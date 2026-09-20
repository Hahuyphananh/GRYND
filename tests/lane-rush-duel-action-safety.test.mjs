/**
 * Lane Rush Duel — player-action safety tests.
 *
 * The core rule the whole game turns on is: BANKED POINTS ARE SAFE.
 * A red (bad) tile only clears the seat's CURRENT UNBANKED run — it
 * never touches the banked total and never ends the duel.
 *
 * These tests drive the pure helpers the server transition is built
 * from (`scoreFromActions` / `bankedScoreOf` / `unbankedOf` for the
 * banked vs unbanked split, `bankedWinnerOf` / `climbEnded` for the
 * terminal conditions, `hasResolvedActionId` for duplicate-action
 * idempotency, `isStaleRoundAction` for stale clicks, and
 * `releasePendingActions` for legacy action recovery) against an
 * in-memory mirror of the single server transition (same pattern as
 * `lane-rush-duel-flow.test.mjs` — the DB-backed store itself is
 * covered by the build + the production flow).
 *
 * Run:  node --import tsx --test tests/lane-rush-duel-action-safety.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  BOT_USER_ID,
  MATCH_STATUS,
  MAX_LANES,
  PICKABLE_STATES,
  RISK_PATHS,
  WIN_BANKED_SCORE,
  bankedScoreOf,
  bankedWinnerOf,
  buildPlayerTower,
  bustsByLaneForSeat,
  climbEnded,
  decideBotAction,
  hasResolvedActionId,
  isStaleRoundAction,
  latestBustFor,
  pickPointsForSeat,
  releasePendingActions,
  scoreFromActions,
  unbankedOf,
} from "../src/lib/lane-rush-duel/constants.js";

// ════════════════════════════════════════════════════════════════════
// In-memory mirror of the server transition (applyEntryImmediately)
// ════════════════════════════════════════════════════════════════════

function makeMatch({ id = 1, difficulty = "easy", opponent = "u2" } = {}) {
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
    player1Id: "u1",
    player2Id: opponent,
    difficulty,
    stakeAmount: 100,
    status: MATCH_STATUS.ACTIVE,
    currentTurnUserId: null,
    roundDeadline: null,
    p1Lane: 0,
    p2Lane: 0,
    p1Held: false,
    p2Held: false,
    p1Tower: tower,
    p2Tower: tower,
    actions: [],
  };
}

function seatOf(match, userId) {
  return userId === match.player1Id ? "player1" : "player2";
}

function laneOf(match, seat) {
  return Number(seat === "player1" ? match.p1Lane : match.p2Lane) || 0;
}

function towerOf(match, seat) {
  return seat === "player1" ? match.p1Tower : match.p2Tower;
}

function badTile(match, userId, path = "balanced") {
  const seat = seatOf(match, userId);
  return towerOf(match, seat)[laneOf(match, seat)][path];
}

function safeTile(match, userId, path = "balanced") {
  return (badTile(match, userId, path) + 1) % RISK_PATHS[path].tiles;
}

// One resolved action: exactly what the server's single transition does
// (validate → resolve tile → update unbanked/banked → decide whether
// the duel actually ended).
function act(
  match,
  userId,
  action,
  { path = "balanced", tile = 0, actionId = null } = {},
) {
  const seat = seatOf(match, userId);
  const laneField = seat === "player1" ? "p1Lane" : "p2Lane";
  const heldField = seat === "player1" ? "p1Held" : "p2Held";
  const lane = laneOf(match, seat);

  // Idempotency: the same actionId can never resolve twice (checked
  // before tile validation, exactly like the server does).
  if (hasResolvedActionId(match.actions, actionId)) {
    return { duplicate: true, entry: null, match };
  }

  const entry = {
    userId,
    seat,
    action,
    lane,
    round: lane,
    pending: false,
    autoPicked: false,
    at: "2026-01-01T00:00:00.000Z",
  };
  if (actionId != null) entry.actionId = String(actionId);

  if (action === "hold") {
    entry.bankedTotal = scoreFromActions(match.actions, seat);
    match[heldField] = true;
    match[laneField] = (lane + 1) % MAX_LANES;
    // The ONLY terminal player action: banking the win target.
    if (Number(entry.bankedTotal) >= WIN_BANKED_SCORE) {
      match.status = MATCH_STATUS.FINISHED;
      match.winnerId = userId;
    }
  } else {
    const bad = towerOf(match, seat)[lane][path];
    entry.path = path;
    entry.tile = tile;
    entry.safe = tile !== bad;
    entry.points = entry.safe
      ? pickPointsForSeat(match, seat, lane, path, match.difficulty)
      : 0;
    // A safe pick advances; a BUST stays on the row and consumes none
    // of the banked total (it never ends the duel either).
    if (entry.safe) match[laneField] = (lane + 1) % MAX_LANES;
  }

  match.actions.push(entry);
  return { duplicate: false, entry, match };
}

function bank(match, userId, actionId = null) {
  return act(match, userId, "hold", { actionId });
}

// ════════════════════════════════════════════════════════════════════
// 1-2. Safe pick grows the UNBANKED run
// ════════════════════════════════════════════════════════════════════

test("safe tile increases the unbanked run only", () => {
  const match = makeMatch();
  act(match, "u1", "pick", { tile: safeTile(match, "u1") });

  assert.ok(scoreFromActions(match.actions, "player1") > 0);
  assert.equal(bankedScoreOf(match, "player1"), 0);
  assert.equal(unbankedOf(match, "player1"), scoreFromActions(match.actions, "player1"));
});

test("safe tile after a bank still only grows the unbanked run", () => {
  const match = makeMatch();
  act(match, "u1", "pick", { tile: safeTile(match, "u1") });
  const banked = bank(match, "u1").entry.bankedTotal;

  // The banked player keeps climbing (banking never ends the climb).
  assert.equal(match.status, MATCH_STATUS.ACTIVE);
  act(match, "u1", "pick", { tile: safeTile(match, "u1") });

  assert.equal(bankedScoreOf(match, "player1"), banked);
  assert.ok(unbankedOf(match, "player1") > 0);
  assert.equal(
    scoreFromActions(match.actions, "player1"),
    banked + unbankedOf(match, "player1"),
  );
});

// ════════════════════════════════════════════════════════════════════
// 3-6. A RED tile clears the unbanked run and NOTHING else
// ════════════════════════════════════════════════════════════════════

test("red tile sets the unbanked run to zero", () => {
  const match = makeMatch();
  act(match, "u1", "pick", { tile: safeTile(match, "u1") });
  assert.ok(unbankedOf(match, "player1") > 0);

  const bust = act(match, "u1", "pick", { tile: badTile(match, "u1") });

  assert.equal(bust.entry.safe, false);
  assert.equal(bust.entry.points, 0);
  assert.equal(unbankedOf(match, "player1"), 0);
  assert.equal(scoreFromActions(match.actions, "player1"), 0);
});

test("red tile does NOT modify the banked total", () => {
  const match = makeMatch();
  act(match, "u1", "pick", { tile: safeTile(match, "u1") });
  const banked = bank(match, "u1").entry.bankedTotal;

  // Keep climbing so the bust has an at-risk run to destroy.
  act(match, "u1", "pick", { tile: safeTile(match, "u1") });
  assert.ok(unbankedOf(match, "player1") > 0);

  act(match, "u1", "pick", { tile: badTile(match, "u1") });

  assert.equal(bankedScoreOf(match, "player1"), banked);
  assert.equal(unbankedOf(match, "player1"), 0);
  assert.equal(scoreFromActions(match.actions, "player1"), banked);
});

test("red tile does NOT end the duel", () => {
  const match = makeMatch();
  act(match, "u1", "pick", { tile: safeTile(match, "u1") });
  bank(match, "u1");
  const laneBeforeBust = laneOf(match, "player1");

  act(match, "u1", "pick", { tile: badTile(match, "u1") });

  assert.equal(match.status, MATCH_STATUS.ACTIVE);
  assert.ok(PICKABLE_STATES.has(match.status));
  assert.equal(match.winnerId, undefined);
  assert.equal(climbEnded(match, "player1"), false);
  assert.equal(climbEnded(match, "player2"), false);
  assert.equal(bankedWinnerOf(match), null);

  // The seat stays on the row it busted on and can immediately play on.
  assert.equal(laneOf(match, "player1"), laneBeforeBust);
  assert.ok(PICKABLE_STATES.has(match.status));
});

test("a bust by one seat does not touch the opponent's run or lane", () => {
  const match = makeMatch();
  act(match, "u2", "pick", { tile: safeTile(match, "u2") });
  const oppScore = scoreFromActions(match.actions, "player2");
  const oppLane = laneOf(match, "player2");

  act(match, "u1", "pick", { tile: badTile(match, "u1") });

  assert.equal(scoreFromActions(match.actions, "player2"), oppScore);
  assert.equal(laneOf(match, "player2"), oppLane);
  assert.equal(match.status, MATCH_STATUS.ACTIVE);
});

// ════════════════════════════════════════════════════════════════════
// 7-8. Banking transfers unbanked → banked; red straight after a bank
//       preserves the banked amount
// ════════════════════════════════════════════════════════════════════

test("banking transfers the unbanked run into the banked total and resets it", () => {
  const match = makeMatch();
  act(match, "u1", "pick", { tile: safeTile(match, "u1") });
  act(match, "u1", "pick", { tile: safeTile(match, "u1") });
  const earned = unbankedOf(match, "player1");
  assert.ok(earned > 0);

  const entry = bank(match, "u1").entry;

  assert.equal(entry.bankedTotal, earned);
  assert.equal(bankedScoreOf(match, "player1"), earned);
  assert.equal(unbankedOf(match, "player1"), 0);
});

test("red tile after banking preserves the protected banked amount", () => {
  const match = makeMatch();
  act(match, "u1", "pick", { tile: safeTile(match, "u1") });
  const banked = bank(match, "u1").entry.bankedTotal;
  assert.ok(banked > 0);

  // Bank, then keep climbing and bust.
  act(match, "u1", "pick", { tile: safeTile(match, "u1") });
  act(match, "u1", "pick", { tile: badTile(match, "u1") });

  assert.equal(bankedScoreOf(match, "player1"), banked);
  assert.equal(scoreFromActions(match.actions, "player1"), banked);
  assert.equal(match.status, MATCH_STATUS.ACTIVE);
});

// ════════════════════════════════════════════════════════════════════
// 9. The AI cannot declare victory because the player hit red
// ════════════════════════════════════════════════════════════════════

test("a player bust can never produce a winner, and the bot keeps playing", () => {
  const match = makeMatch({ id: 9, opponent: BOT_USER_ID });
  act(match, "u1", "pick", { tile: safeTile(match, "u1") });
  bank(match, "u1");
  act(match, "u1", "pick", { tile: badTile(match, "u1") });

  // No resolution path fires: nobody banked the target, no climb ends.
  assert.equal(bankedWinnerOf(match), null);
  assert.equal(climbEnded(match, "player1"), false);
  assert.equal(climbEnded(match, "player2"), false);
  assert.equal(match.status, MATCH_STATUS.ACTIVE);

  // The bot's next decision is a normal climb/bank decision — it never
  // converts the player's bust into a claim.
  const decision = decideBotAction(match, { random: () => 0.5 });
  assert.ok(decision);
  assert.ok(["pick", "hold"].includes(decision.action));
  assert.equal(match.status, MATCH_STATUS.ACTIVE);
  assert.equal(match.winnerId, undefined);
});

test("only a banked total at the target settles the duel", () => {
  const match = makeMatch();
  match.actions = [
    { action: "pick", seat: "player1", safe: true, points: 999, lane: 0 },
  ];
  assert.equal(bankedWinnerOf(match), null); // 999 unbanked ≠ win
  assert.equal(match.status, MATCH_STATUS.ACTIVE);

  // ...and a bust on top of it clears the run without settling.
  act(match, "u1", "pick", { tile: badTile(match, "u1") });
  assert.equal(bankedWinnerOf(match), null);
  assert.equal(match.status, MATCH_STATUS.ACTIVE);
});

// ════════════════════════════════════════════════════════════════════
// 10. Duplicate actions cannot resolve twice
// ════════════════════════════════════════════════════════════════════

test("duplicate tile clicks with the same actionId cannot resolve twice", () => {
  const match = makeMatch();
  const first = act(match, "u1", "pick", {
    tile: safeTile(match, "u1"),
    actionId: "match1:player1:100:1",
  });
  const scoreAfterFirst = scoreFromActions(match.actions, "player1");

  const second = act(match, "u1", "pick", {
    tile: safeTile(match, "u1"),
    actionId: "match1:player1:100:1",
  });

  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(match.actions.length, 1);
  assert.equal(scoreFromActions(match.actions, "player1"), scoreAfterFirst);
});

test("a distinct actionId still resolves (the guard is per-action, not global)", () => {
  const match = makeMatch();
  act(match, "u1", "pick", { tile: safeTile(match, "u1"), actionId: "a-1" });
  act(match, "u1", "pick", { tile: safeTile(match, "u1"), actionId: "a-2" });
  assert.equal(match.actions.length, 2);
});

test("hasResolvedActionId ignores blank / legacy ids", () => {
  const actions = [{ seat: "player1", action: "pick", safe: true }];
  assert.equal(hasResolvedActionId(actions, null), false);
  assert.equal(hasResolvedActionId(actions, ""), false);
  assert.equal(hasResolvedActionId(actions, undefined), false);
  assert.equal(hasResolvedActionId(actions, "anything"), false);
  assert.equal(hasResolvedActionId([{ actionId: 7 }], 7), true);
  assert.equal(hasResolvedActionId(null, "7"), false);
});

test("a bot wake-up id is deduped the same way", () => {
  const actions = [{ seat: "player2", action: "pick", actionId: "m:bot:1:0:1" }];
  assert.equal(hasResolvedActionId(actions, "m:bot:1:0:1"), true);
  assert.equal(hasResolvedActionId(actions, "m:bot:1:0:2"), false);
});

// ════════════════════════════════════════════════════════════════════
// 11. A stale click cannot resolve against a newer row
// ════════════════════════════════════════════════════════════════════

test("isStaleRoundAction rejects a click rendered against an older row", () => {
  // Player acted at row 3 → the seat is now on row 4.
  assert.equal(isStaleRoundAction({ expectedRound: 3, currentLane: 4 }), true);
  assert.equal(isStaleRoundAction({ expectedRound: 4, currentLane: 4 }), false);
  // Legacy / AFK / bot callers send no row — never stale.
  assert.equal(isStaleRoundAction({ expectedRound: null, currentLane: 4 }), false);
  assert.equal(isStaleRoundAction({ expectedRound: undefined, currentLane: 4 }), false);
  assert.equal(isStaleRoundAction({ expectedRound: "nope", currentLane: 4 }), false);
});

test("an outdated async response/click cannot overwrite a newer player state", () => {
  const match = makeMatch();
  // Player resolves at row 0 → state moves to row 1.
  act(match, "u1", "pick", { tile: safeTile(match, "u1"), actionId: "p-1" });
  const laneAfter = laneOf(match, "player1");
  const stateAfter = unbankedOf(match, "player1");

  // A response computed back when the seat was on row 0:
  const stale = isStaleRoundAction({ expectedRound: 0, currentLane: laneAfter });
  assert.equal(stale, true);

  // ...and a replay of the same action is a no-op too.
  const replay = act(match, "u1", "pick", {
    tile: safeTile(match, "u1"),
    actionId: "p-1",
  });
  assert.equal(replay.duplicate, true);
  assert.equal(laneOf(match, "player1"), laneAfter);
  assert.equal(unbankedOf(match, "player1"), stateAfter);
});

// ════════════════════════════════════════════════════════════════════
// 12. Bust feedback + legacy pending recovery
// ════════════════════════════════════════════════════════════════════

test("bustsByLaneForSeat marks the busted row and clears on a later safe pick", () => {
  const match = makeMatch();
  act(match, "u1", "pick", { tile: badTile(match, "u1") });

  const markers = bustsByLaneForSeat(match.actions, "player1");
  assert.ok(markers[0]);
  assert.equal(markers[0].tile, towerOf(match, "player1")[0].balanced);

  // Surviving the same row clears the marker (the row is resolved).
  act(match, "u1", "pick", { tile: safeTile(match, "u1") });
  assert.equal(bustsByLaneForSeat(match.actions, "player1")[0], undefined);
});

test("latestBustFor reports a live bust and resets after a later safe row", () => {
  const match = makeMatch();
  act(match, "u1", "pick", { tile: badTile(match, "u1") });
  assert.equal(latestBustFor(match.actions, "player1").safe, false);
  assert.equal(latestBustFor(match.actions, "player2"), null);

  act(match, "u1", "pick", { tile: safeTile(match, "u1") });
  assert.equal(latestBustFor(match.actions, "player1"), null);
});

test("releasePendingActions un-hides a stranded legacy parked action", () => {
  const actions = [
    { seat: "player1", action: "pick", safe: true, points: 10, pending: true },
    { seat: "player2", action: "pick", safe: true, points: 10, pending: false },
  ];
  const released = releasePendingActions(actions);

  assert.equal(released[0].pending, false);
  assert.equal(released[1].pending, false);
  // The original history is not mutated.
  assert.equal(actions[0].pending, true);
  assert.equal(releasePendingActions(null), null);
});

test("unbankedOf is never negative", () => {
  const match = makeMatch();
  act(match, "u1", "pick", { tile: badTile(match, "u1") });
  assert.equal(unbankedOf(match, "player1"), 0);
  assert.equal(unbankedOf(null, "player1"), 0);
  assert.equal(unbankedOf({ actions: [] }, "player1"), 0);
});
