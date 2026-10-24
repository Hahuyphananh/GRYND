/**
 * hillstrike-platform.test.mjs
 *
 * Hillstrike's PLATFORM registration — every GRYND surface that has to know the
 * game exists, and the guarantees that make that safe. The rules engine and the
 * physics live in tests/hillstrike-rules.test.mjs / -physics.test.mjs; the store,
 * routes, UI and fairness in their own files. This file is about the SEAMS:
 *
 *   * discovery — one canonical id (`hillstrike`) across the lobby catalogue, the
 *     recommendation tags, the card art, the presence map, the rating registry,
 *     the trophy registry and the quick queue;
 *   * the public page — /games/hillstrike is the landing page, it is in the
 *     sitemap through the generated inventory, the lobby is the noindex
 *     /games/hillstrike/play, and the free practice board is excluded;
 *   * copy — the lobby card's name and description exist in every locale;
 *   * settlement — the ONLY rated writer is the online store's own transaction,
 *     spelled as the literal `gameKey: "hillstrike"`, and free practice has no
 *     path to it;
 *   * the no-economy guarantee — no stake column, no wager catalogue entry, no
 *     escrow or payout reference.
 *
 * It asserts against the REAL modules rather than re-declared lists, so dropping
 * Hillstrike from any surface fails here instead of in production.
 *
 * Run:  npm run test:hillstrike
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const { GAME_CATALOG, GAMES_BY_ID, supportsTokenWager } = await import("../src/lib/gameTags.js");
const { PRESENCE_GAME_IDS, isCanonicalGameId, isPresenceGame, resolveGameId } = await import(
  "../src/lib/gamePresence.js"
);
const { RATED_GAMES, isRatedGame, getRatingGameLabel } = await import("../src/lib/rating.js");
const { TROPHY_GAMES, getTrophyGameLabel, isTrophyGame } = await import("../src/lib/trophies.js");
const { WAGER_GAME_KEYS } = await import("../src/lib/defaultWagers.js");
const { GAME_LANDING_BY_SLUG, GAME_LANDING_SLUGS, gameLandingPath, gamePlayPath } = await import(
  "../src/lib/gameLandingPages.ts"
);
const { PUBLIC_SEO_PATHS, EXCLUDED_FROM_SITEMAP } = await import("../src/lib/seoPages.ts");
const { QUICK_QUEUE_GAME_KEYS } = await import("../src/lib/quickQueue.ts");
const { quickQueueGameRoute, QUICK_QUEUE_GAME_OPTIONS } = await import(
  "../src/components/lobby/PlatformQuickQueue.jsx"
);
const { APP_TEXT_TRANSLATIONS } = await import("../src/lib/appTextTranslations.js");

const read = (rel) => fs.readFileSync(path.join(process.cwd(), rel), "utf8").replace(/\r\n/g, "\n");
/** Source with comments removed, so a file's own prose cannot satisfy — or trip
 *  — a check about what the CODE does. */
const code = (rel) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const KEY = "hillstrike";
const LOBBY_PAGE = "src/app/casino/hillstrike/page.tsx";
const LOBBY_CLIENT = "src/app/casino/hillstrike/PageClient.tsx";
const MATCH_CLIENT = "src/app/casino/hillstrike/[matchId]/PageClient.tsx";
const PRACTICE_CLIENT = "src/app/casino/hillstrike/play-ai/PageClient.tsx";
const PRACTICE_PAGE = "src/app/casino/hillstrike/play-ai/page.tsx";
const STORE = "src/lib/hillstrike/serverStore.ts";

/** Every locale the app ships, derived from the translation table itself. */
const LOCALES = Object.keys(APP_TEXT_TRANSLATIONS);

// ── 1. One id, everywhere ─────────────────────────────────────────────────

test("registry: the catalogue has exactly one Hillstrike, linked to its public page", () => {
  const entries = GAME_CATALOG.filter((game) => game.id === KEY);
  assert.equal(entries.length, 1, "the game must appear in GAME_CATALOG exactly once");
  assert.equal(entries[0].href, "/games/hillstrike");
  assert.ok(entries[0].tags.includes("pvp"), "every GRYND game is a 1v1 duel");
  assert.ok(entries[0].tags.includes("skill"), "the outcome is decided by aiming ability");
  // Nothing is drawn during play: the battlefield is seeded once and identical
  // for both seats, so the game must never be tagged as luck.
  assert.equal(entries[0].tags.includes("chance"), false);
  assert.equal(GAMES_BY_ID[KEY], entries[0]);
});

test("lobby: the hub renders a card with the game's own id, route and art", () => {
  const lobby = read("src/app/casino/PageClient.jsx");
  assert.match(lobby, /leaderboardKey: "hillstrike",/);
  assert.match(lobby, /href: "\/games\/hillstrike",/);
  assert.match(lobby, /image: GAME_CARD_ART\["hillstrike"\],/);
  assert.match(lobby, /nameKey: "games\.hillstrike_name",/);
  assert.match(lobby, /descriptionKey: "games\.hillstrike_desc",/);
  assert.match(lobby, /pvpMode: "1v1",/);
  // The artwork is registered in the ONE card-art registry, keyed by slug.
  const art = read("src/components/games/gameCardArt.js");
  assert.match(art, /import hillstrikeArt from "\.\.\/\.\.\/images\/hillstrike-card\.svg";/);
  assert.match(art, /hillstrike: hillstrikeArt,/);
  assert.ok(fs.existsSync("src/images/hillstrike-card.svg"));
});

test("copy: the lobby card is translated in every shipped locale", () => {
  for (const locale of LOCALES) {
    const games = APP_TEXT_TRANSLATIONS[locale]?.games;
    assert.ok(games, `${locale} has no games block`);
    assert.equal(typeof games.hillstrike_name, "string", `${locale}: name`);
    assert.ok(games.hillstrike_name.trim().length > 0, `${locale}: name is empty`);
    assert.equal(typeof games.hillstrike_desc, "string", `${locale}: description`);
    assert.ok(games.hillstrike_desc.trim().length > 40, `${locale}: description is a stub`);
  }
});

// ── 2. Presence ───────────────────────────────────────────────────────────

test("presence: the canonical id resolves and unknown neighbours do not", () => {
  assert.ok(PRESENCE_GAME_IDS.includes(KEY));
  assert.equal(isPresenceGame(KEY), true);
  assert.equal(isCanonicalGameId(KEY), true);
  assert.equal(resolveGameId(KEY), KEY);
  // Free practice is browser-only and sends no presence beat at all (its own
  // contract forbids network calls), so there is deliberately no `-ai` label.
  // Unknown neighbours must not resolve.
  assert.equal(resolveGameId("hillstrike-ai"), null);
  assert.equal(resolveGameId("hillstrike-online"), null);
  assert.equal(resolveGameId("hill-strike"), null);
  // The match page beats through the shared host with real lifecycle signals.
  const match = read(MATCH_CLIENT);
  assert.match(match, /<GameSessionHost\b/);
  assert.match(match, /gameLabel="hillstrike"/);
  assert.doesNotMatch(match, /useActiveGamePresence|sendPresenceBeat/);
});

// ── 3. Competitive settlement ─────────────────────────────────────────────

test("rated: Hillstrike is in the one rated registry, and its trophies follow it", () => {
  assert.ok(RATED_GAMES.includes(KEY));
  assert.equal(isRatedGame(KEY), true);
  assert.equal(getRatingGameLabel(KEY), "Hillstrike");
  assert.ok(TROPHY_GAMES.includes(KEY));
  assert.equal(isTrophyGame(KEY), true);
  assert.equal(getTrophyGameLabel(KEY), "Hillstrike");
});

test("settlement: exactly one site writes Elo and trophies, with the literal key", () => {
  // The platform's wiring audits scan sources for `gameKey: "<key>"`; an
  // indirected key would be invisible, so the literal is the contract.
  const sites = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx|js|jsx|mjs)$/.test(entry.name)) {
        if (read(full).includes('gameKey: "hillstrike"')) {
          sites.push(full.split(path.sep).join("/").replace(/^\.\//, ""));
        }
      }
    }
  };
  walk("src");
  assert.deepEqual(sites, [STORE], "only the online store may settle Hillstrike");

  const store = read(STORE);
  assert.equal((store.match(/gameKey: "hillstrike",/g) ?? []).length, 2, "Elo + trophies");
  assert.equal((store.match(/await applyRatingResult\(\{/g) ?? []).length, 1);
  assert.equal((store.match(/await applyTrophyResult\(\{/g) ?? []).length, 1);
  // Best-effort: a progression failure must never un-finish a decided match.
  assert.match(store, /\}\)\.catch\(\(\) => \{\}\);/);
  // A lobby with no opponent is not a result.
  assert.match(store, /if \(!match\.player2Id\) return;/);
});

test("practice: the free board cannot touch a rating, a trophy or the server", () => {
  for (const file of [PRACTICE_CLIENT, PRACTICE_PAGE]) {
    const src = read(file);
    assert.doesNotMatch(
      src,
      /hillstrike\/serverStore|\/api\/hillstrike|applyRatingResult|applyTrophyResult/,
      `${file} must not reach a settlement path`,
    );
  }
});

// ── 4. Public page, SEO and routing ───────────────────────────────────────

test("public page: the landing entry is a real catalogue entry for this game", () => {
  const page = GAME_LANDING_BY_SLUG[KEY];
  assert.ok(page, "the public landing page entry must exist");
  assert.equal(page.leaderboardKey, KEY);
  assert.equal(gameLandingPath(KEY), "/games/hillstrike");
  assert.equal(gamePlayPath(KEY), "/games/hillstrike/play");
  assert.ok(GAME_LANDING_SLUGS.includes(KEY));
  // The landing copy must describe the rules the engine actually enforces.
  const copy = [...page.introduction, ...page.howToPlay, ...page.rules].join(" ");
  assert.match(copy, /three lives/i);
  assert.match(copy, /direct hit/i);
  assert.match(copy, /opening shot|single shot/i);
  // Wagering is retired: nothing may claim a stake is at play.
  assert.doesNotMatch(copy, /\bwagered\b(?!.*\bno\b)/i);
});

test("seo: the landing page is listed, the lobby and practice board are not", () => {
  assert.ok(PUBLIC_SEO_PATHS.includes("/games/hillstrike"));
  assert.equal(PUBLIC_SEO_PATHS.includes("/games/hillstrike/play"), false);
  assert.equal(PUBLIC_SEO_PATHS.includes("/casino/hillstrike/play-ai"), false);
  assert.ok(
    EXCLUDED_FROM_SITEMAP["/casino/hillstrike/play-ai"],
    "the practice board needs a stated reason for its exclusion",
  );
  // The lobby is noindex and canonical to its play URL; the landing page is the
  // indexable one.
  const lobby = read(LOBBY_PAGE);
  assert.match(lobby, /canonical: "\/games\/hillstrike\/play"/);
  assert.match(lobby, /robots:\s*\{\s*index:\s*false,\s*follow:\s*true\s*\}/);
});

test("routing: both URL prefixes are game routes, so a guest is handled uniformly", () => {
  const proxy = read("src/proxy.ts");
  assert.ok(proxy.includes('"/casino/hillstrike(.*)"'));
  assert.ok(proxy.includes('"/games/hillstrike(.*)"'));
});

// ── 5. Matchmaking ────────────────────────────────────────────────────────

test("quick queue: Hillstrike is a destination that routes to its own matchmaking", () => {
  assert.ok(QUICK_QUEUE_GAME_KEYS.includes(KEY));
  assert.equal(
    QUICK_QUEUE_GAME_KEYS.filter((key) => key === KEY).length,
    1,
    "the key must not be duplicated in the queue vocabulary",
  );
  const worker = read("src/lib/quickQueueWorker.ts");
  assert.match(
    worker,
    /import \{ createOrJoin as createOrJoinHillstrikeMatch \} from "\.\/hillstrike\/serverStore"/,
  );
  // Unstaked: the queue's stake envelope is never passed to the game, and both
  // paired seats are seated by the same `createOrJoin`.
  assert.match(worker, /"hillstrike": \(userId\) => createOrJoinHillstrikeMatch\(\{ userId \}\)/);

  const ui = read("src/components/lobby/PlatformQuickQueue.jsx");
  assert.match(ui, /\["hillstrike", "Hillstrike"\]/);
  assert.match(ui, /hillstrike: "\/casino\/hillstrike"/);
  assert.ok(QUICK_QUEUE_GAME_OPTIONS.some(([key]) => key === KEY));
  assert.equal(quickQueueGameRoute(KEY, "abc-123"), "/casino/hillstrike/abc-123");
  assert.equal(quickQueueGameRoute(KEY, ""), null);

  // The destination is the game's OWN store, and both seats land on one id.
  const store = read(STORE);
  assert.match(store, /export async function createOrJoin\(\{ userId \}/);
  assert.match(store, /return \{ match: updated, joined: true \} as const;/);
});

// ── 6. No economy ─────────────────────────────────────────────────────────

test("no economy: no wager catalogue entry, no stake column, no payout path", () => {
  assert.equal(WAGER_GAME_KEYS.includes(KEY), false);
  assert.equal(supportsTokenWager(KEY), false);
  const lobby = code(LOBBY_CLIENT);
  assert.doesNotMatch(lobby, /stakeAmount|wager=|requireStake|escrow/i);
  // The migration declares the absence, and creates no money column.
  const migration = read("src/db/migrations/0229_hillstrike_pvp.sql");
  assert.doesNotMatch(migration, /^\s*(wager|stake|pot|payout|prize|coin)\w*\s+/im);
});
