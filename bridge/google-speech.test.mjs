import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createGoogleSpeech } from './google-speech.mjs'

const env = { JARVIS_GOOGLE_PROJECT: 'speech-test-project' }
const audio = Buffer.from('synthetic audio fixture')
const token = 'synthetic-credential-not-valid'
const success = (transcript = 'Hello Jarvis.') => ({
  ok: true, status: 200,
  json: async () => ({ results: [{ alternatives: [{ transcript }] }] }),
})
function fixture({ transcript, response, auth, ...options } = {}) {
  const requests = []
  let tokenCalls = 0
  const speech = createGoogleSpeech({
    env,
    auth: auth ?? { getAccessToken: async () => { tokenCalls++; return token } },
    fetchImpl: async (url, request) => { requests.push({ url, request }); return response ?? success(transcript) },
    ...options,
  })
  return { speech, requests, tokenCalls: () => tokenCalls }
}

function authClock(t) {
  const timers = new Map()
  let nextId = 0
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    const id = ++nextId
    timers.set(id, { callback, delay })
    return id
  })
  t.mock.method(globalThis, 'clearTimeout', (id) => { timers.delete(id) })
  return timers
}

test('construction and status make no credential or speech requests; probe only checks credentials', async () => {
  const { speech, requests, tokenCalls } = fixture()
  assert.equal(speech.configured, true)
  assert.equal(speech.status().ready, false)
  assert.equal(tokenCalls(), 0)
  assert.equal(requests.length, 0)
  assert.deepEqual(await speech.probe(), {
    ready: true,
    detail: 'Google credentials available; Speech-to-Text API access has not yet been verified.',
    project: env.JARVIS_GOOGLE_PROJECT, model: 'chirp_3', language: 'en-US', provider: 'google',
  })
  assert.equal(tokenCalls(), 1)
  assert.equal(requests.length, 0)
})

test('posts authenticated V2 Chirp 3 audio and inline phrase hints to the selected regional endpoint', async () => {
  const { speech, requests } = fixture({ env: { ...env, JARVIS_GOOGLE_LOCATION: 'eu', JARVIS_GOOGLE_LANGUAGE: 'en-GB' } })
  const controller = new AbortController()
  assert.deepEqual(await speech.recognize(audio, { signal: controller.signal }), {
    text: 'Hello Jarvis.', rawText: 'Hello Jarvis.', corrected: false, provider: 'google',
  })
  assert.equal(requests.length, 1)
  const { url, request } = requests[0]
  assert.equal(url, 'https://eu-speech.googleapis.com/v2/projects/speech-test-project/locations/eu/recognizers/_:recognize')
  assert.equal(request.method, 'POST')
  assert.equal(request.redirect, 'error')
  assert.equal(request.signal, controller.signal)
  assert.deepEqual(request.headers, {
    Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'x-goog-user-project': 'speech-test-project',
  })
  assert.deepEqual(JSON.parse(request.body), {
    config: {
      autoDecodingConfig: {}, languageCodes: ['en-GB'], model: 'chirp_3',
      adaptation: { phraseSets: [{ inlinePhraseSet: { phrases: [
        'Jarvis', 'ChatGPT', 'Claude', 'GitHub', 'Infinityinsight', 'Google Drive',
      ].map((value) => ({ value })) } }] },
    },
    content: audio.toString('base64'),
  })
  assert.match(speech.status().detail, /API verified/)
  assert.match((await speech.probe()).detail, /API verified/)
})

test('does not assume a project and rejects invalid configuration before authentication or upload', async () => {
  for (const config of [{}, { ...env, JARVIS_GOOGLE_PROJECT: 'wrong/project' }, { ...env, JARVIS_GOOGLE_LOCATION: 'localhost' }, { ...env, JARVIS_GOOGLE_LANGUAGE: 'English please' }]) {
    const { speech, requests, tokenCalls } = fixture({ env: config })
    assert.equal(speech.configured, false)
    assert.equal((await speech.probe()).ready, false)
    await assert.rejects(speech.recognize(audio), { status: 503 })
    assert.equal(tokenCalls(), 0)
    assert.equal(requests.length, 0)
  }
  assert.equal(fixture({ env: { GOOGLE_CLOUD_PROJECT: 'fallback-project' } }).speech.status().project, 'fallback-project')
  assert.equal(fixture({ env: { ...env, GOOGLE_CLOUD_PROJECT: 'fallback-project' } }).speech.status().project, env.JARVIS_GOOGLE_PROJECT)
})

test('credential failures are sanitized and never upload audio', async () => {
  for (const getAccessToken of [async () => null, async () => '', async () => { throw new Error(`private-path ${token}`) }]) {
    const { speech, requests } = fixture({ auth: { getAccessToken } })
    const status = await speech.probe()
    assert.equal(status.ready, false)
    assert.match(status.detail, /Application Default Credentials/)
    await assert.rejects(speech.recognize(audio), (error) => {
      assert.equal(error.status, 503)
      assert.doesNotMatch(error.message, /private-path|synthetic-credential/)
      return true
    })
    assert.equal(requests.length, 0)
  }
})

for (const status of [403, 429]) {
  test(`HTTP ${status} supplies a useful setup message without exposing the upstream body or retrying`, async () => {
    let bodyReads = 0
    let bodyCancelled = false
    const { speech, requests } = fixture({ response: {
      ok: false, status,
      body: { cancel: async () => { bodyCancelled = true } },
      json: async () => { bodyReads++; return { error: { message: token } } },
    } })
    await assert.rejects(speech.recognize(audio), (error) => {
      assert.equal(error.status, status)
      assert.match(error.message, new RegExp(`HTTP ${status}`))
      assert.match(error.message, status === 403 ? /API and billing/ : /quota/)
      assert.doesNotMatch(error.message, /synthetic-credential/)
      return true
    })
    assert.equal(bodyReads, 0)
    assert.equal(bodyCancelled, true)
    assert.equal(requests.length, 1)
    assert.equal(speech.status().ready, true)
  })
}

test('transport errors hide details and do not retry or fall back to another provider', async () => {
  let requests = 0
  const { speech } = fixture({ fetchImpl: async () => { requests++; throw new Error(`internal-url ${token}`) } })
  await assert.rejects(speech.recognize(audio), (error) => {
    assert.equal(error.status, 502)
    assert.doesNotMatch(error.message, /internal-url|synthetic-credential/)
    return true
  })
  assert.equal(requests, 1)
})

for (const failure of ['network', 429, 503]) {
  test(`a ${failure} failure keeps credentials ready and allows the next explicit recognition request`, async () => {
    let requests = 0
    const { speech } = fixture({ fetchImpl: async () => {
      if (++requests > 1) return success()
      if (failure === 'network') throw new Error('Synthetic connection failure')
      return { ok: false, status: failure }
    } })
    await speech.probe()
    await assert.rejects(speech.recognize(audio))
    assert.equal(requests, 1, 'must not automatically retry audio')
    assert.equal(speech.status().ready, true)
    assert.doesNotMatch(speech.status().detail, /API verified/)
    assert.equal((await speech.recognize(audio)).text, 'Hello Jarvis.')
    assert.equal(requests, 2)
    assert.equal(speech.status().ready, true)
    assert.match(speech.status().detail, /API verified/)
  })
}

test('rejects empty, non-buffer and oversized audio before authentication or upload', async () => {
  const { speech, requests, tokenCalls } = fixture()
  for (const value of [Buffer.alloc(0), 'audio', null]) await assert.rejects(speech.recognize(value), { status: 400 })
  await assert.rejects(speech.recognize(Buffer.alloc(10 * 1024 * 1024 + 1)), { status: 413 })
  assert.equal(tokenCalls(), 0)
  assert.equal(requests.length, 0)
})

test('cancellation before and during authentication prevents uploading audio', async () => {
  const before = new AbortController()
  before.abort()
  const first = fixture()
  await assert.rejects(first.speech.recognize(audio, { signal: before.signal }), { name: 'AbortError' })
  assert.equal(first.tokenCalls(), 0)
  assert.equal(first.requests.length, 0)
  const during = new AbortController()
  const second = fixture({ auth: { getAccessToken: async () => { during.abort(); return token } } })
  await assert.rejects(second.speech.recognize(audio, { signal: during.signal }), { name: 'AbortError' })
  assert.equal(second.requests.length, 0)
})

test('abort settles hanging authentication immediately and clears its timeout and listener', async (t) => {
  const timers = authClock(t)
  const controller = new AbortController()
  const add = t.mock.method(controller.signal, 'addEventListener')
  const remove = t.mock.method(controller.signal, 'removeEventListener')
  let finishAuthentication
  const { speech, requests } = fixture({ auth: { getAccessToken: () => new Promise((resolve) => { finishAuthentication = resolve }) } })
  const pending = speech.recognize(audio, { signal: controller.signal })
  const rejected = assert.rejects(pending, { name: 'AbortError' })
  await Promise.resolve()
  controller.abort()
  await rejected
  assert.equal(requests.length, 0)
  assert.equal(timers.size, 0)
  assert.equal(add.mock.callCount(), 1)
  assert.equal(remove.mock.callCount(), 1)
  assert.equal(remove.mock.calls[0].arguments[1], add.mock.calls[0].arguments[1])
  finishAuthentication(token)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(requests.length, 0, 'a token arriving after cancellation must not upload audio')
  assert.equal(speech.status().ready, false)
})

test('startup credential probing times out after ten seconds without submitting audio', async (t) => {
  const timers = authClock(t)
  const { speech, requests } = fixture({ auth: { getAccessToken: async () => new Promise(() => {}) } })
  const pending = speech.probe()
  assert.equal(timers.size, 1)
  const timer = [...timers.values()][0]
  assert.equal(timer.delay, 10_000)
  timer.callback()
  const status = await pending
  assert.equal(status.ready, false)
  assert.match(status.detail, /credential.*timed out/i)
  assert.equal(timers.size, 0)
  assert.equal(requests.length, 0)
})

test('a timed out credential refresh retains known credentials and permits the next manual request', async (t) => {
  const timers = authClock(t)
  let tokenCalls = 0
  const { speech, requests } = fixture({ auth: { getAccessToken: async () => ++tokenCalls === 2 ? new Promise(() => {}) : token } })
  await speech.probe()
  const pending = speech.recognize(audio)
  const rejected = assert.rejects(pending, { status: 503 })
  await Promise.resolve()
  assert.equal(timers.size, 1)
  ;[...timers.values()][0].callback()
  await rejected
  assert.equal(speech.status().ready, true)
  assert.match(speech.status().detail, /credential.*timed out/i)
  assert.equal(timers.size, 0)
  assert.equal(requests.length, 0)
  assert.equal((await speech.recognize(audio)).text, 'Hello Jarvis.')
  assert.equal(requests.length, 1)
  assert.equal(timers.size, 0)
})

test('settled credentials clear the timeout on success and rejection', async (t) => {
  const timers = authClock(t)
  for (const getAccessToken of [async () => token, async () => { throw new Error('Synthetic auth error') }]) {
    const controller = new AbortController()
    const remove = t.mock.method(controller.signal, 'removeEventListener')
    const { speech } = fixture({ auth: { getAccessToken } })
    await speech.recognize(audio, { signal: controller.signal }).catch(() => {})
    assert.equal(timers.size, 0)
    assert.equal(remove.mock.callCount(), 1)
  }
})

test('cancellation during fetch or response parsing never delivers a stale transcript', async () => {
  for (const phase of ['fetch', 'json']) {
    const controller = new AbortController()
    const { speech } = fixture({ fetchImpl: async (_url, request) => {
      assert.equal(request.signal, controller.signal)
      if (phase === 'fetch') { controller.abort(); throw new Error('Cancelled upstream') }
      return { ok: true, json: async () => { controller.abort(); return { results: [{ alternatives: [{ transcript: 'Stale text' }] }] } } }
    } })
    await assert.rejects(speech.recognize(audio, { signal: controller.signal }), { name: 'AbortError' })
  }
})

test('joins only the first transcript alternative from each result and accepts no recognized speech', async () => {
  const response = { ok: true, json: async () => ({ results: [
    { alternatives: [{ transcript: '  Open up ' }, { transcript: 'ignore this' }] },
    { alternatives: [{ transcript: 'ChatGPT.  ' }] },
  ] }) }
  assert.equal((await fixture({ response }).speech.recognize(audio)).text, 'Open up ChatGPT.')
  for (const payload of [{}, { results: [] }, { results: [{ alternatives: [{ transcript: ' ' }] }] }]) {
    assert.equal((await fixture({ response: { ok: true, json: async () => payload } }).speech.recognize(audio)).text, '')
  }
})

test('rejects malformed provider payloads with a safe error', async () => {
  for (const payload of [null, [], { results: null }, { results: {} }, { results: [null] }, { results: [{ alternatives: [] }] }, { results: [{ alternatives: [{ transcript: 123 }] }] }, { error: { message: token } }]) {
    await assert.rejects(fixture({ response: { ok: true, json: async () => payload } }).speech.recognize(audio), (error) => {
      assert.equal(error.status, 502)
      assert.doesNotMatch(error.message, /synthetic-credential/)
      return true
    })
  }
  await assert.rejects(fixture({ response: { ok: true, json: async () => { throw new Error(token) } } }).speech.recognize(audio), /invalid JSON response/)
})

test('a malformed response keeps credentials ready while clearing API verification, and a later success recovers it', async () => {
  let call = 0
  const { speech } = fixture({ fetchImpl: async () => ++call === 2
    ? { ok: true, json: async () => ({ results: null }) }
    : success() })
  await speech.recognize(audio)
  assert.equal(speech.status().ready, true)
  await assert.rejects(speech.recognize(audio), { status: 502 })
  assert.equal(speech.status().ready, true)
  assert.match(speech.status().detail, /invalid recognition results/)
  await speech.recognize(audio)
  assert.equal(speech.status().ready, true)
  assert.match(speech.status().detail, /API verified/)
})

for (const [rawText, expected] of [
  ['open up chat tee tee tee', 'open up ChatGPT'],
  ['Go to Chat GPT.', 'Go to ChatGPT.'],
  ['Launch chat gee pee tee!', 'Launch ChatGPT!'],
  ['Hey Jarvis, please open chat g p t', 'Hey Jarvis, please open ChatGPT'],
  ['Hey, Jarvis, open up chat tee tee tee.', 'Hey, Jarvis, open up ChatGPT.'],
  ['Could you please open chat GPT?', 'Could you please open ChatGPT?'],
]) {
  test(`corrects the affirmative navigation command: ${rawText}`, async () => {
    const { speech } = fixture({ transcript: rawText })
    assert.deepEqual(await speech.recognize(audio), { text: expected, rawText, corrected: true, provider: 'google' })
  })
}

for (const rawText of [
  'Open ChatGPT',
  'do not open chat tee tee tee',
  "don't launch chat GPT",
  'never go to chat GPT',
  'Open anything but chat GPT',
  'Open chat GPT in a new tab',
  'Open chat tee tee tee and send my password',
  'Write the words open chat tee tee tee',
  'Say open chat tee tee tee',
  'I heard "open chat GPT"',
  'Open "chat tee tee tee"',
  'chat tee tee tee is what it heard',
  'Please explain what Chat GPT means',
]) {
  test(`preserves the unrelated, negated, quoted, or qualified transcript: ${rawText}`, async () => {
    const { speech } = fixture({ transcript: rawText })
    assert.deepEqual(await speech.recognize(audio), { text: rawText, rawText, corrected: false, provider: 'google' })
  })
}
