// tests/play-hub.test.mjs
//
// THE PLAY HUB CONTRACT.
//
// Verifies the hub has exactly six cards in the required order, every card and
// lobby points at a real experience, navigation sends Play to /play, the ranked
// lobby no longer offers bots, the daily puzzle uses the multi-step
// server-enforced system, and free /stats is blurred + locked while Pro loads
// the entitlement-gated coaching report.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { APP_TEXT_TRANSLATIONS } from "../src/lib/appTextTranslations.js";
import { PLAY_HUB_TRANSLATIONS } from "../src/lib/playHubTranslations.js";
import { PLAY_MODE_GROUPS, PLAY_MODE_PALETTE } from "../src/lib/playModePalette.ts";

const ROOT = process.cwd();
const read = (relative) =>
  fs.readFileSync(path.join(ROOT, relative), "utf8").replace(/\r\n/g, "\n");
const exists = (relative) => fs.existsSync(path.join(ROOT, relative));

const HUB = "src/components/play/PlayHub.tsx";
const NAV = "src/components/navigation-bar.jsx";
const RANKED_LOBBY = "src/components/solitaire-duel/SolitaireLobby.tsx";
const PUZZLE_ROUTE = "src/app/api/solitaire/puzzle/route.ts";
const STATS_CLIENT = "src/components/stats/SolitaireAcademyStats.tsx";

// Solo and Daily open the standalone surfaces that own their intent; the other
// six open their own lobby. `/play/solo` and `/play/daily` 308 to these.
const MODES = [
  ["solo", "/solitaire"],
  ["daily", "/daily"],
  ["ai", "/play/ai"],
  ["ranked", "/play/ranked"],
  ["puzzleRanked", "/play/puzzle-ranked"],
  ["puzzleAi", "/play/puzzle-ai"],
  ["dailyPuzzle", "/play/daily-puzzle"],
  ["unlimited", "/play/unlimited-puzzles"],
];

// ── Play hub ──────────────────────────────────────────────────────────────

test("every mode card has its own accent colour", () => {
  const accents = Object.values(PLAY_MODE_PALETTE).map((palette) =>
    palette.accent.toLowerCase(),
  );
  assert.equal(new Set(accents).size, accents.length, "two modes share an accent");
});

test("the Play hub renders exactly eight mode cards in order", () => {
  const source = read(HUB);
  const ids = [...source.matchAll(/data-testid=\{`play-mode-\$\{mode\.id\}`\}/g)];
  assert.equal(ids.length, 1, "cards are rendered from one list, not hand-copied");
  assert.match(source, /const MODES: readonly Mode\[\] = \[/);

  const order = [
    ...source.matchAll(
      /id: "(solo|daily|ai|ranked|puzzleRanked|puzzleAi|dailyPuzzle|unlimited)"/g,
    ),
  ];
  assert.deepEqual(
    order.map((match) => match[1]),
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

  for (const [id, href] of MODES) {
    assert.match(
      source,
      new RegExp(`id: "${id}",\\s*href: "${href.replace(/\//g, "\\/")}"`),
      `${id} must link to ${href}`,
    );
  }
  assert.doesNotMatch(source, /aria-disabled|<button[^>]*disabled/i);
});

test("every mode has a dedicated, real lobby route", () => {
  for (const route of [
    "src/app/play/page.tsx",
    "src/app/play/solo/page.tsx",
    "src/app/play/daily/page.tsx",
    "src/app/play/ai/page.tsx",
    "src/app/play/ranked/page.tsx",
    "src/app/play/puzzle-ranked/page.tsx",
    "src/app/play/puzzle-ai/page.tsx",
    "src/app/play/daily-puzzle/page.tsx",
    "src/app/play/daily-puzzle/play/page.tsx",
    "src/app/play/unlimited-puzzles/page.tsx",
    "src/app/play/unlimited-puzzles/play/page.tsx",
  ]) {
    assert.ok(exists(route), `${route} must exist`);
  }

  for (const lobby of ["solo", "daily", "dailyPuzzle", "unlimited"]) {
    const folder =
      lobby === "dailyPuzzle" ? "daily-puzzle" : lobby === "unlimited" ? "unlimited-puzzles" : lobby;
    assert.match(read(`src/app/play/${folder}/page.tsx`), /ModeLobby/);
  }
  // AI and ranked reuse the existing implementations, never a copy.
  assert.match(read("src/app/play/ai/page.tsx"), /solitaire-duel\/play-ai\/PageClient/);
  assert.match(read("src/app/play/ranked/page.tsx"), /SolitaireLobby/);

  // The two puzzle modes are dedicated routes with dedicated clients.
  assert.match(read("src/app/play/puzzle-ranked/page.tsx"), /PuzzleRankedLobby/);
  assert.match(read("src/app/play/puzzle-ai/page.tsx"), /PuzzleAiLobby/);
  assert.match(read("src/components/play/PuzzleRankedLobby.tsx"), /\/api\/solitaire-puzzle\/queue/);
  assert.match(read("src/components/play/PuzzleAiLobby.tsx"), /\/api\/solitaire-puzzle\/ai/);
});

test("Ranked is one row of two equal cards, and never crosses modes", () => {
  const source = read(HUB);
  // The Ranked group is exactly the regular mode and the puzzle mode, two up.
  assert.deepEqual(
    PLAY_MODE_GROUPS.find((group) => group.id === "ranked")?.modes,
    ["ranked", "puzzleRanked"],
  );
  assert.deepEqual(
    PLAY_MODE_GROUPS.find((group) => group.id === "practice")?.modes,
    ["ai", "puzzleAi"],
  );
  // Ranked (and the other zones) are two-up; Practice takes three columns so
  // the strategic library is its third card in the same row.
  assert.match(
    source,
    /group\.id === "practice"[\s\S]{0,80}sm:grid-cols-2 lg:grid-cols-3/,
  );
  assert.match(source, /data-testid="play-mode-strategic"/);
  assert.match(source, /href="\/play\/strategic-puzzles"/);
  assert.match(source, /id: "puzzleRanked", href: "\/play\/puzzle-ranked", group: "ranked"/);
  assert.match(source, /id: "ranked", href: "\/play\/ranked", group: "ranked"/);
  // No card spans the whole row any more: both take 50% on desktop.
  assert.doesNotMatch(source, /featured|col-span-3/);
  // The puzzle modes are practice, not replacements for the library.
  assert.match(source, /id: "puzzleAi", href: "\/play\/puzzle-ai", group: "practice"/);
  assert.match(source, /\/play\/strategic-puzzles/);
  // The Puzzle Ranked client can never send the player to regular Ranked.
  assert.doesNotMatch(read("src/components/play/PuzzleRankedLobby.tsx"), /\/play\/ranked/);
  // The existing regular Vs AI card is untouched.
  assert.match(source, /id: "ai", href: "\/play\/ai", group: "practice"/);
});

test("hub CTA labels come from all three locales", () => {
  const languages = ["en", "fr", "es"];
  const keys = [];
  for (const [id] of MODES) {
    for (const suffix of ["title", "description", "meta", "cta", "tag"]) {
      keys.push(`cards.${id}.${suffix}`);
    }
  }
  for (const suffix of ["title", "description", "meta", "cta", "tag"]) {
    keys.push(`cards.strategic.${suffix}`);
  }
  for (const mode of [
    "solo",
    "daily",
    "dailyPuzzle",
    "unlimited",
    "puzzleRanked",
    "puzzleAi",
  ]) {
    keys.push(`lobby.${mode}.title`, `lobby.${mode}.description`, `lobby.${mode}.cta`, `lobby.${mode}.note`);
  }
  keys.push("title", "description", "back", "loading", "unavailable");

  for (const language of languages) {
    const bundle = PLAY_HUB_TRANSLATIONS[language];
    assert.ok(bundle, language);
    for (const key of keys) {
      const value = key.split(".").reduce((entry, part) => entry?.[part], bundle);
      assert.equal(typeof value, "string", `${language} missing ${key}`);
      assert.ok(value.trim().length > 0, `${language} empty ${key}`);
    }
    assert.equal(APP_TEXT_TRANSLATIONS[language].playHub, bundle);
  }
});

// ── Navigation ────────────────────────────────────────────────────────────

test("Play is one nav destination on desktop and mobile", () => {
  const nav = read(NAV);
  assert.match(nav, /function navLabel/);
  assert.match(nav, /if \(path === "\/play"\) return "Play"/);
  assert.match(nav, /function isPathActive/);
  assert.match(nav, /currentPath\.startsWith\("\/play\/"\)/);
  assert.match(nav, /isPathActive\(path, currentPath\)/);

  const arrays = [...nav.matchAll(/\["\/", "\/play", "\/learn", "\/classement", "\/contact", "\/games\/solitaire-duel", "\/upgrade-pro"\]/g)];
  assert.equal(arrays.length, 2, "desktop and mobile share the same destinations");
  assert.equal((nav.match(/aria-current=\{isPathActive/g) ?? []).length, 1);

  // Solo and Daily are no longer separate navbar items.
  assert.doesNotMatch(nav, /"\/solitaire"/);
  assert.doesNotMatch(nav, /"\/daily"/);
  // Essential navigation survives.
  for (const path of ['"/learn"', '"/classement"', '"/upgrade-pro"', '"/games/solitaire-duel"']) {
    assert.ok(nav.includes(path), path);
  }
});

// ── Ranked is humans only ─────────────────────────────────────────────────

test("the ranked lobby no longer offers Play vs Bots", () => {
  const lobby = read(RANKED_LOBBY);
  assert.doesNotMatch(lobby, /Play vs Bots|solitaire-play-bots|IconRobot/);
  assert.doesNotMatch(lobby, /extraActions/);
  assert.match(lobby, /real human players/);
  assert.doesNotMatch(lobby, /create-ai/);
  // The AI system itself is untouched and still reachable.
  assert.ok(exists("src/app/casino/solitaire-duel/play-ai/page.tsx"));
  assert.ok(exists("src/app/play/ai/page.tsx"));
});

test("existing routes remain available for bookmarks", () => {
  for (const route of [
    "src/app/solitaire/page.tsx",
    "src/app/daily/page.tsx",
    "src/app/casino/solitaire-duel/page.tsx",
    "src/app/casino/solitaire-duel/play-ai/page.tsx",
    "src/app/solitaire/review/[kind]/[gameId]/page.tsx",
    "src/app/stats/page.tsx",
  ]) {
    assert.ok(exists(route), route);
  }
});

// ── Daily and unlimited puzzles reuse the enforced system ──────────────────

test("the daily puzzle uses the ordered multi-step server system", () => {
  const route = read(PUZZLE_ROUTE);
  assert.match(route, /getDailyPuzzleSteps/);
  assert.match(route, /dailyPuzzleStepFromKey/);
  assert.match(route, /PUZZLE_STEP_LOCKED/);
  assert.match(route, /totalSteps/);
  assert.match(route, /nextStep/);
  assert.match(route, /onConflictDoNothing/);
  assert.match(route, /alreadyPlayed/);
  // The answer and the position after it travel ONLY once a move is recorded.
  assert.match(route, /answerMove: attempt \? puzzle\.answer : null/);
  assert.match(route, /solution: attempt \? puzzle\.answerBoard : null/);
  // A submitted move is engine-validated before it is judged or recorded.
  assert.match(route, /applyMove\(\{ state: puzzle\.state, move \}\)/);
  assert.match(route, /verifyPuzzleMove/);
  assert.match(route, /status: 409/);

  assert.match(read("src/app/play/daily-puzzle/play/page.tsx"), /SolitairePuzzle kind="daily"/);
  assert.match(read("src/components/play/LobbyStatus.tsx"), /\/api\/solitaire\/puzzle\?kind=/);
});

test("the unlimited card and lobby show today's remaining puzzles", () => {
  // The hub card reads the server's allowance, from a read-only endpoint that
  // does NOT build a position, and never invents a number.
  assert.match(read(HUB), /PuzzleAllowanceBadge/);
  const badge = read("src/components/play/PuzzleAllowanceBadge.tsx");
  assert.match(badge, /\/api\/solitaire\/puzzle\?kind=unlimited&allowanceOnly=1/);
  assert.match(badge, /remaining/);
  assert.match(badge, /if \(failed\) return null/);

  // The lobby prints the same live figures.
  const lobby = read("src/components/play/LobbyStatus.tsx");
  assert.match(lobby, /allowanceOnly=1/);
  assert.match(lobby, /lobby\.unlimited\.remaining/);

  // And the counts exist in all three locales.
  for (const language of ["en", "fr", "es"]) {
    const card = PLAY_HUB_TRANSLATIONS[language].cards.unlimited;
    assert.equal(typeof card.remaining, "string", `${language} needs a remaining count`);
    assert.equal(typeof card.pro, "string", `${language} needs the PRO label`);
  }
});

// ── Stats: Pro analytics + blurred free lock ──────────────────────────────

test("free stats are blurred behind a lock and Pro loads coaching", () => {
  const source = read(STATS_CLIENT);
  assert.match(source, /\/api\/learn\/coaching/);
  assert.match(source, /stats-solitaire-blurred/);
  assert.match(source, /stats-solitaire-lock/);
  assert.match(source, /blur-\[5px\]/);
  assert.match(source, /IconLock/);
  assert.match(source, /\/upgrade-pro/);
  assert.match(source, /signedIn \? "\/upgrade-pro" : "\/sign-in"/);
  assert.match(source, /coachingSnapshotFromLocal/);
  assert.doesNotMatch(source, /isPro\s*=\s*true/);

  const statsPage = read("src/app/stats/PageClient.tsx");
  assert.match(statsPage, /SolitaireAcademyStats/);
  assert.match(statsPage, /<PerformanceDashboard/);

  const locked = read("src/components/stats/ProAnalyticsLocked.tsx");
  assert.match(locked, /blur-\[5px\]/);
  assert.match(locked, /IconLock/);
});

test("the Play hub is the only new navigation entry, not a game duplicate", () => {
  assert.ok(exists("src/app/play/page.tsx"));
  assert.doesNotMatch(read("src/app/play/page.tsx"), /fetch\(|api\//);
  assert.doesNotMatch(read(HUB), /fetch\(/);
});
