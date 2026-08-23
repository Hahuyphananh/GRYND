/**
 * Lane Rush Duel — flow (state-machine) tests for the SHARED TOWER +
 * DEFERRED REVEAL model.
 *
 * The server store (`src/lib/lane-rush-duel/serverStore.js`) is the
 * authoritative state machine, but it pulls in `drizzle-orm` and the
 * DB client at import time, so this test MIRRORS the relevant logic
 * in plain functions and drives it through an in-memory `matches`
 * Map — the same approach as `tests/mines-pvp-flow.test.mjs`. The
 * mirror intentionally tracks the production logic so any drift is
 * caught by a reviewer when the diff is reviewed.
 *
 * Contract under test:
 *   • BOTH players climb the SAME shared tower (p1Tower === p2Tower,
 *     one client seed).
 *   • DEFERRED REVEAL: an action parks as `pending` and the turn
 *     passes to the opponent; the pair only resolves when the
 *     opponent answers the same row. Pending entries are scrubbed to
 *     `{ action: "pending", seat, round, pending: true }` — no tile,
 *     path, safe, or type leaks before both have acted.
 *   • A player whose opponent is already done (banked/completed)
 *     climbs alone: their picks resolve immediately.
 *   • Resolution: bust (other wins), both bust on the same row
 *     (draw/refund), flag correct (instant win), completion, or
 *     both-done → compare scores.
 *
 * Run:  node --import tsx --test tests/lane-rush-duel-flow.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  BOT_USER_ID,
  MATCH_STATUS,
  MAX_FLAGS,
  MAX_LANES,
  MAX_PEEKS,
  PICKABLE_STATES,
  RESULT,
  RISK_PATH_KEYS,
  RISK_PATHS,
  WIN_BANKED_SCORE,
  bankedScoreOf,
  bankedWinnerOf,
  banksUsedBySeat,
  buildPlayerTower,
  climbEnded,
  computePayout,
  finalScoreOf,
  flagsUsedBySeat,
  hasBanked,
  opponentOf,
  peeksUsedBySeat,
  pickPointsForSeat,
  pointsForSafePick,
  scoreFromActions,
} from "../src/lib/lane-rush-duel/constants.js";

// ════════════════════════════════════════════════════════════════════════
// In-memory mirror of the server store's deferred-reveal state machine
// ════════════════════════════════════════════════════════════════════════

function makeMatch({ id, player1Id, player2Id, difficulty = "easy" }) {
  // Shared tower: one server seed + one client seed for BOTH seats.
  const serverSeed = `server-${id}`;
  const clientSeed = `client-${id}`;
  const tower = buildPlayerTower({
    serverSeed,
    clientSeed,
    nonce: id,
    difficulty,
  });
  return {
    id,
    player1Id,
    player2Id,
    difficulty,
    stakeAmount: 100,
    status: MATCH_STATUS.READY,
    firstPlayerId: player1Id,
    currentTurnUserId: null,
    roundDeadline: new Date(Date.now() + 60_000),
    p1Lane: 0,
    p2Lane: 0,
    p1Held: false,
    p2Held: false,
    p1ClientSeed: clientSeed,
    p2ClientSeed: clientSeed,
    p1Tower: tower,
    p2Tower: tower,
    actions: [],
    result: null,
    winnerId: null,
    prizePaid: 0,
    houseFee: 0,
    p1Points: 0,
    p2Points: 0,
    endedAt: null,
  };
}

function seatOf(match, userId) {
  if (!match || !userId) return null;
  if (match.player1Id === userId) return "player1";
  if (match.player2Id === userId) return "player2";
  return null;
}

function isParticipant(match, userId) {
  return seatOf(match, userId) !== null;
}

function lastPendingAction(match) {
  for (let i = match.actions.length - 1; i >= 0; i -= 1) {
    if (match.actions[i] && match.actions[i].pending === true) {
      return match.actions[i];
    }
  }
  return null;
}

function advanceFromReady(match) {
  if (!match.firstPlayerId) return match;
  match.status =
    match.firstPlayerId === match.player1Id
      ? MATCH_STATUS.P1_TURN
      : MATCH_STATUS.P2_TURN;
  match.currentTurnUserId = match.firstPlayerId;
  match.roundDeadline = new Date(Date.now() + 60_000);
  return match;
}

// ── Mirrors `act` in the production server store ─────────────────────
function act({ userId, matchId, action, path, tileIndex, matches }) {
  const match = matches.get(matchId);
  if (!match) return { error: "Match not found", status: 404 };
  if (!isParticipant(match, userId)) {
    return { error: "Forbidden", status: 403 };
  }
  if (!PICKABLE_STATES.has(match.status)) {
    return { error: "Match is not awaiting an action", status: 400 };
  }
  if (
    match.roundDeadline &&
    new Date(match.roundDeadline).getTime() <= Date.now()
  ) {
    return { error: "Action window has expired", status: 400 };
  }
  if (match.currentTurnUserId !== userId) {
    return { error: "It is not your turn", status: 403 };
  }

  const seat = seatOf(match, userId);
  const lane = Number(seat === "player1" ? match.p1Lane : match.p2Lane) || 0;
  if (climbEnded(match, seat)) {
    return { error: "Your climb is over", status: 400 };
  }

  // Flag budget (mirrors the production act()).
  if (action === "flag" && flagsUsedBySeat(match, seat) >= MAX_FLAGS) {
    return { error: "No flags left this match", status: 400 };
  }

  // Peek budget (mirrors the production act()).
  if (action === "peek" && peeksUsedBySeat(match, seat) >= MAX_PEEKS) {
    return { error: "No peeks left this match", status: 400 };
  }

  const entry = {
    userId,
    seat,
    action,
    lane,
    round: lane,
    pending: true,
    autoPicked: false,
    at: new Date().toISOString(),
  };

  if (action !== "hold") {
    const tower = seat === "player1" ? match.p1Tower : match.p2Tower;
    const laneLayout = tower[lane] || {};
    if (tileIndex >= RISK_PATHS[path].tiles) {
      return { error: "Invalid tile index", status: 400 };
    }
    const badTile = Number(laneLayout[path]);
    entry.path = path;
    entry.tile = tileIndex;
    if (action === "peek") {
      // Private peek: instant, no points, keeps the turn.
      entry.pending = false;
      entry.peekResult = tileIndex === badTile ? "bad" : "safe";
    } else if (action === "flag") {
      // Correct flag = safe (claims the row); wrong flag = bust.
      const correct = tileIndex === badTile;
      entry.flagCorrect = correct;
      entry.safe = correct;
      entry.points = correct
        ? pickPointsForSeat(match, seat, lane, path, match.difficulty)
        : 0;
    } else {
      entry.safe = tileIndex !== badTile;
      entry.points = entry.safe
        ? pickPointsForSeat(match, seat, lane, path, match.difficulty)
        : 0;
    }
  }

  if (action === "hold") {
    // Soft bank: lock the seat's accumulated points as its safe score.
    entry.bankedTotal = scoreFromActions(match.actions, seat);
  }

  // A peek is INSTANT: record it and keep the turn with the actor.
  if (action === "peek") {
    match.actions = [...match.actions, entry];
    return { match };
  }

  const oppSeat = seat === "player1" ? "player2" : "player1";
  const oppEnded = climbEnded(match, oppSeat);

  const pending = lastPendingAction(match);
  const pairComplete =
    pending !== null &&
    pending.seat !== seat &&
    Number(pending.round) === lane;

  if (pairComplete) {
    resolveRound(match, entry);
  } else if (oppEnded) {
    entry.pending = false;
    applyEntryImmediately(match, entry, seat);
  } else {
    parkPendingAction(match, entry, seat);
  }

  return { match };
}

function parkPendingAction(match, entry, seat) {
  const otherUserId = opponentOf(match, entry.userId);
  const otherSeat = otherUserId === match.player1Id ? "player1" : "player2";
  match.actions = [...match.actions, entry];
  match.status =
    otherSeat === "player1" ? MATCH_STATUS.P1_TURN : MATCH_STATUS.P2_TURN;
  match.currentTurnUserId = otherUserId;
  match.roundDeadline = new Date(Date.now() + 60_000);
}

// ── Mirrors `afterRound`: decide settle vs continue after every ──────
// action pair / lone action. Appends the entry exactly once (the
// settle helpers read `match.actions` as-is; advanceTurn does not
// re-append).
function applyEntryImmediately(match, entry, seat) {
  if (entry.action === "hold") {
    // Banking moves you PAST the row you banked on (capped at the
    // top — a hold never completes the tower), keeping both players
    // on the same row for the deferred pairing.
    if (seat === "player1") {
      match.p1Held = true;
      match.p1Lane = Math.max(
        match.p1Lane,
        Math.min(Number(entry.round) + 1, MAX_LANES - 1),
      );
    } else {
      match.p2Held = true;
      match.p2Lane = Math.max(
        match.p2Lane,
        Math.min(Number(entry.round) + 1, MAX_LANES - 1),
      );
    }
    return afterRound(match, entry, seat);
  }
  // pick + flag share the same resolution (safe = advance / bust).
  if (entry.safe === false) {
    return afterRound(match, entry, seat);
  }
  const newLane = Number(entry.round) + 1;
  if (seat === "player1") match.p1Lane = newLane;
  else match.p2Lane = newLane;
  return afterRound(match, entry, seat);
}

function afterRound(match, entry, lastSeat) {
  if (!match.actions.some((a) => a === entry)) {
    match.actions = [...match.actions, entry];
  }

  // Rule 1 — the 1,000-banked race: whoever locks ≥ WIN_BANKED_SCORE
  // first takes the pot instantly (chronological action order wins
  // the both-bank-1000-on-the-same-row edge case).
  const bankedWinner = bankedWinnerOf(match);
  if (bankedWinner === "player1") {
    return resolveMatch(match, match.player2Id, "banked_target", entry);
  }
  if (bankedWinner === "player2") {
    return resolveMatch(match, match.player1Id, "banked_target", entry);
  }

  // Rule 2 — completion = instant win (single completer).
  const p1Top = Number(match.p1Lane) >= MAX_LANES;
  const p2Top = Number(match.p2Lane) >= MAX_LANES;
  if (p1Top && !p2Top) {
    return resolveMatch(match, match.player2Id, "completed", entry);
  }
  if (p2Top && !p1Top) {
    return resolveMatch(match, match.player1Id, "completed", entry);
  }

  // Rule 3 — fallback settlement ONLY when both climbs are over
  // (busted / completed). Banking never settles the match: the race
  // to 1,000 banked continues.
  const p1Ended = climbEnded(match, "player1");
  const p2Ended = climbEnded(match, "player2");
  if (p1Ended && p2Ended) return resolveByFinalScores(match, entry);
  return advanceTurn(match, lastSeat);
}

function advanceTurn(match, lastSeat) {
  const lastUserId =
    lastSeat === "player1" ? match.player1Id : match.player2Id;
  const otherUserId = opponentOf(match, lastUserId);
  const otherSeat = otherUserId === match.player1Id ? "player1" : "player2";
  const otherEnded = climbEnded(match, otherSeat);
  const nextUserId = otherEnded ? lastUserId : otherUserId;
  const nextSeat =
    nextUserId === match.player1Id ? "player1" : "player2";
  match.status =
    nextSeat === "player1" ? MATCH_STATUS.P1_TURN : MATCH_STATUS.P2_TURN;
  match.currentTurnUserId = nextUserId;
  match.roundDeadline = new Date(Date.now() + 60_000);
}

// ── Mirrors `resolveRound`: apply the pair together ───────────────────
function resolveRound(match, entry) {
  const applied = [...match.actions, entry].map((a) =>
    a && a.pending === true ? { ...a, pending: false } : a,
  );
  let p1Lane = Number(match.p1Lane) || 0;
  let p2Lane = Number(match.p2Lane) || 0;
  let p1Held = Boolean(match.p1Held);
  let p2Held = Boolean(match.p2Held);

  for (const a of applied) {
    if (a.action === "hold") {
      // Banking moves you past the row you banked on (capped at the
      // top — a hold never completes the tower). Keeps the pair on
      // the same row so deferred reveal keeps working.
      const nextLane = Math.min(Number(a.round) + 1, MAX_LANES - 1);
      if (a.seat === "player1") {
        p1Held = true;
        p1Lane = Math.max(p1Lane, nextLane);
      } else {
        p2Held = true;
        p2Lane = Math.max(p2Lane, nextLane);
      }
      continue;
    }
    // pick + flag: safe (or a correct flag) advances; anything else
    // (bad pick / wrong flag) busts. Peeks are instant and never
    // reach the pairing resolution.
    if (a.safe === true) {
      const newLane = Number(a.round) + 1;
      if (a.seat === "player1") p1Lane = Math.max(p1Lane, newLane);
      else p2Lane = Math.max(p2Lane, newLane);
    }
  }

  match.p1Lane = p1Lane;
  match.p2Lane = p2Lane;
  match.p1Held = p1Held;
  match.p2Held = p2Held;
  match.actions = applied;
  const lastAction = applied[applied.length - 1];

  // Both-bust is handled by afterRound's settlement: both finals are
  // their banked totals (two no-bank busts are 0 vs 0 → DRAW).
  return afterRound(match, lastAction, lastAction.seat);
}

function resolveByFinalScores(match, entry) {
  const p1Score = finalScoreOf(match, "player1");
  const p2Score = finalScoreOf(match, "player2");
  let result;
  if (p1Score > p2Score) result = RESULT.PLAYER1;
  else if (p2Score > p1Score) result = RESULT.PLAYER2;
  else result = RESULT.DRAW;
  const winnerId =
    result === RESULT.PLAYER1
      ? match.player1Id
      : result === RESULT.PLAYER2
        ? match.player2Id
        : null;
  return settle(match, result, winnerId, entry);
}

function resolveMatch(match, loserId, reason, entry) {
  // Any loser-based resolution (completed / banked_target / bust /
  // flag): loser loses, the other player wins.
  const winnerId = opponentOf(match, loserId);
  const result =
    winnerId === match.player1Id ? RESULT.PLAYER1 : RESULT.PLAYER2;
  return settle(match, result, winnerId, entry);
}

function settle(match, result, winnerId, entry) {
  const payout = computePayout({ stakeAmount: match.stakeAmount, result });
  match.status = MATCH_STATUS.FINISHED;
  match.currentTurnUserId = null;
  match.roundDeadline = null;
  match.result = result;
  match.winnerId = winnerId;
  match.prizePaid = payout.prizePaid;
  match.houseFee = payout.houseFee;
  match.p1Points = finalScoreOf(match, "player1");
  match.p2Points = finalScoreOf(match, "player2");
  match.endedAt = new Date();
  return match;
}

// AFK auto-pick (mirrors production forcePick, with an injectable
// path/tile so tests are deterministic).
function forcePick(match, { path, tile } = {}) {
  if (!PICKABLE_STATES.has(match.status)) return match;
  const userId = match.currentTurnUserId;
  if (!userId) return match;
  const seat = seatOf(match, userId);
  const lane = Number(seat === "player1" ? match.p1Lane : match.p2Lane) || 0;
  const pathKey =
    path || RISK_PATH_KEYS[Math.floor(Math.random() * RISK_PATH_KEYS.length)];
  const tower = seat === "player1" ? match.p1Tower : match.p2Tower;
  const laneLayout = tower[lane] || {};
  const badTile = Number(laneLayout[pathKey]);
  const idx =
    Number.isInteger(tile)
      ? tile
      : Math.floor(Math.random() * RISK_PATHS[pathKey].tiles);
  const entry = {
    userId,
    seat,
    action: "pick",
    path: pathKey,
    tile: idx,
    safe: idx !== badTile,
    lane,
    round: lane,
    points: idx !== badTile
      ? pickPointsForSeat(match, seat, lane, pathKey, match.difficulty)
      : 0,
    autoPicked: true,
    pending: true,
    at: new Date().toISOString(),
  };

  const pending = lastPendingAction(match);
  const pairComplete =
    pending !== null && pending.seat !== seat && Number(pending.round) === lane;
  const oppSeat = seat === "player1" ? "player2" : "player1";
  const oppEnded = climbEnded(match, oppSeat);

  if (pairComplete) {
    resolveRound(match, entry);
  } else if (oppEnded) {
    entry.pending = false;
    applyEntryImmediately(match, entry, seat);
  } else {
    parkPendingAction(match, entry, seat);
  }
  return match;
}

// ── Mirrors scrubMatchForViewer: pending entries are redacted, and
// the OPPONENT's peek details (tile + safe/bad answer) are stripped
// until the match finishes.
function scrubMatchForViewer(match, viewerUserId) {
  if (!match) return match;
  const finished = match.status === MATCH_STATUS.FINISHED;
  const viewerSeat =
    viewerUserId === match.player1Id
      ? "player1"
      : viewerUserId === match.player2Id
        ? "player2"
        : null;
  const actions = Array.isArray(match.actions)
    ? match.actions.map((a) => {
        if (a && a.pending === true) {
          return {
            action: "pending",
            userId: a.userId,
            seat: a.seat,
            lane: a.lane,
            round: a.round,
            pending: true,
            autoPicked: a.autoPicked === true,
            at: a.at,
          };
        }
        if (a && a.action === "peek" && a.seat !== viewerSeat && !finished) {
          return {
            action: "peek",
            userId: a.userId,
            seat: a.seat,
            lane: a.lane,
            round: a.round,
            pending: false,
            at: a.at,
          };
        }
        return a;
      })
    : match.actions;
  return {
    ...match,
    actions,
    p1Tower: finished ? match.p1Tower : null,
    p2Tower: finished ? match.p2Tower : null,
  };
}

// Helpers for building deterministic matches.
function startMatch({ matches, id = 1, firstPlayerId = "u1" } = {}) {
  const match = makeMatch({ id, player1Id: "u1", player2Id: "u2" });
  match.firstPlayerId = firstPlayerId;
  matches.set(id, match);
  advanceFromReady(match);
  return match;
}

// A tile that is GUARANTEED safe on `path` for `seat`'s current row.
function safeTile(match, seat, path = "balanced") {
  const lane = Number(seat === "player1" ? match.p1Lane : match.p2Lane) || 0;
  const tower = seat === "player1" ? match.p1Tower : match.p2Tower;
  const bad = Number(tower[lane][path]);
  return (bad + 1) % RISK_PATHS[path].tiles;
}

// The BAD tile on `path` for `seat`'s current row.
function badTile(match, seat, path = "balanced") {
  const lane = Number(seat === "player1" ? match.p1Lane : match.p2Lane) || 0;
  const tower = seat === "player1" ? match.p1Tower : match.p2Tower;
  return Number(tower[lane][path]);
}

function pick(userId, match, tile, path = "balanced") {
  return act({ userId, matchId: match.id, action: "pick", path, tileIndex: tile, matches: new Map([[match.id, match]]) });
}

// Climb a lone player (opponent's climb is over) with safe picks on
// `path` until their accumulated score reaches `minScore`, then BANK
// (which locks a banked total ≥ minScore — the 1,000-banked win).
// Returns the match (already resolved if the bank crossed the target).
function climbLoneToTarget(match, userId, minScore = WIN_BANKED_SCORE, path = "balanced") {
  const seat = seatOf(match, userId);
  let guard = 0;
  while (
    scoreFromActions(match.actions, seat) < minScore &&
    guard < MAX_LANES * 2 &&
    match.status !== MATCH_STATUS.FINISHED
  ) {
    pick(userId, match, safeTile(match, seat, path), path);
    guard += 1;
  }
  if (match.status !== MATCH_STATUS.FINISHED) {
    act({ userId, matchId: match.id, action: "hold", matches: new Map([[match.id, match]]) });
  }
  return match;
}

// ════════════════════════════════════════════════════════════════════════
// Shared tower
// ════════════════════════════════════════════════════════════════════════

test("shared tower: both seats climb the SAME layout from one client seed", () => {
  const match = makeMatch({ id: 1, player1Id: "u1", player2Id: "u2" });
  assert.deepEqual(match.p1Tower, match.p2Tower);
  assert.equal(match.p1ClientSeed, match.p2ClientSeed);
  assert.equal(match.p1Tower.length, MAX_LANES);
});

// ════════════════════════════════════════════════════════════════════════
// Deferred reveal — first action parks as pending
// ════════════════════════════════════════════════════════════════════════

test("first pick parks as pending: turn passes, nothing resolves, nothing leaks", () => {
  const matches = new Map();
  const match = startMatch({ matches });
  const tile = safeTile(match, "player1");

  const r = pick("u1", match, tile);
  assert.equal(r.error, undefined);
  assert.equal(match.actions.length, 1);
  assert.equal(match.actions[0].pending, true);
  assert.equal(match.actions[0].action, "pick");
  // The pick has NOT resolved yet: lane counters are unchanged.
  assert.equal(match.p1Lane, 0);
  assert.equal(match.p2Lane, 0);
  // Turn passed to the opponent with a fresh deadline.
  assert.equal(match.status, MATCH_STATUS.P2_TURN);
  assert.equal(match.currentTurnUserId, "u2");

  // The opponent (and the acting player's own refresh) see only a
  // redacted stub — no tile, path, safe, or points.
  const scrubbed = scrubMatchForViewer(match, "u2");
  assert.equal(scrubbed.actions.length, 1);
  const stub = scrubbed.actions[0];
  assert.equal(stub.action, "pending");
  assert.equal(stub.seat, "player1");
  assert.equal(stub.round, 0);
  assert.equal(stub.pending, true);
  assert.equal("tile" in stub, false);
  assert.equal("path" in stub, false);
  assert.equal("safe" in stub, false);
  assert.equal("points" in stub, false);
});

test("second pick resolves the pair: both advance together, first actor starts the next row", () => {
  const matches = new Map();
  const match = startMatch({ matches });
  const t1 = safeTile(match, "player1");
  const t2 = safeTile(match, "player2");

  pick("u1", match, t1);
  const r = pick("u2", match, t2);
  assert.equal(r.error, undefined);
  assert.equal(match.actions.length, 2);
  assert.ok(match.actions.every((a) => a.pending === false));
  assert.equal(match.p1Lane, 1);
  assert.equal(match.p2Lane, 1);
  // First actor (u1) starts the next row.
  assert.equal(match.status, MATCH_STATUS.P1_TURN);
  assert.equal(match.currentTurnUserId, "u1");
  assert.equal(match.result, null);
});

// ════════════════════════════════════════════════════════════════════════
// Busts are deferred — the row reveals together
// ════════════════════════════════════════════════════════════════════════

test("bust is deferred: P1 hits the bad tile but the match waits for P2's answer", () => {
  const matches = new Map();
  const match = startMatch({ matches });
  const bad = badTile(match, "player1");

  const r = pick("u1", match, bad);
  assert.equal(r.error, undefined);
  // NOT finished — the bust is parked and hidden.
  assert.notEqual(match.status, MATCH_STATUS.FINISHED);
  assert.equal(match.status, MATCH_STATUS.P2_TURN);
  assert.equal(match.actions[0].pending, true);
  // The scrub shows no safe flag for the parked bust.
  const scrubbed = scrubMatchForViewer(match);
  assert.equal("safe" in scrubbed.actions[0], false);

  // P2 survives the row → the bust is revealed, but the match is NOT
  // over: P2 hasn't banked 1,000, so they keep climbing on alone.
  const t2 = safeTile(match, "player2");
  pick("u2", match, t2);
  assert.equal(match.p1Lane, 0); // the busted player never advances
  assert.equal(match.status, MATCH_STATUS.P2_TURN);
  assert.equal(match.result, null);
  // P2 banking 16 does NOT settle — the race is to BANK 1,000. P2
  // climbs alone to 1,000 accumulated, banks → wins (P1 keeps 0).
  act({ userId: "u2", matchId: match.id, action: "hold", matches });
  assert.equal(match.status, MATCH_STATUS.P2_TURN); // still racing!
  climbLoneToTarget(match, "u2");
  assert.equal(match.status, MATCH_STATUS.FINISHED);
  assert.equal(match.result, RESULT.PLAYER2);
  assert.equal(match.winnerId, "u2");
});

test("both pick the bad tile on the same row → DRAW (full refund)", () => {
  const matches = new Map();
  const match = startMatch({ matches });
  pick("u1", match, badTile(match, "player1"));
  pick("u2", match, badTile(match, "player2"));

  assert.equal(match.status, MATCH_STATUS.FINISHED);
  assert.equal(match.result, RESULT.DRAW);
  assert.equal(match.winnerId, null);
  assert.equal(match.houseFee, 0);
  assert.equal(match.prizePaid, 0);
});

// ════════════════════════════════════════════════════════════════════════
// Flags are deferred too
// ════════════════════════════════════════════════════════════════════════

test("flag is deferred: a correct flag CLAIMS the row — not an instant win", () => {
  const matches = new Map();
  const match = startMatch({ matches });
  const bad = badTile(match, "player1");

  const r = act({
    userId: "u1",
    matchId: match.id,
    action: "flag",
    path: "balanced",
    tileIndex: bad,
    matches,
  });
  assert.equal(r.error, undefined);
  assert.equal(match.status, MATCH_STATUS.P2_TURN);
  assert.equal(match.actions[0].pending, true);
  // The parked flag is scrubbed — no flagCorrect/tile leaks.
  const scrubbed = scrubMatchForViewer(match);
  assert.equal("flagCorrect" in scrubbed.actions[0], false);
  assert.equal("tile" in scrubbed.actions[0], false);

  // P2 answers → the flag resolves: correct → P1 claims the row and
  // the game CONTINUES (the old instant-win is gone).
  pick("u2", match, safeTile(match, "player2"));
  assert.notEqual(match.status, MATCH_STATUS.FINISHED);
  assert.equal(match.p1Lane, 1);
  assert.equal(match.actions[0].flagCorrect, true);
  assert.equal(match.actions[0].safe, true);
  assert.equal(match.actions[0].tile, bad);
  // The claimed row scores points (treated like a safe pick).
  assert.equal(
    scoreFromActions(match.actions, "player1"),
    pointsForSafePick(0, "balanced", "easy"),
  );
  // First actor (u1) starts the next row.
  assert.equal(match.status, MATCH_STATUS.P1_TURN);
  assert.equal(match.currentTurnUserId, "u1");
});

test("wrong flag on pair resolution → flagger busts, opponent wins", () => {
  const matches = new Map();
  const match = startMatch({ matches });
  const safe = safeTile(match, "player1");

  act({
    userId: "u1",
    matchId: match.id,
    action: "flag",
    path: "balanced",
    tileIndex: safe,
    matches,
  });
  pick("u2", match, safeTile(match, "player2"));
  // The flagger busts but never banked — the match continues; P2 must
  // bank 1,000 to lock the win (banking 16 doesn't settle).
  assert.equal(match.status, MATCH_STATUS.P2_TURN);
  assert.equal(match.result, null);
  act({ userId: "u2", matchId: match.id, action: "hold", matches });
  assert.equal(match.status, MATCH_STATUS.P2_TURN); // still racing
  climbLoneToTarget(match, "u2");
  assert.equal(match.status, MATCH_STATUS.FINISHED);
  assert.equal(match.result, RESULT.PLAYER2);
  assert.equal(match.winnerId, "u2");
});

test("flag budget: a player can use at most 2 flags per match", () => {
  const matches = new Map();
  const match = startMatch({ matches });
  const flag = (tile) =>
    act({
      userId: "u1",
      matchId: match.id,
      action: "flag",
      path: "balanced",
      tileIndex: tile,
      matches,
    });
  const answer = () => pick("u2", match, safeTile(match, "player2"));

  // Flag 1: correct → claims row 0.
  assert.equal(flag(badTile(match, "player1")).error, undefined);
  answer();
  // Flag 2: correct → claims row 1.
  assert.equal(flag(badTile(match, "player1")).error, undefined);
  answer();
  // Flag 3: budget exhausted → rejected (and the row is untouched).
  const third = flag(badTile(match, "player1"));
  assert.equal(third.status, 400);
  assert.ok(/no flags left/i.test(third.error));
  assert.equal(match.p1Lane, 2);
});

test("flag budget: a used flag counts immediately, even while parked", () => {
  const matches = new Map();
  const match = startMatch({ matches });
  act({
    userId: "u1",
    matchId: match.id,
    action: "flag",
    path: "balanced",
    tileIndex: badTile(match, "player1"),
    matches,
  });
  // The raw history already counts the parked flag — the budget check
  // on the player's NEXT turn sees it.
  assert.equal(flagsUsedBySeat(match, "player1"), 1);
  assert.equal(match.actions[0].pending, true);
  // While the flag is parked it is not the player's turn, so they
  // cannot fire another one until the row resolves.
  const second = act({
    userId: "u1",
    matchId: match.id,
    action: "flag",
    path: "balanced",
    tileIndex: badTile(match, "player1"),
    matches,
  });
  assert.equal(second.status, 403);
});

// ════════════════════════════════════════════════════════════════════════
// Holds — chicken game
// ════════════════════════════════════════════════════════════════════════

test("soft bank: P1 banks, the pair resolves, and BOTH keep climbing — P1's picks pay 50%", () => {
  const matches = new Map();
  const match = startMatch({ matches });

  // P1 climbs row 0 on balanced (16 pts) → lane 1, then banks.
  pick("u1", match, safeTile(match, "player1"));
  pick("u2", match, safeTile(match, "player2"));
  act({ userId: "u1", matchId: match.id, action: "hold", matches });
  assert.equal(match.status, MATCH_STATUS.P2_TURN);
  assert.equal(match.actions[2].pending, true); // bank parked
  assert.equal(match.p1Held, false); // not applied until the pair resolves

  // P2 answers the row → the pair resolves together. Banking moves
  // P1 past the row they banked on, so both stay on the same row.
  pick("u2", match, safeTile(match, "player2"));
  assert.equal(match.p1Held, true);
  assert.equal(match.p1Lane, 2);
  assert.equal(match.p2Lane, 2);
  assert.equal(bankedScoreOf(match, "player1"), 16);
  // Banking does NOT end the climb — P1 gets the next turn.
  assert.equal(match.status, MATCH_STATUS.P1_TURN);
  assert.equal(match.currentTurnUserId, "u1");

  // P1's next pick pays HALF: lane 2 balanced = 64 × 0.5 = 32 pts.
  pick("u1", match, safeTile(match, "player1"));
  const last = match.actions[match.actions.length - 1];
  assert.equal(last.points, 32);
});

test("soft bank: re-banking stacks the rate penalty (25% after the 2nd bank)", () => {
  const matches = new Map();
  const match = startMatch({ matches });

  pick("u1", match, safeTile(match, "player1"));
  pick("u2", match, safeTile(match, "player2"));
  // Bank #1 (locks 16 pts), then bank #2 (locks the same 16 again).
  act({ userId: "u1", matchId: match.id, action: "hold", matches });
  pick("u2", match, safeTile(match, "player2"));
  act({ userId: "u1", matchId: match.id, action: "hold", matches });
  pick("u2", match, safeTile(match, "player2"));

  assert.equal(banksUsedBySeat(match, "player1"), 2);
  // Each bank moved P1 one row (they never picked): P1 faces row 3,
  // lane 3 balanced (128) pays 128 × 0.25 = 32.
  pick("u1", match, safeTile(match, "player1"));
  const last = match.actions[match.actions.length - 1];
  assert.equal(last.points, 32);
});

test("soft bank: busting WITH a bank keeps your banked total and the opponent climbs on alone", () => {
  const matches = new Map();
  const match = startMatch({ matches });

  // P1 banks 16, then busts on the next row — the match continues.
  pick("u1", match, safeTile(match, "player1"));
  pick("u2", match, safeTile(match, "player2"));
  act({ userId: "u1", matchId: match.id, action: "hold", matches });
  pick("u2", match, safeTile(match, "player2"));
  pick("u1", match, badTile(match, "player1")); // P1 busts WITH a bank

  assert.equal(match.p1Held, true);
  assert.equal(bankedScoreOf(match, "player1"), 16);
  assert.equal(match.status, MATCH_STATUS.P2_TURN); // not finished!
  // P2 climbs alone now — their pick resolves immediately.
  pick("u2", match, safeTile(match, "player2"));
  assert.equal(match.actions[match.actions.length - 1].pending, false);
  // P2 banking 16 does NOT settle: both have banked but neither is at
  // 1,000, so the 1,000-banked race continues.
  act({ userId: "u2", matchId: match.id, action: "hold", matches });
  assert.equal(match.status, MATCH_STATUS.P2_TURN); // still racing!
  // P2 climbs to 1,000 accumulated and banks → the race ends it.
  climbLoneToTarget(match, "u2");
  assert.equal(match.status, MATCH_STATUS.FINISHED);
  assert.equal(match.result, RESULT.PLAYER2);
  assert.equal(match.winnerId, "u2");
});

test("soft bank: busting WITHOUT a bank loses your points — the survivor banks to win", () => {
  const matches = new Map();
  const match = startMatch({ matches });

  pick("u1", match, safeTile(match, "player1")); // u1: 16 pts, no bank
  pick("u2", match, badTile(match, "player2")); // u2 busts, no bank

  // Not settled: u1 hasn't banked 1,000 and u2 never banked — u1
  // climbs on alone.
  assert.equal(match.status, MATCH_STATUS.P1_TURN);
  assert.equal(match.result, null);
  // u1 banking 16 does NOT settle — the race to 1,000 banked
  // continues. u2's unbanked points are gone forever.
  act({ userId: "u1", matchId: match.id, action: "hold", matches });
  assert.equal(match.status, MATCH_STATUS.P1_TURN); // still racing!
  // u1 climbs alone to 1,000 accumulated, banks → wins. u2 keeps 0.
  climbLoneToTarget(match, "u1");
  assert.equal(match.status, MATCH_STATUS.FINISHED);
  assert.equal(match.result, RESULT.PLAYER1);
  assert.equal(match.winnerId, "u1");
  assert.equal(match.p2Points, 0);
});

test("soft bank: both bust on the same row with no banks → DRAW (0 vs 0)", () => {
  const matches = new Map();
  const match = startMatch({ matches });
  pick("u1", match, badTile(match, "player1"));
  pick("u2", match, badTile(match, "player2"));
  assert.equal(match.status, MATCH_STATUS.FINISHED);
  assert.equal(match.result, RESULT.DRAW);
  assert.equal(match.winnerId, null);
  assert.equal(match.p1Points, 0);
  assert.equal(match.p2Points, 0);
});

test("soft bank: banking the last row does NOT complete the tower", () => {
  const matches = new Map();
  const match = startMatch({ matches });
  // Walk both players to the last row, then u1 banks instead of
  // climbing it. Without the cap the bank would complete u1 (instant
  // win); with it, only u2's actual climb to the top wins.
  for (let row = 0; row < MAX_LANES - 1; row += 1) {
    pick("u1", match, safeTile(match, "player1"));
    pick("u2", match, safeTile(match, "player2"));
  }
  assert.equal(match.p1Lane, MAX_LANES - 1);
  act({ userId: "u1", matchId: match.id, action: "hold", matches });
  pick("u2", match, safeTile(match, "player2"));
  // The hold NEVER completes the tower — u1's lane is capped. But the
  // bank locks 1,920 ≥ 1,000, so u1 wins the 1,000-banked race (this
  // is checked BEFORE completion in afterRound).
  assert.equal(match.p1Lane, MAX_LANES - 1); // capped — bank never completes
  assert.equal(match.status, MATCH_STATUS.FINISHED);
  assert.equal(match.result, RESULT.PLAYER1); // u1 won the 1,000 race
  assert.equal(match.winnerId, "u1");
});

// ════════════════════════════════════════════════════════════════════════
// Peek — private, instant, budgeted
// ════════════════════════════════════════════════════════════════════════

test("peek is instant + private: reveals the answer and keeps the turn", () => {
  const matches = new Map();
  const match = startMatch({ matches });
  const bad = badTile(match, "player1");

  const r = act({
    userId: "u1",
    matchId: match.id,
    action: "peek",
    path: "balanced",
    tileIndex: bad,
    matches,
  });
  assert.equal(r.error, undefined);
  const peek = match.actions[match.actions.length - 1];
  assert.equal(peek.action, "peek");
  assert.equal(peek.pending, false);
  assert.equal(peek.peekResult, "bad");
  assert.equal(peek.points, undefined);
  // No advancement, no turn change — still u1's turn.
  assert.equal(match.p1Lane, 0);
  assert.equal(match.status, MATCH_STATUS.P1_TURN);
  assert.equal(match.currentTurnUserId, "u1");
});

test("peek: the opponent sees only that you peeked — not the tile or answer", () => {
  const matches = new Map();
  const match = startMatch({ matches });
  const safe = safeTile(match, "player1", "risky");
  act({
    userId: "u1",
    matchId: match.id,
    action: "peek",
    path: "risky",
    tileIndex: safe,
    matches,
  });

  const opponentView = scrubMatchForViewer(match, "u2");
  const oppPeek = opponentView.actions[opponentView.actions.length - 1];
  assert.equal(oppPeek.action, "peek");
  assert.equal(oppPeek.seat, "player1");
  assert.equal("peekResult" in oppPeek, false);
  assert.equal("tile" in oppPeek, false);
  assert.equal("path" in oppPeek, false);

  // The viewer's own view keeps the full answer.
  const selfView = scrubMatchForViewer(match, "u1");
  const myPeek = selfView.actions[selfView.actions.length - 1];
  assert.equal(myPeek.peekResult, "safe");
  assert.equal(myPeek.tile, safe);
  assert.equal(myPeek.path, "risky");
});

test("peek budget: at most 2 peeks per match", () => {
  const matches = new Map();
  const match = startMatch({ matches });
  const safe = safeTile(match, "player1");
  const peek = () =>
    act({
      userId: "u1",
      matchId: match.id,
      action: "peek",
      path: "balanced",
      tileIndex: safe,
      matches,
    });
  assert.equal(peek().error, undefined);
  assert.equal(peek().error, undefined);
  assert.equal(peeksUsedBySeat(match, "player1"), 2);
  const third = peek();
  assert.equal(third.status, 400);
  assert.ok(/no peeks left/i.test(third.error));
});

test("peek then pick: the info turns a coin-flip risky row into a sure climb", () => {
  const matches = new Map();
  const match = startMatch({ matches });
  const bad = badTile(match, "player1", "risky");
  const other = bad === 0 ? 1 : 0;

  // Peek the risky bad tile, then pick the OTHER tile on the same turn.
  act({
    userId: "u1",
    matchId: match.id,
    action: "peek",
    path: "risky",
    tileIndex: bad,
    matches,
  });
  const r = pick("u1", match, other, "risky");
  assert.equal(r.error, undefined);
  const pickEntry = match.actions[match.actions.length - 1];
  assert.equal(pickEntry.safe, true);
  assert.equal(pickEntry.points, pointsForSafePick(0, "risky", "easy"));
  // The pair still resolves with the opponent normally.
  pick("u2", match, safeTile(match, "player2"));
  assert.equal(match.p1Lane, 1);
  assert.equal(match.p2Lane, 1);
  assert.equal(match.status, MATCH_STATUS.P1_TURN);
});

test("peek does not disturb the opponent's parked pick", () => {
  const matches = new Map();
  const match = startMatch({ matches });
  pick("u1", match, safeTile(match, "player1")); // parks (round 0)

  // u2 peeks (their turn) — instant, then answers the row normally.
  const r = act({
    userId: "u2",
    matchId: match.id,
    action: "peek",
    path: "balanced",
    tileIndex: safeTile(match, "player2"),
    matches,
  });
  assert.equal(r.error, undefined);
  assert.equal(match.actions.length, 2);
  assert.equal(match.actions[0].pending, true); // u1's pick still parked
  assert.equal(match.status, MATCH_STATUS.P2_TURN); // still u2's turn

  pick("u2", match, safeTile(match, "player2"));
  assert.equal(match.actions.length, 3);
  assert.ok(match.actions.every((a) => a.pending === false));
  assert.equal(match.p1Lane, 1);
  assert.equal(match.p2Lane, 1);
});

test("both hold below 1,000 → the race continues (banking never settles)", () => {
  const matches = new Map();
  const match = startMatch({ matches });
  // P1 climbs risky (25 pts on row 0), P2 climbs balanced (16 pts).
  pick("u1", match, safeTile(match, "player1", "risky"), "risky");
  pick("u2", match, safeTile(match, "player2", "balanced"), "balanced");

  act({ userId: "u1", matchId: match.id, action: "hold", matches });
  act({ userId: "u2", matchId: match.id, action: "hold", matches });

  // Neither banked 1,000 → NO settlement; both keep racing.
  assert.notEqual(match.status, MATCH_STATUS.FINISHED);
  assert.equal(match.result, null);
  assert.equal(bankedScoreOf(match, "player1"), 25);
  assert.equal(bankedScoreOf(match, "player2"), 16);
  // Both keep climbing at reduced rates; first actor starts the row.
  assert.equal(match.status, MATCH_STATUS.P1_TURN);
  assert.equal(match.currentTurnUserId, "u1");
});

test("first to BANK 1,000 wins the race instantly", () => {
  const matches = new Map();
  const match = startMatch({ matches });
  // Both climb 6 risky rows: 25+50+100+200+375+750 = 1,500 accumulated.
  for (let row = 0; row < 6; row += 1) {
    pick("u1", match, safeTile(match, "player1", "risky"), "risky");
    pick("u2", match, safeTile(match, "player2", "risky"), "risky");
  }
  assert.equal(scoreFromActions(match.actions, "player1"), 1500);

  // u1 banks 1,500 → the hold parks (deferred reveal) until u2
  // answers the row; the pair resolves together.
  act({ userId: "u1", matchId: match.id, action: "hold", matches });
  assert.equal(match.status, MATCH_STATUS.P2_TURN); // parked, awaiting u2
  pick("u2", match, safeTile(match, "player2", "risky"), "risky");

  // Crossing the 1,000 target is an INSTANT win — even though u2
  // also has 1,500 accumulated (but unbanked).
  assert.equal(match.status, MATCH_STATUS.FINISHED);
  assert.equal(match.result, RESULT.PLAYER1);
  assert.equal(match.winnerId, "u1");
  assert.equal(bankedScoreOf(match, "player1"), 1500);
  // u1's kept final = their banked 1,500; u2 never busted so their
  // final is their accumulated score — but the POT goes to u1, the
  // first to bank 1,000.
  assert.equal(match.p1Points, 1500);
  assert.equal(match.p2Points, 3000);
  assert.equal(match.winnerId, "u1");
});

// ════════════════════════════════════════════════════════════════════════
// Completion
// ════════════════════════════════════════════════════════════════════════

test("both climb all 8 rows safely → both done → scores decide", () => {
  const matches = new Map();
  const match = startMatch({ matches });
  for (let row = 0; row < MAX_LANES; row += 1) {
    pick("u1", match, safeTile(match, "player1", "safe"), "safe");
    pick("u2", match, safeTile(match, "player2", "safe"), "safe");
  }
  assert.equal(match.status, MATCH_STATUS.FINISHED);
  assert.equal(match.p1Lane, MAX_LANES);
  assert.equal(match.p2Lane, MAX_LANES);
  // Same path, same rows → identical scores → DRAW.
  assert.equal(match.result, RESULT.DRAW);
  assert.equal(match.winnerId, null);
});

// ════════════════════════════════════════════════════════════════════════
// AFK force-pick
// ════════════════════════════════════════════════════════════════════════

test("AFK: force-pick on the first actor parks and hands the turn over", () => {
  const matches = new Map();
  const match = startMatch({ matches });
  forcePick(match, { path: "balanced", tile: safeTile(match, "player1") });
  assert.equal(match.actions.length, 1);
  assert.equal(match.actions[0].autoPicked, true);
  assert.equal(match.actions[0].pending, true);
  assert.equal(match.status, MATCH_STATUS.P2_TURN);
  assert.equal(match.p1Lane, 0);
});

test("AFK: force-pick completes a parked pair", () => {
  const matches = new Map();
  const match = startMatch({ matches });
  pick("u1", match, safeTile(match, "player1"));
  forcePick(match, { path: "balanced", tile: safeTile(match, "player2") });
  assert.equal(match.actions.length, 2);
  assert.equal(match.p1Lane, 1);
  assert.equal(match.p2Lane, 1);
  assert.equal(match.status, MATCH_STATUS.P1_TURN);
});

test("AFK force-pick can bust — the survivor must bank 1,000 to win", () => {
  const matches = new Map();
  const match = startMatch({ matches });
  // u1 parks a safe pick, then u2 times out and is force-picked onto
  // the bad tile → u2 busts with no bank.
  pick("u1", match, safeTile(match, "player1"));
  forcePick(match, { path: "balanced", tile: badTile(match, "player2") });
  assert.equal(match.actions[1].autoPicked, true);
  // Not settled — u1 climbs on alone.
  assert.equal(match.status, MATCH_STATUS.P1_TURN);
  assert.equal(match.result, null);
  // u1 banking 16 does NOT settle — they must bank 1,000 to win.
  act({ userId: "u1", matchId: match.id, action: "hold", matches });
  assert.equal(match.status, MATCH_STATUS.P1_TURN); // still racing!
  climbLoneToTarget(match, "u1");
  assert.equal(match.status, MATCH_STATUS.FINISHED);
  assert.equal(match.result, RESULT.PLAYER1);
  assert.equal(match.winnerId, "u1");
});

// ════════════════════════════════════════════════════════════════════════
// Validation + turn enforcement (spot checks)
// ════════════════════════════════════════════════════════════════════════

test("act: rejects when it is not your turn", () => {
  const matches = new Map();
  const match = startMatch({ matches });
  const r = pick("u2", match, safeTile(match, "player2"));
  assert.equal(r.status, 403);
  assert.ok(/not your turn/i.test(r.error));
});

test("act: a BANKED player can still act (banking never ends the climb)", () => {
  const matches = new Map();
  const match = startMatch({ matches });
  pick("u1", match, safeTile(match, "player1"));
  pick("u2", match, safeTile(match, "player2"));
  act({ userId: "u1", matchId: match.id, action: "hold", matches });
  pick("u2", match, safeTile(match, "player2"));
  // u1 banked but is NOT done — they keep their next turn and act.
  assert.equal(match.status, MATCH_STATUS.P1_TURN);
  const r = pick("u1", match, safeTile(match, "player1"));
  assert.equal(r.error, undefined);
  // Banking moved P1 past the banked row: lane 2 balanced = 64 pts
  // at the 50% rate.
  assert.equal(match.actions[match.actions.length - 1].points, 32);
});

test("act: rejects when your climb is over (busted)", () => {
  const matches = new Map();
  const match = startMatch({ matches });
  pick("u1", match, safeTile(match, "player1"));
  pick("u2", match, badTile(match, "player2")); // u2 busts
  assert.equal(match.status, MATCH_STATUS.P1_TURN);
  // Force a stale state where it IS u2's turn — the ended-guard
  // rejects the act.
  match.status = MATCH_STATUS.P2_TURN;
  match.currentTurnUserId = "u2";
  match.roundDeadline = new Date(Date.now() + 60_000);
  const r = pick("u2", match, safeTile(match, "player2"));
  assert.equal(r.status, 400);
  assert.ok(/climb is over/i.test(r.error));
});

test("act: rejects an invalid tile index for the chosen path", () => {
  const matches = new Map();
  const match = startMatch({ matches });
  // Risky path has 2 tiles; index 2 is out of range.
  const r = act({
    userId: "u1",
    matchId: match.id,
    action: "pick",
    path: "risky",
    tileIndex: 2,
    matches,
  });
  assert.equal(r.status, 400);
  assert.ok(/invalid tile index/i.test(r.error));
});

test("bot matches share the tower too (seat 2 is the bot id)", () => {
  const match = makeMatch({ id: 9, player1Id: "u1", player2Id: BOT_USER_ID });
  assert.deepEqual(match.p1Tower, match.p2Tower);
});
