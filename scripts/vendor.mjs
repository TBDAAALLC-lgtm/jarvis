import { cpSync, mkdirSync } from 'node:fs'

/** Refresh the locked hand-tracking runtime for both dev and production. */
export function vendorWasm() {
  const from = new URL('../node_modules/@mediapipe/tasks-vision/wasm/', import.meta.url)
  const to = new URL('../public/mediapipe/', import.meta.url)
  mkdirSync(to, { recursive: true })
  cpSync(from, to, { recursive: true })
}
