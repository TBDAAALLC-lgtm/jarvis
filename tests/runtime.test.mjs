import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { loadConfigFromFile } from 'vite'

for (const [url, origin] of [
  ['ws://127.0.0.1:18888', 'http://127.0.0.1:18888'],
  ['wss://bridge.example.test/ws', 'https://bridge.example.test'],
]) {
  test(`CSP permits configured bridge HTTP endpoints for ${url}`, async () => {
    const saved = process.env.VITE_BRIDGE_URL
    process.env.VITE_BRIDGE_URL = url
    try {
      const loaded = await loadConfigFromFile({ command: 'build', mode: 'production' })
      const plugin = loaded.config.plugins.flat().find((p) => p.name === 'jarvis-runtime')
      const html = plugin.transformIndexHtml(await readFile(new URL('../index.html', import.meta.url), 'utf8'))
      for (const directive of ['connect-src', 'img-src', 'media-src', 'frame-src']) {
        const sources = new RegExp(`${directive} ([^;]+);`).exec(html)?.[1].split(/\s+/) ?? []
        assert.ok(sources.includes(origin), `${directive} missing ${origin}`)
        assert.ok(!sources.includes('http:'), 'do not allow all HTTP origins')
      }
    } finally {
      if (saved === undefined) delete process.env.VITE_BRIDGE_URL
      else process.env.VITE_BRIDGE_URL = saved
    }
  })
}
