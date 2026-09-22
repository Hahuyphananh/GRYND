/**
 * Crash Arena — fold-out settlement timing.
 *
 * A fold that leaves exactly one active player ends the hand immediately
 * (fold-out): the curve freezes for FOLD_PAUSE_MS so the table can read the
 * reveal, and the ranked payouts are resolved AT that deadline.
 *
 * Settling that hand used to be reachable only from the realtime-server
 * crash sweep, whose cadence is 1s while a hand runs and 15s once its
 * running-hand hint idles. A table sat on the "Hand over — settling
 * payouts…" card for as long as the next tick took (and forever when no
 * sweep was running), i.e. the fold paused the game far beyond the 3s the
 * rules promise. The pause is now exactly FOLD_PAUSE_MS and the settlement
 * is triggered at its deadline by whoever gets there first (the action
 * route schedules it, the table's client wakes it, the sweep backstops),
 * with `settleCrashPokerHand`'s row lock keeping it to a single writer.
 *
 * These tests cover both halves: the pure deadline arithmetic (so the
 * freeze can't silently grow again) and the source contracts that keep the
 * three wake-ups wired.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createHand,
  applyFold,
  curveMultiplierAt,
  pauseHandOnFold,
  resumePauseIfDue,
  resolveHand,
  handFromEntries,
} from "../src/lib/crash-poker/roundSystem.js";
import { FOLD_PAUSE_MS } from "../src/lib/crash-poker/constants.js";

const ACTION_ROUTE = readFileSync("src/app/api/crash-arena/action/route.ts", "utf8");
const SETTLE_ROUTE = readFileSync("src/app/api/crash-arena/settle/route.ts", "utf8");
const CLIENT_HOOK = readFileSync(
  "src/components/crash-arena/useCrashArenaRound.js",
  "utf8",
);
const SWEEP_ROUTE = readFileSync(
  "src/app/api/crash-arena/crash-check/route.ts",
  "utf8",
);

const TWO_PLAYERS = [
  { userId: 1, name: "You" },
  { userId: 2, name: "GRYND AI" },
];

/** A 1v1 hand whose first fold is a fold-out (player 1 folds, player 2 wins). */
function foldOutHand({ now }) {
  const hand = createHand({
    players: TWO_PLAYERS,
    wager: 10,
    startedAt: now - 2_000,
  });
  const res = applyFold(hand, { userId: 1, multiplier: 1.4 });
  assert.equal(res.error, undefined);
  return res;
}

// ── The pause window ───────────────────────────────────────────────────────

test("a fold-out freezes the curve for exactly FOLD_PAUSE_MS", () => {
  const now = 5_000_000;
  const { hand } = foldOutHand({ now });
  const frozen = pauseHandOnFold(hand, now, FOLD_PAUSE_MS);

  assert.equal(frozen.pausedSince, now);
  assert.equal(frozen.pausedUntil, now + FOLD_PAUSE_MS);
  assert.equal(FOLD_PAUSE_MS, 3_000, "the promise is a 3 second reveal");
});

test("the fold-out settle deadline IS the pause deadline (no settle grace)", () => {
  const now = 5_000_000;
  const { hand } = foldOutHand({ now });
  const frozen = pauseHandOnFold(hand, now, FOLD_PAUSE_MS);
  const pending = { ...frozen, settlePendingAt: frozen.pausedUntil };

  assert.equal(
    pending.settlePendingAt,
    pending.pausedUntil,
    "a settle grace on top of the pause is what stretched the freeze",
  );

  // The curve is frozen for the whole window: a fold-out settle decided at
  // the deadline grades the same multiplier the table is looking at.
  const frozenValue = curveMultiplierAt(hand, now);
  assert.ok(Math.abs(curveMultiplierAt(pending, pending.settlePendingAt) - frozenValue) < 1e-9);

  // …and it is due the instant the window closes, not a tick later.
  const { resumed, hand: after } = resumePauseIfDue(pending, pending.settlePendingAt);
  assert.equal(resumed, true);
  assert.ok(curveMultiplierAt(after, pending.settlePendingAt) >= frozenValue);
});

test("settling at the fold-out deadline crowns the survivor with the whole pot", () => {
  const now = 5_000_000;
  const { hand } = foldOutHand({ now });
  const frozen = pauseHandOnFold(hand, now, FOLD_PAUSE_MS);
  const pending = { ...frozen, settlePendingAt: frozen.pausedUntil };

  // Rebuild the way every writer does (round row + entries) and resolve.
  const entries = pending.players.map((p) => ({
    userId: p.userId,
    contributed: p.contributed,
    isActive: p.isActive,
    result: p.userId === 1 ? "pending" : "pending",
    foldedAtMultiplier: p.foldedAtMultiplier,
    allIn: false,
    lastAction: p.lastAction,
  }));
  const rebuilt = handFromEntries({
    round: { bigBlind: 10, handState: pending },
    entries,
  });
  const resolved = resolveHand(rebuilt, 0); // no crash happened — fold-out
  assert.equal(resolved.winnerUserId, 2);
  assert.equal(resolved.payouts.length, 2);
  assert.ok(resolved.payouts.find((p) => p.userId === 2).amount > 0);
});

// ── Action route: schedule the settle at the deadline ──────────────────────

test("the action route schedules the fold-out settlement after the response", () => {
  assert.match(
    ACTION_ROUTE,
    /import\s*\{\s*NextResponse,\s*after\s*\}\s*from\s*"next\/server"/,
    "the route schedules work with after() so the fold response isn't delayed",
  );
  assert.match(
    ACTION_ROUTE,
    /function scheduleFoldOutSettlement\(roundId: number, settleAt: number\)/,
    "the fold-out settle is a dedicated helper",
  );
  assert.match(
    ACTION_ROUTE,
    /await new Promise\(\(resolve\) => setTimeout\(resolve, waitMs\)\)/,
    "the helper waits out the remaining pause window",
  );
  assert.match(
    ACTION_ROUTE,
    /await settleCrashPokerHand\(roundId\)/,
    "and settles through the shared, idempotent settle function",
  );
  assert.match(ACTION_ROUTE, /after\(run\)/, "scheduled via after()");
});

test("only a fold-out schedules the deferred settle, at the pause deadline", () => {
  assert.match(
    ACTION_ROUTE,
    /if \(result\.handOver && pause\) \{\s*scheduleFoldOutSettlement\(roundId, Number\(pause\.until\)\);/,
    "a normal fold never schedules a settlement",
  );
  // A fold-out is frozen with the same window as any other fold.
  assert.match(
    ACTION_ROUTE,
    /persistedHand = pauseHandOnFold\(nextHand, now, FOLD_PAUSE_MS\);/,
    "the fold-out pause is FOLD_PAUSE_MS",
  );
  assert.match(
    ACTION_ROUTE,
    /settlePendingAt: Number\(persistedHand\.pausedUntil\)/,
    "and settlePendingAt is exactly that deadline",
  );
  assert.doesNotMatch(
    ACTION_ROUTE,
    /FOLD_OUT_SETTLE_GRACE_MS/,
    "the pause-extending settle grace is gone",
  );
  assert.doesNotMatch(
    ACTION_ROUTE,
    /\.\.\.persistedHand,\s*settlePendingAt: Number\(persistedHand\.pausedUntil\) \+/,
    "no extra offset is added to the settle deadline",
  );
});

test("the deferred settle can never double-pay or block the fold response", () => {
  // settleCrashPokerHand locks the round row and no-ops once settled, so the
  // three wake-ups (action route / client / sweep) are safe to race.
  const settleHand = readFileSync("src/lib/crash-poker/settleHand.ts", "utf8");
  assert.match(settleHand, /alreadySettled/);
  assert.match(settleHand, /\.for\("update"\)/);
  // The scheduling itself must never throw into the fold handler.
  assert.match(ACTION_ROUTE, /\} catch \{\s*\/\/[\s\S]{0,200}void run\(\)\.catch\(\(\) => \{\}\);/);
});

// ── Settle route: the client's wake-up ────────────────────────────────────

test("the settle route resolves a due fold-out on server time only", () => {
  assert.match(
    SETTLE_ROUTE,
    /const settlePendingAt =\s*hand\?\.settlePendingAt != null \? Number\(hand\.settlePendingAt\) : null/,
    "the fold-out path is gated on the hand's own settlePendingAt",
  );
  assert.match(
    SETTLE_ROUTE,
    /if \(now < settlePendingAt\) \{/,
    "SERVER time decides whether the hand may be settled",
  );
  assert.match(
    SETTLE_ROUTE,
    /retryAfterMs: Math\.max\(50, settlePendingAt - now\)/,
    "an early caller is told exactly how long to wait",
  );
  assert.match(
    SETTLE_ROUTE,
    /error: "The hand is still frozen"/,
    "and refused rather than settled early",
  );
});

test("the settle route only lets a seat in the hand resolve it", () => {
  assert.match(
    SETTLE_ROUTE,
    /from\(crashArenaEntries\)[\s\S]{0,300}eq\(crashArenaEntries\.roundId, rid\)[\s\S]{0,120}eq\(crashArenaEntries\.userId, caller\.id\)/,
    "participation is checked against the hand's entries",
  );
  assert.match(
    SETTLE_ROUTE,
    /error: "You are not in this hand",?\s*\}\s*,\s*\{\s*status: 403/,
    "a non-participant is rejected",
  );
  // The crash path keeps its own due check, and settlement itself is shared.
  assert.match(SETTLE_ROUTE, /isCrashDueAt\(hand, now, cp\)/);
  assert.match(SETTLE_ROUTE, /await settleCrashPokerHand\(rid\)/);
});

test("the settle route answers with the canonical results payload", () => {
  assert.match(
    SETTLE_ROUTE,
    /results: settled/,
    "the whole settle result travels as `results`, like the sweep's payload",
  );
  assert.match(
    SETTLE_ROUTE,
    /alreadySettled: true, results: null/,
    "an already-settled round is a success with no results (client refetches)",
  );
});

// ── Client: wake the settle at the deadline ───────────────────────────────

test("the client wakes the settle from the fold-out freeze, not a plain fold", () => {
  assert.match(
    CLIENT_HOOK,
    /if \(!foldPause\?\.handOver\) return;[\s\S]{0,4000}?fetch\("\/api\/crash-arena\/settle"/,
    "only a fold-out freeze calls the settle route",
  );
  assert.match(
    CLIENT_HOOK,
    /body: JSON\.stringify\(\{ roundId \}\)/,
    "it names the running round",
  );
});

test("the client applies the authoritative results and relays them to the room", () => {
  assert.match(
    CLIENT_HOOK,
    /const results = data\?\.data\?\.results \?\? null;/,
    "the results come from the settle response",
  );
  assert.match(
    CLIENT_HOOK,
    /applyServerSettlementRef\.current\?\.\(results, roundId\)/,
    "they are applied through the shared settlement path",
  );
  assert.match(
    CLIENT_HOOK,
    /socket\.emit\(CRASH_ARENA_READY, \{\s*tableId,\s*handOver: true,\s*results,\s*\}\)/,
    "and pushed to the other seats instantly",
  );
  // applyServerSettlement is declared later in the file than this effect, so
  // reaching it through a ref is what keeps the deps array out of its TDZ.
  assert.match(
    CLIENT_HOOK,
    /const applyServerSettlementRef = useRef\(null\)/,
    "the settlement callback is reached through a ref",
  );
  assert.match(
    CLIENT_HOOK,
    /applyServerSettlementRef\.current = applyServerSettlement;/,
    "and the ref is kept current",
  );
});

test("the client's wake-up is bounded and falls back to the poll", () => {
  assert.match(CLIENT_HOOK, /FOLD_OUT_SETTLE_MAX_ATTEMPTS = 8/);
  assert.match(CLIENT_HOOK, /setTimeout\(wake, FOLD_OUT_SETTLE_RETRY_MS\)/);
  assert.match(
    CLIENT_HOOK,
    /Math\.max\(0, until - Date\.now\(\)\) \+ FOLD_OUT_SETTLE_FIRST_DELAY_MS/,
    "the first attempt lands just past the server's deadline (clock skew)",
  );
  assert.match(
    CLIENT_HOOK,
    /onRoomUpdateRef\.current\?\.\(\)/,
    "a refetch stays as the safety net for the already-settled path",
  );
  assert.match(
    CLIENT_HOOK,
    /if \(data\?\.success\) \{[\s\S]{0,300}?reconcile\(\);/,
    "an already-settled answer reconciles instead of erroring",
  );
});

// ── Backstop: the sweep still owns the hand if nobody wakes it ────────────

test("the crash sweep still settles a pending fold-out as the backstop", () => {
  assert.match(
    SWEEP_ROUTE,
    /if \(hand\.settlePendingAt != null\) \{[\s\S]{0,200}?if \(now < hand\.settlePendingAt\) continue;/,
    "the sweep honours the same deadline",
  );
  assert.match(
    SWEEP_ROUTE,
    /const settled = await settleCrashPokerHand\(round\.id\);[\s\S]{0,200}?if \(settled\.alreadySettled\) continue;/,
    "and no-ops when another writer already resolved it",
  );
});

test("no stale settle-grace constant is left in the codebase", () => {
  const constants = readFileSync("src/lib/crash-poker/constants.js", "utf8");
  assert.doesNotMatch(constants, /export const FOLD_OUT_SETTLE_GRACE_MS/);
  assert.doesNotMatch(constants, /FOLD_OUT_SETTLE_GRACE_MS/);
});
