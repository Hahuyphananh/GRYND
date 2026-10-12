// Precision — the round-result cooldown in front of the next countdown.
//
// Regression: a decided round armed the next one IMMEDIATELY, so the 5s
// pre-round countdown ran concurrently with the 3s round-result overlay. Both
// players are looking at the overlay (and a client only learns of the decision
// on its next read — the poll, or the socket broadcast when it is the seat that
// stopped second), so the countdown's first seconds were spent behind it. With
// a late-enough observation the round OPENED while the overlay was still up:
// the timer was already running when the player got their screen back, and the
// elapsed they then saw had nothing to do with the round they were shown.
//
// The fix sequences the two windows: `ROUND_RESULT_REVEAL_MS` (shared with the
// overlay, so they cannot drift) is folded into the armed envelope as dead time
// in front of the countdown — `countdownEndsAt = now + ROUND_RESULT_REVEAL_MS +
// ROUND_COUNTDOWN_MS` — and the client clamps the countdown it DISPLAYS to
// `ROUND_COUNTDOWN_MS`, so the cooldown reads as a hold rather than extra
// ticks.
//
// Only rounds that FOLLOW a decision get the gate; the first round (both seats
// just readied) has no result on screen to protect.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  armRoundState,
  generateRoundNonce,
  isArmedRoundDue,
  makeInitialMatch,
} from "../src/lib/precision/engine.ts";
import {
  ROUND_COUNTDOWN_MS,
  ROUND_RESULT_REVEAL_MS,
} from "../src/lib/precision/constants.ts";

const read = (relative) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

function match(id = "test-cooldown") {
  return makeInitialMatch(
    id,
    25,
    [
      { seat: 1, userId: "a", name: "A", isReady: true, isConnected: true },
      { seat: 2, userId: "b", name: "B", isReady: true, isConnected: true },
    ],
    "active",
    1,
  );
}

test("the next round's countdown is held behind the round-result cooldown", () => {
  const m = match();
  const decisionAt = 900_000;
  armRoundState(m, generateRoundNonce(), decisionAt, ROUND_RESULT_REVEAL_MS);

  assert.equal(m.phase, "arming");
  assert.equal(m.armingStartedAt, decisionAt);
  assert.equal(
    m.countdownEndsAt,
    decisionAt + ROUND_RESULT_REVEAL_MS + ROUND_COUNTDOWN_MS,
    "the countdown must sit BEHIND the cooldown, not on top of it",
  );

  // The overlay is on screen for ROUND_RESULT_REVEAL_MS after the decision.
  assert.equal(
    isArmedRoundDue(m, decisionAt + ROUND_RESULT_REVEAL_MS),
    false,
    "the round must not open while the result overlay is still up",
  );
  // The countdown itself starts exactly when the cooldown ends, and the round
  // opens a full countdown later — so the player always gets the whole 5..1.
  const countdownStartsAt = m.countdownEndsAt - ROUND_COUNTDOWN_MS;
  assert.equal(countdownStartsAt, decisionAt + ROUND_RESULT_REVEAL_MS);
  assert.equal(isArmedRoundDue(m, m.countdownEndsAt - 1), false);
  assert.equal(isArmedRoundDue(m, m.countdownEndsAt), true);
});

test("the arms are ordered: cooldown, then countdown, then the round", () => {
  const m = match();
  const decisionAt = 1_500_000;
  armRoundState(m, generateRoundNonce(), decisionAt, ROUND_RESULT_REVEAL_MS);

  const opensAt = m.countdownEndsAt;
  assert.ok(opensAt > decisionAt + ROUND_RESULT_REVEAL_MS);
  assert.ok(opensAt - decisionAt >= ROUND_RESULT_REVEAL_MS + ROUND_COUNTDOWN_MS);
});

test("the first round has no cooldown in front of it", () => {
  const m = match("test-first-round");
  const armedAt = 10_000;
  // Ready-up arm: both players are already looking at the board, and there is
  // no previous round's result to protect.
  armRoundState(m, generateRoundNonce(), armedAt);

  assert.equal(
    m.countdownEndsAt,
    armedAt + ROUND_COUNTDOWN_MS,
    "round 1 keeps its plain countdown",
  );
  assert.equal(isArmedRoundDue(m, armedAt + ROUND_COUNTDOWN_MS), true);
});

test("a degenerate cooldown can never shorten the window", () => {
  for (const bad of [-5_000, Number.NaN, Number.POSITIVE_INFINITY]) {
    const m = match(`test-bad-${String(bad)}`);
    const armedAt = 20_000;
    armRoundState(m, generateRoundNonce(), armedAt, bad);
    assert.equal(
      m.countdownEndsAt,
      armedAt + ROUND_COUNTDOWN_MS,
      `an unusable revealMs (${String(bad)}) must not move the round earlier`,
    );
  }
});

test("the overlay and the server gate read one shared constant", () => {
  // The overlay must not keep a private copy: if the two numbers drift, the
  // gate can end up SHORTER than the overlay and the round opens behind it
  // again — the exact bug this file pins.
  assert.match(
    read("../src/components/precision/PrecisionRoundResultPanel.tsx"),
    /export \{ ROUND_RESULT_REVEAL_MS \} from "\.\.\/\.\.\/lib\/precision\/constants";/,
    "the overlay must re-export the shared ROUND_RESULT_REVEAL_MS, not redefine it",
  );
  assert.ok(ROUND_RESULT_REVEAL_MS > 0);
  assert.ok(ROUND_COUNTDOWN_MS > 0);
});

test("the store only gates the rounds that follow a decision", () => {
  const store = read("../src/lib/precision/serverStore.ts");
  // The post-decision arm passes the cooldown…
  assert.match(
    store,
    /armRound\(write, now, ROUND_RESULT_REVEAL_MS\)/,
    "the between-rounds arm must hold the countdown behind the cooldown",
  );
  // …and the ready-up arm (the first round) does not.
  assert.match(
    store,
    /\/\/ Both seats ready → arm round 1 immediately[\s\S]{0,400}?armRound\(write, now\);/,
    "the first round must be armed with no cooldown in front of it",
  );
});

test("the result popup ends where the countdown begins, and never over a live round", () => {
  // The other half of the same rule. The server's gate sequences the
  // countdown behind the result; the CLIENT's reveal has to end on that same
  // server instant, or the player reads the countdown's tail (a popup window
  // measured from OBSERVATION drifts by the delivery lag, and a late enough
  // observation put the popup on top of a round that was already live).
  const matchView = read("../src/lib/precision/matchView.ts");
  assert.match(
    matchView,
    /export function revealWindowMsOf\(state: PrecisionState \| null, serverNowMs: number\): number \{/,
    "the reveal window must be derivable from the decision stamp",
  );
  assert.match(
    matchView,
    /const remaining = decisionAt \+ ROUND_RESULT_REVEAL_MS - now;/,
    "the window must be measured from the DECISION, not from observation",
  );

  const hook = read("../src/hooks/usePrecisionRoundReveal.ts");
  assert.match(
    hook,
    /revealWindowMsOf\(state, serverClockNow\(Date\.now\(\), offsetRef\.current\)\)/,
    "the reveal timer must use the server-anchored window",
  );
  // A reveal is never STARTED while a round is live…
  assert.match(
    hook,
    /if \(state\?\.phase === "active"\) return;/,
    "a live round must never start a reveal (the previous round's decision is still in the snapshot)",
  );
  // …and an open round drops whatever is on screen.
  assert.match(
    hook,
    /if \(state\?\.phase === "active"\) dismissReveal\(\);/,
    "the round opening must dismiss the result popup outright",
  );

  // The page has to hand the hook the server clock, or the anchor is measured
  // on the device's own wall clock.
  const page = read("../src/app/casino/precision/game/[matchId]/PageClient.tsx");
  assert.match(
    page,
    /usePrecisionRoundReveal\(\{[\s\S]{0,200}?serverClockOffsetMs,\s*\}\);/,
    "the match page must pass its server-clock estimate to the reveal",
  );
});

test("the round-result overlay is an outcome verdict, not a both-seats table", () => {
  // The card answers ONE question — did our seat take the round — and it answers
  // it with a colour: green (we won), red (we did not), amber (a true tie). The
  // per-seat times, deltas and rank badges it used to print were unreadable in
  // the few seconds the card is up, and the board behind it already recaps the
  // round spatially.
  const panel = read("../src/components/precision/PrecisionRoundResultPanel.tsx");
  for (const removed of [
    "precision-round-result-row-",
    "precision-round-result-rank-",
    "precision-round-result-target",
    "precision-round-result-race",
    "precision-round-result-banner",
    "diffToRank",
  ]) {
    assert.ok(
      !panel.includes(removed),
      `the card must not carry the old both-seats furniture (${removed})`,
    );
  }
  assert.match(
    panel,
    /roundWinnerSeat === localSeat \? "win" : "loss"/,
    "green vs red is the server's round winner compared against our own seat, and nothing else",
  );
  assert.match(panel, /data-outcome=\{outcome\}/, "the verdict must be readable off the card");
  assert.match(panel, /t\("games\.precision\.you_win_round"\)/);
  assert.match(panel, /t\("games\.precision\.you_lose_round"\)/);
  assert.match(panel, /t\("games\.precision\.tie_replaying"\)/);
  // The three palettes, spelled out — a win cannot drift into the loss colour.
  assert.match(panel, /text-emerald-200/, "the win verdict must be green");
  assert.match(panel, /text-red-200/, "the loss verdict must be red");
  assert.match(panel, /text-amber-200/, "a tie must be amber, neither win nor loss");

  // …and the copy the card renders ships in every language: the loss line the
  // redesign added, plus a "next round in Ns" line that takes its seconds from
  // the window the page measured (it used to be a hardcoded 3s).
  const text = read("../src/lib/appTextTranslations.js");
  assert.equal(
    (text.match(/you_lose_round:/g) ?? []).length,
    3,
    "en + fr + es must all carry the loss verdict",
  );
  assert.equal(
    (text.match(/next_round_in: "[^"]*\{seconds\}s/g) ?? []).length,
    3,
    "en + fr + es must all interpolate the countdown's seconds",
  );
});

test("the displayed countdown is clamped to the countdown's own length", () => {
  const hook = read("../src/hooks/usePrecisionRoundClock.ts");
  assert.match(
    hook,
    /Math\.min\(ROUND_COUNTDOWN_MS, Math\.max\(0, endsAt - serverNow\(\)\)\)/,
    "the cooldown must read as a hold at ROUND_COUNTDOWN_MS, not as extra ticks",
  );
});
