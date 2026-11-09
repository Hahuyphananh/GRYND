#!/usr/bin/env node
// qa/bot-benchmark.mjs
//
// A DETERMINISTIC strength audit of the six named Solitaire bots.
//
// Every bot plays the SAME deals, with the same move limit and the same
// stagnation rule, through its real `planAiMoves` path (the same deterministic
// `botRoll(ply)` dice the server uses). Nothing here reaches into hidden cards,
// swaps deals per bot, or changes a profile to make a table look tidy.
//
// Metrics per bot:
//   • completion rate over N deals (with a 95% Wilson interval),
//   • mean plies and wall-clock cost per deal, ms per decision,
//   • DECISION QUALITY: for the first `--regret-plies` decisions of every deal,
//     the chosen move is scored with the strongest fair objective (Perfect's
//     weights, `scoreMove`) against the best legal move in the same position.
//       regret      = bestScore − chosenScore
//       mistakes    = decisions with regret > 1        (not the best move)
//       gross       = decisions with regret ≥ 500      (a real blunder)
//   • legality: every chosen move must be a member of `legalMoves(state)`,
//   • with --deep: the same regret against Perfect's FULL lookahead evaluator
//     (`evaluateMoveForBot(..., "perfect")`) on a small stratified sample.
//
// Adjacent bots are compared PAIRED on identical deals (sign test on discordant
// results), so the report can say whether an ordering is supported by data or
// is indistinguishable from noise.
//
// Usage:
//   node --import tsx qa/bot-benchmark.mjs --deals=120 --max-moves=900
//   node --import tsx qa/bot-benchmark.mjs --deals=60 --deep --deep-deals=12

import { performance } from "node:perf_hooks";

import {
  evaluateMoveForBot,
  legalMoves,
  planAiMoves,
  scoreMove,
} from "../src/lib/solitaire-duel/ai.ts";
import { SOLITAIRE_BOTS } from "../src/lib/solitaire-duel/bots.ts";
import { dealFromSeed } from "../src/lib/solitaire-duel/deck.ts";
import { applyMove, initialStateFromDeal } from "../src/lib/solitaire-duel/rules.ts";

const arg = (name, fallback) => {
  const hit = process.argv.find((entry) => entry.startsWith(`--${name}=`));
  return hit ? Number(hit.slice(name.length + 3)) : fallback;
};

const DEALS = Math.max(1, arg("deals", 120));
const MAX_MOVES = Math.max(1, arg("max-moves", 900));
const REGRET_PLIES = Math.max(0, arg("regret-plies", 80));
const DEEP = process.argv.includes("--deep");
const DEEP_DEALS = Math.max(1, arg("deep-deals", 12));
const DEEP_PLIES = Math.max(1, arg("deep-plies", 4));

const sameMove = (a, b) =>
  a.kind === b.kind &&
  (a.card?.suit ?? a.suit) === (b.card?.suit ?? b.suit) &&
  (a.card?.rank ?? null) === (b.card?.rank ?? null) &&
  (a.fromColumn ?? null) === (b.fromColumn ?? null) &&
  (a.toColumn ?? null) === (b.toColumn ?? null);

const foundationTotal = (state) =>
  ["spades", "hearts", "diamonds", "clubs"].reduce(
    (total, suit) => total + (state.foundations?.[suit]?.length ?? 0),
    0,
  );

/** 95% Wilson interval for a completion rate. */
function wilson(successes, total) {
  if (!total) return [0, 0];
  const z = 1.96;
  const p = successes / total;
  const denominator = 1 + (z * z) / total;
  const centre = (p + (z * z) / (2 * total)) / denominator;
  const spread =
    (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) /
    denominator;
  return [Math.max(0, centre - spread), Math.min(1, centre + spread)];
}

/** Two-sided sign test over discordant paired outcomes. */
function signTest(aWins, bWins) {
  const n = aWins + bWins;
  if (n === 0) return 1;
  const mean = n / 2;
  const sd = Math.sqrt(n) / 2;
  const z = Math.abs(aWins - mean) / sd;
  // Normal approximation is plenty for n >= 10; exact binomial below that.
  if (n >= 10) return Math.min(1, 2 * (1 - normalCdf(z)));
  let tail = 0;
  for (let k = 0; k <= Math.min(aWins, bWins); k += 1) {
    tail += binomial(n, k);
  }
  return Math.min(1, 2 * tail);
}

const normalCdf = (z) => 0.5 * (1 + erf(z / Math.SQRT2));
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}
function binomial(n, k) {
  let result = 1;
  for (let i = 1; i <= k; i += 1) result = (result * (n - k + i)) / i;
  return result / 2 ** n;
}

const rows = [];

for (const bot of SOLITAIRE_BOTS) {
  const row = {
    id: bot.id,
    name: bot.name,
    rating: bot.ratingLabel,
    deals: DEALS,
    completed: 0,
    completedFlags: [],
    moves: [],
    elapsedMs: [],
    stuck: 0,
    decisions: 0,
    regretSum: 0,
    regretMax: 0,
    notBest: 0,
    gross: 0,
    illegal: 0,
    finalFoundation: [],
    deepDecisions: 0,
    deepRegretSum: 0,
    deepNotBest: 0,
  };

  for (let seed = 1; seed <= DEALS; seed += 1) {
    const deal = dealFromSeed(seed);
    const start = initialStateFromDeal(deal);

    const started = performance.now();
    const plan = planAiMoves({ state: start, difficulty: bot.id, maxMoves: MAX_MOVES });
    row.elapsedMs.push(performance.now() - started);
    row.moves.push(plan.moves.length);
    row.completedFlags.push(plan.completed);
    if (plan.completed) row.completed += 1;
    if (plan.stuck) row.stuck += 1;

    // Replay exactly the plan's own trajectory to score its decisions.
    let state = start;
    for (let index = 0; index < plan.moves.length; index += 1) {
      const move = plan.moves[index];
      const legal = legalMoves(state);
      if (!legal.some((candidate) => sameMove(candidate, move))) {
        row.illegal += 1;
        break;
      }
      if (index < REGRET_PLIES) {
        const best = Math.max(...legal.map((candidate) => scoreMove(state, candidate)));
        const chosen = scoreMove(state, move);
        const regret = best - chosen;
        row.decisions += 1;
        row.regretSum += regret;
        row.regretMax = Math.max(row.regretMax, regret);
        if (regret > 1) row.notBest += 1;
        if (regret >= 500) row.gross += 1;
      }
      const applied = applyMove({ state, move });
      if (!applied.ok) break;
      state = applied.state;
    }
    row.finalFoundation.push(foundationTotal(state));

    // Optional: regret against Perfect's full lookahead, small sample only.
    if (DEEP && seed <= DEEP_DEALS) {
      let deepState = start;
      const limit = Math.min(DEEP_PLIES, plan.moves.length);
      for (let index = 0; index < limit; index += 1) {
        const move = plan.moves[index];
        const legal = legalMoves(deepState);
        const best = Math.max(
          ...legal.map((candidate) => evaluateMoveForBot(deepState, candidate, "perfect")),
        );
        const chosen = evaluateMoveForBot(deepState, move, "perfect");
        row.deepDecisions += 1;
        row.deepRegretSum += best - chosen;
        if (best - chosen > 1) row.deepNotBest += 1;
        const applied = applyMove({ state: deepState, move });
        if (!applied.ok) break;
        deepState = applied.state;
      }
    }
  }

  row.meanMoves = row.moves.reduce((a, b) => a + b, 0) / row.moves.length;
  row.meanMs = row.elapsedMs.reduce((a, b) => a + b, 0) / row.elapsedMs.length;
  row.msPerDecision = row.decisions
    ? row.elapsedMs.reduce((a, b) => a + b, 0) / row.decisions
    : 0;
  row.meanFoundation = row.finalFoundation.reduce((a, b) => a + b, 0) / DEALS;
  row.meanRegret = row.decisions ? row.regretSum / row.decisions : 0;
  row.notBestShare = row.decisions ? row.notBest / row.decisions : 0;
  row.grossShare = row.decisions ? row.gross / row.decisions : 0;
  row.deepMeanRegret = row.deepDecisions ? row.deepRegretSum / row.deepDecisions : null;
  row.deepNotBestShare = row.deepDecisions ? row.deepNotBest / row.deepDecisions : null;
  row.ci = wilson(row.completed, DEALS);
  rows.push(row);
}

const fmt = (value, digits = 2) => (value === null ? "—" : value.toFixed(digits));
const pct = (value) => `${(value * 100).toFixed(1)}%`;

console.log(
  `\nDETERMINISTIC BOT BENCHMARK — ${DEALS} identical deals (dealFromSeed 1..${DEALS}), ` +
    `maxMoves ${MAX_MOVES}, regret sampled on first ${REGRET_PLIES} plies\n`,
);
console.log(
  "bot          rating   complete (95% CI)      mean plies  mean ms   ms/dec  regret  not-best  gross  illegal",
);
for (const row of rows) {
  console.log(
    `${row.name.padEnd(12)} ${String(row.rating).padEnd(8)} ` +
      `${String(row.completed).padStart(3)}/${DEALS} ${pct(row.completed / DEALS).padStart(6)} ` +
      `[${pct(row.ci[0])}, ${pct(row.ci[1])}]`.padEnd(22) +
      ` ${fmt(row.meanMoves, 1).padStart(10)} ${fmt(row.meanMs, 0).padStart(8)} ` +
      `${fmt(row.msPerDecision, 1).padStart(7)} ${fmt(row.meanRegret, 1).padStart(7)} ` +
      `${pct(row.notBestShare).padStart(8)} ${pct(row.grossShare).padStart(6)} ` +
      `${String(row.illegal).padStart(7)}`,
  );
}

if (DEEP) {
  console.log(
    `\nPerfect full-lookahead reference (first ${DEEP_PLIES} plies of deals 1..${DEEP_DEALS}):`,
  );
  for (const row of rows) {
    console.log(
      `  ${row.name.padEnd(12)} decisions ${String(row.deepDecisions).padStart(3)}  ` +
        `mean regret ${fmt(row.deepMeanRegret, 1).padStart(8)}  ` +
        `not-best ${pct(row.deepNotBestShare ?? 0).padStart(6)}`,
    );
  }
}

console.log("\nPAIRED COMPARISON (identical deals; discordant completions, two-sided sign test):");
for (let index = 0; index + 1 < rows.length; index += 1) {
  const a = rows[index];
  const b = rows[index + 1];
  let aOnly = 0;
  let bOnly = 0;
  for (let deal = 0; deal < DEALS; deal += 1) {
    if (a.completedFlags[deal] && !b.completedFlags[deal]) aOnly += 1;
    if (b.completedFlags[deal] && !a.completedFlags[deal]) bOnly += 1;
  }
  const p = signTest(aOnly, bOnly);
  console.log(
    `  ${a.name.padEnd(12)} vs ${b.name.padEnd(12)}  ` +
      `${aOnly} vs ${bOnly} discordant  p=${p.toFixed(3)}  ` +
      `${p < 0.05 ? "distinct" : "not distinguishable at n=" + DEALS}`,
  );
}

console.log(
  "\nNOTE: regret is measured against Perfect's heuristic (and, with --deep, its bounded lookahead). " +
    "That reference is the strongest FAIR evaluator in this engine, not a solver; regret 0 does not " +
    "mean mathematically optimal play.\n",
);
