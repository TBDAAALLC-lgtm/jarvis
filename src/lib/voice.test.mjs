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
async function harness(t, {
  engine, spoken = '', mode = 'guard', age = 1000, deferTranscription = false,
  capabilityOverrides = {}, expectedLive = true,
}) {
  let now = 10000
  let speakingAt = spoken ? now - age : 0
  let nextTimer = 0
  let recognizer, vadHandlers, transcript, completeTranscription, resolveJson, rejectJson
  let vadLive = false
  const responseQueue = []
  const activity = { mic: 0, browser: 0, vad: 0, requests: 0, jsonReads: 0, signals: [] }
  const timers = new Map()
  const events = { starts: 0, wakes: [], utterances: [], partials: [], errors: [] }
  class Recognition {
    constructor() { recognizer = this; activity.browser++ }
    start() { this.onstart() }
    abort() {}
  }
  const imports = {
    '../config': { BRIDGE_HTTP_URL: 'http://synthetic.invalid' },
    './audio': { getMic: async () => { activity.mic++; return {} } },
    './tts': { speakingNow: () => spoken, speakingSince: () => speakingAt },
    './vad': {
      startVad: async (handlers) => {
        activity.vad++
        vadLive = true
        vadHandlers = handlers
        return {
          live: () => vadLive,
          meter: () => ({ speaking: false }),
          setGuard() {},
          stop() { vadLive = false },
        }
      },
    },
    './capabilities': { caps: () => ({ stt: engine !== 'browser', ...capabilityOverrides }) },
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
    AbortController,
    AbortSignal,
    DOMException,
    fetch: async (url, options) => {
      activity.requests++
      activity.signals.push(options.signal)
      assert.equal(url, 'http://synthetic.invalid/stt')
      assert.equal(options.method, 'POST')
      const text = transcript
      const spec = responseQueue.shift() ?? {}
      const status = spec.status ?? 200
      const response = {
        ok: status >= 200 && status < 300,
        status,
        text: async () => spec.text ?? '',
        json: async () => {
          activity.jsonReads++
          if (spec.deferJson) {
            return new Promise((resolve, reject) => { resolveJson = resolve; rejectJson = reject })
          }
          if (spec.jsonError) throw spec.jsonError
          return spec.json ?? { text }
        },
      }
      if (deferTranscription) {
        return new Promise((resolve) => { completeTranscription = () => resolve(response) })
      }
      return response
    },
  })
  vm.runInContext(source, context, { filename: 'voice.ts' })
  const voice = await context.exports.startVoice({
    mode: () => mode,
    onWake: (text) => events.wakes.push(text),
    onSpeechStart: () => { events.starts++; mode = 'command' },
    onPartial: (text) => events.partials.push(text),
    onUtterance: (text) => events.utterances.push(text),
    onError: (error) => events.errors.push(error),
  })
  t.after(() => voice.stop())
  assert.equal(voice.live(), expectedLive)

  const advance = (ms) => {
    const end = now + ms
    for (;;) {
      const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0]
      if (!next || next[1].at > end) break
      const [id, timer] = next
      timers.delete(id)
      now = timer.at
      timer.fn()
    }
    now = end
  }

  const segmentEnd = async (text) => {
    transcript = text
    vadHandlers.onEnd({ type: 'audio/synthetic' })
    // The real transcription drain is asynchronous and does not return its
    // promise to onEnd; let its mocked fetch/json microtasks settle.
    await new Promise(setImmediate)
  }

  const input = {
    events,
    activity,
    diag: context.exports.diag,
    live: () => voice.live(),
    advance,
    setMode(value) { mode = value },
    queueResponse: (response) => responseQueue.push(response),
    stop: () => voice.stop(),
    async completeJson(payload, error) {
      assert.equal(typeof resolveJson, 'function')
      if (error) rejectJson(error)
      else resolveJson(payload)
      await new Promise(setImmediate)
    },
    async completeTranscription() {
      assert.equal(typeof completeTranscription, 'function')
      completeTranscription()
      await new Promise(setImmediate)
    },
    setPlayback(text, age = 1000) {
      spoken = text
      speakingAt = text ? now - age : 0
    },
    segmentStart() { vadHandlers.onStart() },
    segmentEnd,
    async result(text, { final = true } = {}) {
      if (engine === 'browser') {
        const result = [{ transcript: text }]
        result.isFinal = final
        recognizer.onresult({ resultIndex: 0, results: [result] })
      } else {
        vadHandlers.onStart()
        await segmentEnd(text)
      }
      assert.deepEqual(events.errors, [])
    },
    async hear(text) {
      await input.result(text)
      advance(3000)
    },
  }
  return input
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
      assert.equal(voice.events.starts, 0, 'an echo must not cancel the current answer')
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

const answer = 'The current population estimate is ten thousand residents.'

test('browser does not cancel playback for a tentative unrelated hypothesis later corrected to echo', async (t) => {
  const voice = await harness(t, { engine: 'browser', spoken: answer })
  await voice.result('yes please', { final: false })
  assert.equal(voice.events.starts, 0, 'tentative background words must not cut off playback')
  await voice.hear(answer)
  assert.equal(voice.events.starts, 0)
  assert.deepEqual(voice.events.utterances, [])
})

test('browser does not combine rejected single words across a quiet gap into an interruption', async (t) => {
  const voice = await harness(t, { engine: 'browser', spoken: answer })
  await voice.result('hello ')
  voice.advance(10000)
  await voice.hear('indeed ')
  assert.equal(voice.events.starts, 0)
  assert.deepEqual(voice.events.utterances, [])
})

for (const heard of ['please wait for delivery', 'we have enough time']) {
  test(`browser does not interpret an embedded override as a playback interruption: ${heard}`, async (t) => {
    const voice = await harness(t, { engine: 'browser', spoken: answer })
    await voice.result(heard, { final: false })
    assert.equal(voice.events.starts, 0)
    await voice.hear(heard)
    assert.deepEqual(voice.events.utterances, [])
  })
}

for (const heard of ['stop', 'stop now', 'Hey Jarvis']) {
  test(`browser immediately accepts deliberate "${heard}" during the first syllable`, async (t) => {
    const voice = await harness(t, { engine: 'browser', spoken: answer, age: 100 })
    await voice.result(heard, { final: false })
    assert.equal(voice.events.starts, 1, 'explicit controls must act before final recognition or endpointing')
  })
}

for (const engine of ['browser', 'elevenlabs']) {
  test(`${engine} ignores unrelated final speech during playback`, async (t) => {
    const voice = await harness(t, { engine, spoken: answer })
    await voice.hear('pass the coffee please')
    assert.equal(voice.events.starts, 0)
    assert.deepEqual(voice.events.utterances, [])
  })

  test(`${engine} accepts an ordinary interruption while thinking without playback`, async (t) => {
    const voice = await harness(t, { engine })
    await voice.hear('open the report')
    assert.equal(voice.events.starts, 1)
    assert.deepEqual(voice.events.utterances, ['open the report'])
  })

  test(`${engine} accepts ordinary command-mode follow-up speech`, async (t) => {
    const voice = await harness(t, { engine, mode: 'command' })
    await voice.hear('open the report')
    assert.deepEqual(voice.events.utterances, ['open the report'])
  })

  test(`${engine} accepts a wake-addressed request over playback`, async (t) => {
    const voice = await harness(t, { engine, spoken: answer })
    await voice.hear('Hey Jarvis, open the report')
    assert.equal(voice.events.starts, 1)
    assert.deepEqual(voice.events.utterances, ['Hey Jarvis, open the report'])
  })
}

for (const text of ['', 'no record of it sir']) {
  test(`elevenlabs energy followed by ${text ? 'echo' : 'empty transcription'} never cancels playback`, async (t) => {
    const voice = await harness(t, { engine: 'elevenlabs', spoken: 'There is no record of it, sir.' })
    voice.segmentStart()
    assert.equal(voice.events.starts, 0, 'energy alone cannot identify the speaker')
    await voice.segmentEnd(text)
    voice.advance(3000)
    assert.equal(voice.events.starts, 0)
    assert.deepEqual(voice.events.utterances, [])
  })
}

for (const text of ['stop', 'Hey Jarvis']) {
  test(`elevenlabs accepts deliberate "${text}" after transcription during the first syllable`, async (t) => {
    const voice = await harness(t, { engine: 'elevenlabs', spoken: answer, age: 100 })
    voice.segmentStart()
    assert.equal(voice.events.starts, 0)
    await voice.segmentEnd(text)
    assert.equal(voice.events.starts, 1, 'a validated control must not be blocked by the onset self-guard')
    voice.advance(3000)
    assert.deepEqual(voice.events.utterances, [text])
  })
}

test('elevenlabs compares a delayed transcript with the playback captured with its audio', async (t) => {
  const spoken = 'Jarvis can open the quarterly report.'
  const voice = await harness(t, { engine: 'elevenlabs', spoken, deferTranscription: true })
  voice.segmentStart()
  await voice.segmentEnd(spoken)
  voice.setPlayback('The population estimate is ten thousand residents.')
  await voice.completeTranscription()
  voice.advance(3000)
  assert.equal(voice.events.starts, 0)
  assert.deepEqual(voice.events.utterances, [], 'old playback must not become a new addressed command')
  assert.deepEqual(voice.events.wakes, [])
})

test('elevenlabs discards an in-flight transcript after the voice session stops', async (t) => {
  const voice = await harness(t, { engine: 'elevenlabs', mode: 'command', deferTranscription: true })
  voice.segmentStart()
  await voice.segmentEnd('open the report')
  voice.stop()
  const stoppedEvents = structuredClone(voice.events)
  await voice.completeTranscription()
  voice.advance(3000)
  assert.deepEqual(voice.events, stoppedEvents, 'a stopped session must not emit partials or commands')
})

test('Google recognition selects bridge VAD and delivers its corrected transcript without browser recognition', async (t) => {
  const voice = await harness(t, {
    engine: 'google', mode: 'command',
    capabilityOverrides: { stt: true, sttProvider: 'google' },
  })
  voice.queueResponse({ json: { text: 'Open the quarterly report.' } })
  await voice.hear('raw capture is not a transcript')
  assert.equal(voice.diag.engine, 'google')
  assert.equal(voice.activity.mic, 1)
  assert.equal(voice.activity.vad, 1)
  assert.equal(voice.activity.browser, 0)
  assert.equal(voice.activity.requests, 1)
  assert.deepEqual(voice.events.utterances, ['Open the quarterly report.'])
})

test('explicit unavailable Google reports setup detail before opening any capture or browser fallback', async (t) => {
  const detail = 'Google speech credentials are unavailable. Configure Application Default Credentials for the selected project.'
  const voice = await harness(t, {
    engine: 'google', expectedLive: false,
    capabilityOverrides: { stt: false, sttProvider: 'google', sttDetail: detail },
  })
  assert.deepEqual(voice.events.errors, [detail])
  assert.equal(voice.diag.engine, 'google')
  assert.equal(voice.diag.running, false)
  assert.equal(voice.activity.mic, 0)
  assert.equal(voice.activity.browser, 0)
  assert.equal(voice.activity.vad, 0)
  assert.equal(voice.activity.requests, 0)
  assert.equal(voice.live(), false)
})

for (const { status, text, reason } of [
  {
    status: 503,
    text: 'Google speech credentials are unavailable. Configure Application Default Credentials for the selected project.',
    reason: /unavailable|credentials|configured|503/i,
  },
  {
    status: 429,
    text: 'Google speech quota is exhausted or requests are arriving too quickly. Check project quotas before trying again.',
    reason: /quota|rate|too (many|quickly)|429/i,
  },
]) {
  test(`Google HTTP ${status} reports actionable safe failure and the next segment recovers without fallback`, async (t) => {
    const voice = await harness(t, {
      engine: 'google', mode: 'command',
      capabilityOverrides: { stt: true, sttProvider: 'google' },
    })
    voice.queueResponse({ status, text, json: { debug: 'private-internal-token-must-not-surface' } })
    voice.segmentStart()
    await voice.segmentEnd('discarded audio')
    assert.equal(voice.events.errors.length, 1)
    assert.match(voice.events.errors[0], /google/i)
    assert.match(voice.events.errors[0], reason)
    assert.match(voice.events.errors[0], /configure|check|retry|try again|trying again/i)
    assert.doesNotMatch(voice.events.errors[0], /private-internal-token/i)
    assert.deepEqual(voice.events.utterances, [])
    assert.equal(voice.live(), true)
    voice.queueResponse({ json: { text: 'Open the quarterly report.' } })
    voice.segmentStart()
    await voice.segmentEnd('next audio recording')
    voice.advance(3000)
    assert.deepEqual(voice.events.utterances, ['Open the quarterly report.'])
    assert.equal(voice.events.errors.length, 1)
    assert.equal(voice.diag.lastError, '')
    assert.equal(voice.diag.engine, 'google')
    assert.equal(voice.activity.browser, 0)
    assert.equal(voice.activity.vad, 1)
    assert.equal(voice.activity.requests, 2)
  })
}

test('Google drops a decoded transcript when stop happens while the JSON body is pending', async (t) => {
  const voice = await harness(t, {
    engine: 'google', mode: 'command',
    capabilityOverrides: { stt: true, sttProvider: 'google' },
  })
  voice.queueResponse({ deferJson: true })
  voice.segmentStart()
  await voice.segmentEnd('pending audio')
  assert.equal(voice.activity.jsonReads, 1)
  voice.stop()
  const stoppedEvents = structuredClone(voice.events)
  await voice.completeJson({ text: 'Open the quarterly report.' })
  voice.advance(3000)
  assert.deepEqual(voice.events, stoppedEvents)
  assert.equal(voice.live(), false)
})

test('Google suppresses an asynchronous decode failure after the voice session stops', async (t) => {
  const voice = await harness(t, {
    engine: 'google', mode: 'command',
    capabilityOverrides: { stt: true, sttProvider: 'google' },
  })
  voice.queueResponse({ deferJson: true })
  voice.segmentStart()
  await voice.segmentEnd('pending audio')
  voice.stop()
  const stoppedEvents = structuredClone(voice.events)
  await voice.completeJson(undefined, new Error('late decoder failure'))
  voice.advance(3000)
  assert.deepEqual(voice.events, stoppedEvents)
  assert.equal(voice.live(), false)
})

for (const [text, expected] of [
  ['pass the coffee please', []],
  ['Jarvis, open the report', ['Jarvis, open the report']],
]) {
  test(`queued Google segment keeps captured playback policy after the answer ends: ${text}`, async (t) => {
    const voice = await harness(t, {
      engine: 'google', spoken: answer, deferTranscription: true,
      capabilityOverrides: { stt: true, sttProvider: 'google' },
    })
    await voice.result('')
    await voice.result(text)
    voice.setPlayback('')
    voice.setMode('command')
    await voice.completeTranscription()
    await voice.completeTranscription()
    voice.advance(3000)
    assert.deepEqual(voice.events.utterances, expected)
  })
}

test('Google cannot reopen listening when a pending transcription outlives standby', async (t) => {
  const voice = await harness(t, {
    engine: 'google', mode: 'command', deferTranscription: true,
    capabilityOverrides: { stt: true, sttProvider: 'google' },
  })
  await voice.result('Jarvis, open the report')
  voice.setMode('wake')
  await voice.completeTranscription()
  voice.advance(3000)
  assert.deepEqual(voice.events.utterances, [])
  assert.deepEqual(voice.events.wakes, [])
})

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
