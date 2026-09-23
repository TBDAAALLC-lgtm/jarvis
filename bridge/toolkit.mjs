import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

/**
 * One definition of a tool, for both brains.
 *
 * The bridge grew a Claude half and a GPT half, and only the Claude half had
 * hands. openai.mjs said why in its header, and the reason was a good one: the
 * MCP servers are wired into the Agent SDK and their permission gate lives
 * inside the SDK's own `canUseTool` callback, so exposing the same tools to GPT
 * meant writing a second gate beside the first, where the two could drift. A
 * drifting permission gate is the one bug in this project that could actually
 * hurt someone, so GPT got conversation and no hands.
 *
 * That reasoning holds for a second *gate*. It does not hold for a second
 * *caller*. `decideTool` is a pure function of the tool's name — it reads verbs
 * out of `mcp__<server>__<tool>` and returns a boolean — and OpenAI's function
 * names accept exactly the characters those names are made of. So both brains
 * can ask the identical question about the identical string and get the
 * identical answer. There is no mapping table between the two worlds, which
 * means there is nothing to fall out of step: rename a tool and both paths
 * break together, which is the only kind of coupling worth having here.
 *
 * What was genuinely missing was one definition of each tool to point both at,
 * and it turns out the SDK was already holding one. `tool()` returns a plain
 * `{ name, description, inputSchema, handler }` object and `createSdkMcpServer`
 * simply consumes an array of them, so the definitions were readable the whole
 * time — nothing was hiding them, nobody had looked. This module reads them:
 * the same array builds the SDK server for Claude and the function list for
 * GPT, and neither consumer owns it.
 *
 * That is why the change at each tool module is one word. No tool is rewritten,
 * no definition is copied, and there is no second place to keep in step — which
 * was the entire objection, answered by removing the duplication rather than by
 * managing it.
 *
 * The asymmetry that remains is real and deliberate. Claude also gets the
 * user's configured MCP servers and the SDK's own built-in tools, which live in
 * another process and are not ours to hand out. GPT gets the four servers this
 * bridge builds itself — the display, the interface, the browser, the camera —
 * which is what the two tiles were promised to have in common.
 */

/** MCP tool names, which are also the names GPT sees. */
export const mcpName = (server, tool) => `mcp__${server}__${tool}`

/**
 * OpenAI rejects a function name outside `[A-Za-z0-9_-]{1,64}`, and rejects the
 * whole request rather than the one tool — so a name that slips through would
 * take the entire turn down with it, at the moment the model first tried to use
 * it, and the error would name the request rather than the tool.
 *
 * Every name in this bridge passes today. This is here so that the day somebody
 * adds `chrome_wait_for_selector_or_timeout` it is caught while they are
 * writing it rather than in front of a microphone.
 */
const NAME_OK = /^[A-Za-z0-9_-]{1,64}$/

/**
 * Zod shape to JSON Schema.
 *
 * `io: 'input'` is the important one: several schemas here carry `.default()`
 * or `.catch()`, and the output view of those is the post-parse type, which is
 * narrower than what a caller is allowed to send. The model should be told what
 * it may write, not what the handler will end up holding.
 *
 * `unrepresentable: 'any'` because a schema that cannot be expressed in JSON
 * Schema must not take the whole tool surface down at boot. A tool described
 * loosely still works; a bridge that will not start does not.
 */
function jsonSchema(shape) {
  const keys = Object.keys(shape ?? {})
  if (!keys.length) return { type: 'object', properties: {}, additionalProperties: false }

  const schema = z.toJSONSchema(z.object(shape), {
    io: 'input',
    unrepresentable: 'any',
  })
  // The dialect marker is meaningful to a validator and noise to a model.
  delete schema.$schema
  return schema
}

/**
 * Declare a server's tools once.
 *
 * Returns the SDK server for the Agent SDK to mount, and keeps the specs
 * readable so the GPT path can offer the same tools without a second
 * definition. `server` is built eagerly because the SDK wants an object, not a
 * thunk, and because a schema that cannot be built should fail at boot in the
 * log rather than mid-sentence in front of the user.
 */
export function defineTools({ name, version = '1.0.0', instructions, alwaysLoad, tools: specs }) {
  for (const spec of specs) {
    const full = mcpName(name, spec.name)
    if (!NAME_OK.test(full)) {
      throw new Error(
        `[jarvis] tool name "${full}" cannot be offered to OpenAI ` +
          '(allowed: letters, digits, underscore, hyphen, at most 64 characters)',
      )
    }
  }

  return {
    name,
    specs,
    // Passed through untouched. These are the SDK's own tool objects and the
    // SDK is their first consumer; reading them for a second consumer must not
    // change what the first one is handed.
    server: createSdkMcpServer({ name, version, instructions, alwaysLoad, tools: specs }),
  }
}

/**
 * The kits GPT may call, indexed by the name it will call them with.
 *
 * Built per connection, because the display and camera kits close over the
 * socket that is about to receive their output.
 */
export function registry(kits) {
  const byName = new Map()
  for (const kit of kits) {
    for (const spec of kit.specs) {
      byName.set(mcpName(kit.name, spec.name), spec)
    }
  }
  return byName
}

/**
 * The same tools, as OpenAI function definitions.
 *
 * Every tool is offered, including ones the gate will refuse. That is on
 * purpose and it matches the Claude path exactly: the SDK is handed the whole
 * surface too, and `canUseTool` denies at the moment of the call with a
 * sentence explaining why. Filtering here instead would be a second policy
 * decision in a second place — the very thing this module exists to avoid — and
 * it would leave the model unable to tell the user *why* it cannot do the thing
 * they just asked for, because it would not know the thing existed.
 */
export function functionSchemas(reg) {
  return [...reg].map(([name, spec]) => ({
    type: 'function',
    function: {
      name,
      description: spec.description,
      parameters: jsonSchema(spec.inputSchema),
    },
  }))
}

/**
 * What a tool result looks like once it has left MCP.
 *
 * MCP returns an array of typed content blocks; a chat completion's `tool`
 * message carries a string and nothing else. Text collapses cleanly. Images do
 * not, and they are the interesting case: the camera's whole output is an
 * image, so dropping it would leave `look` reporting success and describing
 * nothing. They come back separately here so the caller can put them where a
 * chat completion will actually accept them.
 */
export function flatten(result) {
  const blocks = Array.isArray(result?.content) ? result.content : []
  const text = blocks
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
  const images = blocks
    .filter((b) => b?.type === 'image' && typeof b.data === 'string' && b.data)
    .map((b) => ({ data: b.data, mimeType: b.mimeType ?? 'image/jpeg' }))

  return {
    text: text || (images.length ? 'See the attached image.' : 'Done.'),
    images,
    isError: result?.isError === true,
  }
}

/**
 * The schema, as something that can actually reject an argument.
 *
 * On the Claude path the SDK parses arguments against the tool's shape before
 * the handler ever sees them. Every handler in this bridge was written knowing
 * that, and two things follow from it that are easy to miss when a second
 * caller appears.
 *
 * The small one is that `.default()` and `.catch()` — used heavily here,
 * deliberately, so a coordinate arriving as a string does not break a turn the
 * user is watching — only do anything during a parse. Skip it and every one of
 * those defences is decoration.
 *
 * The large one is that a Zod object STRIPS keys it does not declare, and
 * several handlers are built on exactly that. `chrome_screenshot` is
 * `forward('computer')({ action: 'screenshot', ...args })`: the `action` is
 * meant to be fixed, and what stops a caller supplying their own is not the
 * spread order but the parse that removed it two steps earlier. Hand a raw
 * argument object straight to that handler and a screenshot — which is
 * permitted in read-only mode, being a read — becomes `left_click` at a
 * coordinate of the caller's choosing in the user's signed-in browser.
 *
 * So arguments are parsed here too, from the same shape, before any handler
 * runs. This is the concrete form of the promise the header makes: not that the
 * gate is shared, but that everything standing between a model and the machine
 * is.
 */
const parsers = new WeakMap()

function parserFor(spec) {
  let parser = parsers.get(spec)
  if (!parser) {
    parser = z.object(spec.inputSchema ?? {})
    parsers.set(spec, parser)
  }
  return parser
}

/**
 * Run one tool by its full name.
 *
 * The gate is the caller's — `decide` is passed in rather than imported, so
 * this module never becomes a second place where policy lives. A refusal comes
 * back in the same shape as a failure, because to the model they are the same
 * thing: the tool did not run, here is the sentence explaining it.
 *
 * A handler that throws is caught. On the Claude path the SDK turns a thrown
 * handler into an error result and the turn continues; without this the same
 * throw would reject out of the GPT loop and end the turn, so the two brains
 * would fail differently at the same tool. They fail the same way now.
 */
export async function callTool(reg, name, args, { decide, refusal, signal }) {
  const spec = reg.get(name)
  if (!spec) {
    return { text: `No such tool: ${name}.`, images: [], isError: true }
  }
  if (!decide(name)) {
    return { text: refusal, images: [], isError: true }
  }

  const parsed = parserFor(spec).safeParse(args ?? {})
  if (!parsed.success) {
    // Handed back rather than repaired. Most fields here carry `.catch()`, so
    // reaching this at all means something structural is wrong, and guessing
    // at what was meant is how a tool runs against the wrong thing.
    const why = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ')
    return {
      text: `Those arguments were rejected — ${why}. Call it again with arguments that fit the schema.`,
      images: [],
      isError: true,
    }
  }

  try {
    /**
     * The second argument is how a tool learns it has been called off.
     *
     * The SDK passes `{ signal, requestId }` here on the Claude path, and this
     * used to pass `{}` — so a GPT tool could not be interrupted at all, and
     * the signal the SDK was already providing on the other side was going
     * unused by every handler anyway. Both now receive the same thing under the
     * same name, which is what lets `look`, `watch` and the browser tools be
     * abort-aware once rather than twice.
     */
    return flatten(await spec.handler(parsed.data, { signal }))
  } catch (err) {
    return {
      text: `The tool failed: ${err?.message ?? err}`,
      images: [],
      isError: true,
    }
  }
}
