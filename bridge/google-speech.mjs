import { GoogleAuth } from 'google-auth-library'

const MODEL = 'chirp_3'
const MAX_AUDIO_BYTES = 10 * 1024 * 1024
const AUTH_TIMEOUT_MS = 10_000
const PHRASES = ['Jarvis', 'ChatGPT', 'Claude', 'GitHub', 'Infinityinsight', 'Google Drive']
const CREDENTIAL_HELP = 'Google speech credentials are unavailable. Configure Application Default Credentials for the selected project.'
const CREDENTIAL_TIMEOUT = 'Google speech credential lookup timed out. Check your connection and Application Default Credentials, then try again.'

function speechError(status, message) {
  const error = new Error(message)
  error.status = status
  return error
}

function checkAbort(signal) {
  if (signal?.aborted) throw new DOMException('Google speech request cancelled.', 'AbortError')
}

async function boundedAccessToken(client, signal) {
  let timer
  let onAbort
  const cancelled = new Promise((_, reject) => {
    onAbort = () => reject(new DOMException('Google speech request cancelled.', 'AbortError'))
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })
  const timedOut = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = speechError(503, CREDENTIAL_TIMEOUT)
      error.code = 'GOOGLE_AUTH_TIMEOUT'
      reject(error)
    }, AUTH_TIMEOUT_MS)
  })
  try {
    // The SDK lookup cannot be cancelled, but this wait can. Promise.race also
    // observes a late rejection so it cannot become an unhandled rejection.
    return await Promise.race([
      Promise.resolve().then(() => { checkAbort(signal); return client.getAccessToken() }),
      cancelled,
      timedOut,
    ])
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

function upstreamMessage(status) {
  const help = {
    400: 'Check the audio format, language, and Google speech configuration.',
    401: 'Refresh Application Default Credentials for the selected project.',
    403: 'Check that Speech-to-Text API and billing are enabled and your account can recognize speech and use this project.',
    404: 'Check the selected Google Cloud project and speech region.',
    413: 'The recording exceeds the Google speech request size limit.',
    429: 'Google speech quota is exhausted or requests are arriving too quickly. Check project quotas before trying again.',
  }
  return `Google speech returned HTTP ${status}. ${help[status] ?? 'The speech service is temporarily unavailable; try again later.'}`
}

// Only correct a whole, affirmative navigation command whose target is an
// obvious pronunciation of ChatGPT. Dictation, quotes, negations, and trailing
// instructions remain verbatim; this never chooses a different action.
function correctNavigation(text) {
  const command = /^((?:(?:hey[\s,]+)?jarvis[,.]?\s+)?(?:(?:please\s+)|(?:(?:can|could|would)\s+you\s+(?:please\s+)?))?(?:open(?:\s+up)?|go\s+to|launch)\s+)(?:chat\s+gpt|chat\s+g\s+p\s+t|chat\s+gee\s+pee\s+tee|chat\s+tee\s+tee\s+tee)([.!?]*)$/i
  return text.replace(command, '$1ChatGPT$2')
}

function readTranscript(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.error) {
    throw speechError(502, 'Google speech returned an invalid recognition response.')
  }
  // Google omits results when no speech was recognized.
  if (payload.results === undefined) return ''
  if (!Array.isArray(payload.results)) throw speechError(502, 'Google speech returned invalid recognition results.')
  return payload.results.map((result) => {
    const first = result?.alternatives?.[0]
    if (!Array.isArray(result?.alternatives) || typeof first?.transcript !== 'string') {
      throw speechError(502, 'Google speech returned an invalid transcript.')
    }
    return first.transcript.trim()
  }).filter(Boolean).join(' ')
}

/** Server-side Google Speech-to-Text V2. Construction never reads credentials or submits audio. */
export function createGoogleSpeech({ env = process.env, fetchImpl = fetch, auth } = {}) {
  const project = String(env.JARVIS_GOOGLE_PROJECT || env.GOOGLE_CLOUD_PROJECT || '').trim()
  const location = String(env.JARVIS_GOOGLE_LOCATION || 'us').trim()
  const language = String(env.JARVIS_GOOGLE_LANGUAGE || 'en-US').trim()
  let configurationError = ''
  if (!project) configurationError = 'Set JARVIS_GOOGLE_PROJECT or GOOGLE_CLOUD_PROJECT to use Google speech.'
  else if (!/^(?:[a-z][a-z0-9-]{4,28}[a-z0-9]|\d+)$/.test(project)) configurationError = 'The Google speech project must be a valid Google Cloud project ID or number.'
  else if (!['us', 'eu'].includes(location)) configurationError = 'JARVIS_GOOGLE_LOCATION must be us or eu for Google Chirp 3.'
  else if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(language)) configurationError = 'JARVIS_GOOGLE_LANGUAGE must be a valid language code, such as en-US.'

  const configured = !configurationError
  const client = auth ?? (configured ? new GoogleAuth({
    projectId: project,
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  }) : null)
  let ready = false
  let apiVerified = false
  let detail = configurationError || 'Google speech project configured; credentials have not been checked.'
  const status = () => ({ ready, detail, project, model: MODEL, language, provider: 'google' })

  async function accessToken(signal) {
    checkAbort(signal)
    if (!configured) throw speechError(503, configurationError)
    let token
    try {
      token = await boundedAccessToken(client, signal)
    } catch (error) {
      checkAbort(signal)
      // A timeout does not revoke previously discovered credentials.
      if (error?.code !== 'GOOGLE_AUTH_TIMEOUT') ready = false
      apiVerified = false
      detail = error?.code === 'GOOGLE_AUTH_TIMEOUT' ? CREDENTIAL_TIMEOUT : CREDENTIAL_HELP
      throw speechError(503, detail)
    }
    checkAbort(signal)
    if (typeof token !== 'string' || !token.trim()) {
      ready = false
      apiVerified = false
      detail = CREDENTIAL_HELP
      throw speechError(503, detail)
    }
    ready = true
    return token
  }

  async function probe() {
    try {
      await accessToken()
      ready = true
      detail = apiVerified
        ? 'Google Speech-to-Text API verified by a successful recognition request.'
        : 'Google credentials available; Speech-to-Text API access has not yet been verified.'
    } catch {
      // accessToken already records a sanitized setup problem.
    }
    return status()
  }

  async function recognize(audio, { signal } = {}) {
    checkAbort(signal)
    if (!Buffer.isBuffer(audio) || audio.length === 0) throw speechError(400, 'A non-empty audio recording is required.')
    if (audio.length > MAX_AUDIO_BYTES) throw speechError(413, 'Audio recordings must be 10 MiB or smaller.')
    const token = await accessToken(signal)
    checkAbort(signal)
    let response
    try {
      response = await fetchImpl(`https://${location}-speech.googleapis.com/v2/projects/${project}/locations/${location}/recognizers/_:recognize`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'x-goog-user-project': project,
        },
        redirect: 'error',
        signal,
        body: JSON.stringify({
          config: {
            autoDecodingConfig: {},
            languageCodes: [language],
            model: MODEL,
            adaptation: { phraseSets: [{ inlinePhraseSet: { phrases: PHRASES.map((value) => ({ value })) } }] },
          },
          content: audio.toString('base64'),
        }),
      })
    } catch {
      checkAbort(signal)
      apiVerified = false
      detail = 'Google speech could not be reached. Check your connection and try again.'
      throw speechError(502, detail)
    }
    checkAbort(signal)
    if (!response.ok) {
      // Never relay upstream bodies: they can contain credential or account details.
      await response.body?.cancel().catch(() => {})
      checkAbort(signal)
      apiVerified = false
      detail = upstreamMessage(response.status)
      throw speechError(response.status, detail)
    }
    let payload
    try {
      payload = await response.json()
    } catch {
      checkAbort(signal)
      apiVerified = false
      detail = 'Google speech returned an invalid JSON response.'
      throw speechError(502, detail)
    }
    checkAbort(signal)
    let rawText
    try {
      rawText = readTranscript(payload)
    } catch (error) {
      apiVerified = false
      detail = error.message
      throw error
    }
    const text = correctNavigation(rawText)
    ready = true
    apiVerified = true
    detail = 'Google Speech-to-Text API verified by a successful recognition request.'
    return { text, rawText, corrected: text !== rawText, provider: 'google' }
  }

  return { configured, status, probe, recognize }
}
