import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import test from 'node:test'
import vm from 'node:vm'

const source = readFileSync(new URL('./server.mjs', import.meta.url), 'utf8')
const connectionSource = source.slice(source.indexOf("wss.on('connection',"))
const requestSource = source.slice(
  source.indexOf('function speechUpstream('),
  source.indexOf('\nconst server = http.createServer'),
) + '\nhandleRequest'
const proxySource = source.slice(
  source.indexOf('async function proxyRemote('),
  source.indexOf('\n// ---------------------------------------------------------------------------', source.indexOf('async function proxyRemote(')),
) + '\nproxyRemote'
const tick = () => new Promise(setImmediate)

// Exercise the real connection handler without starting a server, loading user
// credentials, running MCP tools, or making model requests.
function connection({ interrupt = () => Promise.resolve(), closeEndsStream = true } = {}) {
  const frames = []
  const inputs = []
  const runs = []
  const events = []
  const timers = new Map()
  let connect
  let receive
  let capture
  let ended = false
  let interruptCount = 0
  let sessionCloseCount = 0
  const event = (value) => {
    if (receive) {
      const resolve = receive
      receive = null
      resolve(value)
    } else events.push(value)
  }
  const session = {
    async *[Symbol.asyncIterator]() {
      while (!ended) {
        const value = events.length ? events.shift() : await new Promise((r) => { receive = r })
        if (value === null) return
        if (value instanceof Error) throw value
        yield value
      }
    },
    interrupt() {
      interruptCount++
      return interrupt()
    },
    close() {
      sessionCloseCount++
      if (!closeEndsStream) return
      if (ended) return
      ended = true
      event(null)
    },
  }
  const kit = (name) => ({ name, server: {} })
  const context = {
    wss: { on: (_, callback) => { connect = callback } },
    query: ({ prompt }) => {
      void (async () => {
        for await (const value of prompt) inputs.push(value.message.content)
      })()
      return session
    },
    console: { log() {}, error() {}, warn() {} },
    process: { env: {} },
    homedir: () => 'C:/synthetic',
    MCP_SERVERS: {}, ALLOW_WRITES: false, BROWSER_WRITES: false, MODEL: 'test', EFFORT: 'low',
    SYSTEM_PROMPT: '', WRITE_REFUSAL: '',
    displayKit: () => kit('display'), uiKit: () => kit('ui'),
    chromeKit: () => kit('chrome'), visionKit: (askBrowser) => { capture = askBrowser; return kit('vision') },
    registry: () => ({}), decideTool: () => true,
    AUTH_FAILURE: /failed to authenticate/, RESULT_FAILURES: { default: 'error' },
    forgetImages() {}, trim: (history) => history.slice(), AbortController,
    runTurn: (options) => new Promise((resolve, reject) => {
      runs.push({ options, resolve, reject })
    }),
    setTimeout: (callback, ms) => {
      const id = Symbol('timer')
      timers.set(id, { callback, ms })
      return id
    },
    clearTimeout: (id) => timers.delete(id),
  }
  vm.runInNewContext(connectionSource, context)
  const socket = new EventEmitter()
  socket.OPEN = 1
  socket.readyState = 1
  socket.send = (raw) => frames.push(JSON.parse(raw))
  socket.close = () => {
    if (socket.readyState === 3) return
    socket.readyState = 3
    socket.emit('close')
  }
  connect(socket)
  return {
    socket, frames, inputs, runs, event, capture,
    get interruptCount() { return interruptCount },
    get sessionCloseCount() { return sessionCloseCount },
    send: (value) => socket.emit('message', Buffer.from(JSON.stringify(value))),
    async expire(ms = 400) {
      await tick()
      for (const [id, timer] of [...timers]) {
        if (timer.ms <= ms) {
          timers.delete(id)
          timer.callback()
        }
      }
      await tick()
    },
  }
}

const ask = (id, provider = 'claude') => ({ type: 'ask', text: id, id, provider })
const result = (text) => ({ type: 'result', subtype: 'success', result: text })

test('non-object websocket messages cannot crash the bridge', async () => {
  const h = connection()
  for (const value of [null, [], 1, true, 'ask']) assert.doesNotThrow(() => h.send(value))
  h.send(ask('valid'))
  await tick()
  assert.deepEqual(h.inputs, ['valid'])
  h.socket.close()
})

test('websocket transport errors close only the affected session', () => {
  const h = connection()
  assert.doesNotThrow(() => h.socket.emit('error', new Error('synthetic protocol error')))
  assert.equal(h.socket.readyState, 3)
})

test('a queued question cannot start after its socket closes', async () => {
  const h = connection()
  h.send(ask('old'))
  await tick()
  h.send({ type: 'interrupt' })
  h.send(ask('queued', 'gpt'))
  h.socket.close()
  await h.expire()
  assert.equal(h.runs.length, 0)
})

test('an unsettled Claude turn retires only Claude and never relabels old output', async () => {
  const h = connection()
  h.send(ask('old'))
  await tick()
  h.send({ type: 'interrupt' })
  h.send(ask('new'))
  await h.expire()
  h.event(result('old answer'))
  await tick()
  assert.deepEqual(h.inputs, ['old'])
  assert.equal(h.socket.readyState, h.socket.OPEN)
  assert.equal(h.sessionCloseCount, 1)
  assert.ok(h.frames.some((frame) => frame.type === 'error' && frame.ask === 'new'))
  assert.ok(!h.frames.some((frame) => frame.type === 'done' && frame.ask === 'new'))
  h.socket.close()
})

test('interrupt acknowledgement cannot bypass the settlement deadline', async () => {
  const h = connection({ interrupt: () => new Promise(() => {}) })
  h.send(ask('old'))
  await tick()
  h.send(ask('new'))
  await h.expire()
  assert.equal(h.socket.readyState, h.socket.OPEN)
  assert.equal(h.sessionCloseCount, 1)
  assert.ok(h.frames.some((frame) => frame.type === 'error' && frame.ask === 'new'))
  h.socket.close()
})

test('retiring stuck Claude preserves GPT history and rejects late Claude output', async (t) => {
  // A close request need not synchronously drain the SDK's buffered events.
  const h = connection({ closeEndsStream: false })
  t.after(() => { h.event(null); h.socket.close() })
  h.send(ask('gpt-seed', 'gpt'))
  await tick()
  h.runs[0].options.history.push({ role: 'assistant', content: 'Remembered GPT answer' })
  h.runs[0].resolve({ text: 'Remembered GPT answer', aborted: false })
  await tick()

  h.send(ask('claude-stuck'))
  await tick()
  h.send(ask('gpt-replacement', 'gpt'))
  await h.expire()
  assert.equal(h.socket.readyState, h.socket.OPEN)
  assert.equal(h.sessionCloseCount, 1)
  assert.equal(h.runs.length, 2)
  assert.equal(h.runs[1].options.signal.aborted, false)
  assert.deepEqual(Array.from(h.runs[1].options.history, (message) => message.content), [
    'gpt-seed', 'Remembered GPT answer', 'gpt-replacement',
  ])
  assert.ok(h.frames.some((frame) => frame.type === 'error' && frame.ask === 'claude-stuck'))
  assert.ok(!h.frames.some((frame) => frame.type === 'error' && (!frame.ask || frame.ask === 'gpt-replacement')))

  const beforeLateOutput = h.frames.length
  h.event({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Late Claude text' } } })
  h.event(result('Late Claude answer'))
  h.event({ type: 'system', subtype: 'init', mcp_servers: [{ name: 'retired', status: 'connected' }] })
  await tick()
  assert.equal(h.frames.length, beforeLateOutput)
  assert.equal(h.runs[1].options.signal.aborted, false)
  h.runs[1].options.history.push({ role: 'assistant', content: 'Replacement GPT answer' })
  h.runs[1].resolve({ text: 'Replacement GPT answer', aborted: false })
  await tick()
  assert.ok(h.frames.some((frame) => frame.type === 'done' && frame.ask === 'gpt-replacement' && frame.text === 'Replacement GPT answer'))
  assert.ok(!h.frames.some((frame) => frame.type === 'done' && frame.text === 'Late Claude answer'))

  h.send(ask('claude-after-retirement'))
  await tick()
  assert.equal(h.frames.filter((frame) => frame.type === 'error' && frame.ask === 'claude-after-retirement').length, 1)
  assert.deepEqual(h.inputs, ['claude-stuck'])
  h.send(ask('gpt-next', 'gpt'))
  await tick()
  assert.equal(h.runs.length, 3)
  assert.deepEqual(Array.from(h.runs[2].options.history, (message) => message.content), [
    'gpt-seed', 'Remembered GPT answer', 'gpt-replacement', 'Replacement GPT answer', 'gpt-next',
  ])
  h.runs[2].resolve({ text: 'Continued', aborted: false })
  await tick()
})

test('completed Claude interruption releases GPT and later asks interrupt the live GPT turn', async () => {
  const h = connection()
  h.send(ask('old'))
  await tick()
  h.send({ type: 'interrupt' })
  h.send(ask('gpt', 'gpt'))
  h.event(result('old answer'))
  await tick()
  assert.equal(h.runs.length, 1)
  h.send(ask('next', 'gpt'))
  await tick()
  assert.equal(h.runs[0].options.signal.aborted, true)
  assert.equal(h.runs.length, 1)
  h.runs[0].resolve({ text: '', aborted: true })
  await tick()
  assert.equal(h.runs.length, 2)
  h.runs[1].resolve({ text: 'next answer', aborted: false })
  await tick()
  assert.ok(h.frames.some((frame) => frame.type === 'done' && frame.ask === 'next'))
  h.socket.close()
})

test('only the newest queued question is delivered after interruption', async () => {
  const h = connection()
  h.send(ask('old'))
  await tick()
  h.send(ask('superseded'))
  h.send(ask('newest'))
  h.event(result('old answer'))
  await tick()
  assert.deepEqual(h.inputs, ['old', 'newest'])
  assert.equal(h.interruptCount, 1)
  h.socket.close()
})

test('slow GPT cancellation cannot overlap another GPT history mutation', async () => {
  const h = connection()
  h.send(ask('old', 'gpt'))
  await tick()
  h.send(ask('new', 'gpt'))
  await h.expire()
  assert.equal(h.runs.length, 1)
  assert.equal(h.runs[0].options.signal.aborted, true)
  assert.equal(h.socket.readyState, 3)
})

test('camera request timeout cancels the matching browser capture', async () => {
  const h = connection()
  const pending = h.capture('capture', {}, 20_000)
  const rejected = assert.rejects(pending, /did not answer in time/)
  await h.expire(20_000)
  await rejected
  const capture = h.frames.find((frame) => frame.type === 'capture')
  assert.ok(h.frames.some((frame) => frame.type === 'cancel' && frame.id === capture.id))
  h.socket.close()
})

test('socket close settles pending camera requests', async () => {
  const h = connection()
  const pending = h.capture('capture', {}, 20_000)
  h.socket.close()
  assert.match((await pending).error, /disconnected/)
})

test('successful explanations of authentication errors remain successful answers', async () => {
  const h = connection()
  h.send(ask('explain'))
  await tick()
  h.event({ ...result('The message "failed to authenticate" means the login was rejected.'), is_error: false })
  await tick()
  assert.ok(h.frames.some((frame) => frame.type === 'done' && frame.ask === 'explain'))
  assert.ok(!h.frames.some((frame) => frame.type === 'error'))
  h.socket.close()
})

test('SDK error metadata is respected even with a success result subtype', async () => {
  const h = connection()
  h.send(ask('question'))
  await tick()
  h.event({ ...result('Insufficient credits for this request.'), is_error: true })
  await tick()
  assert.ok(h.frames.some((frame) => frame.type === 'error' && frame.ask === 'question'))
  assert.ok(!h.frames.some((frame) => frame.type === 'done'))
  h.socket.close()
})

for (const ending of ['EOF', 'stream error']) {
  const failClaude = (h) => h.event(ending === 'EOF' ? null : new Error('Synthetic Claude stream failure'))

  test(`Claude ${ending} settles its active request with one correctly tagged error`, async (t) => {
    const h = connection()
    t.after(() => h.socket.close())
    h.send(ask('claude-live'))
    await tick()
    failClaude(h)
    await tick()

    const errors = h.frames.filter((frame) => frame.type === 'error')
    assert.equal(errors.length, 1)
    assert.equal(errors[0].ask, 'claude-live')
    assert.ok(!h.frames.some((frame) => frame.type === 'done' && frame.ask === 'claude-live'))
    assert.equal(h.socket.readyState, h.socket.OPEN)

    // The dead provider fails subsequent requests immediately, while the other
    // provider can still start instead of waiting behind the abandoned turn.
    h.send(ask('claude-after-failure'))
    await tick()
    assert.equal(h.frames.filter((frame) => frame.type === 'error' && frame.ask === 'claude-after-failure').length, 1)
    assert.deepEqual(h.inputs, ['claude-live'])
    h.send(ask('gpt-after-failure', 'gpt'))
    await tick()
    assert.equal(h.runs.length, 1)
    h.runs[0].resolve({ text: 'GPT is available', aborted: false })
    await tick()
    assert.equal(h.frames.filter((frame) => frame.type === 'error' && frame.ask === 'claude-live').length, 1)
    assert.ok(h.frames.some((frame) => frame.type === 'done' && frame.ask === 'gpt-after-failure'))
  })

  test(`Claude ${ending} does not fail the current GPT listener or discard its history`, async (t) => {
    const h = connection()
    t.after(() => h.socket.close())
    h.send(ask('gpt-first', 'gpt'))
    await tick()
    h.runs[0].options.history.push({ role: 'assistant', content: 'First GPT answer' })
    h.runs[0].resolve({ text: 'First GPT answer', aborted: false })
    await tick()

    h.send(ask('gpt-live', 'gpt'))
    await tick()
    failClaude(h)
    await tick()
    assert.equal(h.socket.readyState, h.socket.OPEN)
    assert.equal(h.runs[1].options.signal.aborted, false)
    // The actual client accepts untagged errors as errors for its current ask.
    // A provider-status notification must not use this turn-error channel.
    assert.ok(!h.frames.some((frame) => frame.type === 'error' && (!frame.ask || frame.ask === 'gpt-live')))

    h.runs[1].options.onDelta('Second GPT answer')
    h.runs[1].options.history.push({ role: 'assistant', content: 'Second GPT answer' })
    h.runs[1].resolve({ text: 'Second GPT answer', aborted: false })
    await tick()
    assert.ok(h.frames.some((frame) => frame.type === 'text' && frame.ask === 'gpt-live'))
    assert.ok(h.frames.some((frame) => frame.type === 'done' && frame.ask === 'gpt-live'))

    h.send(ask('gpt-next', 'gpt'))
    await tick()
    assert.equal(h.runs.length, 3)
    assert.deepEqual(Array.from(h.runs[2].options.history, (message) => message.content), [
      'gpt-first', 'First GPT answer', 'gpt-live', 'Second GPT answer', 'gpt-next',
    ])
    h.runs[2].resolve({ text: 'Continued', aborted: false })
    await tick()
  })
}

function requestHandler(fetch, extra = {}) {
  return vm.runInNewContext(requestSource, {
    URL, Buffer, FormData, Blob, AbortController, AbortSignal, setTimeout, clearTimeout,
    console: { log() {}, error() {}, warn() {} },
    originAllowed: () => true, corsFor: () => ({}),
    elevenKey: () => 'synthetic-test-key', VOICE_ID: 'synthetic', fetch,
    ...extra,
  })
}

function request(chunks, path = '/tts') {
  const req = Readable.from(chunks)
  req.method = 'POST'
  req.url = path
  req.headers = {}
  return req
}

function response() {
  const res = new EventEmitter()
  res.writeHead = (status) => { res.statusCode = status; res.headersSent = true }
  res.write = () => true
  res.end = () => { res.writableEnded = true; res.emit('finish') }
  res.destroy = () => { res.destroyed = true; res.emit('close') }
  return res
}

test('TTS preserves UTF-8 when a request splits a character between chunks', async () => {
  let forwarded
  const handler = requestHandler(async (_, options) => {
    forwarded = JSON.parse(options.body)
    return { ok: true, body: Readable.from([]) }
  })
  const text = 'مرحبا'
  const bytes = Buffer.from(JSON.stringify({ text }))
  const split = bytes.findIndex((byte) => byte >= 0xc0) + 1
  const res = response()
  await handler(request([bytes.subarray(0, split), bytes.subarray(split)]), res)
  assert.equal(res.statusCode, 200)
  assert.equal(forwarded.text, text)
})

for (const path of ['/tts', '/stt']) {
  test(`${path} aborts its upstream request when the client disconnects`, async () => {
    let signal
    const handler = requestHandler((_, options) => {
      signal = options.signal
      return new Promise((_, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    })
    const chunks = path === '/tts' ? [Buffer.from('{"text":"hello"}')] : [Buffer.alloc(1400)]
    const res = response()
    const pending = handler(request(chunks, path), res)
    await tick()
    // Assert before awaiting the handler so the broken implementation fails
    // immediately instead of leaving the regression test hanging.
    assert.ok(signal, 'the provider fetch needs a cancellation signal')
    res.destroy()
    await pending
    assert.equal(signal.aborted, true)
  })

  test(`${path} times out a stalled provider and releases its timer`, async () => {
    let expire
    let cleared = false
    const handler = requestHandler((_, options) => new Promise((_, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    }), {
      setTimeout: (callback) => { expire = callback; return 1 },
      clearTimeout: () => { cleared = true },
    })
    const chunks = path === '/tts' ? [Buffer.from('{"text":"hello"}')] : [Buffer.alloc(1400)]
    const res = response()
    const pending = handler(request(chunks, path), res)
    await tick()
    expire()
    await pending
    assert.equal(res.statusCode, 504)
    assert.equal(res.writableEnded, true)
    assert.equal(cleared, true)
    assert.equal(res.listenerCount('close'), 0)
  })
}

test('TTS rejects non-string text before calling the provider', async () => {
  let calls = 0
  const handler = requestHandler(() => { calls++; throw new Error('unexpected provider call') })
  for (const text of [{ value: 'hello' }, 7, true, '  ']) {
    const res = response()
    await handler(request([Buffer.from(JSON.stringify({ text }))]), res)
    assert.equal(res.statusCode, 400)
  }
  assert.equal(calls, 0)
})

for (const [name, statusCode, type, length, status] of [
  ['HTTP rejection', 404, 'image/png', undefined, 404],
  ['unsupported MIME type', 200, 'text/html', undefined, 415],
  ['scriptable SVG', 200, 'image/svg+xml', undefined, 415],
  ['declared oversized body', 200, 'image/png', '11', 413],
]) {
  test(`media proxy destroys ${name} without draining its body`, async () => {
    const upstream = Readable.from([Buffer.alloc(100)])
    upstream.statusCode = statusCode
    upstream.headers = { 'content-type': type, 'content-length': length }
    const proxy = vm.runInNewContext(proxySource, {
      URL, console, PROXY_UA: 'test',
      vetTarget: (url) => new URL(url),
      openRemote: async () => ({ res: upstream }),
      proxyError: (code, message) => Object.assign(new Error(message), { status: code }),
      NEVER_PROXIED: new Set(['image/svg+xml']),
    })
    const req = new EventEmitter()
    req.url = '/img?url=https://example.test/image'
    req.headers = {}
    const res = response()
    await assert.rejects(proxy(req, res, {}, {
      kinds: ['image/'], maxBytes: 10, timeoutMs: 100, ranged: false,
    }), (error) => error.status === status)
    assert.equal(upstream.destroyed, true)
    assert.equal(upstream.readableFlowing, null)
    assert.ok(!res.headersSent)
  })
}
