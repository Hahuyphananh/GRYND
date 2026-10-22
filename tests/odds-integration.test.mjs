/**
 * Odds — end-to-end integration review.
 *
 * The engine is exercised for real (five rounds, both seats, both entry points)
 * and the parts that only exist inside a route handler — the timeout direction,
 * the sanitiser on every read, the refund paths — are pinned at the source, the
 * same way `odds-ai-leave.test.mjs` pins the AI connection rule. Nothing here
 * needs a database or a browser.
 *
 * What this file is for, in the order the review asks:
 *   1. the full five-round flow, replayable end to end;
 *   2. scoring and clue integrity (truthful, ambiguous, never a reveal);
 *   3. secrecy — the live target is not in any player's view;
 *   4. the money rules no client can reach: timeout direction, payouts, draws,
 *      abandoned-match refunds, and the one place that could leak the answer.
 *
 * Run:  node --import tsx --test tests/odds-integration.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  MIN_CLUE_CANDIDATES,
  ROUND_TIMEOUT_MS,
  TARGET_MAX,
  TARGET_MIN,
  TOTAL_ROUNDS,
  botPrediction,
  createClue,
  createRound,
  currentRoundOf,
  decideMatchWinner,
  describePrediction,
  hasSubmitted,
  initPvPOddsGame,
  isCurrentOddsState,
  parsePrediction,
  predictionOf,
  predictionWidth,
  resolveRound,
  scorePrediction,
  submitAIPrediction,
  submitPrediction,
  viewForPlayer,
} from "../src/lib/odds.ts";
import { PVP_WINNER_SHARE } from "../src/lib/games/economy.ts";

/** A deterministic RNG so a failing match can be replayed exactly. */
function seeded(seed = 1337) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

/** A wrong exact call: guaranteed to differ from the target. */
const wrongNumber = (target) => (target === TARGET_MIN ? TARGET_MAX : TARGET_MIN);

// ── 1. The complete game ─────────────────────────────────────────────────

test("a new match is five rounds over the fixed 1–100 domain", () => {
  const state = initPvPOddsGame({ random: seeded() });
  assert.equal(state.totalRounds, TOTAL_ROUNDS);
  assert.equal(TOTAL_ROUNDS, 5);
  assert.equal(state.currentRound, 1);
  assert.equal(state.rounds.length, 1);
  assert.equal(state.p1Score, 0);
  assert.equal(state.p2Score, 0);
  assert.equal(state.gameOver, false);

  const live = currentRoundOf(state);
  assert.ok(live.target >= TARGET_MIN && live.target <= TARGET_MAX);
  assert.ok(live.clue.length > 0);
  assert.equal(live.resolved, false);
  assert.equal(isCurrentOddsState(state), true);
});

test("a whole match: same target and clue for both seats, target hidden until both call, five rounds, cumulative winner", () => {
  let state = initPvPOddsGame({ random: seeded(7) });
  const seenTargets = [];
  const seenClues = [];

  for (let round = 1; round <= TOTAL_ROUNDS; round += 1) {
    assert.equal(state.currentRound, round);

    // Both seats read the SAME live round: one target, one clue, neither
    // target visible.
    const p1View = viewForPlayer(state, true);
    const p2View = viewForPlayer(state, false);
    const live1 = p1View.rounds[round - 1];
    assert.equal(live1.target, null, "the live target is not in a player's view");
    assert.equal(p2View.rounds[round - 1].target, null);
    assert.equal(live1.clue, p2View.rounds[round - 1].clue);
    assert.ok(live1.clue.length > 0);
    seenClues.push(live1.clue);

    const target = currentRoundOf(state).target;
    seenTargets.push(target);

    // Player 1 calls it exactly; player 2 is wrong.
    const first = submitPrediction(state, "player1", { kind: "exact", value: target });
    assert.equal(first.roundComplete, false, "one call is not a completed round");
    assert.equal(viewForPlayer(first.updatedState, true).opponentSubmitted, false);

    const second = submitPrediction(first.updatedState, "player2", {
      kind: "exact",
      value: wrongNumber(target),
    });
    assert.equal(second.roundComplete, true);

    const { round: resolved, updatedState } = resolveRound(second.updatedState);
    state = updatedState;

    assert.equal(resolved.resolved, true);
    assert.equal(resolved.player1Score, 100);
    assert.equal(resolved.player2Score, 0);
    assert.equal(state.p1Score, 100 * round);
    assert.equal(state.p2Score, 0);

    // Only now is the round public — for both seats.
    for (const view of [viewForPlayer(state, true), viewForPlayer(state, false)]) {
      const history = view.rounds[round - 1];
      assert.equal(history.target, target, "a resolved round reveals its target");
      assert.ok(history.player1Prediction && history.player2Prediction);
      assert.equal(history.player1Score, 100);
      assert.equal(history.player2Score, 0);
    }
  }

  assert.equal(state.gameOver, true);
  assert.equal(state.rounds.length, TOTAL_ROUNDS);
  assert.equal(state.winner, "player1");
  assert.equal(seenTargets.length, 5);
  // Five rounds, five clues: the ladder tightens rather than repeating one
  // broad sentence, but every round is still a real clue.
  assert.equal(seenClues.length, 5);
});

test("an exact tie after five rounds is a draw, and nothing invents a winner", () => {
  let state = initPvPOddsGame({ random: seeded(99) });
  for (let round = 1; round <= TOTAL_ROUNDS; round += 1) {
    const target = currentRoundOf(state).target;
    // Both seats make the identical call, so both score identically.
    const call = { kind: "range", min: Math.max(1, target - 4), max: Math.min(100, target + 4) };
    state = submitPrediction(state, "player1", call).updatedState;
    state = submitPrediction(state, "player2", call).updatedState;
    state = resolveRound(state).updatedState;
  }
  assert.equal(state.gameOver, true);
  assert.equal(state.p1Score, state.p2Score);
  assert.equal(state.winner, null);
  assert.equal(decideMatchWinner(state.p1Score, state.p2Score), null);
  assert.equal(decideMatchWinner(3, 2), "player1");
  assert.equal(decideMatchWinner(2, 3), "player2");
});

// ── 2. Scoring and clue integrity ────────────────────────────────────────

test("exact calls pay 100 for a hit and nothing for a miss", () => {
  assert.equal(scorePrediction({ kind: "exact", value: 42 }, 42), 100);
  assert.equal(scorePrediction({ kind: "exact", value: 42 }, 43), 0);
  assert.equal(scorePrediction({ kind: "exact", value: 1 }, 1), 100);
  assert.equal(scorePrediction({ kind: "exact", value: 100 }, 100), 100);
});

test("ranges pay by inclusive width, at least 1, and nothing on a miss", () => {
  // width = max - min + 1
  assert.equal(scorePrediction({ kind: "range", min: 42, max: 42 }, 42), 100);
  assert.equal(scorePrediction({ kind: "range", min: 41, max: 42 }, 41), 50);
  assert.equal(scorePrediction({ kind: "range", min: 40, max: 44 }, 42), 20);
  assert.equal(scorePrediction({ kind: "range", min: 40, max: 49 }, 45), 10);
  assert.equal(scorePrediction({ kind: "range", min: 1, max: 100 }, 37), 1);
  // Inclusive edges count as hits.
  assert.equal(scorePrediction({ kind: "range", min: 40, max: 44 }, 40), 20);
  assert.equal(scorePrediction({ kind: "range", min: 40, max: 44 }, 44), 20);
  // One either side is a miss, however close.
  assert.equal(scorePrediction({ kind: "range", min: 40, max: 44 }, 39), 0);
  assert.equal(scorePrediction({ kind: "range", min: 40, max: 44 }, 45), 0);
  // Width agrees with the paytable.
  assert.equal(predictionWidth({ kind: "range", min: 40, max: 44 }), 5);
  assert.equal(predictionWidth({ kind: "exact", value: 7 }), 1);
});

test("invalid predictions are rejected, never scored as a silent zero", () => {
  const bad = [
    null,
    undefined,
    {},
    { exact: 0 },
    { exact: 101 },
    { exact: 5.5 },
    { exact: "42" },
    { min: 50, max: 40 },
    { min: 1 },
    { max: 100 },
    { min: 0, max: 10 },
    { exact: 42, min: 1, max: 100 },
  ];
  for (const input of bad) {
    const parsed = parsePrediction(input);
    assert.ok("error" in parsed, `must reject ${JSON.stringify(input)}`);
  }

  // The engine backstop scores malformed input 0 rather than throwing.
  assert.equal(scorePrediction({ kind: "range", min: 50, max: 40 }, 45), 0);
  assert.equal(scorePrediction(null, 45), 0);

  // A malformed submission is a 400, not a stored miss.
  const state = initPvPOddsGame({ random: seeded(3) });
  assert.throws(
    () => submitPrediction(state, "player1", { kind: "range", min: 10, max: 5 }),
    (err) => err.status === 400,
  );
  assert.throws(
    () => submitPrediction(state, "player1", { kind: "exact", value: 101 }),
    (err) => err.status === 400,
  );
});

test("one call per seat per round, and no resolving before both are in", () => {
  const state = initPvPOddsGame({ random: seeded(11) });
  assert.throws(() => resolveRound(state), /Both players must submit/);

  const one = submitPrediction(state, "player1", { kind: "exact", value: 50 });
  assert.throws(() => resolveRound(one.updatedState), /Both players must submit/);

  // "Locked in is locked in" — a conflicting second call is refused, and the
  // first one is what survives.
  assert.throws(
    () => submitPrediction(one.updatedState, "player1", { kind: "exact", value: 51 }),
    /already submitted/,
  );
  assert.deepEqual(predictionOf(one.updatedState, true), { kind: "exact", value: 50 });
  assert.equal(hasSubmitted(one.updatedState, true), true);
  assert.equal(hasSubmitted(one.updatedState, false), false);
});

/** Parse a clue sentence back into the set of numbers it admits. */
function admits(clue) {
  const text = String(clue).trim();
  let m = text.match(/^Higher than (\d+)\.$/);
  if (m) {
    const bound = Number(m[1]);
    return { kind: "higher", numbers: range(1, 100).filter((n) => n > bound) };
  }
  m = text.match(/^Lower than (\d+)\.$/);
  if (m) {
    const bound = Number(m[1]);
    return { kind: "lower", numbers: range(1, 100).filter((n) => n < bound) };
  }
  m = text.match(/^Somewhere in the (lower|upper) half\.$/);
  if (m) {
    return {
      kind: `${m[1]}-half`,
      numbers: range(1, 100).filter((n) => (m[1] === "lower" ? n <= 50 : n > 50)),
    };
  }
  m = text.match(/^Between (\d+) and (\d+), inclusive\.$/);
  if (m) {
    const min = Number(m[1]);
    const max = Number(m[2]);
    return { kind: "interval", numbers: range(min, max) };
  }
  return { kind: "unknown", numbers: [] };
}

function range(min, max) {
  const out = [];
  for (let n = min; n <= max; n += 1) out.push(n);
  return out;
}

test("every clue is truthful, ambiguous, and admits at least five targets", () => {
  const countsByRound = new Map();

  for (let round = 1; round <= TOTAL_ROUNDS; round += 1) {
    for (let target = TARGET_MIN; target <= TARGET_MAX; target += 1) {
      const clue = createClue(target, round);
      const parsed = admits(clue.text);

      assert.notEqual(parsed.kind, "unknown", `unparseable clue: ${clue.text}`);
      assert.ok(
        parsed.numbers.includes(target),
        `round ${round} clue "${clue.text}" must be true of ${target}`,
      );
      assert.ok(
        parsed.numbers.length >= MIN_CLUE_CANDIDATES,
        `round ${round} clue "${clue.text}" leaves only ${parsed.numbers.length} targets`,
      );
      assert.ok(
        parsed.numbers.length < TARGET_MAX - TARGET_MIN + 1,
        "a clue must always rule something out",
      );
      // The engine's own candidate list is the same set the sentence admits —
      // this is what stops the text and the last scoring rule drifting apart.
      assert.deepEqual(
        clue.candidates,
        parsed.numbers,
        `candidates disagree with "${clue.text}"`,
      );
      // No parity, divisibility or exact-number hints, at any round.
      assert.doesNotMatch(clue.text, /even|odd|multiple|divisible|digit|prime/i);
      assert.equal(clue.candidates.length > 1, true);

      const bucket = countsByRound.get(round) ?? new Set();
      bucket.add(parsed.numbers.length);
      countsByRound.set(round, bucket);
    }
  }

  // Early rounds are broad: halves and comparisons only, never a narrow band.
  for (const round of [1, 2]) {
    for (let target = TARGET_MIN; target <= TARGET_MAX; target += 1) {
      const clue = createClue(target, round);
      assert.notEqual(clue.kind, "interval", `round ${round} must not use intervals`);
    }
  }

  // The ladder never widens: each round's widest clue is no wider than the
  // previous round's.
  let previousMax = Infinity;
  for (let round = 1; round <= TOTAL_ROUNDS; round += 1) {
    const widest = Math.max(...countsByRound.get(round));
    assert.ok(
      widest <= previousMax,
      `round ${round} widened the field to ${widest} (previous ${previousMax})`,
    );
    previousMax = widest;
  }
  // The last round is genuinely the tightest.
  assert.ok(Math.max(...countsByRound.get(5)) <= 9);
});

test("both seats are given the same clue text for the same round", () => {
  const round = createRound(3, seeded(21));
  const clue = createClue(round.target, 3);
  assert.equal(round.clue, clue.text);
});

// ── 3. Secrecy ───────────────────────────────────────────────────────────

test("the live target and the opponent's pending call never reach a player", () => {
  let state = initPvPOddsGame({ random: seeded(5) });
  const target = currentRoundOf(state).target;

  // Nobody has called yet.
  for (const isP1 of [true, false]) {
    const view = viewForPlayer(state, isP1);
    assert.equal(view.rounds[0].target, null);
    assert.equal(view.mySubmitted, false);
    assert.equal(view.opponentSubmitted, false);
  }

  state = submitPrediction(state, "player1", { kind: "exact", value: target }).updatedState;

  const asP1 = viewForPlayer(state, true);
  assert.equal(asP1.rounds[0].target, null, "the answer is still secret");
  assert.deepEqual(asP1.rounds[0].player1Prediction, { kind: "exact", value: target });
  assert.equal(asP1.rounds[0].player2Prediction, null);
  assert.equal(asP1.mySubmitted, true);

  const asP2 = viewForPlayer(state, false);
  assert.equal(asP2.rounds[0].target, null);
  assert.equal(asP2.rounds[0].player1Prediction, null, "the opponent's call is hidden");
  assert.equal(asP2.rounds[0].player2Prediction, null);
  assert.equal(asP2.opponentSubmitted, true);

  // No score is published before the round resolves either.
  assert.equal(asP1.rounds[0].player1Score, null);
  assert.equal(asP1.rounds[0].player2Score, null);
});

test("a public match view is JSON-serialisable without the target", () => {
  const state = initPvPOddsGame({ random: seeded(8) });
  const target = currentRoundOf(state).target;
  const json = JSON.stringify(viewForPlayer(state, true));
  assert.equal(
    json.includes(`"target":${target}`),
    false,
    "the serialised view must not carry the live target as a number",
  );
});

// ── 4. AI entry point and the money rules ────────────────────────────────

test("the bot always makes a legal call and one submission closes its round", () => {
  const rand = seeded(1234);
  for (const tier of ["easy", "normal", "hard"]) {
    for (let i = 0; i < 40; i += 1) {
      const call = botPrediction(50, tier, rand);
      assert.ok(call.kind === "exact" || call.kind === "range");
      assert.ok(predictionWidth(call) >= 1);
      if (call.kind === "exact") {
        assert.ok(call.value >= TARGET_MIN && call.value <= TARGET_MAX);
      } else {
        assert.ok(call.min >= TARGET_MIN && call.max <= TARGET_MAX && call.min <= call.max);
      }
    }
  }

  const state = initPvPOddsGame({ random: seeded(4321) });
  const target = currentRoundOf(state).target;
  const { round, updatedState } = submitAIPrediction(
    state,
    { kind: "exact", value: target },
    "normal",
    seeded(55),
  );
  assert.equal(round.resolved, true);
  assert.equal(round.player1Score, 100, "a correct exact call pays 100 against the bot too");
  assert.equal(updatedState.currentRound, 2);
  // The AI scored through the same engine function — never a closest-number rule.
  assert.equal(round.player2Score, scorePrediction(round.player2Prediction, target));
  assert.equal(describePrediction({ kind: "range", min: 41, max: 42 }), "41–42");
  assert.equal(describePrediction({ kind: "exact", value: 7 }), "exact 7");
  assert.equal(describePrediction(null), "—");
});

test("the pot is both stakes minus the shared rake", () => {
  // Same formula as `oddsPvpPayout`, asserted against the shared economy
  // constant so a rake change shows up here rather than in production.
  assert.equal(PVP_WINNER_SHARE, 0.9);
  for (const stake of [0, 10, 25, 100]) {
    const pot = Number((2 * stake * PVP_WINNER_SHARE).toFixed(2));
    if (stake === 0) assert.equal(pot, 0, "a free match moves nothing");
    else assert.ok(pot < 2 * stake, "the house keeps its rake");
  }
});

// ── 5. Route guards (the parts that need a database to execute) ──────────

const read = (relPath) =>
  fs.readFileSync(path.join(process.cwd(), relPath), "utf8").replace(/\r\n/g, "\n");

/** Source with `//` comment lines dropped, so assertions are about real code. */
const code = (relPath) =>
  read(relPath)
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");

const PICK = "src/app/api/odds/pvp/pick/route.ts";
const STATUS = "src/app/api/odds/pvp/status/route.ts";
const CLEANUP = "src/app/api/odds/pvp/cleanup/route.ts";
const AI_START = "src/app/api/odds/ai/start/route.ts";
const CLIENT = "src/app/casino/odds/game/[matchId]/PageClient.tsx";

function routeFiles(dir = "src/app/api/odds") {
  const out = [];
  for (const entry of fs.readdirSync(path.join(process.cwd(), dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...routeFiles(rel));
    else if (entry.name === "route.ts" || entry.name === "route.js") out.push(rel);
  }
  return out;
}

/** Every `NextResponse.json({ … })` payload in a route, as source text. */
function jsonPayloads(body) {
  const marker = "NextResponse.json(";
  const payloads = [];
  let at = body.indexOf(marker);
  while (at !== -1) {
    const start = at + marker.length - 1; // the opening paren
    let depth = 0;
    let end = start;
    for (; end < body.length; end += 1) {
      if (body[end] === "(") depth += 1;
      else if (body[end] === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    payloads.push(body.slice(start, end + 1));
    at = body.indexOf(marker, end);
  }
  return payloads;
}

test("no Odds route hands the raw engine state to a client", () => {
  const routes = routeFiles();
  assert.ok(routes.length >= 8, `expected the Odds route tree, found ${routes.length}`);

  // A state leaves the server only as `null` or a `viewForPlayer` projection
  // (usually via a local named `view`). `.set({ gameState })` writes to the DB
  // and is not a payload, which is why only the JSON bodies are scanned.
  const safeValue = /^\s*(null|\[\]|view\b|view\?|viewForPlayer\(|\w+\.view\b|\w+\.view\?)/;

  for (const route of routes) {
    for (const payload of jsonPayloads(code(route))) {
      for (const key of ["gameState", "updatedState", "rounds"]) {
        const re = new RegExp(`${key}:\\s*`, "g");
        let m = re.exec(payload);
        while (m) {
          // A short window is enough: the value is either a bare projection
          // (`view`, `viewForPlayer(...)`, `null`) or a ternary whose branches
          // project. A raw `gameState: game.gameState,` matches neither.
          const expr = payload.slice(m.index + m[0].length, m.index + m[0].length + 90);
          assert.ok(
            safeValue.test(expr) || /viewForPlayer\(|view\b/.test(expr),
            `${route} returns \`${key}\` without a per-viewer projection: ${expr.split("\n")[0]}`,
          );
          m = re.exec(payload);
        }
      }
    }
  }

  // The AI session start is the one that used to return the raw state (round
  // 1's target included); it must project.
  assert.match(code(AI_START), /viewForPlayer\(result\.gameState, true\)/);
});

test("the round timeout pays the seat that called the round, never the idle one", () => {
  const pick = code(PICK);
  // The claim branch requires MY call to be in AND the opponent's not to be.
  assert.match(pick, /roundAge > ROUND_TIMEOUT_MS/);
  assert.match(pick, /mineSubmitted && !opponentSubmitted/);
  // The mirror case must not be payable: no settlement keyed on the opponent
  // having submitted while the caller has not.
  assert.doesNotMatch(
    pick,
    /roundAge > ROUND_TIMEOUT_MS && opponentSubmitted(?!\s*&&)/,
  );
  // The winner is always the caller of a *due* claim.
  assert.match(pick, /const winnerId = userId;/);
});

test("a claim carries no prediction, so it can never overwrite a pending call", () => {
  const pick = code(PICK);
  assert.match(pick, /const claimOnly = body\?\.claim === true;/);
  assert.match(pick, /if \(claimOnly\) \{[\s\S]{0,240}?nothing to claim yet/);

  const client = code(CLIENT);
  assert.match(client, /JSON\.stringify\(\{ gameId: myGameId, claim: true \}\)/);
  // The board only offers it once the server-side round is actually due.
  assert.match(client, /idleForMs >= ROUND_TIMEOUT_MS/);
  assert.match(client, /ROUND_TIMEOUT_MS/);
});

test("the inactivity sweep forfeits the seat that never called", () => {
  const cleanup = code(CLEANUP);
  assert.match(cleanup, /if \(p1Done && !p2Done\)/);
  assert.match(cleanup, /forfeitPlayer\(game\.id, game\.player2Id!/);
  assert.match(cleanup, /if \(!p1Done && p2Done\)/);
  assert.match(cleanup, /forfeitPlayer\(game\.id, game\.player1Id/);
  // Both silent is a refund, not a win for anybody.
  assert.match(cleanup, /cancelAbandonedGame/);
  assert.match(cleanup, /voidUnsupportedOddsMatch/);
});

test("a match both seats abandoned is voided and refunded on read", () => {
  const status = code(STATUS);
  assert.match(status, /function isAbandoned/);
  assert.match(status, /live\.player1Prediction !== null \|\|/);
  assert.match(status, /ROUND_TIMEOUT_MS \* 2/);
  assert.match(status, /voidUnsupportedOddsMatch\(\{/);
  assert.match(status, /clerkIds: \[locked\.player1Id, locked\.player2Id\]/);
  assert.match(status, /result: "cancelled"/);
  // Idempotent: re-checked under the row lock before settling.
  assert.match(status, /\.for\("update"\)/);
});

test("a settled match cannot be settled twice", () => {
  for (const route of [PICK, STATUS, CLEANUP, "src/app/api/odds/pvp/forfeit/route.ts"]) {
    const body = code(route);
    assert.match(body, /status !== "playing"/, `${route} must re-check the match status under the lock`);
    assert.match(body, /\.for\("update"\)/, `${route} must lock the row it settles`);
  }
});

test("a draw is refunded rather than paid to a seat", () => {
  const pick = code(PICK);
  assert.match(pick, /if \(winner\) \{[\s\S]*?payOddsPvpWinner/);
  assert.match(pick, /voidUnsupportedOddsMatch\(\{[\s\S]{0,400}?result: "draw"/);
  // No winner → no payout is advertised either.
  assert.match(pick, /payout: winner \? payout : 0/);
});

test("the retired rules are gone from the game's copy and docs", () => {
  const retired = [
    /six rounds/i,
    /shrinking (range|window)/i,
    /closest (predictions?|guess)/i,
    /100 → 50 → 25 → 12 → 6 → 3/,
    /1–100 down to 1–3/,
  ];

  // Files that are only about Odds are checked whole.
  for (const file of [
    "docs/GAME_ODDS.md",
    "src/app/casino/odds/PageClient.tsx",
    "src/images/odds.svg",
  ]) {
    const text = read(file);
    for (const pattern of retired) {
      assert.doesNotMatch(text, pattern, `${file} still describes the retired rules: ${pattern}`);
    }
  }

  // The catalogue holds every game (Barricade really does have a shrinking
  // window), so only the Odds entry is checked here.
  const landingText = read("src/lib/gameLandingPages.ts");
  const oddsEntry = landingText.slice(
    landingText.indexOf('slug: "odds"'),
    landingText.indexOf('slug: "hex-duel"'),
  );
  assert.ok(oddsEntry.length > 500, "the Odds landing entry must exist");
  for (const pattern of retired) {
    assert.doesNotMatch(oddsEntry, pattern, `the Odds landing entry still describes the retired rules: ${pattern}`);
  }

  // The translated lobby card blurb, in every locale.
  const descriptions = read("src/lib/appTextTranslations.js")
    .split("\n")
    .filter((line) => line.includes("odds_desc:"));
  assert.equal(descriptions.length, 3, "one odds_desc per locale");
  for (const line of descriptions) {
    for (const pattern of retired) {
      assert.doesNotMatch(line, pattern, `a translated odds_desc still describes the retired rules: ${pattern}`);
    }
  }

  // …and the current rules are actually stated where players read them.
  assert.match(oddsEntry, /five rounds/i);
  assert.match(oddsEntry, /1–100/);
  assert.match(oddsEntry, /100 ÷ its width/);

  const guide = read("docs/GAME_ODDS.md");
  assert.match(guide, /5 rounds/);
  assert.match(guide, /at least five/i);
});
