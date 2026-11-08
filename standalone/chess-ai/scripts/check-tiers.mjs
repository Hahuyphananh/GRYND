#!/usr/bin/env node
// standalone/chess-ai/scripts/check-tiers.mjs
//
// Every difficulty pairing, played by the real engine: 3 tiers × 3 tiers.
//
// A tier bug is usually invisible in one game — a mis-set `Skill Level`, a
// MultiPV option that leaks between searches, a `movetime` that the wrong tier
// ignores. Playing each pairing for a fixed number of plies with every move
// re-validated by chess.js catches those that would otherwise only show up as
// "hard feels easy" in a review.
//
// Usage:
//   node standalone/chess-ai/scripts/check-tiers.mjs
//   node standalone/chess-ai/scripts/check-tiers.mjs --plies=24 --dir=dist/chess-ai-harness
//
// Exit 0 only when all nine pairings produced legal, non-stalled games that
// reported the tiers they were asked to play.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

import { withBrowserPage } from "./lib/browser.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const APP = resolve(HERE, "..");
const ROOT = resolve(APP, "../..");

const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const found = argv.find((entry) => entry.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
};

const OUT = resolve(ROOT, option("dir", "dist/chess-ai-harness"));
const MAX_PLIES = Math.max(8, Number(option("plies", "16")));
const SKIP_BUILD = argv.includes("--no-build");
const TIERS = ["easy", "medium", "hard"];

if (!SKIP_BUILD) {
  await build({ configFile: join(APP, "vite.config.harness.mts"), logLevel: "warn" });
}
assert.ok(existsSync(join(OUT, "harness.html")), `no harness.html in ${OUT}`);

const rows = [];
const failures = [];

await withBrowserPage(OUT, async ({ base, page }) => {
  await page.send("Network.setBlockedURLs", { urls: ["https://*", "wss://*"] });

  for (const white of TIERS) {
    for (const black of TIERS) {
      const label = `${white} vs ${black}`;
      const before = page.consoleErrors.length;
      const startedAt = Date.now();

      try {
        await page.navigate(
          `${base}/harness.html?white=${white}&black=${black}&maxPlies=${MAX_PLIES}&run=${Date.now()}`
        );
        const payload = await page.until(
          `the ${label} game`,
          `window.__SELFPLAY__ && window.__SELFPLAY__.running === false && window.__SELFPLAY__.whiteTier === "${white}" && window.__SELFPLAY__.blackTier === "${black}" ? window.__SELFPLAY__ : null`,
          180_000
        );

        const elapsed = Date.now() - startedAt;
        const report = payload.report;
        const problems = [];

        if (payload.ok !== true) problems.push(payload.error ?? "self-play failed");
        if (!report) problems.push("no report");
        else {
          if (report.stalled) problems.push("stalled before the ply limit");
          if (report.moves.length !== report.plies) problems.push("move log / ply count mismatch");
          if (report.plies < 4) problems.push(`only ${report.plies} plies`);
          if (report.plies > MAX_PLIES) problems.push(`${report.plies} plies exceeded the limit`);
          if (
            !report.moves.every(
              (move) => /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move.uci) && move.san.length > 0
            )
          ) {
            problems.push("a move is malformed");
          }
          // The engine's own settings must be the tier's. `easy` searches skill 0,
          // `hard` searches 20 — a leaked option shows up here.
          const expectedSkill = { easy: 0, medium: 8, hard: 20 };
          for (const move of report.moves) {
            const expected = move.color === "white" ? expectedSkill[white] : expectedSkill[black];
            if (move.settings?.skillLevel !== expected) {
              problems.push(
                `${move.color} played ${move.san} at Skill Level ${move.settings?.skillLevel}, expected ${expected}`
              );
              break;
            }
          }
        }
        const newErrors = page.consoleErrors.slice(before);
        if (newErrors.length > 0) problems.push(`console errors: ${newErrors.join(" | ")}`);

        rows.push({
          pairing: label,
          plies: report?.plies ?? 0,
          termination: report?.termination ?? "none",
          durationMs: elapsed,
          problems,
        });
        if (problems.length > 0) failures.push(`${label}: ${problems.join("; ")}`);
      } catch (error) {
        rows.push({
          pairing: label,
          plies: 0,
          termination: "timeout",
          durationMs: Date.now() - startedAt,
          problems: [error.message],
        });
        failures.push(`${label}: ${error.message}`);
      }
    }
  }
});

mkdirSync(join(ROOT, "dist/qa"), { recursive: true });
writeFileSync(
  join(ROOT, "dist/qa/chess-ai-tiers.json"),
  JSON.stringify({ plies: MAX_PLIES, failures, rows }, null, 2)
);

console.log(`\nChess AI — self-play across every difficulty pairing (${MAX_PLIES} plies each)`);
console.log("-".repeat(74));
console.log(
  "pairing".padEnd(20) +
    "plies".padStart(6) +
    "result".padStart(16) +
    "time".padStart(9) +
    "  check"
);
for (const row of rows) {
  const check = row.problems.length === 0 ? "ok" : "FAIL";
  console.log(
    row.pairing.padEnd(20) +
      String(row.plies).padStart(6) +
      String(row.termination).padStart(16) +
      `${(row.durationMs / 1000).toFixed(1)}s`.padStart(9) +
      `  ${check}`
  );
  for (const problem of row.problems) console.log(`  - ${problem}`);
}
console.log("-".repeat(74));
console.log(
  failures.length === 0
    ? `PASS  all ${rows.length} pairings played legal games and reported the requested tiers`
    : `FAILED  ${failures.length} pairing(s) had problems`
);
console.log(`report        ${join(ROOT, "dist/qa/chess-ai-tiers.json")}\n`);

process.exit(failures.length === 0 ? 0 : 1);
