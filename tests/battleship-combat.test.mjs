// tests/battleship-combat.test.mjs
//
// PHASE 4 — simultaneous combat.
//
// The engine cases are run directly against the pure rules, in the order the
// server runs them:
//
//   both LOCK (rows with result NULL) → both shots judged against the same
//   pre-round fleets → both results written → the round advances (or the match
//   ends, with a mutual final blow a DRAW).
//
// What is pinned here:
//   1. both hit · both miss · one hits and one misses · both sink a ship
//   2. both destroy the final enemy ship in the SAME round → draw
//   3. a locked-but-unresolved attack is NOT part of the engine state
//   4. duplicate submissions, concurrent submissions and old-round shots are
//      refused by the store's constraints/guards
//   5. invalid coordinates and out-of-board cells are refused
//   6. reconnection rebuilds the exact state, and the projection still has no
//      opponent fleet
//   7. publication (route) happens AFTER the transaction, and the socket events
//      carry no hidden fleet/coordinate data
//
// Run:  node --import tsx --test tests/battleship-combat.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  createMatchState,
  formatCoordinate,
  hasAttacked,
  matchViewForSeat,
  parseCoordinate,
  resolveRound,
  shipCells,
} from "../src/lib/battleship/rules.ts";
import {
  attackForRound,
  buildMatchState,
  expectedRound,
  fleetDamage,
  roundLocked,
  sunkBySeat,
} from "../src/lib/battleship/combat.ts";
import { canSubmitAttack } from "../src/lib/battleship/seats.ts";
import { MATCH_PHASE, SHOT_RESULTS } from "../src/lib/battleship/constants.ts";

// Two valid fleets, mirror images of each other.
const FLEET_A = {
  ships: [
    { ship: "carrier", orientation: "horizontal", x: 0, y: 0 },
    { ship: "battleship", orientation: "horizontal", x: 0, y: 2 },
    { ship: "cruiser", orientation: "horizontal", x: 0, y: 4 },
    { ship: "submarine", orientation: "horizontal", x: 0, y: 6 },
    { ship: "frigate", orientation: "horizontal", x: 0, y: 1 },
    { ship: "destroyer", orientation: "horizontal", x: 0, y: 8 },
  ],
};
const FLEET_B = {
  ships: [
    { ship: "carrier", orientation: "horizontal", x: 5, y: 0 },
    { ship: "battleship", orientation: "horizontal", x: 5, y: 2 },
    { ship: "cruiser", orientation: "horizontal", x: 5, y: 4 },
    { ship: "submarine", orientation: "horizontal", x: 5, y: 6 },
    { ship: "frigate", orientation: "horizontal", x: 5, y: 1 },
    { ship: "destroyer", orientation: "horizontal", x: 5, y: 8 },
  ],
};
const FLEETS = { player1: FLEET_A, player2: FLEET_B };

const fresh = () => createMatchState({ player1: FLEET_A, player2: FLEET_B });
const both = (state, player1, player2) =>
  resolveRound(state, { player1, player2 });

const read = (relative) => fs.readFileSync(path.join(process.cwd(), relative), "utf8");
const STORE = read("src/lib/battleship/serverStore.ts");
const ROUTE = read("src/app/api/battleship/match/[matchId]/attack/route.ts");
const ROOMS = read("src/lib/battleship/rooms.ts");
const SERVER = read("realtime-server/server.js");
const UI = read("src/components/games/battleship/BattlePreview.tsx");
const PAGE = read("src/app/casino/battleship/PageClient.tsx");

// ── Round outcomes ────────────────────────────────────────────────────────

test("both players hit: one round, two hits, the round advances", () => {
  const out = both(fresh(), "F1", "A1");
  assert.equal(out.ok, true);
  assert.equal(out.round.attacks.player1.result, SHOT_RESULTS.HIT);
  assert.equal(out.round.attacks.player1.ship, null);
  assert.equal(out.round.attacks.player2.result, SHOT_RESULTS.HIT);
  assert.equal(out.round.destroyed.player1, false);
  assert.equal(out.round.destroyed.player2, false);
  assert.equal(out.round.roundAdvanced, true);
  assert.equal(out.state.round, 2);
  assert.equal(out.state.status, "playing");
});

test("both players miss: open water on both boards", () => {
  const out = both(fresh(), "B10", "H10");
  assert.equal(out.ok, true);
  assert.equal(out.round.attacks.player1.result, SHOT_RESULTS.MISS);
  assert.equal(out.round.attacks.player2.result, SHOT_RESULTS.MISS);
  assert.equal(out.round.roundAdvanced, true);
});

test("one hits and one misses: each shot is judged independently", () => {
  const out = both(fresh(), "F1", "H10");
  assert.equal(out.round.attacks.player1.result, SHOT_RESULTS.HIT);
  assert.equal(out.round.attacks.player2.result, SHOT_RESULTS.MISS);
  assert.equal(out.round.roundAdvanced, true);
});

test("both players sink a ship in the same round", () => {
  const first = both(fresh(), "F9", "A9");
  assert.equal(first.round.attacks.player1.result, SHOT_RESULTS.HIT);

  const second = both(first.state, "G9", "B9");
  assert.equal(second.ok, true);
  assert.equal(second.round.attacks.player1.result, SHOT_RESULTS.SUNK);
  assert.equal(second.round.attacks.player1.ship, "destroyer");
  assert.equal(second.round.attacks.player2.result, SHOT_RESULTS.SUNK);
  assert.equal(second.round.attacks.player2.ship, "destroyer");
  assert.deepEqual(sunkBySeat(second.round.attacks), ["destroyer", "destroyer"]);
  assert.equal(second.round.roundAdvanced, true);
});

/** Both fleets fully hit except one cell of each destroyer. */
function nearlyDestroyedState() {
  const rows = { player1: [], player2: [] };
  for (const seat of ["player1", "player2"]) {
    const enemy = seat === "player1" ? FLEET_B : FLEET_A;
    let round = 0;
    for (const ship of enemy.ships) {
      const cells = shipCells(ship);
      const leaving = ship.ship === "destroyer" ? 1 : 0;
      const fired = cells.slice(0, cells.length - leaving);
      fired.forEach((cell, index) => {
        round += 1;
        const destroys = leaving === 0 && index === fired.length - 1;
        rows[seat].push({
          round,
          seat,
          coordinate: formatCoordinate(cell),
          result: destroys ? SHOT_RESULTS.SUNK : SHOT_RESULTS.HIT,
          ship: destroys ? ship.ship : null,
        });
      });
    }
  }

  return {
    status: "playing",
    round: 17,
    players: {
      player1: { seat: "player1", fleet: FLEET_A, attacks: rows.player1 },
      player2: { seat: "player2", fleet: FLEET_B, attacks: rows.player2 },
    },
    outcome: null,
    winner: null,
  };
}

test("both destroy the final enemy ship: the match is a DRAW, not an invented winner", () => {
  const out = both(nearlyDestroyedState(), "G9", "B9");
  assert.equal(out.ok, true);
  assert.equal(out.round.attacks.player1.result, SHOT_RESULTS.SUNK);
  assert.equal(out.round.attacks.player2.result, SHOT_RESULTS.SUNK);
  assert.equal(out.round.destroyed.player1, true);
  assert.equal(out.round.destroyed.player2, true);
  assert.equal(out.round.outcome, "draw");
  assert.equal(out.state.status, "finished");
  assert.equal(out.state.winner, null);
  assert.equal(out.round.roundAdvanced, false);
});

test("a losing player still lands their shot in the deciding round", () => {
  // player1 wipes player2 out one round before player2 can finish player1: both
  // shots still resolve, and only the completed fleet decides the outcome.
  const state = {
    status: "playing",
    round: 17,
    players: {
      player1: {
        seat: "player1",
        fleet: FLEET_A,
        attacks: nearlyDestroyedState().players.player1.attacks,
      },
      player2: {
        seat: "player2",
        fleet: FLEET_B,
        attacks: nearlyDestroyedState().players.player2.attacks,
      },
    },
    outcome: null,
    winner: null,
  };
  // J5 is open water on player1's board: player2's own (losing) shot still lands
  // and is evaluated against the same pre-round position.
  const out = both(state, "G9", "J5");
  assert.equal(out.ok, true);
  assert.equal(out.round.attacks.player1.result, SHOT_RESULTS.SUNK, "player1 finishes the fleet");
  assert.equal(out.round.attacks.player2.result, SHOT_RESULTS.MISS, "player2's own shot still lands");
  assert.equal(out.round.outcome, "player1");
  assert.equal(out.state.winner, "player1");
});

// ── Locking / duplicate / concurrency ─────────────────────────────────────

test("a locked-but-unresolved attack is not part of the engine state", () => {
  const rows = [{ round: 1, seat: "player1", coordinate: "F1", result: null, ship: null }];
  assert.deepEqual(roundLocked(rows, 1), { player1: true, player2: false });
  assert.equal(attackForRound(rows, 1, "player1").coordinate, "F1");
  assert.equal(attackForRound(rows, 1, "player2"), null);
  assert.equal(expectedRound(rows), 1, "an unresolved lock does not advance the round");

  const state = buildMatchState({ round: 1, fleets: FLEETS, attacks: rows });
  assert.ok(state);
  assert.equal(state.players.player1.attacks.length, 0, "a lock is not a shot");
  assert.equal(state.players.player2.attacks.length, 0);
  assert.equal(state.round, 1);
});

test("a duplicate lock for the same seat and round is impossible by storage", () => {
  // The store inserts ON CONFLICT DO NOTHING under UNIQUE (match_id, round, seat)
  // and UNIQUE (match_id, seat, coordinate).
  assert.match(STORE, /battleshipAttacks\)\s*\n\s*\.values\(\{ matchId, round: row\.round, seat, coordinate: label \}\)/);
  assert.match(STORE, /\.onConflictDoNothing\(\)/);
  assert.match(STORE, /if \(!inserted\) return \{ error: "Your attack is locked for this round", status: 409 \}/);
});

test("a repeated identical submission is idempotent; a different one is refused", () => {
  assert.match(STORE, /if \(existing\.coordinate\.toUpperCase\(\) === label\)/);
  assert.match(STORE, /return asWaiting\(await buildDto\(row, seat, tx\)\)/);
  assert.match(STORE, /return \{ error: "Your attack is locked for this round", status: 409 \}/);
});

test("concurrent submissions serialise on the match row and cannot double-resolve", () => {
  const locks = [...STORE.matchAll(/\.for\("update"\)/g)].length;
  assert.ok(locks >= 5, `expected every mutation to lock its row, found ${locks}`);
  // The round only advances under a conditional UPDATE on round AND phase.
  assert.match(
    STORE,
    /eq\(battleshipMatches\.round, row\.round\),\s*\n\s*eq\(battleshipMatches\.phase, MATCH_PHASE\.COMBAT\)/,
  );
  assert.match(STORE, /if \(!updated\) \{\s*\n\s*return \{ error: "The round changed concurrently; retry the request", status: 409 \}/);
  // Both shots are written inside the SAME transaction as the row update.
  assert.match(STORE, /for \(const shotSeat of SEATS\) \{/);
  assert.match(STORE, /\.set\(\{ result: attack\.result, ship: attack\.ship \}\)/);
});

test("an old-round coordinate cannot be fired again", () => {
  const first = both(fresh(), "F1", "A1");
  assert.equal(first.ok, true);
  const coordinate = parseCoordinate("F1");
  assert.equal(hasAttacked(first.state.players.player1.attacks, coordinate), true);

  const replay = both(first.state, "F1", "A1");
  assert.equal(replay.ok, false);
  assert.equal(replay.code, "already_attacked");
});

test("invalid and out-of-board coordinates are refused before anything is stored", () => {
  for (const bad of ["Z99", "O1", "A0", "J11", "B7B", "", null]) {
    assert.equal(parseCoordinate(bad), null, `${String(bad)} must not parse`);
  }
  const out = both(fresh(), "Z99", "A1");
  assert.equal(out.ok, false);
  assert.equal(out.code, "invalid_coordinate");
  assert.equal(out.state, undefined, "a rejected round changes nothing");
});

test("the open round must match the logs", () => {
  const rows = [{ round: 1, seat: "player1", coordinate: "F1", result: "hit", ship: null }];
  assert.equal(expectedRound(rows), 2, "one resolved round leaves round 2 open");
  const out = both(fresh(), "F1", "A1");
  const rebuilt = buildMatchState({
    round: 1,
    fleets: FLEETS,
    attacks: out.state.players.player1.attacks.map((record) => ({
      ...record,
      seat: "player1",
    })).concat(
      out.state.players.player2.attacks.map((record) => ({ ...record, seat: "player2" })),
    ),
  });
  assert.ok(rebuilt, "the stored logs rebuild a legal state");
  assert.equal(expectedRound(
    out.state.players.player1.attacks
      .map((record) => ({ ...record, seat: "player1" }))
      .concat(out.state.players.player2.attacks.map((record) => ({ ...record, seat: "player2" }))),
  ), 2);
});

// ── Reconnection / privacy ────────────────────────────────────────────────

test("a reconnect rebuilds the exact pending state from the rows", () => {
  const rows = [
    { round: 1, seat: "player1", coordinate: "F1", result: null, ship: null },
    { round: 1, seat: "player2", coordinate: "A1", result: null, ship: null },
  ];
  assert.deepEqual(roundLocked(rows, 1), { player1: true, player2: true });
  assert.equal(expectedRound(rows), 1, "both locks resolve as one round, not two");

  const state = buildMatchState({ round: 1, fleets: FLEETS, attacks: rows });
  assert.ok(state);
  const view = matchViewForSeat(state, "player1");
  assert.equal("fleet" in view.opponent, false, "the opponent projection has no fleet field");
  assert.equal(view.you.fleet.ships.length, 6, "the viewer still sees their own fleet");
  assert.equal(view.round, 1);
});

test("the projection never carries the opponent's fleet", () => {
  const out = both(fresh(), "F1", "A1");
  for (const seat of ["player1", "player2"]) {
    const view = matchViewForSeat(out.state, seat);
    assert.equal("fleet" in view.opponent, false);
    assert.equal(JSON.stringify(view.opponent).includes("carrier:A1"), false);
    assert.equal(view.opponent.board.length, 10);
  }
});

test("fleetDamage derives damage from the shots fired at the viewer's own fleet", () => {
  const damage = fleetDamage(FLEET_A, [
    { round: 1, seat: "player2", coordinate: "A1", result: "hit", ship: null },
    { round: 2, seat: "player2", coordinate: "B1", result: "hit", ship: null },
  ]);
  assert.deepEqual(damage.damaged.carrier, [true, true, false, false, false]);
  assert.deepEqual(damage.damaged.destroyer, [false, false]);
  assert.deepEqual(damage.sunk, []);
});

// ── Attack authorization ─────────────────────────────────────────────────

const SEATS = { player1Id: "user_host", player2Id: "user_guest" };

test("an attack requires combat, an open round and an unlocked seat", () => {
  const base = {
    phase: MATCH_PHASE.COMBAT,
    seats: SEATS,
    userId: "user_host",
    round: 1,
    locked: { player1: false, player2: false },
  };
  assert.deepEqual(canSubmitAttack(base), { ok: true, seat: "player1" });

  const locked = canSubmitAttack({ ...base, locked: { player1: true, player2: false } });
  assert.equal(locked.ok, false);
  assert.equal(locked.code, "attack_locked");
  assert.equal(locked.status, 409);

  const placement = canSubmitAttack({ ...base, phase: MATCH_PHASE.PLACEMENT });
  assert.equal(placement.ok, false);
  assert.equal(placement.code, "wrong_phase");

  const finished = canSubmitAttack({ ...base, phase: MATCH_PHASE.FINISHED });
  assert.equal(finished.ok, false);
  assert.equal(finished.code, "match_finished");

  const roundZero = canSubmitAttack({ ...base, round: 0 });
  assert.equal(roundZero.ok, false);
  assert.equal(roundZero.code, "invalid_round");
});

test("a non-player can never lock an attack in someone else's match", () => {
  const verdict = canSubmitAttack({
    phase: MATCH_PHASE.COMBAT,
    seats: SEATS,
    userId: "user_third",
    round: 1,
    locked: { player1: false, player2: false },
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.status, 403);
  assert.equal(verdict.code, "not_a_player");
});

// ── Publication ───────────────────────────────────────────────────────────

test("results are published only after the transaction commits", () => {
  const awaitAt = ROUTE.indexOf("await submitAttack");
  const publishAt = ROUTE.indexOf("publishRoundResult(matchId, round)");
  assert.ok(awaitAt > -1 && publishAt > awaitAt, "the emit must follow the commit");
  assert.match(read("src/lib/battleship/publish.ts"), /BATTLESHIP_EVENTS\.ROUND_RESOLVED/);
  assert.doesNotMatch(STORE, /broadcast/, "the store never publishes");
  assert.match(STORE, /to: "completed"/, "a finished match completes its lifecycle");

  const lockedBlock = ROUTE.slice(
    ROUTE.indexOf("BATTLESHIP_EVENTS.ATTACK_LOCKED"),
    ROUTE.indexOf("BATTLESHIP_EVENTS.ROUND_RESOLVED"),
  );
  assert.doesNotMatch(lockedBlock, /coordinate/, "a locked event carries no cell");
});

test("the socket vocabulary is the contractual one and carries no fleet data", () => {
  for (const [name, value] of [
    ["ATTACK_LOCKED", "battleship:attack_locked"],
    ["OPPONENT_WAITING", "battleship:opponent_waiting"],
    ["ROUND_RESOLVED", "battleship:round_resolved"],
    ["ROUND_STARTED", "battleship:round_started"],
    ["SHIP_SUNK", "battleship:ship_sunk"],
    ["MATCH_FINISHED", "battleship:match_finished"],
  ]) {
    assert.match(ROOMS, new RegExp(`${name}: "${value}"`));
  }
  const code = ROOMS.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(code, /fleet|ships|placement/);
});

test("the realtime server tracks the match room and only trusted sockets may poke", () => {
  assert.match(SERVER, /const BATTLESHIP_MATCH_ROOM_PREFIX = "battleship:match:"/);
  assert.match(SERVER, /trackBattleshipJoin\(String\(roomId\), socket\.data\.userId\)/);
  assert.match(SERVER, /trackBattleshipLeave\(String\(roomId\), socket\.data\.userId\)/);
  assert.match(SERVER, /socket\.on\("battleship:ready"/);
  assert.match(SERVER, /rejecting ready from non-participant/);
  assert.match(ROOMS, /BATTLESHIP_MATCH_ROOM_PREFIX = "battleship:match:"/);
});

// ── Transport & interface ────────────────────────────────────────────────

test("the client sends one coordinate and cannot author a result", () => {
  assert.match(PAGE, /JSON\.stringify\(\{ coordinate: formatCoordinate\(coordinate\) \}\)/);
  const stripped = PAGE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const forbidden of [/JSON\.stringify\(\{[^}]*result:/, /JSON\.stringify\(\{[^}]*winner:/, /JSON\.stringify\(\{[^}]*ship:/, /JSON\.stringify\(\{[^}]*round:/, /JSON\.stringify\(\{[^}]*seat:/]) {
    assert.equal(forbidden.test(stripped), false, `the client must not send ${forbidden}`);
  }
  assert.match(ROUTE, /body\?\.coordinate/);
  assert.doesNotMatch(ROUTE, /body\?\.(round|seat|result|winner|ship|phase)/);
});

test("the interface locks, waits, then reveals both outcomes together", () => {
  assert.match(UI, /data-testid="attack-locked"/);
  assert.match(UI, /data-testid="waiting-opponent"/);
  assert.match(UI, /onAttack\(selected\)/);
  assert.match(UI, /highlight=\{revealCells\}/);
  assert.equal(/resolveRound|resolveAttack|applyAttack/.test(UI), false);
  assert.equal(/setLocked/.test(UI), false, "the lock is the server's");
  assert.match(UI, /isCellDisabled=\{\(\) => locked \|\| Boolean\(result\) \|\| busy\}/);
  assert.match(PAGE, /reveal=\{reveal\}/);
  assert.match(PAGE, /battleshipMatchRoom/);
});
