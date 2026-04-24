#!/usr/bin/env node
/**
 * E2E test for ted IRC bridge.
 *
 * Usage:
 *   node e2e/irc-e2e.mjs                    # run via railway ssh
 *   node e2e/irc-e2e.mjs --message "hi"     # custom message
 *   node e2e/irc-e2e.mjs --timeout 90       # custom timeout in seconds
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const args = process.argv.slice(2);
const msgIdx = args.indexOf('--message');
const message = msgIdx >= 0 ? args[msgIdx + 1] : 'what is 2+2?';
const timeoutIdx = args.indexOf('--timeout');
const timeoutSec = timeoutIdx >= 0 ? Number(args[timeoutIdx + 1]) : 60;

// The node script that runs inside the Railway container.
// It connects to IRC, sends a message, captures the response, and prints JSON.
const remoteScript = `
const net = require("net");
const nick = "e2e" + Math.random().toString(36).slice(2, 6);
const msg = ${JSON.stringify(message)};
const ch = "#ted";
const tms = ${timeoutSec * 1000};

const s = net.createConnection(6667, "docker.railway.internal", () => {
  s.write("NICK " + nick + "\\r\\n");
  s.write("USER " + nick + " 0 * :e2e\\r\\n");
});

let buf = "", reg = false, res = [];
const tm = setTimeout(() => { s.write("QUIT\\r\\n"); s.destroy(); done(); }, tms);

function done() {
  clearTimeout(tm);
  const f = res.join(" ");
  const o = { sent: msg, response: f || null, checks: {} };
  if (!f) { o.checks.responded = "FAIL"; }
  else {
    o.checks.responded = "PASS";
    o.checks.no_markdown = /\\*\\*|##/.test(f) ? "FAIL" : "PASS";
    o.checks.reasonable_length = f.length < 500 ? "PASS" : "FAIL (" + f.length + " chars)";
  }
  console.log(JSON.stringify(o));
  process.exit(0);
}

s.on("data", d => {
  const t = d.toString();
  buf += t;
  for (const l of t.split("\\r\\n")) {
    if (l.includes("PING")) {
      const m = l.match(/PING :?(\\S+)/);
      if (m) s.write("PONG :" + m[1] + "\\r\\n");
    }
    if (l.includes("PRIVMSG " + ch) && /^:ted-bot/.test(l)) {
      const mg = l.split("PRIVMSG " + ch + " :")[1];
      if (mg) { res.push(mg); process.stderr.write("[ted] " + mg + "\\n"); }
    }
  }
  if (!reg && (buf.includes("376") || buf.includes("422"))) {
    reg = true;
    s.write("JOIN " + ch + "\\r\\n");
    setTimeout(() => {
      process.stderr.write(">>> " + msg + "\\n");
      s.write("PRIVMSG " + ch + " :" + msg + "\\r\\n");
    }, 2000);
    let gf = false;
    const ci = setInterval(() => {
      if (res.length > 0 && !gf) {
        gf = true;
        setTimeout(() => {
          clearInterval(ci);
          clearTimeout(tm);
          s.write("QUIT\\r\\n");
          setTimeout(done, 500);
        }, 5000);
      }
    }, 500);
  }
});
s.on("error", e => { clearTimeout(tm); console.log(JSON.stringify({ error: e.message })); process.exit(1); });
`;

console.log('=== IRC E2E Test ===');
console.log(`Message: "${message}"`);
console.log(`Timeout: ${timeoutSec}s`);
console.log('');

try {
  // Write the script to a temp file, copy it into the container, run it
  const b64 = Buffer.from(remoteScript).toString('base64');
  const cmd = `echo '${b64}' | base64 -d > /tmp/e2e.js && node /tmp/e2e.js`;
  const output = execSync(
    `railway ssh -s ted-irc-bridge -- '${cmd}' 2>&1`,
    { timeout: (timeoutSec + 20) * 1000, encoding: 'utf8' },
  );

  // The output may contain stderr lines (prefixed with >>> or [ted]) before the JSON line
  const lines = output.trim().split('\n');
  for (const l of lines) {
    if (!l.startsWith('{')) console.log(`  ${l}`);
  }
  const jsonLine = lines.findLast(l => l.startsWith('{'));
  if (!jsonLine) throw new Error('No JSON output from remote script');
  const results = JSON.parse(jsonLine);
  console.log('');
  console.log('=== Results ===');
  console.log(`Sent: ${results.sent}`);
  console.log(`Response: ${results.response ?? '(none)'}`);
  console.log('');
  const checks = results.checks || {};
  let allPass = true;
  for (const [name, status] of Object.entries(checks)) {
    const pass = String(status).startsWith('PASS');
    if (!pass) allPass = false;
    console.log(`  ${pass ? 'PASS' : 'FAIL'} ${name}: ${status}`);
  }
  console.log('');
  console.log(allPass ? 'ALL CHECKS PASSED' : 'SOME CHECKS FAILED');
  process.exit(allPass ? 0 : 1);
} catch (err) {
  console.error('E2E test error:', err.message);
  process.exit(1);
}
