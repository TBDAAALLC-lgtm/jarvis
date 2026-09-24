import http from 'node:http'

/**
 * A page to prove the browser tools actually work.
 *
 * Written by Codex while verifying `--browser-writes`, and kept because the
 * thing it tests cannot be tested any other way. `chrome_click` and
 * `chrome_type` reach through the extension into a real Chrome, so a unit test
 * can prove the tool is *offered* — browser-policy.test.mjs does exactly that —
 * and can prove nothing at all about whether a click lands.
 *
 * Every alternative target is worse. A real site makes the test depend on
 * someone else's markup, their uptime and their bot detection, and it tells
 * that site a machine is poking at it. This page changes one string when, and
 * only when, a click arrives after the right text was typed:
 *
 *   type "JARVIS_CHROME_TEST" into #message, click #verify
 *   → #result reads CHROME_ACTION_OK
 *
 * So the assertion is unambiguous. Reading alone cannot produce that string,
 * and neither can typing alone; only the full read-type-click round trip does.
 *
 * Loopback only, no dependencies, no state, nothing cached, and nothing leaves
 * the machine. Run it, point JARVIS at http://localhost:5185, and stop it when
 * you are done:
 *
 *   npm run fixture:chrome
 *
 * PORT exists so a second copy can run while one is already up — the usual
 * case being that somebody is mid-test on the default and you want your own.
 */

const PORT = Number(process.env.PORT ?? 5185)

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Jarvis Chrome integration check</title></head>
<body><main><h1>Jarvis Chrome integration check</h1><p>This temporary local page verifies browser reading, typing, and clicking. Nothing is submitted externally.</p>
<label for="message">Test message</label><input id="message" autocomplete="off"><button id="verify">Verify integration</button><output id="result" aria-live="polite">Waiting for check</output>
<script>document.getElementById('verify').addEventListener('click',()=>{document.getElementById('result').textContent=document.getElementById('message').value==='JARVIS_CHROME_TEST'?'CHROME_ACTION_OK':'Enter the test message first'});</script></main></body></html>`

http
  .createServer((req, res) => {
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      // Never cached: the point of a fixture is that every run sees the page
      // as it is now, not as it was when something last worked.
      'cache-control': 'no-store',
    })
    res.end(html)
  })
  // 127.0.0.1 rather than the default wildcard. A test page that answers the
  // whole network is a test page somebody else can reach.
  .listen(PORT, '127.0.0.1', () =>
    console.log(`browser integration fixture ready on http://localhost:${PORT}`),
  )
