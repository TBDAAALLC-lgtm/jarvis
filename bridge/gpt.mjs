import { streamChat } from './openai.mjs'
import { callTool, functionSchemas } from './toolkit.mjs'

/**
 * The GPT turn, with hands.
 *
 * The Agent SDK runs Claude's tool loop for us — ask, call, feed the result
 * back, repeat until the model stops asking. Chat completions do not. The model
 * returns with `finish_reason: "tool_calls"` and then it is the caller's turn
 * to do something, so that loop lives here.
 *
 * Three things this owes to the Claude path, because two brains that fail
 * differently are two assistants:
 *
 *   A turn always ends in words. Running out of rounds is the one way this
 *   could hand back nothing at all, so it does not end on the last round — it
 *   ends on a round with no tools offered, where the only thing the model can
 *   do is answer. Silence is this project's defining bug and it is not coming
 *   back through the door tools opened.
 *
 *   A tool that fails is reported to the model, not thrown. `callTool` catches,
 *   the message goes into the transcript as that tool's result, and the model
 *   gets to say something sensible about it — the same as a `tool_result` with
 *   `is_error` on the other path.
 *
 *   An interrupt abandons pending calls. Barge-in means the user changed their
 *   mind, and executing the tool they interrupted — opening a blade, waking the
 *   camera — is worse than doing nothing.
 */

/**
 * How many times the model may call tools before it has to speak.
 *
 * Every round re-sends the whole transcript, so this bounds cost as much as
 * time. Eight is enough for the shapes that actually occur here — look at the
 * page, screenshot it, put it on a blade — and short enough that a model stuck
 * in a retry rut is cut off while the user is still listening.
 */
const MAX_ROUNDS = 8

/**
 * A tool result is a message, and every message is re-sent every round.
 *
 * `chrome_read_page` on a large document returns tens of thousands of
 * characters, and left whole it would be paid for again on every subsequent
 * round of the same turn. Truncated with the truncation stated, so the model
 * knows to narrow its next call rather than concluding the page simply ends.
 */
const MAX_TOOL_CHARS = 24_000

const clip = (text) =>
  text.length <= MAX_TOOL_CHARS
    ? text
    : `${text.slice(0, MAX_TOOL_CHARS)}\n\n[...truncated. Narrow the request if you need the rest.]`

/**
 * Trim the transcript without breaking it.
 *
 * A `tool` message is only legal immediately after the `assistant` message
 * whose `tool_calls` it answers — OpenAI rejects the whole request otherwise,
 * with an error about the message list rather than about the history cap that
 * caused it. So the old `while (too long) shift()` cannot survive tools: it
 * cuts wherever it happens to land, and one unlucky cut point turns every later
 * question in the session into a 400.
 *
 * Cutting only immediately before a plain-text `user` message is what makes it
 * safe. That is a real question the user asked, everything before it is a
 * finished exchange, and what remains always begins somewhere legal.
 */
export function trim(history, maxMessages) {
  if (history.length <= maxMessages) return history

  const isQuestion = (m) => m?.role === 'user' && typeof m.content === 'string'

  for (let i = history.length - maxMessages; i < history.length; i++) {
    if (isQuestion(history[i])) return history.slice(i)
  }
  // Past the last real question — the tail is one long tool sequence. Keep it
  // whole from the question that started it rather than cutting into it: going
  // over the cap for a turn is recoverable, an unsendable transcript is not.
  for (let i = history.length - 1; i >= 0; i--) {
    if (isQuestion(history[i])) return history.slice(i)
  }
  return []
}

/** Images cannot ride in a `tool` message, so they follow in a `user` one. */
const imageMessage = (images) => ({
  role: 'user',
  content: [
    {
      type: 'text',
      text:
        images.length > 1
          ? `The tool returned ${images.length} images, in order.`
          : 'The tool returned this image.',
    },
    ...images.map((im) => ({
      type: 'image_url',
      image_url: { url: `data:${im.mimeType};base64,${im.data}` },
    })),
  ],
})

/**
 * Run one question to completion.
 *
 * `history` is mutated: the assistant's words, its tool calls and their results
 * are appended as they happen, so an interrupt leaves behind a truthful record
 * of how far the turn actually got rather than an all-or-nothing block.
 *
 * `decide` is the caller's permission gate — the same `decideTool` the Agent
 * SDK's `canUseTool` consults, given the same `mcp__server__tool` name. It is
 * passed in rather than imported so that this file, like toolkit.mjs, never
 * becomes a second place where policy is written.
 */
export async function runTurn({
  system,
  history,
  registry,
  decide,
  refusal,
  signal,
  onDelta,
  onTool,
  onToolResult,
  maxRounds = MAX_ROUNDS,
}) {
  const tools = functionSchemas(registry)
  const messages = () => [{ role: 'system', content: system }, ...history]

  // Everything said across every round of this turn. The rounds are an
  // implementation detail; what the user heard is one answer.
  let spoken = ''

  for (let round = 0; round < maxRounds; round++) {
    const res = await streamChat({ messages: messages(), tools, signal, onDelta, onTool })
    spoken += res.text

    if (res.aborted) {
      // Recorded even though it was cut off. Dropping it would leave the model
      // believing it never spoke, and repeating itself on the next question.
      if (res.text) history.push({ role: 'assistant', content: res.text })
      return { text: spoken, aborted: true }
    }

    if (!res.toolCalls.length) {
      if (res.text) history.push({ role: 'assistant', content: res.text })
      return { text: spoken, aborted: false }
    }

    history.push({
      role: 'assistant',
      // Null rather than '' when the model went straight to a tool: an empty
      // string is a message with no content, which some models reject on the
      // next round.
      content: res.text || null,
      tool_calls: res.toolCalls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: c.args || '{}' },
      })),
    })

    const images = []
    for (const call of res.toolCalls) {
      // Between calls, not only before the batch: a model can ask for four
      // things at once and the user can cut in during the second.
      if (signal?.aborted) return { text: spoken, aborted: true }

      let args = {}
      let malformed = null
      try {
        args = call.args?.trim() ? JSON.parse(call.args) : {}
      } catch (err) {
        // Handed straight back. A model that wrote invalid JSON can usually
        // write valid JSON when told so, and inventing arguments on its behalf
        // is how a tool ends up running against something nobody asked for.
        malformed = {
          text:
            `The arguments were not valid JSON (${err?.message ?? err}). ` +
            'Call it again with well-formed JSON.',
          images: [],
          isError: true,
        }
      }

      const out = malformed ?? (await callTool(registry, call.name, args, { decide, refusal }))
      onToolResult?.(call.name, out.isError)

      history.push({ role: 'tool', tool_call_id: call.id, content: clip(out.text) })
      images.push(...out.images)
    }

    if (images.length) history.push(imageMessage(images))
  }

  /**
   * Out of rounds, and possibly still nothing said.
   *
   * One more pass with no tools offered, so the only move left is to answer.
   * Without this, a model that kept reaching for tools would end the turn with
   * whatever it happened to have said — often nothing — and the interface would
   * go quiet for a reason the user could not see.
   */
  const res = await streamChat({
    messages: [
      ...messages(),
      {
        role: 'system',
        content:
          'You have used all the tool calls available for this turn. Answer now, ' +
          'in words, from what you already have. If it was not enough, say ' +
          'plainly what you could not find out.',
      },
    ],
    signal,
    onDelta,
  })
  spoken += res.text
  if (res.text) history.push({ role: 'assistant', content: res.text })
  return { text: spoken, aborted: res.aborted }
}
