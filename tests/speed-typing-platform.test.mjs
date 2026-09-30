/**
 * speed-typing-platform.test.mjs
 *
 * Speed Typing's PLATFORM registration — the surfaces that are neither game
 * rules nor competitive settlement (those live in
 * tests/speed-typing-competitive.test.mjs):
 *
 *   * game discovery / registry — it appears in the canonical catalog and the
 *     casino lobby, in the same position, with tags, exactly once;
 *   * active-game presence — its gameLabel resolves to a canonical id and the
 *     match page feeds the shared host with REAL lifecycle signals, so the
 *     "N playing" badge can count it honestly from day one;
 *   * navigation — Games → Speed Typing → Lobby → Match, using only the
 *     existing routes and the existing shared lobby chrome;
 *   * metadata — page title + a description that states the format
 *     (1v1 · same passage · first to finish · no wagers);
 *   * ad conventions — the lobby page carries the script; the match page does
 *     not;
 *   * the no-economy guarantee — nothing in the game's own surfaces can move a
 *     token, a balance or a payout.
 *
 * It deliberately asserts against the REAL sources and the REAL modules — no
 * re-declared game lists — so a future refactor that drops Speed Typing from
 * any of these surfaces fails here rather than in production.
 *
 * Run:  node --import tsx --test tests/speed-typing-platform.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const { GAME_CATALOG, DEFAULT_GAME_ORDER, GAMES_BY_ID } = await import(
  "../src/lib/gameTags.js"
);
const { PRESENCE_GAME_IDS, isCanonicalGameId, isPresenceGame, resolveGameId } =
  await import("../src/lib/gamePresence.js");
const { recommendGames } = await import("../src/lib/gameRecommendations.js");
const { RATED_GAMES } = await import("../src/lib/rating.js");

const read = (rel) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");
const strip = (src) => src.replace(/\r\n/g, "\n");
/** Source with comments removed, so the files' own prose about the (absent)
 *  economy can never be mistaken for an economy reference. */
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
const code = (rel) => stripComments(strip(read(rel)));

const LOBBY = "src/app/casino/PageClient.jsx";
const LOBBY_PAGE = "src/app/casino/speed-typing/PageClient.tsx";
const MATCH_PAGE = "src/app/casino/speed-typing/[matchId]/PageClient.tsx";
const PAGE = "src/app/casino/speed-typing/page.tsx";
const MATCH_PAGE_ROUTE = "src/app/casino/speed-typing/[matchId]/page.tsx";
const CREATE_ROUTE = "src/app/api/speed-typing/create-or-join/route.ts";
const FETCH_ROUTE = "src/app/api/speed-typing/match/[matchId]/route.ts";
const SITEMAP = "src/app/sitemap.ts";
const TRANSLATIONS = "src/lib/appTextTranslations.js";
const PRESENCE = "src/lib/gamePresence.js";

const KEY = "speed-typing";

// ── 1. Game discovery / registry ─────────────────────────────────────────

test("discovery: speed-typing is in the canonical catalog with the lobby's href", () => {
  const entry = GAME_CATALOG.find((game) => game.id === KEY);
  assert.ok(entry, "speed-typing must be in GAME_CATALOG");
  assert.equal(entry.href, "/casino/speed-typing");
  assert.ok(entry.tags.includes("pvp"), "Speed Typing is a 1v1 duel → pvp");
  assert.ok(entry.tags.includes("skill"), "the outcome turns on ability → skill");
  assert.ok(
    entry.tags.includes("fast_paced"),
    "a race decided by typing speed is fast_paced",
  );
  assert.ok(!entry.tags.includes("chance"), "nothing is drawn during play");
  assert.ok(!entry.tags.includes("multiplayer"), "Speed Typing is strictly 2-player");
  // Exactly one entry — a duplicate would corrupt the fallback order.
  assert.equal(GAME_CATALOG.filter((game) => game.id === KEY).length, 1);
  assert.ok(DEFAULT_GAME_ORDER.includes(KEY));
  assert.equal(GAMES_BY_ID[KEY]?.href, "/casino/speed-typing");
});

test("discovery: the catalog and the lobby agree on Speed Typing's position", () => {
  const lobbyIds = [...strip(read(LOBBY)).matchAll(/leaderboardKey: "([^"]+)"/g)].map(
    (m) => m[1],
  );
  assert.equal(GAME_CATALOG.length, lobbyIds.length, "catalog/lobby length mismatch");
  assert.deepEqual(
    GAME_CATALOG.map((game) => game.id),
    lobbyIds,
    "the catalog must mirror the lobby's featured order",
  );
  // New games are APPENDED to the end of the lobby, so Speed Typing sits after
  // Mini Golf and before any title that shipped later — asserted relatively, so
  // a newer card does not falsify the append-at-the-end rule.
  assert.ok(
    lobbyIds.indexOf(KEY) > lobbyIds.indexOf("mini-golf"),
    "Speed Typing is appended after Mini Golf",
  );
});

test("discovery: the lobby card links to the lobby, records plays and is 1v1", () => {
  const src = strip(read(LOBBY));
  const card = src.slice(src.indexOf('name: "Speed Typing"'));
  assert.match(card, /href: "\/casino\/speed-typing"/);
  assert.match(card, /leaderboardKey: "speed-typing"/);
  assert.match(card, /playsKey: "speed-typing"/);
  assert.match(card, /pvpMode: "1v1"/);
  assert.match(card, /descriptionKey: "games.speed_typing_desc"/);
  assert.match(card, /nameKey: "games.speed_typing_name"/);
  // The card art is shipped art, not a shared fallback.
  assert.match(src, /import ImgSpeedTyping from "\.\.\/\.\.\/images\/speed-typing-card\.svg"/);
  // The "Newest" sort is newest-first: a title shipped later may precede it,
  // but Speed Typing must sit directly behind it.
  assert.match(src, /const newestOrder = \[\n\s*"tic-tac-toe",\n\s*"speed-typing",/);
});

test("discovery: personalization always returns Speed Typing (never hidden)", () => {
  const ranked = recommendGames({ game_types: ["pvp_duels"] }).recommendations.map(
    (game) => game.id,
  );
  assert.ok(ranked.includes(KEY));
  assert.equal(ranked.length, GAME_CATALOG.length);
});

test("discovery: the game is in the sitemap under its canonical /games path", () => {
  const src = strip(read(SITEMAP));
  assert.match(src, /speedTypingMatches,/);
  assert.match(
    src,
    /\{ path: "\/games\/speed-typing", source: \[speedTypingMatches, speedTypingMatches\.createdAt\] \}/,
  );
});

// ── 2. Active-game presence ──────────────────────────────────────────────

test("presence: the speed-typing gameLabel resolves to the canonical id", () => {
  assert.ok(PRESENCE_GAME_IDS.includes(KEY), "canonical id must come from GAME_CATALOG");
  assert.equal(resolveGameId(KEY), KEY);
  assert.equal(resolveGameId("  SPEED-TYPING  "), KEY, "labels are normalized");
  assert.equal(isPresenceGame(KEY), true);
  assert.equal(isCanonicalGameId(KEY), true);
  // The label map is the game's own label, so a heartbeat can never be sent
  // under an unknown name.
  assert.match(strip(read(PRESENCE)), /"speed-typing": "speed-typing",/);
});

test("presence: the match page reports through the shared host with real signals", () => {
  const src = strip(read(MATCH_PAGE));
  assert.match(src, /<GameSessionHost\b/);
  assert.match(src, /gameLabel="speed-typing"/);
  // A waiting lobby is not yet a game, and a terminal match must stop counting.
  assert.match(src, /autoStart=\{match\?\.status === "playing"\}/);
  assert.match(src, /autoStop=\{finished\}/);
  // The page must not beat presence itself.
  assert.doesNotMatch(src, /useActiveGamePresence|sendPresenceBeat/);
});

test("presence: the game's label is the canonical id, so no alias can drift", () => {
  // Unlike chess/uno, Speed Typing has exactly ONE play surface, so its label
  // set has no AI alias to collapse.
  const map = strip(read(PRESENCE));
  const aliases = [...map.matchAll(/"?([a-z0-9-]+)"?:\s*"speed-typing"/g)].map((m) => m[1]);
  assert.deepEqual(aliases, [KEY]);
});

// ── 3. Navigation: Games → Lobby → Match ─────────────────────────────────

test("navigation: the lobby entry route renders the Speed Typing lobby client", () => {
  const page = strip(read(PAGE));
  assert.match(page, /import PageClient from "\.\/PageClient"/);
  assert.match(page, /<PageClient \/>/);

  const lobby = strip(read(LOBBY_PAGE));
  assert.match(lobby, /\/api\/speed-typing\/create-or-join/);
  assert.match(lobby, /router\.push\(`\/casino\/speed-typing\/\$\{data\.data\.matchId\}`\)/);
  // It reuses the ONE shared lobby chrome rather than growing a new one.
  assert.match(lobby, /import PvpLobbyPage from "\.\.\/\.\.\/\.\.\/components\/lobby\/PvpLobby"/);
  assert.match(lobby, /<PvpLobbyPage/);
  assert.match(lobby, /rulesKey="speed-typing"/);
});

test("navigation: the match route renders the match client, ad-free", () => {
  const page = strip(read(MATCH_PAGE_ROUTE));
  assert.match(page, /import PageClient from "\.\/PageClient"/);
  assert.match(page, /return <PageClient \/>;/);
  assert.doesNotMatch(page, /AdSense|AdSlot/);
});

test("navigation: the lobby and match routes talk to the ONE matchmaking store", () => {
  const create = strip(read(CREATE_ROUTE));
  assert.match(create, /import \{ createOrJoin \} from "\.\.\/\.\.\/\.\.\/\.\.\/lib\/speed-typing\/serverStore"/);
  assert.match(create, /await createOrJoin\(\{ userId \}\)/);
  // The caller's id comes from the verified session, never from the request.
  assert.match(create, /requireAgeVerifiedUser/);
  assert.doesNotMatch(create, /body|searchParams/);

  const fetchRoute = strip(read(FETCH_ROUTE));
  assert.match(fetchRoute, /fetchMatch/);
  assert.match(fetchRoute, /isMatchId/);
  assert.match(fetchRoute, /requireAgeVerifiedUser/);
});

test("navigation: the match page reads the authoritative snapshot", () => {
  const src = strip(read(MATCH_PAGE));
  assert.match(src, /\/api\/speed-typing\/match\/\$\{matchId\}/);
  assert.match(src, /data-testid="speed-typing-match"/);
  assert.match(src, /data-status=\{match\.status\}/);
});

// ── 4. Metadata ──────────────────────────────────────────────────────────

test("metadata: the page title and description state the format", () => {
  const src = strip(read(PAGE));
  assert.match(src, /title: "Speed Typing \| GRYND"/);
  const description = /description:\s*"([^"]+)"/.exec(src)?.[1] ?? "";
  for (const trait of [/1v1/, /exact same passage/, /first to finish/i, /no wagers/i, /no randomness/i]) {
    assert.match(description, trait, `metadata description must mention ${trait}`);
  }
});

test("metadata: the lobby card copy also carries the format in every locale", () => {
  const src = strip(read(TRANSLATIONS));

  const nameLines = src.split("\n").filter((line) => line.includes("speed_typing_name:"));
  assert.equal(nameLines.length, 3, "speed_typing_name must exist for en/fr/es");
  for (const line of nameLines) {
    assert.match(line, /speed_typing_name: "Speed Typing"/);
  }

  const descLines = src.split("\n").filter((line) => line.includes("speed_typing_desc:"));
  assert.equal(descLines.length, 3, "speed_typing_desc must exist for en/fr/es");
  // Each locale states the format in its own words: 1v1, the identical text for
  // both players, and the first to finish correctly winning.
  const formatPerLocale = [
    [/1v1/, /exact same passage/, /first to finish/i],
    [/1v1/, /exactement le même texte/, /premier à le terminer/i],
    [/1v1/, /exactamente el mismo texto/, /primero en completarlo/i],
  ];
  descLines.forEach((line, index) => {
    for (const trait of formatPerLocale[index]) {
      assert.match(line, trait, `locale ${index} description must mention ${trait}`);
    }
  });
});

// ── 5. Ad convention ─────────────────────────────────────────────────────

test("ads: the lobby page carries the ad script, the match page carries none", () => {
  const page = strip(read(PAGE));
  assert.equal((page.match(/<AdSenseScript\s*\/>/g) ?? []).length, 1);
  assert.match(page, /import AdSenseScript from "\.\.\/\.\.\/\.\.\/components\/AdSenseScript"/);
  assert.doesNotMatch(strip(read(MATCH_PAGE)), /AdSense|AdSlot/);
});

// ── 6. The no-economy guarantee ──────────────────────────────────────────

test("economy: the server surfaces never reference an economy field", () => {
  // The two routes and the store are CODE — no marketing prose to confuse the
  // scan — so they can be held to the strict rule: a game with no wagers has no
  // business naming a balance, a payout, a stake or a prize.
  for (const file of [CREATE_ROUTE, FETCH_ROUTE, "src/lib/speed-typing/serverStore.ts"]) {
    const src = code(file);
    for (const forbidden of [
      /balance/i,
      /payout/i,
      /wager/i,
      /stake/i,
      /prizePaid|prize_paid/i,
      /houseFee|house_fee/i,
      /tokenTransactions|token_transactions/i,
    ]) {
      assert.doesNotMatch(src, forbidden, `${file} must not touch the economy (${forbidden})`);
    }
  }
});

test("economy: the UI never calls an economy endpoint or reads an economy field", () => {
  // The pages legitimately SAY "no wagers" in their rules copy, so this looks at
  // what the code touches rather than at the words on the screen.
  for (const file of [PAGE, LOBBY_PAGE, MATCH_PAGE, MATCH_PAGE_ROUTE]) {
    const src = strip(read(file));
    assert.doesNotMatch(
      src,
      /fetch\(\s*["'`][^"'`]*(token|balance|payout|wager|stake)/i,
      `${file} must not call an economy endpoint`,
    );
    assert.doesNotMatch(
      src,
      /\b(betAmount|stakeAmount|prizePaid|houseFee|newBalance)\b/,
      `${file} must not read an economy field`,
    );
  }
});

test("economy: the game is not a wager game and has no wager catalog entry", async () => {
  const { supportsTokenWager } = await import("../src/lib/gameTags.js");
  const { WAGER_GAME_KEYS } = await import("../src/lib/defaultWagers.js");
  assert.equal(supportsTokenWager(KEY), false);
  assert.equal(WAGER_GAME_KEYS.includes(KEY), false);
});

test("economy: the game is registered as a rated game and nothing else", () => {
  assert.ok(RATED_GAMES.includes(KEY));
  // Rating is the ONLY competitive register it joins: no leaderboard-specific
  // game list, no trophy-specific list.
  assert.ok(!read("src/lib/trophies.js").includes('"speed-typing"'));
  assert.ok(!read("src/app/api/leaderboard/game/route.js").includes("speed-typing"));
});
