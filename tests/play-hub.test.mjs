// tests/play-hub.test.mjs
//
// THE SIX-MODE PLAY HUB CONTRACT.
//
// Verifies the hub has exactly six cards in the required order, every card and
// lobby points at a real experience, navigation sends Play to /play, the ranked
// lobby no longer offers bots, the daily/unlimited puzzles reuse the existing
// server-enforced system, and free /stats is blurred + locked while Pro loads
// the entitlement-gated coaching report.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { APP_TEXT_TRANSLATIONS } from "../src/lib/appTextTranslations.js";
import { PLAY_HUB_TRANSLATIONS } from "../src/lib/playHubTranslations.js";

const ROOT = process.cwd();
const read = (relative) =>
  fs.readFileSync(path.join(ROOT, relative), "utf8").replace(/\r\n/g, "\n");
const exists = (relative) => fs.existsSync(path.join(ROOT, relative));

const HUB = "src/components/play/PlayHub.tsx";
const NAV = "src/components/navigation-bar.jsx";
const RANKED_LOBBY = "src/components/solitaire-duel/SolitaireLobby.tsx";
const PUZZLE_ROUTE = "src/app/api/solitaire/puzzle/route.ts";
const ALLOWANCE = "src/lib/solitaire-duel/puzzleAllowance.ts";
const STATS_CLIENT = "src/components/stats/SolitaireAcademyStats.tsx";

const MODES = [
  ["solo", "/play/solo"],
  ["daily", "/play/daily"],
  ["ai", "/play/ai"],
  ["ranked", "/play/ranked"],
  ["dailyPuzzle", "/play/daily-puzzle"],
  ["unlimited", "/play/unlimited-puzzles"],
];

// ── Play hub ──────────────────────────────────────────────────────────────

test("the Play hub renders exactly six mode cards in order", () => {
  const source = read(HUB);
  const ids = [...source.matchAll(/data-testid=\{`play-mode-\$\{mode\.id\}`\}/g)];
  assert.equal(ids.length, 1, "cards are rendered from one list, not hand-copied");
  assert.match(source, /const MODES: readonly Mode\[\] = \[/);

  const order = [...source.matchAll(/id: "(solo|daily|ai|ranked|dailyPuzzle|unlimited)"/g)];
  assert.deepEqual(
    order.map((match) => match[1]),
    ["solo", "daily", "ai", "ranked", "dailyPuzzle", "unlimited"],
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
    "src/app/play/daily-puzzle/page.tsx",
    "src/app/play/unlimited-puzzles/page.tsx",
    "src/app/play/daily-puzzle/play/page.tsx",
    "src/app/play/unlimited-puzzles/play/page.tsx",
  ]) {
    assert.ok(exists(route), `${route} must exist`);
  }

  for (const lobby of ["solo", "daily", "dailyPuzzle", "unlimited"]) {
    assert.match(read(`src/app/play/${lobby === "dailyPuzzle" ? "daily-puzzle" : lobby === "unlimited" ? "unlimited-puzzles" : lobby}/page.tsx`), /ModeLobby/);
  }
  // AI and ranked reuse the existing implementations, never a copy.
  assert.match(read("src/app/play/ai/page.tsx"), /solitaire-duel\/play-ai\/PageClient/);
  assert.match(read("src/app/play/ranked/page.tsx"), /SolitaireLobby/);
});

test("hub CTA labels come from all three locales", () => {
  const languages = ["en", "fr", "es"];
  const keys = [];
  for (const [id] of MODES) {
    for (const suffix of ["title", "description", "meta", "cta", "tag"]) {
      keys.push(`cards.${id}.${suffix}`);
    }
  }
  for (const mode of ["solo", "daily", "dailyPuzzle", "unlimited"]) {
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

  const arrays = [...nav.matchAll(/\["\/", "\/play", "\/learn", "\/classement", "\/games\/solitaire-duel", "\/upgrade-pro"\]/g)];
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

test("the new puzzle lobbies reuse the server-authoritative puzzle system", () => {
  const route = read(PUZZLE_ROUTE);
  assert.match(route, /onConflictDoNothing/);
  assert.match(route, /consumePuzzleAllowance/);
  assert.match(route, /alreadyPlayed/);
  // The answer and the position after it travel ONLY once a move is recorded.
  assert.match(route, /answerMove: attempt \? puzzle\.answer : null/);
  assert.match(route, /solution: attempt \? puzzle\.answerBoard : null/);
  // A submitted move is engine-validated before it is judged or recorded.
  assert.match(route, /applyMove\(\{ state: puzzle\.state, move \}\)/);
  assert.match(route, /verifyPuzzleMove/);
  assert.match(route, /status: 429/);
  assert.match(route, /PUZZLE_LIMIT_REACHED/);

  const allowance = read(ALLOWANCE);
  assert.match(allowance, /FREE_PUZZLES_PER_DAY = 5/);
  assert.match(allowance, /on conflict \("user_id", "day_key"\)/);
  assert.match(allowance, /"used" < \$\{limit\}/);

  assert.match(read("src/app/play/daily-puzzle/play/page.tsx"), /SolitairePuzzle kind="daily"/);
  assert.match(read("src/app/play/unlimited-puzzles/play/page.tsx"), /SolitairePuzzle kind="unlimited"/);
  assert.match(read("src/components/play/LobbyStatus.tsx"), /\/api\/solitaire\/puzzle\?kind=/);
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
