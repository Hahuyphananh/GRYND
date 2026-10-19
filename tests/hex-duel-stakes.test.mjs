// tests/hex-duel-stakes.test.mjs
//
// Hex Duel plays for coins now, and a staked match must never settle on a
// client's word (src/lib/games/stakes.js). These tests pin the two halves of
// that promise:
//
//   1. THE RULEBOOK IS THE SERVER'S TOO. The pure rules moved to
//      src/lib/hex-duel/rules.ts so the action endpoint can replay a match and
//      decide its winner; the client engine must import that module rather than
//      keep a second copy, the move validator must refuse a fabricated capture,
//      and the endTurn echo the engine ignores must be ignored by the replay
//      too (or the server's turn would flip twice).
//   2. THE MONEY MOVES ON THE SERVER'S RESULT. The finish request is a signal,
//      never a claim: no route may read a winner out of a request body, both
//      seats are escrowed when the second one joins, the pot is paid through the
//      shared ledger helper, and only the losing seat can report a loss.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  applyRecordedMove,
  checkHexDuelMove,
  makeInitialCore,
  otherPlayer,
} from "../src/lib/hex-duel/rules.ts";
import {
  hexDuelOpponentSeat,
  hexDuelSeatFor,
  hexDuelSettledWinner,
  replayHexDuel,
} from "../src/lib/hex-duel/authority.ts";

const read = (path) => fs.readFileSync(path, "utf8");

const SEATS = { player1Id: "user_1", player2Id: "user_2" };
const CAPTURE = { type: "attack", sourceKey: "3,4", targetKey: "4,4", troopCount: 7 };

/**
 * A state where player1 really does hold a tile next to the enemy capital with
 * enough troops to take it — and still keep one behind (the board never lets a
 * tile send its last troop).
 */
function statePrimedForCapture() {
  const state = makeInitialCore();
  state.capturedTiles["3,4"] = "player1";
  state.tileTroops["3,4"] = 8;
  return state;
}

// ── 1. The rulebook is the server's too ──────────────────────────────────

test("the client engine imports the shared rulebook instead of keeping a copy", () => {
  const engine = read("src/lib/hexDuelEngine.ts");
  assert.match(engine, /from "\.\/hex-duel\/rules"/, "the engine must use the shared rules");
  for (const moved of ["function coreReducer", "function makeInitialCore", "function resolveAttackOutcome"]) {
    assert.ok(
      !engine.includes(moved),
      `${moved} must live in src/lib/hex-duel/rules.ts only`,
    );
  }
  const rules = read("src/lib/hex-duel/rules.ts");
  assert.match(rules, /export function coreReducer/);
  assert.match(rules, /export function checkHexDuelMove/);
  assert.ok(
    !rules.trimStart().startsWith('"use client"'),
    "the rulebook must carry no client directive — the server imports it directly",
  );
});

test("no settle path may take a winner from a request body", () => {
  // The regression this whole file exists for: while any settle path read a
  // winner out of a request body, a client could name itself the winner of a
  // staked match and take the pot.
  const end = read("src/app/api/hex-duel/multiplayer/end/route.ts");
  assert.doesNotMatch(
    end,
    /body\.winner/,
    "the finish request must not name a winner",
  );
  assert.match(end, /hexDuelSettledWinner\(/, "the winner is derived server-side");
  assert.match(end, /settleHexDuelMatch\(/, "settlement is the one shared implementation");
});

test("a fabricated capture is refused: the source tile must really be the caller's", () => {
  // Straight out of the initial position — the move a cheater would need in
  // order to have the replay declare them the winner.
  const initial = makeInitialCore();
  const check = checkHexDuelMove(initial, "player1", CAPTURE);
  assert.equal(check.ok, false);
  assert.equal(check.code, "NOT_YOUR_TILE");
});

test("a legal capital capture is accepted and decides the match for the attacker", () => {
  const state = statePrimedForCapture();
  const check = checkHexDuelMove(state, "player1", CAPTURE);
  assert.equal(check.ok, true, "the board allows this attack");

  const after = applyRecordedMove(state, "player1", CAPTURE);
  assert.equal(after.winner, "player1", "the capture ends the game");
  assert.equal(after.capturedTiles["4,4"], "player1");
});

test("the move validator refuses everything the board would not offer", () => {
  const state = statePrimedForCapture();
  const cases = [
    [{ ...CAPTURE, troopCount: 7 }, "player2", "NOT_YOUR_TURN"],
    [{ ...CAPTURE, sourceKey: "4,4" }, "player1", "NOT_YOUR_TILE"],
    [{ ...CAPTURE, targetKey: "3,4" }, "player1", "OWN_TILE"],
    [{ ...CAPTURE, targetKey: "0,1" }, "player1", "NOT_ADJACENT"],
    [{ ...CAPTURE, targetKey: "9,9" }, "player1", "BAD_TARGET"],
    [{ ...CAPTURE, troopCount: 7.5 }, "player1", "BAD_TROOPS"],
    [{ ...CAPTURE, troopCount: 0 }, "player1", "BAD_TROOPS"],
    [{ ...CAPTURE, troopCount: 8 }, "player1", "TOO_MANY_TROOPS"],
  ];
  for (const [move, seat, code] of cases) {
    const check = checkHexDuelMove(state, seat, move);
    assert.equal(check.ok, false, `${code} must be refused`);
    assert.equal(check.code, code);
  }
  // No action points left is not a legal move either.
  const exhausted = { ...statePrimedForCapture(), currentAP: 0 };
  assert.equal(checkHexDuelMove(exhausted, "player1", CAPTURE).code, "NO_ACTION_POINTS");
});

test("the endTurn echo that the engine ignores is ignored by the replay too", () => {
  // An attack that empties the action points auto-flips the turn AND makes the
  // client echo an explicit endTurn. The receiver ignores that echo; the server
  // must, or its replay would flip the turn twice and drift from both boards.
  // One action point left, so the attack itself empties the turn.
  const state = { ...statePrimedForCapture(), currentAP: 1 };
  const attacked = applyRecordedMove(state, "player1", {
    type: "attack",
    sourceKey: "3,4",
    targetKey: "2,3",
    troopCount: 6,
  });
  assert.notEqual(attacked.currentTurn, state.currentTurn, "the attack auto-flipped");

  const echoed = applyRecordedMove(attacked, "player1", { type: "endTurn" });
  assert.equal(echoed, attacked, "the echo is a no-op for the receiver");
  assert.equal(echoed.currentTurn, attacked.currentTurn);
  assert.deepEqual(echoed.tileTroops, attacked.tileTroops, "and it does not re-grow troops");
});

// ── 2. The winner the server will settle on ──────────────────────────────

test("a capture in the recorded log is the winner, and it beats the row's column", () => {
  const rows = [
    { userId: "user_2", actionType: "attack", sourceKey: "1,1", targetKey: "0,0", troopCount: 2 },
    { userId: "user_1", actionType: "attack", sourceKey: "3,4", targetKey: "4,4", troopCount: 7 },
  ];
  const settled = hexDuelSettledWinner(SEATS, rows, "player2");
  assert.equal(settled.winner, "player1");
  assert.equal(settled.source, "capture", "the board outranks the column");
});

test("with nothing on file, only a recorded concession can name a winner", () => {
  const none = hexDuelSettledWinner(SEATS, [], "pending");
  assert.equal(none.winner, null);
  assert.equal(none.source, "none");

  const conceded = hexDuelSettledWinner(SEATS, [], "player2");
  assert.equal(conceded.winner, "player2");
  assert.equal(conceded.source, "concede");
});

test("a row from a seat that is not in the match cannot decide anything", () => {
  const rows = [
    { userId: "user_999", actionType: "attack", sourceKey: "3,4", targetKey: "4,4", troopCount: 7 },
  ];
  const replayed = replayHexDuel(SEATS, rows);
  assert.equal(replayed.winner, null);
  assert.equal(replayed.applied, 0);
  assert.equal(replayed.ignored, 1);
  assert.equal(hexDuelSeatFor(SEATS, "user_999"), null);
});

test("replay tolerates junk rows without throwing", () => {
  const rows = [
    { userId: "user_1", actionType: "teleport", sourceKey: null, targetKey: null, troopCount: null },
    { userId: "user_1", actionType: "attack", sourceKey: null, targetKey: "4,4", troopCount: 7 },
    { userId: "user_1", actionType: "endTurn", sourceKey: null, targetKey: null, troopCount: null },
  ];
  const replayed = replayHexDuel(SEATS, rows);
  assert.equal(replayed.winner, null);
  assert.equal(replayed.applied, 1, "only the endTurn moved the game");
  assert.equal(replayed.state.currentTurn, "player2");
});

test("a concession always hands the win to the OTHER seat", () => {
  assert.equal(hexDuelOpponentSeat("player1"), "player2");
  assert.equal(hexDuelOpponentSeat("player2"), "player1");
  assert.equal(otherPlayer("player1"), "player2");
});

// ── 3. The wiring: escrow at join, pot at settlement ─────────────────────

test("a lobby is created with a required, server-validated stake", () => {
  const create = read("src/app/api/hex-duel/multiplayer/create/route.ts");
  assert.match(create, /requireStake\(wager, "hex-duel"\)/);
  assert.match(create, /wagerAmount: stake\.stake\.toFixed\(2\)/);
  assert.doesNotMatch(
    create,
    /normalizeStake\(wager\)/,
    "a ranked lobby must not silently fall back to free play",
  );
});

test("both seats are escrowed in the transaction that fills the second seat", () => {
  const join = read("src/app/api/hex-duel/multiplayer/join/route.ts");
  assert.match(join, /import \{ escrowMatchWagers \} from "[^"]*tokens\/wager"/);
  assert.match(join, /await escrowMatchWagers\(\{/);
  assert.match(join, /clerkIds: \[game\.player1Id, userId\]/);
  assert.match(join, /gameKey: "hex-duel"/);
  assert.match(join, /if \(!escrow\.ok\)/);

  // The queue seats the pair itself, so it must escrow too.
  const queue = read("src/lib/quickQueueHexDuel.ts");
  assert.match(queue, /await escrowMatchWagers\(\{/);
  assert.match(queue, /clerkIds: \[open\.player1Id, userId\]/);
  assert.match(queue, /gameKey: "hex-duel"/);
});

test("the action endpoint validates the move against the server's own replay", () => {
  const action = read("src/app/api/hex-duel/multiplayer/action/route.ts");
  assert.match(action, /replayHexDuel\(seats, storedRows/);
  assert.match(action, /checkHexDuelMove\(/);
  assert.match(action, /if \(!check\.ok\)/, "an impossible move is refused, not recorded");
  // The deciding move is what writes the winner — and only while it is pending.
  assert.match(action, /game\.winner === "pending"/);
  assert.match(action, /applyRecordedMove\(replayed\.state, callerSlot, move\)/);
});

test("the pot is paid through the shared ledger, in the settling transaction", () => {
  const settle = read("src/lib/hex-duel/settle.ts");
  assert.match(settle, /payPvpPot\(\{/);
  assert.match(settle, /gameKey: "hex-duel"/);
  assert.match(settle, /winnerClerkId/);
  // No hand-written pot arithmetic anywhere in the module.
  assert.doesNotMatch(settle, /\* 1\.8|\* 1\.9|0\.9 \*/, "the rake lives in pvpPot");

  const end = read("src/app/api/hex-duel/multiplayer/end/route.ts");
  assert.match(end, /PAYOUT_MULTIPLIER = 2 \* PVP_WINNER_SHARE/);
});

test("only a seat can concede, and only its own match", () => {
  const resign = read("src/app/api/hex-duel/multiplayer/resign/route.ts");
  assert.match(resign, /hexDuelOpponentSeat\(callerSlot\)/, "the winner is the opponent");
  assert.match(resign, /const callerSlot = hexDuelSeatFor\(game, clerkId\)/);
  assert.match(resign, /settleHexDuelMatch\(\{/);    assert.doesNotMatch(resign, /body\.winner/, "a resign cannot name its own winner");
    assert.doesNotMatch(resign, /winner:\s*body/, "and not from any other body field");
  // A waiting lobby is cancelled, never settled.
  assert.match(resign, /game\.status === "waiting" && game\.player2Id === null/);
});

test("a lost connection forfeits its own match through the internal route", () => {
  const forfeit = read("src/app/api/hex-duel/multiplayer/disconnect-forfeit/route.ts");
  assert.match(forfeit, /verifyToken\(token/, "the socket's own token authorises it");
  assert.match(forfeit, /hexDuelOpponentSeat\(callerSlot\)/);
  assert.match(forfeit, /settleHexDuelMatch\(\{/);

  const server = read("realtime-server/server.js");
  assert.match(
    server,
    /api\/hex-duel\/multiplayer\/disconnect-forfeit/,
    "the grace timer must settle the stake, not just tell the socket",
  );
});

test("the clock is reported by the seat whose own clock ran out", () => {
  const page = read("src/app/casino/hex-duel/game/[matchId]/PageClient.tsx");
  assert.match(page, /expiredPlayer === mySeat/, "a seat may only report its own timeout");
  assert.match(page, /reason: "timeout"/);
  assert.match(page, /reason: "resign"/);
  // The finish request carries the match it is finishing, and the client knows
  // a pending result is not a failure.
  assert.match(page, /gameId: multiplayerGameId/);
  assert.match(page, /RESULT_PENDING/);
});
