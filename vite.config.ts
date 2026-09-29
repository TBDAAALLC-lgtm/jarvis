import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { vendorWasm } from './scripts/vendor.mjs'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_')
  const bridgeUrl = new URL((env.VITE_BRIDGE_URL?.trim() || 'ws://localhost:8787').replace(/^ws/, 'http'))
  if (!['http:', 'https:'].includes(bridgeUrl.protocol)) {
    throw new Error('VITE_BRIDGE_URL must use ws:// or wss://')
  }
  const bridgeOrigins = [...new Set([
    'http://localhost:8787', 'http://127.0.0.1:8787', bridgeUrl.origin,
  ])].join(' ')
  return {
    plugins: [react(), {
      name: 'jarvis-runtime',
      buildStart: vendorWasm,
      transformIndexHtml: (html) => html.replaceAll(
        'http://localhost:8787 http://127.0.0.1:8787', bridgeOrigins,
      ),
    }],
    server: {
      // Honour PORT so a second instance can run alongside the first. The bridge
      // only accepts sockets from localhost:5173-5199, so stay inside that range
      // or set JARVIS_ALLOWED_ORIGINS to match.
      port: Number(process.env.PORT) || 5173,
    },
    optimizeDeps: {
      // kokoro-js pulls in `phonemizer`, which carries espeak-ng as inline WASM.
      // Vite's dependency pre-bundler rewrites that initialisation and the
      // language table ends up empty — the symptom is
      // `Invalid language identifier: "en". Should be one of: .` at generate()
      // time, long after the model has loaded successfully. Serving these
      // untouched fixes it.
      exclude: ['kokoro-js', 'phonemizer', '@huggingface/transformers'],
    },
  }
})
