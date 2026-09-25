import { BACKEND, BRIDGE_HTTP_URL, env } from '../config'

/**
 * What speech engines are actually available, decided once at boot.
 *
 * Input and output are independent: Google can recognize speech while the
 * browser or ElevenLabs speaks. Explicit Google configuration reports setup
 * failures instead of quietly switching back to browser recognition.
 *
 * Cloud speech lives behind the bridge — it holds credentials and makes
 * the calls, so the browser never sees a secret. In direct mode (no bridge)
 * only a key baked into the bundle could reach ElevenLabs for speech, and that
 * is not a path worth encouraging, so direct mode is treated as browser-only.
 */

/**
 * Which account a brain is signed in as.
 *
 * Only the Claude side has one, and it exists because "is it signed in" was
 * never the question that actually went wrong here. A login to the right
 * organisation and a login to a personal account carrying the same
 * subscription are indistinguishable from outside — same tile, same "ready",
 * same word "team" — and they diverge several turns later as an error that
 * reads like anything except a wrong account.
 *
 * Optional because a bridge that has not been restarted since this was added
 * does not send it, and an unlabelled tile is the right thing to show then
 * rather than a guess.
 */
export type Account = {
  email: string | null
  org: string | null
  orgId: string | null
}

/** Whether one brain can answer, and a short reason when it cannot. */
export type ProviderState = {
  ready: boolean
  detail: string
  account?: Account | null
}

export type ProviderName = 'claude' | 'gpt'

export type Capabilities = {
  /** The selected server-side speech recognition provider is configured. */
  stt: boolean
  sttProvider?: 'google' | 'elevenlabs' | 'browser' | 'unavailable'
  sttDetail?: string
  /** ElevenLabs text-to-speech is reachable via the bridge. */
  tts: boolean
  /**
   * Which brains can actually answer right now.
   *
   * Worth probing rather than discovering by asking: an expired Claude
   * login and a missing OpenAI key both produce a turn that says nothing,
   * and silence is the one symptom this interface cannot explain. Knowing
   * up front lets the tile say so before the user talks to a dead brain.
   */
  providers: Record<ProviderName, ProviderState>
}

/** Browser-only until the probe says otherwise. Safe default: the app works. */
const UNKNOWN: Record<ProviderName, ProviderState> = {
  claude: { ready: false, detail: 'bridge not reached' },
  gpt: { ready: false, detail: 'bridge not reached' },
}

let current: Capabilities = { stt: false, tts: false, providers: UNKNOWN }
let probed = false

/** The last known capabilities. Read synchronously by the voice and speech
 *  layers; accurate once `probeCapabilities` has resolved during boot. */
export function caps(): Capabilities {
  return current
}

/** What each brain reported at boot. */
export function providers(): Record<ProviderName, ProviderState> {
  return current.providers
}

export function capabilitiesProbed(): boolean {
  return probed
}

/**
 * Ask the bridge what it can do, once. Called during the boot sequence, before
 * the voice loop starts, so the first "Hey Jarvis" already uses the right
 * engine. Never throws: a failed probe simply leaves the browser fallback in
 * place, which is the correct behaviour when the bridge is unreachable.
 */
export async function probeCapabilities(): Promise<Capabilities> {
  if (BACKEND !== 'bridge') {
    // No bridge to ask. Direct mode has no server-side speech, so browser only.
    current = {
      stt: false,
      tts: false,
      providers: {
        claude: { ready: true, detail: 'direct API' },
        gpt: { ready: false, detail: 'bridge only' },
      },
    }
    probed = true
    return current
  }
  try {
    const res = await fetch(`${BRIDGE_HTTP_URL}/health`, {
      signal: AbortSignal.timeout(3000),
    })
    if (res.ok) {
      const h = (await res.json()) as {
        stt?: boolean
        sttProvider?: Capabilities['sttProvider']
        sttDetail?: string
        tts?: boolean
        providers?: Partial<
          Record<ProviderName, Partial<ProviderState> & { account?: Partial<Account> | null }>
        >
      }
      const one = (name: ProviderName): ProviderState => {
        // Taken only when it carries something. An account object of three
        // nulls is the same as no account, and the tooltip should not grow a
        // trailing separator for it.
        const a = h.providers?.[name]?.account
        const account =
          a && (a.email || a.org)
            ? { email: a.email ?? null, org: a.org ?? null, orgId: a.orgId ?? null }
            : null
        return {
          ready: Boolean(h.providers?.[name]?.ready),
          detail: h.providers?.[name]?.detail ?? 'unknown',
          account,
        }
      }
      current = {
        stt: Boolean(h.stt),
        sttProvider: h.sttProvider ?? (h.stt ? 'elevenlabs' : 'browser'),
        sttDetail: typeof h.sttDetail === 'string' ? h.sttDetail : undefined,
        tts: Boolean(h.tts),
        // An older bridge sends no `providers` block at all. Claiming both
        // are dead would be wrong, so fall back to the pre-tile world:
        // Claude answers, GPT was never wired up.
        providers: h.providers
          ? { claude: one('claude'), gpt: one('gpt') }
          : {
              claude: { ready: true, detail: 'bridge (no status)' },
              gpt: { ready: false, detail: 'bridge too old' },
            },
      }
    }
  } catch {
    // Bridge down or slow — stay on the browser engines rather than blocking
    // boot on a health check that is only an optimisation.
  }
  probed = true
  return current
}

/** A short human label for the HUD: what voice stack is actually in play. */
export function engineLabel(): string {
  const c = current
  if (c.sttProvider === 'google') {
    if (!c.stt) return 'Google Speech-to-Text · setup required'
    return c.tts ? 'Google recognition · ElevenLabs voice' : 'Google recognition · browser voice'
  }
  if (c.stt && c.tts) return 'ElevenLabs'
  if (c.tts) return 'ElevenLabs voice'
  // env.elevenKey is only meaningful in direct mode; harmless to mention.
  if (env.elevenKey && BACKEND !== 'bridge') return 'ElevenLabs (direct)'
  return 'browser speech'
}
