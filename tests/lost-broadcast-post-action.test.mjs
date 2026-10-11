// tests/lost-broadcast-post-action.test.mjs
//
// The class behind the reported Precision latency:
//
//   "When I click stop, the AI is still in flight and the results show with
//    delay."
//
// A seat that acts on its own clock — the STOP, the tap, the move — must be able
// to see the consequence of its OWN action without the room broadcast. In
// Precision it could not: the stop response carried `{ success: true }` and
// nothing read the match while the round was live, so a `precision:roundResult`
// packet the socket dropped left the board with the bot still flying until the
// tab was refocused.
//
// The other six clocked pages — the ones that also bring their stored instants
// forward with `useDeadlineRead` (see `countdown-start-liveness.test.mjs`) —
// each confirm the acting seat's own action over HTTPS: the action's response
// carries the snapshot, or a read is issued from the same handler the moment the
// action succeeds. Every one of them had its recurring poll removed by
// `useMatchSync`, so a dropped broadcast has no backstop to fall back on — the
// read in the action handler IS the guarantee. This file pins it. Delete any one
// of those reads and the acting seat is back to waiting on a packet it may never
// receive.
//
// Run:  node --import tsx --test tests/lost-broadcast-post-action.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
/** Strip // and block comments, so prose ABOUT a read is never mistaken for one. */
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const KENO = "src/app/casino/keno-pvp/[matchId]/PageClient.jsx";
const SPEED_TYPING = "src/app/casino/speed-typing/[matchId]/PageClient.tsx";
const FOUR_IN_A_ROW = "src/app/casino/four-in-a-row/game/[gameId]/PageClient.tsx";
const MINES = "src/app/casino/mines-pvp/[matchId]/PageClient.tsx";
const TOWER_ARENA = "src/app/casino/tower-arena/game/[matchId]/PageClient.tsx";
const LANE_RUSH = "src/app/casino/lane-runner/[matchId]/PageClient.jsx";

/**
 * The read that must trail `anchor`, in the same handler.
 *
 * Both indices are searched in the comment-stripped source, so a handler that
 * only TALKS about reading fails. `maxGap` keeps the pair in one function: a read
 * belonging to some other handler further down the file is not evidence.
 */
function assertReadTrails({ code, anchor, readCall, maxGap, why }) {
  const anchorAt = code.indexOf(anchor);
  assert.ok(
    anchorAt >= 0,
    `${anchor} is gone — this test can no longer see the action it guards`,
  );
  const readAt = code.indexOf(readCall, anchorAt);
  assert.ok(
    readAt >= 0,
    `${why}: no ${readCall} follows ${anchor} anywhere in the file`,
  );
  assert.ok(
    readAt - anchorAt <= maxGap,
    `${why}: the first ${readCall} trails ${anchor} by ${readAt - anchorAt} chars ` +
      `(limit ${maxGap}) — that is a different handler, not this action`,
  );
  return readAt;
}

// ── Keno Duel: claiming the lit tile ────────────────────────────────────

test("Keno Duel: a claimed tile is confirmed to the claimer over HTTPS", () => {
  const code = stripComments(read(KENO));

  assert.ok(
    code.includes("/api/keno-pvp/match/${matchId}/catch"),
    "the claim must still be submitted over HTTPS",
  );
  // The success path: the claim landed, so pull the freshly lit tile rather than
  // waiting for KENO_PVP_MATCH_UPDATED. Both seats are graded off this same
  // snapshot, so the claimer's own view is authoritative too.
  assertReadTrails({
    code,
    anchor: 'posthog?.capture("keno_pvp_claimed"',
    readCall: "void fetchStatus()",
    maxGap: 400,
    why: "a lost broadcast would strand the seat that claimed",
  });
  // A refused tap reconciles as well — a refusal usually means the tile moved on.
  assertReadTrails({
    code,
    anchor: "/api/keno-pvp/match/${matchId}/catch",
    readCall: "void fetchStatus()",
    maxGap: 1400,
    why: "a rejected claim must not leave the board on the tile the server rejected",
  });
});

// ── Speed Typing: crossing the finish line ──────────────────────────────

test("Speed Typing: the finisher reads its own verdict", () => {
  const code = stripComments(read(SPEED_TYPING));

  assert.ok(
    code.includes("/api/speed-typing/match/${matchId}/finish"),
    "the finish must still be submitted over HTTPS",
  );
  // A finisher's own verdict is in the finish response — but the row is only
  // written back into the page by the follow-up read, which `complete` always
  // triggers. Without it the racer sat on a clock they had already beaten.
  assert.ok(
    code.includes(
      "if (complete || data.data?.outcome?.settled) void load({ silent: true });",
    ),
    "the finisher no longer reads the race it just finished — the result would " +
      "have to arrive by broadcast, which is exactly the Precision gap",
  );
});

// ── Four in a Row: dropping a disc ──────────────────────────────────────

test("Four in a Row: a played disc is confirmed to the player who dropped it", () => {
  const code = stripComments(read(FOUR_IN_A_ROW));

  assert.ok(
    code.includes('fetch("/api/four-in-a-row/play-move"'),
    "the move must still be submitted over HTTPS",
  );
  // The success path announces the move to the room AND reads: the read is what
  // shows this player their own disc landed. The failure branch's read is not
  // enough on its own, so the emit is the anchor.
  const emit = 'event: "match:updated",';
  const firstEmit = code.indexOf(emit);
  assert.ok(firstEmit > 0, "the room broadcast emit is gone");
  assertReadTrails({
    code,
    anchor: emit,
    readCall: "fetchState()",
    maxGap: 300,
    why: "the seat that moved must not wait for the broadcast it just sent",
  });
});

// ── Mines Duel: picking a cell ──────────────────────────────────────────

test("Mines Duel: a pick is confirmed to the player who made it", () => {
  const code = stripComments(read(MINES));

  assert.ok(
    code.includes("/api/mines-pvp/match/${matchId}/${action}"),
    "the pick must still be submitted over HTTPS",
  );
  // The read sits at the end of the success path, after the bot's turn has been
  // asked for, so the human sees their own reveal (and the bot's answer) without
  // depending on MINES_PVP_MATCH_UPDATED.
  assertReadTrails({
    code,
    anchor: "/api/mines-pvp/match/${matchId}/${action}",
    readCall: "await fetchStatus()",
    maxGap: 2600,
    why: "a lost broadcast would freeze the picker's board mid-turn",
  });
});

// ── Tower Arena: dropping a block ───────────────────────────────────────

test("Tower Arena: a submitted placement is confirmed to the placer", () => {
  const code = stripComments(read(TOWER_ARENA));

  assert.ok(
    code.includes('fetch("/api/tower-arena/submit-placement"'),
    "the placement must still be submitted over HTTPS",
  );
  // The block was already animated optimistically; `load()` is what makes the
  // placement authoritative (the settled block, the contact shock, and the turn
  // handover) instead of waiting for an arena event that may not arrive.
  assertReadTrails({
    code,
    anchor: 'fetch("/api/tower-arena/submit-placement"',
    readCall: "load();",
    maxGap: 1600,
    why: "the placer would keep an optimistic block that the server had rejected",
  });
});

// ── Lane Rush Duel: acting on the bridge ────────────────────────────────

test("Lane Rush Duel: an action is confirmed to the player who took it", () => {
  const code = stripComments(read(LANE_RUSH));

  assert.ok(
    code.includes("/api/lane-rush-duel/match/${matchId}/act"),
    "the action must still be submitted over HTTPS",
  );
  // A 409 (the board moved on, or the window expired) reconciles immediately.
  assertReadTrails({
    code,
    anchor: "/api/lane-rush-duel/match/${matchId}/act",
    readCall: "await fetchStatus()",
    maxGap: 2600,
    why: "a refused action must resync the board it was refused against",
  });
  // …and so does the success path, after the room is nudged: the crossing is
  // resolved by the action itself, so the actor's read is what shows it.
  const emit = "event: LANE_RUSH_DUEL_MATCH_UPDATED,";
  const emitAt = code.indexOf(emit);
  assert.ok(emitAt > 0, "the room broadcast emit is gone");
  assertReadTrails({
    code,
    anchor: emit,
    readCall: "await fetchStatus()",
    maxGap: 200,
    why: "a lost broadcast would leave the actor on an unresolved crossing",
  });
});
