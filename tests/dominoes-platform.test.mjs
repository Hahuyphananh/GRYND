/**
 * dominoes-platform.test.mjs
 *
 * Dominoes' PLATFORM registration — every GRYND system that has to know the
 * game exists, and the guarantees that make that safe. The rules engine lives in
 * tests/dominoes-rules.test.mjs, the online store, routes and UI in
 * tests/dominoes-store.test.mjs / -routes.test.mjs / -online-ui.test.mjs; this
 * file is about the SEAMS between the game and the platform:
 *
 *   * game discovery / registry — it appears in the canonical catalog and the
 *     casino lobby, appended once, with honest tags and real card art;
 *   * the public landing page — /games/dominoes exists, is in the sitemap, is
 *     served by the same shared component as every other game, and its lobby is
 *     reachable at /games/dominoes/play through the existing rewrite;
 *   * active-game presence — the canonical id resolves, and the match page feeds
 *     the shared host REAL lifecycle signals;
 *   * navigation and matchmaking — Games → Dominoes → Lobby → Match through the
 *     existing shared lobby chrome, plus the platform Quick Queue, whose
 *     destination is the game's own store;
 *   * competitive settlement — Dominoes is in the ONE rated-game registry, its
 *     store settles through the shared Elo/trophy writers inside the transaction
 *     that claimed the match, a blocked round is a DRAW, and cancelled /
 *     abandoned / non-existent matches are excluded by construction;
 *   * the no-economy guarantee — Dominoes has no stake column, no escrow and no
 *     payout path, and it is in no wager catalog;
 *   * no unrelated game is removed — Dice Flush stays retired and every other
 *     catalogue entry is still there.
 *
 * It asserts against the REAL sources and the REAL modules — no re-declared game
 * lists — so a future refactor that drops Dominoes from any of these surfaces
 * fails here rather than in production.
 *
 * Run:  npm run test:dominoes
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const { GAME_CATALOG, DEFAULT_GAME_ORDER, GAMES_BY_ID, supportsTokenWager } =
  await import("../src/lib/gameTags.js");
const { PRESENCE_GAME_IDS, isCanonicalGameId, isPresenceGame, resolveGameId } =
  await import("../src/lib/gamePresence.js");
const { recommendGames } = await import("../src/lib/gameRecommendations.js");
const { RATED_GAMES, isRatedGame, getRatingGameLabel, normalizeRatingGameKey } =
  await import("../src/lib/rating.js");
const { TROPHY_GAMES, getTrophyGameLabel, isTrophyGame } = await import(
  "../src/lib/trophies.js"
);
const { WAGER_GAME_KEYS } = await import("../src/lib/defaultWagers.js");
const { GAME_LANDING_BY_SLUG, GAME_LANDING_SLUGS, gameLandingPath, gamePlayPath } =
  await import("../src/lib/gameLandingPages.ts");
const { PUBLIC_SEO_PATHS } = await import("../src/lib/seoPages.ts");
const { QUICK_QUEUE_GAME_KEYS } = await import("../src/lib/quickQueue.ts");
const { normalizeQuickQueueReadiness } = await import("../src/lib/quickQueueReadiness.ts");
const { quickQueueGameRoute, QUICK_QUEUE_GAME_OPTIONS } = await import(
  "../src/components/lobby/PlatformQuickQueue.jsx"
);
const { ROOM_GAMES } = await import("../src/lib/rooms/catalog.ts");
const { dominoesMatches } = await import("../src/db/schema.ts");
const { APP_TEXT_TRANSLATIONS, t } = await import(
  "../src/lib/appTextTranslations.js"
);

const read = (rel) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");
const strip = (src) => src.replace(/\r\n/g, "\n");
/** Source with comments removed, so the files' own prose can never satisfy a
 *  check about what the CODE references. */
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
const code = (rel) => stripComments(strip(read(rel)));
const exists = (rel) => fs.existsSync(path.join(process.cwd(), rel));

const KEY = "dominoes";
/** The public page slug and the internal key are the SAME string for this game. */
const SLUG = "dominoes";

const LOBBY = "src/app/casino/PageClient.jsx";
const LOBBY_PAGE = "src/app/casino/dominoes/page.tsx";
const LOBBY_CLIENT = "src/app/casino/dominoes/PageClient.tsx";
const MATCH_PAGE = "src/app/casino/dominoes/[matchId]/page.tsx";
const MATCH_CLIENT = "src/app/casino/dominoes/[matchId]/PageClient.tsx";
const STORE = "src/lib/dominoes/serverStore.ts";
const MOVE_ROUTE = "src/app/api/dominoes/match/[matchId]/move/route.ts";
const CREATE_ROUTE = "src/app/api/dominoes/create-or-join/route.ts";

// ── 1. Game discovery / registry ──────────────────────────────────────────

test("discovery: dominoes is in the canonical catalog with the lobby's href", () => {
  const entry = GAME_CATALOG.find((game) => game.id === KEY);
  assert.ok(entry, "dominoes must be in GAME_CATALOG");
  assert.equal(entry.href, "/games/dominoes");
  assert.ok(entry.tags.includes("pvp"), "Dominoes is a 1v1 duel → pvp");
  assert.ok(entry.tags.includes("strategy"), "which end to feed decides it → strategy");
  assert.ok(entry.tags.includes("chance"), "the seven tiles you are dealt are chance");
  assert.ok(
    !entry.tags.includes("skill"),
    "chance and skill are mutually exclusive — the deal, not only ability, decides it",
  );
  assert.ok(entry.tags.includes("casual"), "the rules are commonly known → casual");
  assert.ok(entry.tags.includes("competitive"), "its results move a rated ladder");
  // Exactly one entry — a duplicate would corrupt the fallback order.
  assert.equal(GAME_CATALOG.filter((game) => game.id === KEY).length, 1);
  assert.ok(DEFAULT_GAME_ORDER.includes(KEY));
  assert.equal(GAMES_BY_ID[KEY]?.href, "/games/dominoes");
});

test("discovery: the catalog and the lobby agree on Dominoes' position", () => {
  const lobbyIds = [...strip(read(LOBBY)).matchAll(/leaderboardKey: "([^"]+)"/g)].map(
    (m) => m[1],
  );
  assert.equal(GAME_CATALOG.length, lobbyIds.length, "catalog/lobby length mismatch");
  assert.deepEqual(
    GAME_CATALOG.map((game) => game.id),
    lobbyIds,
    "the catalog must mirror the lobby's featured order — it IS the engine's fallback",
  );
  // New games are APPENDED, so Dominoes is last and after everything older.
  assert.equal(lobbyIds[lobbyIds.length - 1], KEY, "Dominoes is appended last");
  assert.ok(lobbyIds.indexOf(KEY) > lobbyIds.indexOf("barricade"));
  // …and it leads the "Newest" sort, because it is the newest game.
  const newestBlock = strip(read(LOBBY)).slice(
    strip(read(LOBBY)).indexOf("const newestOrder = ["),
  );
  const newestKeys = [
    ...newestBlock.slice(0, newestBlock.indexOf("];")).matchAll(/"([a-z0-9-]+)"/g),
  ].map((m) => m[1]);
  assert.equal(newestKeys[0], KEY, "Dominoes is the newest game");
});

test("discovery: the lobby card links to the game, records plays and is 1v1", () => {
  const src = strip(read(LOBBY));
  const at = src.indexOf('href: "/games/dominoes"');
  assert.ok(at > 0, "the lobby must carry a Dominoes card");
  const card = src.slice(at, at + 600);
  assert.match(card, /leaderboardKey: "dominoes"/);
  assert.match(card, /playsKey: "dominoes"/);
  assert.match(card, /pvpMode: "1v1"/);
  assert.match(card, /descriptionKey: "games\.dominoes_desc"/);
  assert.match(card, /nameKey: "games\.dominoes_name"/);
  // The card art is shipped art, looked up in the ONE shared registry, keyed by
  // the game's PUBLIC page slug.
  assert.match(card, /image: GAME_CARD_ART\["dominoes"\]/);
  assert.match(
    strip(read("src/components/games/gameCardArt.js")),
    /dominoes: dominoesArt,/,
  );
  assert.ok(exists("src/images/dominoes-card.svg"), "the card art must exist");
});

test("discovery: the card copy exists in all three locales", () => {
  const src = strip(read("src/lib/appTextTranslations.js"));
  for (const field of ["dominoes_name", "dominoes_desc"]) {
    const lines = src.split("\n").filter((line) => line.includes(`${field}:`));
    assert.equal(lines.length, 3, `${field} must exist for en/fr/es`);
  }
  // The English copy states the real format: free, 1v1, seven tiles and the
  // fifteen-second turn window.
  const en = src.indexOf('dominoes_desc: "');
  const copy = src.slice(en, src.indexOf("\n", en));
  for (const trait of [/free/i, /1v1/, /seven tiles/i, /fifteen seconds/i]) {
    assert.match(copy, trait, `the English card copy must mention ${trait}`);
  }
});

test("localisation: every string the screens use is a key in all three locales", () => {
  const LOCALES = ["en", "fr", "es"];
  const bundles = LOCALES.map(
    (locale) => APP_TEXT_TRANSLATIONS[locale]?.games?.dominoes ?? null,
  );
  bundles.forEach((bundle, index) => {
    assert.ok(bundle, `${LOCALES[index]} must carry a games.dominoes block`);
  });
  const enKeys = Object.keys(bundles[0]).sort();
  for (let index = 1; index < bundles.length; index += 1) {
    assert.deepEqual(
      Object.keys(bundles[index]).sort(),
      enKeys,
      `${LOCALES[index]} must translate every games.dominoes key`,
    );
  }
  // A real block, not a placeholder: the board, the lobby and the result screen
  // all draw from it.
  assert.ok(enKeys.length >= 100, `only ${enKeys.length} Dominoes keys`);

  // Every key the three screens name literally must resolve in every locale — a
  // missing key would surface as the raw key in the UI.
  const SCREENS = [
    "src/app/casino/dominoes/PageClient.tsx",
    "src/app/casino/dominoes/[matchId]/PageClient.tsx",
    "src/components/dominoes/DominoMatchView.tsx",
    "src/components/dominoes/DominoHand.tsx",
    "src/components/dominoes/DominoChain.tsx",
  ];
  const used = new Set();
  for (const file of SCREENS) {
    const source = code(file);
    assert.match(source, /useTranslation\(\)/, `${file} must translate its copy`);
    for (const match of source.matchAll(/["`]games\.dominoes\.([a-z0-9_]+)["`]/g)) {
      used.add(match[1]);
    }
    // The two families that are built at runtime (`status_<status>`, `turn_<state>`)
    // are named here instead, so a renamed or deleted member still fails.
    for (const key of [
      "status_waiting",
      "status_playing",
      "status_finished",
      "status_cancelled",
      "status_loading",
      "turn_waiting",
      "turn_cancelled",
      "turn_finished",
      "turn_loading",
      "turn_yours",
      "turn_theirs",
    ]) {
      used.add(key);
    }
  }
  assert.ok(used.size >= 70, `only ${used.size} Dominoes keys referenced`);
  for (const locale of LOCALES) {
    for (const key of used) {
      assert.equal(
        typeof bundles[LOCALES.indexOf(locale)][key],
        "string",
        `${locale} is missing games.dominoes.${key}`,
      );
    }
  }
  // The resolver the app actually calls agrees, and interpolates.
  assert.equal(t("en", "games.dominoes.tiles_count", { count: 3 }), "3 tiles");
  assert.equal(t("fr", "games.dominoes.tiles_count", { count: 3 }), "3 tuiles");
  assert.equal(t("es", "games.dominoes.tiles_count", { count: 3 }), "3 fichas");
  assert.equal(t("fr", "games.dominoes_name"), "Dominos");
  assert.equal(t("es", "games.dominoes_name"), "Dominó");

  // The English copy did not move when it became translatable: the sentences the
  // board shipped with are still what the bundle carries.
  assert.equal(
    bundles[0].turn_yours,
    "Your turn — play a tile, or draw if nothing fits.",
  );
  assert.equal(bundles[0].rules_summary, "How to play Dominoes");
  assert.equal(bundles[0].resign_title, "Resign this match?");

  // …and the hardcoded originals are gone from the screens.
  const screens = SCREENS.map((file) => stripComments(strip(read(file)))).join("\n");
  for (const literal of [
    "Your turn — play a tile",
    "How to play Dominoes",
    "Resign this match?",
    "Draw a tile — not available right now",
    "The chain is empty. Play any tile to open it.",
  ]) {
    assert.equal(
      screens.includes(literal),
      false,
      `the screens must not hardcode \"${literal}\"`,
    );
  }
});

test("discovery: personalization always returns Dominoes (never hidden)", () => {
  const ranked = recommendGames({ game_types: ["strategy"] }).recommendations.map(
    (game) => game.id,
  );
  assert.ok(ranked.includes(KEY));
  assert.equal(ranked.length, GAME_CATALOG.length);
});

// ── 2. The public landing page ────────────────────────────────────────────

test("landing: /games/dominoes exists with full content and its own leaderboard key", () => {
  const game = GAME_LANDING_BY_SLUG[SLUG];
  assert.ok(game, "the public landing page must exist");
  assert.equal(game.leaderboardKey, KEY, "the landing page names a real GAME_CATALOG id");
  assert.equal(gameLandingPath(SLUG), "/games/dominoes");
  // The landing page's Play CTA is the derived lobby URL every game uses.
  assert.equal(gamePlayPath(SLUG), "/games/dominoes/play");
  // The lobby ships a free, unrated practice board against the bot, so the
  // landing page advertises it.
  assert.equal(game.aiPractice, true);
  assert.ok(game.faq.length >= 3);
  assert.ok(game.related.length >= 3);
  for (const related of game.related) {
    assert.ok(GAME_LANDING_BY_SLUG[related], `unknown related slug ${related}`);
  }
  // The instructions really are Dominoes: the deal, both open ends, drawing and
  // passing, and the blocked-round pip count.
  const prose = [
    ...game.howToPlay,
    ...game.rules,
    ...game.scoring,
  ].join(" ");
  for (const trait of [/seven tiles/i, /open end/i, /draw one tile/i, /pass/i, /pips/i]) {
    assert.match(prose, trait, `the instructions must explain ${trait}`);
  }
});

test("landing: it is generated into the sitemap and never shadows the lobby", () => {
  assert.ok(PUBLIC_SEO_PATHS.includes("/games/dominoes"));
  assert.ok(!PUBLIC_SEO_PATHS.includes("/games/dominoes/play"));
  assert.match(code("src/lib/seoPages.ts"), /gameLandingPath\(game\.slug\)/);
  assert.match(
    code("src/lib/seoPages.ts"),
    /dominoes: \{ table: dominoesMatches, column: dominoesMatches\.createdAt \}/,
  );
  assert.equal(dominoesMatches.createdAt.name, "created_at");
  assert.equal(GAME_LANDING_SLUGS.filter((slug) => slug === SLUG).length, 1);
});

test("landing: the lobby is noindex and canonical to its own play URL", () => {
  const src = strip(read(LOBBY_PAGE));
  assert.match(src, /canonical: "\/games\/dominoes\/play"/);
  assert.match(src, /robots:\s*\{\s*index:\s*false,\s*follow:\s*true\s*\}/);
  // The match instance is not crawlable in any sense.
  const match = strip(read(MATCH_PAGE));
  assert.match(match, /robots:\s*\{\s*index:\s*false,\s*follow:\s*false\s*\}/);
  assert.match(match, /generateMetadata/);
});

// ── 3. Active-game presence ───────────────────────────────────────────────

test("presence: the canvas tag resolves to the canonical id", () => {
  assert.ok(PRESENCE_GAME_IDS.includes(KEY), "the canonical id comes from GAME_CATALOG");
  assert.equal(resolveGameId(KEY), KEY);
  assert.equal(resolveGameId("  DOMINOES  "), KEY, "labels are normalized");
  assert.equal(isPresenceGame(KEY), true);
  assert.equal(isCanonicalGameId(KEY), true);
  // Practice is the SAME game: the bot seat lives on the match row, so there is
  // no second presence label to collapse.
  assert.equal(resolveGameId("dominoes-ai"), null);
  assert.match(strip(read("src/lib/gamePresence.js")), /^\s*dominoes: "dominoes",/m);
});

test("presence: the match page reports through the shared host with real signals", () => {
  const src = strip(read(MATCH_CLIENT));
  assert.match(src, /<GameSessionHost\b/);
  assert.match(src, /gameLabel="dominoes"/);
  // A waiting lobby is not yet a game, and a settled match must stop counting.
  assert.match(src, /autoStart=\{status === "playing"\}/);
  assert.match(src, /autoStop=\{finished\}/);
  // The page must not beat presence itself.
  assert.doesNotMatch(src, /useActiveGamePresence|sendPresenceBeat/);
});

// ── 4. Navigation, matchmaking and the quick queue ────────────────────────

test("navigation: the lobby reuses the shared chrome and the one matchmaking store", () => {
  const page = strip(read(LOBBY_PAGE));
  assert.match(page, /import PageClient from "\.\/PageClient"/);
  assert.match(page, /<PageClient \/>/);
  assert.equal((page.match(/<AdSenseScript\s*\/>/g) ?? []).length, 1);
  // The match view carries no ad surface.
  assert.doesNotMatch(strip(read(MATCH_CLIENT)), /AdSenseScript|AdSlot/);

  const lobby = strip(read(LOBBY_CLIENT));
  assert.match(
    lobby,
    /import PvpLobbyPage from "\.\.\/\.\.\/\.\.\/components\/lobby\/PvpLobby"/,
  );
  assert.match(lobby, /<PvpLobbyPage/);
  assert.match(lobby, /rulesKey="dominoes"/);
  assert.match(lobby, /fetch\("\/api\/dominoes\/create-or-join"/);
  assert.match(lobby, /fetch\("\/api\/dominoes\/available"/);
  // One place builds the live match URL, under the canonical /games route.
  assert.match(lobby, /`\/games\/dominoes\/\$\{id\}`/);
  assert.match(lobby, /router\.push\(matchPath\(data\.data\.matchId\)\)/);
  // …and only once the second seat is a real player.
  assert.match(lobby, /if \(data\.data\?\.joined\) \{/);
  assert.match(lobby, /setWaitingMatchId\(String\(data\.data\.matchId\)\)/);
  // Unstaked: the lobby's CODE never offers, sends or reads a wager. (Its prose
  // may say there is no stake; this asserts no stake is passed as a value.)
  for (const money of [/wager=/, /stake=/, /stakeAmount/, /requireStake/, /escrow/i]) {
    assert.doesNotMatch(code(LOBBY_CLIENT), money, `the lobby must not pass ${money}`);
  }
});

test("navigation: matchmaking is age-verified and takes no stake from the caller", () => {
  const create = code(CREATE_ROUTE);
  assert.match(create, /requireAgeVerifiedUser/);
  assert.match(create, /await createOrJoin\(\{ userId \}\)/);
  // The caller's IDENTITY comes from the verified session, and there is nothing
  // else to read: no stake, no seat, no opponent.
  assert.doesNotMatch(create, /body\?\.|searchParams|requireStake/);
});

test("matchmaking: Dominoes is a Quick Queue destination and route", () => {
  assert.ok(QUICK_QUEUE_GAME_KEYS.includes(KEY), "the queue vocabulary must know the game");
  assert.equal(
    QUICK_QUEUE_GAME_KEYS.filter((key) => key === KEY).length,
    1,
    "the key must not be duplicated in the queue vocabulary",
  );
  const worker = strip(read("src/lib/quickQueueWorker.ts"));
  assert.match(
    worker,
    /import \{ createOrJoin as createOrJoinDominoesMatch \} from "\.\/dominoes\/serverStore"/,
  );
  // Unstaked: the queue's stake envelope is never passed to the game.
  assert.match(
    worker,
    /"dominoes": \(userId\) => createOrJoinDominoesMatch\(\{ userId \}\)/,
  );
  // The UI offers it and knows where a queued pair lands.
  const ui = strip(read("src/components/lobby/PlatformQuickQueue.jsx"));
  assert.match(ui, /\["dominoes", "Dominoes"\]/);
  assert.match(ui, /dominoes: "\/casino\/dominoes"/);
  assert.equal(quickQueueGameRoute(KEY, "abc-123"), "/casino/dominoes/abc-123");
  assert.equal(quickQueueGameRoute(KEY, ""), null);
  assert.ok(QUICK_QUEUE_GAME_OPTIONS.some(([key]) => key === KEY));
  // A Dominoes-only selection is a valid queue request.
  assert.deepEqual(
    normalizeQuickQueueReadiness({ userId: "user_1", preferredGames: [KEY] }).preferredGames,
    [KEY],
  );
  // The destination is the game's OWN store, and both paired seats land on one id.
  const store = strip(read(STORE));
  assert.match(store, /export async function createOrJoin\(\{/);
  assert.match(store, /return \{ match: updated, joined: true \} as const;/);
});

// ── 5. Server authority ───────────────────────────────────────────────────

test("authority: the only client-authored move input is an action + expectedVersion", () => {
  const route = code(MOVE_ROUTE);
  // Free practice shares this route with the ranked table, so the gate is the
  // shared practice gate (a guest is a seat; the store still authorises by seat).
  assert.match(route, /requirePracticePlayer/);
  assert.doesNotMatch(route, /requireAgeVerifiedUser/);
  assert.match(route, /action: body\?\.action/);
  assert.match(route, /expectedVersion: body\?\.expectedVersion/);
  // No client-supplied hand, chain, turn, winner or result is read.
  for (const forbidden of [
    /body\?\.(hand|hands|chain|openEnds|drawPile|turn|winner|result|gameState)/,
    /body\?\.(matchCompleted|finished|winnerId|resultReason|pips)/,
    /body\?\.(elo|rating|trophies|delta)/,
  ]) {
    assert.doesNotMatch(route, forbidden, "the route must not read a client-authored fact");
  }
  // Every consequence is derived by the shared engine inside a row-locked
  // transaction.
  const store = code(STORE);
  assert.match(store, /validateAction\(state, seat, action as DominoesAction\)/);
  assert.match(store, /const next = applyAction\(state, seat, action as DominoesAction\)/);
  assert.match(store, /\.for\("update"\)/);
  assert.match(store, /eq\(dominoesMatches\.ply, match\.ply\)/);
});

test("authority: the store settles exactly once, through the shared writers", () => {
  const store = code(STORE);
  assert.match(store, /import \{ applyRatingResult \} from "\.\.\/rating";/);
  assert.match(store, /import \{ applyTrophyResult \} from "\.\.\/trophyStore";/);
  // The settlement spells the key as the LITERAL, which is the platform's
  // convention so the wiring audits can see it. Four call sites: rating and
  // trophies for a decided match, and rating and trophies for a draw.
  assert.equal((store.match(/gameKey: "dominoes",/g) ?? []).length, 4);
  assert.equal((store.match(/await applyRatingResult\(\{/g) ?? []).length, 2);
  assert.equal((store.match(/await applyTrophyResult\(\{/g) ?? []).length, 2);
  assert.match(store, /const matchId = String\(match\.id\);/);
  // Best-effort: a progression failure must never un-finish a decided match.
  assert.match(store, /\}\)\.catch\(\(\) => \{\}\);/);
  // The account W/L counters are the only other progression touched, and a draw
  // touches neither.
  assert.match(store, /set\(\{ gamesWon: sql`\$\{users\.gamesWon\} \+ 1` \}\)/);
  assert.match(store, /set\(\{ gamesLost: sql`\$\{users\.gamesLost\} \+ 1` \}\)/);
  // Every terminal path claims the row with a conditional write before it
  // settles: the ply-conditional action write, the clock resolution, the
  // resignation, the disconnect forfeit and a practice match whose opening
  // bot turn ends it.
  assert.equal((store.match(/await settleMatch\(/g) ?? []).length, 5);
  assert.ok((store.match(/if \(!updated\) \{/g) ?? []).length >= 3);
});

test("settlement: a draw uses the supported draw semantics", () => {
  const store = code(STORE);
  // The engine's terminal state has no winner for a blocked round on equal pips;
  // the store records the platform's own DRAW vocabulary and settles it as one.
  assert.match(store, /const result = state\.winner \?\? RESULT\.DRAW;/);
  assert.match(store, /if \(outcome\.result === RESULT\.DRAW\) \{/);
  assert.match(store, /result: "draw",/);
  // A draw is the ONLY branch that skips the W/L counters.
  const drawBranch = store.slice(
    store.indexOf("if (outcome.result === RESULT.DRAW) {"),
    store.indexOf("const winnerId ="),
  );
  assert.doesNotMatch(drawBranch, /gamesWon|gamesLost/);
});

test("settlement: only completed, eligible matches can be rated", () => {
  const store = code(STORE);
  // Both seats must be real accounts: a lobby with no opponent never settles.
  assert.match(store, /if \(!match\.player2Id\) return;/);
  assert.match(
    store,
    /if \(!winnerId \|\| !loserId \|\| winnerId === loserId\) return;/,
  );
  // A cancelled lobby settles NOTHING — it is the one terminal path that never
  // calls the settlement at all.
  const cancelBody = store.slice(
    store.indexOf("export async function cancelMatch({"),
    store.indexOf("export async function forfeitMatchOnDisconnect({"),
  );
  assert.ok(cancelBody.length > 0);
  assert.doesNotMatch(cancelBody, /settleMatch\(/);
  assert.match(cancelBody, /status: MATCH_STATUS\.CANCELLED/);
  // Practice is UNRATED: the bot seat is never rated, never counted and never
  // trophied, and a human practice win unlocks the daily reward instead.
  assert.match(store, /if \(match\.isAi\)/);
  assert.match(store, /markDailyRewardWin\(tx, winnerId\)/);
  assert.equal(exists("src/app/casino/dominoes/play-ai"), false);
  // And the writers only accept a registered key, which the registry provides.
  assert.equal(isRatedGame(KEY), true);
});

// ── 6. Competitive registry ───────────────────────────────────────────────

test("rating: dominoes is registered once and reuses the trophy registry", () => {
  assert.ok(RATED_GAMES.includes(KEY));
  assert.equal(RATED_GAMES.filter((game) => game === KEY).length, 1);
  assert.equal(normalizeRatingGameKey(KEY), KEY, "the key resolves to itself, not to chess");
  assert.equal(getRatingGameLabel(KEY), "Dominoes");
  // Trophies have no second registry: they ARE the rated games.
  assert.equal(TROPHY_GAMES, RATED_GAMES);
  assert.ok(TROPHY_GAMES.includes(KEY));
  assert.equal(isTrophyGame(KEY), true);
  assert.equal(getTrophyGameLabel(KEY), "Dominoes");
  // The per-game Elo board (and the classement first paint) read the registry
  // rather than a hand-kept list.
  assert.match(code("src/app/api/leaderboard/game/route.js"), /RATED_GAMES\.map/);
  assert.match(
    code("src/app/classement/PageClient.jsx"),
    /\{ key: "dominoes", label: "Dominoes" \}/,
  );
});

// ── 7. The no-economy guarantee ───────────────────────────────────────────

test("economy: Dominoes moves no token, no balance and no payout", () => {
  // No wager catalog knows it…
  assert.equal(supportsTokenWager(KEY), false);
  assert.equal(WAGER_GAME_KEYS.includes(KEY), false);

  // …the store has no escrow, pot or payout path at all…
  const store = code(STORE);
  for (const money of [
    /escrowMatchWagers/,
    /payPvpPot/,
    /tokens\//,
    /houseFee/,
    /prizePaid/,
    /coins/i,
  ]) {
    assert.doesNotMatch(store, money, `the Dominoes store must not touch ${money}`);
  }

  // …and the match table carries no stake or settlement column. The block is
  // taken from the raw source (comments included) and checked for COLUMN NAMES,
  // so the table's own "no wager columns" note cannot satisfy or fail it.
  const schema = strip(read("src/db/schema.ts"));
  const start = schema.indexOf('pgTable(\n  "dominoes_matches"');
  const end = schema.indexOf('pgTable(\n  "dominoes_moves"');
  assert.ok(start > 0 && end > start, "the dominoes_matches table must exist");
  const table = schema.slice(start, end);
  for (const column of ['"stake_amount"', '"house_fee"', '"prize_paid"', '"wager"']) {
    assert.equal(table.includes(column), false, `dominoes_matches must not have ${column}`);
  }
});

test("rooms: Dominoes is a real free-play adapter, not a fake one", () => {
  // The private-room contract needs a "seat these two named players" primitive
  // in the game's OWN store. Dominoes has one now
  // (`createDominoesMatchForPair`), so the room catalog may offer it — but a room
  // is stake-shaped and Dominoes is unstaked, so the ceiling must be 0 and the
  // adapter must never pass a stake.
  const entry = ROOM_GAMES.find((game) => game.key === KEY);
  assert.ok(entry, "Dominoes must be registered as a room game");
  assert.equal(entry.seats, 2);
  assert.equal(entry.mode, "pvp");
  assert.equal(entry.maxStake, 0, "a Dominoes room is free play only");

  const adapters = code("src/lib/rooms/games.ts");
  assert.match(adapters, /createDominoesMatchForPair/, "the adapter delegates to the store");

  // Two `case "dominoes"` sites: the URL table first, the adapter second.
  const urlTable = adapters.slice(
    adapters.indexOf('case "dominoes"'),
    adapters.indexOf("default:"),
  );
  assert.match(
    urlTable,
    /return `\/games\/dominoes\/\$\{matchId\}`/,
    "a Dominoes room targets the same match URL as the public flow",
  );

  // The adapter creates the match through the store primitive — it must not
  // build a row of its own, and must not smuggle a stake into an unstaked game.
  const dominoesCase = adapters.slice(adapters.lastIndexOf('case "dominoes"'));
  assert.ok(dominoesCase.length > 0, "the adapter must have a dominoes case");
  assert.match(dominoesCase, /createDominoesMatchForPair\(\{/, "it calls the store primitive");
  assert.match(dominoesCase, /matchUrlFor\(game\.key/, "it hands back the canonical match URL");
  assert.equal(
    /\b(stake|wager)\b/i.test(dominoesCase),
    false,
    "the Dominoes adapter must never pass a stake",
  );

  // And the primitive itself stays on the authoritative store: it opens the
  // store's own waiting row and seats the second player with the store's own
  // join path, inside one transaction.
  const store = code("src/lib/dominoes/serverStore.ts");
  const pair = store.slice(store.indexOf("export async function createDominoesMatchForPair"));
  assert.ok(pair.length > 0, "the pair primitive must exist");
  const body = pair.slice(0, pair.indexOf("function dealMatchSafely"));
  assert.match(body, /db\.transaction/, "the pair must be created atomically");
  assert.match(body, /createWaitingMatch\(tx, host, nowMs\)/, "seat 1 uses the store's own lobby helper");
  assert.match(body, /joinExistingMatch\(tx, matchId, opponent, nowMs\)/, "seat 2 uses the store's own join helper");
  assert.match(body, /pg_advisory_xact_lock/, "it serialises with public matchmaking");
  assert.equal(/dealMatch\(|insert\(dominoesMatches\)/.test(body), false, "it must not mint a second kind of match");
});

// ── 8. Nothing else was removed ───────────────────────────────────────────

test("regression: Dice Flush stays retired and every other game survives", () => {
  const ids = GAME_CATALOG.map((game) => game.id);
  assert.equal(ids.includes("dice-flush"), false, "Dice Flush must NOT be resurrected");
  assert.doesNotMatch(strip(read(LOBBY)), /href: "\/games\/dice-flush"/);

  const expected = [
    "mines-pvp",
    "memory-grid",
    "chess",
    "keno",
    "uno",
    "rps",
    "tower-arena",
    "four-in-a-row",
    "lane-runner",
    "pool-masters",
    "hex-duel",
    "odds",
    "precision",
    "dots-and-boxes",
    "mini-golf",
    "speed-typing",
    "tic-tac-toe",
    "solitaire-duel",
    "sudoku-duel",
    "barricade",
  ];
  for (const id of expected) {
    assert.ok(ids.includes(id), `the catalogue must still contain ${id}`);
  }
  // Every public landing page still exists alongside the new one.
  for (const slug of [
    ...expected.map((id) => (id === "barricade" ? "barrier-blitz" : id)),
    "neon-flush",
    "uno",
  ]) {
    assert.ok(GAME_LANDING_BY_SLUG[slug], `landing page for ${slug} must still exist`);
  }
});
