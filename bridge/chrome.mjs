import { tool } from '@anthropic-ai/claude-agent-sdk'
import { defineTools } from './toolkit.mjs'
import { z } from 'zod'
import { createConnection } from 'node:net'
import { readdir, stat } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { join } from 'node:path'

/**
 * JARVIS's hands on your actual browser.
 *
 * Not Playwright. Playwright drives a fresh automation profile: no cookies, no
 * sessions, and a fingerprint that the sites worth visiting recognise on sight
 * — you land on a login wall or a bot check, which is exactly where a voice
 * assistant is least able to help. The browser already sitting on the desk has
 * none of those problems. It is signed in to everything, it looks like a person
 * because it is one, and the pages it can reach are the pages the user actually
 * cares about.
 *
 * Reaching it is the interesting part.
 *
 * The Claude for Chrome extension already speaks to a local process — that is
 * how Claude Code's own browser tools work. The chain is:
 *
 *   Chrome extension  (fcoeoabgfenejglbffodgkkbkcdhcgfn)
 *        ↕  Chrome Native Messaging: 4-byte little-endian length + JSON
 *   chrome-native-host
 *        ↕  POSIX:   /tmp/claude-mcp-browser-bridge-<user>/<pid>.sock
 *        ↕  Windows: \\.\pipe\claude-mcp-browser-bridge-<user>
 *   whoever connects  ← this file
 *
 * What Claude Code normally does at that last step is detour through
 * `wss://bridge.claudeusercontent.com`, matching the CLI and the extension by
 * user id and OAuth token in Anthropic's cloud. That hop is the source of most
 * of the "Browser extension is not connected" reports: the socket underneath is
 * healthy and the bridge above it simply fails to authenticate, with no
 * fallback to the socket that was working all along.
 *
 * We are on the same machine as the socket, so we skip the round trip to
 * Virginia entirely and connect to it directly. Nothing about the browser side
 * changes — the extension does not know or care who is on the other end of its
 * native host.
 *
 * The cost of going under a private interface is that it can move. Everything
 * that could break is therefore soft: the socket is re-discovered on every
 * reconnect rather than pinned, an unreachable extension is reported to the
 * model as a plain sentence instead of thrown, and no tool here is required for
 * the rest of JARVIS to work.
 */

/**
 * Where the native host listens, which is not one answer.
 *
 * `userInfo().username` rather than $USER, which is unset under launchd — and a
 * bridge started from a login item is exactly the case where a wrong guess
 * would look like the extension being uninstalled.
 *
 * The rest of the name is the same everywhere; the container is not. On POSIX
 * the host opens a Unix socket in a directory of its own, one file per host
 * process, named for the pid. On Windows there are no Unix sockets to open, so
 * it creates a named pipe instead — and being a kernel object rather than a
 * file, it has no directory to sit in and no pid in its name. Its own log says
 * so in as many words:
 *
 *   [chrome-native-host] Creating Windows named pipe:
 *   \\.\pipe\claude-mcp-browser-bridge-User
 *
 * One fixed name, recreated on every start. That is also why a second host
 * instance logs the attempt and never logs success — the name is already taken.
 *
 * This file only knew the POSIX half. `readdir('/tmp/...')` on Windows fails
 * the way any missing directory fails, findSocket returned null, and every
 * chrome_* tool reported the extension as not running — on a machine where it
 * was running, with the pipe open, while the persona names those tools as the
 * first thing to reach for and tells the model not to quietly fall back to a
 * web search. The most useful capability in the bridge was dead on the platform
 * it was being used on, and it looked like a browser problem rather than a bug.
 *
 * Everything above this line is the same on both: the framing, the request
 * shape, the replies. Only the address differs.
 */
const BRIDGE_NAME = `claude-mcp-browser-bridge-${userInfo().username}`

/** POSIX: a directory of per-pid sockets. */
const SOCKET_DIR = `/tmp/${BRIDGE_NAME}`

/** Windows: one named pipe, in the kernel's pipe namespace. */
const WINDOWS_PIPE = `\\\\.\\pipe\\${BRIDGE_NAME}`

/**
 * How long a single browser action may take.
 *
 * Generous because these are real page loads on a real network, and the failure
 * we are avoiding is not a slow answer but a promise that never settles and
 * silently wedges the turn. A navigation to a heavy site genuinely can take
 * fifteen seconds; a screenshot of it takes a couple more.
 */
const CALL_TIMEOUT_MS = 45_000

/** Connecting to a socket on the same machine either works at once or is dead. */
const CONNECT_TIMEOUT_MS = 3_000

/** Said once, so both platforms report an absent extension identically. */
const NOT_RUNNING =
  'The Claude browser extension is not running on this machine. ' +
  'Open Chrome with the Claude extension enabled, then try again.'

/**
 * Dial failures that mean "nothing is listening" rather than "something broke".
 *
 * ENOENT is the pipe or socket file not being there at all. ECONNREFUSED is a
 * POSIX socket file left behind by a host that has since exited — the file
 * outlives the process, which is the whole reason findSocket sorts by mtime.
 */
const MISSING = new Set(['ENOENT', 'ECONNREFUSED'])

/**
 * Find the socket to talk to.
 *
 * The name carries the native host's pid, so it changes every time Chrome
 * restarts and the old file is left behind — picking the wrong one gives a
 * connection that opens successfully and then answers nothing, which is the
 * most confusing failure available. Newest by modification time is the live one.
 *
 * `0.sock` is deliberately deprioritised: it is a symlink some builds create
 * and then fail to update across a Chrome restart, so it is the single most
 * likely file here to be pointing at a host that no longer exists. It is still
 * accepted as a last resort, because on some setups it is all there is.
 */
async function findSocket() {
  /**
   * Windows has nothing to choose between.
   *
   * The name is fixed, so there is no newest-wins to do — and there is nothing
   * to stat either: a named pipe is a kernel object, not a file, so the pipe
   * namespace does not answer `readdir` or `stat` through Node's fs at all.
   * Handing the path back unconditionally is therefore right, and the question
   * "is anything actually listening?" moves to the one place that can answer it
   * honestly, which is the connection attempt itself.
   */
  if (process.platform === 'win32') return WINDOWS_PIPE

  let names
  try {
    names = await readdir(SOCKET_DIR)
  } catch {
    return null
  }
  const candidates = []
  for (const name of names) {
    if (!name.endsWith('.sock')) continue
    const path = join(SOCKET_DIR, name)
    try {
      const info = await stat(path)
      candidates.push({ path, at: info.mtimeMs, fallback: name === '0.sock' })
    } catch {
      /* vanished between readdir and stat — a restart mid-scan */
    }
  }
  if (!candidates.length) return null
  candidates.sort((a, b) => a.fallback - b.fallback || b.at - a.at)
  return candidates[0].path
}

/**
 * One connection, one request in flight.
 *
 * The wire protocol carries no request id — a reply is simply the next frame —
 * so two overlapping calls would be indistinguishable and the answers could be
 * handed to the wrong caller. Serialising is not a performance compromise here:
 * the browser is a single visible window doing one thing at a time, and the
 * model is watching each result before deciding the next action anyway.
 */
class ChromeLink {
  constructor() {
    this.socket = null
    this.path = null
    /** Tail of the current request chain, so calls queue rather than collide. */
    this.chain = Promise.resolve()
    /** Bytes received but not yet forming a whole frame. */
    this.buffer = Buffer.alloc(0)
    /** Resolver for the frame we are currently waiting on. */
    this.waiting = null
  }

  /** Drop the connection and forget it, so the next call re-discovers. */
  reset(err) {
    const pending = this.waiting
    this.waiting = null
    this.buffer = Buffer.alloc(0)
    if (this.socket) {
      this.socket.removeAllListeners()
      this.socket.destroy()
      this.socket = null
    }
    this.path = null
    if (pending) pending.reject(err ?? new Error('browser connection closed'))
  }

  /** Pull whole frames out of the byte stream and hand them to the waiter. */
  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    for (;;) {
      if (this.buffer.length < 4) return
      const length = this.buffer.readUInt32LE(0)
      // A frame larger than this is a desynchronised stream, not a big reply —
      // reading it would mean waiting for bytes that are never coming.
      if (length > 64 * 1024 * 1024) {
        this.reset(new Error('browser sent a malformed frame'))
        return
      }
      if (this.buffer.length < 4 + length) return
      const body = this.buffer.subarray(4, 4 + length)
      this.buffer = this.buffer.subarray(4 + length)
      const waiter = this.waiting
      if (!waiter) continue // unsolicited frame; nothing asked for it
      try {
        const reply = JSON.parse(body.toString('utf8'))
        // The native host broadcasts notifications on this same stream. Like
        // its SocketClient, only a result/error frame completes the request.
        if (!reply || typeof reply !== 'object' || typeof reply.method === 'string') continue
        if (!('result' in reply) && !('error' in reply)) continue
        this.waiting = null
        waiter.resolve(reply)
      } catch (err) {
        this.waiting = null
        waiter.reject(new Error(`unreadable reply from the browser: ${err.message}`))
      }
    }
  }

  async ensureConnected() {
    if (this.socket && !this.socket.destroyed) return
    const path = await findSocket()
    if (!path) throw new Error(NOT_RUNNING)

    await new Promise((resolve, reject) => {
      const socket = createConnection(path)
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new Error('the browser extension did not accept a connection'))
      }, CONNECT_TIMEOUT_MS)

      socket.once('connect', () => {
        clearTimeout(timer)
        this.socket = socket
        this.path = path
        socket.on('data', (chunk) => this.onData(chunk))
        // Both of these mean the same thing to us: whatever we were waiting for
        // is not coming, and the next call must dial again from scratch. The
        // native host dies with Chrome, so this fires on every browser restart.
        socket.on('error', (err) => this.reset(err))
        socket.on('close', () => this.reset(new Error('the browser disconnected')))
        resolve()
      })
      socket.once('error', (err) => {
        clearTimeout(timer)
        // On Windows this is where "not running" shows up, because there is no
        // directory to find empty first — the pipe either exists or the dial
        // returns ENOENT. Same sentence either way, so the model is told the
        // same thing on both platforms instead of one of them getting a raw
        // errno it cannot act on.
        reject(MISSING.has(err?.code) ? new Error(NOT_RUNNING) : err)
      })
    })
  }

  /** Send one framed message and wait for exactly one framed reply. */
  async request(message, { signal, onSend } = {}) {
    await this.ensureConnected()
    // A connection attempt can outlive the turn that requested the action.
    if (signal?.aborted) throw new Error('the user interrupted')
    const body = Buffer.from(JSON.stringify(message), 'utf8')
    const header = Buffer.alloc(4)
    header.writeUInt32LE(body.length, 0)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // A timed-out call leaves the stream ambiguous — a late reply would be
        // read as the answer to whatever runs next — so the connection goes
        // rather than being reused.
        this.reset(new Error('the browser did not answer in time'))
      }, CALL_TIMEOUT_MS)

      this.waiting = {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (err) => {
          clearTimeout(timer)
          reject(err)
        },
      }

      try {
        // Once a write begins, even an error cannot prove the peer did not act.
        onSend?.()
        this.socket.write(Buffer.concat([header, body]), (err) => {
          if (err) this.reset(err)
        })
      } catch (err) {
        this.reset(err)
      }
    })
  }

  /**
   * Run one extension tool. Queued behind whatever is already running.
   *
   * Reconnect once if dialing failed before any request was sent. After a write
   * begins, a timeout or disconnect has an unknown outcome: replaying a click
   * or typed text could perform the user's action twice.
   */
  call(name, args, signal) {
    const run = async () => {
      /**
       * Interrupted before this one's turn in the queue came up.
       *
       * Calls are serialised, so a batch can sit here for seconds behind
       * whatever is already talking to the browser. Running them anyway means
       * the user's real Chrome navigates somewhere they cancelled — and then
       * settle() polls the page they did not ask for.
       *
       * Checked here rather than only at the head, because the wire protocol
       * has no request id: a call already sent cannot be recalled without
       * desynchronising every reply after it. So one in flight is allowed to
       * finish and its answer is discarded upstream; one not yet sent is simply
       * never sent.
       */
      if (signal?.aborted) throw new Error('the user interrupted')

      const message = { method: 'execute_tool', params: { tool: name, args: args ?? {} } }
      for (let attempt = 0; ; attempt++) {
        let sent = false
        try {
          return await this.request(message, { signal, onSend: () => { sent = true } })
        } catch (err) {
          this.reset()
          if (signal?.aborted) throw err
          if (sent) {
            throw new Error(
              `${err?.message ?? err}. The browser action may have completed; ` +
                'inspect its current state before retrying.',
              { cause: err },
            )
          }
          if (attempt >= 1) throw err
        }
      }
    }
    // Chained on the tail whether or not the previous call succeeded, so one
    // failure cannot stall every later call behind a rejected promise.
    const result = this.chain.then(run, run)
    this.chain = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}

/**
 * Turn a native-host reply into an MCP result.
 *
 * The happy path already carries MCP-shaped content blocks — text and images,
 * exactly what the extension's own tools return — so those pass through
 * untouched rather than being stringified and re-parsed. Errors arrive as
 * `{ error: { content } }` and become an MCP error, which is what puts them in
 * front of the model as something to react to rather than as a silent nothing.
 */
function toResult(reply) {
  if (!reply || typeof reply !== 'object') {
    return { isError: true, content: [{ type: 'text', text: 'The browser returned nothing.' }] }
  }
  if (reply.error) {
    const detail = reply.error.content ?? reply.error.message ?? reply.error
    return {
      isError: true,
      content: [{ type: 'text', text: typeof detail === 'string' ? detail : JSON.stringify(detail) }],
    }
  }
  // A reply can be well-formed at the transport layer and still carry a refusal
  // from the tool itself: `{ result: { isError: true, content } }` is how a
  // permission denial arrives when the extension answers in MCP's own shape
  // rather than as `{ error }`. Dropped, it became a successful result carrying
  // the words "Permission denied" — which the model is free to read as progress.
  // Only a literal `true` counts, so a malformed `"false"` cannot promote itself
  // into an authoritative failure.
  const failed = reply.result?.isError === true ? { isError: true } : null
  const content = reply.result?.content
  if (Array.isArray(content)) return { ...failed, content: clean(content) }
  if (typeof content === 'string') return { ...failed, content: [{ type: 'text', text: content }] }
  return { ...failed, content: [{ type: 'text', text: JSON.stringify(reply.result ?? reply) }] }
}

/**
 * Translate an image block from the Anthropic wire format into the MCP one.
 *
 * The extension answers a screenshot with the shape the Messages API uses —
 * `{ type: 'image', source: { type: 'base64', media_type, data } }` — because
 * that is what its own caller feeds straight back to the model. MCP wants the
 * flatter `{ type: 'image', data, mimeType }`, and the Agent SDK validates it:
 * a block carrying neither `data` nor `mimeType` is rejected outright.
 *
 * The result was a screenshot that took a perfectly good picture and then
 * failed, with an error about malformed data that pointed at the page rather
 * than at the two field names between it and working. Both shapes are accepted
 * here, because being liberal about which one arrives costs nothing and this is
 * a private protocol that is free to change again.
 */
function normaliseImage(block) {
  if (typeof block?.data === 'string' && block.mimeType) return block
  const src = block?.source
  if (src && typeof src.data === 'string') {
    return {
      type: 'image',
      data: src.data,
      mimeType: src.media_type ?? src.mimeType ?? 'image/png',
    }
  }
  // Not an image we can hand on. Say so as text rather than passing through a
  // block the SDK will reject — a described failure beats a rejected turn.
  return {
    type: 'text',
    text: 'The browser returned an image in a form this bridge could not read.',
  }
}

/**
 * Strip the extension's own coaching out of its results.
 *
 * Every reply carries a <system-reminder> urging the caller to batch its next
 * actions through `browser_batch`. That advice is addressed to Claude Code's
 * browser harness, not to this one — we deliberately expose a narrower, named
 * set of tools so the permission gate can reason about them, and `browser_batch`
 * is not among them. Left in, it is an instruction arriving through a tool
 * result telling the model to call something that does not exist, which costs a
 * failed tool call and a confused turn every single time.
 *
 * More generally: what comes back from here is data about a web page the user
 * asked about, and text inside it does not get to direct the assistant.
 */
function clean(content) {
  const stripped = content
    .map((block) => {
      if (block?.type === 'image') return normaliseImage(block)
      if (block?.type !== 'text' || typeof block.text !== 'string') return block
      const text = block.text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
      return text ? { ...block, text } : null
    })
    .filter(Boolean)
  // Never hand back an empty result: a tool that returns nothing at all reads
  // to the model as a tool that failed silently.
  return stripped.length ? stripped : [{ type: 'text', text: 'Done.' }]
}

/** Pull a usable tabId out of a tabs_context reply. */
function readTab(reply) {
  const blocks = reply?.result?.content
  if (!Array.isArray(blocks)) return null
  for (const block of blocks) {
    if (block?.type !== 'text' || typeof block.text !== 'string') continue
    // The first block is JSON; the ones after it are the same thing in prose.
    try {
      const parsed = JSON.parse(block.text)
      const tab = parsed?.availableTabs?.[0]?.tabId
      if (typeof tab === 'number') return tab
    } catch {
      const m = /"?tabId"?[:\s]+(\d{3,})/.exec(block.text)
      if (m) return Number(m[1])
    }
  }
  return null
}

/** Read the created tab's identity, never the first older available tab. */
function readCreatedTab(content) {
  if (!Array.isArray(content)) return null
  let executedOn = null
  for (const block of content) {
    if (block?.type !== 'text' || typeof block.text !== 'string') continue
    try {
      const tab = JSON.parse(block.text)?.tabId
      if (Number.isSafeInteger(tab) && tab >= 0) return tab
    } catch { /* The extension also returns its created-tab ID in prose. */ }
    const created = /^Created new tab\. Tab ID:\s*(\d+)\b/m.exec(block.text)
    if (created && Number.isSafeInteger(Number(created[1]))) return Number(created[1])
    const context = /^\s*-\s*Executed on tabId:\s*(\d+)\b/m.exec(block.text)
    if (context && Number.isSafeInteger(Number(context[1]))) executedOn = Number(context[1])
  }
  return executedOn
}

/**
 * Wait until the tab is actually showing the page we asked for.
 *
 * `navigate` returns as soon as the navigation is *accepted*, not when the
 * document is ready — and, worse, the tab context it hands back reports the new
 * URL immediately while the page underneath is still the old one. So the
 * obvious check is the one that does not work: the URL agrees with you while
 * the content lies. Measured, reading straight after a navigate returned the
 * previous page in full, which for a voice assistant means confidently
 * answering a question about the wrong article.
 *
 * The reliable signal is the reader's own view of where it is: get_page_text
 * prints a `URL:` line describing the document it actually parsed. When that
 * line agrees with the target, the page really has landed.
 */
/**
 * ...but the target is the wrong thing to wait for.
 *
 * `navigate` follows redirects, so the URL the model asked for is frequently
 * not the URL that lands: a shortener from a tool result, a locale redirect
 * (ikea.com -> ikea.com/gb/en/), a consent or login wall. Waiting for the
 * document to report the *requested* address means waiting for something that
 * is never going to happen, and the old loop then ran all sixteen polls before
 * returning — with no signal that it had given up rather than matched.
 *
 * That is not an edge case, it is most links, and the cost is paid on the
 * success path: about six and a half seconds of sleeps plus sixteen round trips
 * to the extension, during which the persona is under instruction to go silent
 * while using a tool. The interface simply stops for seven seconds on a
 * navigation that worked immediately. And because every poll goes through the
 * shared request chain, the browser is unavailable to anything else throughout.
 *
 * So the question changes from "is this the page I asked for" to "has the page
 * stopped changing". Landing on the target is kept as a fast exit because it is
 * the common case and it is unambiguous; otherwise two consecutive polls
 * reporting the same URL means the redirects have finished. The gap grows, so a
 * page that settles at once costs one short poll rather than a fixed tax, and
 * the whole thing is capped in wall-clock rather than in attempts.
 */
const SETTLE_GAP_MS = 120
const SETTLE_MAX_GAP_MS = 500
const SETTLE_BUDGET_MS = 3_000

/** Same page? Compared on origin + path, since fragments and trailing slashes
 *  differ freely between what you ask for and what you get. */
function samePage(a, b) {
  try {
    const x = new URL(a)
    const y = new URL(b)
    return (
      x.host.replace(/^www\./, '') === y.host.replace(/^www\./, '') &&
      x.pathname.replace(/\/$/, '') === y.pathname.replace(/\/$/, '')
    )
  } catch {
    return false
  }
}

/**
 * One browser session per connection.
 *
 * The link and the remembered tab used to live at module scope, and they were
 * the only per-socket state in this bridge that did — server.mjs builds the
 * other three kits inside `wss.on('connection')` precisely so that each socket
 * gets its own. This one was shared, and outlived every socket that used it.
 *
 * What that costs: reload the page mid-turn and the old connection's Claude
 * pump can still be running, still holding the request chain. The new
 * connection builds fresh kits and is handed the same link and the same
 * `activeTab` — so the next question queues behind the abandoned turn's polling
 * and then answers about the page that turn navigated to, not the one in front
 * of the user. `chrome_new_tab` from either connection blanked the other's tab
 * pointer; `chrome_close_tab` cleared it by comparing against the other's id.
 *
 * Per connection now, which is also what makes the tab pointer honest: it means
 * "the tab this conversation is working in" rather than "the last tab anyone
 * touched".
 */
function browserSession() {
  const link = new ChromeLink()

  /**
   * The tab JARVIS is working in.
   *
   * Remembered here rather than threaded through the model, because making the
   * model carry it is both unreliable and pointless. Unreliable: it is a
   * ten-digit integer that has to survive being read out of one tool result and
   * written into the next, and the failure mode when it does not is the useless
   * "No tab available". Pointless: there is one visible browser window and the
   * user is looking at it — "the tab" is not ambiguous to anybody except the
   * protocol.
   *
   * Cleared when the extension says this tab is gone. The failed action is
   * returned to the caller so it can recover without acting on a different tab.
   */
  let activeTab = null

  /** The tab to act on: the one named, the one we remember, or a fresh one. */
  async function resolveTab(given) {
    if (given !== undefined && given !== null && `${given}`.trim() !== '') {
      const asked = Number(given)
      if (Number.isFinite(asked)) return asked
    }
    if (activeTab !== null) return activeTab
    const reply = await link.call('tabs_context_mcp', { createIfEmpty: true })
    activeTab = readTab(reply)
    return activeTab
  }

  async function settle(tab, target, signal) {
  const deadline = Date.now() + SETTLE_BUDGET_MS
  let gap = SETTLE_GAP_MS
  let previous = null

  while (Date.now() < deadline) {
    if (signal?.aborted) return
    let reply
    try {
      reply = await link.call('get_page_text', { tabId: tab, max_chars: 200 }, signal)
    } catch {
      return // the browser went away; the caller's own error path will say so
    }
    const blocks = reply?.result?.content
    const text = Array.isArray(blocks)
      ? blocks.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('\n')
      : ''
    const at = /^URL:\s*(\S+)/m.exec(text)?.[1] ?? null

    // Arrived where we were aimed. Unambiguous, and the common case.
    if (at && samePage(at, target)) return
    // Or arrived somewhere and stayed there: the redirects are done. Requires
    // two readings, because the first poll can catch the document mid-hop and
    // one sighting of an address proves nothing about whether it is final.
    if (at && previous && samePage(at, previous)) return
    previous = at

    await new Promise((r) => setTimeout(r, gap))
    gap = Math.min(gap * 2, SETTLE_MAX_GAP_MS)
  }
  }

/**
 * Every tool here is the same two lines; only the name and the schema differ.
 *
 * `needsTab` is false only for the handful that address the browser rather than
 * a page — listing tabs, opening one — which are also the ones that would
 * deadlock if resolving a tab called them.
 */
  function forward(name, { needsTab = true } = {}) {
  return async (args, extra) => {
    const signal = extra?.signal
    try {
      let sent = args ?? {}
      if (needsTab) {
        const tab = await resolveTab(sent.tabId)
        sent = tab === null ? sent : { ...sent, tabId: tab }
      }
      const reply = await link.call(name, sent, signal)
      // A ref, focused field or explicit tab belongs to this target. Never
      // replay its action on another tab just because this one disappeared.
      if (needsTab && reply?.error && /no tab available/i.test(JSON.stringify(reply.error))) {
        if (sent.tabId === activeTab) activeTab = null
      }
      return toResult(reply)
    } catch (err) {
      // Plainly worded because it may well be spoken. The model is told what to
      // do about it, since it is the only one that can act.
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text:
              `Could not reach the browser: ${err?.message ?? err}. ` +
              'Tell the user their browser is not available and carry on without it.',
          },
        ],
      }
    }
  }
  }

  return {
    link,
    forward,
    settle,
    resolveTab,
    /** Remember a successful creation, clearing the old target if no ID came back. */
    rememberCreatedTab: (content) => {
      activeTab = readCreatedTab(content)
    },
    /** The current tab was closed, so stop steering it. */
    forgetTab: () => {
      activeTab = null
    },
    /** Was this the tab we were working in? Asked before closing one. */
    isActiveTab: (id) => Number(id) === activeTab,
  }
}

// ---------------------------------------------------------------------------
// Schemas
//
// Loose in the same way ui.mjs is loose, and for the same reason: a turn that
// fails because a coordinate arrived as a string is a turn the user watched
// break. Anything the extension will tolerate, we pass along.
// ---------------------------------------------------------------------------

/**
 * Which tab to act on.
 *
 * Numeric, and the extension means it: these ids are large integers and a
 * string form is not accepted. It is also not optional in the way an
 * ergonomically designed API would make it — omit it and every acting tool
 * answers "No tab available", including immediately after a tab group has been
 * created. Both facts were learned the way facts about undocumented protocols
 * usually are.
 *
 * So the schema says "optional" and means it, but the optionality is provided
 * by us rather than by the extension: see resolveTab. The model is free to name
 * a tab when it has a reason to, and free to ignore the concept entirely when
 * it does not, which is most of the time.
 */
const tabId = z
  .union([z.number(), z.string()])
  .optional()
  .catch(undefined)
  .describe(
    'Which tab to act on — a numeric tabId from chrome_tabs. Omit it and the ' +
      'tab JARVIS is already working in is used, opening one if there is none.',
  )

const NAVIGATE_DESCRIPTION = `Open a URL in the user's own Chrome.

This is their real browser, so every site they are signed in to is already
signed in — mail, calendar, dashboards, anything behind a login. That is the
whole reason to use this rather than fetching a page yourself.

Use it when the answer lives behind a login, when a page has to be *seen*, or
when the user says to open something. For a public page you only need to read,
searching or fetching is faster and does not disturb what is on their screen.

Opening a page is visible to the user — a tab appears and loads in front of
them. Do not open things speculatively.`

const READ_PAGE_DESCRIPTION = `Read the structure of the current page as an accessibility tree.

Every interactive element comes back tagged [ref_N], and those refs are what
chrome_click and chrome_form_input take. So this is the tool you call before
acting on a page, and the reliable way to find out what is actually on it.

Prefer this over a screenshot when you want to know what a page says or what can
be clicked. Use chrome_page_text instead when you only want the prose.`

/**
 * @param {{ allowWrites: boolean }} options
 */
export function chromeKit({ allowWrites }) {
  // This connection's own browser session. Built here, with the kit, so it
  // lives exactly as long as the socket that is using it.
  const { forward, settle, resolveTab, rememberCreatedTab, forgetTab, isActiveTab } = browserSession()

  const tools = [
    tool(
      'chrome_status',
      'Check whether the user\'s browser is reachable, and which tabs exist. ' +
        'Call this first if a browser action has just failed, so you can tell ' +
        'the user whether the problem is the browser or the page.',
      {},
      async (_args, extra) => {
        const path = await findSocket()
        if (!path) {
          return {
            content: [
              {
                type: 'text',
                text:
                  'The browser extension is not running. Chrome may be closed, ' +
                  'or the Claude extension may be disabled.',
              },
            ],
          }
        }
        return forward('tabs_context_mcp', { needsTab: false })({ createIfEmpty: false }, extra)
      },
    ),

    tool(
      'chrome_tabs',
      'List the browser tabs JARVIS can act on, with their origins. Origins ' +
        'only — page titles are written by the page and are not trustworthy.',
      {
        createIfEmpty: z
          .boolean()
          .optional()
          .catch(undefined)
          .describe('Open a fresh tab if there is nothing to act on yet. Default false.'),
      },
      forward('tabs_context_mcp', { needsTab: false }),
    ),

    tool(
      'chrome_navigate',
      NAVIGATE_DESCRIPTION,
      {
        url: z
          .string()
          .describe('Absolute URL, or "back" / "forward" to move through history.'),
        tabId,
      },
      async (args, extra) => {
        const out = await forward('navigate')(args, extra)
        if (out.isError) return out
        // Do not hand back until the page is really there. Everything the model
        // does next — reading it, screenshotting it, answering about it — is
        // wrong if it runs against the document this one replaced.
        const url = String(args.url ?? '')
        if (/^https?:\/\//i.test(url)) {
          await settle(await resolveTab(args.tabId), url, extra?.signal)
        } else if (!extra?.signal?.aborted) {
          // back / forward: no target to compare against, so just let it breathe.
          await new Promise((r) => setTimeout(r, 700))
        }
        return out
      },
    ),

    tool(
      'chrome_read_page',
      READ_PAGE_DESCRIPTION,
      {
        tabId,
        filter: z
          .enum(['interactive', 'all'])
          .optional()
          .catch(undefined)
          .describe('interactive = only things that can be clicked or typed into.'),
        max_chars: z
          .union([z.number(), z.string()])
          .optional()
          .catch(undefined)
          .describe('Cap the tree size. Large pages are worth capping.'),
      },
      forward('read_page'),
    ),

    tool(
      'chrome_page_text',
      'Get the visible text of the current page — the article, the message, ' +
        'the readout. This is the fastest way to answer "what does it say".',
      {
        tabId,
        max_chars: z.union([z.number(), z.string()]).optional().catch(undefined),
      },
      forward('get_page_text'),
    ),

    tool(
      'chrome_find',
      'Find an element by describing it in plain words, e.g. "the search box". ' +
        'This one runs a model inside the extension, so some Claude accounts ' +
        'cannot use it at all and it fails with a permission error. When that ' +
        'happens do not retry it — use chrome_read_page, which returns the same ' +
        'refs by reading the page directly and always works.',
      {
        query: z.string().describe('What to look for, described naturally.'),
        tabId,
      },
      forward('find'),
    ),

    tool(
      'chrome_screenshot',
      'Take a picture of what is on the page right now. Use it when the ' +
        'answer is visual, or when the user asks what something looks like — ' +
        'and put the result on the display rather than describing it.',
      { tabId },
      // `action` after the spread, not before it. The schema strips an `action`
      // a caller supplies, so this is the second lock rather than the only one
      // — but a screenshot is a read and runs in read-only mode, so if the
      // first lock ever slipped, the tool that escalated to `left_click` in the
      // user's signed-in browser would be this one.
      async (args, extra) => forward('computer')({ ...args, action: 'screenshot' }, extra),
    ),

    tool(
      'chrome_scroll',
      'Scroll the page to bring more of it into view. A read that happens to ' +
        'move the page, not an action on it.',
      {
        direction: z.enum(['up', 'down', 'left', 'right']).catch('down'),
        amount: z.union([z.number(), z.string()]).optional().catch(undefined),
        tabId,
      },
      async (args, extra) =>
        forward('computer')(
          {
            action: 'scroll',
            scroll_direction: args.direction ?? 'down',
            scroll_amount: args.amount ?? 3,
            coordinate: [400, 400],
            tabId: args.tabId,
          },
          extra,
        ),
    ),

    tool(
      'chrome_console',
      'Read console output from the page. For diagnosing a site that is ' +
        'misbehaving, not for ordinary browsing.',
      {
        tabId,
        onlyErrors: z.boolean().optional().catch(undefined),
        limit: z.union([z.number(), z.string()]).optional().catch(undefined),
      },
      forward('read_console_messages'),
    ),

    tool(
      'chrome_network',
      'List network requests the page made, or fetch one response body by id.',
      {
        tabId,
        urlPattern: z.string().optional().catch(undefined),
        requestId: z.string().optional().catch(undefined),
        limit: z.union([z.number(), z.string()]).optional().catch(undefined),
      },
      forward('read_network_requests'),
    ),
  ]

  /**
   * The acting half.
   *
   * These are withheld by default, and the reason is specific to what this
   * server is: it is pointed at a browser that is signed in to the user's mail,
   * their bank and their employer. A misheard sentence that merely reads a page
   * is a wasted turn; a misheard sentence that clicks a button on a page that
   * is already authenticated is something else. The gate is the same one the
   * rest of the bridge uses, so a user who has decided to trust it turns both
   * on together.
   */
  if (allowWrites) {
    tools.push(
      tool(
        'chrome_click',
        'Click something on the page. Take the ref from chrome_read_page or ' +
          'chrome_find rather than guessing coordinates. Say what you are ' +
          'about to do before doing anything irreversible.',
        {
          ref: z.string().optional().catch(undefined).describe('A ref_N from chrome_read_page.'),
          coordinate: z
            .array(z.number())
            .optional()
            .catch(undefined)
            .describe('[x, y] fallback when there is no ref.'),
          tabId,
        },
        async (args, extra) => forward('computer')({ ...args, action: 'left_click' }, extra),
      ),

      tool(
        'chrome_type',
        'Type text into whatever is focused. Click the field first.',
        { text: z.string(), tabId },
        async (args, extra) => forward('computer')({ ...args, action: 'type' }, extra),
      ),

      tool(
        'chrome_key',
        'Press a key or chord, e.g. "Return", "Escape", "cmd+a".',
        { text: z.string().describe('The key to press.'), tabId },
        async (args, extra) => forward('computer')({ ...args, action: 'key' }, extra),
      ),

      tool(
        'chrome_form_input',
        'Set the value of a form field directly — more reliable than typing ' +
          'for selects, checkboxes and long values.',
        {
          ref: z.string().describe('A ref_N from chrome_read_page.'),
          value: z.union([z.string(), z.number(), z.boolean()]),
          tabId,
        },
        forward('form_input'),
      ),

      tool(
        'chrome_new_tab',
        'Open a fresh blank tab and work in it from now on.',
        {},
        async (args, extra) => {
          const out = await forward('tabs_create_mcp', { needsTab: false })(args, extra)
          // Whatever was just opened is what the next action should land in.
          if (!out.isError) rememberCreatedTab(out.content)
          return out
        },
      ),

      tool(
        'chrome_close_tab',
        'Close a tab by id.',
        {
          tabId: z
            .union([z.number(), z.string()])
            .describe('The numeric tabId to close, from chrome_tabs.'),
        },
        async (args, extra) => {
          const out = await forward('tabs_close_mcp', { needsTab: false })(args, extra)
          // Only a confirmed close retires the target. A denied one leaves the
          // tab open and in front of the user, so forgetting it sent the next
          // omitted-tab action off to whatever unrelated tab context listed
          // first — acting on a page nobody asked about, immediately after the
          // user refused a far smaller thing.
          if (!out.isError && isActiveTab(args.tabId)) forgetTab()
          return out
        },
      ),
    )
  }

  return defineTools({
    name: 'jarvis_chrome',
    version: '1.0.0',
    instructions:
      "The user's own Chrome, already signed in to everything they use. " +
      'Reach for it when the answer is behind a login or has to be seen on a ' +
      'real page. Reading is free; acting on a page is not, so say what you ' +
      'are doing before you do anything that changes something.',
    // Behind tool search the model would never think to look, and "open my
    // GitHub notifications" would quietly become a web search instead.
    alwaysLoad: true,
    tools,
  })
}

/**
 * Whether the extension looks reachable, for the boot log.
 *
 * A real dial, not a file test. It has to be on Windows, where findSocket
 * always returns a path because the pipe namespace cannot be inspected — a file
 * test there would report the browser ready on a machine with Chrome closed.
 *
 * It is also the better answer on POSIX, where the old check was satisfied by
 * any `.sock` file in the directory. Those outlive the process that made them,
 * so a machine that had Chrome open yesterday reported browser control ready
 * today, and the first tool call was the thing that discovered otherwise. The
 * banner exists to say what is true before anybody asks a question that depends
 * on it, which means it has to be true.
 *
 * Opened and dropped immediately: the link keeps its own connection, and this
 * is only ever asked once at boot.
 */
export async function chromeAvailable() {
  const path = await findSocket()
  if (!path) return false

  return new Promise((resolve) => {
    const socket = createConnection(path)
    const settle = (ok) => {
      clearTimeout(timer)
      socket.removeAllListeners()
      socket.destroy()
      resolve(ok)
    }
    const timer = setTimeout(() => settle(false), CONNECT_TIMEOUT_MS)
    socket.once('connect', () => settle(true))
    socket.once('error', () => settle(false))
  })
}
