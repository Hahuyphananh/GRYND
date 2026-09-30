/**
 * solitaire-duel-platform.test.mjs
 *
 * Solitaire Duel's PLATFORM registration — the surfaces that are neither the
 * game's rules nor its settlement (those live in tests/solitaire-duel-rules,
 * -store, -security, -interactions and -ui-contract):
 *
 *   * game discovery / registry — it appears in the canonical catalog and the
 *     casino lobby, in the SAME position, exactly once, with tags that match
 *     the lobby card;
 *   * active-game presence — its gameLabel resolves to a canonical id, so the
 *     lobby's "N playing" badge can count it honestly and no presence request
 *     can ever be sent for a game that does not exist;
 *   * rated settlement — the key is in the ONE rating registry (which the
 *     trophy registry IS), so the store's shared-writer calls take effect and
 *     the leaderboard mirror can label it;
 *   * the sitemap knows it under its canonical /games alias;
 *   * ad conventions — the lobby page carries the script, the match route does
 *     not;
 *   * copy — the lobby card's name/description exist in every locale and state
 *     the format (1v1 · same deal · first to solve · no wagers).
 *
 * It asserts against the REAL sources and the REAL modules — no re-declared
 * game lists — so dropping the game from any of these surfaces fails here
 * rather than in production.
 *
 * Run:  node --import tsx --test tests/solitaire-duel-platform.test.mjs
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
const { RATED_GAMES, RATING_GAME_LABELS, isRatedGame } = await import(
  "../src/lib/rating.js"
);
const { TROPHY_GAMES, isTrophyGame, getTrophyGameLabel } = await import(
  "../src/lib/trophies.js"
);

const read = (rel) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");
const strip = (src) => src.replace(/\r\n/g, "\n");
/** Source with comments removed, so prose about a rule can't trip an assertion. */
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const code = (rel) => stripComments(strip(read(rel)));

const KEY = "solitaire-duel";
const LOBBY = "src/app/casino/PageClient.jsx";
const LOBBY_PAGE = "src/app/casino/solitaire-duel/page.tsx";
const MATCH_PAGE_ROUTE = "src/app/casino/solitaire-duel/[matchId]/page.tsx";
const CLASSEMENT = "src/app/classement/PageClient.jsx";
const SITEMAP = "src/app/sitemap.ts";
const TRANSLATIONS = "src/lib/appTextTranslations.js";
const PRESENCE = "src/lib/gamePresence.js";

// ── 1. Discovery: the catalog and the lobby agree ─────────────────────────

test("discovery: solitaire-duel is in the canonical catalog with the lobby's href", () => {
  const entry = GAMES_BY_ID[KEY];
  assert.ok(entry, "solitaire-duel must be in GAME_CATALOG");
  assert.equal(entry.href, "/casino/solitaire-duel");
  assert.ok(entry.tags.includes("pvp"), "it is a 1v1 duel → pvp");
  assert.ok(entry.tags.includes("skill"), "the outcome turns on ability → skill");
  assert.ok(
    entry.tags.includes("competitive"),
    "it is a ranked duel → competitive",
  );
  assert.ok(entry.tags.includes("fast_paced"), "it is a timed race → fast_paced");
  assert.ok(!entry.tags.includes("chance"), "nothing is drawn during play");
  assert.ok(
    !entry.tags.includes("casual"),
    "a ranked duel with a 52-card puzzle is not a pick-up game",
  );

  assert.ok(DEFAULT_GAME_ORDER.includes(KEY));
  assert.equal(GAME_CATALOG.filter((game) => game.id === KEY).length, 1);
});

test("discovery: the catalog and the lobby agree on Solitaire Duel's position", () => {
  const lobby = strip(read(LOBBY));
  const start = lobby.indexOf("  const games = [");
  const end = lobby.indexOf("\n  ];", start);
  const block = lobby.slice(start, end);
  const ids = [...block.matchAll(/leaderboardKey: "([^"]+)"/g)].map((m) => m[1]);

  assert.deepEqual(GAME_CATALOG.map((game) => game.id), ids);
  assert.equal(ids.filter((id) => id === KEY).length, 1);
});

test("discovery: the lobby card links to the lobby, records plays and is 1v1", () => {
  const src = strip(read(LOBBY));
  const start = src.indexOf('href: "/casino/solitaire-duel"');
  assert.ok(start > -1, "the lobby card must exist");
  const card = src.slice(Math.max(0, start - 80), start + 420);

  assert.match(card, /leaderboardKey: "solitaire-duel"/);
  assert.match(card, /playsKey: "solitaire-duel"/);
  assert.match(card, /pvpMode: "1v1"/);
  assert.match(card, /descriptionKey: "games.solitaire_duel_desc"/);
  assert.match(card, /nameKey: "games.solitaire_duel_name"/);
  assert.match(
    src,
    /import ImgSolitaireDuel from "\.\.\/\.\.\/images\/solitaire-duel-card\.svg"/,
  );
  assert.ok(
    fs.existsSync("src/images/solitaire-duel-card.svg"),
    "the card artwork must exist",
  );
  // It rides the existing "newest" ordering, without disturbing the games that
  // were already at its head.
  assert.match(src, /"solitaire-duel",\n/);
  assert.match(src, /const newestOrder = \[\n\s*"tic-tac-toe",\n\s*"speed-typing",/);
});

// ── 2. Presence ───────────────────────────────────────────────────────────

test("presence: the solitaire-duel gameLabel resolves to the canonical id", () => {
  assert.ok(PRESENCE_GAME_IDS.includes(KEY), "the id must come from GAME_CATALOG");
  assert.equal(isCanonicalGameId(KEY), true);
  assert.equal(isPresenceGame(KEY), true);
  assert.equal(resolveGameId(KEY), KEY);
  assert.equal(getTrophyGameLabel(KEY), "Solitaire Duel");
  assert.match(strip(read(PRESENCE)), /"solitaire-duel": "solitaire-duel",/);
});

test("presence: the lobby has a card to render the count on", () => {
  const lobby = strip(read(LOBBY));
  const ids = [...lobby.matchAll(/leaderboardKey: "([^"]+)"/g)].map((m) => m[1]);
  assert.ok(ids.includes(KEY), "the badge counts by leaderboardKey");
});

// ── 3. Rated settlement ───────────────────────────────────────────────────

test("rating: the key is in the ONE rating registry, and the trophy set is it", () => {
  assert.equal(isRatedGame(KEY), true);
  assert.ok(RATED_GAMES.includes(KEY));
  assert.equal(RATED_GAMES.filter((key) => key === KEY).length, 1);
  assert.equal(RATING_GAME_LABELS[KEY], "Solitaire Duel");
  // TROPHY_GAMES IS RATED_GAMES — one list, so the two can never drift.
  assert.deepEqual([...TROPHY_GAMES], [...RATED_GAMES]);
  assert.equal(isTrophyGame(KEY), true);

  // The first-paint leaderboard mirror must not drift from the registry.
  const classement = strip(read(CLASSEMENT));
  const mirror = classement.slice(
    classement.indexOf("const RATED_GAMES_FALLBACK = ["),
    classement.indexOf("];", classement.indexOf("const RATED_GAMES_FALLBACK = [")),
  );
  assert.match(mirror, /key: "solitaire-duel", label: "Solitaire Duel"/);
});

// ── 4. Sitemap ────────────────────────────────────────────────────────────

test("sitemap: the game is listed under its canonical /games path", () => {
  const src = strip(read(SITEMAP));
  assert.match(src, /solitaireDuelMatches,/);
  assert.match(
    src,
    /\{ path: "\/games\/solitaire-duel", source: \[solitaireDuelMatches, solitaireDuelMatches\.createdAt\] \}/,
  );
});

// ── 5. Ad convention ─────────────────────────────────────────────────────

test("ads: the lobby carries the tag and the live board never does", () => {
  assert.match(strip(read(LOBBY_PAGE)), /AdSenseScript/);
  const match = strip(read(MATCH_PAGE_ROUTE));
  assert.doesNotMatch(match, /AdSenseScript|AdSlot/);
});

// ── 6. Copy ───────────────────────────────────────────────────────────────

test("metadata: the lobby title and description state the format", () => {
  const src = strip(read(LOBBY_PAGE));
  assert.match(src, /title: "Solitaire Duel \| GRYND"/);
  const description = src.slice(src.indexOf("description:"), src.indexOf("export default"));
  for (const trait of [/1v1/, /deterministic/i, /no wagers/i]) {
    assert.match(description, trait, `metadata description must mention ${trait}`);
  }
});

test("metadata: the lobby card copy exists in every locale and states the format", () => {
  const src = strip(read(TRANSLATIONS));

  const nameLines = src.split("\n").filter((line) => line.includes("solitaire_duel_name:"));
  assert.equal(nameLines.length, 3, "solitaire_duel_name must exist for en/fr/es");
  for (const line of nameLines) {
    assert.match(line, /solitaire_duel_name: "Solitaire Duel"/);
  }

  const descLines = src.split("\n").filter((line) => line.includes("solitaire_duel_desc:"));
  assert.equal(descLines.length, 3, "solitaire_duel_desc must exist for en/fr/es");
  // Each locale states the format in its own words: a rated 1v1 race, the SAME
  // deal for both players, and the first to solve it (or the most progress)
  // winning.
  const formatPerLocale = [
    [/1v1/, /exact same Klondike deal/, /solve the whole puzzle first/i],
    [/1v1/, /exactement la même donne/, /résolvez toute la patience/i],
    [/1v1/, /exactamente el mismo reparto/, /resuelve todo el solitario/i],
  ];
  descLines.forEach((line, index) => {
    for (const trait of formatPerLocale[index]) {
      assert.match(line, trait, `locale ${index} description must mention ${trait}`);
    }
  });
});

// ── 7. The game's own surfaces stay economy-free ─────────────────────────

test("no economy: the platform surfaces expose no wager for this game", () => {
  const src = code(LOBBY);
  const card = src.slice(
    src.indexOf('href: "/casino/solitaire-duel"'),
    src.indexOf('href: "/casino/solitaire-duel"') + 420,
  );
  // The card carries no stake/bet/balance field at all.
  for (const forbidden of ["wager", "stake", "betAmount", "balance", "payout"]) {
    assert.equal(
      card.toLowerCase().includes(forbidden.toLowerCase()),
      false,
      `the lobby card must not carry a ${forbidden} concept`,
    );
  }
});
