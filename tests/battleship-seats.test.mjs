// tests/battleship-seats.test.mjs
//
// Phase 3 — the PURE seat / phase authorization rules behind ranked Battleship.
//
// These are the answers the store gives on every protected operation, tested
// directly, without a database:
//
//   * which AUTHENTICATED user holds which seat (and that a third party holds
//     none — the 403 path);
//   * that a host can never be seated against themselves;
//   * that a lobby can never be double-filled;
//   * that placement is impossible before an opponent exists and after combat
//     has opened;
//   * that the placement → combat transition needs BOTH readiness flags, which
//     only the store can set from confirmed fleet rows;
//   * that only the host can cancel, and only a waiting lobby.
//
// "Two separate authenticated browser sessions" is modelled here as two distinct
// Clerk user ids driving the same row: `user_host` and `user_guest`. A live
// browser check needs a database and two real sessions, which this environment
// cannot provide; the seat arithmetic those sessions would exercise is what the
// cases below pin down.

import assert from "node:assert/strict";
import test from "node:test";

import {
  canCancelMatch,
  canConfirmFleet,
  canJoinLobby,
  canResign,
  isCombatPhase,
  isParticipant,
  isTerminalPhase,
  phaseForFleetReadiness,
  requireSeat,
  seatForUser,
} from "../src/lib/battleship/seats.ts";
import { MATCH_PHASE } from "../src/lib/battleship/constants.ts";

const HOST = "user_host_2f8c";
const GUEST = "user_guest_91ab";
const THIRD = "user_third_44de";

/** A fresh open lobby: one seat filled, phase waiting. */
const LOBBY = { player1Id: HOST, player2Id: null, phase: MATCH_PHASE.WAITING };

/** The same row after the second browser session joined. */
const SEATED = { player1Id: HOST, player2Id: GUEST, phase: MATCH_PHASE.PLACEMENT };

test("the phase vocabulary is exactly the five contractual phases", () => {
  assert.deepEqual(Object.values(MATCH_PHASE), [
    "waiting",
    "placement",
    "combat",
    "finished",
    "cancelled",
  ]);
});

test("seatForUser maps each authenticated id onto its seat", () => {
  assert.equal(seatForUser(LOBBY, HOST), "player1");
  assert.equal(seatForUser(LOBBY, GUEST), null);
  assert.equal(seatForUser(SEATED, HOST), "player1");
  assert.equal(seatForUser(SEATED, GUEST), "player2");
});

test("seatForUser refuses a third user and any missing identity", () => {
  assert.equal(seatForUser(SEATED, THIRD), null);
  assert.equal(seatForUser(SEATED, null), null);
  assert.equal(seatForUser(SEATED, undefined), null);
  assert.equal(seatForUser(SEATED, ""), null);
});

test("seatForUser is not fooled by a seat-shaped string", () => {
  // A forged "player2" string is not a player id; it buys no seat.
  assert.equal(seatForUser(SEATED, "player2"), null);
  assert.equal(seatForUser(SEATED, "2"), null);
});

test("requireSeat resolves participants and 403s everyone else", () => {
  assert.deepEqual(requireSeat(SEATED, HOST), { ok: true, seat: "player1" });
  assert.deepEqual(requireSeat(SEATED, GUEST), { ok: true, seat: "player2" });

  const denied = requireSeat(SEATED, THIRD);
  assert.equal(denied.ok, false);
  assert.equal(denied.status, 403);
  assert.match(denied.message, /not a player/i);

  assert.equal(requireSeat(SEATED, null).status, 403);
});

test("isParticipant agrees with seatForUser", () => {
  assert.equal(isParticipant(SEATED, HOST), true);
  assert.equal(isParticipant(SEATED, GUEST), true);
  assert.equal(isParticipant(SEATED, THIRD), false);
  assert.equal(isParticipant(LOBBY, GUEST), false);
});

// ── Joining ───────────────────────────────────────────────────────────────

test("an open lobby accepts a second, different authenticated player", () => {
  assert.deepEqual(canJoinLobby(LOBBY, GUEST), { ok: true });
});

test("a host cannot join their own lobby", () => {
  const verdict = canJoinLobby(LOBBY, HOST);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "self");
  assert.equal(verdict.status, 409);
  assert.match(verdict.message, /your own lobby/i);
});

test("a filled lobby refuses a third player — no duplicate seat", () => {
  // A second player holds the seat while the row is still `waiting` (the
  // placement phase comes from the store's join UPDATE, so both orderings are
  // refused: one because the seat is taken, the other because the lobby closed).
  const filled = { player1Id: HOST, player2Id: GUEST, phase: MATCH_PHASE.WAITING };
  const verdict = canJoinLobby(filled, THIRD);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "taken");
  assert.equal(verdict.status, 409);

  // The seated guest also cannot re-take the seat it already holds.
  assert.equal(canJoinLobby(filled, GUEST).ok, false);
  assert.equal(canJoinLobby(SEATED, THIRD).ok, false);
});

test("a lobby past waiting accepts nobody, whatever its phase", () => {
  for (const phase of [
    MATCH_PHASE.PLACEMENT,
    MATCH_PHASE.COMBAT,
    MATCH_PHASE.FINISHED,
    MATCH_PHASE.CANCELLED,
  ]) {
    const verdict = canJoinLobby({ player1Id: HOST, player2Id: null, phase }, GUEST);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, "not-open");
    assert.equal(verdict.status, 409);
  }
});

// ── Fleet confirmation ────────────────────────────────────────────────────

test("placement is refused while the lobby still waits for an opponent", () => {
  const verdict = canConfirmFleet({ phase: MATCH_PHASE.WAITING, seats: LOBBY, userId: HOST });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.status, 409);
  assert.match(verdict.message, /wait for an opponent/i);
});

test("placement is allowed for either seat once the lobby is seated", () => {
  assert.deepEqual(
    canConfirmFleet({ phase: MATCH_PHASE.PLACEMENT, seats: SEATED, userId: HOST }),
    { ok: true, seat: "player1" },
  );
  assert.deepEqual(
    canConfirmFleet({ phase: MATCH_PHASE.PLACEMENT, seats: SEATED, userId: GUEST }),
    { ok: true, seat: "player2" },
  );
});

test("a non-player can never confirm a fleet into someone else's match", () => {
  const verdict = canConfirmFleet({ phase: MATCH_PHASE.PLACEMENT, seats: SEATED, userId: THIRD });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.status, 403);
});

test("fleet confirmation closes once combat has begun", () => {
  const verdict = canConfirmFleet({ phase: MATCH_PHASE.COMBAT, seats: SEATED, userId: HOST });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.status, 409);
  assert.match(verdict.message, /combat has already begun/i);
});

test("a terminal match accepts no fleet", () => {
  for (const phase of [MATCH_PHASE.FINISHED, MATCH_PHASE.CANCELLED]) {
    const verdict = canConfirmFleet({ phase, seats: SEATED, userId: HOST });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.status, 409);
    assert.match(verdict.message, /over/i);
  }
});

// ── Phase derivation ──────────────────────────────────────────────────────

test("combat needs BOTH fleets — one confirmation keeps the match in placement", () => {
  assert.equal(phaseForFleetReadiness(false, false), MATCH_PHASE.PLACEMENT);
  assert.equal(phaseForFleetReadiness(true, false), MATCH_PHASE.PLACEMENT);
  assert.equal(phaseForFleetReadiness(false, true), MATCH_PHASE.PLACEMENT);
});

test("both fleets confirmed opens combat", () => {
  assert.equal(phaseForFleetReadiness(true, true), MATCH_PHASE.COMBAT);
});

test("isCombatPhase and isTerminalPhase agree with the vocabulary", () => {
  assert.equal(isCombatPhase(MATCH_PHASE.COMBAT), true);
  assert.equal(isCombatPhase(MATCH_PHASE.PLACEMENT), false);
  assert.equal(isCombatPhase(null), false);

  assert.equal(isTerminalPhase(MATCH_PHASE.FINISHED), true);
  assert.equal(isTerminalPhase(MATCH_PHASE.CANCELLED), true);
  assert.equal(isTerminalPhase(MATCH_PHASE.COMBAT), false);
  assert.equal(isTerminalPhase(MATCH_PHASE.WAITING), false);
  assert.equal(isTerminalPhase(undefined), false);
});

// ── Cancellation ──────────────────────────────────────────────────────────

test("the host may cancel their waiting lobby", () => {
  assert.deepEqual(canCancelMatch({ phase: MATCH_PHASE.WAITING, seats: LOBBY, userId: HOST }), {
    ok: true,
  });
});

test("a non-player cannot cancel someone else's lobby", () => {
  const verdict = canCancelMatch({ phase: MATCH_PHASE.WAITING, seats: LOBBY, userId: THIRD });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.status, 403);
});

test("the second seat cannot cancel the host's lobby", () => {
  const verdict = canCancelMatch({
    phase: MATCH_PHASE.PLACEMENT,
    seats: SEATED,
    userId: GUEST,
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.status, 403);
  assert.match(verdict.message, /only the host/i);
});

test("a seated match cannot be cancelled through the lobby route", () => {
  const verdict = canCancelMatch({ phase: MATCH_PHASE.PLACEMENT, seats: SEATED, userId: HOST });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.status, 409);
  assert.match(verdict.message, /waiting lobby/i);
});

test("only a live seated match can be resigned, and the caller is never the winner", () => {
  assert.deepEqual(
    canResign({ phase: MATCH_PHASE.PLACEMENT, seats: SEATED, userId: HOST }),
    { ok: true, seat: "player1" },
  );
  assert.deepEqual(
    canResign({ phase: MATCH_PHASE.COMBAT, seats: SEATED, userId: GUEST }),
    { ok: true, seat: "player2" },
  );

  // A third user cannot resign someone else's match.
  assert.equal(canResign({ phase: MATCH_PHASE.COMBAT, seats: SEATED, userId: THIRD }).status, 403);

  // A waiting lobby, a settled match and practice all refuse the action.
  assert.equal(canResign({ phase: MATCH_PHASE.WAITING, seats: LOBBY, userId: HOST }).status, 409);
  assert.equal(canResign({ phase: MATCH_PHASE.FINISHED, seats: SEATED, userId: HOST }).status, 409);
  assert.equal(
    canResign({ phase: MATCH_PHASE.COMBAT, seats: SEATED, userId: HOST, isAi: true }).status,
    409,
  );
});

// ── Two authenticated sessions on one row ─────────────────────────────────

test("two separate authenticated sessions share one match without sharing a seat", () => {
  // Session 1 opens the lobby.
  assert.equal(seatForUser(LOBBY, HOST), "player1");

  // Session 2 joins it.
  const joined = canJoinLobby(LOBBY, GUEST);
  assert.equal(joined.ok, true);

  const match = { player1Id: HOST, player2Id: GUEST, phase: MATCH_PHASE.PLACEMENT };

  // Both sessions resolve to DIFFERENT seats on the SAME match.
  assert.notEqual(seatForUser(match, HOST), seatForUser(match, GUEST));
  assert.deepEqual(requireSeat(match, HOST), { ok: true, seat: "player1" });
  assert.deepEqual(requireSeat(match, GUEST), { ok: true, seat: "player2" });

  // Each confirms its own fleet; neither may confirm for the other, and no
  // third session can reach the match at all.
  assert.equal(canConfirmFleet({ phase: match.phase, seats: match, userId: HOST }).ok, true);
  assert.equal(canConfirmFleet({ phase: match.phase, seats: match, userId: GUEST }).ok, true);
  assert.equal(canConfirmFleet({ phase: match.phase, seats: match, userId: THIRD }).status, 403);

  // A repeated confirmation from the same seat cannot invent a third ready
  // flag: readiness is per seat, and the phase only advances when both are on.
  assert.equal(phaseForFleetReadiness(true, false), MATCH_PHASE.PLACEMENT);
  assert.equal(phaseForFleetReadiness(true, true), MATCH_PHASE.COMBAT);
});

test("a corrupt row where both seats hold one id resolves to a single seat", () => {
  // Defensive: the store's self-join guard makes this unreachable, and if a row
  // were ever written this way the caller still holds exactly one seat.
  const corrupt = { player1Id: HOST, player2Id: HOST, phase: MATCH_PHASE.PLACEMENT };
  assert.equal(seatForUser(corrupt, HOST), "player1");
  assert.equal(canConfirmFleet({ phase: corrupt.phase, seats: corrupt, userId: HOST }).seat, "player1");
});
