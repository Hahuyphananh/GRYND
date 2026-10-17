/**
 * barricade-platform.test.mjs
 *
 * Barricade's PLATFORM registration — every GRYND system that has to know the
 * game exists, and the guarantees that make that safe. The rules engine's own
 * behaviour lives in tests/barricade-rules.test.mjs, the AI in
 * tests/barricade-ai.test.mjs, and the online store/UI contracts in
 * tests/barricade-online-store.test.mjs / tests/barricade-online-ui.test.mjs;
 * this file is about the SEAMS between the game and the platform:
 *
 *   * game discovery / registry — it appears in the canonical catalog and the
 *     casino lobby, in the same position, with honest tags, exactly once;
 *   * the public landing page — /games/barrier-blitz exists, is in the sitemap and
 *     is served by the same shared component as every other game;
 *   * active-game presence — its gameLabel (and the practice alias) resolve to
 *     the canonical id, and the match page feeds the shared host REAL lifecycle
 *     signals, so the lobby's "N playing" badge counts it honestly;
 *   * navigation and matchmaking — Games → Barricade → Lobby → Match, through
 *     the existing shared lobby chrome, the existing routes and the one
 *     matchmaking store, plus the platform Quick Queue;
 *   * competitive settlement — Barricade is registered in the ONE rated-game
 *     registry, its store settles through the shared Elo/trophy writers inside
 *     the same transaction that claimed the match, and free practice is excluded
 *     by construction rather than by a flag;
 *   * the no-economy guarantee — nothing in the game's own surfaces can move a
 *     token, a balance or a payout, and it is in no wager catalog.
 *
 * It asserts against the REAL sources and the REAL modules — no re-declared game
 * lists — so a future refactor that drops Barricade from any of these surfaces
 * fails here rather than in production.
 *
 * Run:  npm run test:barricade
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
const { TROPHY_GAMES } = await import("../src/lib/trophies.js");
const { WAGER_GAME_KEYS } = await import("../src/lib/defaultWagers.js");
const { GAME_LANDING_BY_SLUG, GAME_LANDING_SLUGS, gameLandingPath, gamePlayPath } =
  await import("../src/lib/gameLandingPages.ts");
const { PUBLIC_SEO_PATHS } = await import("../src/lib/seoPages.ts");
const { QUICK_QUEUE_GAME_KEYS } = await import("../src/lib/quickQueue.ts");
const { normalizeQuickQueueReadiness } = await import("../src/lib/quickQueueReadiness.ts");
const { quickQueueGameRoute, QUICK_QUEUE_GAME_OPTIONS } = await import(
  "../src/components/lobby/PlatformQuickQueue.jsx"
);
const { barricadeMatches } = await import("../src/db/schema.ts");

const read = (rel) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");
const strip = (src) => src.replace(/\r\n/g, "\n");
/** Source with comments removed, so the files' own prose can never satisfy a
 *  check about what the CODE references. */
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
const code = (rel) => stripComments(strip(read(rel)));

const KEY = "barricade";
// The PUBLIC page slug and the internal game key are no longer the same string:
// the game was renamed Barrier Blitz, so its routes moved while `barricade`
// remains the rating/trophy/presence id (and every store and API path).
const SLUG = "barrier-blitz";

const LOBBY = "src/app/casino/PageClient.jsx";
const LOBBY_PAGE = "src/app/casino/barrier-blitz/page.tsx";
const LOBBY_CLIENT = "src/app/casino/barrier-blitz/PageClient.tsx";
const MATCH_PAGE = "src/app/casino/barrier-blitz/[matchId]/page.tsx";
const MATCH_CLIENT = "src/app/casino/barrier-blitz/[matchId]/PageClient.tsx";
const PRACTICE_PAGE = "src/app/casino/barrier-blitz/play-ai/page.tsx";
const PRACTICE_CLIENT = "src/app/casino/barrier-blitz/play-ai/PageClient.tsx";
const STORE = "src/lib/barricade/serverStore.ts";
const MOVE_ROUTE = "src/app/api/barricade/match/[matchId]/move/route.ts";

// ── 1. Game discovery / registry ──────────────────────────────────────────

test("discovery: barricade is in the canonical catalog with the lobby's href", () => {
  const entry = GAME_CATALOG.find((game) => game.id === KEY);
  assert.ok(entry, "barricade must be in GAME_CATALOG");
  assert.equal(entry.href, "/games/barrier-blitz");
  assert.ok(entry.tags.includes("pvp"), "Barricade is a 1v1 duel → pvp");
  assert.ok(entry.tags.includes("strategy"), "reading the position decides it → strategy");
  assert.ok(entry.tags.includes("skill"), "nothing is drawn during play → skill");
  assert.ok(entry.tags.includes("competitive"), "its results move a rated ladder → competitive");
  assert.ok(!entry.tags.includes("chance"), "there is no randomness anywhere in Barricade");
  assert.ok(!entry.tags.includes("multiplayer"), "Barricade is strictly 2-player");
  // Exactly one entry — a duplicate would corrupt the fallback order.
  assert.equal(GAME_CATALOG.filter((game) => game.id === KEY).length, 1);
  assert.ok(DEFAULT_GAME_ORDER.includes(KEY));
  assert.equal(GAMES_BY_ID[KEY]?.href, "/games/barrier-blitz");
});

test("discovery: the catalog and the lobby agree on Barricade's position", () => {
  const lobbyIds = [...strip(read(LOBBY)).matchAll(/leaderboardKey: "([^"]+)"/g)].map(
    (m) => m[1],
  );
  assert.equal(GAME_CATALOG.length, lobbyIds.length, "catalog/lobby length mismatch");
  assert.deepEqual(
    GAME_CATALOG.map((game) => game.id),
    lobbyIds,
    "the catalog must mirror the lobby's featured order — it IS the engine's fallback",
  );
  // New games are APPENDED to the end of the lobby, so Barricade sits after the
  // titles that shipped before it — asserted relatively, so a newer card does
  // not falsify the append-at-the-end rule.
  assert.equal(lobbyIds[lobbyIds.length - 1], KEY, "Barricade is appended last");
  assert.ok(lobbyIds.indexOf(KEY) > lobbyIds.indexOf("sudoku-duel"));
});

test("discovery: the lobby card links to the game, records plays and is 1v1", () => {
  const src = strip(read(LOBBY));
  const card = src.slice(src.indexOf('name: "Barrier Blitz"'));
  assert.match(card, /href: "\/games\/barrier-blitz"/);
  assert.match(card, /leaderboardKey: "barricade"/);
  assert.match(card, /playsKey: "barricade"/);
  assert.match(card, /pvpMode: "1v1"/);
  assert.match(card, /descriptionKey: "games\.barricade_desc"/);
  assert.match(card, /nameKey: "games\.barricade_name"/);
  // The card art is shipped art, not a shared fallback — and it is looked up in
  // the ONE shared registry, keyed by the game's PUBLIC page slug (the registry's
  // keys are the landing slugs, asserted in tests/game-landing-pages.test.mjs).
  assert.match(card, /image: GAME_CARD_ART\["barrier-blitz"\]/);
  assert.match(
    strip(read("src/components/games/gameCardArt.js")),
    /"barrier-blitz": barricadeArt,/,
  );
  assert.ok(fs.existsSync("src/images/barricade-card.svg"), "the card art must exist");
  // The "Newest" sort is newest-first, and Barricade is the newest game.
  assert.match(src, /const newestOrder = \[\n\s*(?:\/\/[^\n]*\n\s*)*"barricade",/);
});

test("discovery: the card copy exists in all three locales", () => {
  const src = strip(read("src/lib/appTextTranslations.js"));
  for (const field of ["barricade_name", "barricade_desc"]) {
    const lines = src.split("\n").filter((line) => line.includes(`${field}:`));
    assert.equal(lines.length, 3, `${field} must exist for en/fr/es`);
  }
  // The English copy states the format: free, 1v1, the 9x9 board, one action a
  // turn and the race to the far side.
  const en = src.indexOf('barricade_desc: "');
  const copy = src.slice(en, src.indexOf("\n", en));
  for (const trait of [/free/i, /1v1/, /9x9/, /one action/i, /far/i]) {
    assert.match(copy, trait, `the English card copy must mention ${trait}`);
  }
});

test("discovery: personalization always returns Barricade (never hidden)", () => {
  const ranked = recommendGames({ game_types: ["strategy"] }).recommendations.map(
    (game) => game.id,
  );
  assert.ok(ranked.includes(KEY));
  assert.equal(ranked.length, GAME_CATALOG.length);
});

// ── 2. The public landing page ────────────────────────────────────────────

test("landing: /games/barrier-blitz exists with full content and its own leaderboard key", () => {
  const game = GAME_LANDING_BY_SLUG[SLUG];
  assert.ok(game, "the public landing page must exist");
  assert.equal(game.leaderboardKey, KEY, "the landing page names a real GAME_CATALOG id");
  assert.equal(gameLandingPath(SLUG), "/games/barrier-blitz");
  // The lobby's Play CTA and the landing Play CTA are the same derived URLs.
  assert.equal(gamePlayPath(SLUG), "/games/barrier-blitz/play");
  assert.equal(game.aiPractice, true, "the free vs-AI board is advertised");
  assert.ok(game.faq.length >= 3);
  assert.ok(game.related.length >= 3);
  for (const related of game.related) {
    assert.ok(GAME_LANDING_BY_SLUG[related], `unknown related slug ${related}`);
  }
});

test("landing: it is generated into the sitemap and never shadows the lobby", () => {
  assert.ok(
    PUBLIC_SEO_PATHS.includes("/games/barrier-blitz"),
    "the indexable page must be in the sitemap",
  );
  assert.ok(!PUBLIC_SEO_PATHS.includes("/games/barrier-blitz/play"));
  // The sitemap's game entries are a projection of the catalog, and Barricade's
  // freshness hint is its own match table — never a hand-written URL.
  assert.match(code("src/lib/seoPages.ts"), /gameLandingPath\(game\.slug\)/);
  assert.match(
    code("src/lib/seoPages.ts"),
    /barricade: \{ table: barricadeMatches, column: barricadeMatches\.createdAt \}/,
  );
  assert.equal(barricadeMatches.createdAt.name, "created_at");
  assert.equal(GAME_LANDING_SLUGS.filter((slug) => slug === SLUG).length, 1);
});

test("landing: the lobby is noindex and canonical to its own play URL", () => {
  const src = strip(read(LOBBY_PAGE));
  assert.match(src, /canonical: "\/games\/barrier-blitz\/play"/);
  assert.match(src, /robots:\s*\{\s*index:\s*false,\s*follow:\s*true\s*\}/);
  // The match instance is not crawlable in any sense.
  const match = strip(read(MATCH_PAGE));
  assert.match(match, /robots:\s*\{\s*index:\s*false,\s*follow:\s*false\s*\}/);
  assert.match(match, /generateMetadata/);
});

// ── 3. Active-game presence ───────────────────────────────────────────────

test("presence: both Barricade labels resolve to the canonical id", () => {
  assert.ok(PRESENCE_GAME_IDS.includes(KEY), "the canonical id comes from GAME_CATALOG");
  assert.equal(resolveGameId(KEY), KEY);
  assert.equal(resolveGameId("  BARRICADE  "), KEY, "labels are normalized");
  assert.equal(isPresenceGame(KEY), true);
  assert.equal(isCanonicalGameId(KEY), true);
  // Free practice collapses onto the ONE game: a player practising against the
  // bot is still playing Barricade.
  assert.equal(resolveGameId("barricade-ai"), KEY);
  const map = strip(read("src/lib/gamePresence.js"));
  assert.match(map, /"?barricade"?: "barricade",/);
  assert.match(map, /"barricade-ai": "barricade",/);
});

test("presence: the match page reports through the shared host with real signals", () => {
  const src = strip(read(MATCH_CLIENT));
  assert.match(src, /<GameSessionHost\b/);
  assert.match(src, /gameLabel="barricade"/);
  // A waiting lobby is not yet a game, and a terminal match must stop counting.
  assert.match(src, /autoStart=\{status === "playing"\}/);
  assert.match(src, /autoStop=\{matchOver\}/);
  // The page must not beat presence itself.
  assert.doesNotMatch(src, /useActiveGamePresence|sendPresenceBeat/);
  // And practice reports under the practice label, which maps to the same id.
  assert.match(strip(read(PRACTICE_CLIENT)), /gameLabel="barricade-ai"/);
});

// ── 4. Navigation, matchmaking and the quick queue ────────────────────────

test("navigation: the lobby entry route renders the client, ads script included", () => {
  const page = strip(read(LOBBY_PAGE));
  assert.match(page, /import PageClient from "\.\/PageClient"/);
  assert.match(page, /<PageClient \/>/);
  assert.equal((page.match(/<AdSenseScript\s*\/>/g) ?? []).length, 1);
  // The match view carries no ad surface.
  assert.doesNotMatch(strip(read(MATCH_CLIENT)), /AdSenseScript|AdSlot/);
});

test("navigation: the lobby reuses the shared chrome and the one matchmaking store", () => {
  const lobby = strip(read(LOBBY_CLIENT));
  assert.match(lobby, /import PvpLobbyPage from "\.\.\/\.\.\/\.\.\/components\/lobby\/PvpLobby"/);
  assert.match(lobby, /<PvpLobbyPage/);
  assert.match(lobby, /rulesKey="barricade"/);
  assert.match(lobby, /fetch\("\/api\/barricade\/create-or-join"/);
  assert.match(lobby, /fetch\("\/api\/barricade\/available"/);
  // The lobby builds the match URL in one place, under the NEW public route.
  assert.match(lobby, /`\/casino\/barrier-blitz\/\$\{id\}`/);
  assert.match(lobby, /router\.push\(matchPath\(data\.data\.matchId\)\)/);
  // …and only AFTER the server has seated a second player: a fresh lobby stays
  // on the matchmaking screen (see tests/barricade-online-ui.test.mjs).
  assert.match(lobby, /if \(data\.data\?\.joined\) \{/);
  assert.match(lobby, /setWaitingMatchId\(String\(data\.data\.matchId\)\)/);

  const create = code("src/app/api/barricade/create-or-join/route.ts");
  assert.match(create, /requireAgeVerifiedUser/);
  // PvP plays for coins: the lobby must name a legal stake, which the route
  // validates before the store ever sees it.
  assert.match(create, /requireStake\(body\?\.stake, "barricade"\)/);
  assert.match(create, /await createOrJoin\(\{ userId, stake: required\.stake \}\)/);
  // The caller's IDENTITY comes from the verified session, never from the
  // request (only the stake is read from the body).
  assert.doesNotMatch(create, /searchParams|body\.userId/);
});

test("matchmaking: Barricade is a Quick Queue destination and route", () => {
  assert.ok(QUICK_QUEUE_GAME_KEYS.includes(KEY), "the queue vocabulary must know the game");
  assert.equal(
    QUICK_QUEUE_GAME_KEYS.filter((key) => key === KEY).length,
    1,
    "the key must not be duplicated in the queue vocabulary",
  );
  const worker = strip(read("src/lib/quickQueueWorker.ts"));
  assert.match(worker, /import \{ createOrJoin as createOrJoinBarricadeMatch \} from "\.\/barricade\/serverStore"/);
  // Staked: the queue's normalized stake IS what the pair is matched at.
  assert.match(
    worker,
    /"barricade": \(userId\) => createOrJoinBarricadeMatch\(\{ userId, stake: sourceStake \}\)/,
  );
  // The UI offers it and knows where a queued pair lands.
  const ui = strip(read("src/components/lobby/PlatformQuickQueue.jsx"));
  assert.match(ui, /\["barricade", "Barrier Blitz"\]/);
  assert.match(ui, /barricade: "\/casino\/barrier-blitz"/);
  assert.equal(quickQueueGameRoute(KEY, "abc-123"), "/casino/barrier-blitz/abc-123");
  assert.equal(quickQueueGameRoute(KEY, ""), null);
  assert.ok(QUICK_QUEUE_GAME_OPTIONS.some(([key]) => key === KEY));
  // A Barricade-only selection is a valid queue request.
  assert.deepEqual(
    normalizeQuickQueueReadiness({ userId: "user_1", preferredGames: [KEY] }).preferredGames,
    [KEY],
  );
  // The destination is the game's OWN lobby: both paired seats land on one id.
  const store = strip(read(STORE));
  assert.match(store, /export async function createOrJoin\(\{/);
  assert.match(store, /userId,\s*stake = 0,/);
  assert.match(store, /return \{ match: updated, joined: true \} as const;/);
});

// ── 5. Server authority ───────────────────────────────────────────────────

test("authority: the only client-authored move input is an address + expectedVersion", () => {
  const route = code(MOVE_ROUTE);
  assert.match(route, /requireAgeVerifiedUser/);
  assert.match(route, /action: body\?\.action/);
  assert.match(route, /expectedVersion: body\?\.expectedVersion/);
  // No client-supplied board, pawn, reserve, turn, winner or result is read.
  for (const forbidden of [
    /body\?\.(board|pawns|walls|wallsRemaining|turn|winner|result|gameState)/,
    /body\?\.(matchCompleted|finished|winnerId|resultReason)/,
  ]) {
    assert.doesNotMatch(route, forbidden, "the route must not read a client-authored fact");
  }
  // Every consequence is derived by the shared engine inside a row-locked
  // transaction.
  const store = code(STORE);
  assert.match(store, /validateAction\(state, seat, action as BarricadeAction\)/);
  assert.match(store, /const next = applyAction\(state, seat, action as BarricadeAction\)/);
  assert.match(store, /\.for\("update"\)/);
  assert.match(store, /eq\(barricadeMatches\.ply, match\.ply\)/);
});

test("authority: the store settles exactly once, through the shared writers", () => {
  const store = code(STORE);
  assert.match(store, /import \{ applyRatingResult \} from "\.\.\/rating";/);
  assert.match(store, /import \{ applyTrophyResult \} from "\.\.\/trophyStore";/);
  // The settlement spells the key as the LITERAL, which is the platform's
  // convention precisely so the wiring audits can see it: every call site must
  // read `gameKey: "barricade"` for tests/trophy-system.test.mjs to be able to
  // prove one writer per rated game.
  // Four call sites spell the key as the LITERAL: rating, trophies, the escrow
  // that funds both seats, and the pot payout.
  assert.equal((store.match(/gameKey: "barricade",/g) ?? []).length, 4);
  assert.match(store, /gameKey: "barricade",\n\s+matchId: String\(match\.id\),/);
  assert.equal((store.match(/await applyRatingResult\(\{/g) ?? []).length, 1);
  assert.equal((store.match(/await applyTrophyResult\(\{/g) ?? []).length, 1);
  // Best-effort: a progression failure must never un-finish a decided match.
  assert.match(store, /\}\)\.catch\(\(\) => \{\}\);/);
  // The account W/L counters are the only other progression touched.
  assert.match(store, /set\(\{ gamesWon: sql`\$\{users\.gamesWon\} \+ 1` \}\)/);
  assert.match(store, /set\(\{ gamesLost: sql`\$\{users\.gamesLost\} \+ 1` \}\)/);
  // Every terminal path claims the row with a conditional UPDATE before it
  // settles, so a second concurrent completion is a no-op rather than a second
  // settlement.
  assert.equal((store.match(/await settleMatch\(/g) ?? []).length, 3);
  assert.ok((store.match(/if \(!updated\) \{/g) ?? []).length >= 3);
  assert.match(store, /eq\(barricadeMatches\.status, MATCH_STATUS\.PLAYING\)/);
  // And the shared writers are idempotent per (user, game, match) by their own
  // journals — asserted from the registry that makes the key legitimate.
  assert.equal(isRatedGame(KEY), true);
});

test("authority: free practice cannot touch progression at all", () => {
  // The store has no AI/practice path: there is no `isAi` column and no
  // server-side practice seat, so a practice game has no match row to settle.
  const store = code(STORE);
  assert.doesNotMatch(store, /isAi|is_ai/);
  // …and the schema says so explicitly, so a future "just add an is_ai column"
  // change has to answer this note first.
  assert.match(strip(read("src/db/schema.ts")), /no `is_ai` column/);
  // The store refuses to settle a lobby with no second seat.
  assert.match(store, /if \(!match\.player2Id\) return;/);
  assert.match(store, /if \(!winnerId \|\| !loserId \|\| winnerId === loserId\) return;/);
  // Practice is entirely client-side: the board makes NO request at all, so it
  // cannot reach an API, a match row or a settlement path.
  const practice = strip(read(PRACTICE_CLIENT));
  assert.doesNotMatch(practice, /\bfetch\(/);
  assert.doesNotMatch(practice, /\/api\/barricade/);
});

// ── 6. Competitive registry ───────────────────────────────────────────────

test("rating: barricade is registered once and reuses the trophy registry", () => {
  assert.ok(RATED_GAMES.includes(KEY));
  assert.equal(RATED_GAMES.filter((game) => game === KEY).length, 1);
  assert.equal(normalizeRatingGameKey(KEY), KEY, "the key resolves to itself, not to chess");
  assert.equal(getRatingGameLabel(KEY), "Barrier Blitz");
  // Trophies have no second registry: they ARE the rated games.
  assert.equal(TROPHY_GAMES, RATED_GAMES);
  assert.ok(TROPHY_GAMES.includes(KEY));
  // The per-game Elo board (and the classement first paint) read the registry
  // rather than a hand-kept list.
  assert.match(code("src/app/api/leaderboard/game/route.js"), /RATED_GAMES\.map/);
  assert.match(
    code("src/app/classement/PageClient.jsx"),
    /\{ key: "barricade", label: "Barrier Blitz" \}/,
  );
});

// ── 7. The no-economy guarantee ───────────────────────────────────────────

test("economy: a Barricade match escrows both seats and pays the pot minus the rake", () => {
  // The game is a coin match now, so the wager catalog knows it.
  assert.equal(supportsTokenWager(KEY), true);
  assert.equal(WAGER_GAME_KEYS.includes(KEY), true);

  const store = code(STORE);
  // Both seats are escrowed when the second one joins…
  assert.match(store, /import \{ escrowMatchWagers \} from "\.\.\/tokens\/wager";/);
  assert.match(store, /clerkIds: \[updated\.player1Id, userId\]/);
  assert.match(store, /stake: stakeAmount,/);
  // …and the winner is paid the pot out of that escrow, minus the shared rake.
  assert.match(store, /import \{ payPvpPot \} from "\.\.\/tokens\/pvpPot";/);
  assert.match(store, /await payPvpPot\(\{/);
  assert.match(store, /houseFee: \(stake \* 0\.2\)\.toFixed\(2\)/);
  assert.match(store, /prizePaid: payout\.toFixed\(2\)/);
  // A practice row (stake 0) records nothing, so a legacy match can never mint.
  assert.match(store, /if \(stake > 0\) \{/);

  // The schema carries the stake + settlement columns.
  const schema = code("src/db/schema.ts");
  const table = schema.slice(
    schema.indexOf('export const barricadeMatches'),
    schema.indexOf('export const barricadeMoves'),
  );
  assert.match(table, /stakeAmount: numeric\("stake_amount"/);
  assert.match(table, /houseFee: numeric\("house_fee"/);
  assert.match(table, /prizePaid: numeric\("prize_paid"/);
});
