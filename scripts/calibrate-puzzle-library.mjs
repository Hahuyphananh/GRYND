// scripts/calibrate-puzzle-library.mjs
//
// RECORDED-HUMAN CALIBRATION REPORT for the strategic puzzle library.
//
// Reads only. Aggregates per-puzzle, per-HUMAN-seat attempts and solves from
// `solitaire_puzzle_sessions` + `solitaire_puzzle_session_moves`, then applies
// the rules in src/lib/solitaire-duel/puzzleCalibration.ts.
//
// Human seats: player1 always, plus player2 when the row is not AI. Practice
// (Puzzle vs AI) rows contribute only player1, because seat 2 is the bot.
// Waiting/cancelled sessions contribute nothing, and only the last
// `windowDays` of matches are read.
//
// Usage:
//   node --env-file-if-exists=.env.local --import tsx \
//     scripts/calibrate-puzzle-library.mjs [--window=30] [--write] [--json]
//
// Default is a dry run: it prints the report and writes nothing. `--write`
// regenerates src/lib/solitaire-duel/puzzleCalibrationData.ts. With too little
// data that file legitimately stays empty — calibration must never invent a
// rate it did not measure.

import { writeFileSync } from "node:fs";
import { sql } from "drizzle-orm";

const { db } = await import("../src/db/client.ts");
const { puzzleLibraryPuzzles } = await import(
  "../src/lib/solitaire-duel/puzzleLibrary.ts"
);
const { deriveDifficultyCalibration, PUZZLE_CALIBRATION_MIN_ATTEMPTS } =
  await import("../src/lib/solitaire-duel/puzzleCalibration.ts");

const args = process.argv.slice(2);
const write = args.includes("--write");
const jsonOnly = args.includes("--json");
const windowArg = args.find((arg) => arg.startsWith("--window="));
const windowDays = Math.max(
  1,
  Math.min(365, Number(windowArg?.split("=")[1] ?? 30) || 30),
);

const since = sql`now() - (${windowDays} || ' days')::interval`;

const sessionRows = (
  await db.execute(sql`
    select id, mode, is_ai, player2_id, status, p1_solved, p2_solved, manifest
      from solitaire_puzzle_sessions
     where status in ('playing', 'finished')
       and created_at >= ${since}
  `)
).rows;

const moveRows = (
  await db.execute(sql`
    select m.session_id, m.seat, m.puzzle_index, count(*)::int as n
      from solitaire_puzzle_session_moves m
      join solitaire_puzzle_sessions s on s.id = m.session_id
     where s.status in ('playing', 'finished')
       and s.created_at >= ${since}
     group by 1, 2, 3
  `)
).rows;

const attempted = new Set(
  moveRows.map((row) => `${row.session_id}|${row.seat}|${row.puzzle_index}`),
);

const samples = new Map();
const bump = (id, field) => {
  const entry = samples.get(id) ?? { attempts: 0, solves: 0 };
  entry[field] += 1;
  samples.set(id, entry);
};

for (const session of sessionRows) {
  const manifest =
    typeof session.manifest === "string"
      ? JSON.parse(session.manifest)
      : session.manifest;
  if (!Array.isArray(manifest) || manifest.length === 0) continue;

  const seats = [["player1", "p1_solved"]];
  if (!session.is_ai && session.player2_id) {
    seats.push(["player2", "p2_solved"]);
  }

  for (const [seat, solvedKey] of seats) {
    const solved = Number(session[solvedKey] ?? 0);
    for (let slot = 0; slot < manifest.length; slot += 1) {
      const entry = manifest[slot];
      if (!entry?.id) continue;
      if (attempted.has(`${session.id}|${seat}|${slot}`)) bump(entry.id, "attempts");
      if (solved > slot) bump(entry.id, "solves");
    }
  }
}

const library = puzzleLibraryPuzzles();
const { calibration, report } = deriveDifficultyCalibration({
  samples: Object.fromEntries(samples),
  puzzles: library.map((puzzle) => ({
    id: puzzle.id,
    band: puzzle.levelNumber,
    category: puzzle.category,
  })),
  minAttempts: PUZZLE_CALIBRATION_MIN_ATTEMPTS,
});

const output = {
  ...report,
  sessionsRead: sessionRows.length,
  humanSeatsRead: sessionRows.reduce(
    (total, session) => total + (session.is_ai || !session.player2_id ? 1 : 2),
    0,
  ),
  puzzlesWithSamples: samples.size,
  calibration,
};

if (jsonOnly) {
  console.log(JSON.stringify(output, null, 2));
} else {
  console.log("Puzzle difficulty calibration (recorded human play)");
  console.log(`  window:            ${windowDays} days`);
  console.log(`  sessions read:     ${output.sessionsRead}`);
  console.log(`  human seats read:  ${output.humanSeatsRead}`);
  console.log(`  puzzles sampled:   ${output.puzzlesWithSamples}/${output.puzzlesConsidered}`);
  console.log(`  eligible (>=${report.minAttempts}): ${output.eligible}`);
  console.log(`  tier sizes:        Beginner ${report.byTier.beginner}, Intermediate ${report.byTier.intermediate}`);
  console.log(`  changes:           ${report.changes.length}`);
  for (const change of report.changes) {
    console.log(
      `    ${change.id}: ${change.from} -> ${change.to} (${change.solves}/${change.attempts}, ${change.rate})`,
    );
  }
  const insufficient = report.skips.filter(
    (skip) => skip.reason === "insufficient-sample",
  ).length;
  if (insufficient) console.log(`  skipped (sample too small): ${insufficient}`);
  if (report.changes.length === 0) {
    console.log(
      "  result: no position had enough recorded human play to move a tier.",
    );
  }
}

if (write) {
  const meta = {
    generatedAt: new Date().toISOString().slice(0, 10),
    windowDays,
    minAttempts: PUZZLE_CALIBRATION_MIN_ATTEMPTS,
    sources: "ranked and Puzzle-vs-AI human seats",
    note:
      report.changes.length > 0
        ? `${report.changes.length} learning-tier position(s) moved to match recorded human solve rates.`
        : "No learning-tier position had the minimum recorded human sample, so no tier changed.",
  };
  const body = `// src/lib/solitaire-duel/puzzleCalibrationData.ts
//
// GENERATED by scripts/calibrate-puzzle-library.mjs — do not hand-edit.
//
// Recorded-human calibration for the two learning tiers. Only positions whose
// measured solve rate disagreed with their structural band are listed; an empty
// map means no position had the minimum sample, which is a real result.
//
// Each entry is \`{ attempts, solves, rate, band }\`: human seats that reached
// the position, seats that advanced past it, the resulting rate, and the band
// to use (1 = Beginner, 2 = Intermediate).

export const PUZZLE_CALIBRATION_META = ${JSON.stringify(meta, null, 2)} as const;

export type PuzzleCalibrationSnapshot = Readonly<
  Record<
    string,
    Readonly<{ attempts: number; solves: number; rate: number; band: 1 | 2 }>
  >
>;

export const PUZZLE_DIFFICULTY_CALIBRATION: PuzzleCalibrationSnapshot = Object.freeze(${JSON.stringify(calibration, null, 2)});
`;
  writeFileSync("src/lib/solitaire-duel/puzzleCalibrationData.ts", body);
  console.log("wrote src/lib/solitaire-duel/puzzleCalibrationData.ts");
}

process.exit(0);
