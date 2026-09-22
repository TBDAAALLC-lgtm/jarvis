#!/usr/bin/env node
/**
 * Persona guard.
 *
 * The spoken persona lives in a template literal in bridge/server.mjs and has
 * no test around it, so every property it depends on has been rediscovered
 * the expensive way: by writing a rule, generating answers, and reading them
 * back. Most of what went wrong was not a matter of taste and did not need a
 * model to catch it. A backtick would have broken the file. An em dash is
 * read aloud as nothing and cost a pass to notice. A rule quoting a whole
 * sentence gets recited back as an answer.
 *
 * This checks the mechanical half, in a second, on every run. It cannot tell
 * you whether the voice is any good. It can tell you the prompt is still
 * well-formed, that the persona has not silently swallowed the tool
 * instructions, and that the guards which stopped known failures are still
 * in the file.
 *
 *   npm run check:persona
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SERVER = join(ROOT, 'bridge', 'server.mjs')

const BACKSLASH = String.fromCharCode(92)
const TICK = String.fromCharCode(96)

/** Where the spoken persona stops and the tool instructions begin. */
const BOUNDARY = 'The blades'

const problems = []
const notes = []
const fail = (m) => problems.push(m)
const note = (m) => notes.push(m)

const src = readFileSync(SERVER, 'utf8').replace(/\r\n/g, '\n')

// --- extract ---------------------------------------------------------------
const open = 'const SYSTEM_PROMPT = ' + TICK
const start = src.indexOf(open)
if (start === -1) {
  console.error('FAIL  SYSTEM_PROMPT not found in bridge/server.mjs')
  process.exit(1)
}
let end = start + open.length
while (end < src.length) {
  if (src[end] === TICK && src[end - 1] !== BACKSLASH) break
  end++
}
const prompt = src.slice(start + open.length, end)
const cut = prompt.indexOf(BOUNDARY)
if (cut === -1) {
  console.error(`FAIL  persona/tool boundary "${BOUNDARY}" not found`)
  process.exit(1)
}
const persona = prompt.slice(0, cut)
const tools = prompt.slice(cut)

// --- 1. it has to survive being a template literal -------------------------
// An unescaped backtick or a dollar-brace does not fail loudly; it changes
// what the string is, or stops the file parsing.
for (const [name, text] of [['persona', persona], ['tools', tools]]) {
  const bare = text.split('').filter((c, i) => c === TICK && text[i - 1] !== BACKSLASH)
  if (bare.length) fail(`${name}: ${bare.length} unescaped backtick(s)`)
  if (text.includes('${')) fail(`${name}: contains a dollar-brace sequence`)
}

// --- 2. every character has to be sayable ----------------------------------
// Em dashes, smart quotes and ellipses are silent or mispronounced, and they
// are invisible in review. The persona is held to pure ASCII; the tool half
// is only reported, since it is not spoken.
const nonAscii = [...persona].filter((c) => c.charCodeAt(0) > 126)
if (nonAscii.length) {
  fail(`persona: ${nonAscii.length} non-ASCII character(s): ${JSON.stringify([...new Set(nonAscii)].join(''))}`)
}
const toolNonAscii = [...tools].filter((c) => c.charCodeAt(0) > 126)
if (toolNonAscii.length) {
  note(`tools: ${toolNonAscii.length} non-ASCII (not spoken, so only noted)`)
}

// --- 3. the recital guard --------------------------------------------------
// Without this line the model answers with the prompt's own examples. That
// happened, verbatim, and invalidated a whole evaluation pass.
// Matched loosely on purpose: the wording of this guard has already
// changed once, and a checker that only knows one phrasing reports a
// missing rule that is sitting in front of it.
if (!/shapes?[^.]{0,60}scripts?/i.test(persona)) {
  fail('persona: the shape-not-script guard is missing - examples will be recited back as answers')
}

// --- 4. no service register outside the rule that bans it ------------------
// "sir" may appear only in a line that forbids it.
const SERVICE = /\b(sir|shall i|very good|at your service|as you wish)\b/i
const NEGATED = /\b(no|not|never|ban|forbid)\b/i
persona.split('\n').forEach((line, i) => {
  if (SERVICE.test(line) && !NEGATED.test(line)) {
    fail(`persona line ${i + 1}: service register used rather than banned - ${line.trim().slice(0, 60)}`)
  }
})

// --- 5. the two brains have to agree about the user ------------------------
// The name block is composed at call time, so a provider that builds its
// system message without it is talking to a different person.
const addressUses = (src.match(/addressBlock\(\)/g) || []).length
if (addressUses < 3) {
  fail(`addressBlock() is referenced ${addressUses} time(s): its definition plus one per provider is the minimum, so a brain is missing it`)
}

// --- 6. and it has to render, in both branches -----------------------------
const fnSrc = src.match(/function addressBlock\(\)[\s\S]*?\n}/)
if (!fnSrc) {
  fail('addressBlock() not found')
} else {
  for (const name of ['', 'Ada']) {
    process.env.JARVIS_NAME = name
    let out
    try {
      out = new Function(`${fnSrc[0]}; return addressBlock()`)()
    } catch (err) {
      fail(`addressBlock() threw with JARVIS_NAME=${JSON.stringify(name)}: ${err.message}`)
      continue
    }
    if (!out || out.length < 80) {
      fail(`addressBlock() returned almost nothing with JARVIS_NAME=${JSON.stringify(name)}`)
    }
    if (name && !out.includes(name)) {
      fail('addressBlock() ignored JARVIS_NAME')
    }
    if (!name && /THEIR NAME IS/.test(out)) {
      fail('addressBlock() claimed a name when none is set')
    }
  }
  delete process.env.JARVIS_NAME
}

// --- 7. line length --------------------------------------------------------
const long = persona.split('\n').filter((l) => l.length > 80)
if (long.length) note(`persona: ${long.length} line(s) over 80 columns`)

// --- report ----------------------------------------------------------------
const lines = persona.split('\n').length
console.log(`persona  ${persona.length} bytes / ${lines} lines / ~${Math.round(persona.length / 3.8)} tokens`)
console.log(`tools    ${tools.length} bytes / ${tools.split('\n').length} lines`)
for (const n of notes) console.log(`note  ${n}`)
if (!problems.length) {
  console.log('ok    every persona guard holds')
  process.exit(0)
}
for (const p of problems) console.error(`FAIL  ${p}`)
process.exit(1)
