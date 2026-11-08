#!/usr/bin/env node
// qa/chess-ai-standalone-check.mjs
//
// Plays the standalone chess app the way a player does: clicks e2 then e4 on the
// real board, waits for Stockfish's reply, takes the move back, resigns, and
// starts another game — with every https/wss request blocked.
//
// It is run against a built folder (`dist/portal/chess-ai` by default) and is
// reused by the itch verifier against the EXTRACTED archive, so the thing tested
// is the thing that ships.
//
// Usage:
//   node qa/chess-ai-standalone-check.mjs
//   node qa/chess-ai-standalone-check.mjs --dir=dist/packages/.verify-extract
//   node qa/chess-ai-standalone-check.mjs --keep-open   # leave Chrome running (debug)

import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Chess } from "chess.js";

import { sleep, withBrowserPage } from "../standalone/chess-ai/scripts/lib/browser.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const found = argv.find((entry) => entry.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
};

const DIR = resolve(ROOT, option("dir", "dist/portal/chess-ai"));
assert.ok(existsSync(join(DIR, "index.html")), `no index.html in ${DIR}`);

const problems = [];
const check = (condition, message) => {
  if (!condition) problems.push(message);
};

const report = { dir: DIR, checks: [], problems: [] };
const note = (message) => {
  report.checks.push(message);
  console.log(`  ok    ${message}`);
};

/** Click a board square by its own element (`data-square` is set per square). */
const clickSquare = (page, square) =>
  page.evaluate(`(() => {
    const el = document.querySelector('[data-square="${square}"]');
    if (!el) return false;
    el.click();
    return true;
  })()`);

const clickAction = (page, action) =>
  page.evaluate(`(() => {
    const button = document.querySelector('[data-action="${action}"]');
    if (!button) return false;
    button.click();
    return true;
  })()`);

await withBrowserPage(DIR, async ({ base, page }) => {
  // The board is ~700 px tall; a default 600 px headless viewport would put its
  // lower half off-screen.
  await page.send("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.send("Network.setBlockedURLs", { urls: ["https://*", "wss://*"] });
  await page.navigate(`${base}/index.html`);
  await page.until(
    "the board",
    "document.querySelector('[data-testid=\"board\"]') !== null",
    20_000
  );
  await page.until(
    "the engine to boot",
    "window.__CHESS_STATE__ && window.__CHESS_STATE__.engineReady === true",
    40_000
  );
  note("board rendered and the engine booted");

  const start = await page.evaluate("window.__CHESS_STATE__");
  check(start.status === "playing", `expected a fresh game, got ${start.status}`);
  check(start.history.length === 0, "a fresh game already has moves");
  check(start.humanColor === "white", `expected White by default, got ${start.humanColor}`);
  check(start.engineError === null, `engine error at boot: ${start.engineError}`);

  // ── e2e4 ────────────────────────────────────────────────────────────────
  check(await clickSquare(page, "e2"), "could not click e2");
  await page.until("the e2 pick", "window.__CHESS_STATE__.selected === 'e2'", 5_000);
  check(await clickSquare(page, "e4"), "could not click e4");
  await page.until("the human move", "window.__CHESS_STATE__.history.length >= 1", 5_000);
  note("click-to-move played e2–e4");

  // ── the AI replies ──────────────────────────────────────────────────────
  await page.until(
    "Stockfish's reply",
    "window.__CHESS_STATE__.history.length === 2 && window.__CHESS_STATE__.thinking === false",
    40_000
  );
  note("Stockfish answered as Black");

  const afterReply = await page.evaluate("window.__CHESS_STATE__");
  const replay = new Chess();
  let legal = true;
  for (const move of afterReply.history) {
    try {
      replay.move({
        from: move.uci.slice(0, 2),
        to: move.uci.slice(2, 4),
        promotion: move.uci.length > 4 ? move.uci.slice(4) : undefined,
      });
    } catch {
      legal = false;
    }
    if (replay.fen() !== move.fenAfter) legal = false;
  }
  check(legal, "the played moves do not replay legally from the start position");
  check(replay.fen() === afterReply.fen, "the board does not match the replayed history");
  check(
    afterReply.isHumanTurn,
    `expected White's turn after the reply, got ${afterReply.sideToMove}`
  );
  note("both moves replay legally and the board matches the history");

  // ── undo ────────────────────────────────────────────────────────────────
  check(await clickAction(page, "undo"), "no undo button");
  await page.until("the undo", "window.__CHESS_STATE__.history.length === 0", 5_000);
  const afterUndo = await page.evaluate("window.__CHESS_STATE__");
  check(
    afterUndo.fen === "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    "undo did not restore the starting position"
  );
  note("undo took back the whole pair");

  // ── resign -> result -> play again ──────────────────────────────────────
  check(await clickAction(page, "resign"), "no resign button");
  await page.until(
    "the result overlay",
    "document.querySelector('[data-testid=\"result\"]') !== null",
    5_000
  );
  const result = await page.evaluate(`(() => {
    const overlay = document.querySelector('[data-testid="result"]');
    return {
      outcome: overlay?.getAttribute("data-result"),
      title: overlay?.querySelector("h2")?.textContent,
      state: window.__CHESS_STATE__,
    };
  })()`);
  check(result.outcome === "loss", `resigning should be a loss, got ${result.outcome}`);
  check(result.title === "You lose", `unexpected result title: ${result.title}`);
  check(result.state.status === "finished", "the match did not finish on resign");
  check(result.state.reason === "resign", `unexpected end reason: ${result.state.reason}`);
  note("resign ended the game and showed the result screen");

  check(await clickAction(page, "play-again"), "no play-again button");
  await page.until(
    "the new game",
    "window.__CHESS_STATE__.status === 'playing' && window.__CHESS_STATE__.history.length === 0",
    5_000
  );
  check(
    await page.evaluate("document.querySelector('[data-testid=\"result\"]') === null"),
    "the result overlay survived the new game"
  );
  note("play again started a clean game");

  // ── offline + clean console ─────────────────────────────────────────────
  await sleep(500);
  // `data:` is an inline image (the board library's transparent GIF), not a
  // network request; only http(s) URLs can leave the package.
  const foreign = page.requests.filter((url) => /^https?:/i.test(url) && !url.startsWith(base));
  check(foreign.length === 0, `requests left the package origin: ${foreign.join(", ")}`);
  check(page.consoleErrors.length === 0, `console errors: ${page.consoleErrors.join(" | ")}`);
  if (foreign.length === 0) note("no request left the package origin (https/wss blocked)");
  if (page.consoleErrors.length === 0) note("no console errors");
});

// A click that hit the wrong square is a UI bug; a failure here is worth the
// extra context.
mkdirSync(join(ROOT, "dist/qa"), { recursive: true });
writeFileSync(
  join(ROOT, "dist/qa/chess-ai-app.json"),
  JSON.stringify({ ...report, problems }, null, 2)
);

console.log("\nChess AI — standalone app QA (offline browser)");
console.log("-".repeat(70));
if (problems.length === 0) {
  console.log("PASS  the built game plays, undoes, resigns and restarts offline");
} else {
  for (const problem of problems) console.log(`FAIL  ${problem}`);
  console.log(`\nFAILED — ${problems.length} problem(s)`);
}
console.log(`report        dist/qa/chess-ai-app.json\n`);

process.exit(problems.length === 0 ? 0 : 1);
