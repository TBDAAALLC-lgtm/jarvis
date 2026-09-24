import { useEffect, useState } from 'react'
import { useStore, type Provider } from '../store'
import {
  capabilitiesProbed,
  providers as probedProviders,
  type ProviderState,
} from '../lib/capabilities'

/**
 * The two brains, as tiles in the top-right corner.
 *
 * This interface has exactly one failure it cannot explain: silence. An
 * expired Claude login and an absent OpenAI key both produce a turn that says
 * nothing, and from the outside that is indistinguishable from a microphone
 * that never heard you. So each tile carries its own readiness, probed from
 * the bridge at boot, and a tile that cannot answer says why on its face
 * rather than waiting to disappoint you mid-sentence.
 *
 * A tile stays clickable even when it is not ready. Selecting a brain and
 * being told plainly that it needs a login is a better experience than a
 * control that ignores the pointer for reasons it does not explain.
 */

const LABEL: Record<Provider, string> = {
  claude: 'JARVIS-CLAUDE',
  gpt: 'JARVIS-GPT',
}

/**
 * The tooltip: the verdict, the remedy, and whose account this is.
 *
 * The account goes here and not on the tile, for two reasons.
 *
 * The tile is a 9px row of dot, name and verdict, and an email address is
 * longer than all three together — it would wrap the tile or truncate to
 * something unreadable, and it would sit there permanently. It is also the
 * user's address, on screen for the whole session, in every screenshot and
 * every shared window. There is no version of "always visible" that is worth
 * that.
 *
 * And the question it answers is not one anybody asks continuously. "Which
 * account is this?" gets asked exactly when something looks wrong — which is
 * the moment you point at the tile anyway. So the answer lives under the
 * pointer: free when you do not want it, immediate when you do.
 *
 * Organisation before email, because organisation is the thing that was
 * actually wrong. A personal account and an organisation account with the same
 * subscription differ in that word alone.
 */
function hoverLabel(label: string, state: ProviderState): string {
  const parts = [`${label} — ${state.detail}`]
  const a = state.account
  if (a?.org) parts.push(a.org)
  if (a?.email) parts.push(a.email)
  return parts.join(' · ')
}

/** Roomy enough to read at 9px, short enough not to wrap the tile. */
function shortDetail(state: ProviderState): string {
  if (state.ready) return 'READY'
  const d = state.detail.toLowerCase()
  if (d.includes('expired')) return 'LOGIN EXPIRED'
  if (d.includes('not signed in') || d.includes('no login')) return 'NOT SIGNED IN'
  if (d.includes('openai_api_key')) return 'NO API KEY'
  if (d.includes('too old')) return 'BRIDGE TOO OLD'
  if (d.includes('bridge')) return 'NO BRIDGE'
  return 'UNAVAILABLE'
}

export function Brains() {
  const provider = useStore((s) => s.provider)
  const setProvider = useStore((s) => s.setProvider)

  /**
   * The probe finishes during boot, after this has already mounted, and it
   * resolves outside React — so nothing would re-render on its own. One short
   * poll until it lands is less machinery than threading the result through
   * the store for a value that is read once and then never changes.
   */
  const [state, setState] = useState(probedProviders)
  useEffect(() => {
    /**
     * Land on a brain that can actually answer.
     *
     * Remembering the choice across reloads is right until the remembered one
     * stops working. Then every question goes to a dead brain and returns an
     * authentication error, with nothing on screen tying that error to that
     * tile -- so it reads as "it stopped working" rather than "you are asking
     * the wrong one". Observed exactly that way: one good answer from GPT,
     * then two questions into a Claude tile that could not serve them.
     *
     * Only ever moves off a brain that is down and onto one that is up, and
     * only once, before the first question. A deliberate choice between two
     * working brains is never overridden.
     */
    const settle = () => {
      const p = probedProviders()
      setState(p)
      const chosen = useStore.getState().provider
      if (p[chosen]?.ready) return
      const other: Provider = chosen === 'claude' ? 'gpt' : 'claude'
      if (p[other]?.ready) setProvider(other)
    }

    if (capabilitiesProbed()) {
      settle()
      return
    }
    const t = setInterval(() => {
      if (!capabilitiesProbed()) return
      settle()
      clearInterval(t)
    }, 300)
    return () => clearInterval(t)
  }, [setProvider])

  return (
    <div className="brains" role="group" aria-label="Which brain answers">
      {(['claude', 'gpt'] as Provider[]).map((name) => {
        const s = state[name]
        const selected = provider === name
        return (
          <button
            key={name}
            type="button"
            className={`brain${selected ? ' brain-on' : ''}${
              s.ready ? '' : ' brain-down'
            }`}
            aria-pressed={selected}
            // The full sentence from the bridge, including the command to run,
            // and which account it is signed in as. The face of the tile has
            // room for a verdict, not a remedy — see hoverLabel for why the
            // account belongs here rather than on it.
            title={hoverLabel(LABEL[name], s)}
            onClick={(e) => {
              setProvider(name)
              // Space and Enter both activate a focused button, and Space is
              // also the push-to-talk key. Dropping focus after the click
              // keeps the next Space press meaning "talk".
              e.currentTarget.blur()
            }}
          >
            <span className="brain-dot" />
            <span className="brain-name">{LABEL[name]}</span>
            <span className="brain-state">{shortDetail(s)}</span>
          </button>
        )
      })}
    </div>
  )
}
