import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { chromeKit } from './chrome.mjs'
import { registry } from './toolkit.mjs'

/**
 * The browser gate, and the promise it makes about everything else.
 *
 * `--browser-writes` exists so that "let JARVIS use my browser" does not also
 * mean "let JARVIS run a shell". That is only true if the flag widens exactly
 * one surface, so these tests assert both halves: the six acting Chrome tools
 * appear, and nothing outside Chrome moves.
 *
 * The gate is not re-implemented here. chromeKit decides at construction which
 * tools to build — that is the single place the policy lives — so that is what
 * gets measured.
 */

/** The tools that only exist once the browser may act. */
const ACTING = [
  'mcp__jarvis_chrome__chrome_click',
  'mcp__jarvis_chrome__chrome_type',
  'mcp__jarvis_chrome__chrome_key',
  'mcp__jarvis_chrome__chrome_form_input',
  'mcp__jarvis_chrome__chrome_new_tab',
  'mcp__jarvis_chrome__chrome_close_tab',
]

/** Present in both modes: looking at a page changes nothing. */
const READING = [
  'mcp__jarvis_chrome__chrome_status',
  'mcp__jarvis_chrome__chrome_tabs',
  'mcp__jarvis_chrome__chrome_navigate',
  'mcp__jarvis_chrome__chrome_read_page',
  'mcp__jarvis_chrome__chrome_page_text',
  'mcp__jarvis_chrome__chrome_screenshot',
]

const names = (allowWrites) => registry([chromeKit({ allowWrites })])

test('reading tools exist whether or not the browser may act', () => {
  for (const mode of [false, true]) {
    const reg = names(mode)
    for (const tool of READING) {
      assert.ok(reg.has(tool), `${tool} missing with allowWrites=${mode}`)
    }
  }
})

test('acting tools are absent until the browser may act', () => {
  const reg = names(false)
  for (const tool of ACTING) {
    assert.ok(!reg.has(tool), `${tool} should not be built in read-only mode`)
  }
})

test('acting tools appear when the browser may act', () => {
  const reg = names(true)
  for (const tool of ACTING) {
    assert.ok(reg.has(tool), `${tool} should be built when acting is allowed`)
  }
})

test('enabling the browser adds only the browser tools', () => {
  const off = names(false)
  const on = names(true)
  const added = [...on.keys()].filter((k) => !off.has(k))
  assert.deepEqual(added.sort(), [...ACTING].sort())
  // Nothing is taken away by turning it on, either.
  const removed = [...off.keys()].filter((k) => !on.has(k))
  assert.deepEqual(removed, [])
})

test('every tool the gate governs is a Chrome tool', () => {
  const off = names(false)
  const on = names(true)
  for (const k of [...on.keys()].filter((x) => !off.has(x))) {
    assert.ok(
      k.startsWith('mcp__jarvis_chrome__'),
      `${k} is outside the browser surface and must not move with this flag`,
    )
  }
})

/**
 * The gate itself, executed — not described.
 *
 * An earlier version of this file asserted things about the *source text*:
 * that a regex appeared, that an identifier was used twice. Those pass when
 * the code is spelled right and fail when it is merely reformatted, which is
 * the wrong way round. They cannot answer the only question worth asking —
 * with the browser flag on and nothing else, does `decideTool` still say no to
 * Bash?
 *
 * So the real thing runs. The flag constants and `decideTool` are lifted out
 * of server.mjs verbatim and evaluated as a module with `process.argv` and
 * `process.env` set to whatever case is under test. Booting the whole file is
 * not an option — it binds a port and spawns the Agent SDK on import — but
 * this is the same code, making the same decisions, not a restatement of it.
 */
const source = readFileSync(new URL('./server.mjs', import.meta.url), 'utf8')

const slice = (from, to) => {
  const a = source.indexOf(from)
  const b = source.indexOf(to, a)
  assert.ok(a >= 0 && b > a, `could not find ${from} … ${to} in server.mjs`)
  return source.slice(a, b)
}

/**
 * Everything from the flags down to the end of decideTool, minus the MCP
 * config read in the middle — that one touches the real ~/.claude.json and is
 * irrelevant here, so it is replaced with an empty server list.
 */
const GATE =
  'import { homedir } from "node:os"\n' +
  'import { join } from "node:path"\n' +
  slice('const ALLOW_WRITES =', 'const READ_ONLY_BUILTINS') +
  slice('const READ_ONLY_BUILTINS', '/**\n * Every MCP server') +
  'const MCP_SERVERS = {}\n' +
  slice('/** MCP tools arrive as', 'const SYSTEM_PROMPT') +
  '\nexport { decideTool, ALLOW_WRITES, ALLOW_BROWSER_WRITES, BROWSER_WRITES }\n'

/** Load the real gate with a given command line and environment. */
async function gateWith({ argv = [], env = {} } = {}) {
  const realArgv = process.argv
  const realEnv = { ...process.env }
  process.argv = ['node', 'server.mjs', ...argv]
  delete process.env.JARVIS_ALLOW_WRITES
  delete process.env.JARVIS_ALLOW_BROWSER_WRITES
  Object.assign(process.env, env)
  try {
    // The fragment busts the module cache so each case evaluates afresh.
    const tag = encodeURIComponent(JSON.stringify({ argv, env }))
    return await import('data:text/javascript,' + encodeURIComponent(GATE) + '#' + tag)
  } finally {
    process.argv = realArgv
    for (const k of ['JARVIS_ALLOW_WRITES', 'JARVIS_ALLOW_BROWSER_WRITES']) {
      if (realEnv[k] === undefined) delete process.env[k]
      else process.env[k] = realEnv[k]
    }
  }
}

/** Things that must stay denied unless the FULL write flag is set. */
const OFF_LIMITS = [
  'Bash',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'KillShell',
  'TaskStop',
  'mcp__some-server__send_message',
  'mcp__some-server__delete_character',
  'mcp__some-server__create_invoice',
  'mcp__some-server__make_outbound_call',
  'mcp__some-server__install_apk',
]

/** Reads, which are allowed in every mode. */
const ALWAYS_FINE = ['Read', 'Grep', 'WebSearch', 'mcp__some-server__list_devices']

const MODES = [
  { name: 'no flags', argv: [] },
  { name: '--browser-writes', argv: ['--browser-writes'] },
  { name: 'JARVIS_ALLOW_BROWSER_WRITES=1', env: { JARVIS_ALLOW_BROWSER_WRITES: '1' } },
]

for (const mode of MODES) {
  test(`browser-only (${mode.name}) still denies the shell, the filesystem and effectful MCP`, async () => {
    const g = await gateWith(mode)
    for (const tool of OFF_LIMITS) {
      assert.equal(g.decideTool(tool), false, `${tool} must be denied with ${mode.name}`)
    }
  })

  test(`reads are permitted with ${mode.name}`, async () => {
    const g = await gateWith(mode)
    for (const tool of ALWAYS_FINE) {
      assert.equal(g.decideTool(tool), true, `${tool} should be allowed with ${mode.name}`)
    }
  })
}

test('the browser flag is read from both the CLI and the environment', async () => {
  for (const mode of MODES.slice(1)) {
    const g = await gateWith(mode)
    assert.equal(g.ALLOW_BROWSER_WRITES, true, `${mode.name} should set the browser flag`)
    assert.equal(g.BROWSER_WRITES, true)
    assert.equal(g.ALLOW_WRITES, false, `${mode.name} must NOT set the full write flag`)
  }
})

test('--writes still enables the browser, and everything else', async () => {
  for (const mode of [{ argv: ['--writes'] }, { env: { JARVIS_ALLOW_WRITES: '1' } }]) {
    const g = await gateWith(mode)
    assert.equal(g.ALLOW_WRITES, true)
    assert.equal(g.BROWSER_WRITES, true, '--writes must continue to imply the browser')
    for (const tool of ['Bash', 'Write', 'Edit', 'mcp__some-server__send_message']) {
      assert.equal(g.decideTool(tool), true, `${tool} should be permitted with full writes`)
    }
  }
})

test('with no flags at all, the browser flag is off', async () => {
  const g = await gateWith({ argv: [] })
  assert.equal(g.ALLOW_WRITES, false)
  assert.equal(g.ALLOW_BROWSER_WRITES, false)
  assert.equal(g.BROWSER_WRITES, false)
})
