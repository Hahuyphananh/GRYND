// qa/hillstrike-fairness.mjs
//
// Measures Hillstrike's fairness over a LARGE FIXED SEED SET and reports the
// numbers instead of assuming them.
//
// The battlefield generator is mirror-symmetric. That is a property of the MAP,
// and it is worth stating plainly what it does NOT prove: it does not prove that
// a match is fair, because the opening shot, the one-two-two volley order and the
// way destruction reshapes one side of the field all remain asymmetric. So this
// script plays real bot-vs-bot matches on the real engine, twice per seed —
//        A: the seed's recorded opening seat        B: the same seed, opening
//        seat swapped to the other player
// and measures:
//
//   • LAYOUTS: generation failures (\"rejections\"), validation failures, mirror
//     failures, and whether both seats actually have a line of fire (a symmetric
//     map with no line is not a fair map);
//   • MATCHES: wins by seat, wins by the opening seat (with a 95% Wilson
//     interval), first-shot hit rate, overall hit rate, match length;
//   • ASYMMETRY: per seed, whether the OPENING SEAT won both orientations (a
//     tempo advantage) or the same SEAT won both (a seat advantage), or the
//     pair split.
//
// Everything is deterministic (fixed seeds, a slip-free bot), so a re-run
// reproduces every number to the match.
//
// Usage:
//   node --import tsx qa/hillstrike-fairness.mjs                 # 200 seeds, normal
//   node --import tsx qa/hillstrike-fairness.mjs --seeds=400 --tiers=normal,easy,hard
//   node --import tsx qa/hillstrike-fairness.mjs --quick         # 40 seeds, normal
//
// Writes qa/reports/hillstrike-fairness/{report.json,summary.md}.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { chooseAiShot } from "../src/lib/hillstrike/ai.ts";
import {
  IMPACT_KINDS,
  MATCH_STATUS,
  TERRAIN_COLUMNS,
} from "../src/lib/hillstrike/constants.ts";
import { createBattlefield, validateBattlefield } from "../src/lib/hillstrike/generation.ts";
import { simulateShot } from "../src/lib/hillstrike/physics.ts";
import { applyShot, createInitialState } from "../src/lib/hillstrike/rules.ts";
import { AI_DIFFICULTIES } from "../src/lib/aiDifficulty.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPORTS = join(root, "qa", "reports", "hillstrike-fairness");
mkdirSync(REPORTS, { recursive: true });

const args = new Map(
  process.argv.slice(2).map((argument) => {
    const [key, value = "true"] = argument.replace(/^--/, "").split("=");
    return [key, value];
  }),
);
const QUICK = args.has("quick");
const SEED_COUNT = Number(args.get("seeds") ?? (QUICK ? 40 : 200));
const TIERS = (args.get("tiers") ?? "normal")
  .split(",")
  .map((tier) => tier.trim())
  .filter((tier) => AI_DIFFICULTIES.includes(tier));
if (TIERS.length === 0) {
  console.error(`unknown tier(s); pick from ${AI_DIFFICULTIES.join(", ")}`);
  process.exit(1);
}

/** Large, awkward seeds, always included: the fixed set is part of the contract. */
const FIXED_SEEDS = [424242, 777777, 123456789, 4294967295];
const SEEDS = [
  ...new Set([...Array.from({ length: SEED_COUNT }, (_, index) => index), ...FIXED_SEEDS]),
].sort((a, b) => a - b);

const SEATS = ["player1", "player2"];
const other = (seat) => (seat === "player1" ? "player2" : "player1");
const NO_SLIPS = () => 1;

console.log(
  `hillstrike fairness — ${SEEDS.length} seeds × 2 opening seats × ${TIERS.length} tier(s) ` +
    `(${TIERS.join(", ")})`,
);

// ── Layouts ────────────────────────────────────────────────────────────────

function playableSeats(state) {
  const seats = new Set();
  const hits = (seat, angle, power) => {
    const impact = simulateShot({
      battlefield: state.battlefield,
      shooterSeat: seat,
      shot: { angleDeg: angle, power },
      projectile: state.projectile,
    }).impact;
    return impact.kind === IMPACT_KINDS.PLAYER && impact.target === other(seat);
  };
  for (let angle = 4; angle <= 86 && seats.size < 2; angle += 2) {
    for (let power = 20; power <= 100; power += 4) {
      if (!seats.has("player1") && hits("player1", angle, power)) seats.add("player1");
      if (!seats.has("player2") && hits("player2", 180 - angle, power)) seats.add("player2");
      if (seats.size === 2) break;
    }
  }
  return seats;
}

function measureLayout(seed) {
  let field;
  try {
    field = createBattlefield(seed);
  } catch (error) {
    return { seed, generated: false, reason: String(error && error.message) };
  }
  const verdict = validateBattlefield(field);
  const mirrored =
    field.terrain.every((height, column) => height === field.terrain[TERRAIN_COLUMNS - 1 - column]) &&
    field.players.player1.y === field.players.player2.y;
  const state = createInitialState({ seed, openingSeat: "player1" });
  const reachable = playableSeats(state);
  return {
    seed,
    generated: true,
    valid: verdict.ok,
    reason: verdict.ok ? null : verdict.message,
    mirrored,
    playableSeats: [...reachable],
    spawnHeight: field.players.player1.y,
    blocks: field.blocks.length,
  };
}

// ── Matches ────────────────────────────────────────────────────────────────

function playMatch({ seed, openingSeat, tier, maxShots = 80 }) {
  let state = createInitialState({ seed, openingSeat });
  let shots = 0;
  let hits = 0;
  let firstShotHit = false;
  const problems = [];

  while (state.status === MATCH_STATUS.PLAYING && shots < maxShots) {
    const shooter = state.turn;
    const shot = chooseAiShot({ state, seat: shooter, difficulty: tier, random: NO_SLIPS });
    const next = applyShot(state, shooter, shot).state;

    if (![1, 2].includes(state.shotsRemaining)) problems.push("volley counter out of range");
    if (next.turnIndex !== state.turnIndex + 1) problems.push("turn index did not advance");
    if (next.lastShot.livesLost > 0) {
      hits += 1;
      if (shots === 0) firstShotHit = true;
    }
    if (!validateBattlefield(next.battlefield).ok) problems.push("invalid battlefield");
    state = next;
    shots += 1;
  }

  return {
    seed,
    openingSeat,
    tier,
    finished: state.status === MATCH_STATUS.FINISHED,
    winner: state.winner,
    shots,
    hits,
    firstShotHit,
    lives: state.lives,
    problems,
  };
}

// ── Statistics ─────────────────────────────────────────────────────────────

function wilson(successes, total, z = 1.96) {
  if (total === 0) return { low: 0, high: 0, p: 0 };
  const p = successes / total;
  const denominator = 1 + (z * z) / total;
  const centre = p + (z * z) / (2 * total);
  const spread = z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));
  return {
    p,
    low: Math.max(0, (centre - spread) / denominator),
    high: Math.min(1, (centre + spread) / denominator),
  };
}

const percent = (value) => `${(value * 100).toFixed(1)}%`;
const interval = (stats) => `${percent(stats.p)} (95% CI ${percent(stats.low)}–${percent(stats.high)})`;

// ── Run ────────────────────────────────────────────────────────────────────

const layouts = SEEDS.map(measureLayout);
const layoutStats = {
  seeds: layouts.length,
  generated: layouts.filter((layout) => layout.generated).length,
  rejected: layouts.filter((layout) => !layout.generated),
  invalid: layouts.filter((layout) => layout.generated && !layout.valid),
  asymmetric: layouts.filter((layout) => layout.generated && !layout.mirrored),
  playableBoth: layouts.filter((layout) => layout.playableSeats?.length === 2).length,
  playableOne: layouts.filter((layout) => layout.playableSeats?.length === 1),
  playableNone: layouts.filter((layout) => layout.playableSeats?.length === 0),
  spawnHeights: layouts.filter((layout) => layout.generated).map((layout) => layout.spawnHeight),
};
layoutStats.rejectionRate = layoutStats.rejected.length / layoutStats.seeds;
layoutStats.playableRate = layoutStats.playableBoth / layoutStats.seeds;

console.log(
  `\nLAYOUTS  generated ${layoutStats.generated}/${layoutStats.seeds} · ` +
    `rejected ${layoutStats.rejected.length} (${percent(layoutStats.rejectionRate)}) · ` +
    `invalid ${layoutStats.invalid.length} · asymmetric ${layoutStats.asymmetric.length}`,
);
console.log(
  `         playable for both seats ${layoutStats.playableBoth}/${layoutStats.seeds} ` +
    `(${percent(layoutStats.playableRate)}) · one seat only ${layoutStats.playableOne.length} · ` +
    `neither ${layoutStats.playableNone.length}`,
);
console.log(
  `         spawn height ${Math.min(...layoutStats.spawnHeights)}–${Math.max(...layoutStats.spawnHeights)}`,
);

const perTier = [];

for (const tier of TIERS) {
  const matches = [];
  for (const seed of SEEDS) {
    for (const openingSeat of SEATS) {
      matches.push(playMatch({ seed, openingSeat, tier }));
    }
  }

  const unfinished = matches.filter((match) => !match.finished);
  const broken = matches.filter((match) => match.problems.length > 0);
  const seatWins = { player1: 0, player2: 0 };
  let openerWins = 0;
  let firstShotHits = 0;
  let hits = 0;
  let shots = 0;
  const lengths = [];
  for (const match of matches) {
    seatWins[match.winner] += 1;
    if (match.winner === match.openingSeat) openerWins += 1;
    if (match.firstShotHit) firstShotHits += 1;
    hits += match.hits;
    shots += match.shots;
    lengths.push(match.shots);
  }

  // Per seed: did the OPENING SEAT win both orientations, the same SEAT win both,
  // or did the pair split? The first is a tempo advantage, the second a seat one.
  const pairs = SEEDS.map((seed) => {
    const a = matches.find((match) => match.seed === seed && match.openingSeat === "player1");
    const b = matches.find((match) => match.seed === seed && match.openingSeat === "player2");
    return { seed, a, b };
  });
  const openerConsistent = pairs.filter(
    (pair) => pair.a.winner === pair.a.openingSeat && pair.b.winner === pair.b.openingSeat,
  ).length;
  const seatConsistent = pairs.filter((pair) => pair.a.winner === pair.b.winner).length;
  const split = pairs.length - openerConsistent - seatConsistent;

  const openerStats = wilson(openerWins, matches.length);
  const p1Stats = wilson(seatWins.player1, matches.length);
  const firstShotStats = wilson(firstShotHits, matches.length);

  const summary = {
    tier,
    matches: matches.length,
    unfinished: unfinished.length,
    brokenStates: broken.length,
    seatWins,
    seatWinRate: { player1: p1Stats, player2: wilson(seatWins.player2, matches.length) },
    openerWins,
    openerWinRate: openerStats,
    firstShotHits,
    firstShotHitRate: firstShotStats,
    hitRate: shots === 0 ? 0 : hits / shots,
    meanShots: lengths.reduce((sum, value) => sum + value, 0) / lengths.length,
    minShots: Math.min(...lengths),
    maxShots: Math.max(...lengths),
    pairs: { count: pairs.length, openerConsistent, seatConsistent, split },
  };
  perTier.push(summary);

  console.log(`\nMATCHES  tier=${tier} · ${summary.matches} matches over ${SEEDS.length} seeds × both opening seats`);
  console.log(
    `         finished ${summary.matches - summary.unfinished}/${summary.matches} · ` +
      `invalid transitions ${summary.brokenStates}`,
  );
  console.log(
    `         seat wins: player1 ${seatWins.player1} (${interval(p1Stats)}) · ` +
      `player2 ${seatWins.player2} (${interval(summary.seatWinRate.player2)})`,
  );
  console.log(
    `         opening-seat wins: ${openerWins}/${summary.matches} = ${interval(openerStats)}`,
  );
  console.log(
    `         first shot hit ${firstShotHits}/${summary.matches} (${percent(firstShotStats.p)}) · ` +
      `shots that took a life ${percent(summary.hitRate)} · ` +
      `length mean ${summary.meanShots.toFixed(2)} (${summary.minShots}–${summary.maxShots}) shots`,
  );
  console.log(
    `         per-seed pairs: opening seat won both ${openerConsistent}/${pairs.length} · ` +
      `same seat won both ${seatConsistent}/${pairs.length} · split ${split}/${pairs.length}`,
  );

  if (openerStats.low > 0.5) {
    console.log(
      `         ⚠ OPENING-SEAT ADVANTAGE: the 95% interval excludes a coin flip ` +
        `(${percent(openerStats.low)}–${percent(openerStats.high)}).`,
    );
  }
}

// ── Invariants: the script fails loudly rather than reporting a broken sweep ──

const failures = [];
if (layoutStats.rejected.length > 0) failures.push("a seed failed to generate a battlefield");
if (layoutStats.invalid.length > 0) failures.push("a generated battlefield failed validation");
if (layoutStats.asymmetric.length > 0) failures.push("a generated battlefield was not mirror-symmetric");
if (layoutStats.playableBoth < layoutStats.seeds) failures.push("a layout was not playable for both seats");
for (const summary of perTier) {
  if (summary.unfinished > 0) failures.push(`tier ${summary.tier}: a match did not finish`);
  if (summary.brokenStates > 0) failures.push(`tier ${summary.tier}: an invalid state transition occurred`);
  if (summary.seatWins.player1 + summary.seatWins.player2 !== summary.matches) {
    failures.push(`tier ${summary.tier}: wins do not add up`);
  }
}

const report = {
  generatedAt: new Date().toISOString(),
  seeds: SEEDS.length,
  tiers: TIERS,
  deterministic: true,
  layouts: {
    seeds: layoutStats.seeds,
    generated: layoutStats.generated,
    rejectedCount: layoutStats.rejected.length,
    rejectionRate: layoutStats.rejectionRate,
    invalidCount: layoutStats.invalid.length,
    asymmetricCount: layoutStats.asymmetric.length,
    playableBothCount: layoutStats.playableBoth,
    playableRate: layoutStats.playableRate,
    playableOne: layoutStats.playableOne,
    playableNone: layoutStats.playableNone,
    rejected: layoutStats.rejected.slice(0, 20),
    invalid: layoutStats.invalid.slice(0, 20),
  },
  tiers: perTier,
  failures,
};
writeFileSync(join(REPORTS, "report.json"), JSON.stringify(report, null, 2));

const tempoWarned = perTier.filter((summary) => summary.openerWinRate.low > 0.5);
const tempoBehind = perTier.filter((summary) => summary.openerWinRate.high < 0.5);

const markdown = [
  "# Hillstrike fairness evaluation",
  "",
  `- Fixed seed set: **${SEEDS.length}** seeds — ${SEED_COUNT} consecutive seeds 0…${SEED_COUNT - 1}` +
    `${SEED_COUNT - 1 >= FIXED_SEEDS[0] ? "" : " (overlapping the fixed seeds below)"} plus the fixed awkward seeds ${FIXED_SEEDS.join(", ")}`,
  `- Tiers: ${TIERS.join(", ")} — slip-free bots, deterministic, reproducible`,
  `- Matches per tier: **${SEEDS.length * 2}** (every seed played with both opening seats)`,
  "",
  "## Layouts",
  "",
  `- Generated: ${layoutStats.generated}/${layoutStats.seeds}`,
  `- Rejection rate (generator threw): ${percent(layoutStats.rejectionRate)} (${layoutStats.rejected.length})`,
  `- Validation failures: ${layoutStats.invalid.length}`,
  `- Mirror failures: ${layoutStats.asymmetric.length}`,
  `- Playable for both seats: ${percent(layoutStats.playableRate)} (${layoutStats.playableBoth}/${layoutStats.seeds})`,
  "",
  "## Matches",
  "",
  "| tier | matches | player1 wins | player2 wins | opening-seat wins | opening 95% CI | first-shot hit | shot hit rate | mean length |",
  "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ...perTier.map(
    (summary) =>
      `| ${summary.tier} | ${summary.matches} | ${summary.seatWins.player1} | ${summary.seatWins.player2} | ` +
      `${summary.openerWins} (${percent(summary.openerWinRate.p)}) | ` +
      `${percent(summary.openerWinRate.low)}–${percent(summary.openerWinRate.high)} | ` +
      `${percent(summary.firstShotHitRate.p)} | ${percent(summary.hitRate)} | ` +
      `${summary.meanShots.toFixed(2)} |`,
  ),
  "",
  "### Per-seed pairs (tempo vs seat)",
  "",
  "| tier | opening seat won both | same seat won both | split |",
  "| --- | --- | --- | --- |",
  ...perTier.map(
    (summary) =>
      `| ${summary.tier} | ${summary.pairs.openerConsistent}/${summary.pairs.count} | ` +
      `${summary.pairs.seatConsistent}/${summary.pairs.count} | ${summary.pairs.split}/${summary.pairs.count} |`,
  ),
  "",
  "## Asymmetry found",
  "",
  ...(tempoWarned.length > 0
    ? [
        "**The opening seat decides the match at high accuracy.** The one-two-two",
        "volley order gives the opener the killing shot first whenever both players",
        "land their shots:",
        "",
        ...tempoWarned.map(
          (summary) =>
            `- \`${summary.tier}\`: opener wins ${percent(summary.openerWinRate.p)} ` +
            `(95% CI ${percent(summary.openerWinRate.low)}–${percent(summary.openerWinRate.high)}), ` +
            `opening shot hits ${percent(summary.firstShotHitRate.p)} of the time, ` +
            `shot hit rate ${percent(summary.hitRate)}, mean ${summary.meanShots.toFixed(2)} shots`,
        ),
        "",
        "The seats themselves are not advantaged: player1 and player2 win equally",
        "often, because every seed is played from both opening seats. This is a TEMPO",
        "asymmetry in the volley rules, not a bias in the map or the physics.",
      ]
    : []),
  ...(tempoBehind.length > 0
    ? [
        "",
        "**At low accuracy the same rule works the other way.** The opening seat fires",
        "one shot and then matches the opponent two-for-two, so over a long match it",
        "takes one shot FEWER than the second seat — and at a low hit rate that extra",
        "chance is worth more than first strike:",
        "",
        ...tempoBehind.map(
          (summary) =>
            `- \`${summary.tier}\`: opener wins only ${percent(summary.openerWinRate.p)} ` +
            `(95% CI ${percent(summary.openerWinRate.low)}–${percent(summary.openerWinRate.high)}), ` +
            `shot hit rate ${percent(summary.hitRate)}, mean ${summary.meanShots.toFixed(2)} shots`,
        ),
      ]
    : []),
  "",
  "## What this does and does not prove",
  "",
  "The map generator is mirror-symmetric, and every layout in this sweep is",
  "mirrored and playable for both seats. That symmetry is necessary and it is not",
  "sufficient: it says nothing about whether a *match* is fair, because the opening",
  "shot, the volley order and the way destruction reshapes one side of the field",
  "are still asymmetric. The numbers above are the measurement of those parts, and",
  "they are reported rather than asserted.",
  "",
  "These numbers describe two equally-skilled bots. They are not a claim about",
  "human play, where misses are common; they bound what a near-perfect player can",
  "do with the opening seat.",
  "",
  "## Design implications (not implemented here)",
  "",
  "- The opening seat is recorded on every match (`openingSeat`), so a staked or",
  "  ranked mode can account for the tempo asymmetry instead of ignoring it.",
  "- If matchmaking ever pairs players of very high accuracy, alternating the",
  "  opening seat across a series (or a best-of-N format) removes the advantage;",
  "  a single match does not.",
  "- The practice ladder should keep `easy` genuinely inaccurate: its low hit rate",
  "  is what makes a practice match last long enough to practise aiming.",
  "",
];
writeFileSync(join(REPORTS, "summary.md"), markdown.join("\n"));

console.log(`\nreport: ${join(REPORTS, "report.json")}`);
console.log(`summary: ${join(REPORTS, "summary.md")}`);
if (failures.length > 0) {
  console.log(`\nFAILURES:\n- ${failures.join("\n- ")}`);
  process.exitCode = 1;
} else {
  console.log("\nALL INVARIANTS HELD (layouts valid & mirrored & playable; every match terminated)");
}
