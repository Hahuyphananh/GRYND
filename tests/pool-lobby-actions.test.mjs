/**
 * pool-lobby-actions.test.mjs
 *
 * The Pool Masters lobby's three "start something" actions POST, and a POST is
 * the kind of request a browser can REJECT outright — most visibly when the app
 * is served from a host that 308-redirects to another origin: `fetch` follows
 * the redirect cross-origin, the redirected response carries no CORS headers,
 * and the promise rejects with `TypeError: Failed to fetch`. A dropped socket
 * or a cold function looks identical to the caller.
 *
 * The bug this file pins: those handlers ran `try { … } finally { … }`. A
 * rejection escaped as an UNCAUGHT promise, the busy overlay cleared, and
 * neither the game nor a message appeared — the reported symptom, "clicking
 * Create Game does nothing".
 *
 * The contract asserted here:
 *   * every action goes through ONE retrying JSON helper (never its own fetch),
 *   * that helper retries exactly once and then rethrows,
 *   * a non-JSON reply cannot escape as a SyntaxError, and
 *   * every action reports a transport failure in the lobby's error banner.
 *
 * Run: node --import tsx --test tests/pool-lobby-actions.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const LOBBY = "src/app/casino/pool-masters/PageClient.tsx";
const page = fs.readFileSync(LOBBY, "utf8");

/** The three lobby actions, by the endpoint each one POSTs to. */
const ENDPOINTS = ["create-lobby", "join-lobby", "create-ai-match"];

/** The source of one action handler, from its declaration to its closing `};`. */
function actionBody(name) {
  const start = page.indexOf(`const ${name} = async`);
  assert.notEqual(start, -1, `${name} exists`);
  const end = page.indexOf("\n  };", start);
  assert.notEqual(end, -1, `${name} closes`);
  return page.slice(start, end);
}

const ACTIONS = {
  createLobby: "create-lobby",
  joinLobby: "join-lobby",
  createAI: "create-ai-match",
};

test("lobby: every action POSTs through the retrying JSON helper", () => {
  for (const [name, endpoint] of Object.entries(ACTIONS)) {
    const body = actionBody(name);
    assert.match(body, new RegExp(`await postPoolJson\\("/api/pool/${endpoint}"`), `${name} uses the helper`);
    // A bare fetch here is exactly the un-guarded shape that produced the
    // uncaught rejection: no action may issue its own request.
    assert.equal(body.includes("fetch("), false, `${name} must not fetch directly`);
  }
});

test("lobby: the helper retries once and then rethrows", () => {
  const helper = page.slice(page.indexOf("async function postPoolJson"), page.indexOf("export default function PoolLobbyPage"));
  // Two attempts — the first failure is retried, the second is reported.
  assert.match(helper, /for \(let attempt = 0; attempt < 2; attempt \+= 1\)/);
  assert.match(helper, /if \(attempt === 0\) await new Promise/);
  assert.match(helper, /throw failure;/);
  // The retry waits before re-issuing the request.
  assert.match(helper, /setTimeout\(resolve, 400\)/);
});

test("lobby: a non-JSON reply cannot escape as a SyntaxError", () => {
  // A platform/proxy error page answers with HTML; `res.json()` would throw.
  assert.match(page, /await res\.json\(\)\.catch\(\(\) => null\)/);
});

test("lobby: every action reports a transport failure to the player", () => {
  for (const [name] of Object.entries(ACTIONS)) {
    const body = actionBody(name);
    assert.match(body, /catch \{\s*setError\(UNREACHABLE\);/, `${name} reports the failure`);
    // …and still clears its busy state, so the button is usable again.
    assert.match(body, /finally \{/, `${name} clears busy state`);
  }
  assert.match(page, /const UNREACHABLE =/);
});

test("lobby: the success path is unchanged — an id navigates, anything else reports", () => {
  assert.match(actionBody("createLobby"), /if \(!data\?\.lobbyId\)/);
  assert.match(actionBody("joinLobby"), /if \(!data\?\.matchId\)/);
  assert.match(actionBody("createAI"), /if \(!data\?\.matchId\)/);
  // A missing lobby id is the only thing that reports instead of navigating.
  assert.match(page, /if \(!data\?\.lobbyId\) \{\s*setError\(data\?\.error \|\| data\?\.message \|\| "Unable to create lobby"\)/);
  assert.match(page, /router\.push\(`\/casino\/pool-masters\/game\/\$\{data\.lobbyId\}`\)/);
  assert.match(page, /`\/casino\/pool-masters\/game\/\$\{data\.matchId\}\?ai=1&turn=/);
});

test("lobby: a refusal shows the server's own reason, not just a generic line", () => {
  // The pool routes answer a refusal with `{ ok: false, message }` and the
  // age-gate with `{ error }`. Reading only one shape silently swapped the real
  // cause ("Wager must be between …") for a generic "Unable to …" line, so both
  // must be read, on every action.
  for (const [name, fallback] of [
    ["createLobby", "Unable to create lobby"],
    ["joinLobby", "Unable to join lobby"],
    ["createAI", "Unable to start AI match"],
  ]) {
    const body = actionBody(name);
    assert.match(
      body,
      new RegExp(`setError\\(data\\?\\.error \\|\\| data\\?\\.message \\|\\| "${fallback}"\\)`),
      `${name} reads both refusal shapes`,
    );
  }
});
