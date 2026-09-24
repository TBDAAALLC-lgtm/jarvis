import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

const source = ts.transpileModule(
  await readFile(new URL('./voice.ts', import.meta.url), 'utf8'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
).outputText

// Exercise the public entry point and real callbacks without opening a microphone,
// contacting a transcriber, or depending on wall-clock recognition delays.
async function harness(t, { engine, spoken, mode = 'guard', age = 1000 }) {
  let now = 10000
  const speakingAt = now - age
  let nextTimer = 0
  let recognizer, vadHandlers, transcript
  const timers = new Map()
  const events = { starts: 0, wakes: [], utterances: [], errors: [] }
  class Recognition {
    constructor() { recognizer = this }
    start() { this.onstart() }
    abort() {}
  }
  const imports = {
    '../config': { BRIDGE_HTTP_URL: 'http://synthetic.invalid' },
    './audio': { getMic: async () => ({}) },
    './tts': { speakingNow: () => spoken, speakingSince: () => speakingAt },
    './vad': {
      startVad: async (handlers) => {
        vadHandlers = handlers
        return {
          live: () => true,
          meter: () => ({ speaking: false }),
          setGuard() {},
          stop() {},
        }
      },
    },
    './capabilities': { caps: () => ({ stt: engine === 'elevenlabs' }) },
  }
  const context = vm.createContext({
    exports: {},
    require: (name) => {
      assert.ok(Object.hasOwn(imports, name), `Unexpected dependency: ${name}`)
      return imports[name]
    },
    window: { SpeechRecognition: Recognition },
    Date: { now: () => now },
    performance: { now: () => now },
    setTimeout: (fn, delay) => {
      const id = ++nextTimer
      timers.set(id, { fn, at: now + delay })
      return id
    },
    clearTimeout: (id) => timers.delete(id),
    setInterval: () => ++nextTimer,
    clearInterval() {},
    fetch: async (url, options) => {
      assert.equal(url, 'http://synthetic.invalid/stt')
      assert.equal(options.method, 'POST')
      return { ok: true, json: async () => ({ text: transcript }) }
    },
  })
  vm.runInContext(source, context, { filename: 'voice.ts' })
  const voice = await context.exports.startVoice({
    mode: () => mode,
    onWake: (text) => events.wakes.push(text),
    onSpeechStart: () => { events.starts++; mode = 'command' },
    onPartial() {},
    onUtterance: (text) => events.utterances.push(text),
    onError: (error) => events.errors.push(error),
  })
  t.after(() => voice.stop())
  assert.equal(voice.live(), true)

  return {
    events,
    async hear(text) {
      if (engine === 'browser') {
        const result = [{ transcript: text }]
        result.isFinal = true
        recognizer.onresult({ resultIndex: 0, results: [result] })
      } else {
        transcript = text
        vadHandlers.onStart()
        vadHandlers.onEnd({ type: 'audio/synthetic' })
        // The real transcription drain is asynchronous and does not return its
        // promise to onEnd; let its mocked fetch/json microtasks settle.
        await new Promise(setImmediate)
      }
      const end = now + 2000
      for (;;) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0]
        if (!next || next[1].at > end) break
        const [id, timer] = next
        timers.delete(id)
        now = timer.at
        timer.fn()
      }
      now = end
      assert.deepEqual(events.errors, [])
    },
  }
}

const echoes = [
  { spoken: 'There is no record of it, sir.', heard: 'no record of it sir' },
  { spoken: 'There is no second moon.', heard: 'there is no second moon' },
  { spoken: 'No, the figure is lower, sir.', heard: 'no the figure is lower sir' },
]

for (const engine of ['browser', 'elevenlabs']) {
  for (const { spoken, heard } of echoes) {
    test(`${engine} suppresses playback transcript: ${heard}`, async (t) => {
      const voice = await harness(t, { engine, spoken })
      await voice.hear(heard)
      assert.deepEqual(voice.events.utterances, [])
      assert.deepEqual(voice.events.wakes, [])
      // ElevenLabs interrupts on VAD onset before it has any words. These tests
      // cover transcript filtering, not acoustic cancellation or VAD accuracy.
      if (engine === 'browser') assert.equal(voice.events.starts, 0)
    })
  }

  for (const heard of ['stop', 'stop now']) {
    test(`${engine} accepts explicit "${heard}" even when playback contains it`, async (t) => {
      const voice = await harness(t, {
        engine,
        spoken: 'I can stop now if you need me to.',
        // The browser's explicit stop must also bypass the first-syllable guard.
        age: engine === 'browser' ? 100 : 1000,
      })
      await voice.hear(heard)
      assert.equal(voice.events.starts, 1)
      assert.deepEqual(voice.events.utterances, [heard])
    })
  }
}

test('browser accepts a Jarvis interruption when playback contains a different override', async (t) => {
  const voice = await harness(t, {
    engine: 'browser',
    spoken: 'Wait, I can open the report now.',
    age: 100,
  })
  await voice.hear('Jarvis, open the report')
  assert.equal(voice.events.starts, 1)
  assert.deepEqual(voice.events.utterances, ['Jarvis, open the report'])
})

for (const engine of ['browser', 'elevenlabs']) {
  test(`${engine} accepts a Jarvis wake when playback contains a different override`, async (t) => {
    const voice = await harness(t, {
      engine,
      spoken: 'Wait, I can open the report now.',
      mode: 'wake',
    })
    await voice.hear('Jarvis, open the report')
    assert.deepEqual(voice.events.wakes, ['open the report'])
    assert.deepEqual(voice.events.utterances, [])
  })
}
