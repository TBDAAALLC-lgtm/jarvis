import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { syncBuiltinESMExports } from 'node:module'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { fetchText, openRemote, vetTarget } from './net.mjs'

function response(statusCode, headers = {}, body) {
  const res = new PassThrough()
  res.statusCode = statusCode
  res.headers = headers
  if (body !== undefined) res.end(body)
  return res
}

function stubRequests(t, responses) {
  const requests = []
  const stub = t.mock.method(http, 'request', (url) => {
    requests.push(url.href)
    const req = new EventEmitter()
    req.setTimeout = () => req
    req.destroy = (error) => { if (error) req.emit('error', error) }
    req.end = () => queueMicrotask(() => {
      const res = responses.shift()
      if (res) req.emit('response', res)
      else req.emit('error', new Error('unexpected request'))
    })
    return req
  })
  syncBuiltinESMExports()
  t.after(() => { stub.mock.restore(); syncBuiltinESMExports() })
  return requests
}

test('redirect bodies are stopped before following the next URL', async (t) => {
  const redirect = response(302, { location: '/final' })
  const final = response(200, {}, 'ok')
  const requests = stubRequests(t, [redirect, final])
  const result = await openRemote(new URL('http://example.com/start'), {}, 1000)
  assert.equal(result.res, final)
  assert.deepEqual(requests, ['http://example.com/start', 'http://example.com/final'])
  assert.equal(redirect.destroyed, true, 'unused redirect body must not keep downloading')
})

test('a refused private redirect closes its response without making another request', async (t) => {
  const redirect = response(302, { location: 'http://127.0.0.1/private' })
  const requests = stubRequests(t, [redirect])
  await assert.rejects(openRemote(new URL('http://example.com/start'), {}, 1000), { status: 403 })
  assert.equal(requests.length, 1)
  assert.equal(redirect.destroyed, true)
})

test('fetchText closes rejected status bodies instead of draining them without a cap', async (t) => {
  const rejected = response(500)
  stubRequests(t, [rejected])
  await assert.rejects(fetchText('http://example.com/page', { maxBytes: 8, timeoutMs: 1000 }), { status: 502 })
  assert.equal(rejected.destroyed, true)
})

test('fetchText still reads successful text and preserves its content type', async (t) => {
  stubRequests(t, [response(200, { 'content-type': 'text/plain; charset=utf-8' }, 'hello')])
  const result = await fetchText('http://example.com/page', { maxBytes: 8, timeoutMs: 1000 })
  assert.equal(result.text, 'hello')
  assert.equal(result.bytes, 5)
  assert.equal(result.type, 'text/plain')
})

test('fetchText aborts a successful response that exceeds the byte limit', async (t) => {
  const oversized = response(200, {}, 'too much content')
  stubRequests(t, [oversized])
  await assert.rejects(fetchText('http://example.com/page', { maxBytes: 8, timeoutMs: 1000 }), { status: 413 })
  assert.equal(oversized.destroyed, true)
})

test('private address and non-HTTP targets stay blocked before any request', () => {
  for (const url of ['http://127.0.0.1/', 'http://[::1]/', 'http://169.254.169.254/', 'http://printer.local/']) {
    assert.throws(() => vetTarget(url), { status: 403 })
  }
  assert.throws(() => vetTarget('file:///private'), { status: 400 })
})
