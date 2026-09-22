/**
 * The GPT half of the brain.
 *
 * The Claude side of this bridge is the Agent SDK: it owns a session, spawns
 * MCP servers, and runs tools. This side is deliberately much smaller — a
 * streaming chat completion and nothing else. Two reasons for the asymmetry.
 *
 * The first is honesty about what is on offer. The MCP servers are wired into
 * the SDK as SDK servers (`displayServer`, `uiServer`, `chromeServer`,
 * `visionServer`), and their permission gate lives inside the SDK's own
 * `canUseTool` callback. Re-exposing them as OpenAI function definitions would
 * mean re-implementing that gate in a second place, where the two copies could
 * drift — and a drifting permission gate is the one bug in this project that
 * could actually hurt someone. So GPT gets conversation, not hands.
 *
 * The second is that a plain fetch has no dependency. `@anthropic-ai/sdk` is
 * already here for direct mode; adding `openai` for one streaming POST would be
 * a whole package to keep current for no capability we don't get from SSE.
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

export async function resolveModel(signal) {
  if (process.env.OPENAI_MODEL?.trim()) return process.env.OPENAI_MODEL.trim()
  if (cachedModel) return cachedModel

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

  // Chat models only: the embeddings, audio, image and moderation entries in
  // this list would all 400 on /chat/completions.
  const chat = data
    .map((m) => m.id)
    .filter((id) => /^(gpt|o\d)/.test(id))
    .filter((id) => !/(embed|whisper|tts|dall-e|moderation|audio|realtime|image|transcribe|search|codex)/.test(id))

  if (!chat.length) throw new Error('this key exposes no chat models')

  // Prefer the highest generation number, then the most recently dated build,
  // then the shortest id — which is how OpenAI names its stable aliases
  // ("gpt-5" over "gpt-5-2025-11-01-preview").
  const rank = (id) => {
    const gen = Number(id.match(/^(?:gpt|o)-?(\d+)/)?.[1] ?? 0)
    const date = Number(id.match(/(\d{4})-?(\d{2})-?(\d{2})/)?.slice(1).join('') ?? 0)
    const preview = /preview|alpha|beta/.test(id) ? -1 : 0
    return [gen, preview, date, -id.length]
  }
  chat.sort((a, b) => {
    const ra = rank(a)
    const rb = rank(b)
    for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return rb[i] - ra[i]
    return 0
  })

  cachedModel = chat[0]
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
 */
export async function streamChat({ messages, signal, onDelta }) {
  const key = openaiKey()
  if (!key) throw new Error('no OPENAI_API_KEY')

  const model = await resolveModel(signal)

  const res = await fetch(`${API}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model, messages, stream: true }),
    signal,
  })

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
    throw new Error(`OpenAI ${res.status}: ${message || 'no detail'}`)
  }

  let full = ''
  let buffer = ''
  const decoder = new TextDecoder()

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
          const delta = json.choices?.[0]?.delta?.content
          if (delta) {
            full += delta
            onDelta?.(delta)
          }
        }
      }
    }
  } catch (err) {
    if (err?.name === 'AbortError') return { text: full, model, aborted: true }
    throw err
  }

  return { text: full, model, aborted: false }
}
