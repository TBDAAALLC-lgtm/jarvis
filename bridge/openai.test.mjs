import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runTurn } from './gpt.mjs'
import { streamChat } from './openai.mjs'

// This worker never talks to a provider or loads local credential files.
process.env.OPENAI_API_KEY = 'synthetic-test-only'
process.env.OPENAI_MODEL = 'synthetic-chat-model'

const messages = [{ role: 'user', content: 'Hello' }]
const frame = (value, eol = '\n') => `data: ${JSON.stringify(value)}${eol}${eol}`
const delta = (content, finish_reason = null) => ({ choices: [{ delta: { content }, finish_reason }] })
const toolDelta = (finish_reason = 'tool_calls', id = 'call_1') => ({
  choices: [{
    delta: { tool_calls: [{ index: 0, id, function: { name: 'mcp__test__run', arguments: '{}' } }] },
    finish_reason,
  }],
})
const response = (chunks) => ({
  ok: true,
  status: 200,
  body: (async function* () {
    for (const chunk of chunks) yield typeof chunk === 'string' ? Buffer.from(chunk) : chunk
  })(),
})

test('streams ordinary LF text and preserves deltas', async () => {
  globalThis.fetch = async () => response([frame(delta('Hello')), frame(delta(' world', 'stop')), 'data: [DONE]\n\n'])
  const seen = []
  const result = await streamChat({ messages, onDelta: (text) => seen.push(text) })
  assert.equal(result.text, 'Hello world')
  assert.deepEqual(seen, ['Hello', ' world'])
  assert.equal(result.finishReason, 'stop')
  assert.equal(result.aborted, false)
})

for (const [label, eol] of [['CRLF', '\r\n'], ['CR', '\r']]) {
  test(`reads ${label} SSE with UTF-8 and delimiters split at every byte`, async () => {
    const bytes = Buffer.from(frame(delta('Hello 🌍'), eol) + frame(delta('', 'stop'), eol) + `data: [DONE]${eol}${eol}`)
    globalThis.fetch = async () => response(Array.from(bytes, (byte) => Uint8Array.of(byte)))
    const result = await streamChat({ messages })
    assert.equal(result.text, 'Hello 🌍')
    assert.equal(result.finishReason, 'stop')
  })
}

test('joins multiple data lines in one SSE event and ignores comments', async () => {
  globalThis.fetch = async () => response([
    ': keepalive\r\n\r\n',
    'data: {"choices":\r\ndata: [{"delta":{"content":"Hello"},"finish_reason":"stop"}]}\r\n\r\n',
    'data: [DONE]\r\n\r\n',
  ])
  assert.equal((await streamChat({ messages })).text, 'Hello')
})

test('surfaces an API error after partial text', async () => {
  globalThis.fetch = async () => response([
    frame(delta('Partial')),
    frame({ error: { message: 'Synthetic provider failure' } }),
  ])
  await assert.rejects(streamChat({ messages }), /Synthetic provider failure/)
})

test('surfaces a named error event without a nested error object', async () => {
  globalThis.fetch = async () => response(['event: error\n' + frame({ message: 'Synthetic event failure' })])
  await assert.rejects(streamChat({ messages }), /Synthetic event failure/)
})

test('rejects malformed JSON instead of silently dropping a data event', async () => {
  globalThis.fetch = async () => response(['data: {broken\n\n', frame(delta('', 'stop'))])
  await assert.rejects(streamChat({ messages }), /malformed|invalid.*JSON/i)
})

test('does not report a truncated text stream as completed', async () => {
  globalThis.fetch = async () => response([frame(delta('Partial'))])
  await assert.rejects(streamChat({ messages }), /ended|incomplete/i)
})

test('does not execute a tool from an unfinished stream', async () => {
  let executions = 0
  let requests = 0
  globalThis.fetch = async () => response([++requests === 1
    ? frame(toolDelta(null))
    : frame(delta('Done.', 'stop'))])
  const registry = new Map([['mcp__test__run', {
    description: 'Only increments a local test counter',
    inputSchema: {},
    handler: async () => {
      executions++
      return { content: [{ type: 'text', text: 'Done' }] }
    },
  }]])
  await assert.rejects(runTurn({
    system: 'Synthetic test', history: [...messages], registry,
    decide: () => true, refusal: 'Denied',
  }), /ended|incomplete/i)
  assert.equal(executions, 0)
  assert.equal(requests, 1)
})

test('returns complete tool calls only with the tool_calls finish reason', async () => {
  globalThis.fetch = async () => response([frame(toolDelta()), 'data: [DONE]\n\n'])
  const result = await streamChat({ messages })
  assert.deepEqual(result.toolCalls, [{ id: 'call_1', name: 'mcp__test__run', args: '{}' }])

  globalThis.fetch = async () => response([frame(toolDelta('length')), 'data: [DONE]\n\n'])
  await assert.rejects(streamChat({ messages }), /tool.*incomplete|incomplete.*tool/i)
})

test('assembles interleaved tool argument chunks by index', async () => {
  const toolFrame = (tool_calls, finish_reason = null) => frame({ choices: [{ delta: { tool_calls }, finish_reason }] })
  globalThis.fetch = async () => response([
    toolFrame([{ index: 1, id: 'call_b', function: { name: 'tool_b', arguments: '{"b":' } }]),
    toolFrame([{ index: 0, id: 'call_a', function: { name: 'tool_a', arguments: '{"a":' } }]),
    toolFrame([{ index: 1, function: { arguments: '2}' } }, { index: 0, function: { arguments: '1}' } }], 'tool_calls'),
    'data: [DONE]\n\n',
  ])
  const announced = []
  const result = await streamChat({ messages, onTool: (name) => announced.push(name) })
  assert.deepEqual(result.toolCalls, [
    { id: 'call_a', name: 'tool_a', args: '{"a":1}' },
    { id: 'call_b', name: 'tool_b', args: '{"b":2}' },
  ])
  assert.deepEqual(announced, ['tool_b', 'tool_a'])
})

test('rejects a completed tool call missing its call id', async () => {
  globalThis.fetch = async () => response([frame(toolDelta('tool_calls', '')), 'data: [DONE]\n\n'])
  await assert.rejects(streamChat({ messages }), /tool.*incomplete|incomplete.*tool/i)
})

test('stops at DONE and closes the response iterator', async () => {
  let closed = false
  globalThis.fetch = async () => ({
    ok: true,
    body: (async function* () {
      try {
        yield Buffer.from(frame(delta('Done', 'stop')) + 'data: [DONE]\n\n' + frame(delta(' ignored')))
        throw new Error('Must not read after DONE')
      } finally {
        closed = true
      }
    })(),
  })
  assert.equal((await streamChat({ messages })).text, 'Done')
  assert.equal(closed, true)
})

test('preserves cancellation before headers and during the response body', async () => {
  globalThis.fetch = async () => { throw new DOMException('Stopped', 'AbortError') }
  assert.equal((await streamChat({ messages })).aborted, true)

  globalThis.fetch = async () => ({
    ok: true,
    body: (async function* () {
      yield Buffer.from(frame(delta('Partial')))
      throw new DOMException('Stopped', 'AbortError')
    })(),
  })
  const result = await streamChat({ messages })
  assert.equal(result.text, 'Partial')
  assert.equal(result.aborted, true)
  assert.deepEqual(result.toolCalls, [])
})

test('keeps the existing tools/reasoning retry', async () => {
  const sent = []
  globalThis.fetch = async (_url, options) => {
    sent.push(JSON.parse(options.body))
    if (sent.length === 1) return new Response(JSON.stringify({ error: { message: 'Function tools with reasoning_effort are not supported' } }), { status: 400 })
    return response([frame(delta('Recovered', 'stop'))])
  }
  const result = await streamChat({ messages, tools: [{ type: 'function', function: { name: 'test' } }] })
  assert.equal(result.text, 'Recovered')
  assert.equal(sent.length, 2)
  assert.equal(sent[1].reasoning_effort, 'none')
})

test('keeps automatic model fallback after the first model is refused', async () => {
  delete process.env.OPENAI_MODEL
  const sent = []
  globalThis.fetch = async (url, options) => {
    if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'gpt-2' }, { id: 'gpt-1' }] }))
    sent.push(JSON.parse(options.body).model)
    if (sent.length === 1) return new Response(JSON.stringify({ error: { message: 'model does not exist' } }), { status: 404 })
    return response([frame(delta('Recovered', 'stop'))])
  }
  try {
    const result = await streamChat({ messages })
    assert.equal(result.text, 'Recovered')
    assert.deepEqual(sent, ['gpt-2', 'gpt-1'])
  } finally {
    process.env.OPENAI_MODEL = 'synthetic-chat-model'
  }
})
