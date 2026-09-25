import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

const source = ts.transpileModule(
  await readFile(new URL('./capabilities.ts', import.meta.url), 'utf8'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
).outputText

function harness({ health, backend = 'bridge', fail = false } = {}) {
  let requests = 0
  const context = vm.createContext({
    exports: {},
    require(name) {
      assert.equal(name, '../config')
      return { BACKEND: backend, BRIDGE_HTTP_URL: 'http://synthetic.invalid', env: {} }
    },
    AbortSignal,
    fetch: async (url, options) => {
      requests++
      assert.equal(url, 'http://synthetic.invalid/health')
      assert.ok(options.signal instanceof AbortSignal)
      if (fail) throw new Error('bridge unavailable')
      return { ok: true, json: async () => health }
    },
  })
  vm.runInContext(source, context, { filename: 'capabilities.ts' })
  return { ...context.exports, requests: () => requests }
}

test('Google recognition is available independently of browser or ElevenLabs voice output', async () => {
  for (const tts of [false, true]) {
    const h = harness({ health: { stt: true, sttProvider: 'google', sttDetail: 'Credentials checked; API unverified', tts } })
    assert.equal(h.capabilitiesProbed(), false)
    const caps = await h.probeCapabilities()
    assert.equal(caps.stt, true)
    assert.equal(caps.sttProvider, 'google')
    assert.equal(caps.sttDetail, 'Credentials checked; API unverified')
    assert.equal(caps.tts, tts)
    assert.equal(h.engineLabel(), `Google recognition · ${tts ? 'ElevenLabs' : 'browser'} voice`)
    assert.equal(h.capabilitiesProbed(), true)
    assert.equal(h.requests(), 1)
  }
})

test('selected but unavailable Google retains its setup state instead of presenting browser fallback as ready', async () => {
  const detail = 'Configure Application Default Credentials for the selected project.'
  const h = harness({ health: { stt: false, sttProvider: 'google', sttDetail: detail, tts: true } })
  await h.probeCapabilities()
  assert.equal(h.caps().stt, false)
  assert.equal(h.caps().sttProvider, 'google')
  assert.equal(h.caps().sttDetail, detail)
  assert.equal(h.caps().tts, true)
  assert.equal(h.engineLabel(), 'Google Speech-to-Text · setup required')
})

test('legacy bridge speech capabilities preserve the previous ElevenLabs and browser choices', async () => {
  for (const stt of [false, true]) {
    const h = harness({ health: { stt, tts: stt } })
    await h.probeCapabilities()
    assert.equal(h.caps().stt, stt)
    assert.equal(h.caps().sttProvider, stt ? 'elevenlabs' : 'browser')
    assert.equal(h.engineLabel(), stt ? 'ElevenLabs' : 'browser speech')
  }
})

test('an unreachable bridge does not invent a working cloud recognizer', async () => {
  const h = harness({ fail: true })
  await h.probeCapabilities()
  assert.equal(h.caps().stt, false)
  assert.equal(h.caps().tts, false)
  assert.equal(h.engineLabel(), 'browser speech')
  assert.equal(h.capabilitiesProbed(), true)
})

test('direct mode keeps server-side speech disabled without probing the bridge', async () => {
  const h = harness({ backend: 'direct' })
  await h.probeCapabilities()
  assert.equal(h.caps().stt, false)
  assert.equal(h.caps().tts, false)
  assert.equal(h.engineLabel(), 'browser speech')
  assert.equal(h.requests(), 0)
})
