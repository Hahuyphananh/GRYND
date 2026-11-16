/**
 * solitaire-ghost-duel.test.mjs
 *
 * ASYNCHRONOUS GHOST DUELS — a RECORDED HUMAN, never an AI.
 *
 * Ranked Solitaire keeps its live queue. What this file proves is the fallback:
 * when no live player joins within the window, the open lobby is re-seated
 * against another real player's recorded run of the SAME deterministic deal.
 *
 * The four claims under test:
 *
 *   1. THE REPLAY IS A REAL LOG. `findGhostRun` refuses a re-dealt seat, a log
 *      that is too short, and any recording that does not replay through the
 *      real engine. No planner, no difficulty, no random move ever exists.
 *   2. THE DEAL IS THE RECORDING'S OWN. The seat's log replays from the source
 *      match's committed deal, which is what makes "the ghost played this exact
 *      deal" structural rather than a claim.
 *   3. THE PACE IS THE HUMAN'S. Offsets come from each move's own server
 *      instant minus that match's GO, are clamped monotonic, and playback only
 *      applies steps the clock has reached — idempotently.
 *   4. RANKED STAYS HUMAN. Settlement moves ONLY the human's ladder (single-seat
 *      writers), the ghost seat is a synthetic id that can never be an account
 *      or the AI seat, and the lobby copy never offers a bot.
 *
 * Pure helpers are exercised directly; the store, the writers and the UI are
 * checked at the source level (the behavioural suites in
 * tests/solitaire-duel-store.test.mjs cover the store's own flows).
 *
 * Run:  node --import tsx --test tests/solitaire-ghost-duel.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  GHOST_FALLBACK_MS,
  GHOST_MIN_RECORDED_MOVES,
  SEAT,
  SOLITAIRE_DUEL_AI_PLAYER_ID,
  SOLITAIRE_GHOST_PLAYER_PREFIX,
  VARIANT_VERSION,
  isGhostPlayerId,
} from "../src/lib/solitaire-duel/constants.ts";
import {
  backfillGhostRuns,
  buildGhostRunsFromCandidate,
  buildGhostTimeline,
  buildGhostTrail,
  chooseGhostSeat,
  dueGhostSteps,
  ghostHandleFor,
  ghostPlayerIdFor,
  ghostSeatsFor,
  ghostTimelineReplays,
} from "../src/lib/solitaire-duel/ghosts.ts";
import { initialStateFromDeal } from "../src/lib/solitaire-duel/rules.ts";
import {
  solvableDealFromSeed,
  solveDealLine,
} from "../src/lib/solitaire-duel/solvable.ts";
import { deriveDealSeed } from "../src/lib/solitaire-duel/seeds.js";

const read = (path) => fs.readFileSync(path, "utf8").replace(/\r\n/g, "\n");
/** Source with comments removed, so prose about a rule cannot trip an assertion. */
const code = (path) =>
  read(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

const GHOSTS = "src/lib/solitaire-duel/ghosts.ts";
const STORE = "src/lib/solitaire-duel/serverStore.ts";
const RATING = "src/lib/rating.js";
const TROPHIES = "src/lib/trophyStore.js";
const LOBBY = "src/components/solitaire-duel/SolitaireLobby.tsx";
const MATCH_PAGE = "src/app/casino/solitaire-duel/[matchId]/PageClient.tsx";
const MIGRATION = "src/db/migrations/0255_solitaire_ghost_duels.sql";

const NOW = 1_800_000_000_000;

/** One verified-solvable deal and its proven winning line. */
const DEAL = solvableDealFromSeed(
  deriveDealSeed({ serverSeed: "ab".repeat(32), variantVersion: VARIANT_VERSION }),
);
const LINE = solveDealLine(DEAL);

const timelineRows = (count, spacingMs = 1_500) =>
  LINE.slice(0, count).map((move, index) => ({
    kind: move.kind,
    move,
    createdAt: new Date(NOW + index * spacingMs),
  }));

// ── 1. Identity: anonymised, synthetic, never an account or the AI seat ───

test("ghost identity is a stable anonymised handle, not the source account", () => {
  const alice = ghostHandleFor("user_alice");
  assert.equal(alice, ghostHandleFor("user_alice"), "deterministic");
  assert.match(alice, /^GHOST-[0-9A-F]{4}$/);
  assert.notEqual(alice, ghostHandleFor("user_bob"));
  // Nothing of the account id survives into the handle.
  assert.equal(alice.includes("alice"), false);
  assert.equal(alice.includes("user_"), false);

  const seat = ghostPlayerIdFor("88888888-8888-4888-8888-888888888888");
  assert.equal(seat.startsWith(SOLITAIRE_GHOST_PLAYER_PREFIX), true);
  assert.equal(seat === ghostPlayerIdFor("99999999-9999-4999-8999-999999999999"), false);
  assert.equal(seat, ghostPlayerIdFor("88888888-8888-4888-8888-888888888888"));
  // The synthetic seat is neither an account nor the AI identity.
  assert.equal(seat === SOLITAIRE_DUEL_AI_PLAYER_ID, false);
  assert.equal(seat.startsWith("user_"), false);
});

test("isGhostPlayerId recognises only the ghost namespace", () => {
  assert.equal(isGhostPlayerId(ghostPlayerIdFor("m1")), true);
  assert.equal(isGhostPlayerId(SOLITAIRE_DUEL_AI_PLAYER_ID), false);
  assert.equal(isGhostPlayerId("user_alice"), false);
  assert.equal(isGhostPlayerId(null), false);
});

// ── 2. Seat selection: a replayable, real-log seat or nothing ─────────────

test("chooseGhostSeat prefers the seat that actually solved the deal", () => {
  assert.equal(
    chooseGhostSeat({
      p1Ply: 200,
      p2Ply: 240,
      p1Reset: 0,
      p2Reset: 0,
      p1Done: true,
      p2Done: false,
    }),
    SEAT.PLAYER1,
    "the completing seat is the stronger, faster replay",
  );
  assert.equal(
    chooseGhostSeat({
      p1Ply: 60,
      p2Ply: 240,
      p1Reset: 0,
      p2Reset: 0,
      p1Done: false,
      p2Done: false,
    }),
    SEAT.PLAYER2,
    "with neither finished, the longer log wins",
  );
});

test("chooseGhostSeat refuses a re-dealt seat and a log that never played", () => {
  // A re-dealt board no longer replays from the match's committed deal.
  assert.equal(
    chooseGhostSeat({
      p1Ply: 400,
      p2Ply: 10,
      p1Reset: 1,
      p2Reset: 0,
      p1Done: true,
      p2Done: false,
    }),
    SEAT.PLAYER2,
  );
  // Both re-dealt → nothing usable.
  assert.equal(
    chooseGhostSeat({
      p1Ply: 400,
      p2Ply: 400,
      p1Reset: 1,
      p2Reset: 2,
      p1Done: true,
      p2Done: true,
    }),
    null,
  );
  // Too few moves to be an opponent.
  assert.equal(
    chooseGhostSeat({
      p1Ply: GHOST_MIN_RECORDED_MOVES - 1,
      p2Ply: 0,
      p1Reset: 0,
      p2Reset: 0,
      p1Done: false,
      p2Done: false,
    }),
    null,
  );
});

// ── 3. Pace: the human's recorded timing, clamped and idempotent ──────────

test("buildGhostTimeline derives offsets from each move's own server instant", () => {
  const timeline = buildGhostTimeline({
    goAtMs: new Date(NOW),
    rows: timelineRows(4, 1_200),
  });
  assert.deepEqual(
    timeline.map((step) => step.offsetMs),
    [0, 1_200, 2_400, 3_600],
  );
  // The moves themselves are the recording, verbatim and in order.
  assert.deepEqual(
    timeline.map((step) => step.move),
    LINE.slice(0, 4),
  );
});

test("buildGhostTimeline clamps backwards timestamps and never reorders", () => {
  const timeline = buildGhostTimeline({
    goAtMs: new Date(NOW),
    rows: [
      { kind: "draw", move: LINE[0], createdAt: new Date(NOW - 5_000) },
      { kind: "draw", move: LINE[1], createdAt: new Date(NOW + 900) },
      { kind: "draw", move: LINE[2], createdAt: new Date(NOW + 300) },
    ],
  });
  // A pre-GO row lands at zero; a back-dated row holds the previous offset
  // rather than moving the ghost backwards in time.
  assert.deepEqual(
    timeline.map((step) => step.offsetMs),
    [0, 900, 900],
  );
  // A missing instant cannot invent a pace either.
  const undated = buildGhostTimeline({ goAtMs: null, rows: [{ kind: "draw", move: LINE[0] }] });
  assert.deepEqual(undated.map((step) => step.offsetMs), [0]);
});

test("dueGhostSteps applies only what the clock has reached, idempotently", () => {
  const timeline = buildGhostTimeline({
    goAtMs: new Date(NOW),
    rows: timelineRows(3, 1_000),
  });

  assert.deepEqual(
    dueGhostSteps(timeline, 0, 0).map((entry) => entry.index),
    [0],
    "the first move is due immediately",
  );
  assert.deepEqual(
    dueGhostSteps(timeline, 0, 999).map((entry) => entry.index),
    [0],
  );
  assert.deepEqual(
    dueGhostSteps(timeline, 1, 2_000).map((entry) => entry.index),
    [1, 2],
    "the cursor skips what has already been played",
  );
  assert.deepEqual(dueGhostSteps(timeline, 3, 10_000), [], "nothing is replayed twice");
  assert.deepEqual(dueGhostSteps(timeline, 0, -1), [], "no time has passed");
});

// ── 4. The deal: the recording only replays on ITS committed puzzle ───────

test("a real recorded line replays on the source deal", () => {
  assert.ok(LINE.length >= GHOST_MIN_RECORDED_MOVES, "the fixture plays a real game");
  const timeline = buildGhostTimeline({ goAtMs: new Date(NOW), rows: timelineRows(LINE.length) });
  assert.equal(timeline.length, LINE.length);
  assert.equal(ghostTimelineReplays(DEAL, timeline), true);
});

test("a broken recording is refused rather than played", () => {
  const timeline = buildGhostTimeline({ goAtMs: new Date(NOW), rows: timelineRows(12) });
  // A card sent to the WRONG foundation is illegal on any board, and an
  // unknown move kind never reaches a board at all: neither can become an
  // opponent, so a corrupted log is dropped instead of replayed.
  const opening = initialStateFromDeal(DEAL);
  const column = opening.tableau[6];
  const top = column[column.length - 1].card;
  const wrongSuit = top.suit === "spades" ? "hearts" : "spades";
  const illegal = [
    {
      offsetMs: 0,
      kind: "tableau-to-foundation",
      move: {
        kind: "tableau-to-foundation",
        fromColumn: 6,
        card: top,
        suit: wrongSuit,
      },
    },
  ];
  assert.equal(ghostTimelineReplays(DEAL, illegal), false);
  assert.equal(ghostTimelineReplays(DEAL, [...timeline.slice(0, 3), ...illegal]), false);
  assert.equal(
    ghostTimelineReplays(DEAL, [{ offsetMs: 0, kind: "teleport", move: { kind: "teleport" } }]),
    false,
  );
  assert.equal(ghostTimelineReplays(DEAL, []), false);
  assert.equal(ghostTimelineReplays(null, timeline), false);
});

// ── 5. The store: live queue first, replay fallback, human-only settlement ─

test("the fallback window is inside the promised 5–10 seconds", () => {
  assert.ok(GHOST_FALLBACK_MS >= 5_000, "no earlier than 5s");
  assert.ok(GHOST_FALLBACK_MS <= 10_000, "no later than 10s");
});

test("the store keeps the live queue first and closes it to a ghost on join", () => {
  const store = code(STORE);
  const storeSrc = read(STORE);
  // A new lobby opens a ghost WINDOW; it does not start a ghost.
  assert.match(store, /ghostFallbackAt: new Date\(nowMs \+ GHOST_FALLBACK_MS\)/);
  // A live joiner closes that window, so a real person always beats a replay.
  assert.match(
    storeSrc,
    /A live player arrived: the ghost window is closed for good\.\s*ghostFallbackAt: null,/,
  );
  // The conversion is serialized with matchmaking by the SAME advisory lock.
  assert.match(store, /export async function resolveGhostFallback/);
  assert.match(
    store,
    /resolveGhostFallback[\s\S]{0,900}pg_advisory_xact_lock\(\$\{SOLITAIRE_DUEL_LOCK_NAMESPACE\}, 0\)/,
    "the fallback must serialize with createOrJoin",
  );
  // Called from the read path so a player is never left waiting.
  assert.match(store, /const fallback = await resolveGhostFallback\(\{ matchId, nowMs \}\)/);
  // The ghost gets a synthetic seat, never an account and never the AI id.
  assert.match(store, /player2Id: ghostPlayerIdFor\(run\.sourceMatchId\)/);
  assert.match(store, /isGhost: true,/);
  // The recording's OWN committed deal, so the puzzle is provably shared.
  assert.match(store, /serverSeed: run\.serverSeed/);
  assert.match(store, /deal: run\.deal/);
});

test("playback replays the recording on every read and before judging a move", () => {
  const store = code(STORE);
  assert.match(store, /export async function advanceGhostMatch/);
  assert.match(store, /const due = dueGhostSteps\(timeline, state\.ply, nowMs - goAtMs\)/);
  // Same seam as the practice bot: a read IS the clock for a recording.
  assert.match(store, /const advancedGhost = await advanceGhostMatch\(\{ matchId, nowMs \}\)/);
  assert.match(store, /await advanceGhostMatch\(\{ matchId, nowMs \}\);\s*\n\s*try \{/);
  // The completion instant is the RECORDED one, not the read instant.
  assert.match(store, /state\.completedAtMs = goAtMs \+ completing\.step\.offsetMs/);
});

test("a ghost seat can never forfeit — only the human's clock decides", () => {
  const store = code(STORE);
  assert.match(store, /if \(match\.isGhost\) \{[\s\S]{0,400}isGhostPlayerId\(match\.player2Id\)/);
  assert.match(store, /const humanSeat = isGhostPlayerId\(match\.player2Id\)/);
  assert.doesNotMatch(
    store,
    /if \(match\.isGhost\) \{[\s\S]{0,200}const ghostSeat = SEAT\.PLAYER2;[\s\S]{0,100}return ghostSeat/,
    "the recording is never treated as an idle seat",
  );
  // The opponent's idle clock is suppressed for a ghost in the DTO.
  assert.match(store, /opponentInactivityAlarmAtMs: match\.isGhost\s*\n\s*\? null/);
});

test("the DTO marks a recording without leaking the source account", () => {
  const store = code(STORE);
  assert.match(store, /isGhost: Boolean\(match\.isGhost\)/);
  assert.match(store, /ghost: match\.isGhost\s*\n\s*\? \{/);
  assert.match(store, /name: match\.ghostName \?\? "GHOST"/);
  // The source player's id is never part of the client payload.
  const ghostBlock = store.slice(store.indexOf("isGhost: Boolean(match.isGhost)"));
  assert.doesNotMatch(ghostBlock.slice(0, 400), /sourcePlayerId|player1Id|player2Id/);
});

test("settlement moves ONLY the human's ladder, against the recorded strength", () => {
  const store = code(STORE);
  assert.match(read(STORE), /A GHOST duel settles into the HUMAN's ladder ONLY/);
  assert.match(store, /await applyGhostRatingResult\(\{/);
  assert.match(store, /await applyGhostTrophyResult\(\{/);
  // The recorded strength is passed through as recorded (a missing row falls
  // back to the writer's own default rather than to a fake 0).
  assert.match(store, /opponentRating: match\.ghostRating \?\? undefined/);
  assert.match(store, /opponentTrophies: match\.ghostTrophies \?\? undefined/);
  // The two-seat writers are reached only by a real pair, which a ghost row
  // never is: the ghost branch returns before them.
  assert.match(
    store,
    /if \(match\.isGhost\) \{[\s\S]*?await applyGhostTrophyResult\(\{[\s\S]*?if \(humanWon\) await markDailyRewardWin\(tx, humanId\);\s*\n\s*return;/,
  );
});

test("the single-seat writers reuse the platform's maths and journals", () => {
  const rating = code(RATING);
  assert.match(rating, /export async function applyGhostRatingResult/);
  const ratingFn = rating.slice(rating.indexOf("export async function applyGhostRatingResult"));
  // One player only: no second seat, no second rating row.
  assert.doesNotMatch(ratingFn, /loserClerkId/);
  assert.doesNotMatch(ratingFn, /winnerClerkId/);
  assert.match(ratingFn, /ratingDelta\(\{/);
  assert.match(ratingFn, /INSERT INTO rating_events[\s\S]*?NULL, \$\{outcome\}/);
  assert.match(ratingFn, /ON CONFLICT \(user_id, game_key, match_id\) DO NOTHING/);

  const trophies = code(TROPHIES);
  assert.match(trophies, /export async function applyGhostTrophyResult/);
  const trophyFn = trophies.slice(trophies.indexOf("export async function applyGhostTrophyResult"));
  assert.match(trophyFn, /seats: \[\{ clerkId: String\(clerkId\), outcome \}\]/);
  assert.match(trophyFn, /opponentIdFor: \(\) => null/);
  assert.match(trophyFn, /duelTrophyDelta\(\{/);
});

// ── 6. No AI: the ghost module cannot reach a planner ────────────────────

test("the ghost module imports no planner, no bot and no AI seat", () => {
  const ghosts = code(GHOSTS);
  assert.doesNotMatch(ghosts, /from "\.\/ai"/);
  assert.doesNotMatch(ghosts, /from "\.\/bots"/);
  assert.doesNotMatch(ghosts, /planAiMoves|planAiLine|botCanFinishDeal|SOLITAIRE_DUEL_AI_PLAYER_ID/);
  // The replay goes through the real rules authority, not a second engine.
  assert.match(ghosts, /replayMoves[\s\S]{0,40}from "\.\/rules"/);
  assert.match(ghosts, /replayMoves\(\{/);
});

test("the schema keeps a ghost distinct from the AI seat", () => {
  const migration = read(MIGRATION);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS is_ghost BOOLEAN NOT NULL DEFAULT FALSE/);
  assert.match(migration, /ghost_source_match_id UUID/);
  assert.match(migration, /ghost_timeline JSONB/);
  assert.match(migration, /ghost_completed_at_offset_ms INT/);
  // The pool is REAL, FINISHED, HUMAN matches only.
  const ghosts = code(GHOSTS);
  assert.match(ghosts, /WHERE m\.status = 'finished'/);
  assert.match(ghosts, /AND m\.is_ai = false/);
  assert.match(ghosts, /AND m\.is_ghost = false/);
  assert.match(ghosts, /m\.player1_id <> \$\{String\(excludeUserId\)\}/);
});

// ── 7. Player-facing copy states what the opponent is ────────────────────

test("the lobby promises a recording, not a bot", () => {
  const lobby = code(LOBBY);
  assert.match(lobby, /ghost/i);
  assert.match(lobby, /recorded/i);
  assert.match(lobby, /never a bot|never an AI/i);
  // The bot picker stays a separate mode with its own route.
  assert.doesNotMatch(lobby, /solitaire-play-bots|Play vs Bots/);
  assert.doesNotMatch(lobby, /\/api\/solitaire-duel\/create-ai/);
});

test("the live match names the recording and says it is not an AI", () => {
  const page = code(MATCH_PAGE);
  assert.match(page, /data-testid="solitaire-ghost-opponent"/);
  assert.match(page, /Racing a recorded run by a real player/);
  assert.match(page, /never an AI/);
  assert.match(page, /const ghost = match\?\.isGhost \? match\.ghost \?\? null : null/);
  assert.match(page, /ghost\?\.name \|\| opponentIdentity\?\.name/);
  // The client still sends nothing competitive.
  assert.doesNotMatch(page, /JSON\.stringify\(\{ winner/);
});

// ── 8. The backfill: history keeps the pool warm ─────────────────────────

test("ghostSeatsFor lists every replayable seat, the winner first", () => {
  assert.deepEqual(
    ghostSeatsFor({
      p1Ply: 240,
      p2Ply: 410,
      p1Reset: 0,
      p2Reset: 0,
      p1Done: true,
      p2Done: false,
    }),
    [SEAT.PLAYER1, SEAT.PLAYER2],
    "both seats record; the one that solved it leads",
  );
  // A re-dealt seat is never recorded: its log no longer replays.
  assert.deepEqual(
    ghostSeatsFor({
      p1Ply: 400,
      p2Ply: 120,
      p1Reset: 1,
      p2Reset: 0,
      p1Done: true,
      p2Done: false,
    }),
    [SEAT.PLAYER2],
  );
  assert.deepEqual(
    ghostSeatsFor({ p1Ply: 3, p2Ply: 0, p1Reset: 0, p2Reset: 0, p1Done: false, p2Done: false }),
    [],
  );
});

/** A fake executor: answers each `execute` from a queue, reusing the last reply. */
function fakeExecutor(replies) {
  const calls = [];
  let index = 0;
  return {
    calls,
    execute: async (query) => {
      calls.push(query);
      const reply = replies[Math.min(index, replies.length - 1)];
      index += 1;
      return reply ?? { rows: [] };
    },
  };
}

const candidateRow = (overrides = {}) => ({
  matchId: "11111111-1111-4111-8111-111111111111",
  player1Id: "user_alice",
  player2Id: "user_bob",
  variant: "klondike-1",
  variantVersion: VARIANT_VERSION,
  serverSeed: "ab".repeat(32),
  serverSeedHash: "cd".repeat(32),
  dealSeed: 7,
  deal: DEAL,
  goAt: new Date(NOW),
  p1Ply: LINE.length,
  p2Ply: LINE.length,
  p1Reset: 0,
  p2Reset: 0,
  p1Done: true,
  p2Done: true,
  ...overrides,
});

const ledgerRow = { rating: 1_425, trophies: 33 };

function sourceRow(index, spacingMs = 1_500) {
  const move = LINE[index];
  return {
    ply: index + 1,
    kind: move.kind,
    move,
    createdAt: new Date(NOW + index * spacingMs),
  };
}

const moveRows = (count = LINE.length, spacingMs = 1_500) =>
  Array.from({ length: count }, (_, index) => sourceRow(index, spacingMs));

test("a finished match yields a verified run for EACH replayable seat", async () => {
  const executor = fakeExecutor([
    { rows: moveRows() },
    { rows: [ledgerRow] },
    { rows: moveRows() },
    { rows: [ledgerRow] },
  ]);
  const runs = await buildGhostRunsFromCandidate(executor, candidateRow());
  assert.equal(runs.length, 2, "both real humans are recorded");
  assert.deepEqual(runs.map((run) => run.seat), [SEAT.PLAYER1, SEAT.PLAYER2]);
  assert.deepEqual(runs.map((run) => run.sourceClerkId), ["user_alice", "user_bob"]);
  assert.notEqual(runs[0].name, runs[1].name, "each handle is fixed to its own account");
  for (const run of runs) {
    // The recording is stored only after it replays on the source deal.
    assert.equal(ghostTimelineReplays(DEAL, run.timeline), true);
    assert.equal(run.timeline.length, LINE.length);
    assert.equal(run.ply, LINE.length);
    // The source player's recorded strength travels with the run.
    assert.equal(run.rating, 1_425);
    assert.equal(run.trophies, 33);
  }
  // Both runs solved the fixture, so both carry a completion instant.
  assert.equal(runs[0].completedOffsetMs, runs[0].timeline.at(-1).offsetMs);
});

test("a match that cannot replay yields no run at all", async () => {
  // Re-dealt seats are refused before the log is even read.
  const reDealt = fakeExecutor([{ rows: [] }, { rows: [] }]);
  const none = await buildGhostRunsFromCandidate(
    reDealt,
    candidateRow({ p1Reset: 1, p2Reset: 1 }),
  );
  assert.deepEqual(none, []);

  // A log shorter than the floor is refused.
  const short = fakeExecutor([{ rows: moveRows(GHOST_MIN_RECORDED_MOVES - 1) }]);
  assert.deepEqual(
    await buildGhostRunsFromCandidate(
      short,
      candidateRow({ p2Ply: 0, p2Reset: 1, p2Done: false }),
    ),
    [],
  );

  // A log that does not replay from the committed deal is refused.
  const corrupt = moveRows().map((row) => ({ ...row, move: LINE[LINE.length - 1] }));
  const broken = fakeExecutor([{ rows: corrupt }]);
  assert.deepEqual(
    await buildGhostRunsFromCandidate(
      broken,
      candidateRow({ p2Ply: 0, p2Reset: 1, p2Done: false }),
    ),
    [],
    "an un-replayable log never becomes an opponent",
  );
});

test("backfillGhostRuns records history, skipping what it cannot replay", async () => {
  const partial = candidateRow({
    matchId: "22222222-2222-4222-8222-222222222222",
    player1Id: "user_carol",
    p2Ply: 0,
    p2Reset: 1,
    p2Done: false,
  });
  const unplayable = candidateRow({
    matchId: "33333333-3333-4333-8333-333333333333",
    p1Ply: 400,
    p2Ply: 0,
    p2Reset: 1,
    p2Done: false,
  });
  const executor = fakeExecutor([
    { rows: [partial, unplayable] }, // candidates
    { rows: moveRows() }, // partial: accepted moves
    { rows: [ledgerRow] }, // partial: recorded strength
    { rows: [] }, // insert
    { rows: moveRows(4) }, // unplayable: too short to replay
  ]);

  const result = await backfillGhostRuns(executor, { limit: 25 });
  assert.deepEqual(result, { scanned: 2, recorded: 1, skipped: 1 });
  // One match produced one run (the other is refused), and it was written.
  assert.equal(executor.calls.length, 5, "no wasted work beyond the candidates");
});

test("the backfill job is idempotent, bounded and writes only its own pool", () => {
  const ghosts = read(GHOSTS);
  const backfill = ghosts.slice(ghosts.indexOf("export async function backfillGhostRuns"));
  // History is the source, newest first, so a fresh pool fills immediately.
  assert.match(ghosts, /ORDER BY m\.created_at DESC/);
  // Nothing already recorded is considered, and the insert cannot duplicate.
  assert.match(backfill, /ON CONFLICT \(source_match_id, source_seat\) DO NOTHING/);
  assert.match(ghosts, /NOT EXISTS \(\s*\n\s*SELECT 1 FROM solitaire_ghost_runs r WHERE r\.source_match_id = m\.id/);
  // Bounded per tick so a scheduler can never walk the whole history at once.
  assert.match(backfill, /Math\.min\(500, Math\.floor\(Number\(limit\)/);
  // It inserts into the pool table and touches no match, rating, trophy or user.
  assert.doesNotMatch(backfill, /UPDATE |DELETE |INSERT INTO solitaire_duel_matches|player_ratings|player_trophies/);
  assert.match(backfill, /INSERT INTO solitaire_ghost_runs/);
});

test("matchmaking reads the pool first and only then scans live", () => {
  const ghosts = code(GHOSTS);
  assert.match(ghosts, /export async function readGhostPool/);
  const find = ghosts.slice(ghosts.indexOf("export async function findGhostRun"));
  assert.match(find, /const pooled = await readGhostPool\(executor, \{ excludeUserId \}\)/);
  assert.ok(
    find.indexOf("readGhostPool") < find.indexOf("readGhostCandidates"),
    "the warm pool is tried before a live scan",
  );
  // A pooled run is re-verified before it is offered, and never the requester's.
  assert.match(ghosts, /if \(!ghostTimelineReplays\(deal, timeline\)\) return null/);
  assert.match(ghosts, /WHERE variant_version = \$\{VARIANT_VERSION\}\s*\n\s*AND source_clerk_id <> \$\{String\(excludeUserId\)\}/);
});

test("the backfill is scheduled on both schedulers with the cron secret", () => {
  const route = read("src/app/api/jobs/solitaire-ghost-pool/route.ts");
  assert.match(route, /verifyCronRequest\(request\)/);
  assert.match(route, /backfillGhostRuns\(db, \{ limit \}\)/);
  assert.match(route, /success: true/);

  const runner = read("deploy/jobs/run-job.sh");
  assert.match(runner, /solitaire-ghost-pool\b[^)]*\) ;;/);
  assert.equal(fs.existsSync("deploy/jobs/grynd-job-solitaire-ghost-pool.timer"), true);
  const timer = read("deploy/jobs/grynd-job-solitaire-ghost-pool.timer");
  assert.match(timer, /Unit=grynd-job@solitaire-ghost-pool\.service/);

  const vercel = JSON.parse(read("vercel.json"));
  const cron = (vercel.crons ?? []).find(
    (entry) => entry.path === "/api/jobs/solitaire-ghost-pool",
  );
  assert.ok(cron, "the Vercel cron list must schedule the backfill");
  assert.equal(cron.schedule, "*/10 * * * *");
});

// ── 9. The trail: the recording's own progress, at its own pace ───────────

test("buildGhostTrail samples the VERIFIED replay of the source deal", () => {
  const timeline = buildGhostTimeline({
    goAtMs: new Date(NOW),
    rows: timelineRows(LINE.length, 900),
  });
  const trail = buildGhostTrail(DEAL, timeline, 12);
  assert.ok(trail.length >= 2 && trail.length <= 13, "bounded, painted at a glance");
  assert.equal(trail[0].atMs, 0, "the run starts at GO");
  assert.equal(trail[0].foundationCards, 0);
  // The fixture solves the deal, so the recording reaches all 52 cards.
  assert.equal(trail.at(-1).foundationCards, 52);
  assert.equal(trail.at(-1).atMs, timeline.at(-1).offsetMs);
  // Progress only ever moves forward, at instants the recording really had.
  const instants = new Set(timeline.map((step) => step.offsetMs));
  for (let index = 1; index < trail.length; index += 1) {
    assert.ok(trail[index].atMs >= trail[index - 1].atMs);
    assert.ok(trail[index].foundationCards >= trail[index - 1].foundationCards);
    assert.ok(instants.has(trail[index].atMs), "no interpolated positions");
  }
  assert.deepEqual(buildGhostTrail(DEAL, []), []);
});

 test("the trail is stored with the ghost match and delivered in the DTO", () => {
  const store = code(STORE);
  assert.match(store, /ghostTrail: run\.trail/);
  assert.match(store, /trail: Array\.isArray\(match\.ghostTrail\) \? match\.ghostTrail : \[\]/);
  assert.match(store, /completedAtMs:\s*\n?\s*match\.ghostCompletedAtOffsetMs == null/);
  assert.match(
    code("src/db/migrations/0256_solitaire_ghost_runs.sql"),
    /ALTER TABLE solitaire_duel_matches[\s\S]{0,200}ghost_trail JSONB/,
  );
});

test("the opponent panel paints the recorded trail as the clock reaches it", () => {
  const page = code(MATCH_PAGE);
  // The strip only exists for a recorded run, keyed by the seat's tone.
  assert.match(page, /data-testid=\{`solitaire-ghost-trail-\$\{tone\}`\}/);
  assert.match(page, /ghostTrail\.filter\(\(point\) => point\.atMs <= ghostElapsedMs\)/);
  // Heights come from recorded foundation counts only — no card leaves the server.
  assert.match(page, /Math\.min\(52, Number\(point\.foundationCards\)/);
  assert.doesNotMatch(page, /point\.card\b|point\.suit\b|point\.rank\b/);
  // The opponent meter receives the trail and the server-clock elapsed time.
  assert.match(page, /ghostTrail=\{ghostTrail\}/);
  assert.match(page, /ghostElapsedMs=\{ghostElapsedMs\}/);
  assert.match(page, /Math\.max\(0, serverNowMs - match\.goAtMs\)/);
});
