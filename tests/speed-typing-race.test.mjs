/**
 * speed-typing-race.test.mjs
 *
 * The AUTHORITATIVE RACE: the pure rules that decide everything, and the store
 * contract that applies them under a row lock.
 *
 * Two halves, deliberately:
 *
 *   1. BEHAVIOUR — `src/lib/speed-typing/passages.ts` and `rules.ts` are driven
 *      for real. Passage selection, verification, the server clock, the
 *      checkpoint throttle, the finish verdict and the resolution rules are all
 *      arithmetic, so they are tested as arithmetic rather than by racing two
 *      browsers.
 *
 *   2. CONTRACT — the store cannot be driven without Postgres, so what is
 *      asserted is the part that must never change: every mutating function
 *      takes the row lock first, nothing accepts a decision from a caller, the
 *      terminal write and the settlement share one transaction, and a replay
 *      writes nothing.
 *
 * The single idea under test throughout: a client may only ever say WHAT IT
 * TYPED. If any test here can be satisfied by a client-supplied winner, score,
 * duration, WPM or rating, the game is broken.
 *
 * Run:  node --import tsx --test tests/speed-typing-race.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  ENABLED_PASSAGES,
  PASSAGE_IDS,
  PASSAGE_VERSION,
  SPEED_TYPING_PASSAGES,
  isPassageId,
  passageById,
  passageForRow,
  passageIndexFromSeed,
  passageWordCount,
  selectPassageForSeed,
} from "../src/lib/speed-typing/passages.ts";
import {
  coerceRaceState,
  correctCharsFor,
  createRaceState,
  emptySeatRace,
  evaluateCheckpoint,
  evaluateFinish,
  forfeitSeatRace,
  instantFromDate,
  isRaceDue,
  isRaceLive,
  oppositeSeat,
  raceDeadlineMs,
  raceMetrics,
  raceViewFor,
  resolveRace,
  seatForUser,
  seatNumber,
  userIdForSeat,
  verifyTypedText,
} from "../src/lib/speed-typing/rules.ts";
import {
  DEAD_HEAT_TOLERANCE_MS,
  RACE_COUNTDOWN_MS,
  RACE_LIMIT_MS,
  RESOLUTION,
  SEAT,
} from "../src/lib/speed-typing/constants.ts";

const read = (rel) => fs.readFileSync(rel, "utf8");
const code = (rel) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");

const STORE = "src/lib/speed-typing/serverStore.ts";
const STORE_CODE = code(STORE);

const GO = 1_700_000_000_000;
const DEADLINE = GO + RACE_LIMIT_MS;

/** A live race state with both seats fresh. */
function liveState() {
  return createRaceState({ version: 1 });
}

/** A state where a seat has finished at `atMs` with `typed` characters. */
function stateWithFinish({ seat, atMs, charsTyped, errors = 0 }) {
  const state = liveState();
  state.seats[seat] = {
    ...state.seats[seat],
    charsTyped,
    errors,
    finished: true,
    finishedAtMs: atMs,
    elapsedMs: atMs - GO,
    wpm: 60,
    accuracy: 100,
    updatedAtMs: atMs,
  };
  return state;
}

// ════════════════════════════════════════════════════════════════════════
// 1. The passage catalog — server-selected, versioned, deterministic
// ════════════════════════════════════════════════════════════════════════

test("catalog: every passage is plain, typable ASCII with a stable id", () => {
  assert.ok(SPEED_TYPING_PASSAGES.length >= 8, "a small catalog would repeat quickly");
  const ids = new Set();
  for (const passage of SPEED_TYPING_PASSAGES) {
    assert.match(passage.id, /^pt-[0-9]{2}$/);
    assert.equal(ids.has(passage.id), false, `duplicate passage id ${passage.id}`);
    ids.add(passage.id);
    // ASCII only: a smart quote or an accent is not typable on every keyboard,
    // and this text is compared character by character.
    assert.match(passage.text, /^[\x20-\x7E]+$/, `${passage.id} must be plain ASCII`);
    assert.doesNotMatch(passage.text, /"/, `${passage.id} must not need an escaped quote`);
    assert.doesNotMatch(passage.text, /\s{2,}/, `${passage.id} must not rely on double spaces`);
    assert.equal(passage.text, passage.text.trim());
    const words = passageWordCount(passage.text);
    assert.ok(words >= 18 && words <= 60, `${passage.id} has ${words} words`);
  }
  assert.deepEqual(PASSAGE_IDS, SPEED_TYPING_PASSAGES.map((p) => p.id));
});

test("catalog: selection is deterministic for a seed, and the seed alone decides", () => {
  for (const seed of [0, 1, 7, 42, 12345, 4294967295]) {
    const first = selectPassageForSeed({ seed });
    const second = selectPassageForSeed({ seed });
    assert.ok(first);
    assert.equal(first.id, second.id);
    assert.equal(passageIndexFromSeed(seed), passageIndexFromSeed(seed));
  }
});

test("catalog: the seeds spread across the catalog instead of walking it", () => {
  const seen = new Set();
  for (let seed = 0; seed < 400; seed += 1) {
    seen.add(selectPassageForSeed({ seed })?.id);
  }
  // Every SELECTABLE passage is reachable, and consecutive seeds do not march
  // in order. (Retired entries are excluded — see speed-typing-prompts.test.mjs.)
  assert.equal(seen.size, ENABLED_PASSAGES.length);
  assert.notEqual(
    passageIndexFromSeed(11),
    (passageIndexFromSeed(10) + 1) % ENABLED_PASSAGES.length,
    "a plain seed % length would walk the catalog in order",
  );
});

test("catalog: a passage id resolves ONLY under the version it was written in", () => {
  const known = SPEED_TYPING_PASSAGES[0].id;
  assert.ok(passageById(known, PASSAGE_VERSION));
  assert.equal(passageById(known, PASSAGE_VERSION + 1), null, "a future version must not resolve");
  assert.equal(passageById("pt-99", PASSAGE_VERSION), null);
  assert.equal(passageById(null, PASSAGE_VERSION), null);
  // A driver may hand back an integer as a string; that one case is coerced,
  // and nothing else is.
  assert.ok(passageById(known, String(PASSAGE_VERSION)));
  assert.equal(passageById(known, "nope"), null);
  assert.equal(passageById(known, PASSAGE_VERSION + 0.5), null);
  assert.equal(selectPassageForSeed({ seed: 1, version: PASSAGE_VERSION + 1 }), null);
  assert.equal(isPassageId(known), true);
  assert.equal(isPassageId("nope"), false);
});

test("catalog: a row resolves to the text the server selected for it", () => {
  const passage = selectPassageForSeed({ seed: 987654 });
  const row = {
    raceSeed: 987654,
    passageId: passage.id,
    passageVersion: PASSAGE_VERSION,
  };
  assert.equal(passageForRow(row)?.text, passage.text);
  // The stored pair wins, so a legacy row still resolves to the text it raced.
  assert.equal(
    passageForRow({ ...row, raceSeed: 1 })?.id,
    passage.id,
    "the stored passage id must outrank a re-derived one",
  );
  assert.equal(passageForRow({}), null, "an unarmed row has no passage");
  assert.equal(
    passageForRow({ passageId: "pt-01", passageVersion: PASSAGE_VERSION + 1 }),
    null,
    "an unresolvable pair must never fall back to anything",
  );
});

// ════════════════════════════════════════════════════════════════════════
// 2. Verification — the only way progress is ever produced
// ════════════════════════════════════════════════════════════════════════

const PASSAGE = "the quick brown fox jumps over the lazy dog";

test("verify: exactly the passage completes it", () => {
  const exact = verifyTypedText({ passageText: PASSAGE, typedText: PASSAGE });
  assert.equal(exact.ok, true);
  assert.equal(exact.charsTyped, PASSAGE.length);
  assert.equal(exact.errors, 0);
  assert.equal(exact.firstMismatch, -1);
  assert.equal(exact.length, PASSAGE.length);
});

test("verify: a prefix is progress, not a completion", () => {
  const prefix = verifyTypedText({ passageText: PASSAGE, typedText: "the quick brown" });
  assert.equal(prefix.ok, false);
  assert.equal(prefix.charsTyped, 15);
  assert.equal(prefix.errors, 0);
  assert.equal(prefix.firstMismatch, -1, "a correct prefix has no mismatch — just no finish");
});

test("verify: one wrong character is counted, located, and never credited", () => {
  const typo = `${PASSAGE.slice(0, 10)}X${PASSAGE.slice(11)}`;
  const result = verifyTypedText({ passageText: PASSAGE, typedText: typo });
  assert.equal(result.ok, false, "a typo must not complete the race");
  assert.equal(result.errors, 1);
  assert.equal(result.firstMismatch, 10);
  assert.equal(result.charsTyped, PASSAGE.length);
});

test("verify: extra characters past the end are ignored, not rewarded", () => {
  // A client may legitimately send the passage plus a trailing newline, or keep
  // typing for a moment after the last character lands.
  const over = verifyTypedText({ passageText: PASSAGE, typedText: `${PASSAGE}\n\nmore text` });
  assert.equal(over.ok, true);
  assert.equal(over.charsTyped, PASSAGE.length, "progress is capped at the passage");
  // And the cap cannot be used to skip: the passage itself must still be exact.
  // Uppercase Q never appears in this passage, so every position must mismatch.
  const cheated = verifyTypedText({ passageText: PASSAGE, typedText: "Q".repeat(PASSAGE.length) });
  assert.equal(cheated.ok, false);
  assert.equal(cheated.errors, PASSAGE.length);
});

test("verify: CRLF is normalised, and only CRLF", () => {
  const withLf = "line one\nline two";
  assert.equal(verifyTypedText({ passageText: withLf, typedText: "line one\r\nline two" }).ok, true);
  assert.equal(
    verifyTypedText({ passageText: withLf, typedText: "line one line two" }).ok,
    false,
    "a collapsed newline is a different text",
  );
  assert.equal(
    verifyTypedText({ passageText: "Hello World", typedText: "hello world" }).ok,
    false,
    "case is not folded",
  );
});

test("verify: a non-string submission is empty progress, never an error", () => {
  for (const value of [null, undefined, 42, {}, [], true]) {
    const result = verifyTypedText({ passageText: PASSAGE, typedText: value });
    assert.equal(result.ok, false);
    assert.equal(result.charsTyped, 0);
    assert.equal(result.errors, 0);
  }
  // And an empty passage can never be \"completed\".
  assert.equal(verifyTypedText({ passageText: "", typedText: "" }).ok, false);
});

// ════════════════════════════════════════════════════════════════════════
// 3. The server clock and the server-derived numbers
// ════════════════════════════════════════════════════════════════════════

test("clock: elapsed comes from the server's own instants", () => {
  const seat = { ...emptySeatRace(), charsTyped: 250, finishedAtMs: GO + 60_000 };
  const metrics = raceMetrics({ seat, goAtMs: GO, nowMs: GO + 999_999 });
  assert.equal(metrics.elapsedMs, 60_000, "a finished seat reports its frozen time");
  // 250 characters in 60s = 50 words per minute at five characters a word.
  assert.equal(metrics.wpm, 50);
  assert.equal(metrics.accuracy, 100);
  assert.equal(metrics.remainingMs, 0, "the limit has long passed");
});

test("clock: WPM counts CORRECT characters only", () => {
  const seat = { ...emptySeatRace(), charsTyped: 250, errors: 50, finishedAtMs: GO + 60_000 };
  const metrics = raceMetrics({ seat, goAtMs: GO, nowMs: GO + 60_000 });
  assert.equal(metrics.wpm, 40, "(250 - 50) / 5 = 40");
  assert.equal(metrics.accuracy, 80);
});

test("clock: an unarmed or not-yet-started race reports zeros, never a negative", () => {
  const seat = { ...emptySeatRace(), charsTyped: 10, errors: 1, finishedAtMs: GO - 5_000 };
  const before = raceMetrics({ seat, goAtMs: GO, nowMs: GO });
  assert.equal(before.elapsedMs, 0);
  const unarmed = raceMetrics({ seat: emptySeatRace(), goAtMs: null, nowMs: GO });
  assert.equal(unarmed.elapsedMs, 0);
  assert.equal(unarmed.wpm, 0);
  assert.equal(unarmed.accuracy, 0);
  assert.equal(unarmed.remainingMs, 0);
  // Typing nothing is 0% accurate, not 100% — a no-show must not look perfect.
  assert.equal(raceMetrics({ seat: emptySeatRace(), goAtMs: GO, nowMs: GO + 1 }).accuracy, 0);
});

test("clock: the deadline is GO + the limit, and duty follows from it", () => {
  assert.equal(raceDeadlineMs({ goAt: new Date(GO) }), DEADLINE);
  assert.equal(raceDeadlineMs({ goAt: null }), 0);
  assert.equal(raceDeadlineMs({ goAt: new Date(GO) }, 1_000), GO + 1_000);

  assert.equal(isRaceDue({ goAt: new Date(GO) }, DEADLINE - 1), false);
  assert.equal(isRaceDue({ goAt: new Date(GO) }, DEADLINE), true);
  // A resolved race is never due again.
  const resolved = liveState();
  resolved.resolvedAtMs = GO + 10;
  assert.equal(isRaceDue({ goAt: new Date(GO), raceState: resolved }, DEADLINE + 1), false);
  assert.equal(isRaceDue({ goAt: null }, DEADLINE + 1), false);
});

test("clock: a race is live only while the server says so", () => {
  const armed = { status: "playing", goAt: new Date(GO) };
  assert.equal(isRaceLive(armed, GO), true);
  assert.equal(isRaceLive(armed, DEADLINE), true);
  assert.equal(isRaceLive(armed, DEADLINE + 1), false);
  assert.equal(isRaceLive({ ...armed, status: "finished" }, GO + 10), false);
  assert.equal(isRaceLive({ status: "playing", goAt: null }, GO), false);
  // A countdown is the run-up to GO: the race is armed, and not yet running.
  assert.equal(isRaceLive({ status: "playing", goAt: new Date(GO) }, GO - 1_000), true);
  assert.equal(RACE_COUNTDOWN_MS > 0, true);
});

test("clock: instants parse from a Date, a number and an ISO string", () => {
  assert.equal(instantFromDate(new Date(GO)), GO);
  assert.equal(instantFromDate(GO), GO);
  assert.equal(instantFromDate(new Date(GO).toISOString()), GO);
  assert.equal(instantFromDate(null), null);
  assert.equal(instantFromDate("not a date"), null);
  assert.equal(instantFromDate(new Date("nope")), null);
  assert.equal(instantFromDate(0), null);
});

// ════════════════════════════════════════════════════════════════════════
// 4. Seats
// ════════════════════════════════════════════════════════════════════════

test("seats: a seat comes from the ROW, and a stranger has none", () => {
  const match = { player1Id: "a", player2Id: "b" };
  assert.equal(seatForUser(match, "a"), SEAT.PLAYER1);
  assert.equal(seatForUser(match, "b"), SEAT.PLAYER2);
  assert.equal(seatForUser(match, "c"), null);
  assert.equal(seatForUser(match, null), null);
  assert.equal(seatForUser({ player1Id: "a" }, "b"), null, "an empty seat is nobody's");
  assert.equal(oppositeSeat(SEAT.PLAYER1), SEAT.PLAYER2);
  assert.equal(oppositeSeat(SEAT.PLAYER2), SEAT.PLAYER1);
  assert.equal(userIdForSeat(match, SEAT.PLAYER1), "a");
  assert.equal(userIdForSeat(match, SEAT.PLAYER2), "b");
  assert.equal(userIdForSeat({ player1Id: "a" }, SEAT.PLAYER2), null);
  assert.equal(seatNumber(SEAT.PLAYER1), 1);
  assert.equal(seatNumber(SEAT.PLAYER2), 2);
});

// ════════════════════════════════════════════════════════════════════════
// 5. Checkpoints — throttled, monotonic, and never a row per keystroke
// ════════════════════════════════════════════════════════════════════════

/** Drive one checkpoint through the rules with sensible defaults. */
function checkpoint({
  state = liveState(),
  seat = SEAT.PLAYER1,
  typed,
  nowMs = GO + 1_000,
  goAtMs = GO,
  minAdvance = 0,
}) {
  return evaluateCheckpoint({
    state,
    seat,
    verification: verifyTypedText({ passageText: PASSAGE, typedText: typed }),
    nowMs,
    goAtMs,
    minAdvance,
  });
}

test("checkpoint: real progress is accepted and stored as the server measured it", () => {
  const decision = checkpoint({ typed: PASSAGE.slice(0, 12) });
  assert.equal(decision.accept, true);
  assert.equal(decision.reason, "accepted");
  assert.equal(decision.seat.charsTyped, 12);
  assert.equal(decision.seat.errors, 0);
  assert.equal(decision.seat.updatedAtMs, GO + 1_000);
});

test("checkpoint: nothing typed before GO is counted", () => {
  const early = checkpoint({ typed: PASSAGE, nowMs: GO - 1 });
  assert.equal(early.accept, false);
  assert.equal(early.reason, "before_go");
  assert.equal(early.seat.charsTyped, 0, "a pre-buffered passage must not count");
});

test("checkpoint: nothing after the hard limit is counted", () => {
  const late = checkpoint({ typed: PASSAGE, nowMs: DEADLINE + 1 });
  assert.equal(late.accept, false);
  assert.equal(late.reason, "past_deadline");
});

test("checkpoint: progress is MONOTONIC — a late, shorter packet cannot rewind a seat", () => {
  const state = liveState();
  const first = checkpoint({ state, typed: PASSAGE.slice(0, 20) });
  state.seats[SEAT.PLAYER1] = first.seat;

  const shorter = checkpoint({ state, typed: PASSAGE.slice(0, 5), nowMs: GO + 1_100 });
  assert.equal(shorter.accept, false, "there is no new information in a shorter prefix");
  assert.equal(shorter.reason, "no_advance");
  assert.equal(shorter.seat.charsTyped, 20, "the stored position is unchanged");

  const longer = checkpoint({ state, typed: PASSAGE.slice(0, 26), nowMs: GO + 1_200 });
  assert.equal(longer.accept, true);
  assert.equal(longer.seat.charsTyped, 26);
});

test("checkpoint: an error count never decreases, so a fix does not launder it", () => {
  const state = liveState();
  const typo = checkpoint({ state, typed: "the quXck brown" });
  assert.equal(typo.seat.errors, 1);
  state.seats[SEAT.PLAYER1] = typo.seat;

  // The player notices and corrects it, then continues.
  const fixed = checkpoint({ state, typed: "the quick brown fox", nowMs: GO + 1_100 });
  assert.equal(fixed.accept, true);
  assert.equal(fixed.seat.charsTyped, 19);
  assert.equal(fixed.seat.errors, 1, "accuracy reflects the whole race, not the last frame");
});

test("checkpoint: a resolved race and a closed seat accept nothing", () => {
  const resolved = liveState();
  resolved.resolvedAtMs = GO + 500;
  assert.equal(checkpoint({ state: resolved, typed: PASSAGE }).reason, "resolved");

  const finished = stateWithFinish({ seat: SEAT.PLAYER1, atMs: GO + 900, charsTyped: 43 });
  assert.equal(checkpoint({ state: finished, typed: PASSAGE }).reason, "seat_closed");

  const gone = liveState();
  gone.seats[SEAT.PLAYER1] = forfeitSeatRace(gone.seats[SEAT.PLAYER1], GO + 100);
  assert.equal(checkpoint({ state: gone, typed: PASSAGE }).reason, "seat_closed");
});

test("checkpoint: an unarmed race is refused rather than guessed at", () => {
  assert.equal(checkpoint({ typed: PASSAGE, goAtMs: null }).reason, "unarmed");
});

test("checkpoint: the throttle is what keeps a race out of the write path", () => {
  // With the shipped advance threshold, ordinary keystroke-rate calls are
  // rejected — which is the entire reason no rows exist per keystroke.
  const small = evaluateCheckpoint({
    state: liveState(),
    seat: SEAT.PLAYER1,
    verification: verifyTypedText({ passageText: PASSAGE, typedText: "the" }),
    nowMs: GO + 500,
    goAtMs: GO,
  });
  assert.equal(small.accept, false);
  assert.equal(small.reason, "below_threshold");

  // …but the same call WITH the default threshold and a real jump gets through.
  const jump = evaluateCheckpoint({
    state: liveState(),
    seat: SEAT.PLAYER1,
    verification: verifyTypedText({ passageText: PASSAGE, typedText: PASSAGE.slice(0, 20) }),
    nowMs: GO + 500,
    goAtMs: GO,
  });
  assert.equal(jump.accept, true);
});

test("checkpoint: a repeat of the same position is a no-op, not an accepted write", () => {
  const state = liveState();
  const first = checkpoint({ state, typed: PASSAGE.slice(0, 10) });
  state.seats[SEAT.PLAYER1] = first.seat;
  const again = checkpoint({ state, typed: PASSAGE.slice(0, 10), nowMs: GO + 1_100 });
  assert.equal(again.accept, false);
  assert.equal(again.reason, "no_advance");
});

// ════════════════════════════════════════════════════════════════════════
// 6. Finishing — verified, frozen, and idempotent
// ════════════════════════════════════════════════════════════════════════

function finish({
  state = liveState(),
  seat = SEAT.PLAYER1,
  typed = PASSAGE,
  nowMs = GO + 30_000,
  goAtMs = GO,
}) {
  return evaluateFinish({
    state,
    seat,
    verification: verifyTypedText({ passageText: PASSAGE, typedText: typed }),
    nowMs,
    goAtMs,
  });
}

test("finish: the exact passage is accepted, with server-derived numbers frozen", () => {
  const decision = finish({});
  assert.equal(decision.accept, true);
  assert.equal(decision.seat.finished, true);
  assert.equal(decision.seat.finishedAtMs, GO + 30_000);
  assert.equal(decision.seat.elapsedMs, 30_000);
  assert.equal(decision.seat.charsTyped, PASSAGE.length);
  assert.equal(decision.seat.wpm, Math.round(PASSAGE.length / 5 / 0.5));
  assert.equal(decision.seat.accuracy, 100);
});

test("finish: only the complete passage counts — a near miss is refused", () => {
  const partial = finish({ typed: PASSAGE.slice(0, PASSAGE.length - 1) });
  assert.equal(partial.accept, false);
  assert.equal(partial.reason, "incomplete");

  const typo = finish({ typed: `${PASSAGE.slice(0, 5)}X${PASSAGE.slice(6)}` });
  assert.equal(typo.accept, false);
  assert.equal(typo.reason, "incomplete");
  assert.equal(typo.firstMismatch, 5, "the refusal says where it went wrong");
});

test("finish: a replay is a duplicate with NO new state (the idempotency rule)", () => {
  const state = stateWithFinish({ seat: SEAT.PLAYER1, atMs: GO + 20_000, charsTyped: PASSAGE.length });
  const replay = finish({ state, nowMs: GO + 25_000 });
  assert.equal(replay.accept, false);
  assert.equal(replay.reason, "duplicate");
  assert.equal(replay.seat.finishedAtMs, GO + 20_000, "the FIRST verified finish stands");
  assert.equal(replay.seat.elapsedMs, 20_000);
});

test("finish: refused before GO, after the limit, on a resolved race, and after a forfeit", () => {
  assert.equal(finish({ nowMs: GO - 1 }).reason, "before_go");
  assert.equal(finish({ nowMs: DEADLINE + 1 }).reason, "past_deadline");
  assert.equal(finish({ goAtMs: null }).reason, "unarmed");

  const resolved = liveState();
  resolved.resolvedAtMs = GO + 100;
  assert.equal(finish({ state: resolved }).reason, "resolved");

  const gone = liveState();
  gone.seats[SEAT.PLAYER1] = forfeitSeatRace(gone.seats[SEAT.PLAYER1], GO + 100);
  assert.equal(finish({ state: gone }).reason, "seat_closed");
});

test("finish: a finish NEVER inherits an error count it did not earn", () => {
  const state = liveState();
  state.seats[SEAT.PLAYER1] = { ...state.seats[SEAT.PLAYER1], charsTyped: 10, errors: 3 };
  const decision = finish({ state });
  assert.equal(decision.accept, true);
  assert.equal(decision.seat.errors, 3, "the race's earlier mistakes are still on the record");
  assert.equal(decision.seat.accuracy, Math.round((PASSAGE.length - 3) / PASSAGE.length * 100));
});

// ════════════════════════════════════════════════════════════════════════
// 7. Resolution — the only place a winner exists
// ════════════════════════════════════════════════════════════════════════

test("resolve: the earlier verified finish wins", () => {
  const state = liveState();
  state.seats[SEAT.PLAYER1] = { ...emptySeatRace(), finished: true, finishedAtMs: GO + 20_000, charsTyped: 43 };
  state.seats[SEAT.PLAYER2] = { ...emptySeatRace(), finished: true, finishedAtMs: GO + 24_000, charsTyped: 43 };
  const outcome = resolveRace({ state, reason: RESOLUTION.FINISH, nowMs: GO + 30_000 });
  assert.equal(outcome.settled, true);
  assert.equal(outcome.winnerSeat, SEAT.PLAYER1);
  assert.equal(outcome.resolutionReason, RESOLUTION.FINISH);
  assert.equal(outcome.resolvedAtMs, GO + 30_000);
});

test("resolve: a photo-finish inside the tolerance is a DRAW, not a race on packet order", () => {
  const state = liveState();
  state.seats[SEAT.PLAYER1] = { ...emptySeatRace(), finished: true, finishedAtMs: GO + 20_000 };
  state.seats[SEAT.PLAYER2] = {
    ...emptySeatRace(),
    finished: true,
    finishedAtMs: GO + 20_000 + DEAD_HEAT_TOLERANCE_MS,
  };
  const outcome = resolveRace({ state, reason: RESOLUTION.FINISH, nowMs: GO + 30_000 });
  assert.equal(outcome.settled, true);
  assert.equal(outcome.winnerSeat, null);
  assert.equal(outcome.resolutionReason, RESOLUTION.DRAW);

  // One millisecond past the tolerance is a real win again.
  state.seats[SEAT.PLAYER2] = {
    ...emptySeatRace(),
    finished: true,
    finishedAtMs: GO + 20_000 + DEAD_HEAT_TOLERANCE_MS + 1,
  };
  assert.equal(
    resolveRace({ state, reason: RESOLUTION.FINISH, nowMs: GO + 30_000 }).winnerSeat,
    SEAT.PLAYER1,
  );
});

test("resolve: one finish and an unfinished opponent goes to the finisher", () => {
  const state = liveState();
  state.seats[SEAT.PLAYER2] = { ...emptySeatRace(), charsTyped: 40 };
  state.seats[SEAT.PLAYER1] = { ...emptySeatRace(), finished: true, finishedAtMs: GO + 21_000 };
  const outcome = resolveRace({ state, reason: RESOLUTION.FINISH, nowMs: GO + 30_000 });
  assert.equal(outcome.winnerSeat, SEAT.PLAYER1);
  assert.equal(outcome.resolutionReason, RESOLUTION.FINISH);
});

test("resolve: a forfeit hands the race to the seat still there", () => {
  const state = liveState();
  state.seats[SEAT.PLAYER2] = forfeitSeatRace(emptySeatRace(), GO + 5_000);
  state.seats[SEAT.PLAYER1] = { ...emptySeatRace(), charsTyped: 7 };
  const outcome = resolveRace({ state, reason: RESOLUTION.FORFEIT, nowMs: GO + 6_000 });
  assert.equal(outcome.winnerSeat, SEAT.PLAYER1);
  assert.equal(outcome.resolutionReason, RESOLUTION.FORFEIT, "a walkover is not a typed win");

  // Both gone is nobody's win.
  const both = liveState();
  both.seats[SEAT.PLAYER1] = forfeitSeatRace(emptySeatRace(), GO + 5_000);
  both.seats[SEAT.PLAYER2] = forfeitSeatRace(emptySeatRace(), GO + 5_000);
  const draw = resolveRace({ state: both, reason: RESOLUTION.FORFEIT, nowMs: GO + 6_000 });
  assert.equal(draw.winnerSeat, null);
  assert.equal(draw.resolutionReason, RESOLUTION.DRAW);
});

test("resolve: the deadline decides on authoritative progress, and a dead level is a draw", () => {
  const state = liveState();
  state.seats[SEAT.PLAYER1] = { ...emptySeatRace(), charsTyped: 30 };
  state.seats[SEAT.PLAYER2] = { ...emptySeatRace(), charsTyped: 12 };
  const outcome = resolveRace({ state, reason: RESOLUTION.DEADLINE, nowMs: DEADLINE });
  assert.equal(outcome.winnerSeat, SEAT.PLAYER1);
  assert.equal(outcome.resolutionReason, RESOLUTION.DEADLINE);

  const level = liveState();
  level.seats[SEAT.PLAYER1] = { ...emptySeatRace(), charsTyped: 12 };
  level.seats[SEAT.PLAYER2] = { ...emptySeatRace(), charsTyped: 12 };
  assert.equal(resolveRace({ state: level, reason: RESOLUTION.DEADLINE, nowMs: DEADLINE }).winnerSeat, null);

  // A race where neither seat typed anything settles as a draw, not as a win
  // for whoever happened to be seat 1.
  const idle = resolveRace({ state: liveState(), reason: RESOLUTION.DEADLINE, nowMs: DEADLINE });
  assert.equal(idle.settled, true);
  assert.equal(idle.winnerSeat, null);
  assert.equal(idle.resolutionReason, RESOLUTION.DRAW);
});

// ════════════════════════════════════════════════════════════════════════
// 8. Stored state is coerced, never trusted
// ════════════════════════════════════════════════════════════════════════

test("state: garbage reads as an empty race instead of throwing", () => {
  const empty = coerceRaceState(undefined);
  assert.deepEqual(empty.seats[SEAT.PLAYER1], emptySeatRace());
  assert.equal(empty.resolvedAtMs, null);
  for (const junk of [null, 0, "nope", [], true]) {
    assert.equal(coerceRaceState(junk).version, 0);
  }
  assert.equal(coerceRaceState({ seats: { player1: "nope" } }).seats[SEAT.PLAYER1].charsTyped, 0);
  assert.equal(coerceRaceState({ seats: null }).seats[SEAT.PLAYER2].charsTyped, 0);
});

test("state: negative, fractional and non-numeric counts cannot be stored as progress", () => {
  const state = coerceRaceState({
    version: -5,
    seats: {
      player1: { charsTyped: -100, errors: -3, finished: "yes", finishedAtMs: -1, updatedAtMs: 12.7 },
      player2: { charsTyped: 4.9, errors: NaN, elapsedMs: Infinity },
    },
  });
  assert.equal(state.version, 0);
  assert.equal(state.seats[SEAT.PLAYER1].charsTyped, 0);
  assert.equal(state.seats[SEAT.PLAYER1].errors, 0);
  assert.equal(state.seats[SEAT.PLAYER1].finished, false, "only a literal true counts as finished");
  assert.equal(state.seats[SEAT.PLAYER1].finishedAtMs, null);
  assert.equal(state.seats[SEAT.PLAYER1].updatedAtMs, 12);
  assert.equal(state.seats[SEAT.PLAYER2].charsTyped, 4);
  assert.equal(state.seats[SEAT.PLAYER2].errors, 0);
  assert.equal(state.seats[SEAT.PLAYER2].elapsedMs, null);
});

// ════════════════════════════════════════════════════════════════════════
// 9. The read model — the passage goes to PARTICIPANTS only
// ════════════════════════════════════════════════════════════════════════

const ROW = {
  id: "55555555-5555-4555-8555-555555555555",
  player1Id: "a",
  player2Id: "b",
  status: "playing",
  raceSeed: 987654,
  passageId: selectPassageForSeed({ seed: 987654 }).id,
  passageVersion: PASSAGE_VERSION,
  goAt: new Date(GO),
  revision: 7,
  raceState: liveState(),
  result: null,
  winnerId: null,
  isAi: false,
  aiDifficulty: null,
  createdAt: new Date(GO - 1_000),
  startedAt: new Date(GO - RACE_COUNTDOWN_MS),
  endedAt: null,
};

test("view: a participant gets the passage, the clock and both seats' state", () => {
  const view = raceViewFor({ match: ROW, seat: SEAT.PLAYER2, nowMs: GO });
  assert.equal(view.seat, 2);
  assert.equal(view.seatKey, SEAT.PLAYER2);
  assert.equal(view.passageText, selectPassageForSeed({ seed: 987654 }).text);
  assert.equal(view.passageId, ROW.passageId);
  assert.equal(view.passageVersion, PASSAGE_VERSION);
  assert.equal(view.goAtMs, GO);
  assert.equal(view.deadlineMs, DEADLINE);
  assert.equal(view.revision, 7);
  assert.equal(view.resolvedAtMs, null);
  assert.equal(view.metrics.you.elapsedMs, 0);
});

test("view: an unarmed row yields no passage rather than an empty race on real text", () => {
  const view = raceViewFor({
    match: {
      ...ROW,
      goAt: null,
      raceSeed: null,
      passageId: null,
      passageVersion: null,
      raceState: null,
      revision: 0,
    },
    seat: SEAT.PLAYER1,
    nowMs: GO,
  });
  assert.equal(view.passageText, "");
  assert.equal(view.passageId, null);
  assert.equal(view.goAtMs, null);
  assert.equal(view.deadlineMs, 0);
  assert.equal(view.revision, 0);
});

// ════════════════════════════════════════════════════════════════════════
// 10. The store contract — row locks, one transaction, no client authority
// ════════════════════════════════════════════════════════════════════════

/**
 * The source of one declared function, from its name to its closing brace.
 *
 * The parameter list is paren-matched first (a default like `nowMs = Date.now()`
 * contains parens of its own), and the BODY brace is the next `{` after it —
 * taking the first `)` in the file instead would land inside the parameter
 * types and silently slice the wrong text.
 */
function functionSource(name) {
  const start = STORE_CODE.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start > -1, `${name} must exist in ${STORE}`);
  const parenOpen = STORE_CODE.indexOf("(", STORE_CODE.indexOf(name, start) + name.length);
  let depth = 0;
  let cursor = parenOpen;
  for (; cursor < STORE_CODE.length; cursor += 1) {
    if (STORE_CODE[cursor] === "(") depth += 1;
    else if (STORE_CODE[cursor] === ")") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  const open = STORE_CODE.indexOf("{", cursor);
  depth = 0;
  for (let i = open; i < STORE_CODE.length; i += 1) {
    if (STORE_CODE[i] === "{") depth += 1;
    else if (STORE_CODE[i] === "}") {
      depth -= 1;
      if (depth === 0) return STORE_CODE.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

test("store: every mutating function takes the row lock BEFORE it decides", () => {
  const mutators = [
    "createOrJoin",
    "joinExistingMatch",
    "cancelMatch",
    "armRace",
    "recordProgress",
    "submitFinish",
    "forfeitMatch",
    "resolveDueRace",
  ];
  for (const name of mutators) {
    const source = functionSource(name);
    assert.match(source, /for\("update"\)/, `${name} must lock the row it decides on`);
  }
  // And the lock is always the first thing inside the transaction.
  for (const name of ["recordProgress", "submitFinish", "forfeitMatch", "resolveDueRace", "armRace"]) {
    const source = functionSource(name);
    assert.ok(source.includes(".update("), `${name} is expected to write`);
    assert.ok(
      source.indexOf('for("update")') < source.indexOf(".update("),
      `${name} must read under the lock before it writes`,
    );
  }
});

test("store: a finish is verified against the SERVER's passage, never the request", () => {
  const source = functionSource("submitFinish");
  assert.match(source, /passageForRow\(match\)/, "the passage comes from the row");
  assert.match(source, /verifyTypedText\(\{ passageText: passage\.text, typedText \}\)/);
  assert.match(source, /evaluateFinish\(\{/);
  // The whole function, comments stripped, contains no client-decides-a-number
  // pattern: nothing reads a winner, a score, a duration or a rating.
  for (const forbidden of [
    /request\.json|await req\.json|body\./,
    /\bwinner(Seat|Id)?\s*[:=]\s*(body|input|payload|params)/i,
    /(elo|rating|troph)\w*\s*[:=]\s*(body|input|payload)/i,
    /(wpm|accuracy|elapsed|duration|score|completionTime)\s*[:=]\s*(body|input|payload)/i,
  ]) {
    assert.doesNotMatch(source, forbidden);
  }
  // …and it reads no such field off its own arguments at all.
  assert.doesNotMatch(source, /params\.(winner|elo|wpm|accuracy|elapsed|score)/i);
});

test("store: the mutating signatures accept a user, a match, typed text and a clock", () => {
  // The parameter lists are the trust boundary: anything a client can set must
  // appear here, and nothing that decides the result may.
  for (const name of ["recordProgress", "submitFinish"]) {
    const source = functionSource(name);
    const args = source.slice(source.indexOf("({"), source.indexOf("}) {"));
    assert.match(args, /userId/);
    assert.match(args, /matchId/);
    assert.match(args, /typedText/);
    for (const forbidden of [/winner/i, /elo/i, /rating/i, /trophy/i, /wpm/i, /accuracy/i, /elapsed/i, /score/i]) {
      assert.doesNotMatch(args, forbidden, `${name} must not accept ${forbidden}`);
    }
  }
});

test("store: the terminal write and the settlement share ONE transaction", () => {
  for (const name of ["submitFinish", "forfeitMatch", "resolveDueRace"]) {
    const source = functionSource(name);
    const terminal = source.indexOf("terminalColumnsFor(");
    const settle = source.indexOf("settleFinishedRace(tx,");
    assert.ok(terminal > -1, `${name} must write the terminal columns`);
    assert.ok(settle > terminal, `${name} must settle after the verdict is written`);
    // Both inside the same `db.transaction` body — there is no second one.
    assert.equal(
      (source.match(/db\.transaction\(/g) ?? []).length,
      1,
      `${name} must not open a second transaction`,
    );
  }
});

test("store: settlement goes through the ONE shared seam, not the writers", () => {
  const source = functionSource("settleFinishedRace");
  assert.match(source, /settleSpeedTypingMatch\(\{/);
  // The shared writers are imported for the seam, never called from the race.
  assert.doesNotMatch(source, /applyRatingResult\(/);
  assert.doesNotMatch(source, /applyTrophyResult\(/);
  // Practice matches and an empty seat never settle.
  assert.match(source, /if \(match\.isAi\) return/);
  assert.match(source, /if \(!match\.player2Id\) return/);
});

test("store: a duplicate finish returns before the first write", () => {
  const source = functionSource("submitFinish");
  const duplicate = source.indexOf('"duplicate"');
  const firstWrite = source.indexOf("tx\n      .update");
  assert.ok(duplicate > -1, "the duplicate path must exist");
  assert.ok(
    duplicate < firstWrite,
    "the already-finished check must short-circuit before any write",
  );
  // The stored verdict is what a replay returns: the frozen server instants.
  assert.match(source, /reason: state\.seats\[seat\]\?\.finished \? "duplicate" : "resolved"/);
});

test("store: a rejected checkpoint writes nothing at all", () => {
  const source = functionSource("recordProgress");
  const rejected = source.indexOf("if (!decision.accept)");
  const write = source.indexOf("tx\n      .update");
  assert.ok(rejected > -1 && rejected < write, "the throttle must gate the write");
});

test("store: a checkpoint after the race ends is a benign no-op, not an error", () => {
  const source = functionSource("recordProgress");
  // A checkpoint stream keeps arriving for a moment after the race resolves;
  // the socket layer must not have to treat a late packet as a failure.
  assert.match(source, /TERMINAL_STATUSES\.includes\(String\(match\.status\)\)/);
  assert.match(source, /reason: "resolved"/);
  // The one remaining 409 is the un-joined lobby.
  assert.match(source, /Waiting for an opponent", status: 409/);
});

test("store: the participant read path is the ONLY gate on the race view", () => {
  const read = functionSource("fetchMatch");
  const gate = read.indexOf("if (!isParticipant(match, userId))");
  const view = read.indexOf("matchViewFor(");
  assert.ok(gate > -1, "fetchMatch must refuse a non-participant");
  assert.ok(view > gate, "the race view must be built only after the participant check");
  // The route that serves the snapshot cannot widen that access either.
  const route = code("src/app/api/speed-typing/match/[matchId]/route.ts");
  assert.match(route, /requireAgeVerifiedUser\(\)/);
  assert.doesNotMatch(route, /matchToDto|raceViewFor/);
});

test("store: a race never writes a row per keystroke", () => {
  // The store's ONLY insert is the match row itself. Nothing inserts progress,
  // keystrokes or events — checkpoints update the row they belong to.
  const inserts = [...STORE_CODE.matchAll(/\.insert\(([A-Za-z0-9_]+)\)/g)].map((m) => m[1]);
  assert.deepEqual(inserts, ["speedTypingMatches"]);
  // Progress is persisted as a checkpoint on the match row, with the
  // authoritative blob alongside the denormalised columns.
  assert.match(functionSource("recordProgress"), /raceState: nextState/);
  assert.match(functionSource("recordProgress"), /progressColumnsFor\(seat/);
});

test("store: the race is armed on the join, with an absolute GO instant", () => {
  assert.match(STORE_CODE, /function armedRaceValues\(/);
  const arming = functionSource("armedRaceValues");
  assert.match(arming, /goAt: new Date\(Math\.floor\(nowMs\) \+ RACE_COUNTDOWN_MS\)/);
  assert.match(arming, /selectPassageForSeed\(\{ seed: raceSeed, version: PASSAGE_VERSION \}\)/);
  assert.match(functionSource("joinExistingMatch"), /\.\.\.armed,/);
});

test("store: the race view is built for participants only", () => {
  const view = functionSource("matchViewFor");
  assert.match(view, /seatForUser\(match, viewerId\)/);
  assert.match(view, /seat \? raceViewFor\(\{ match, seat, nowMs \}\) : null/);
  // The lifecycle DTO stays free of race data, so a public read cannot leak it.
  const dto = functionSource("matchToDto");
  assert.doesNotMatch(dto, /passage|keystrokes|wpm|accuracy|raceState/i);
});

test("store: a practice match settles nothing, and the counters stay opt-in", () => {
  assert.match(functionSource("mirrorCompletedRace"), /if \(match\.isAi\) return/);
});

// ════════════════════════════════════════════════════════════════════════
// 11. Typing behaviour — every case the rules engine must answer for
// ════════════════════════════════════════════════════════════════════════
//
// The verification rules, case by case. These are the questions a competitive
// typing game has to answer the same way every time: what an empty buffer
// means, what a first keystroke means, what a wrong character costs, what
// backspace does, what a flood of text does, and what "finished" actually
// requires. Each answer is a pure arithmetic fact about the SERVER's passage.

test("typing: empty input is zero progress, never an error and never a finish", () => {
  for (const empty of ["", null, undefined]) {
    const result = verifyTypedText({ passageText: PASSAGE, typedText: empty });
    assert.equal(result.ok, false);
    assert.equal(result.charsTyped, 0);
    assert.equal(result.errors, 0);
    assert.equal(result.correctChars, 0);
    assert.equal(result.firstMismatch, -1);
  }
});

test("typing: the first correct character is progress, and still not a completion", () => {
  const result = verifyTypedText({ passageText: PASSAGE, typedText: PASSAGE[0] });
  assert.equal(result.charsTyped, 1);
  assert.equal(result.errors, 0);
  assert.equal(result.correctChars, 1);
  assert.equal(result.firstMismatch, -1);
  assert.equal(result.ok, false, "a prefix is progress, not a win");
});

test("typing: every wrong character is counted, and the FIRST one is located", () => {
  // Two typos early, one later: three mistakes, reported from the first.
  const typed = `${PASSAGE.slice(0, 4)}XX${PASSAGE.slice(6, 9)}Y${PASSAGE.slice(10)}`;
  const result = verifyTypedText({ passageText: PASSAGE, typedText: typed });
  assert.equal(result.errors, 3);
  assert.equal(result.firstMismatch, 4);
  assert.equal(result.charsTyped, PASSAGE.length);
  assert.equal(result.correctChars, PASSAGE.length - 3);
  assert.equal(result.ok, false);
});

test("typing: a corrected submission is verified clean; the attempt is not", () => {
  const wrong = "the quXck brown fox";
  const fixed = "the quick brown fox";
  const bad = verifyTypedText({ passageText: PASSAGE, typedText: wrong });
  const good = verifyTypedText({ passageText: PASSAGE, typedText: fixed });
  assert.equal(bad.errors, 1);
  assert.equal(good.errors, 0, "the corrected text matches on its own");
  assert.equal(good.correctChars, fixed.length);
  assert.equal(good.ok, false, "still a prefix — not the passage");
  // The two submissions are the same LENGTH, so the cursor does not move on
  // the correction; only the error tally carries forward. See the checkpoint
  // tests below for how the race records the mistake permanently.
  assert.equal(bad.charsTyped, good.charsTyped);
});

test("typing: Unicode is compared exactly, code unit by code unit, and never throws", () => {
  // A precomposed accent and an astral character in one passage.
  const unicode = "caf\u00e9 \ud83d\ude00 d\u00e9j\u00e0";
  assert.equal(verifyTypedText({ passageText: unicode, typedText: unicode }).ok, true);

  // A different astral character is a mismatch, counted per UTF-16 code unit.
  // (These two emoji differ in BOTH code units, so the cost is explicit.)
  const astral = "a\ud83d\ude00b";
  const different = verifyTypedText({ passageText: astral, typedText: "a\ud83c\udf00b" });
  assert.equal(different.ok, false);
  assert.equal(different.charsTyped, astral.length);
  assert.equal(different.errors, 2, "an astral character is two code units");

  // Two emoji that share a high surrogate differ in ONE code unit — which is
  // exactly what "compared as UTF-16 code units" means, and why a partial
  // astral match must not be able to complete a passage.
  const shared = verifyTypedText({
    passageText: "x\ud83d\ude00y",
    typedText: "x\ud83d\ude0ey",
  });
  assert.equal(shared.ok, false);
  assert.equal(shared.errors, 1);

  // No normalisation: a precomposed \u00e9 is not e followed by U+0301. The
  // rules compare code units exactly — documents are not "helpfully" folded.
  assert.equal(
    verifyTypedText({ passageText: "caf\u00e9", typedText: "cafe\u0301" }).ok,
    false,
  );

  // Malformed non-string input is empty progress against a Unicode passage
  // too — a Buffer, an object claiming progress, a number. Never a throw.
  for (const junk of [Buffer.from("caf\u00e9"), { charsTyped: 999 }, 42, []]) {
    const result = verifyTypedText({ passageText: unicode, typedText: junk });
    assert.equal(result.ok, false);
    assert.equal(result.charsTyped, 0);
    assert.equal(result.errors, 0);
  }
});

test("typing: completion demands the exact passage, down to the final character", () => {
  const oneShort = PASSAGE.slice(0, PASSAGE.length - 1);
  const short = verifyTypedText({ passageText: PASSAGE, typedText: oneShort });
  assert.equal(short.ok, false);
  assert.equal(short.charsTyped, PASSAGE.length - 1);
  assert.equal(short.correctChars, PASSAGE.length - 1);

  // The last character wrong is still not a completion, and says where.
  const lastWrong = `${PASSAGE.slice(0, -1)}x`;
  const wrong = verifyTypedText({ passageText: PASSAGE, typedText: lastWrong });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.firstMismatch, PASSAGE.length - 1);
  assert.equal(wrong.errors, 1);

  // Exactly the passage — no more, no less — completes.
  const exact = verifyTypedText({ passageText: PASSAGE, typedText: PASSAGE });
  assert.equal(exact.ok, true);
  assert.equal(exact.charsTyped, PASSAGE.length);
  assert.equal(exact.correctChars, PASSAGE.length);
});

test("typing: an empty passage can never be completed, by anything", () => {
  for (const typedText of ["", "a", PASSAGE, null, {}]) {
    const result = verifyTypedText({ passageText: "", typedText });
    assert.equal(result.ok, false, "there is no text to complete");
    assert.equal(result.charsTyped, 0);
  }
  // A non-string passage is not a passage either: it verifies as empty.
  assert.equal(verifyTypedText({ passageText: null, typedText: PASSAGE }).ok, false);
});

test("typing: identical input always verifies identically (deterministic)", () => {
  for (const typedText of ["", "the", "the quXck", PASSAGE, `${PASSAGE}extra`]) {
    assert.deepEqual(
      verifyTypedText({ passageText: PASSAGE, typedText }),
      verifyTypedText({ passageText: PASSAGE, typedText }),
    );
  }
  // And the derived final statistics are deterministic too.
  const seat = { ...emptySeatRace(), charsTyped: 43, errors: 2, finishedAtMs: GO + 30_000 };
  assert.deepEqual(
    raceMetrics({ seat, goAtMs: GO, nowMs: GO + 30_000 }),
    raceMetrics({ seat, goAtMs: GO, nowMs: GO + 30_000 }),
  );
});

// ════════════════════════════════════════════════════════════════════════
// 12. Backspace, correction and impossible claims at the checkpoint
// ════════════════════════════════════════════════════════════════════════

test("backspace: deleting text cannot rewind progress or erase a mistake", () => {
  const state = liveState();
  const typo = checkpoint({ state, typed: "the quXck brown fo", nowMs: GO + 500 });
  assert.equal(typo.seat.charsTyped, 18);
  assert.equal(typo.seat.errors, 1);
  state.seats[SEAT.PLAYER1] = typo.seat;

  // Backspace all the way to "the qu" — a shorter, clean prefix.
  const back = checkpoint({ state, typed: "the qu", nowMs: GO + 600 });
  assert.equal(back.accept, false);
  assert.equal(back.reason, "no_advance");
  assert.equal(back.seat.charsTyped, 18, "progress never moves backwards");
  assert.equal(back.seat.errors, 1, "the mistake is on the record for good");

  // Retype past the old position: progress resumes; the error stays counted.
  const retyped = checkpoint({ state, typed: "the quick brown fox jumps", nowMs: GO + 700 });
  assert.equal(retyped.accept, true);
  assert.equal(retyped.seat.charsTyped, 25);
  assert.equal(retyped.seat.errors, 1);
  assert.equal(correctCharsFor(retyped.seat), 24);
});

test("jump: progress is credited only as far as the submission actually verifies", () => {
  const state = liveState();
  const first = checkpoint({ state, typed: PASSAGE.slice(0, 5) });
  state.seats[SEAT.PLAYER1] = first.seat;
  assert.equal(first.seat.charsTyped, 5);

  // Ten times the passage, all of it wrong. A client shouting "I am finished"
  // cannot pass the cursor beyond the passage, and earns no correct progress.
  const flood = checkpoint({
    state,
    typed: "Q".repeat(PASSAGE.length * 10),
    nowMs: GO + 800,
  });
  assert.equal(flood.seat.charsTyped, PASSAGE.length, "progress is capped at the passage");
  assert.equal(flood.seat.errors, PASSAGE.length, "every wrong position is a mistake");
  assert.equal(correctCharsFor(flood.seat), 0, "a flood of wrong characters earns nothing");

  // A numeric/JSON "progress" claim is not text, so it is empty progress and
  // the stored position is unchanged. The engine derives progress; it never
  // accepts one.
  const junk = checkpoint({ state, typed: { charsTyped: 999 }, nowMs: GO + 900 });
  assert.equal(junk.accept, false);
  assert.equal(junk.reason, "no_advance");
  assert.equal(junk.seat.charsTyped, 5);
});

test("progress: correct characters are the single measure behind WPM, accuracy and the clock", () => {
  const seat = { ...emptySeatRace(), charsTyped: 100, errors: 25, finishedAtMs: GO + 60_000 };
  assert.equal(correctCharsFor(seat), 75);
  const metrics = raceMetrics({ seat, goAtMs: GO, nowMs: GO + 60_000 });
  assert.equal(metrics.accuracy, 75, "75 correct of 100 typed");
  assert.equal(metrics.wpm, 15, "(100 - 25) / 5 over one minute");

  // The helper is total: garbage can never yield a negative or NaN count.
  assert.equal(correctCharsFor({ charsTyped: 5, errors: 9 }), 0);
  assert.equal(correctCharsFor({ charsTyped: -10, errors: -1 }), 0);
  assert.equal(correctCharsFor({}), 0);
  assert.equal(correctCharsFor(null), 0);
});

test("resolve: the deadline rewards CORRECT progress, not keys pressed", () => {
  const state = liveState();
  // Seat 1 mashed the keyboard to the end of the passage but got almost none of
  // it right; seat 2 typed honestly and correctly as far as 11 characters.
  state.seats[SEAT.PLAYER1] = {
    ...emptySeatRace(),
    charsTyped: PASSAGE.length,
    errors: PASSAGE.length - 4,
  };
  state.seats[SEAT.PLAYER2] = { ...emptySeatRace(), charsTyped: 12, errors: 1 };

  assert.ok(
    state.seats[SEAT.PLAYER1].charsTyped > state.seats[SEAT.PLAYER2].charsTyped,
    "the masher is further along by the raw cursor measure",
  );
  const outcome = resolveRace({ state, reason: RESOLUTION.DEADLINE, nowMs: DEADLINE });
  assert.equal(outcome.winnerSeat, SEAT.PLAYER2, "honest typing beats key-mashing");
  assert.equal(outcome.resolutionReason, RESOLUTION.DEADLINE);

  // Equal CORRECT progress is a draw, even when the raw cursors differ.
  const level = liveState();
  level.seats[SEAT.PLAYER1] = { ...emptySeatRace(), charsTyped: 40, errors: 12 };
  level.seats[SEAT.PLAYER2] = { ...emptySeatRace(), charsTyped: 30, errors: 2 };
  assert.equal(
    resolveRace({ state: level, reason: RESOLUTION.DEADLINE, nowMs: DEADLINE }).winnerSeat,
    null,
  );
});

test("progress: a checkpoint records how far the cursor reached, not a claim", () => {
  const decision = checkpoint({ typed: "the quick brown" });
  assert.equal(decision.seat.charsTyped, 15);
  assert.equal(correctCharsFor(decision.seat), 15);

  // A later submission of the same length but wrong text advances the cursor
  // while earning nothing correct — which is exactly why the deadline rule
  // above compares correct characters and not the cursor.
  const state = liveState();
  state.seats[SEAT.PLAYER1] = decision.seat;
  const garbage = checkpoint({ state, typed: "z".repeat(30), nowMs: GO + 1_100 });
  assert.equal(garbage.seat.charsTyped, 30, "the cursor follows the submission");
  assert.equal(correctCharsFor(garbage.seat), 0, "…but it earns no correct characters");
});
