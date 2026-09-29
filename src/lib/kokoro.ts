/** Optional on-device neural speech, with a system-voice fallback. */
import { KOKORO_VOICE } from '../config'
import { KOKORO_SPEED } from '../../shared/voice.mjs'

type Kokoro = {
  generate: (
    text: string,
    opts: { voice: string; speed?: number },
  ) => Promise<{ toBlob: () => Blob }>
}

let model: Kokoro | null = null
let loading: Promise<Kokoro | null> | null = null
let failed = false

/** 0..1 while the model downloads, for the boot readout. */
let progress = 0
export const loadProgress = () => progress
export const isReady = () => model !== null
export const isUnavailable = () => failed

/** Exposed for diagnosis — the console warning alone is easy to miss. */
export let lastError = ''

/**
 * Generation failures latch after this many in a row. One is worth retrying —
 * a WebGPU device can be lost and recovered — but a run of them means the
 * engine is not going to work on this machine, and it is better to drop to the
 * system voice for good than to alternate between the two mid-conversation.
 */
const MAX_FAILURES = 3
let failures = 0

export async function load(): Promise<Kokoro | null> {
  if (model) return model
  if (failed) return null
  if (loading) return loading

  loading = (async () => {
    try {
      const { KokoroTTS } = await import('kokoro-js')
      const tts = await KokoroTTS.from_pretrained(
        'onnx-community/Kokoro-82M-v1.0-ONNX',
        {
          // q8 is about 86MB against fp32's 330MB, and the difference is
          // inaudible through laptop speakers. WebGPU keeps generation ahead
          // of playback; without it this would be too slow to converse with.
          dtype: 'q8',
          device: 'webgpu',
          // The callback is a union across several event shapes; only the
          // download-progress one carries a percentage.
          progress_callback: (p: unknown) => {
            const pct = (p as { progress?: number })?.progress
            if (typeof pct === 'number') progress = pct / 100
          },
        },
      )
      progress = 1
      model = tts as unknown as Kokoro
      return model
    } catch (err) {
      console.warn('[jarvis] kokoro unavailable, using the system voice:', err)
      lastError = String((err as Error)?.message ?? err)
      failed = true
      return null
    } finally {
      loading = null
    }
  })()

  return loading
}

/** Synthesise one sentence. Returns null if the model isn't usable. */
export async function speak(text: string): Promise<string | null> {
  const tts = await load()
  if (!tts) return null
  try {
    const audio = await tts.generate(text, {
      voice: KOKORO_VOICE,
      speed: KOKORO_SPEED,
    })
    failures = 0
    return URL.createObjectURL(audio.toBlob())
  } catch (err) {
    // Surfaced rather than swallowed: a silent null here just looks like the
    // voice quietly reverting to the system one with no explanation.
    console.error('[jarvis] kokoro generation failed:', err)
    lastError = String((err as Error)?.message ?? err)
    failures++
    if (failures >= MAX_FAILURES) {
      // Nothing else sets this on the generation path, so without it tts.ts
      // keeps routing every sentence here and every sentence keeps throwing.
      failed = true
      console.warn(
        `[jarvis] kokoro failed ${failures} times running — the system voice from here on.`,
      )
    }
    return null
  }
}
