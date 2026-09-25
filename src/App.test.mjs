import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

const source = ts.transpileModule(
  await readFile(new URL('./App.tsx', import.meta.url), 'utf8'),
  {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
    },
  },
).outputText

// Run the real component's ignition and voice callbacks. External speech,
// providers, rendering and timers are controlled here; no microphone is opened.
async function harness() {
  const noop = () => {}
  const refs = []
  let refIndex = 0
  let nextTimer = 0
  let callbacks
  const timers = new Map()
  const spoken = []
  const asks = []
  const turns = []
  const state = {
    phase: 'offline',
    provider: 'claude',
    setPhase: (phase) => { state.phase = phase },
    setError: noop,
    setCaption: noop,
    setActiveTool: noop,
    clearPanels: noop,
    clearBlades: noop,
    setConnected: noop,
    setVoice: noop,
    pushTurn: (turn) => turns.push(turn),
    appendToLastTurn: (text) => { turns.at(-1).text += text },
  }
  const useStore = (selector) => selector(state)
  useStore.getState = () => state
  const Ignition = () => null
  const jsx = (type, props) => ({ type, props })
  const imports = {
    react: {
      useRef: (initial) => {
        const index = refIndex++
        return refs[index] ?? (refs[index] = { current: initial })
      },
      // DOM effects are not part of these callback tests; rerenders retain refs.
      useEffect: noop,
    },
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: Symbol('Fragment') },
    './scene/Scene': { Scene: noop },
    './ui/Hud': { Hud: noop },
    './ui/Boot': { Boot: noop },
    './ui/Diagnostics': { Diagnostics: noop },
    './ui/Ignition': { Ignition },
    './store': { useStore },
    './lib/voice': {
      startVoice: async (handlers) => {
        callbacks = handlers
        return { stop: noop, live: () => true }
      },
    },
    './lib/tts': {
      createSpeaker: () => ({
        say: (text) => spoken.push(text),
        push: (text) => spoken.push(text),
        end: async () => {},
        cancel: noop,
        level: () => 0,
      }),
      currentVoiceName: () => 'Test voice',
    },
    './lib/sfx': { unlockAudio: async () => {}, play: noop, duck: noop },
    './lib/music': {
      enable: noop, playBoot: noop, startAmbient: noop, working: noop, duck: noop,
    },
    './lib/hands': {},
    './lib/clap': {},
    './lib/camera': {},
    './lib/kokoro': {},
    './config': { TTS_ENGINE: 'browser', env: {} },
    './lib/fillers': { attention: () => 'At your service, sir.', forTool: () => '' },
    './lib/brain': {
      ask: async (text) => { asks.push(text); return { text: '' } },
      warm: async () => {},
      interrupt: noop,
      watchServers: noop,
      watchPanels: noop,
      watchBlades: noop,
      watchCapture: noop,
      watchUi: noop,
      watchConnection: noop,
      connectedLabels: () => [],
      usingBridge: true,
    },
    './lib/audio': { startAnalyser: async () => {}, micLevel: () => 0 },
    './lib/capabilities': { probeCapabilities: async () => {} },
  }
  const context = vm.createContext({
    exports: {},
    require: (name) => {
      assert.ok(Object.hasOwn(imports, name), `Unexpected dependency: ${name}`)
      return imports[name]
    },
    console,
    setTimeout: (fn, delay) => {
      const id = ++nextTimer
      timers.set(id, { fn, delay })
      return id
    },
    clearTimeout: (id) => timers.delete(id),
    setInterval: () => ++nextTimer,
    clearInterval: noop,
  })
  vm.runInContext(source, context, { filename: 'App.tsx' })
  const render = () => {
    refIndex = 0
    return context.exports.default()
  }
  const tree = render()
  const ignition = tree.props.children.find((child) => child.type === Ignition)
  assert.ok(ignition, 'The rendered ignition button must start the app')
  ignition.props.onStart()
  await new Promise(setImmediate)
  const bootTimer = [...timers].find(([, timer]) => timer.delay === 9200)
  assert.ok(bootTimer, 'Ignition must reach the boot sequence')
  timers.delete(bootTimer[0])
  bootTimer[1].fn()
  await new Promise(setImmediate)
  assert.ok(callbacks, 'Boot must register the actual voice callbacks')
  assert.equal(state.phase, 'dormant')

  return {
    callbacks, state, spoken, asks, render,
    async settle() { await new Promise(setImmediate) },
    sleep() {
      const idle = [...timers].find(([, timer]) => timer.delay === 14000 || timer.delay === 11000)
      assert.ok(idle, 'Listening must have an idle timeout')
      timers.delete(idle[0])
      idle[1].fn()
      assert.equal(state.phase, 'dormant')
    },
  }
}

test('the first bare wake greets and immediately listens without calling a model', async () => {
  const app = await harness()
  app.callbacks.onWake('')
  assert.deepEqual(app.spoken, ['At your service, sir.'])
  assert.equal(app.state.phase, 'listening')
  assert.deepEqual(app.asks, [])
})

test('later bare wakes listen silently after standby and a component rerender', async () => {
  const app = await harness()
  app.callbacks.onWake('')
  app.sleep()
  app.render()
  app.callbacks.onWake('')
  assert.equal(app.state.phase, 'listening')
  assert.deepEqual(app.spoken, ['At your service, sir.'])
  assert.deepEqual(app.asks, [])
})

test('a command on the first wake consumes the greeting opportunity for the session', async () => {
  const app = await harness()
  app.callbacks.onWake('open the report')
  await app.settle()
  assert.deepEqual(app.asks, ['open the report'])
  assert.deepEqual(app.spoken, [])
  app.sleep()
  app.callbacks.onWake('')
  assert.equal(app.state.phase, 'listening')
  assert.deepEqual(app.spoken, [])
  assert.deepEqual(app.asks, ['open the report'])
})

test('punctuated bare names while listening never request a new introduction from a model', async () => {
  const app = await harness()
  app.callbacks.onWake('')
  for (const text of ['Hey, Jarvis!', 'Jarvis.', 'hey jarvis']) {
    app.callbacks.onUtterance(text)
    await app.settle()
    assert.equal(app.state.phase, 'listening')
  }
  assert.deepEqual(app.asks, [])
  assert.deepEqual(app.spoken, ['At your service, sir.'])
})

test('a new page session gets its own first greeting', async () => {
  const firstPage = await harness()
  firstPage.callbacks.onWake('')
  const secondPage = await harness()
  secondPage.callbacks.onWake('')
  assert.deepEqual(firstPage.spoken, ['At your service, sir.'])
  assert.deepEqual(secondPage.spoken, ['At your service, sir.'])
})
