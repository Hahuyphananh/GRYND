#!/usr/bin/env node
// standalone/chess-ai/scripts/check-selfplay.mjs
//
// Phase 2 gate, re-run against the QA harness: plays a whole game with the REAL
// engine in headless Chrome, every move re-validated by chess.js, https/wss
// blocked. `hard` (White) vs `easy` (Black) is the default.
//
// Usage:
//   node standalone/chess-ai/scripts/check-selfplay.mjs
//   node standalone/chess-ai/scripts/check-selfplay.mjs --dir=dist/chess-ai-harness
//   node standalone/chess-ai/scripts/check-selfplay.mjs --white=medium --black=hard --plies=40
//
// Exit 0 = a legal game reached a terminal position (checkmate in the default
// pairing; the assertion below says which endings are accepted).

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
const WHITE = option("white", "hard");
const BLACK = option("black", "easy");
const MAX_PLIES = Number(option("plies", "300"));
const SKIP_BUILD = argv.includes("--no-build");

if (!SKIP_BUILD) {
  await build({ configFile: join(APP, "vite.config.harness.mts"), logLevel: "warn" });
}
assert.ok(existsSync(join(OUT, "harness.html")), `no harness.html in ${OUT}`);

let payload = null;
let failure = null;

try {
  await withBrowserPage(OUT, async ({ base, page }) => {
    await page.send("Network.setBlockedURLs", { urls: ["https://*", "wss://*"] });
    await page.navigate(`${base}/harness.html?white=${WHITE}&black=${BLACK}&maxPlies=${MAX_PLIES}`);
    payload = await page.until(
      "the self-play game to finish",
      "window.__SELFPLAY__ && window.__SELFPLAY__.running === false ? window.__SELFPLAY__ : null",
      240_000
    );

    const failures = [];
    assert.equal(payload.ok, true, `self-play failed in the page: ${payload.error ?? "unknown"}`);
    const report = payload.report;

    if (report.stalled) failures.push("the engine stopped producing moves before the game ended");
    if (report.moves.length !== report.plies)
      failures.push("the move log does not match the ply count");
    if (report.plies < 20)
      failures.push(`the game was too short to be meaningful (${report.plies} plies)`);
    if (
      !report.moves.every(
        (move) =>
          typeof move.san === "string" &&
          move.san.length > 0 &&
          /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move.uci)
      )
    ) {
      failures.push("a recorded move is malformed");
    }
    if (report.termination !== "checkmate") {
      failures.push(`expected checkmate, got ${report.termination}`);
    }
    if (payload.whiteTier !== WHITE || payload.blackTier !== BLACK) {
      failures.push(
        `the page played ${payload.whiteTier}/${payload.blackTier}, not ${WHITE}/${BLACK}`
      );
    }
    if (page.consoleErrors.length > 0) {
      failures.push(`console errors: ${page.consoleErrors.join(" | ")}`);
    }
    const foreign = page.requests.filter((url) => !url.startsWith(base));
    if (foreign.length > 0) failures.push(`requests left the page origin: ${foreign.join(", ")}`);

    const outDir = join(ROOT, "dist/qa");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(
      join(outDir, "chess-ai-selfplay.json"),
      JSON.stringify({ failures, consoleErrors: page.consoleErrors, payload }, null, 2)
    );

    console.log("\nChess AI — full self-play (real engine, real browser)");
    console.log("-".repeat(70));
    console.log(
      `result        ${report.termination ?? "unfinished"} — winner ${report.winner ?? "none"}`
    );
    console.log(`tiers         ${payload.whiteTier} (White) vs ${payload.blackTier} (Black)`);
    console.log(`plies         ${report.plies}`);
    console.log(`duration      ${(report.durationMs / 1000).toFixed(1)} s`);
    console.log(
      `last moves    ${report.moves
        .slice(-6)
        .map((move) => move.san)
        .join(" ")}`
    );
    const unique = new Set(report.moves.map((move) => move.uci));
    console.log(`unique moves  ${unique.size} / ${report.moves.length}`);
    if (failures.length > 0) {
      console.log("-".repeat(70));
      for (const item of failures) console.log(`FAIL  ${item}`);
    }
    console.log("-".repeat(70));
    console.log(
      failures.length === 0
        ? "PASS  a complete legal game reached checkmate"
        : `FAILED  ${failures.length} problem(s)`
    );
    if (failures.length > 0) process.exitCode = 1;
  });
} catch (error) {
  failure = error;
}

if (failure) {
  console.error(`\nFAIL  ${failure.message}\n`);
  process.exit(1);
}
