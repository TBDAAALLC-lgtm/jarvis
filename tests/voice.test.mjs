import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { test } from 'node:test'
import { DEFAULT_KOKORO_VOICE, KOKORO_VOICES, scoreSystemVoice } from '../shared/voice.mjs'

const voice = (name, lang = 'en-US') => ({ name, lang })
const ranked = (voices) => voices
  .map((v) => ({ ...v, score: scoreSystemVoice(v) }))
  .filter((v) => v.score >= 40)
  .sort((a, b) => b.score - a.score)

test('Windows American male voice outranks the old British default', () => {
  const voices = [voice('Daniel (Premium)', 'en-GB'), voice('Microsoft David - English (United States)'), voice('Microsoft Zira - English (United States)')]
  assert.equal(ranked(voices)[0].name, voices[1].name)
})

test('macOS American male voice outranks the old British default', () => {
  assert.equal(ranked([voice('Daniel (Enhanced)', 'en-GB'), voice('Alex')])[0].name, 'Alex')
})

test('British-only installations keep a usable fallback', () => {
  assert.deepEqual(ranked([voice('Google UK English Male', 'en-GB')]).map((v) => v.name), ['Google UK English Male'])
})

test('novelty, non-English and unknown voices do not enter the male voice cycle', () => {
  assert.deepEqual(ranked([voice('Alex', 'de-DE'), voice('Bubbles (Premium)'), voice('Unknown Voice (Premium)'), voice('Samantha (Enhanced)'), voice('Google UK English Female', 'en-GB')]), [])
})

test('Kokoro defaults and retained overrides exist in the installed voice model', () => {
  assert.ok(KOKORO_VOICES.includes(DEFAULT_KOKORO_VOICE))
  for (const id of KOKORO_VOICES) {
    assert.ok(existsSync(new URL(`../node_modules/kokoro-js/voices/${id}.bin`, import.meta.url)), `missing Kokoro voice: ${id}`)
  }
})
