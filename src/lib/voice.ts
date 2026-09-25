import { BRIDGE_HTTP_URL } from '../config'
import { getMic } from './audio'
import { speakingNow, speakingSince } from './tts'
import { startVad, type Vad } from './vad'
import { caps } from './capabilities'

/**
 * The voice loop.
 *
 * One recogniser, running for the life of the page. It is never torn down for
 * a turn, and that single fact is most of what separates this from a kiosk:
 * the microphone is still open while JARVIS is talking, so you can cut him off
 * the way you would cut off a person.
 *
 * The obvious design — one recogniser hunting for the wake word, a second one
 * capturing the command, stopping the first to start the second because the
 * browser only hands out one at a time — is what this replaces. It works, but
 * nothing is listening during an answer, so barge-in is impossible, and every
 * restart leaves a quarter-second of deafness that eats whole wake words.
 *
 * Keeping the mic open costs one thing: JARVIS hears himself through the
 * speakers. That is handled here in text rather than in acoustics — see
 * `isEcho` — because the browser gives SpeechRecognition its own capture and
 * won't let us put a canceller in front of it.
 */

export type VoiceMode =
  /** Powered down. Only his name matters. */
  | 'wake'
  /** He is expecting you to speak. Everything is a command. */
  | 'command'
  /** He is thinking or talking. Speech into the silence of thinking is a new
   *  request; speech over an answer he is audibly giving has to be addressed to
   *  him before it counts as one. */
  | 'guard'
  /** Something is playing that must not be transcribed at all. */
  | 'deaf'

export type VoiceHandlers = {
  /** Read fresh on every result, so the app never has to re-subscribe. */
  mode: () => VoiceMode
  /** Fired on his name, from a partial — waiting for endpointing feels slow.
   *  `trailing` is whatever followed it, so "Jarvis, what's the weather" is
   *  one breath rather than two turns. */
  onWake: (trailing: string) => void
  /** The user has genuinely started talking. This is the barge-in trigger. */
  onSpeechStart: () => void
  /** Live transcript, for the caption under the reactor. */
  onPartial: (text: string) => void
  /** A complete, endpointed utterance. */
  onUtterance: (text: string) => void
  /** The recogniser is unusable. Distinct from the user saying nothing. */
  onError: (message: string) => void
}

export type Voice = {
  stop: () => void
  /** True while a recogniser is actually running. */
  live: () => boolean
}

// ---------------------------------------------------------------------------
// Endpointing
// ---------------------------------------------------------------------------

/** One utterance often produces several partials containing his name. */
const WAKE_DEBOUNCE = 1500

/**
 * His name, and the only wake phrase.
 *
 * The optional prefix is genuinely optional: addressing him by name alone is
 * correct, and during an answer "Jarvis" on its own is the natural way to cut
 * in. The negative lookahead keeps possessives ("Jarvis's job") from waking him.
 *
 * The alternates are not padding. "Jarvis" is not in a general dictation
 * model's high-frequency vocabulary, and Chrome routinely returns Travis,
 * Jervis, Jarvys or Java's for a perfectly clear utterance — every one of which
 * used to be silently discarded, so the wake word "just didn't work" with no
 * indication why. Better a rare false wake than a name that does not answer.
 */
const NAME = "(?:jarvis|jarvys|jervis|jarvis's|travis|jarviss|java's|jarv)"
const GREETING = '(?:hey|hi|ok|okay|yo)?'
const WAKE = new RegExp(`\\b${GREETING}\\s*${NAME}\\b(?!'s)`, 'i')

/**
 * The same phrase, but at the head of the utterance — the shape of actually
 * addressing him rather than merely mentioning him.
 *
 * Anywhere-in-the-line is right for waking a dormant assistant, where his name
 * is the only thing being listened for. It is wrong as a licence to cut off an
 * answer, because the microphone is open to the whole room during one: a name
 * in the middle of a sentence spoken to somebody else is not an instruction,
 * and treating it as one is the same mistake as treating "please wait for
 * delivery" as a stop button. The punctuation class is what lets "Hey, Jarvis!"
 * through — a transcriber puts a comma after the greeting about half the time.
 */
const ADDRESSED = new RegExp(
  `^[\\s,.:;!?-]*${GREETING}[\\s,.:;!?-]*${NAME}\\b(?!'s)`,
  'i',
)

/**
 * The stop button, spoken.
 *
 * Anchored end to end, and that is the entire point of it. These words all
 * occur inside ordinary sentences — "we have enough time", "please wait for
 * delivery", "hold on to the receipt" — and an unanchored match on any of them
 * is indistinguishable from someone in the room finishing a different
 * conversation. A stop is a short, complete, unambiguous utterance; when it is
 * the whole of what was said there is nothing else it could have meant.
 */
const STOP_PHRASE =
  /^[\s,.!?-]*(?:please\s+)?(?:stop(?:\s+(?:now|it|that|please|talking))?|cancel(?:\s+that)?|be\s+quiet|quiet|enough|hold\s+on|shut\s+up|never\s?mind|forget\s+it)[\s.,!?]*$/i

/**
 * Is this someone deliberately taking the floor from him?
 *
 * The only question that matters while he is audibly speaking. Everything else
 * the room produces — background talk, a half-formed hypothesis the recogniser
 * is about to revise, his own voice coming back through the microphone — has to
 * leave the answer running.
 */
const isDeliberate = (text: string): boolean =>
  ADDRESSED.test(text) || STOP_PHRASE.test(text)

/** Everything after the wake phrase, which is usually the actual command. */
function afterWake(text: string): string {
  const m = WAKE.exec(text)
  if (!m) return ''
  return text
    .slice(m.index + m[0].length)
    .replace(/^[\s,.:;!?-]+/, '')
    .trim()
}

// ---------------------------------------------------------------------------
// Assembling one utterance out of several segments
// ---------------------------------------------------------------------------

/**
 * Why this exists.
 *
 * The voice-activity detector is an energy gate, and energy is a fact about the
 * room rather than about the sentence. It ends a segment after a fixed quiet
 * gap, so "what's the weather in — " *pause* " — London" is two segments, two
 * transcripts and, before this, two turns: the first one asking the model a
 * truncated question, the second arriving as a bare noun with no question left
 * to attach it to. People pause. They pause to think of the word, to look at
 * something, mid-list, before the important part. An assistant that treats the
 * first gap as the end of the thought is one you have to talk to carefully, and
 * having to talk carefully is the whole failure.
 *
 * So the segment is no longer the turn. Transcripts accumulate here, and the
 * turn fires only when the text looks finished AND the room has gone quiet.
 *
 * Crucially this costs nothing in the common case. A complete sentence with no
 * one speaking fires immediately — `holdFor` returns 0 — so the latency of an
 * ordinary question is exactly what it was. The waiting only happens when there
 * is a reason to wait.
 */

/**
 * Ending on one of these means the sentence is not over, whatever the silence
 * says. Function words only: they are closed-class, so the list is complete in
 * a way a content-word list could never be, and none of them is a plausible
 * last word of a real request.
 */
const CONTINUES =
  /\b(and|or|but|so|because|since|if|when|while|that|which|who|whose|to|of|in|on|at|by|for|with|from|about|into|onto|over|under|between|through|the|a|an|my|your|his|her|its|our|their|is|are|was|were|be|been|do|does|did|have|has|had|can|could|would|should|will|shall|might|must|like|than|then|as|very|really|just|some|any|all|both|either|neither)$/i

/** Trailing punctuation a transcriber emits mid-thought. */
const TRAILS = /[,;:–—-]$/

/**
 * Speech this soon after a sentence becomes audible is him, not you.
 *
 * Echo cancellation and the raised guard threshold stop most of his playback
 * reaching the detector, but the attack of the very first syllable is the
 * loudest, least-cancelled thing in the whole answer — it arrives before the
 * canceller has adapted to it. Without this, a long answer could interrupt
 * itself on its own first word, which reads as JARVIS refusing to speak.
 *
 * It is no longer the thing standing between playback and a cancellation — that
 * is now `isDeliberate`, which is a stronger test and does not expire. What the
 * window still does is attribute: a rejected fragment inside it is almost
 * certainly his own attack rather than a person, and `selfGuarded` says so,
 * which is the difference between reading the diagnostics and guessing at them.
 * A deliberate address is never held by it — the user who wants him to stop
 * within 350ms of the first syllable wants it most of all.
 *
 * Measured from real audio onset, not from the moment a sentence was queued;
 * see `speakingSince` in tts.ts for why that distinction cost a whole window.
 */
const SELF_GUARD_MS = 350

/**
 * A quiet gap this long with a finished-looking sentence ends the turn.
 *
 * Small on purpose: by the time a transcript reaches the assembler the detector
 * has already sat through SILENCE_MS of quiet and the transcriber has taken its
 * own few hundred milliseconds, so roughly a second of real silence has passed
 * already. All this window has to catch is someone drawing breath to add one
 * more clause. Making it generous here is what would make every ordinary
 * question feel slow.
 */
const SETTLE_MS = 250
/** ...and this long when the sentence is plainly unfinished. */
const CONTINUE_MS = 1600
/**
 * Nothing is held longer than this in total. A ceiling rather than a timer:
 * without it, someone who ends every clause on "and" could hold a turn open
 * for ever, and the assistant would look like it had stopped listening.
 */
const MAX_HOLD_MS = 6000

/**
 * How long to keep waiting, given what has been said so far.
 * 0 means "this is a complete thought, send it now".
 */
function holdFor(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean)
  if (!words.length) return CONTINUE_MS
  // An explicit terminator is the speaker telling us they are done.
  if (/[.!?]$/.test(text)) return 0
  if (TRAILS.test(text.trim())) return CONTINUE_MS
  if (CONTINUES.test(words[words.length - 1])) return CONTINUE_MS
  // One or two words is usually the start of something, not the whole of it —
  // except for the short commands that genuinely are complete.
  if (words.length <= 2 && !OVERRIDE.test(text)) return CONTINUE_MS
  return SETTLE_MS
}

type Assembler = {
  /** Add a transcript. `active` is true if the user is audibly still going. */
  feed: (text: string, active: boolean) => void
  /** Send whatever is held right now, if anything. */
  flush: () => void
  /** Throw away whatever is held — used when he stands down. */
  cancel: () => void
  held: () => string
}

function makeAssembler(h: {
  emit: (text: string) => void
  partial: (text: string) => void
}): Assembler {
  let held = ''
  let timer: ReturnType<typeof setTimeout> | null = null
  let firstAt = 0

  const clear = () => {
    if (timer) clearTimeout(timer)
    timer = null
  }

  const fire = () => {
    clear()
    const text = held.trim()
    held = ''
    firstAt = 0
    if (text) h.emit(text)
  }

  return {
    feed(text, active) {
      if (!text.trim()) return
      held = `${held} ${text}`.replace(/\s+/g, ' ').trim()
      if (!firstAt) firstAt = Date.now()
      // The caption shows the whole thought as it assembles, not just the
      // fragment that happened to arrive last.
      h.partial(held)
      diag.holding = held
      clear()

      // Already talking again. Decide nothing now — the next transcript is
      // part of this same sentence and will bring more of it.
      if (active) {
        timer = setTimeout(fire, MAX_HOLD_MS)
        return
      }

      const wait = Math.min(
        holdFor(held),
        Math.max(0, MAX_HOLD_MS - (Date.now() - firstAt)),
      )
      diag.waitedMs = wait
      if (wait === 0) {
        fire()
        return
      }
      timer = setTimeout(fire, wait)
    },
    flush: fire,
    cancel() {
      clear()
      held = ''
      firstAt = 0
      diag.holding = ''
    },
    held: () => held,
  }
}

// ---------------------------------------------------------------------------
// Hearing himself
// ---------------------------------------------------------------------------

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/**
 * Short words that must always cut through, even when they collide with what
 * he happens to be saying. Suppressing "stop" because he just said "stop"
 * would be the single most infuriating failure this file could have.
 *
 * "no" used to be on this list and was the reason he interrupted himself.
 * Membership buys one exemption: isEcho will not convict a line of being
 * playback on the strength of a word he did not himself just say. That is
 * correct for "stop", which is a button. It was ruinous for "no", which is the
 * most common word in his own speech — every "no record of it" and "there is
 * no" leaked into the microphone and cleared the gate. Membership here is not
 * "words that mean stop" — it is "words worth losing a sentence to". "no" is
 * not one; cancel, quiet and enough carry the same intent without appearing in
 * every other answer.
 *
 * What it is emphatically *not* is permission to cancel an answer. Being on
 * this list once did that too, and one list doing both jobs is what let "please
 * wait for delivery" — an ordinary sentence, spoken to someone else, containing
 * one of these words in the middle of it — stop him dead. Taking the floor is
 * `isDeliberate`, which asks about the whole utterance rather than about one
 * token inside it.
 */
const OVERRIDE =
  /\b(stop|wait|jarvis|cancel|enough|quiet|hold on|shut up|never ?mind|forget it)\b/i

/** Which overrides a line actually contains, normalised so the two sides of a
 *  comparison are the same shape. Multi-word entries survive `norm` intact. */
const OVERRIDE_ALL = new RegExp(OVERRIDE.source, 'gi')
const overridesIn = (text: string): string[] => norm(text).match(OVERRIDE_ALL) ?? []

/**
 * Words too common to be evidence of anything.
 *
 * This set is the difference between a usable filter and an infuriating one.
 * "What about the second one?" is a perfectly ordinary follow-up, and every
 * word in it is likely to appear somewhere in the answer it follows — so a
 * naive bag-of-words match suppresses the user's real question as an echo.
 * Only distinctive words count as proof he is hearing himself.
 */
const STOP = new Set(
  ('a an the and or but so of to in on at by for with from is are was were be ' +
    'it its this that these those i you he she we they me him her them my your ' +
    'our their what which who how why when where do does did can could would ' +
    'should will shall not no yes if then than as about into over under out up ' +
    'down one two three first second third now here there just very really got ' +
    'get have has had say said tell me okay ok well right').split(' '),
)

/**
 * Is this the microphone hearing the speakers?
 *
 * Compared as bags of words rather than by string distance: the recogniser
 * mangles its own playback badly enough that a substring match rarely holds,
 * but the *words* survive.
 */
function isEcho(heard: string, spoken: string): boolean {
  if (!spoken) return false

  const all = norm(heard).split(' ').filter(Boolean)
  if (!all.length) return true

  /**
   * An override word is only evidence when HE did not just say THAT word.
   *
   * This exemption exists so "stop" is never suppressed for colliding with his
   * speech, and that is right. But taken unconditionally it inverts: the more
   * ordinary the word, the more often his own playback contains it, and the
   * exemption then certifies his voice as the user's — after which the guard
   * check skips its remaining defences because the same word is on the same
   * list. Two independent gates, defeated by one token.
   *
   * The comparison is word against word, not list against list. Asking only
   * whether playback held *some* override is what turned a real interruption —
   * "Jarvis, open the report" over "Wait, I can open the report now" — into an
   * echo, on the strength of a word he never said.
   */
  const heardOverrides = overridesIn(heard)
  const spokenOverrides = new Set(overridesIn(spoken))
  if (heardOverrides.some((w) => !spokenOverrides.has(w))) return false

  const mine = new Set(norm(spoken).split(' '))

  /**
   * What is left once the overrides he is also saying are set aside. Those
   * prove nothing either way, so the rest of the utterance has to carry the
   * verdict alone — and when nothing is left to weigh, the benefit of the doubt
   * goes to the room. Hearing "stop now" while he says "I can stop now" is the
   * one case worth being wrong about, and it must not be dropped because the
   * single ordinary word left over happens to appear in his sentence too.
   */
  const rest = heardOverrides.length
    ? norm(heard).replace(OVERRIDE_ALL, ' ').split(' ').filter(Boolean)
    : all
  if (!rest.length) return false

  const content = rest.filter((w) => !STOP.has(w))

  // Nothing distinctive was said at all, so there is no strong evidence either
  // way. Demand a total match before discarding it — the cost of dropping a
  // real question is much higher than the cost of one stray echo getting in.
  if (content.length < 2) {
    if (rest.length < 2) return false
    return rest.every((w) => mine.has(w))
  }

  let hits = 0
  for (const w of content) if (mine.has(w)) hits++
  return hits / content.length >= 0.6
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/**
 * Live state of the voice loop, published on `window.__voice`.
 *
 * When someone says the wake word and nothing happens there are only a handful
 * of possible causes — the recogniser never started, it started and died, it is
 * running but hearing silence, or it is hearing you and transcribing the name
 * as something else. From outside the page those are indistinguishable, which
 * makes the failure impossible to report and impossible to fix. This tells them
 * apart in one glance.
 */
export const diag = {
  /** Which recognition provider is selected. */
  engine: 'browser',
  /** Whether the microphone pipeline is live. */
  running: false,
  /** Speech segments captured since load. */
  sessions: 0,
  /** The most recent transcript, whatever the mode. */
  heard: '',
  rawHeard: '',
  heardAt: 0,
  /** Last failure — a transcription error, or a capture error. */
  lastError: '',
  /** Times the wake word matched. */
  wakes: 0,
  /** Current mode, as the app last reported it. */
  mode: '',
  /** Why the last transcript was ignored — '' when it was accepted. */
  dropped: '',
  /** Transcripts accepted and passed to the app. */
  accepted: 0,
  /** Text assembled but not yet sent, because the thought looks unfinished. */
  holding: '',
  /** How long the assembler decided to wait before sending, in ms. */
  waitedMs: 0,
  /** Barge-ins suppressed because he had only just started the sentence. */
  selfGuarded: 0,
  /** Transcription failures (network, or the bridge speech proxy). */
  restarts: 0,
  /** Milliseconds the last transcription round-trip took. */
  idleMs: 0,
}

/** Record why a transcript went nowhere. Silence always has a reason; this is
 *  the difference between debugging it and speculating about it. */
function drop(why: string) {
  diag.dropped = why
}

if (typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__voice = diag
}

/**
 * Pick the voice engine and start it.
 *
 * Google and ElevenLabs use local segment capture with server transcription.
 * Browser recognition is the default when no cloud provider is selected.
 * An explicitly selected but unavailable provider reports its setup error.
 *
 * The microphone is opened once here so a denied permission is reported loudly
 * rather than surfacing later as an unexplained deafness, whichever engine runs.
 */
export async function startVoice(h: VoiceHandlers): Promise<Voice> {
  const capabilities = caps()
  diag.engine = capabilities.sttProvider ?? (capabilities.stt ? 'elevenlabs' : 'browser')
  if (!capabilities.stt && ['google', 'unavailable'].includes(diag.engine)) {
    diag.running = false
    diag.lastError = capabilities.sttDetail || 'Speech recognition needs configuration. Check the bridge setup.'
    h.onError(diag.lastError)
    return { stop: () => {}, live: () => false }
  }
  try {
    await getMic()
  } catch (err) {
    diag.lastError = 'mic'
    h.onError(
      err instanceof DOMException && err.name === 'NotAllowedError'
        ? 'Microphone access denied — voice input is unavailable.'
        : 'No microphone available.',
    )
    return { stop: () => {}, live: () => false }
  }
  return capabilities.stt ? startCloudVoice(h) : startBrowserVoice(h)
}

/** Local segment capture + the bridge's selected transcription provider. */
async function startCloudVoice(h: VoiceHandlers): Promise<Voice> {
  let lastWake = 0
  let vad: Vad | null = null
  let stopped = false
  const controller = new AbortController()
  const provider = diag.engine === 'google' ? 'Google' : 'ElevenLabs'

  /**
   * A captured segment, carried with the state of the room it was captured in.
   *
   * Transcription is not instant, and he does not stand still while it runs: by
   * the time Scribe answers, the sentence he was speaking when the microphone
   * heard something may be two sentences back. Deciding an echo against
   * whatever he happens to be saying *now* therefore compares a transcript with
   * the wrong audio, and the reference it needed has already scrolled away —
   * which is how a perfect recording of his own voice came back as a fresh
   * command addressed to him. So each segment carries its own reference.
   */
  type Segment = {
    blob: Blob
    /** What he was audibly saying while this was being recorded. */
    playback: string
    /** Whether any of it was recorded over real playback. */
    overSpeech: boolean
  }

  /** The candidate being recorded right now, from onset to end of segment. */
  let candidatePlayback = ''
  let candidateOverSpeech = false

  /**
   * Segments waiting for the transcriber, oldest first.
   *
   * This was a boolean — `if (transcribing) return` — and that single line was
   * the worst bug in the pause story. Segments arrive faster than Scribe
   * answers whenever someone speaks in bursts, which is exactly what pausing
   * mid-sentence looks like, so the second half of the thought was not merely
   * mis-timed, it was silently discarded. Queue instead: nothing a person says
   * out loud gets thrown away because the network was busy.
   *
   * Order is preserved because the drain is single-flight, which matters —
   * "London" arriving before "what's the weather in" is worse than either.
   */
  const pendingAudio: Segment[] = []
  let draining = false

  /**
   * Transcripts become turns here rather than one-per-segment.
   * See makeAssembler for why.
   */
  const assemble = makeAssembler({
    emit: (text) => {
      diag.dropped = ''
      diag.accepted++
      diag.holding = ''
      h.onUtterance(text)
    },
    partial: (text) => h.onPartial(text),
  })

  /**
   * Send one captured segment to the bridge and act on the words.
   *
   * The mode is re-read here, not at capture time, because a barge-in flips the
   * machine from 'guard' to 'listening' between the segment starting and its
   * transcript arriving — and the transcript belongs to the mode the user is in
   * now, not the one they interrupted.
   */
  const transcribe = async (seg: Segment) => {
    const mode = h.mode()
    if (stopped || mode === 'deaf') return
    const stale = () => stopped || h.mode() === 'deaf' || (mode !== 'wake' && h.mode() === 'wake')
    const t0 = performance.now()
    try {
      const res = await fetch(`${BRIDGE_HTTP_URL}/stt`, {
        method: 'POST',
        headers: { 'content-type': seg.blob.type || 'audio/webm' },
        body: seg.blob,
        signal: controller.signal,
      })
      // Words that arrive after the loop was torn down, or after something
      // muted it, belong to a conversation that no longer exists. Acting on
      // them opens a turn nobody asked for, in a page that may have moved on
      // entirely — the network round trip is exactly long enough for that.
      if (stale()) {
        drop('the segment outlived the session it was spoken in')
        return
      }
      diag.idleMs = Math.round(performance.now() - t0)
      if (!res.ok) {
        // Google errors are sanitized by the bridge. Other upstream responses
        // stay out of the interface because they may carry account details.
        const detail = provider === 'Google' ? (await res.text()).slice(0, 400).trim() : ''
        if (stale()) return
        diag.restarts++
        diag.lastError = detail || `${provider} transcription failed (${res.status}). Check the speech service and try again.`
        drop(`transcription failed (${res.status})`)
        h.onError(diag.lastError)
        return
      }
      const { text, rawText } = (await res.json()) as { text?: string; rawText?: string }
      if (stale()) return
      const said = typeof text === 'string' ? text.trim() : ''
      diag.lastError = ''
      diag.rawHeard = typeof rawText === 'string' && rawText.trim() !== said ? rawText.trim() : ''

      if (!said) {
        drop('nothing intelligible in the segment')
        return
      }

      // His own voice, come back through the microphone. The raised guard
      // threshold stops most of it at the door; this catches the rest. Compared
      // against what he was saying when this audio was captured, not what he is
      // saying now — see Segment.
      if (isEcho(said, seg.playback)) {
        drop('echo of his own voice')
        return
      }

      // A queued recording keeps the policy of the room it was captured in,
      // even if the answer finished while Google was transcribing it.
      if (seg.overSpeech && !isDeliberate(said)) {
        drop('background speech captured during playback')
        return
      }

      diag.heard = said
      diag.heardAt = Date.now()

      if (mode === 'wake') {
        if (WAKE.test(said) && Date.now() - lastWake > WAKE_DEBOUNCE) {
          lastWake = Date.now()
          diag.wakes++
          diag.dropped = ''
          diag.accepted++
          h.onWake(afterWake(said))
        } else {
          drop(`heard "${said.slice(-40)}" — not his name`)
        }
        return
      }

      /**
       * The barge-in, decided on words rather than on loudness.
       *
       * This used to fire at the energy onset, before anything had been
       * transcribed — which meant the answer was already dead by the time we
       * learned the segment was empty, or noise, or him. Cancelling is not
       * reversible: you cannot un-interrupt an assistant, and every false one
       * costs the user the sentence they were listening to. So the segment now
       * has to say something, and while he is audibly speaking it has to say
       * something addressed to him.
       *
       * The cost is honest: a segment has to end before Scribe can transcribe
       * it, so this engine confirms an interruption rather than reacting to it.
       * That is a property of doing recognition over the network, not a setting.
       */
      if (h.mode() === 'guard') {
        h.onSpeechStart()
      }

      // Not a turn yet — a piece of one. The assembler decides when the thought
      // is finished, reading the words and whether the room is still noisy.
      assemble.feed(said, vad?.meter().speaking ?? false)
    } catch {
      if (stale()) return
      diag.restarts++
      diag.lastError = `${provider} transcription could not be completed. Check the bridge and connection, then try again.`
      drop('could not reach the speech service')
      h.onError(diag.lastError)
    }
  }

  /** One transcription at a time, in the order the segments were spoken. */
  const drain = async () => {
    if (draining) return
    draining = true
    try {
      while (pendingAudio.length) {
        await transcribe(pendingAudio.shift()!)
      }
    } finally {
      draining = false
    }
  }

  vad = await startVad({
    onStart: () => {
      const mode = h.mode()
      diag.mode = mode
      diag.sessions++
      if (mode === 'deaf') return
      // Standing down mid-thought throws the thought away with it. Otherwise
      // held text would surface as the opening of the *next* conversation.
      if (mode === 'wake') assemble.cancel()
      /**
       * Energy is a fact about the room, not about who is in it.
       *
       * This is where the answer used to be cancelled — on loudness alone, a
       * whole segment before anyone knew whether a word had been said. A door,
       * a chair, a cough and his own first syllable all pass the same gate, and
       * every one of them killed the sentence outright; by the time the
       * transcript came back empty there was nothing left to restore. So the
       * onset only opens a candidate now, and takes down the one thing that
       * will not survive the wait: what he is saying while it records.
       */
      candidatePlayback = speakingNow()
      candidateOverSpeech = speakingSince() > 0
    },
    onEnd: (blob) => {
      if (stopped || h.mode() === 'deaf') return
      // Both ends of the segment, because he may have started or finished a
      // sentence part way through it and either half could be the echo.
      const atEnd = speakingNow()
      const playback =
        candidatePlayback && atEnd && atEnd !== candidatePlayback
          ? `${candidatePlayback} ${atEnd}`
          : candidatePlayback || atEnd
      pendingAudio.push({
        blob,
        playback,
        overSpeech: candidateOverSpeech || speakingSince() > 0,
      })
      candidatePlayback = ''
      candidateOverSpeech = false
      void drain()
    },
    onLevel: (v) => {
      // Only paint the live level while actually listening for a command, so a
      // dormant reactor stays calm and does not twitch at every room noise.
      const mode = h.mode()
      if (mode !== 'command') return
      // Never over the assembled text. This used to run unconditionally and
      // overwrote a half-built sentence with an ellipsis sixty times a second,
      // so a pause looked like the interface had forgotten what you just said.
      if (assemble.held()) return
      h.onPartial(v > 0.04 ? '…' : '')
    },
    onError: (message) => {
      diag.lastError = 'capture'
      diag.running = false
      h.onError(message)
    },
  })
  diag.running = vad.live()

  // Raise the trigger bar exactly while he speaks. The mode is polled rather
  // than pushed because nothing in the app pushes phase changes here, and a
  // 200ms lag on the echo gate is imperceptible.
  const guardPoll = setInterval(() => {
    const mode = h.mode()
    vad?.setGuard(mode === 'guard')
    // He has stood down — by Escape, by the idle timeout, or by dropping back
    // to the wake word. Anything half-said belonged to a conversation that is
    // over, and letting the hold expire later would open the next one with a
    // fragment of the last.
    if ((mode === 'wake' || mode === 'deaf') && assemble.held()) assemble.cancel()
  }, 200)

  return {
    stop: () => {
      stopped = true
      controller.abort()
      clearInterval(guardPoll)
      assemble.cancel()
      pendingAudio.length = 0
      vad?.stop()
      diag.running = false
    },
    live: () => !stopped && (vad?.live() ?? false),
  }
}

/* -------------------------------------------------------------------------- */
/* Browser fallback: SpeechRecognition                                        */
/* -------------------------------------------------------------------------- */

/**
 * The keyless path. Uses the browser's own SpeechRecognition for both detection
 * and transcription, so a student who has configured nothing still gets voice.
 *
 * It is the flakier engine — Chrome throttles it and it can go silent with no
 * event to catch — so a heartbeat watches it and forces a fresh session
 * whenever it stops showing signs of life. That single guard is the difference
 * between "the wake word stopped working halfway through the lesson" and an
 * assistant that keeps listening.
 */
function startBrowserVoice(h: VoiceHandlers): Voice {
  const Ctor =
    (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition
  if (!Ctor) {
    h.onError('This browser has no speech recognition — use Chrome or Edge, or add an ElevenLabs key.')
    return { stop: () => {}, live: () => false }
  }

  let stopped = false
  let running = false
  let rec: any = null
  let settled = ''
  let interim = ''
  let started = false
  let barged = false
  let lastWake = 0
  let lastAlive = Date.now()
  let silenceTimer: ReturnType<typeof setTimeout> | null = null

  /** Same assembly rules as the premium path — a pause is not a full stop. */
  const assemble = makeAssembler({
    emit: (text) => {
      diag.dropped = ''
      diag.accepted++
      diag.holding = ''
      h.onUtterance(text)
    },
    partial: (text) => h.onPartial(text),
  })

  const touch = () => {
    lastAlive = Date.now()
  }

  const clearSilence = () => {
    if (silenceTimer) clearTimeout(silenceTimer)
    silenceTimer = null
  }

  const reset = () => {
    clearSilence()
    settled = ''
    interim = ''
    started = false
    barged = false
  }

  const emit = () => {
    const text = `${settled} ${interim}`.replace(/\s+/g, ' ').trim()
    const mode = h.mode()
    reset()
    if (!text || mode === 'deaf') return
    if (isEcho(text, speakingNow())) {
      drop('echo of his own voice')
      return
    }
    diag.heard = text
    diag.heardAt = Date.now()
    if (mode === 'wake') {
      assemble.cancel()
      if (WAKE.test(text) && Date.now() - lastWake > WAKE_DEBOUNCE) {
        lastWake = Date.now()
        diag.wakes++
        diag.dropped = ''
        diag.accepted++
        h.onWake(afterWake(text))
      } else {
        drop(`heard "${text.slice(-40)}" — not his name`)
      }
      return
    }
    // The recogniser has already endpointed on its own 900ms gap; the assembler
    // decides whether that gap actually ended the thought. `false` because a
    // result only reaches here once the recogniser has gone quiet.
    assemble.feed(text, false)
  }

  const bumpSilence = () => {
    clearSilence()
    // Endpoint on a short quiet gap; the ElevenLabs path tunes this more
    // finely, but a fixed window is plenty for the fallback.
    silenceTimer = setTimeout(emit, 900)
  }

  const onResult = (e: any) => {
    touch()
    const mode = h.mode()
    diag.mode = mode
    if (mode === 'deaf') {
      interim = ''
      return
    }
    let fresh = ''
    interim = ''
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const chunk = e.results[i][0].transcript as string
      if (e.results[i].isFinal) fresh += chunk
      else interim += chunk
    }
    const heard = `${settled}${fresh} ${interim}`.replace(/\s+/g, ' ').trim()
    if (!heard) return
    if (isEcho(`${fresh} ${interim}`, speakingNow())) {
      interim = ''
      return
    }

    if (mode === 'wake') {
      settled += fresh
      if (WAKE.test(heard) && Date.now() - lastWake > WAKE_DEBOUNCE) {
        lastWake = Date.now()
        diag.wakes++
        const trailing = afterWake(heard)
        reset()
        h.onWake(trailing)
      } else if (settled.length > 400) {
        settled = ''
      }
      return
    }

    settled += fresh
    const full = `${settled} ${interim}`.replace(/\s+/g, ' ').trim()
    if (!started || (mode === 'guard' && !barged)) {
      const words = full.split(/\s+/).filter(Boolean).length
      if (mode === 'guard') {
        // A deliberate address or a spoken stop cuts through everything below
        // it, on the first partial, mid-syllable if that is when it arrives.
        // "Stop" has to work on the first syllable or it is not a stop button.
        if (!isDeliberate(full)) {
          /**
           * Is there actually sound coming out of the speakers?
           *
           * Not "is the machine in guard mode" — guard also covers thinking and
           * running a tool, where the room is silent and anything said is
           * plainly meant for him. The distinction is the whole of this branch:
           * over playback the microphone is hearing him as well as you, so an
           * unaddressed line is not evidence of anyone wanting the floor, and
           * an interim hypothesis is not even evidence of what was said. The
           * recogniser revises "yes please" into a piece of his own sentence
           * routinely, and the revision arrives after the answer would already
           * have been cancelled.
           */
          if (speakingSince()) {
            if (Date.now() - speakingSince() < SELF_GUARD_MS) diag.selfGuarded++
            drop(`heard "${full.slice(-40)}" over his answer — not addressed to him`)
            /**
             * And it is not kept, either.
             *
             * Rejected fragments used to sit in `settled` with no expiry, so a
             * word discarded at the start of an answer was still there minutes
             * later, waiting for one more stray word to push the count over
             * two. An interruption assembled out of two unrelated syllables
             * spoken a quiet gap apart is not an interruption; nothing about
             * the first one survives being rejected.
             */
            settled = ''
            interim = ''
            return
          }
          // Nothing is playing — he is thinking, or a tool is running — so this
          // is someone talking into a quiet room, and that is a new request.
          // Still not on one word: a lone token from an open microphone is as
          // likely to be a cough the recogniser named as it is to be speech.
          if (words < 2) return
        }
      }
      started = true
      if (mode === 'guard') barged = true
      h.onSpeechStart()
    }
    diag.dropped = ''
    // Show the whole thought, not just the fragment being spoken now — there
    // may be an earlier half of it held by the assembler.
    const carried = assemble.held()
    h.onPartial(carried ? `${carried} ${full}` : full)
    bumpSilence()
  }

  const spin = () => {
    if (stopped || running) return
    rec = new Ctor()
    rec.continuous = true
    rec.interimResults = true
    rec.lang = 'en-GB'
    rec.onstart = () => {
      running = true
      diag.running = true
      diag.sessions++
      touch()
    }
    rec.onresult = onResult
    rec.onerror = (ev: any) => {
      diag.lastError = String(ev.error ?? '')
      if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
        stopped = true
        diag.running = false
        h.onError('Microphone access was refused — voice input is unavailable.')
      }
    }
    rec.onend = () => {
      running = false
      diag.running = false
      touch()
      rec = null
      if (!stopped) setTimeout(spin, 80)
    }
    try {
      rec.start()
    } catch {
      running = false
      setTimeout(spin, 250)
    }
  }

  spin()

  // The heartbeat. If nothing has been heard from the engine for a while it has
  // gone quiet on us — tear it down and build a fresh one.
  const health = setInterval(() => {
    if (stopped) return
    const idle = Date.now() - lastAlive
    diag.idleMs = idle
    if (idle < 15000) return
    diag.restarts++
    try {
      rec?.abort()
    } catch {
      /* already gone */
    }
    rec = null
    running = false
    diag.running = false
    touch()
    spin()
  }, 5000)

  return {
    stop: () => {
      stopped = true
      clearInterval(health)
      clearSilence()
      assemble.cancel()
      diag.running = false
      try {
        rec?.abort()
      } catch {
        /* noop */
      }
    },
    live: () => running,
  }
}
