import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { test } from 'node:test'
import { z } from 'zod'
import { flatten } from './toolkit.mjs'

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
const notification = { method: 'notifications/tools/list_changed', params: {} }

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

for (const delivery of ['separate chunks', 'one chunk']) {
  test(`a notification before a result preserves the pending action (${delivery})`, async () => {
    let timerStillPending = false
    const env = harness({ onWrite: ({ socket, timers, callback }) => {
      callback()
      if (delivery === 'one chunk') {
        socket.emit('data', Buffer.concat([wire(notification), wire(reply)]))
      } else {
        socket.emit('data', wire(notification))
        timerStillPending = [...timers].some((timer) => timer.delay === 45_000)
        socket.emit('data', wire(reply))
      }
    } })
    const result = await new env.ChromeLink().call('computer', { action: 'left_click' })
    assert.equal(result.result?.content[0].text, 'Synthetic browser reply')
    if (delivery === 'separate chunks') assert.equal(timerStillPending, true)
    assert.equal(env.writes.length, 1)
    assert.equal(env.connections(), 1)
    assert.equal(env.timers.size, 0)
  })
}

test('a notification does not consume or hide an extension permission error', async () => {
  const env = harness({ onWrite: ({ socket, callback }) => {
    callback()
    socket.emit('data', Buffer.concat([
      wire(notification), wire({ error: { content: 'Permission denied by user' } }),
    ]))
  } })
  const readPage = env.chromeKit({ allowWrites: false }).specs.find((spec) => spec.name === 'chrome_read_page')
  const result = await readPage.handler({ tabId: 7 }, {})
  assert.equal(result.isError, true)
  assert.equal(result.content[0].text, 'Permission denied by user')
  assert.equal(env.writes.length, 1)
  assert.equal(env.connections(), 1)
  assert.equal(env.timers.size, 0)
})

for (const [format, failure, expectedText] of [
  ['MCP content blocks', { isError: true, content: [{ type: 'text', text: 'Permission denied by user' }] }, 'Permission denied by user'],
  ['legacy text content', { isError: true, content: 'Permission denied by user' }, 'Permission denied by user'],
  ['fallback result', { isError: true, message: 'Permission denied by user' }, '{"isError":true,"message":"Permission denied by user"}'],
]) {
  test(`a nested tool failure stays an error through Chrome and GPT normalization (${format})`, async () => {
    const env = harness({ onWrite: ({ socket, callback }) => {
      callback()
      socket.emit('data', wire({ result: failure }))
    } })
    const readPage = env.chromeKit({ allowWrites: false }).specs.find((spec) => spec.name === 'chrome_read_page')
    const result = await readPage.handler({ tabId: 7 }, {})
    const gptResult = flatten(result)
    assert.equal(gptResult.text, expectedText)
    assert.equal(gptResult.isError, true)
    assert.equal(result.isError, true)
    assert.equal(env.writes.length, 1)
    assert.equal(env.timers.size, 0)
  })
}

test('an unrecognized JSON frame leaves the action waiting for a result', async () => {
  const env = harness({ onWrite: ({ socket }) => {
    socket.emit('data', Buffer.concat([wire({ unexpected: true }), wire(reply)]))
  } })
  const result = await new env.ChromeLink().call('get_page_text', { tabId: 7 })
  assert.equal(result.result?.content[0].text, 'Synthetic browser reply')
  assert.equal(env.writes.length, 1)
  assert.equal(env.timers.size, 0)
})

for (const field of ['result', 'error']) {
  test(`a malformed ${field} after a notification fails without replaying the action`, async () => {
    const env = harness({ onWrite: ({ socket }) => {
      const body = Buffer.from(`{"${field}":`)
      const header = Buffer.alloc(4)
      header.writeUInt32LE(body.length)
      socket.emit('data', Buffer.concat([wire(notification), header, body]))
    } })
    await assert.rejects(
      new env.ChromeLink().call('computer', { action: 'left_click' }),
      /unreadable reply from the browser:.*may have completed/i,
    )
    assert.equal(env.writes.length, 1)
    assert.equal(env.connections(), 1)
    assert.equal(env.timers.size, 0)
  })
}

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

const tabContext = (tabId) => ({ result: { content: [
  { type: 'text', text: JSON.stringify({ availableTabs: [{ tabId }] }) },
] } })
const missingTab = { error: { content: 'No tab available' } }

for (const closed of [false, true]) {
  test(`close-tab ${closed ? 'clears the target after confirmed success' : 'preserves the target after a permission denial'}`, async () => {
    let contextCalls = 0
    const env = harness({ onWrite: ({ socket, message }) => {
      const response = message.params.tool === 'tabs_context_mcp'
        ? tabContext(++contextCalls === 1 ? 101 : 202)
        : message.params.tool === 'tabs_close_mcp' && !closed
          ? { error: { content: 'Permission denied by user' } } : reply
      socket.emit('data', wire(response))
    } })
    const kit = env.chromeKit({ allowWrites: true })
    const invoke = (name, args = {}) => kit.specs.find((spec) => spec.name === name).handler(args, {})
    await invoke('chrome_read_page')
    const close = await invoke('chrome_close_tab', { tabId: 101 })
    assert.equal(close.isError === true, !closed)
    await invoke('chrome_read_page')
    assert.equal(env.writes.at(-1).params.args.tabId, closed ? 202 : 101)
    assert.equal(contextCalls, closed ? 2 : 1)
    assert.equal(env.writes.filter((message) => message.params.tool === 'tabs_close_mcp').length, 1)
  })
}

for (const [name, args] of [
  ['chrome_click', { ref: 'ref_1' }],
  ['chrome_type', { text: 'Synthetic text' }],
  ['chrome_key', { text: 'Return' }],
  ['chrome_form_input', { ref: 'ref_1', value: 'Synthetic value' }],
  ['chrome_navigate', { url: 'http://localhost:5185/' }],
  ['chrome_read_page', { tabId: 101 }],
]) {
  test(`${name} does not retry a missing target on a different tab`, async () => {
    let contextCalls = 0
    const env = harness({ onWrite: ({ socket, message }) => {
      socket.emit('data', wire(message.params.tool === 'tabs_context_mcp'
        ? tabContext(++contextCalls === 1 && args.tabId === undefined ? 101 : 202)
        : missingTab))
    } })
    const tool = env.chromeKit({ allowWrites: true }).specs.find((spec) => spec.name === name)
    const result = await tool.handler(args, {})
    assert.equal(result.isError, true)
    assert.equal(result.content[0].text, 'No tab available')
    const actions = env.writes.filter((message) => message.params.tool !== 'tabs_context_mcp')
    assert.equal(actions.length, 1)
    assert.equal(actions[0].params.args.tabId, 101)
    assert.equal(contextCalls, args.tabId === undefined ? 1 : 0)
  })
}

for (const [format, content] of [
  ['creation text', [
    { type: 'text', text: 'Created new tab. Tab ID: 202' },
    { type: 'text', text: 'Tab Context:\n- Executed on tabId: 202\n- Available tabs:\n  • tabId 101: "Older tab"\n  • tabId 202: "New Tab"' },
  ]],
  ['executed-tab context', [
    { type: 'text', text: 'Tab Context:\n- Executed on tabId: 202\n- Available tabs:\n  • tabId 101: "Older tab"\n  • tabId 202: "New Tab"' },
  ]],
  ['explicit JSON id', [{ type: 'text', text: JSON.stringify({ tabId: 202, availableTabs: [{ tabId: 101 }] }) }]],
]) {
  test(`new-tab remembers the created tab for an omitted-tab action (${format})`, async () => {
    const env = harness({ onWrite: ({ socket, message }) => {
      const response = message.params.tool === 'tabs_context_mcp' ? tabContext(101)
        : message.params.tool === 'tabs_create_mcp' ? { result: { content } } : reply
      socket.emit('data', wire(response))
    } })
    const kit = env.chromeKit({ allowWrites: true })
    const invoke = (name, args = {}) => kit.specs.find((spec) => spec.name === name).handler(args, {})
    await invoke('chrome_read_page')
    await invoke('chrome_new_tab')
    await invoke('chrome_type', { text: 'Synthetic text' })
    assert.equal(env.writes.at(-1).params.args.tabId, 202)
    assert.equal(env.writes.filter((message) => message.params.tool === 'tabs_context_mcp').length, 1)
  })
}

for (const creation of ['failed', 'missing id']) {
  test(`new-tab ${creation === 'failed' ? 'preserves the target on failure' : 'clears the old target when no created id is returned'}`, async () => {
    let contextCalls = 0
    const env = harness({ onWrite: ({ socket, message }) => {
      const response = message.params.tool === 'tabs_context_mcp' ? tabContext(++contextCalls === 1 ? 101 : 303)
        : message.params.tool === 'tabs_create_mcp' && creation === 'failed'
          ? { error: { content: 'Permission denied by user' } } : reply
      socket.emit('data', wire(response))
    } })
    const kit = env.chromeKit({ allowWrites: true })
    const invoke = (name) => kit.specs.find((spec) => spec.name === name).handler({}, {})
    await invoke('chrome_read_page')
    await invoke('chrome_new_tab')
    await invoke('chrome_read_page')
    assert.equal(env.writes.at(-1).params.args.tabId, creation === 'failed' ? 101 : 303)
    assert.equal(contextCalls, creation === 'failed' ? 1 : 2)
  })
}

test('an explicit missing tab does not discard a different remembered target', async () => {
  const env = harness({ onWrite: ({ socket, message }) => {
    const response = message.params.tool === 'tabs_context_mcp' ? tabContext(101)
      : message.params.args.tabId === 202 ? missingTab : reply
    socket.emit('data', wire(response))
  } })
  const readPage = env.chromeKit({ allowWrites: false }).specs.find((spec) => spec.name === 'chrome_read_page')
  await readPage.handler({}, {})
  const failed = await readPage.handler({ tabId: 202 }, {})
  await readPage.handler({}, {})
  assert.equal(failed.isError, true)
  assert.equal(env.writes.at(-1).params.args.tabId, 101)
  assert.equal(env.writes.filter((message) => message.params.tool === 'tabs_context_mcp').length, 1)
})
