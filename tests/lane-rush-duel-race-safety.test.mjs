/**
 * Lane Rush Duel — race + edge-case safety tests (shared-bridge era).
 *
 * The pure engine (`tests/lane-rush-bridge.test.mjs`) proves the RULES. This
 * file covers what the rules mean for the awkward moments a live duel hits,
 * on both sides of the wire:
 *
 *   • duplicate tile clicks / retried POSTs (idempotency);
 *   • two simultaneous requests (row lock + stale-row refusal);
 *   • acting while it is not your turn;
 *   • the 15s window expiring at the same moment as a tile request;
 *   • reconnection during a turn, and after a failed jump;
 *   • the match ending while another action is in flight;
 *   • the "Get ready" window (so an opening turn can't be lost before the
 *     board is even on screen);
 *   • the bot obeying the same 15s window as a human.
 *
 * There is no DB in this test run (the repo's PvP suites are structural +
 * pure-engine for the same reason), so the server-side assertions are exact
 * ORDER/guard contracts read from the real source files, paired with the
 * engine sequences that show why each guard is required.
 *
 * Run:  node --import tsx --test tests/lane-rush-duel-race-safety.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  BRIDGE_ROWS,
  BRIDGE_TILE_CHOICE_SECONDS,
  bridgeTurnAfterJump,
  buildSharedBridge,
  brokenTilesOf,
  canPlaceFlag,
  flagPlacement,
  isTileBroken,
  resolveJump,
  seatRow,
} from "../src/lib/lane-rush-duel/constants.js";

// Normalise CRLF so multi-line structural assertions work on any OS.
const read = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const store = read("src/lib/lane-rush-duel/serverStore.js");
const constants = read("src/lib/lane-rush-duel/constants.js");
const actRoute = read("src/app/api/lane-rush-duel/match/[matchId]/act/route.js");
const matchRoute = read("src/app/api/lane-rush-duel/match/[matchId]/route.js");
const page = read("src/app/casino/lane-runner/[matchId]/PageClient.jsx");

// The ONE player transition, sliced out so ordering assertions can't be
// fooled by the bot's copy of the same calls.
const actBody = store.slice(
  store.indexOf("export async function act("),
  store.indexOf("// ── Broken-tile signal"),
);
const botBody = store.slice(
  store.indexOf("export async function botAct("),
  store.indexOf("// ── Cancel (creator only, while in waiting)"),
);
const statusBody = store.slice(
  store.indexOf("export async function fetchMatchWithAutoResolve("),
  store.indexOf("async function advanceFromReady"),
);

const SEEDS = Object.freeze({
  serverSeed: "race-server-seed",
  clientSeed: "race-client-seed",
  nonce: 9001,
});

const at = (i) => new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();

/**
 * Drive the pure engine the way the store does: one resolved jump at a time,
 * always from the seat that owns the turn, and always on the seat's own row.
 * Returns the full ledger so a test can assert both the moments and the end.
 */
function playMatch({ bridge, pickTile, seats = ["player1", "player2"] }) {
  const match = {
    player1Id: "u1",
    player2Id: "u2",
    p1Row: 0,
    p2Row: 0,
    broken: [],
    actions: [],
    p1Flags: [],
    p2Flags: [],
    currentTurnUserId: "u1",
  };
  const seatOfUser = { u1: "player1", u2: "player2" };
  const otherUser = (seat) => (seat === "player1" ? "u2" : "u1");

  let steps = 0;
  for (; steps < 400; steps += 1) {
    const seat = seatOfUser[match.currentTurnUserId];
    if (!seat) break;
    const row = seatRow(match, seat);
    const tile = pickTile({ bridge, match, seat, row });
    const outcome = resolveJump({
      bridge,
      broken: brokenTilesOf(match),
      row,
      tile,
    });
    const entry = {
      seat,
      action: "jump",
      row,
      tile,
      outcome: outcome.outcome,
      at: at(steps),
    };
    const turn = bridgeTurnAfterJump({ match, seat, outcome });
    match.actions.push(entry);
    match.broken = Array.isArray(outcome.broken) ? outcome.broken : match.broken;
    if (turn.ended) {
      // The store's win path persists the winner ON the far side of row 10 in
      // the same write that settles the match.
      match[turn.rowField] = turn.row;
      return { match, winner: seat, steps: steps + 1 };
    }
    match[turn.rowField] = turn.row;
    match.currentTurnUserId = turn.turnUserId;
    // The turn must always stay with a real seat — never a dead end.
    assert.ok(
      match.currentTurnUserId === "u1" || match.currentTurnUserId === "u2",
      "every non-terminal resolution leaves the turn with a seat",
    );
    assert.equal(
      turn.turnUserId,
      outcome.outcome === "safe" ? match.currentTurnUserId : otherUser(seat),
      "safe keeps the turn, a fall hands it over",
    );
    assert.equal(
      match[turn.rowField],
      outcome.outcome === "safe" ? row + 1 : 0,
      "safe advances one row, a fall resets to row 1",
    );
    // A safe tile never enters the public broken set.
    if (outcome.outcome === "safe") {
      assert.ok(!isTileBroken(match.broken, row, tile));
    }
  }
  throw new Error("match never finished");
}

// ════════════════════════════════════════════════════════════════════
// The happy path, end to end, purely through the engine
// ════════════════════════════════════════════════════════════════════

test("a full match always ends by crossing row 10 — never by points or a fall", () => {
  const bridge = buildSharedBridge({ ...SEEDS, difficulty: "medium" });
  // Both seats always step over the row's bad tile first (perfect play → the
  // first player to own a turn wins), so this also proves the win is reachable.
  const { match, winner } = playMatch({
    bridge,
    pickTile: ({ bridge: b, row }) =>
      (b.badTiles[row] + 1) % b.tiles, // never the bad tile
  });

  assert.ok(winner === "player1" || winner === "player2");
  assert.equal(seatRow(match, winner), BRIDGE_ROWS, "the winner crossed row 10");
  assert.equal(match.actions.at(-1).outcome, "won");
  // Perfect play takes exactly 10 crossings and the turn never changes hands:
  // a safe tile keeps the turn (the "alternating turns" rule is satisfied by
  // the hand-back on a fall, which this run never triggers).
  assert.equal(match.actions.length, BRIDGE_ROWS);
  assert.equal(match.actions.filter((a) => a.seat === winner).length, BRIDGE_ROWS);
  assert.equal(match.broken.length, 0, "no tile breaks when nobody falls");
});

test("falls are what alternate the turn: reset to row 1, broken tiles pile up", () => {
  const bridge = buildSharedBridge({ ...SEEDS, difficulty: "easy" });
  // Each seat deliberately steps on the bad tile for its FIRST attempt (which
  // is what hands the turn over), then plays perfectly — so the match still
  // finishes while both seats have fallen.
  const attempts = new Map();
  const { match } = playMatch({
    bridge,
    pickTile: ({ bridge: b, seat, row }) => {
      const n = (attempts.get(seat) ?? 0) + 1;
      attempts.set(seat, n);
      void row;
      return n === 1 ? b.badTiles[row] : (b.badTiles[row] + 1) % b.tiles;
    },
  });

  const falls = match.actions.filter((a) => a.outcome === "fell");
  assert.ok(falls.length > 0, "this strategy falls");
  const seats = new Set(falls.map((a) => a.seat));
  assert.equal(seats.size, 2, "both seats fall, so the turn really alternates");
  for (const f of falls) {
    assert.equal(f.row, 0, "the opening fall happens on row 1");
  }
  // Falling is NOT terminal: the match still ends on a crossing.
  assert.equal(match.actions.at(-1).outcome, "won");
  // Every broken entry is that row's single bad tile — never a safe tile — and
  // every fall is represented in the public broken set.
  for (const b of match.broken) {
    assert.equal(b.tile, bridge.badTiles[b.row], "only the bad tile ever breaks");
  }
  for (const f of falls) {
    assert.ok(
      isTileBroken(match.broken, f.row, f.tile),
      "a tile that was stepped on stays broken",
    );
  }
  // Append-only and deduped: every fall is recorded at most once, and nothing
  // is ever removed from the public broken set.
  const replayedKeys = new Set(falls.map((f) => `${f.row}:${f.tile}`));
  assert.equal(
    match.broken.length,
    replayedKeys.size,
    "a broken tile is never recorded twice",
  );
});

// ════════════════════════════════════════════════════════════════════
// Duplicate tile clicks / retried actions
// ════════════════════════════════════════════════════════════════════

test("resolving the SAME click twice is deterministic — so a duplicate can only ever be a no-op", () => {
  const bridge = buildSharedBridge({ ...SEEDS, difficulty: "medium" });
  const row = 3;
  const safeTile = (bridge.badTiles[row] + 1) % bridge.tiles;
  const first = resolveJump({ bridge, broken: [], row, tile: safeTile });
  const again = resolveJump({ bridge, broken: [], row, tile: safeTile });
  assert.deepEqual(again, first, "the engine has no hidden per-call state");

  // The store stops a duplicate BEFORE it can resolve at all: the client's
  // `actionId` is checked first and a repeat is a success no-op.
  const dedupeAt = actBody.indexOf("hasResolvedActionId(match.actions, actionId)");
  const resolveAt = actBody.indexOf("const outcome = resolveJump({");
  assert.ok(dedupeAt > 0 && resolveAt > dedupeAt, "dedupe precedes resolution");
  assert.ok(store.includes("return { duplicate: true, match, status: match.status };"));
  assert.ok(actRoute.includes("if (result.duplicate)"));
  assert.ok(
    actRoute.includes("// action landed on the first attempt, so nothing changed and there"),
    "a duplicate broadcasts nothing",
  );
  // The client also refuses to send a second click while one is in flight.
  assert.ok(page.includes("if (actingRef.current) return;"));
  assert.ok(page.includes("const actionId = `${matchId}:${mySeat}:${Date.now()}:${(actionIdRef.current += 1)}`;"));
});

// ════════════════════════════════════════════════════════════════════
// Two simultaneous requests
// ════════════════════════════════════════════════════════════════════

test("two simultaneous requests serialise on the row lock and the loser is refused, not applied", () => {
  // Every mutating entry point takes the row FOR UPDATE inside one
  // transaction, so two requests can never interleave a read-modify-write.
  assert.ok(store.includes('.for("update")'), "the match row is locked");
  assert.ok(store.includes("async function fetchMatchForUpdate(tx, matchId)"));
  assert.ok(store.includes('const [match] = await tx\n    .select()\n    .from(laneRushDuelMatches)\n    .where(eq(laneRushDuelMatches.id, matchId))\n    .for("update");'));
  for (const [name, body] of [
    ["act", actBody],
    ["botAct", botBody],
    ["status", statusBody],
  ]) {
    assert.ok(
      body.includes("fetchMatchForUpdate(tx, matchId)") ||
        body.includes("fetchMatchForUpdate(tx, matchId);"),
      `${name} must read the locked row`,
    );
  }

  // The second request rendered its click against a row the seat has already
  // left, so the store refuses it — and the engine shows why that matters:
  // resolving it anyway would have crossed the WRONG row.
  const bridge = buildSharedBridge({ ...SEEDS, difficulty: "medium" });
  const staleRow = 3;
  const safeTile = (bridge.badTiles[staleRow] + 1) % bridge.tiles;
  const jump1 = resolveJump({ bridge, broken: [], row: staleRow, tile: safeTile });
  const nowRow = bridgeTurnAfterJump({
    match: { player1Id: "u1", player2Id: "u2" },
    seat: "player1",
    outcome: jump1,
  }).row;
  assert.equal(nowRow, staleRow + 1, "the first request advanced the seat");

  assert.ok(
    actBody.includes("if (!Number.isInteger(selectedRow) || selectedRow !== currentRow) {"),
    "the row the click was rendered against must still be the seat's row",
  );
  assert.ok(actBody.includes('error: "That level already changed — refreshing"'));
  assert.ok(
    actBody.indexOf("selectedRow !== currentRow") < actBody.indexOf("const outcome = resolveJump({"),
    "the staleness guard runs before any resolution",
  );

  // Without the guard the second request would have resolved AGAIN from the
  // row it rendered (`staleRow` → `staleRow + 1`), i.e. it would have crossed
  // a row the seat had already left — that is exactly the double advance the
  // guard exists to stop.
  assert.equal(resolveJump({ bridge, broken: [], row: staleRow, tile: safeTile }).to, staleRow + 1);
  assert.notEqual(staleRow, nowRow, "the stale row is no longer the seat's row");
});

// ════════════════════════════════════════════════════════════════════
// Acting while it is not your turn
// ════════════════════════════════════════════════════════════════════

test("acting out of turn is refused, and a fall hands the turn over so the next click is out of turn", () => {
  assert.ok(
    actBody.includes("if (!match.currentTurnUserId || match.currentTurnUserId !== userId) {"),
    "turn ownership is the server's",
  );
  assert.ok(actBody.includes('error: "Not your turn", status: 409'));
  // The turn gate runs BEFORE the tile is resolved, so an out-of-turn click
  // can never advance a row or break a tile.
  assert.ok(
    actBody.indexOf("Not your turn") < actBody.indexOf("const outcome = resolveJump({"),
  );
  // …and it runs AFTER the flags branch, because a flag is not a tile choice
  // (it never consumes the turn).
  assert.ok(
    actBody.indexOf("if (wantsFlag) {") < actBody.indexOf("Not your turn"),
    "flags stay placeable off-turn",
  );

  // Engine: after a fall the OPPONENT owns the turn, so a same-seat second
  // click would be out of turn.
  const bridge = buildSharedBridge({ ...SEEDS, difficulty: "easy" });
  const outcome = resolveJump({ bridge, broken: [], row: 0, tile: bridge.badTiles[0] });
  assert.equal(outcome.outcome, "fell");
  const turn = bridgeTurnAfterJump({
    match: { player1Id: "u1", player2Id: "u2", currentTurnUserId: "u1" },
    seat: "player1",
    outcome,
  });
  assert.equal(turn.turnUserId, "u2");
  assert.equal(turn.seatStillUp, false);
});

// ════════════════════════════════════════════════════════════════════
// The 15s window expiring at the same moment as a tile request
// ════════════════════════════════════════════════════════════════════

test("a timer expiring at the same time as a tile request resolves as a TIMEOUT, never as a tile", () => {
  // Write path: the expiry is checked (and resolved) BEFORE the tile is
  // validated or resolved, so a late click cannot sneak a tile in — and the
  // timeout that it produced is still broadcast to the other seat.
  const expiryAt = actBody.indexOf("new Date(match.roundDeadline).getTime() <= Date.now()");
  assert.ok(expiryAt > 0);
  assert.ok(expiryAt < actBody.indexOf("selectedRow !== currentRow"));
  assert.ok(expiryAt < actBody.indexOf("const outcome = resolveJump({"));
  assert.ok(actBody.includes("const timedOut = await timeoutAttempt(tx, match);"));
  assert.ok(actBody.includes('error: "Time ran out — the attempt ended"'));
  assert.ok(actBody.includes("timedOut: true"));
  assert.ok(actBody.includes('error: "Time ran out — the attempt ended"'));
  assert.ok(actRoute.includes("if (result.timedOut)"));
  assert.ok(actRoute.includes('action: "timeout"'));

  // Read path: the same expiry (same server clock) is resolved on /status, so
  // whichever request arrives first, the two routes cannot disagree.
  assert.ok(
    statusBody.includes("new Date(match.roundDeadline).getTime() <= Date.now()") &&
      statusBody.includes("await timeoutAttempt(tx, match)"),
  );

  // Engine: a timeout ends the attempt WITHOUT touching a tile.
  const turn = bridgeTurnAfterJump({
    match: {
      player1Id: "u1",
      player2Id: "u2",
      p1Row: 5,
      currentTurnUserId: "u1",
    },
    seat: "player1",
    outcome: { outcome: "timed_out", to: 0 },
  });
  assert.equal(turn.row, 0, "back to row 1");
  assert.equal(turn.turnUserId, "u2", "turn switches");
  assert.equal(turn.ended, false, "a timeout never settles the match");
  // The timeout transition writes no tile and no broken entry at all.
  const timeoutBody = store.slice(
    store.indexOf("async function timeoutAttempt("),
    store.indexOf("export function scrubMatchForViewer"),
  );
  assert.ok(!timeoutBody.includes("resolveJump("));
  assert.ok(!timeoutBody.includes("broken"));
  // The window length itself is unchanged by all of this.
  assert.equal(BRIDGE_TILE_CHOICE_SECONDS, 15);
  assert.ok(store.includes("BRIDGE_TILE_CHOICE_SECONDS * 1000"));
});

// ════════════════════════════════════════════════════════════════════
// Reconnection
// ════════════════════════════════════════════════════════════════════

test("reconnecting mid-turn restores the SERVER's live window, not the device clock", () => {
  // The payload carries the absolute deadline plus the server's own clock…
  assert.ok(matchRoute.includes("roundDeadline: match.roundDeadline"));
  assert.ok(matchRoute.includes("serverNow: new Date().toISOString()"));
  assert.ok(matchRoute.includes("isViewerTurn: match.currentTurnUserId === viewerUserId"));
  // …and the client re-anchors on EVERY payload (first load, poll, reconnect).
  assert.ok(page.includes("setClockOffsetMs(serverMs - Date.now())"));
  assert.ok(page.includes("const serverNowMs = now === null ? null : now + clockOffsetMs;"));
  // A deadline only exists while a seat owns the turn, so a reconnect can
  // never render a phantom countdown.
  assert.ok(
    store.includes("roundDeadline: match.currentTurnUserId ? match.roundDeadline : null"),
  );
  // Nothing about the countdown is authoritative client-side: the only thing
  // reaching zero does is re-ask the server.
  assert.ok(page.includes("expiredDeadlineRef.current === deadlineMs"));
  assert.ok(page.includes("expiredDeadlineRef.current = deadlineMs;"));
  assert.ok(page.includes("fetchStatus();"));
});

test("reconnecting after a failed jump shows the reset from server state and replays nothing", () => {
  // The fall is PERSISTED in the same write as the turn: row 1 + the public
  // broken tile, so any later read (a reconnect, the poll, the opponent)
  // already sees the post-fall board.
  const jumpBody = store.slice(
    store.indexOf("async function applyBridgeJump("),
    store.indexOf("async function resolveMatch("),
  );
  assert.ok(jumpBody.includes("broken,"));
  assert.ok(jumpBody.includes("actions,"));
  assert.ok(jumpBody.includes("[turn.rowField]: turn.row"));
  assert.ok(jumpBody.includes("currentTurnUserId: turn.turnUserId,"));
  assert.ok(jumpBody.includes("roundDeadline: nextTurnDeadline(),"));

  // The client treats the FIRST snapshot as a baseline, so a fresh mount (a
  // reconnect) neither replays the jump animation nor the audio cue.
  assert.ok(page.includes("if (mySeenKeyRef.current === null) {"));
  assert.ok(page.includes("if (oppSeenKeyRef.current === null) {"));
  assert.ok(
    page.includes('history is the baseline, never "news"'),
    "re-delivery of the same action is not news",
  );
  assert.ok(page.includes("mySeenKeyRef.current = myActionKey;"));
  assert.ok(page.includes("oppSeenKeyRef.current = oppActionKey;"));
});

// ════════════════════════════════════════════════════════════════════
// The match ending while another action is in flight
// ════════════════════════════════════════════════════════════════════

test("a match that ends under an in-flight action settles exactly once and refuses the loser request", () => {
  // Only crossing row 10 (or a resignation) settles…
  const jumpBody = store.slice(
    store.indexOf("async function applyBridgeJump("),
    store.indexOf("async function resolveMatch("),
  );
  assert.ok(jumpBody.includes("if (turn.ended) {"));
  assert.ok(jumpBody.includes("return await resolveMatch("));
  assert.ok(jumpBody.includes("loserId: opponentIdOf(match, seat),"));
  assert.ok(jumpBody.includes('reason: "crossed_bridge"'));
  assert.ok(!jumpBody.includes('reason: "fell"'), "a fall never settles");

  // …the settle flips the row to `finished` and clears the turn in ONE write,
  // so an action still in flight finds a terminal match…
  const settleBody = store.slice(
    store.indexOf("async function settle("),
    store.indexOf("async function recordPvPResult("),
  );
  assert.ok(settleBody.includes("status: MATCH_STATUS.FINISHED"));
  assert.ok(settleBody.includes("currentTurnUserId: null"));
  assert.ok(settleBody.includes("roundDeadline: null"));
  // …and every entry point refuses anything that is not pickable, INSIDE the
  // same row-locked transaction (so a second settle can never double-pay).
  assert.ok(actBody.includes("if (!PICKABLE_STATES.has(match.status)) {"));
  assert.ok(actBody.includes('error: "Match is not active", status: 400'));
  assert.ok(botBody.includes("if (!PICKABLE_STATES.has(match.status)) {"));
  assert.ok(statusBody.includes("PICKABLE_STATES.has(match.status)"));
  assert.ok(store.includes("export async function fetchMatchWithAutoResolve"));
  assert.ok(store.includes("TERMINAL_STATES.has(match.status)"), "resign is guarded too");
  assert.ok(
    actBody.indexOf("PICKABLE_STATES.has(match.status)") <
      actBody.indexOf("const outcome = resolveJump({"),
    "the terminal gate runs before any resolution",
  );

  // The engine: the crossing jump settles with a winner and no turn left.
  const bridge = buildSharedBridge({ ...SEEDS, difficulty: "medium" });
  const lastRow = BRIDGE_ROWS - 1;
  const outcome = resolveJump({
    bridge,
    broken: [],
    row: lastRow,
    tile: (bridge.badTiles[lastRow] + 1) % bridge.tiles,
  });
  assert.equal(outcome.outcome, "won");
  const turn = bridgeTurnAfterJump({
    match: { player1Id: "u1", player2Id: "u2", currentTurnUserId: "u1" },
    seat: "player1",
    outcome,
  });
  assert.equal(turn.ended, true);
  assert.equal(turn.turnUserId, null, "a finished match has no turn");
  assert.equal(turn.row, BRIDGE_ROWS);
});

// ════════════════════════════════════════════════════════════════════
// The opening window — the "Get ready" banner
// ════════════════════════════════════════════════════════════════════

test("joining opens a 3s ready window, so the opening 15s turn can't start before the board is up", () => {
  const joinBody = store.slice(
    store.indexOf("async function joinExistingMatch("),
    store.indexOf("// ── Test vs Bot practice match"),
  );
  // The joiner lands in READY with a short deadline and NO turn owner, exactly
  // like the sibling PvP stores — never straight into a live 15s window.
  assert.ok(joinBody.includes("status: MATCH_STATUS.READY"));
  assert.ok(joinBody.includes("const readyDeadline = new Date(Date.now() + READY_WINDOW_MS);"));
  assert.ok(joinBody.includes("roundDeadline: readyDeadline"));
  assert.ok(joinBody.includes("currentTurnUserId: null"));
  assert.ok(!joinBody.includes("currentTurnUserId: firstPlayerId"));
  assert.ok(!joinBody.includes("status: MATCH_STATUS.ACTIVE"));
  // …and the SAME first player the coin flip picked opens the real window with
  // a full 15 seconds once READY elapses.
  assert.ok(store.includes("const openingTurnUserId = match.firstPlayerId || match.player1Id || null;"));
  assert.ok(
    store.includes("roundDeadline: openingTurnUserId ? nextTurnDeadline() : null,"),
    "the opening window is a fresh 15s",
  );
  // PICKABLE excludes READY, so no click can land during the banner…
  const pickable = constants.slice(
    constants.indexOf("export const PICKABLE_STATES = new Set(["),
    constants.indexOf("]);", constants.indexOf("export const PICKABLE_STATES")),
  );
  assert.ok(pickable.includes("MATCH_STATUS.ACTIVE"));
  assert.ok(!pickable.includes("MATCH_STATUS.READY"));
  // …and READY is still a live (non-terminal) state, so the match can advance.
  const active = constants.slice(
    constants.indexOf("export const ACTIVE_STATES = new Set(["),
    constants.indexOf("]);", constants.indexOf("export const ACTIVE_STATES")),
  );
  assert.ok(active.includes("MATCH_STATUS.READY"));
});

// ════════════════════════════════════════════════════════════════════
// The bot plays by the same clock
// ════════════════════════════════════════════════════════════════════

test("the bot obeys the same 15s window as a human", () => {
  assert.ok(botBody.includes("if (match.currentTurnUserId !== BOT_USER_ID) return match;"));
  // The window is checked immediately after turn ownership: a late wake-up
  // ends the bot's attempt instead of granting it borrowed time.
  const turnGate = botBody.indexOf("if (match.currentTurnUserId !== BOT_USER_ID) return match;");
  const deadlineGate = botBody.indexOf(
    "new Date(match.roundDeadline).getTime() <= Date.now()",
  );
  assert.ok(deadlineGate > turnGate, "the bot checks the clock after the turn");
  assert.ok(
    botBody.indexOf("const decision = decideBridgeBotAction(") > deadlineGate,
    "the deadline is enforced before the bot decides anything",
  );
  assert.ok(botBody.includes("const timedOut = await timeoutAttempt(tx, match);"));
  assert.ok(botBody.includes("return { ...timedOut, timedOut: true };"));
  // The bot also can't re-enter its own turn while a wake-up is in flight.
  assert.ok(botBody.includes("if (hasResolvedActionId(match.actions, actionId)) {"));
  assert.ok(botBody.includes("BOT_ACTION_INTERVAL_MS"));
});

// ════════════════════════════════════════════════════════════════════
// Flags can never be gamed through a race
// ════════════════════════════════════════════════════════════════════

test("a flag raced between two requests can only land on a tile the seat really crossed", () => {
  const bridge = buildSharedBridge({ ...SEEDS, difficulty: "medium" });
  const match = {
    player1Id: "u1",
    player2Id: "u2",
    p1Flags: [],
    p2Flags: [],
    // The seat crossed row 1 tile 0 and nothing else.
    actions: [{ seat: "player1", action: "jump", row: 0, tile: 0, outcome: "safe" }],
  };

  // The tile it really landed on is allowed…
  assert.deepEqual(
    canPlaceFlag({ match, seat: "player1", row: 0, tile: 0, bridge }),
    { ok: true },
  );
  // …a tile it never touched is not (the request is never trusted)…
  assert.equal(
    canPlaceFlag({ match, seat: "player1", row: 4, tile: 1, bridge }).ok,
    false,
  );
  // …and the OPPONENT cannot flag this seat's landing either.
  assert.equal(
    canPlaceFlag({ match, seat: "player2", row: 0, tile: 0, bridge }).ok,
    false,
  );

  // Two simultaneous flag requests for the SAME tile: the first appends, and
  // the second is refused by the same-tile guard (append-only, never moved).
  const first = flagPlacement({ match, seat: "player1", row: 0, tile: 0, at: at(1) });
  const after = { ...match, [first.field]: first.flags };
  assert.equal(
    canPlaceFlag({ match: after, seat: "player1", row: 0, tile: 0, bridge }).ok,
    false,
    "the same tile cannot be flagged twice",
  );
  assert.deepEqual(after.p1Flags, first.flags);

  // The store runs the flag inside the same row lock as a jump.
  assert.ok(actBody.includes("if (wantsFlag) {"));
  assert.ok(actBody.includes("canPlaceFlag({"));
  assert.ok(actBody.includes("[placement.field]: placement.flags"));
});
