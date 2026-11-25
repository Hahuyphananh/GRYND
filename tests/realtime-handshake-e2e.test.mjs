// tests/realtime-handshake-e2e.test.mjs
//
// The realtime handshake, end to end, from the origin the browser reports.
//
// This boots the REAL `realtime-server/server.js` (express + Socket.IO + CORS +
// guest auth) and speaks to it the way a browser on the www host does: every
// engine.io request carries `Origin: https://www.grynd.dedyn.io`, and the
// handshake carries the guest session cookie. The server is configured with the
// APEX in `CLIENT_URL` — the exact production mismatch — so a pass proves the
// www origin is not just allowed by the allow-list but can carry a complete
// engine.io handshake, a namespace connect and a delivered event.
//
// The polling transport is driven directly over `node:http` rather than through
// `socket.io-client` because Node's fetch/engine.io client treats `Cookie` as a
// forbidden header and silently drops it; `http.request` sends it, which is
// what a browser does.
//
// Run: node --import tsx --test tests/realtime-handshake-e2e.test.mjs

import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverEntry = path.join(root, "realtime-server", "server.js");

const WWW = "https://www.grynd.dedyn.io";
const APEX = "https://grynd.dedyn.io";
const GUEST_SECRET = "realtime-handshake-test-secret";
const GUEST_ID = `guest_${"0123456789abcdef".repeat(2)}`;
const GUEST_COOKIE = `grynd_guest=${GUEST_ID}.${createHmac("sha256", GUEST_SECRET)
  .update(GUEST_ID)
  .digest("base64url")}`;

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function waitForHealth(base, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return await res.json();
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("realtime server did not become healthy");
}

let child;
let base;
let health;

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [serverEntry], {
    cwd: path.join(root, "realtime-server"),
    env: {
      ...process.env,
      PORT: String(port),
      // The mismatched pair from production: the app is on www, the env says apex.
      CLIENT_URL: APEX,
      GUEST_SESSION_SECRET: GUEST_SECRET,
      REALTIME_INTERNAL_SECRET: "realtime-handshake-test-internal",
      // Keep the background sweeps from hitting a real Next.js server.
      NEXTJS_INTERNAL_URL: "http://127.0.0.1:9",
      NODE_ENV: "test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (chunk) => {
    logs += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    logs += String(chunk);
  });
  child.once("exit", (code) => {
    if (code !== 0 && code !== null) {
      console.error(`[realtime test] server exited (${code})\n${logs}`);
    }
  });
  health = await waitForHealth(base);
});

after(() => {
  child?.kill();
});

/** One engine.io HTTP round-trip, with real request headers. */
function engineRequest(pathname, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}${pathname}`, { method, headers }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

const socketHeaders = (origin) => ({
  Origin: origin,
  Cookie: GUEST_COOKIE,
});

test("the allow-list carries both spellings of the configured host", () => {
  assert.equal(health.ok, true);
  assert.ok(health.allowedOrigins.includes(APEX), `missing ${APEX}`);
  assert.ok(health.allowedOrigins.includes(WWW), `missing ${WWW}`);
});

test("the www origin completes the engine.io polling handshake", async () => {
  const res = await fetch(`${base}/socket.io/?EIO=4&transport=polling`, {
    headers: { Origin: WWW },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), WWW);
  assert.equal(res.headers.get("access-control-allow-credentials"), "true");

  const body = await res.text();
  assert.match(body, /^0\{/, "engine.io OPEN packet expected");
  const packet = JSON.parse(body.slice(1));
  assert.ok(packet.sid, "handshake must carry a session id");
  assert.ok(Array.isArray(packet.upgrades), "handshake must advertise transports");
});

test("the CORS preflight from www is answered for the socket path", async () => {
  const res = await fetch(`${base}/socket.io/?EIO=4&transport=polling`, {
    method: "OPTIONS",
    headers: {
      Origin: WWW,
      "Access-Control-Request-Method": "GET",
    },
  });
  assert.ok(res.status === 204 || res.status === 200, `unexpected ${res.status}`);
  assert.equal(res.headers.get("access-control-allow-origin"), WWW);
});

test("an unlisted origin cannot even open the polling handshake", async () => {
  const res = await fetch(`${base}/socket.io/?EIO=4&transport=polling`, {
    headers: { Origin: "https://evil.example" },
  });
  assert.notEqual(res.headers.get("access-control-allow-origin"), "https://evil.example");
  // The server either rejects outright or answers without an allow header —
  // either way the browser drops the response, which is the point.
  assert.ok([200, 400, 403, 500].includes(res.status), `unexpected ${res.status}`);
});

test("a guest socket connects from the www origin and receives server:hello", async () => {
  const open = await engineRequest("/socket.io/?EIO=4&transport=polling", {
    headers: socketHeaders(WWW),
  });
  assert.equal(open.status, 200);
  assert.equal(open.headers["access-control-allow-origin"], WWW);
  const sid = JSON.parse(open.body.slice(1)).sid;
  assert.ok(sid);

  // Socket.IO CONNECT packet for the default namespace.
  const connect = await engineRequest(`/socket.io/?EIO=4&transport=polling&sid=${sid}`, {
    method: "POST",
    headers: {
      ...socketHeaders(WWW),
      "Content-Type": "text/plain;charset=UTF-8",
    },
    body: "40",
  });
  assert.equal(connect.status, 200);
  assert.equal(connect.body, "ok");

  const poll = await engineRequest(`/socket.io/?EIO=4&transport=polling&sid=${sid}`, {
    headers: socketHeaders(WWW),
  });
  assert.equal(poll.status, 200);
  assert.match(poll.body, /40\{/, "the namespace must acknowledge the connection");
  assert.match(poll.body, /server:hello/, "the server's first event must be delivered");
  assert.ok(
    poll.body.includes(GUEST_ID),
    `server:hello must carry the cookie's guest identity, got: ${poll.body}`,
  );
});
