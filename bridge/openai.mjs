/**
 * The GPT half of the brain.
 *
 * The Claude side of this bridge is the Agent SDK: it owns a session, spawns
 * MCP servers, and runs tools. This side is one streaming POST and an SSE
 * parser, which is the whole reason it stays hand-written — `@anthropic-ai/sdk`
 * is already here for direct mode, and adding `openai` for one request would be
 * another package to keep current for nothing SSE does not already give us.
 *
 * This file used to end by explaining why GPT had no tools: the permission gate
 * lives inside the SDK's `canUseTool`, so a second tool surface meant a second
 * gate, and two gates drift. The objection was right about gates and wrong
 * about what had to be duplicated to get one — see the header of toolkit.mjs,
 * which hands both brains the identical tool definitions under the identical
 * names, so `decideTool` answers for both without knowing which one asked.
 *
 * What is left here is transport. This file streams, and it reports what the
 * model wants to call. It decides nothing, and it runs nothing: the loop that
 * executes a call and feeds the result back lives in bridge/gpt.mjs.
 */

const API = 'https://api.openai.com/v1'

/** The key, read fresh each time so a restart is not needed to notice one. */
export function openaiKey() {
  const k = process.env.OPENAI_API_KEY
  return k && k.trim() ? k.trim() : null
}

/**
 * Which model to talk to.
 *
 * OPENAI_MODEL wins if set. Otherwise we ask the API what this key can see and
 * pick the newest chat model from it, rather than hardcoding a name that will
 * age badly — model ids turn over far faster than this file will. The answer is
 * cached for the life of the process; a wrong guess is recoverable by setting
 * the variable, and the API's own error text is passed through untouched so the
 * reason shows up on screen instead of being swallowed.
 */
let cachedModel = null
/** The rest of the ranked list, so a rejected pick can fall through to it. */
let ranked = []

/**
 * The API saying the MODEL is wrong, rather than the request.
 *
 * Worth separating. A bad request belongs on the user's screen; a model the
 * catalogue advertised and the chat endpoint then refuses is ours to recover
 * from, and without this the first bad pick is cached and every later turn
 * re-posts the same dead id until the bridge is restarted.
 */
function wrongModel(status, message) {
  if (status === 404) return true
  if (status !== 400) return false
  // `only supported in v1/responses` is the `-pro` family refusing chat
  // completions outright. Deliberately not the looser "use /v1/responses",
  // which also appears in the tools-and-reasoning error below — that one names
  // a working model and a bad parameter, and reading it as a bad model would
  // walk the picker down the whole ranked list discarding good ones.
  return /not a chat model|only supported in v1\/responses|model_not_found|does not exist|do not have access to (the )?model/i.test(
    message,
  )
}

/**
 * Models that will not reason and use tools in the same breath.
 *
 * Measured, on the model this key's catalogue ranks first:
 *
 *   OpenAI 400 (gpt-6-sol): Function tools with reasoning_effort are not
 *   supported for gpt-6-sol in /v1/chat/completions. To use function tools,
 *   use /v1/responses or set reasoning_effort to 'none'.
 *
 * Note what this is not. The model is not wrong — it is the newest one the key
 * can see and it answers fine — so `wrongModel` must not claim it, or the
 * picker would walk down the whole ranked list discarding good models over a
 * parameter. What is wrong is the combination, and the API names the fix in the
 * error itself: turn reasoning off for the requests that carry tools.
 *
 * So that is what happens, remembered per model so the 400 is paid once rather
 * than on every turn. Reasoning is untouched everywhere else, including the
 * final toolless round where the model composes what it is actually going to
 * say — which is the round where thinking was worth the most anyway.
 */
const noReasoningWithTools = new Set()

const toolsNeedNoReasoning = (status, message) =>
  status === 400 &&
  /reasoning_effort/i.test(message) &&
  /function tools|tools are not supported/i.test(message)

export async function resolveModel(signal) {
  if (process.env.OPENAI_MODEL?.trim()) return process.env.OPENAI_MODEL.trim()
  if (cachedModel) return cachedModel
  if (ranked.length) {
    cachedModel = ranked[0]
    return cachedModel
  }

  const key = openaiKey()
  if (!key) throw new Error('no OPENAI_API_KEY')

  const res = await fetch(`${API}/models`, {
    headers: { authorization: `Bearer ${key}` },
    signal,
  })
  if (!res.ok) {
    throw new Error(`could not list models (${res.status}): ${await res.text()}`)
  }
  const { data = [] } = await res.json()

  // Chat models only. The embeddings, audio, image and moderation entries
  // would all 400 here -- and so would two subtler families the first version
  // of this filter let straight through: `-instruct` is completions-only, and
  // the `-pro` models answer on /v1/responses and nowhere else.
  const chat = data
    .map((m) => m.id)
    .filter((id) => /^(gpt|o\d)/.test(id))
    .filter(
      (id) =>
        !/(embed|whisper|tts|dall-e|moderation|audio|realtime|image|transcribe|search|codex|instruct)/.test(
          id,
        ),
    )
    .filter((id) => !/(^|-)pro(-|$)/.test(id))

  if (!chat.length) throw new Error('this key exposes no chat models')

  // Highest generation first (5.1 beats 5), then a stable build over a
  // preview, then an undated alias over a dated snapshot.
  //
  // That third term is the one that matters and the one the first version got
  // wrong. It ranked by date before length, so a dated snapshot always beat
  // the bare alias and the "shortest id wins" rule it documented could never
  // run. The cost is not cosmetic: snapshots are retired on a published
  // schedule, so the bridge would have broken on a date nobody had in their
  // calendar, while the alias tracks the current build indefinitely.
  const rank = (id) => {
    const gen = Number(id.match(/^(?:gpt|o)-?(\d+(?:\.\d+)?)/)?.[1] ?? 0)
    const date = Number(id.match(/(\d{4})-?(\d{2})-?(\d{2})/)?.slice(1).join('') ?? 0)
    const preview = /preview|alpha|beta/.test(id) ? -1 : 0
    const snapshot = date ? -1 : 0
    return [gen, preview, snapshot, -id.length, date]
  }
  chat.sort((a, b) => {
    const ra = rank(a)
    const rb = rank(b)
    for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return rb[i] - ra[i]
    return 0
  })

  ranked = chat
  cachedModel = ranked[0]
  return cachedModel
}

/**
 * Stream one turn.
 *
 * `onDelta` is called with each text fragment as it arrives, so the browser can
 * start speaking before the sentence is finished — the same contract the SDK
 * path gets from `content_block_delta`. Resolves with the assembled text.
 *
 * Aborting via `signal` is not an error: barge-in is a normal thing for a voice
 * interface to do, so an AbortError resolves with whatever was said so far
 * rather than throwing into the caller's error path.
 *
 * `tools`, when given, is a list of OpenAI function definitions. Anything the
 * model asks to call comes back in `toolCalls`; nothing is executed here. The
 * caller runs them, appends the results, and calls again — which is why this
 * stays a single request rather than a loop.
 */
export async function streamChat({
  messages,
  tools,
  signal,
  onDelta,
  onTool,
  retried = false,
}) {
  const key = openaiKey()
  if (!key) throw new Error('no OPENAI_API_KEY')

  /**
   * The abort contract has to cover the request, not just the response.
   *
   * The header above promises that an abort resolves rather than throws, and
   * that promise used to be kept only once the body loop had started — the
   * model lookup and the POST sat outside any handler, so a barge-in during the
   * request window rejected out of here, past runTurn, and surfaced as an error
   * frame reading "This operation was aborted" instead of the silent stop every
   * other barge-in produces.
   *
   * Tools widened that window from once per turn to once per round: after a
   * page read comes back, the next round re-posts the whole transcript, and the
   * user cutting in during that POST is an ordinary thing to do. So the window
   * is covered here, and an abort is a resolution on every path out of this
   * function rather than on most of them.
   */
  let model
  let res
  try {
    model = await resolveModel(signal)

    res = await fetch(`${API}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
      },
      // `tools: []` is not the same as no tools — some models reject an empty
      // array — so the key is omitted entirely rather than sent empty.
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        ...(tools?.length
          ? {
              tools,
              tool_choice: 'auto',
              ...(noReasoningWithTools.has(model) ? { reasoning_effort: 'none' } : {}),
            }
          : {}),
      }),
      signal,
    })
  } catch (err) {
    if (err?.name === 'AbortError') {
      return { text: '', model: model ?? null, aborted: true, toolCalls: [], finishReason: null }
    }
    throw err
  }

  if (!res.ok || !res.body) {
    // Pass the upstream wording through. "model not found", "insufficient
    // quota" and "invalid api key" are all things the user can act on, and
    // paraphrasing them into "something went wrong" helps nobody.
    const detail = await res.text().catch(() => '')
    let message = detail
    try {
      message = JSON.parse(detail)?.error?.message ?? detail
    } catch {
      /* not json; the raw body is the best we have */
    }
    // The model is fine and the parameters are not. Remember that for this
    // model and send the same request again without reasoning — checked before
    // the model fallback below, so a recoverable parameter never costs us a
    // model. Retried once, like the fallback, so a server that keeps refusing
    // reports rather than loops.
    if (!retried && !signal?.aborted && toolsNeedNoReasoning(res.status, message)) {
      console.warn(
        `[jarvis] ${model} will not take function tools with reasoning on; ` +
          'retrying this and later tool calls with reasoning off',
      )
      noReasoningWithTools.add(model)
      return streamChat({ messages, tools, signal, onDelta, onTool, retried: true })
    }

    // A model the catalogue advertised and this endpoint refuses is a bad
    // guess on our side, not a bad question on theirs. Drop it and take the
    // runner-up the ranking already computed. Only once, and only when we
    // chose the model: a pinned OPENAI_MODEL is the user's decision and gets
    // reported rather than second-guessed.
    const auto = !process.env.OPENAI_MODEL?.trim()
    if (
      auto &&
      !retried &&
      !signal?.aborted &&
      ranked.length > 1 &&
      wrongModel(res.status, message)
    ) {
      console.warn(
        `[jarvis] ${ranked[0]} was refused by the chat endpoint; falling back to ${ranked[1]}`,
      )
      ranked.shift()
      cachedModel = null
      return streamChat({ messages, tools, signal, onDelta, onTool, retried: true })
    }

    // Name the model. "OpenAI 400" alone leaves the user guessing at which of
    // the key, the account and the model is the one at fault.
    throw new Error(`OpenAI ${res.status} (${model}): ${message || 'no detail'}`)
  }

  let full = ''
  let buffer = ''
  let finishReason = null
  const decoder = new TextDecoder()

  /**
   * Tool calls arrive in pieces, and the pieces are not self-describing.
   *
   * A streamed `tool_calls` delta carries an `index` and almost nothing else:
   * the `id` and the function's `name` appear once, on the fragment that opens
   * the call, and every fragment after it contributes a few more characters of
   * `arguments` — which is a JSON *string* being spelled out, not JSON being
   * built. So the index is the only thing tying the fragments together, and
   * assembling by array position rather than by that index is how two parallel
   * calls end up wearing each other's arguments.
   *
   * Keyed by index, therefore, and parsed only once the stream is over.
   */
  const calls = new Map()
  const announced = new Set()

  try {
    for await (const chunk of res.body) {
      buffer += decoder.decode(Buffer.from(chunk), { stream: true })

      // SSE frames are separated by a blank line; a chunk can split one in
      // half, so only complete frames are consumed and the tail is kept.
      const frames = buffer.split('\n\n')
      buffer = frames.pop() ?? ''

      for (const frame of frames) {
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (!payload || payload === '[DONE]') continue
          let json
          try {
            json = JSON.parse(payload)
          } catch {
            continue // a keepalive or a comment, not a delta
          }
          const choice = json.choices?.[0]
          const delta = choice?.delta?.content
          if (delta) {
            full += delta
            onDelta?.(delta)
          }

          for (const part of choice?.delta?.tool_calls ?? []) {
            const i = part.index ?? 0
            const call = calls.get(i) ?? { id: '', name: '', args: '' }
            if (part.id) call.id = part.id
            if (part.function?.name) call.name += part.function.name
            if (part.function?.arguments) call.args += part.function.arguments
            calls.set(i, call)

            // Announced the moment the name is whole enough to be worth
            // saying, rather than after the arguments finish streaming. On a
            // long argument list that is a visible wait, and the badge exists
            // to say "something is happening" at the point it starts.
            if (call.name && !announced.has(i)) {
              announced.add(i)
              onTool?.(call.name)
            }
          }

          // Carried out because it is the only thing that distinguishes "the
          // model is done" from "the model stopped to use a tool", and the
          // caller decides what to do about that.
          if (choice?.finish_reason) finishReason = choice.finish_reason
        }
      }
    }
  } catch (err) {
    if (err?.name === 'AbortError') {
      // Whatever it was about to call is abandoned deliberately. An abort is
      // the user cutting in, and running a tool they interrupted — opening a
      // blade, moving the camera — is the one thing barge-in must never do.
      return { text: full, model, aborted: true, toolCalls: [], finishReason }
    }
    throw err
  }

  return { text: full, model, aborted: false, toolCalls: collect(calls), finishReason }
}

/**
 * The assembled calls, in the order the model asked for them.
 *
 * Arguments are left as the raw string. Parsing here would mean deciding what
 * to do about a malformed one inside a function whose job is transport, and
 * the right answer — hand the model back its own mistake so it can correct it —
 * only makes sense where the conversation is, which is one layer up.
 */
function collect(calls) {
  return [...calls.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, c]) => c)
    .filter((c) => c.name)
}
