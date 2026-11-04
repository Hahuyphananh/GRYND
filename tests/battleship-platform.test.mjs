// tests/battleship-platform.test.mjs
//
// PHASE 7 — Battleship registered as a first-class GRYND game.
//
// The catalogue, the card art, the public landing page, the rating/trophy
// registry, the Quick Queue, presence, the ranking filter and the copy all have
// to name the game with ONE canonical id (`battleship`). These assertions are
// source/registry contracts, which is the only way to prove the registries
// actually agree without rendering the app.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { GAME_CATALOG, GAMES_BY_ID } from "../src/lib/gameTags.js";
import {
  GAME_CARDS,
  GAME_INDEX,
  GAME_LANDING_BY_SLUG,
  GAME_LANDING_PAGES,
} from "../src/lib/gameLandingPages.ts";
import { resolveGameId } from "../src/lib/gamePresence.js";

const read = (file) => fs.readFileSync(path.join(process.cwd(), file), "utf8");
const code = (file) =>
  read(file)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

const KEY = "battleship";
const LOBBY = "src/app/casino/PageClient.jsx";

test("the lobby catalogue and the tag catalog agree, in the same order, with Battleship present", () => {
  // Read the `games` literal itself (the raw file), not the whole module: the
  // cards are the source of truth and comments elsewhere must not be counted.
  const lobbySource = read(LOBBY);
  const arrayStart = lobbySource.indexOf("const games = [");
  const arrayEnd = lobbySource.indexOf("\n  ];", arrayStart);
  const lobbyIds = [
    ...lobbySource.slice(arrayStart, arrayEnd).matchAll(/leaderboardKey: "([^"]+)"/g),
  ].map((m) => m[1]);
  assert.equal(GAME_CATALOG.length, lobbyIds.length, "catalog/lobby length mismatch");
  assert.deepEqual(GAME_CATALOG.map((game) => game.id), lobbyIds);
  assert.ok(lobbyIds.includes(KEY), "Battleship must be in the lobby catalogue");

  const entry = GAMES_BY_ID[KEY];
  assert.ok(entry, "Battleship must be tagged");
  assert.equal(entry.href, "/games/battleship", "public page slug is canonical");
  assert.deepEqual([...entry.tags].sort(), ["competitive", "pvp", "skill", "strategy"]);
  assert.equal(entry.tags.includes("chance"), false, "nothing is rolled during play");
});

test("the lobby card points at the shared card-art registry", () => {
  const lobby = read(LOBBY);
  const body = lobby.slice(lobby.indexOf(`name: "Battleship"`), lobby.indexOf(`name: "Battleship"`) + 400);
  assert.match(body, /href: "\/games\/battleship"/);
  assert.match(body, /leaderboardKey: "battleship"/);
  assert.match(body, /playsKey: "battleship"/);
  assert.match(body, /image: GAME_CARD_ART\["battleship"\]/);
  assert.match(body, /nameKey: "games\.battleship_name"/);
  assert.match(body, /descriptionKey: "games\.battleship_desc"/);
  assert.match(body, /pvpMode: "1v1"/);

  // Newest first: the game just shipped leads the recency list and the NEW badge.
  assert.match(lobby, /const newestOrder = \[[\s\S]{0,160}"battleship"/);
});

test("the card-art registry carries the geometric illustration and it exists on disk", () => {
  const registry = code("src/components/games/gameCardArt.js");
  assert.match(registry, /import battleshipArt from "\.\.\/\.\.\/images\/battleship-card\.svg"/);
  assert.match(registry, /battleship: battleshipArt,/);

  const art = "src/images/battleship-card.svg";
  assert.ok(fs.existsSync(art), `${art} must exist`);
  const svg = read(art);
  assert.match(svg, /<svg/);
  // Geometric only: a navy ground, a grid, and blue blocks — no external image
  // and no photographic asset.
  assert.match(svg, /#030817|#061229/);
  assert.doesNotMatch(svg, /<image|href="https?:/i);
});

test("the public landing page exists and its rules match the shipped engine", () => {
  const page = GAME_LANDING_BY_SLUG[KEY];
  assert.ok(page, "Battleship must have a landing page");
  assert.equal(page.leaderboardKey, KEY);
  assert.equal(page.aiPractice, true, "free unrated practice is advertised");
  // No `practiceApi`: the practice entry route exists, but the landing page's
  // practice button follows the created match id to /games/<slug>/<id>, and
  // Battleship has no per-match URL — declaring it would ship a dead CTA.
  assert.equal(page.practiceApi, undefined);
  assert.equal(page.ogImage, "/images/battleship-card.svg");

  const rules = [...page.rules, ...page.howToPlay].join(" ");
  assert.match(rules, /14×10/, "the board size is stated");
  assert.match(rules, /Carrier 5, Battleship 4, Cruiser 3, Submarine 3, Frigate 3 and Destroyer 2/);
  assert.match(rules, /twenty cells/);
  assert.match(rules, /simultaneous/i);
  assert.match(rules, /15-second/);
  assert.match(rules, /60-second/);
  assert.match(rules, /miss/i);
  assert.match(rules, /sunk/i);
  assert.match(rules, /draw/i);

  // Every related slug is a real page, and the projections include the game.
  for (const slug of page.related) assert.ok(GAME_LANDING_BY_SLUG[slug], `${slug} missing`);
  assert.ok(GAME_CARDS.some((card) => card.slug === KEY));
  assert.ok(GAME_INDEX.some((entry) => entry.slug === KEY));
});

test("landing-page copy never claims anything is wagered", () => {
  const page = GAME_LANDING_BY_SLUG[KEY];
  const copy = [
    page.shortDescription,
    ...page.introduction,
    ...page.howToPlay,
    ...page.rules,
    ...page.scoring,
    ...page.strategy,
    page.competitive,
    ...page.faq.map((entry) => `${entry.q} ${entry.a}`),
  ].join(" ");
  // Any money word must be negated ("no wager", "no payout", …).
  const money = /\b(wager|wagered|wagering|bet|bets|betting|stake|stakes|staked|rake|payout|payouts)\b/gi;
  for (const match of copy.matchAll(money)) {
    const before = copy.slice(Math.max(0, match.index - 40), match.index);
    assert.match(before, /\b(no|not|never|nothing|without|cannot|isn't)\b/i, `unnegated: ${before}${match[0]}`);
  }
});

test("Battleship is in the ONE rating/trophy registry, settled by the shared writers", () => {
  const rating = code("src/lib/rating.js");
  const ratedBody = rating.slice(
    rating.indexOf("export const RATED_GAMES"),
    rating.indexOf("export const RATING_GAME_LABELS"),
  );
  assert.match(ratedBody, /"battleship"/, "RATED_GAMES must include battleship");
  assert.match(rating, /battleship: "Battleship"/, "the ladder label is registered");

  // Trophies reuse the same list (no second registry).
  const trophies = code("src/lib/trophies.js");
  assert.match(trophies, /RATED_GAMES/);

  const store = code("src/lib/battleship/serverStore.ts");
  assert.match(store, /import \{ applyRatingResult \} from "\.\.\/rating"/);
  assert.match(store, /import \{ applyTrophyResult \} from "\.\.\/trophyStore"/);
  assert.match(store, /gameKey: "battleship"/);
  assert.match(store, /gameKey: "battleship",[\s\S]{0,200}applyTrophyResult|applyTrophyResult\(\{[\s\S]{0,80}gameKey: "battleship"/);
  // Practice and lobbies can never settle.
  assert.match(store, /if \(row\.isAi \|\| !row\.player2Id\) return;/);
  // The account W/L counters use the same shared columns, and a draw touches
  // neither — the platform's own rule.
  assert.match(store, /gamesWon: sql`\$\{users\.gamesWon\} \+ 1`/);
  assert.match(store, /gamesLost: sql`\$\{users\.gamesLost\} \+ 1`/);
  assert.match(store, /if \(!draw\) \{/);
  // Settlement runs in the finalising transaction, not after it.
  assert.match(store, /settleRatedMatchTx\(tx, updated, winnerSeat\)/);
  assert.match(store, /settleRatedMatchTx\(tx, updated, null\)/);
  assert.match(store, /settleRatedMatchTx\(tx, updated, resolution\.state\.winner\)/);
});

test("matchmaking, Quick Queue, presence and the ranking filter all know the canonical id", () => {
  const queue = code("src/lib/quickQueue.ts");
  assert.match(queue, /"battleship"/);
  const worker = code("src/lib/quickQueueWorker.ts");
  assert.match(worker, /createOrJoin as createOrJoinBattleshipMatch \} from "\.\/battleship\/serverStore"/);
  assert.match(worker, /"battleship": \(userId\) => createOrJoinBattleshipMatch\(\{ userId \}\)/);

  assert.equal(resolveGameId("battleship"), "battleship");

  const classement = code("src/app/classement/PageClient.jsx");
  assert.match(classement, /\{ key: "battleship", label: "Battleship" \}/);
});

test("the lobby copy is registered in every shipped language", () => {
  const copy = code("src/lib/appTextTranslations.js");
  for (const locale of ["en", "fr", "es"]) {
    assert.ok(copy.includes("battleship_name:"), `${locale}: missing battleship_name`);
    assert.ok(copy.includes("battleship_desc:"), `${locale}: missing battleship_desc`);
  }
  assert.equal((copy.match(/battleship_name:/g) ?? []).length, 3);
  assert.equal((copy.match(/battleship_desc:/g) ?? []).length, 3);
});

test("the sitemap includes the public page with a database freshness hint", () => {
  const seo = code("src/lib/seoPages.ts");
  assert.match(seo, /battleshipMatches/);
  assert.match(seo, /battleship: \{ table: battleshipMatches, column: battleshipMatches\.createdAt \}/);
  // The game list is a projection of the landing catalogue, so the page is
  // listed without a per-game sitemap edit.
  assert.ok(GAME_LANDING_PAGES.some((page) => page.slug === KEY));
});

test("every pre-existing game is still listed after the registration", () => {
  const expected = ["chess", "dominoes", "hillstrike", "barricade", "mini-golf", "speed-typing"];
  for (const id of expected) {
    assert.ok(GAMES_BY_ID[id], `${id} disappeared from the catalogue`);
    assert.ok(GAME_CARDS.some((card) => card.leaderboardKey === id), `${id} lost its public page`);
  }
});
