import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { test } from 'node:test'
import { z } from 'zod'

const source = (await readFile(new URL('./chrome.mjs', import.meta.url), 'utf8'))
  .replace(/^import .*\r?\n/gm, '')
  .replace(/^export /gm, '')

const wire = (value) => {
  const body = Buffer.from(JSON.stringify(value))
  const header = Buffer.alloc(4)
  header.writeUInt32LE(body.length)
  return Buffer.concat([header, body])
}
const reply = { result: { content: [{ type: 'text', text: 'Synthetic browser reply' }] } }

function harness({ onConnect, onWrite } = {}) {
  const writes = []
  const timers = new Set()
  let connections = 0
  const context = vm.createContext({
    Buffer, z, console,
    process: { platform: 'win32' },
    userInfo: () => ({ username: 'synthetic-test' }),
    tool: (name, description, inputSchema, handler) => ({ name, description, inputSchema, handler }),
    defineTools: (options) => ({ specs: options.tools }),
    setTimeout: (fn, delay) => {
      const timer = { fn, delay }
      timers.add(timer)
      return timer
    },
    clearTimeout: (timer) => timers.delete(timer),
    createConnection: () => {
      const number = ++connections
      const socket = new EventEmitter()
      socket.destroyed = false
      socket.destroy = () => { socket.destroyed = true }
      socket.write = (frame, callback) => {
        const message = JSON.parse(frame.subarray(4).toString('utf8'))
        writes.push(message)
        queueMicrotask(() => {
          if (onWrite) onWrite({ socket, message, number, writes, timers, callback })
          else {
            callback()
            socket.emit('data', wire(reply))
          }
        })
        return true
      }
      queueMicrotask(() => {
        if (onConnect) onConnect({ socket, number })
        else socket.emit('connect')
      })
      return socket
    },
  })
  vm.runInContext(source + '\nglobalThis.api = { ChromeLink, chromeKit }', context)
  return { ...context.api, writes, timers, connections: () => connections }
}

test('new-tab and close-tab handlers pass their call context', async () => {
  const { ChromeLink, chromeKit } = harness()
  const calls = []
  ChromeLink.prototype.call = async (...args) => { calls.push(args); return reply }
  const kit = chromeKit({ allowWrites: true })
  const extra = { signal: new AbortController().signal }
  const create = kit.specs.find((spec) => spec.name === 'chrome_new_tab')
  const close = kit.specs.find((spec) => spec.name === 'chrome_close_tab')
  assert.equal((await create.handler({}, extra)).isError, undefined)
  assert.equal((await close.handler({ tabId: 7 }, extra)).isError, undefined)
  assert.equal(calls[0][0], 'tabs_create_mcp')
  assert.equal(calls[1][0], 'tabs_close_mcp')
  assert.equal(calls[0][2], extra.signal)
  assert.equal(calls[1][2], extra.signal)
})

for (const failure of ['timeout', 'close', 'error', 'write error', 'malformed reply']) {
  test(`does not replay a browser action after a post-send ${failure}`, async () => {
    const env = harness({
      onWrite: ({ socket, number, timers, callback }) => {
        // The old implementation retries; answer that retry so the regression
        // fails promptly, without a live browser or a real 45-second timeout.
        if (number > 1) return socket.emit('data', wire(reply))
        if (failure === 'timeout') return [...timers].find((timer) => timer.delay === 45_000).fn()
        if (failure === 'close') return socket.emit('close')
        if (failure === 'error') return socket.emit('error', new Error('Synthetic socket failure'))
        if (failure === 'write error') return callback(new Error('Synthetic write failure'))
        const bad = Buffer.from('{')
        const header = Buffer.alloc(4)
        header.writeUInt32LE(bad.length)
        socket.emit('data', Buffer.concat([header, bad]))
      },
    })
    await assert.rejects(new env.ChromeLink().call('computer', { action: 'left_click' }), /may have completed/i)
    assert.equal(env.writes.length, 1)
    assert.equal(env.connections(), 1)
    assert.equal(env.timers.size, 0)
  })
}

test('a failed action does not block a later independent request', async () => {
  const env = harness({ onWrite: ({ socket, number }) => {
    if (number === 1) socket.emit('close')
    else socket.emit('data', wire(reply))
  } })
  const link = new env.ChromeLink()
  await assert.rejects(link.call('computer', { action: 'left_click' }), /may have completed/i)
  const result = await link.call('get_page_text', { tabId: 1 })
  assert.equal(result.result.content[0].text, 'Synthetic browser reply')
  assert.equal(env.writes.length, 2)
  assert.equal(env.writes[0].params.tool, 'computer')
  assert.equal(env.writes[1].params.tool, 'get_page_text')
  assert.equal(env.timers.size, 0)
})

test('reconnects once after a failure before a request was sent', async () => {
  const env = harness({ onConnect: ({ socket, number }) => {
    if (number === 1) socket.emit('error', Object.assign(new Error('Synthetic stale endpoint'), { code: 'ECONNREFUSED' }))
    else socket.emit('connect')
  } })
  const result = await new env.ChromeLink().call('computer', { action: 'left_click' })
  assert.equal(result.result.content[0].text, 'Synthetic browser reply')
  assert.equal(env.writes.length, 1)
  assert.equal(env.connections(), 2)
  assert.equal(env.timers.size, 0)
})

test('an interrupt during connection setup prevents the queued action', async () => {
  const abort = new AbortController()
  const env = harness({ onConnect: ({ socket }) => {
    abort.abort()
    socket.emit('connect')
  } })
  await assert.rejects(new env.ChromeLink().call('computer', { action: 'type', text: 'test' }, abort.signal), /interrupted/i)
  assert.equal(env.writes.length, 0)
  assert.equal(env.timers.size, 0)
})

test('an already interrupted action does not connect', async () => {
  const env = harness()
  const abort = new AbortController()
  abort.abort()
  await assert.rejects(new env.ChromeLink().call('computer', { action: 'type' }, abort.signal), /interrupted/i)
  assert.equal(env.connections(), 0)
  assert.equal(env.writes.length, 0)
})
