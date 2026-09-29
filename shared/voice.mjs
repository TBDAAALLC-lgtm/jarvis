/** Speech defaults shared by the browser and bridge. */
export const VOICE_STYLE = `You are JARVIS, speaking aloud with the calm presence of a thoughtful mentor.
Use a Morpheus-inspired delivery: grounded, measured, quietly authoritative.
Write in natural American English, with short sentences and deliberate pauses.
Be direct about facts, uncertainty and failures. Offer perspective when it helps,
but answer practical questions plainly. Avoid riddles, movie quotes, butler
phrasing and calling the user "sir". Usually use one or two sentences, under
sixty words, unless the user explicitly asks for more. No spoken markdown,
stage directions or URLs. Write numbers and dates as you would say them.`

export const NATIVE_VOICE = Object.freeze({ lang: 'en-US', rate: 0.86, pitch: 0.8 })

// Sawyer is ElevenLabs' current replacement for Brian. Explicit environment
// overrides still take precedence. See README for the provider reference.
export const ELEVENLABS_VOICE_ID = '8dEUmyPMdDdK91vboYih'
export const ELEVENLABS_SETTINGS = Object.freeze({
  stability: 0.65,
  similarity_boost: 0.75,
  speed: 0.9,
})

export const KOKORO_VOICES = Object.freeze([
  'am_fenrir', 'am_michael', 'am_onyx', 'am_adam',
  'bm_george', 'bm_fable', 'bm_lewis', 'bm_daniel',
])
export const DEFAULT_KOKORO_VOICE = 'am_fenrir'
export const KOKORO_SPEED = 0.9

/**
 * Rank known English male system voices; availability varies by OS.
 * @param {{ name: string, lang: string }} voice
 */
export function scoreSystemVoice({ name, lang }) {
  if (!/^en(?:[-_]|$)/i.test(lang)) return -Infinity
  const n = name.toLowerCase()
  let score = /^en[-_]us/i.test(lang) ? 25 : 5
  if (/\b(david|guy|alex|aaron)\b/.test(n)) score += 100
  else if (/\b(fred|reed|rocko|eddy)\b/.test(n)) score += 70
  else if (/\b(daniel|oliver|arthur|jamie|malcolm|ryan)\b/.test(n)) score += 50
  else if (n.includes('google uk english male')) score += 50
  else return -Infinity
  if (n.includes('premium')) score += 15
  else if (n.includes('enhanced')) score += 10
  if (/grandma|grandpa|bubbles|jester|bells|boing|whisper|zarvox|superstar|trinoids|wobble|bahh|organ|cellos|bad news|good news/.test(n)) score -= 200
  return score
}
