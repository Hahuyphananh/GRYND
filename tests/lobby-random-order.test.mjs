// tests/lobby-random-order.test.mjs
//
// The casino lobby's random "Featured" order (src/app/casino/PageClient.jsx).
//
// The lobby now reshuffles the All Games grid, the "For You" picks and the
// "Recently played" strip once per visit, so a returning player sees a fresh
// order instead of the same wall. Two things make that a product decision
// rather than a one-liner, and both are pinned here:
//
//   * hydration — the All Games grid is server-rendered, so a shuffle during
//     render would produce different HTML on the server and the client. The
//     order must therefore be applied AFTER mount (state starts null, the
//     shuffle lives in an effect), and the first paint keeps the catalog order;
//   * boundaries — each shuffle happens exactly once, when that section's data
//     lands (never during render), and the explicit sorts the player picks
//     (A–Z, Most played, Newest) stay deterministic.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const { t } = await import("../src/lib/appTextTranslations.js");

const LOBBY = "src/app/casino/PageClient.jsx";

const lobby = fs.readFileSync(path.join(process.cwd(), LOBBY), "utf8").replace(/\r\n/g, "\n");

test("the grid order is shuffled on the client, after hydration", () => {
  // A Fisher–Yates shuffle exists (unbiased, over a copy).
  assert.match(lobby, /function shuffledCopy\(items, random = Math\.random\) \{/);
  assert.match(lobby, /for \(let i = out\.length - 1; i > 0; i -= 1\) \{/);
  assert.match(lobby, /const j = Math\.floor\(random\(\) \* \(i \+ 1\)\);/);
  // …and the state starts empty so the server HTML and the first client render
  // agree — a `useState(() => shuffle(...))` initializer would hydrate wrong.
  assert.match(lobby, /const \[featuredOrder, setFeaturedOrder\] = useState\(null\);/);
  assert.doesNotMatch(lobby, /useState\(\s*\(\)\s*=>\s*shuffledCopy/);
});

test("the shuffle runs once per visit, in an effect — never during render", () => {
  const callIndex = lobby.indexOf("setFeaturedOrder(shuffledCopy(games)");
  assert.ok(callIndex > -1, "the shuffle is never applied");
  const effectIndex = lobby.lastIndexOf("useEffect(() => {", callIndex);
  assert.ok(effectIndex > -1 && effectIndex < callIndex, "the shuffle must sit in a useEffect");
  // The effect is mount-once: an empty dependency list, not a re-render loop.
  assert.match(
    lobby,
    /useEffect\(\(\) => \{\n\s+setFeaturedOrder\(shuffledCopy\(games\)\.map\(\(game\) => game\.leaderboardKey\)\);\n[\s\S]*?\n\s+\}, \[\]\);/
  );
  // The rendered order is derived from state, not from Math.random() in JSX.
  const renderIndex = lobby.indexOf("\n  return (");
  assert.ok(renderIndex > callIndex);
  assert.doesNotMatch(lobby.slice(renderIndex), /shuffledCopy|Math\.random/);
});

test("the sort chip says the order is random, in every locale", () => {
  const key = "home.casino_lobby.sort_featured";
  for (const locale of ["en", "fr", "es"]) {
    assert.notEqual(t(locale, key), key, `${locale} is missing ${key}`);
    assert.notEqual(t(locale, key).toLowerCase(), "featured", `${locale} still says Featured`);
  }
  assert.equal(t("en", key), "Random");
  // The chip still points at the "featured" key, so no persisted preference breaks.
  assert.match(lobby, /\{ key: "featured", labelKey: "home\.casino_lobby\.sort_featured" \}/);
});

test("the random order applies to the Random grid only, and covers every game", () => {
  // The default branch of the sort switch.
  assert.match(lobby, /if \(sortOrder === "featured" && featuredOrder\) \{/);
  // It ranks by the shuffled key list, so every displayed game is placed and
  // none is dropped or duplicated.
  assert.match(
    lobby,
    /const rank = new Map\(featuredOrder\.map\(\(key, index\) => \[key, index\]\)\);/
  );
  assert.match(
    lobby,
    /displayedGames\.sort\(\n\s+\(a, b\) => \(rank\.get\(a\.leaderboardKey\) \?\? 0\) - \(rank\.get\(b\.leaderboardKey\) \?\? 0\),\n\s+\);/
  );
});

test("the explicit sorts stay deterministic — the player asked for them", () => {
  for (const branch of ['sortOrder === "az"', 'sortOrder === "newest"', 'sortOrder === "most-played"']) {
    assert.match(lobby, new RegExp(`else if \\(${branch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`));
  }
  assert.match(lobby, /displayedGames\.sort\(\(a, b\) =>\n\s+\(a\.nameKey \? t\(a\.nameKey\) : a\.name\)\.localeCompare\(/);
  assert.match(lobby, /newestOrder\.indexOf\(a\.leaderboardKey\) - newestOrder\.indexOf\(b\.leaderboardKey\)/);
  assert.match(lobby, /Number\(playCounts\?\.\[a\.playsKey\] \?\? 0\)/);
});

test("For You shuffles its picks once per visit, when the ranking lands", () => {
  // The shuffle happens while building the state payload, inside the fetch
  // effect — one roll per visit, not one per render.
  assert.match(lobby, /ids: shuffledCopy\(data\.primaryGameIds\),/);
  const idsIndex = lobby.indexOf("ids: shuffledCopy(data.primaryGameIds)");
  const effectIndex = lobby.lastIndexOf("useEffect(() => {", idsIndex);
  assert.ok(effectIndex > -1 && effectIndex < idsIndex, "the shuffle must sit in a useEffect");
  assert.ok(lobby.indexOf("\n  return (") > idsIndex, "it must run before the component returns JSX");
  // The section renders the stored (already shuffled) ids, in that order, using
  // the shared GameCard grid — and never touches the array again.
  const forYouStart = lobby.indexOf("{showForYou && (");
  const recentlyPlayedStart = lobby.indexOf('t("home.casino_lobby.recently_played")');
  assert.ok(forYouStart > -1 && recentlyPlayedStart > forYouStart);
  const forYouBlock = lobby.slice(forYouStart, recentlyPlayedStart);
  assert.doesNotMatch(forYouBlock, /shuffledCopy|Math\.random/);
  assert.match(
    lobby,
    /const forYouGames = \(forYou\?\.ids \?\? \[\]\)\n\s+\.map\(\(id\) => games\.find\(\(game\) => game\.leaderboardKey === id\)\)\n\s+\.filter\(Boolean\);/
  );
});

test("the Recently played strip is shuffled once per visit, on mount", () => {
  assert.match(lobby, /setRecentGames\(shuffledCopy\(getPlayedGames\(\)\)\);/);
  const callIndex = lobby.indexOf("setRecentGames(shuffledCopy(getPlayedGames())");
  const effectIndex = lobby.lastIndexOf("useEffect(() => {", callIndex);
  assert.ok(effectIndex > -1 && effectIndex < callIndex, "the shuffle must sit in a useEffect");
  assert.ok(lobby.indexOf("\n  return (") > callIndex, "it must run before the component returns JSX");
  // The strip renders the stored order — the render-time guard above proves
  // there is no shuffle in the JSX.
});
