// tests/play-routes.test.mjs
//
// THE PLAY HUB LINK CONTRACT.
//
// Every one of the eight mode cards must point at a distinct, real route, and
// that route must resolve to a Play page module with a default export. This is
// the static half of "open every card and check the route loads": it pins the
// hrefs and the route/module wiring so a renamed folder or a dead link fails
// here instead of in the browser.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const read = (relative) =>
  fs.readFileSync(path.join(ROOT, relative), "utf8").replace(/\r\n/g, "\n");
const exists = (relative) => fs.existsSync(path.join(ROOT, relative));

const HUB = "src/components/play/PlayHub.tsx";
const source = read(HUB);

const MODES = [
  ...source.matchAll(
    /\{ id: "(solo|daily|ai|ranked|puzzleRanked|puzzleAi|dailyPuzzle|unlimited)", href: "([^"]+)", group: "(ranked|practice|casual|puzzle)" \}/g,
  ),
].map((match) => ({ id: match[1], href: match[2], group: match[3] }));

/** `/play/ai` → src/app/play/ai/page.tsx; `/solitaire` → src/app/solitaire/page.tsx. */
const pageFile = (href) => `src/app${href}/page.tsx`;

test("the hub exposes exactly eight mode links", () => {
  assert.equal(MODES.length, 8);
  assert.deepEqual(
    MODES.map((mode) => mode.id),
    [
      "solo",
      "daily",
      "ai",
      "ranked",
      "puzzleRanked",
      "puzzleAi",
      "dailyPuzzle",
      "unlimited",
    ],
  );
});

test("no two cards share a route, and no route is empty or relative", () => {
  const hrefs = MODES.map((mode) => mode.href);
  assert.equal(new Set(hrefs).size, hrefs.length, "every mode has its own route");
  for (const href of hrefs) {
    assert.match(href, /^\/[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)*$/, href);
  }
});

test("each of the eight links resolves to a real page that loads", () => {
  for (const mode of MODES) {
    const file = pageFile(mode.href);
    assert.ok(exists(file), `${mode.id} (${mode.href}) is missing ${file}`);
    const page = read(file);
    assert.match(
      page,
      /export default (async )?function/,
      `${file} must export a page component`,
    );
    // A page that returns nothing is not a route that loads.
    assert.match(page, /return[\s\S]{0,800}</, `${file} must render something`);
  }

  // The two puzzle lobbies must open their own clients, never each other.
  assert.match(read(pageFile("/play/puzzle-ranked")), /PuzzleRankedLobby/);
  assert.match(read(pageFile("/play/puzzle-ai")), /PuzzleAiLobby/);
  assert.doesNotMatch(read(pageFile("/play/puzzle-ranked")), /PuzzleAiLobby/);
  assert.doesNotMatch(read(pageFile("/play/puzzle-ai")), /PuzzleRankedLobby/);

  // Solitaire Ranked and the regular Vs AI keep their shipped implementations.
  assert.match(read(pageFile("/play/ranked")), /SolitaireLobby/);
  assert.match(read(pageFile("/play/ai")), /solitaire-duel\/play-ai\/PageClient/);
});

test("the strategic library is a third Practice card with a live route", () => {
  assert.ok(exists(pageFile("/play/strategic-puzzles")));
  const page = read(pageFile("/play/strategic-puzzles"));
  assert.match(page, /StrategicPuzzlePlayer/);
  assert.match(page, /puzzleLibraryPuzzles/);
  assert.match(page, /export default function/);

  // The card sits inside the practice grid, after the two mode cards.
  assert.match(source, /data-testid="play-mode-strategic"/);
  assert.match(source, /href="\/play\/strategic-puzzles"/);
  assert.match(
    source,
    /group\.id === "practice"[\s\S]{0,80}sm:grid-cols-2 lg:grid-cols-3/,
  );
  assert.match(source, /\{group\.id === "practice" && libraryCard\}/);

  // It is not one of the eight mode entries: it is an extra practice surface.
  assert.ok(!MODES.some((mode) => mode.href === "/play/strategic-puzzles"));
});

test("the two new routes are not aliases of an existing lobby", () => {
  const files = MODES.map((mode) => pageFile(mode.href));
  assert.equal(new Set(files).size, files.length, "each mode maps to its own page file");
});
