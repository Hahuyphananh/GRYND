/**
 * Standard PvP match-state sync — the `useVisiblePoll` → `useMatchSync`
 * migration contract.
 *
 * Every migrated match page keeps:
 *   * ONE authoritative GET on mount,
 *   * its existing Socket.IO per-match room push (`*_MATCH_UPDATED`), and
 *   * a `useMatchSync` reconcile that fires ONCE on socket reconnect and on
 *     tab focus — never on an interval.
 *
 * `useVisiblePoll` itself is NOT deleted: lobbies and other callers still use
 * it, so its continued existence is asserted here too.
 *
 * Run:  node --import tsx --test tests/match-sync-migration.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
/** Remove // and /* *\/ comments so prose about polling is not mistaken for code. */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const HOOK = read("src/hooks/useMatchSync.ts");
const HOOK_CODE = stripComments(HOOK);
const POLL_HOOK = read("src/hooks/useVisiblePoll.ts");

/** Per-match pages migrated off the recurring poll. */
const MATCH_PAGES = [
  "src/app/casino/four-in-a-row/game/[gameId]/PageClient.tsx",
  "src/app/casino/rps/game/[gameId]/PageClient.tsx",
  "src/app/casino/tower-arena/game/[matchId]/PageClient.tsx",
  "src/app/casino/mines-pvp/[matchId]/PageClient.tsx",
  "src/app/casino/memory-grid/[matchId]/PageClient.tsx",
  "src/app/casino/solitaire-duel/[matchId]/PageClient.tsx",
  "src/app/casino/speed-typing/[matchId]/PageClient.tsx",
  "src/app/casino/sudoku-duel/[matchId]/PageClient.tsx",
  "src/app/casino/keno-pvp/[matchId]/PageClient.jsx",
  "src/app/casino/lane-runner/[matchId]/PageClient.jsx",
  "src/app/casino/pool-masters/game/[matchId]/PageClient.tsx",
  "src/app/casino/dice-flush/PageClient.tsx",
];

test("the sync hook contains no interval — no hidden fallback polling loop", () => {
  assert.match(HOOK, /^"use client";/m);
  assert.ok(
    !HOOK_CODE.includes("setInterval"),
    "useMatchSync must never start a timer",
  );
  // It reconciles on exactly the two recoverable edges.
  assert.match(HOOK, /socket\?\.on\("connect", onConnect\)/);
  assert.match(HOOK, /document\.addEventListener\("visibilitychange", onVisibilityChange\)/);
  // And it fully cleans up so a finished/unmounted match stops syncing.
  assert.match(HOOK, /socket\?\.off\("connect", onConnect\)/);
  assert.match(HOOK, /document\.removeEventListener\("visibilitychange", onVisibilityChange\)/);
});

test("useVisiblePoll is kept, not blindly deleted, for non-match callers", () => {
  assert.match(POLL_HOOK, /export function useVisiblePoll\(/);
  assert.match(POLL_HOOK, /export function useSocketAwarePoll\(/);
  // Lobby pages still legitimately use it.
  const lobbyUsers = [
    "src/app/casino/four-in-a-row/PageClient.tsx",
    "src/app/casino/rps/PageClient.tsx",
    "src/app/casino/mines-pvp/PageClient.tsx",
    "src/app/casino/memory-grid/PageClient.tsx",
    "src/app/casino/tower-arena/PageClient.tsx",
    "src/app/casino/dots-and-boxes/PageClient.tsx",
    "src/app/casino/tic-tac-toe/PageClient.tsx",
    "src/app/casino/mini-golf/PageClient.tsx",
  ];
  assert.ok(
    lobbyUsers.some((f) => read(f).includes("useSocketAwarePoll")),
    "the lobby poll family must still be in use",
  );
});

/** Single-page PvP games whose poll lives INSIDE an effect, so they use the
 * imperative `startMatchSync` twin instead of the hook. */
const IMPERATIVE_PAGES = [
  "src/app/casino/hex-duel/PageClient.tsx",
  "src/app/casino/odds/PageClient.tsx",
];

for (const file of IMPERATIVE_PAGES) {
  test(`${file} uses the interval-free imperative sync`, () => {
    const page = read(file);
    assert.match(page, /startMatchSync\(/, "must use the interval-free twin");
    assert.ok(
      !page.includes("startSocketAwareInterval"),
      "the socket-aware interval backstop must be gone",
    );
    assert.ok(
      !page.includes("useVisiblePoll"),
      "no recurring-poll import may remain",
    );
    assert.match(page, /socket\.on\(/, "the socket push fast path must survive");
  });
}

// ── Precision: hook-based match state + a purely-visual round clock ──────
test("precision match state syncs event-driven, never by polling", () => {
  const hook = read("src/hooks/usePrecisionMatchState.ts");
  assert.match(hook, /useMatchSync\(refreshState, socket/, "must use the shared sync hook");
  assert.ok(!hook.includes("setInterval"), "no recurring get-match poll may remain");
  assert.ok(!hook.includes("MATCH_POLL_INTERVAL_MS"), "the poll cadence constant must be gone");
  // Its socket fast path must survive.
  assert.match(hook, /SOCKET_NAMESPACE\.roundResultEvent/);
});

test("the precision round clock is purely visual (no HTTP poll)", () => {
  const clock = read("src/hooks/usePrecisionRoundClock.ts");
  assert.ok(!clock.includes("refreshState"), "the clock must not fetch on a timer");
  assert.ok(!clock.includes("ARMING_FAST_POLL"), "the arming fast-poll must be gone");
  // The local countdown ticker and the rAF display loop stay.
  assert.match(clock, /setInterval\(tick, 100\)/);
  assert.match(clock, /requestAnimationFrame/);
});

for (const file of MATCH_PAGES) {
  test(`${file} syncs event-driven, never by polling`, () => {
    const page = read(file);
    assert.match(page, /useMatchSync\(/, "must use the event-driven sync hook");
    assert.ok(
      !page.includes("useVisiblePoll"),
      "the recurring poll must be gone from the match page",
    );
    assert.ok(
      !page.includes("SOCKET_HEALTHY_POLL_MS") && !page.includes("SOCKET_DOWN_POLL_MS"),
      "the poll-cadence constants must be gone",
    );
    // The authoritative snapshot read and the socket fast path must survive.
    assert.match(page, /fetch\(/, "the snapshot must still be fetchable");
    assert.match(page, /join_room/, "the per-match socket room must still be joined");
  });
}

test("each migrated page still re-joins its socket room so it can receive pushes", () => {
  // Some pages re-join via an explicit `connect` handler; all of them must at
  // least join the room on mount. A page that neither joins nor re-joins would
  // silently stop receiving the events this migration relies on.
  for (const file of MATCH_PAGES) {
    const page = read(file);
    assert.match(page, /join_room/, `${file} must join its match room`);
  }
});
