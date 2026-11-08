/**
 * Solitaire-first regression contract.
 *
 * GRYND presents Solitaire Duel as its only public game. Archived games keep
 * their source, assets, tables and history; they are closed at the discovery
 * and route boundaries, not deleted.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  ARCHIVED_LANDING_SLUGS,
  GAME_UNAVAILABLE_MESSAGE,
  isArchivedGameApiPath,
  isArchivedGamePath,
  isGameArchived,
  isGameAvailable,
} from "../src/lib/gameAvailability.js";
import { GAME_CATALOG } from "../src/lib/gameTags.js";
import { GAME_LANDING_PAGES } from "../src/lib/gameLandingPages.ts";
import { RATED_GAMES } from "../src/lib/rating.js";

const read = (path) => fs.readFileSync(path, "utf8");
const nav = read("src/components/navigation-bar.jsx");
const home = read("src/app/PageClient.jsx");
const lobby = read("src/app/casino/PageClient.jsx");
const solitaireLobby = read("src/app/casino/solitaire-duel/PageClient.tsx");
const solitaireRoute = read("src/app/api/solitaire-duel/create-or-join/route.ts");
const classement = read("src/app/classement/PageClient.jsx");

test("Solitaire Duel is the only publicly available game", () => {
  const available = GAME_CATALOG.filter((game) => isGameAvailable(game.id)).map(
    (game) => game.id,
  );
  assert.deepEqual(available, ["solitaire-duel"]);
  assert.equal(GAME_CATALOG.length > 1, true, "the implementations are preserved");
});

test("every other catalogue game is archived, not deleted", () => {
  for (const game of GAME_CATALOG) {
    if (game.id === "solitaire-duel") {
      assert.equal(isGameArchived(game.id), false);
    } else {
      assert.equal(isGameArchived(game.id), true, `${game.id} must be archived`);
    }
  }
  // Historical rating keys survive in the registry.
  assert.ok(RATED_GAMES.includes("solitaire-duel"));
  assert.ok(RATED_GAMES.includes("chess"));
});

test("archived landing pages keep their catalogue entries for reactivation", () => {
  const archivedPages = GAME_LANDING_PAGES.filter((page) =>
    isGameArchived(page.leaderboardKey),
  );
  assert.ok(archivedPages.length > 0);
  for (const page of archivedPages) {
    assert.ok(ARCHIVED_LANDING_SLUGS.includes(page.slug), `${page.slug} route must close`);
  }
  assert.equal(
    GAME_LANDING_PAGES.some((page) => page.slug === "solitaire-duel"),
    true,
  );
});

test("direct routes for archived games are intercepted, Solitaire is not", () => {
  for (const slug of ARCHIVED_LANDING_SLUGS) {
    assert.equal(isArchivedGamePath(`/games/${slug}`), true, `/games/${slug}`);
    assert.equal(isArchivedGamePath(`/casino/${slug}`), true, `/casino/${slug}`);
  }
  assert.equal(isArchivedGamePath("/games/solitaire-duel"), false);
  assert.equal(isArchivedGamePath("/casino/solitaire-duel"), false);
  assert.equal(isArchivedGamePath("/casino/solitaire-duel/abc"), false);
  assert.equal(isArchivedGamePath("/games"), false);
  assert.equal(isArchivedGamePath("/classement"), false);
});

test("game-specific APIs for archived games are closed", () => {
  for (const prefix of [
    "keno-pvp",
    "uno",
    "rps",
    "lane-rush-duel",
    "hillstrike",
    "chess",
    "battleship",
    "tower-arena",
    "mines-pvp",
  ]) {
    assert.equal(isArchivedGameApiPath(`/api/${prefix}/start`), true, prefix);
  }
  assert.equal(isArchivedGameApiPath("/api/solitaire-duel/create-or-join"), false);
  assert.equal(isArchivedGameApiPath("/api/leaderboard/trophy"), false);
  assert.equal(isArchivedGameApiPath("/api/user-stats"), false);
});

test("unavailable copy points at Solitaire and exposes no internals", () => {
  assert.match(GAME_UNAVAILABLE_MESSAGE, /Solitaire Duel/);
  assert.doesNotMatch(GAME_UNAVAILABLE_MESSAGE, /keno|rps|uno|hillstrike|lane/i);
});

test("navigation is Solitaire-first and carries no coin, shop or rewards UI", () => {
  assert.match(nav, /\/games\/solitaire-duel/);
  assert.match(nav, /\/classement/);
  assert.doesNotMatch(nav, /nav-coins/);
  assert.doesNotMatch(nav, /IconCoins/);
  assert.doesNotMatch(nav, /\/rewards/);
  assert.doesNotMatch(nav, /\/upgrade-pro/);
  assert.doesNotMatch(nav, /QuestNavBadge/);
});

test("home page sells Solitaire, not a game catalogue or an economy", () => {
  assert.match(home, /The competitive home/);
  assert.match(home, /\/games\/solitaire-duel/);
  assert.doesNotMatch(home, /Coins|coin balance|DailyReward|QuestWidget|UpgradePro/);
  assert.doesNotMatch(home, /\/games\/chess|\/games\/keno|\/games\/rps/);
});

test("the games hub no longer mounts reward, quest or membership widgets", () => {
  assert.doesNotMatch(lobby, /DailyRewardWidget/);
  assert.doesNotMatch(lobby, /QuestWidget/);
  assert.doesNotMatch(lobby, /UpgradeProButton/);
});

test("ranked Solitaire requires no stake, coins or wager", () => {
  assert.doesNotMatch(solitaireRoute, /requireStake/);
  assert.doesNotMatch(solitaireRoute, /body\?\.stake/);
  assert.match(solitaireRoute, /createOrJoin\(\{ userId, stake: 0 \}\)/);
  assert.doesNotMatch(solitaireLobby, /wager=/);
  assert.doesNotMatch(solitaireLobby, /body: JSON\.stringify\(\{ stake \}\)/);
  assert.match(solitaireLobby, /Free ranked play/);
});

test("the public rankings mirror is Solitaire-only but keeps historical ratings", () => {
  assert.match(classement, /AVAILABLE_RATED_GAMES/);
  assert.match(classement, /isGameAvailable\(game\.key\)/);
  assert.ok(RATED_GAMES.includes("keno-pvp"), "archived rating history stays");
});

test("trophy infrastructure remains wired for Solitaire", () => {
  const trophies = read("src/lib/trophies.js");
  assert.match(trophies, /solitaire-duel|RATED_GAMES|isTrophyGame/);
  const store = read("src/lib/solitaire-duel/serverStore.ts");
  assert.match(store, /troph|rating|apply/i);
});
