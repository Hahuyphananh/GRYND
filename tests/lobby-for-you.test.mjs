// tests/lobby-for-you.test.mjs
//
// The casino lobby's "FOR YOU" section (src/app/casino/PageClient.jsx).
//
// The section is built from the recommendation engine, but the lobby is where
// it becomes a product decision, so this suite pins that decision:
//
//   * who sees it — only a signed-in player whose answers are personalized AND
//     complete, one request per mount, chained behind the onboarding-status
//     snapshot so an unanswered account costs nothing;
//   * where it lives — between the search/filter controls and All Games, above
//     the existing "Recently played" strip, hidden the moment the player
//     searches or picks a filter;
//   * how it renders — the lobby's OWN GameCard (no second card system), the
//     same responsive grid classes as All Games (so no horizontal overflow and
//     no layout regression), with localized copy only;
//   * that it fails closed — every failure shape leaves the lobby exactly as it
//     was, with All Games, its filters and its sorting untouched.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const {
  FOR_YOU_HINT_MESSAGE_KEY,
  FOR_YOU_MESSAGE_KEY,
  recommendGames,
  shouldShowPersonalizedSection,
} = await import("../src/lib/gameRecommendations.js");

const { GAME_CATALOG } = await import("../src/lib/gameTags.js");
const { t } = await import("../src/lib/appTextTranslations.js");

const LOBBY = "src/app/casino/PageClient.jsx";
const LOCALES = ["en", "fr", "es"];
/** The exact grid classes both the For You strip and All Games use. */
const GRID_CLASSES = "grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-6 lg:grid-cols-3 xl:grid-cols-4";

const lobby = fs.readFileSync(path.join(process.cwd(), LOBBY), "utf8").replace(/\r\n/g, "\n");

/** A complete questionnaire submission. */
const FULL_ANSWERS = {
  motivation: ["competition"],
  game_types: ["strategy", "pvp_duels"],
  experience: "experienced",
  priorities: ["ranking_up", "winning"],
  discovery: "tiktok",
};

const count = (haystack, needle) => haystack.split(needle).length - 1;

// Extracted regions, so assertions about placement can't be satisfied by an
// unrelated part of the file.
const forYouStart = lobby.indexOf("{showForYou && (");
const recentlyPlayedStart = lobby.indexOf('t("home.casino_lobby.recently_played")');
const allGamesHeading = lobby.indexOf('t("home.all_games")');
const forYouBlock = lobby.slice(forYouStart, recentlyPlayedStart);

// ── 1. Visibility: only a personalized, complete, signed-in player ────────

test("the four lobby scenarios render For You for exactly the right accounts", () => {
  const cases = [
    ["new user with preferences", recommendGames(FULL_ANSWERS), true],
    ["existing user with preferences", recommendGames(FULL_ANSWERS), true],
    ["existing user without preferences", recommendGames(null), false],
    ["logged-out user (API returns the default order)", recommendGames(null), false],
    ["incomplete preferences", recommendGames({ game_types: ["strategy"] }), false],
    ["answers with no usable signal", recommendGames({ motivation: ["variety"] }), false],
    ["API failure", null, false],
    ["API error response", { success: false, error: "Failed to load recommendations" }, false],
  ];
  const seen = new Set();
  for (const [name, payload, expected] of cases) {
    assert.equal(shouldShowPersonalizedSection(payload), expected, name);
    seen.add(expected);
  }
  // The table actually exercises both branches.
  assert.deepEqual([...seen].sort(), [false, true]);
});

test("the lobby asks for recommendations once, and only after onboarding says so", () => {
  // Exactly one recommendation request in the file (no per-card fetch).
  assert.equal(count(lobby, "/api/onboarding/recommendations"), 1);
  assert.match(
    lobby,
    /fetch\("\/api\/onboarding\/recommendations", \{ credentials: "include" \}\)/
  );
  // …and it never fires for a signed-out player or one who never answered.
  assert.match(
    lobby,
    /if \(!user \|\| !questionnaireAnswered\) \{\n\s+setForYou\(null\);\n\s+return;\n\s+\}/
  );
  assert.match(lobby, /setQuestionnaireAnswered\(ok && data\.questionnaireCompleted === true\);/);
  // The go/no-go decision comes from the engine, not from inline conditions.
  assert.match(lobby, /shouldShowPersonalizedSection\(data\)/);
});

test("the request happens in an effect, never during render (no hydration risk)", () => {
  const fetchIndex = lobby.indexOf('fetch("/api/onboarding/recommendations"');
  const effectIndex = lobby.lastIndexOf("useEffect(() => {", fetchIndex);
  const renderIndex = lobby.indexOf("\n  return (");
  assert.ok(effectIndex > -1 && effectIndex < fetchIndex, "fetch must sit inside a useEffect");
  assert.ok(renderIndex > fetchIndex, "fetch must run before the component returns JSX");
  // The JSX itself reads state only.
  assert.doesNotMatch(forYouBlock, /fetch\(/);
  assert.doesNotMatch(forYouBlock, /useEffect|useState/);
  // Server-rendered output is identical to the first client render: the state
  // starts empty, so nothing personalized is in the markup until the effect
  // resolves.
  assert.match(lobby, /const \[forYou, setForYou\] = useState\(null\);/);
  assert.match(
    lobby,
    /const \[questionnaireAnswered, setQuestionnaireAnswered\] = useState\(false\);/
  );
});

// ── 2. Fallbacks: every failure leaves the normal lobby ───────────────────

test("every failure path leaves For You unrendered", () => {
  // Signed out / not answered.
  assert.match(lobby, /setQuestionnaireAnswered\(false\);/);
  // Server said no (or the payload was unusable).
  assert.match(
    lobby,
    /if \(!shouldShowPersonalizedSection\(data\)\) \{\n\s+setForYou\(null\);\n\s+return;\n\s+\}/
  );
  // Network / JSON failure.
  assert.match(lobby, /\.catch\(\(\) => \{\n\s+if \(!cancelled\) setForYou\(null\);\n\s+\}\);/);
  // Status request failed → the flag stays false, so For You never loads.
  assert.match(
    lobby,
    /if \(!cancelled\) \{\n\s+setFirstBattle\(false\);\n\s+setQuestionnaireInvite\(false\);\n\s+setQuestionnaireAnswered\(false\);\n\s+\}/
  );
  // Ids that don't resolve to a real lobby game are dropped, and an empty
  // result hides the section.
  assert.match(
    lobby,
    /const forYouGames = \(forYou\?\.ids \?\? \[\]\)\n\s+\.map\(\(id\) => games\.find\(\(game\) => game\.leaderboardKey === id\)\)\n\s+\.filter\(Boolean\);/
  );
  assert.match(lobby, /\{showForYou && \(/);
});

// ── 3. Placement and the existing lobby ───────────────────────────────────

test("For You sits between the controls and All Games, above Recently played", () => {
  assert.ok(forYouStart > -1, "the For You section is not rendered");
  const controls = lobby.indexOf('t("home.casino_lobby.sort_by")');
  assert.ok(forYouStart > controls, "For You must sit below the search/filter/sort controls");
  assert.ok(allGamesHeading > forYouStart, "All Games must stay below For You");
  assert.ok(recentlyPlayedStart > forYouStart, "For You leads the games area");
  assert.ok(lobby.indexOf("<Footer />") > forYouStart);
});

test("All Games, its filters and its sorting are untouched", () => {
  // The full grid is still rendered from the existing derived list.
  assert.match(lobby, /let displayedGames = \[\.\.\.filteredGames\];/);
  assert.match(lobby, /\{displayedGames\.map\(\(game, index\) => \(/);
  assert.match(lobby, /t\("home\.all_games"\)/);
  assert.match(lobby, /t\("home\.casino_lobby\.no_results_title"\)/);
  // Filters…
  for (const key of ["filter_all", "filter_duels", "filter_multiplayer", "filter_popular"]) {
    assert.match(lobby, new RegExp(`labelKey: "home\\.casino_lobby\\.${key}"`));
  }
  // …and sorts, including the real play-count data behind "Most Played".
  for (const key of ["sort_featured", "sort_most_played", "sort_az", "sort_newest"]) {
    assert.match(lobby, new RegExp(`labelKey: "home\\.casino_lobby\\.${key}"`));
  }
  assert.match(lobby, /setActiveFilter\(btn\.key\)/);
  assert.match(lobby, /setSortOrder\(btn\.key\)/);
  assert.match(lobby, /fetch\("\/api\/game-plays", \{ cache: "no-store" \}\)/);
  // Ordering is derived from `games` exactly as before: the For You block
  // never sorts or mutates it.
  assert.doesNotMatch(forYouBlock, /\.sort\(/);
  assert.doesNotMatch(forYouBlock, /displayedGames/);
  // The existing onboarding surfaces still work alongside it.
  assert.match(lobby, /shouldShowQuestionnaireInvite\(\{/);
  assert.match(lobby, /href="\/welcome\/questionnaire\?from=lobby"/);
  assert.match(lobby, /onClick=\{dismissQuestionnaireInvite\}/);
  assert.match(lobby, /t\("onboarding\.firstMatch\.lobbyCta"\)/);
});

test("the section hides as soon as the player searches or filters", () => {
  assert.match(
    lobby,
    /const showForYou =\n\s+forYouGames\.length > 0 && search\.trim\(\)\.length === 0 && activeFilter === "all";/
  );
  // The same rule the existing "Recently played" strip uses.
  assert.match(
    lobby,
    /\{search\.trim\(\)\.length === 0 &&\n\s+activeFilter === "all" &&\n\s+recentGames\.length > 0 && \(/
  );
});

// ── 4. Reuses the existing card + layout ─────────────────────────────────

test("For You reuses the lobby's GameCard instead of a second card system", () => {
  assert.ok(forYouStart > -1);
  // One card component in the file, defined once…
  assert.equal(count(lobby, "const GameCard = ("), 1);
  assert.doesNotMatch(lobby, /const (ForYouCard|RecommendedCard|LobbyCard) =/);
  // …and the section renders it with the recommendation marker.
  assert.match(forYouBlock, /<GameCard game=\{game\} recommended \/>/);
  assert.match(forYouBlock, /forYouGames\.map\(\(game\) => \(/);
  // The marker is opt-in, so All Games cards are unchanged.
  assert.match(lobby, /const GameCard = \(\{ game, recommended = false \}\) => \(/);
  assert.match(lobby, /\{recommended && \(/);
  assert.match(lobby, /t\("home\.casino_lobby\.recommended_badge"\)/);
});

test("For You uses the same responsive grid as All Games (mobile-safe)", () => {
  // Identical grid classes → identical card widths and breakpoints; the
  // existing root already clips horizontal overflow.
  assert.equal(count(lobby, GRID_CLASSES), 2, "For You and All Games must share one grid recipe");
  assert.match(lobby, /relative min-h-screen overflow-x-clip/);
  // Nothing in the section can overflow horizontally: no scroller of its own,
  // no fixed-width cards (unlike the Recently played carousel).
  assert.doesNotMatch(forYouBlock, /overflow-x-auto|shrink-0|w-\d|min-w-\[/);
  assert.ok(forYouGamesAreCounted());
});

/** The section renders at most the engine's primary picks — a handful of
 *  cards, never the whole grid (the requirement is "do not duplicate the
 *  entire games grid"). */
function forYouGamesAreCounted() {
  const primary = recommendGames(FULL_ANSWERS).primaryGameIds;
  return primary.length > 0 && primary.length <= 4 && primary.length < GAME_CATALOG.length;
}

// ── 5. Localization ──────────────────────────────────────────────────────

test("every string the section renders is localized, in all three locales", () => {
  for (const locale of LOCALES) {
    for (const key of [
      FOR_YOU_MESSAGE_KEY,
      FOR_YOU_HINT_MESSAGE_KEY,
      "home.casino_lobby.recommended_badge",
    ]) {
      assert.notEqual(t(locale, key), key, `${locale} is missing ${key}`);
    }
  }
  assert.equal(t("en", "home.casino_lobby.recommended_badge"), "Recommended");
  // The copy comes from the translation system and the engine's key
  // constants — never a literal English string in the lobby.
  assert.match(forYouBlock, /t\(FOR_YOU_MESSAGE_KEY\)/);
  assert.match(
    forYouBlock,
    /forYou\?\.messageKey \? t\(forYou\.messageKey\) : t\(FOR_YOU_HINT_MESSAGE_KEY\)/
  );
  assert.doesNotMatch(forYouBlock, />(For you|Recommended|Your picks)</);
  assert.match(
    lobby,
    /import \{\n\s+FOR_YOU_HINT_MESSAGE_KEY,\n\s+FOR_YOU_MESSAGE_KEY,\n\s+shouldShowPersonalizedSection,\n\} from "\.\.\/\.\.\/lib\/gameRecommendations";/
  );
});
