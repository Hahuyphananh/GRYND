// tests/socket-url-origin.test.mjs
//
// The socket client must dial the host the page is actually served from.
//
// Production answers on both `grynd.dedyn.io` and `www.grynd.dedyn.io`; when
// the page is on www and the client dials the apex, the handshake becomes a
// cross-origin request ("No 'Access-Control-Allow-Origin' header is present").
// These tests pin the resolution rules and that src/lib/socket.ts uses them.
//
// Run: node --import tsx --test tests/socket-url-origin.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolveSocketUrl } from "../src/lib/socketUrl.ts";

const WWW = "https://www.grynd.dedyn.io";
const APEX = "https://grynd.dedyn.io";

test("a www page dials www even when the env names the apex", () => {
  assert.equal(resolveSocketUrl(APEX, WWW), WWW);
  assert.equal(resolveSocketUrl(`${APEX}/`, WWW), WWW);
});

test("an apex page dials the apex when the env names www", () => {
  assert.equal(resolveSocketUrl(WWW, APEX), APEX);
});

test("an already matching origin resolves to itself", () => {
  assert.equal(resolveSocketUrl(WWW, WWW), WWW);
  assert.equal(resolveSocketUrl(APEX, APEX), APEX);
});

test("a separate realtime host is left exactly as configured", () => {
  assert.equal(
    resolveSocketUrl("https://casino-realtime.onrender.com", WWW),
    "https://casino-realtime.onrender.com",
  );
  assert.equal(
    resolveSocketUrl("https://rt.grynd.dedyn.io", WWW),
    "https://rt.grynd.dedyn.io",
  );
});

test("localhost, IPs and non-http values keep the configured URL", () => {
  assert.equal(resolveSocketUrl("http://localhost:3001", "http://localhost:3000"), "http://localhost:3001");
  assert.equal(resolveSocketUrl("http://127.0.0.1:3001", "http://127.0.0.1:3000"), "http://127.0.0.1:3001");
  assert.equal(resolveSocketUrl("wss://rt.example.com", WWW), "wss://rt.example.com");
  assert.equal(resolveSocketUrl("capacitor://localhost", "capacitor://localhost"), "capacitor://localhost");
});

test("a different protocol, port or base path is a different endpoint", () => {
  assert.equal(resolveSocketUrl("http://www.grynd.dedyn.io", WWW), "http://www.grynd.dedyn.io");
  assert.equal(resolveSocketUrl("https://www.grynd.dedyn.io:8443", WWW), "https://www.grynd.dedyn.io:8443");
  assert.equal(resolveSocketUrl(`${APEX}/realtime`, WWW), `${APEX}/realtime`);
});

test("an unset or blank env disables the socket", () => {
  assert.equal(resolveSocketUrl("", WWW), null);
  assert.equal(resolveSocketUrl("   ", WWW), null);
  assert.equal(resolveSocketUrl(undefined, WWW), null);
});

test("the client feeds the page origin into the resolver", () => {
  const client = readFileSync(new URL("../src/lib/socket.ts", import.meta.url), "utf8");
  assert.match(client, /resolveSocketUrl\(socketUrl, pageOrigin\)/);
  assert.match(client, /window\.location\.origin/);
});
