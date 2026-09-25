import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

const source = ts.transpileModule(
  await readFile(new URL('./tts.ts', import.meta.url), 'utf8'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
).outputText

const settle = () => new Promise(setImmediate)

// Drive the public speaker and actual engine callbacks, with no audio device,
// provider requests, or wall-clock timers. Synthesis and playback start are
// independent events: fetching or queueing audio is not audible playback.
function harness(t, engine, { delayedCancelEvent = false } = {}) {
  let now = 10000
  let utterance, audio, synthesisResponse
  const imports = {
    '../config': {
      env: {}, USE_ELEVENLABS: false, BACKEND: 'bridge',
      TTS_ENGINE: 'system', KOKORO_VOICE: 'unused',
      BRIDGE_HTTP_URL: 'http://synthetic.invalid',
    },
    './kokoro': { isUnavailable: () => true },
    './capabilities': { caps: () => ({ tts: engine === 'cloud' }) },
  }
  const context = vm.createContext({
    exports: {},
    require(name) {
      assert.ok(Object.hasOwn(imports, name), `Unexpected dependency: ${name}`)
      return imports[name]
    },
    window: {},
    Date: { now: () => now },
    speechSynthesis: {
      getVoices: () => [], addEventListener() {}, resume() {}, pause() {},
      speak(value) { utterance = value },
      cancel() { if (!delayedCancelEvent) utterance?.onend?.() },
    },
    SpeechSynthesisUtterance: class { constructor(text) { this.text = text } },
    Audio: class {
      constructor(url) { assert.equal(url, 'blob:synthetic'); audio = this }
      play() { return Promise.resolve() }
      pause() { if (!delayedCancelEvent) this.onpause?.() }
    },
    URL: { createObjectURL: () => 'blob:synthetic', revokeObjectURL() {} },
    fetch(url, options) {
      assert.equal(url, 'http://synthetic.invalid/tts')
      assert.equal(options.method, 'POST')
      return new Promise((resolve) => { synthesisResponse = resolve })
    },
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    setTimeout: () => 1, clearTimeout() {},
    setInterval: () => 1, clearInterval() {},
  })
  vm.runInContext(source, context, { filename: 'tts.ts' })
  const speaker = context.exports.createSpeaker()
  t.after(() => speaker.cancel())
  return {
    speaker,
    since: () => context.exports.speakingSince(),
    text: () => context.exports.speakingNow(),
    now: (value) => { now = value },
    newSpeaker() {
      const next = context.exports.createSpeaker()
      t.after(() => next.cancel())
      return next
    },
    callbacks() {
      const target = engine === 'cloud' ? audio : utterance
      return {
        start: () => engine === 'cloud' ? target.onplaying() : target.onstart(),
        finish: () => engine === 'cloud' ? target.onended() : target.onend(),
      }
    },
    async synthesised() {
      if (engine === 'cloud') {
        assert.equal(typeof synthesisResponse, 'function')
        synthesisResponse({ ok: true, blob: async () => ({}) })
        await settle()
      }
    },
    start() {
      if (engine === 'cloud') audio.onplaying()
      else utterance.onstart()
    },
    finish() {
      if (engine === 'cloud') audio.onended()
      else utterance.onend()
    },
  }
}

for (const engine of ['native', 'cloud']) {
  test(`${engine} speaker clock stays idle while queued and starts at audible playback`, async (t) => {
    const voice = harness(t, engine)
    voice.speaker.say('The report is ready.')
    assert.equal(voice.since(), 0, 'queueing or synthesising must not spend the playback guard')
    voice.now(11000)
    await voice.synthesised()
    assert.equal(voice.since(), 0, 'audio ready but not playing must still be idle')
    voice.now(11500)
    voice.start()
    assert.equal(voice.since(), 11500)
    const drained = voice.speaker.end()
    voice.finish()
    await drained
    assert.equal(voice.since(), 0)
  })

  test(`${engine} speaker uses actual start time and clears it when cancelled`, async (t) => {
    const voice = harness(t, engine)
    voice.speaker.say('The report is ready.')
    voice.now(11000)
    await voice.synthesised()
    voice.now(11500)
    voice.start()
    assert.equal(voice.since(), 11500, 'the clock must not retain the earlier queue timestamp')
    const drained = voice.speaker.end()
    voice.speaker.cancel()
    await drained
    assert.equal(voice.since(), 0)
  })

  test(`${engine} late cancelled-speaker callbacks preserve replacement playback and echo context`, async (t) => {
    const voice = harness(t, engine, { delayedCancelEvent: true })
    voice.speaker.say('The report is ready.')
    await voice.synthesised()
    voice.start()
    const old = voice.callbacks()
    voice.speaker.cancel()
    const replacement = voice.newSpeaker()
    // Identical wording is still a different utterance and must retain ownership.
    replacement.say('The report is ready.')
    await voice.synthesised()
    voice.now(12000)
    voice.start()
    assert.equal(voice.since(), 12000)
    voice.now(12100)
    old.finish()
    await settle()
    assert.equal(voice.since(), 12000, 'a delayed old completion must not clear replacement playback')
    voice.now(14000)
    assert.match(voice.text(), /The report is ready\./, 'replacement echo text must survive after the old tail expires')
    old.start()
    assert.equal(voice.since(), 12000, 'a stale start must not reset the replacement clock')
    replacement.cancel()
    voice.finish()
  })

  test(`${engine} cancelling an already-finished speaker leaves newer playback running`, async (t) => {
    const voice = harness(t, engine)
    voice.speaker.say('The previous answer.')
    await voice.synthesised()
    voice.start()
    const drained = voice.speaker.end()
    voice.finish()
    await drained
    const replacement = voice.newSpeaker()
    replacement.say('The current answer.')
    await voice.synthesised()
    voice.now(12000)
    voice.start()
    voice.speaker.cancel()
    assert.equal(voice.since(), 12000)
    voice.now(14000)
    assert.match(voice.text(), /The current answer\./)
    replacement.cancel()
  })
}
