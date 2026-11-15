// tests/realtime-cors-origins.test.mjs
//
// The Socket.IO server's CORS allow-list.
//
// Production serves the app on www while links and the socket host are on the
// apex, so BOTH forms of a configured origin must pass. Without the twin the
// browser reports "No 'Access-Control-Allow-Origin' header is present" and the
// realtime connection is rejected even though both hosts are the same app.
//
// Run: node --test tests/realtime-cors-origins.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  originVariants,
  parseAllowedOrigins,
} = require("../realtime-server/corsOrigins.js");

test("a configured apex origin also allows its www host, and vice versa", () => {
  assert.deepEqual(originVariants("https://grynd.dedyn.io"), [
    "https://grynd.dedyn.io",
    "https://www.grynd.dedyn.io",
  ]);
  assert.deepEqual(originVariants("https://www.grynd.dedyn.io/"), [
    "https://www.grynd.dedyn.io",
    "https://grynd.dedyn.io",
  ]);
});

test("the Origin the browser sends from www is allowed", () => {
  const allowed = parseAllowedOrigins("https://grynd.dedyn.io");
  assert.ok(allowed.includes("https://www.grynd.dedyn.io"));
  assert.ok(allowed.includes("https://grynd.dedyn.io"));
});

test("both spellings of the same site never duplicate the list", () => {
  assert.deepEqual(
    parseAllowedOrigins("https://grynd.dedyn.io,https://www.grynd.dedyn.io/"),
    ["https://grynd.dedyn.io", "https://www.grynd.dedyn.io"],
  );
});

test("extra entries keep their own variants, in order", () => {
  assert.deepEqual(
    parseAllowedOrigins("https://staging.grynd.dedyn.io,https://app.example.com"),
    [
      "https://staging.grynd.dedyn.io",
      "https://www.staging.grynd.dedyn.io",
      "https://app.example.com",
      "https://www.app.example.com",
    ],
  );
});

test("a stray path or trailing slash still matches the bare origin", () => {
  assert.deepEqual(originVariants("https://app.example.com/play"), [
    "https://app.example.com",
    "https://www.app.example.com",
  ]);
});

test("local, IP and empty entries are left alone", () => {
  assert.deepEqual(originVariants("http://localhost:3000"), ["http://localhost:3000"]);
  assert.deepEqual(originVariants("http://127.0.0.1:3001"), ["http://127.0.0.1:3001"]);
  assert.deepEqual(parseAllowedOrigins(""), []);
  assert.deepEqual(parseAllowedOrigins(undefined), []);
  assert.deepEqual(parseAllowedOrigins(" , "), []);
});
