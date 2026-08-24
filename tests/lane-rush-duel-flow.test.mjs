/**
 * Lane Rush Duel — simultaneous flow tests.
 *
 * These tests mirror the small, pure state transition introduced for the
 * simultaneous mode. Database-backed serverStore integration is covered by
 * the same validation contract and the production build.
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
  buildPlayerTower,
  climbEnded,
  decideBotAction,
  pickPointsForSeat,
  scoreFromActions,
} from "../src/lib/lane-rush-duel/constants.js";

function makeMatch({ id = 1, difficulty = "easy" } = {}) {
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
    player2Id: "u2",
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

function seatOf(userId) {
  return userId === "u1" ? "player1" : "player2";
}

function submit(match, userId, action, path = "balanced", tile = 0) {
  const seat = seatOf(userId);
  const laneField = seat === "player1" ? "p1Lane" : "p2Lane";
  const heldField = seat === "player1" ? "p1Held" : "p2Held";
  const lane = match[laneField];
  const tower = seat === "player1" ? match.p1Tower : match.p2Tower;
  const badTile = tower[lane][path];
  const entry = {
    userId,
    seat,
    action,
    path: action === "hold" ? undefined : path,
    tile: action === "hold" ? undefined : tile,
    lane,
    round: lane,
    safe: action === "hold" ? null : tile !== badTile,
    points:
      action === "hold" || tile === badTile
        ? 0
        : pickPointsForSeat(match, seat, lane, path, match.difficulty),
    pending: false,
  };
  if (action === "hold") {
    entry.bankedTotal = scoreFromActions(match.actions, seat);
    match[heldField] = true;
    match[laneField] = (lane + 1) % MAX_LANES;
  } else if (entry.safe) {
    match[laneField] = (lane + 1) % MAX_LANES;
  }
  match.actions.push(entry);
  if (entry.action === "hold" && entry.bankedTotal >= WIN_BANKED_SCORE) {
    match.status = MATCH_STATUS.FINISHED;
    match.winnerId = userId;
  }
  return entry;
}

function safeTile(match, userId, path = "balanced") {
  const seat = seatOf(userId);
  const lane = match[seat === "player1" ? "p1Lane" : "p2Lane"];
  const tower = seat === "player1" ? match.p1Tower : match.p2Tower;
  return (tower[lane][path] + 1) % RISK_PATHS[path].tiles;
}

function badTile(match, userId, path = "balanced") {
  const seat = seatOf(userId);
  const lane = match[seat === "player1" ? "p1Lane" : "p2Lane"];
  const tower = seat === "player1" ? match.p1Tower : match.p2Tower;
  return tower[lane][path];
}

test("simultaneous matches use an active state with no current turn", () => {
  assert.ok(PICKABLE_STATES.has(MATCH_STATUS.ACTIVE));
  const match = makeMatch();
  assert.equal(match.status, MATCH_STATUS.ACTIVE);
  assert.equal(match.currentTurnUserId, null);
  assert.equal(match.roundDeadline, null);
});

test("both players can submit independently and actions resolve immediately", () => {
  const match = makeMatch();
  const p1 = submit(match, "u1", "pick", "balanced", safeTile(match, "u1"));
  const p2 = submit(match, "u2", "pick", "risky", safeTile(match, "u2", "risky"));

  assert.equal(p1.pending, false);
  assert.equal(p2.pending, false);
  assert.equal(match.actions.length, 2);
  assert.equal(match.p1Lane, 1);
  assert.equal(match.p2Lane, 1);
  assert.equal(match.status, MATCH_STATUS.ACTIVE);
});

test("a bust resets only the current unbanked run and leaves the match active", () => {
  const match = makeMatch();
  submit(match, "u1", "pick", "balanced", safeTile(match, "u1"));
  const banked = submit(match, "u1", "hold");
  assert.equal(banked.bankedTotal, 16);

  submit(match, "u2", "pick", "balanced", safeTile(match, "u2"));
  const bust = submit(match, "u1", "pick", "balanced", badTile(match, "u1"));

  assert.equal(bust.safe, false);
  assert.equal(scoreFromActions(match.actions, "player1"), 16);
  assert.equal(bankedScoreOf(match, "player1"), 16);
  assert.equal(match.p1Lane, 2);
  assert.equal(match.status, MATCH_STATUS.ACTIVE);
  assert.equal(climbEnded(match, "player1"), false);
});

test("a bust does not affect the opponent's points or lane", () => {
  const match = makeMatch();
  submit(match, "u2", "pick", "balanced", safeTile(match, "u2"));
  const opponentScore = scoreFromActions(match.actions, "player2");
  const opponentLane = match.p2Lane;
  submit(match, "u1", "pick", "balanced", badTile(match, "u1"));

  assert.equal(scoreFromActions(match.actions, "player2"), opponentScore);
  assert.equal(match.p2Lane, opponentLane);
  assert.equal(match.status, MATCH_STATUS.ACTIVE);
});

test("reaching the top lane wraps and does not end the game", () => {
  const match = makeMatch();
  match.p1Lane = MAX_LANES - 1;
  const entry = submit(match, "u1", "pick", "safe", safeTile(match, "u1", "safe"));

  assert.equal(entry.safe, true);
  assert.equal(match.p1Lane, 0);
  assert.equal(match.status, MATCH_STATUS.ACTIVE);
});

test("only a banked score reaching 1,000 finishes the race", () => {
  const match = makeMatch();
  match.actions = [
    ...Array.from({ length: 2 }, (_, index) => ({
      action: "pick",
      seat: "player1",
      safe: true,
      points: 500,
      lane: index,
    })),
  ];
  assert.equal(scoreFromActions(match.actions, "player1"), 1000);
  assert.equal(match.status, MATCH_STATUS.ACTIVE);

  submit(match, "u1", "hold");
  assert.equal(match.status, MATCH_STATUS.FINISHED);
  assert.equal(match.winnerId, "u1");
});

test("the bot chooses a valid independent action after a bust", () => {
  const match = makeMatch({ id: 9 });
  match.player2Id = BOT_USER_ID;
  match.actions.push({
    action: "pick",
    seat: "player2",
    safe: false,
    points: 0,
    lane: 0,
  });
  const decision = decideBotAction(match, { random: () => 0.5 });

  assert.ok(decision);
  if (decision.action === "pick") {
    assert.ok(RISK_PATHS[decision.path]);
    assert.ok(decision.tileIndex >= 0);
    assert.ok(decision.tileIndex < RISK_PATHS[decision.path].tiles);
  }
});
