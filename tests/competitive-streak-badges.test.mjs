/**
 * competitive-streak-badges.test.mjs
 *
 * Pins Phase 9: two independent ranked win-streak badges.
 *   * Solitaire Ranked reads `solitaire-duel`;
 *   * Puzzle Ranked reads `solitaire-puzzle`;
 *   * current and best are always separate, and never combined across keys;
 *   * a loss zeros the current value but preserves the personal best;
 *   * a draw also zeros the current value for both seats and preserves best;
 *   * both profiles and both finalized result screens show the right key.
 *
 * Run: node --import tsx --test tests/competitive-streak-badges.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { APP_TEXT_TRANSLATIONS } from "../src/lib/appTextTranslations.js";
import {
  COMPETITIVE_STREAK_GAME_KEYS,
  normalizeCompetitiveStreaks,
} from "../src/lib/competitiveStreakModel.ts";

const read = (path) => fs.readFileSync(path, "utf8");
const model = read("src/lib/competitiveStreakModel.ts");
const writer = read("src/lib/competitiveStreak.ts");
const apiRoute = read("src/app/api/streaks/competitive/route.ts");
const badge = read("src/components/profil/CompetitiveStreakBadge.tsx");
const resultBadge = read("src/components/profil/CompetitiveStreakResultBadge.tsx");
const ownerProfile = read("src/app/profil/PageClient.jsx");
const publicProfile = read("src/app/profil/[clerkId]/PageClient.tsx");
const tokenRoute = read("src/app/api/get-user-tokens/route.ts");
const publicRoute = read("src/app/api/user/public-profile/route.ts");
const duelPage = read("src/app/casino/solitaire-duel/[matchId]/PageClient.tsx");
const duelStore = read("src/lib/solitaire-duel/serverStore.ts");
const puzzlePlayer = read("src/components/play/PuzzleSessionPlayer.tsx");
const puzzleSettlement = read("src/lib/solitaire-puzzle/settlement.ts");
const puzzleConstants = read("src/lib/solitaire-puzzle/constants.ts");

function resolve(locale, key) {
  return key.split(".").reduce((node, part) => node?.[part], locale);
}

test("the two supported keys are independent and zero-filled", () => {
  assert.deepEqual([...COMPETITIVE_STREAK_GAME_KEYS], [
    "solitaire-duel",
    "solitaire-puzzle",
  ]);

  const streaks = normalizeCompetitiveStreaks(
    [
      { gameKey: "solitaire-duel", current: 5, best: 12 },
      { gameKey: "solitaire-puzzle", current: 0, best: 4 },
      // An unexpected game must never leak into either supported ladder.
      { gameKey: "some-other-game", current: 99, best: 99 },
    ],
    COMPETITIVE_STREAK_GAME_KEYS,
  );

  assert.deepEqual(streaks["solitaire-duel"], { current: 5, best: 12 });
  assert.deepEqual(streaks["solitaire-puzzle"], { current: 0, best: 4 });
  assert.equal(streaks["some-other-game"], undefined);

  assert.deepEqual(normalizeCompetitiveStreaks(null), {
    "solitaire-duel": { current: 0, best: 0 },
    "solitaire-puzzle": { current: 0, best: 0 },
  });

  // Corrupt data cannot produce a best below the current streak.
  assert.deepEqual(
    normalizeCompetitiveStreaks([
      { gameKey: "solitaire-duel", current: 12, best: 5 },
    ])["solitaire-duel"],
    { current: 12, best: 12 },
  );
});

test("the writer increments wins, zeros losses/draws, and preserves best", () => {
  assert.match(
    writer,
    /if \(outcome !== "win" && outcome !== "loss" && outcome !== "draw"\) return false/,
  );
  assert.match(
    writer,
    /WHEN \$\{isWin\} THEN "user_competitive_streaks"\."current_streak" \+ 1/,
  );
  assert.match(writer, /ELSE 0/);
  assert.match(writer, /"best_streak" = GREATEST/);
  assert.match(
    writer,
    /ELSE "user_competitive_streaks"\."best_streak"/,
  );
  assert.match(writer, /ON CONFLICT \("match_id", "user_id", "game_key"\) DO NOTHING/);
});

test("each settlement writes its own game key and records both seats on a draw", () => {
  assert.match(duelStore, /gameKey: "solitaire-duel"/);
  assert.match(puzzleSettlement, /gameKey: PUZZLE_RANKED_GAME_KEY/);
  assert.match(puzzleConstants, /PUZZLE_RANKED_GAME_KEY = "solitaire-puzzle"/);
  assert.match(model, /"solitaire-duel"/);
  assert.match(model, /"solitaire-puzzle"/);

  for (const [name, source, marker, player] of [
    ["solitaire-duel", duelStore, "if (outcome.result === RESULT.DRAW)", "match"],
    [
      "solitaire-puzzle",
      puzzleSettlement,
      "if (snapshot.result === PUZZLE_SESSION_RESULT.DRAW)",
      "snapshot",
    ],
  ]) {
    const drawAt = source.indexOf(marker);
    const returnAt = source.indexOf("return;", drawAt);
    assert.ok(drawAt >= 0, `${name} must branch on a draw`);
    const drawBlock = source.slice(drawAt, returnAt);
    assert.equal(
      (drawBlock.match(/outcome: "draw"/g) ?? []).length,
      2,
      `${name} must record the draw for both seats`,
    );
    assert.match(drawBlock, new RegExp(`clerkId: ${player}\\.player1Id`));
    assert.match(drawBlock, new RegExp(`clerkId: ${player}\\.player2Id`));
  }
});

test("the profile read is one authoritative query keyed to the target player", () => {
  assert.match(writer, /from\(userCompetitiveStreaks\)/);
  assert.match(writer, /innerJoin\(users, eq\(users\.id, userCompetitiveStreaks\.userId\)\)/);
  assert.match(writer, /eq\(users\.clerkId, clerkId\)/);
  assert.match(writer, /inArray\(userCompetitiveStreaks\.gameKey, \[\.\.\.gameKeys\]\)/);
  assert.match(writer, /normalizeCompetitiveStreaks\(rows, gameKeys\)/);
});

test("the dedicated API returns both ladders and is read-only", () => {
  assert.match(apiRoute, /readCompetitiveStreaksForClerkId\(userId\)/);
  assert.match(apiRoute, /signedIn: false/);
  assert.match(apiRoute, /streaks/);
  assert.doesNotMatch(
    apiRoute,
    /\brecordCompetitiveResult\s*\(|\bINSERT\s+INTO|\bUPDATE\s+|\bDELETE\s+FROM/,
  );
});

test("both profile APIs expose the map, and both profiles render two badges", () => {
  for (const [name, source] of [
    ["get-user-tokens", tokenRoute],
    ["public-profile", publicRoute],
  ]) {
    assert.match(source, /readCompetitiveStreaksForClerkId\(clerkId\)/, `${name} must read both keys`);
    assert.match(source, /competitiveStreaks/, `${name} must expose the map`);
  }

  for (const [name, source] of [
    ["owner profile", ownerProfile],
    ["public profile", publicProfile],
  ]) {
    assert.match(source, /CompetitiveStreakBadge/, `${name} must render the badge`);
    assert.match(source, /gameKey="solitaire-duel"/, `${name} must render Solitaire Ranked`);
    assert.match(source, /gameKey="solitaire-puzzle"/, `${name} must render Puzzle Ranked`);
  }
});

test("zero current is inactive copy while the personal best still renders", () => {
  assert.match(badge, /data-game-key=\{gameKey\}/);
  assert.match(badge, /competitiveNoCurrent/);
  assert.match(badge, /competitiveBest/);
  assert.match(badge, /currentCount > 0/);
  assert.match(badge, /cyan/);
  assert.match(badge, /fuchsia/);
  assert.doesNotMatch(badge, /PlayerLevelBadge|DailyStreakRecordBadge/);
  assert.doesNotMatch(badge, /fetch\(/);
});

test("finalized ranked results show the matching key without blocking the result", () => {
  assert.match(duelPage, /CompetitiveStreakResultBadge/);
  assert.match(duelPage, /gameKey="solitaire-duel"/);
  assert.match(puzzlePlayer, /CompetitiveStreakResultBadge/);
  assert.match(puzzlePlayer, /gameKey="solitaire-puzzle"/);
  assert.match(resultBadge, /fetch\("\/api\/streaks\/competitive"/);
  assert.doesNotMatch(resultBadge, /setInterval|requestAnimationFrame/);
});

test("all badge copy exists in EN, FR and ES", () => {
  const expected = {
    en: {
      solitaire: "Solitaire Ranked",
      puzzle: "Puzzle Ranked",
      current: "Current: {count} {unit}",
      best: "Personal best: {count} {unit}",
      noCurrent: "No active streak",
      win: "win",
      wins: "wins",
      aria: "{game} win streak — {current}; {best}",
    },
    fr: {
      solitaire: "Solitaire classé",
      puzzle: "Puzzle classé",
      current: "Actuel : {count} {unit}",
      best: "Record personnel : {count} {unit}",
      noCurrent: "Aucune série active",
      win: "victoire",
      wins: "victoires",
      aria: "{game} — série de victoires : {current} ; {best}",
    },
    es: {
      solitaire: "Solitaire clasificado",
      puzzle: "Puzzle clasificado",
      current: "Actual: {count} {unit}",
      best: "Mejor personal: {count} {unit}",
      noCurrent: "Sin racha activa",
      win: "victoria",
      wins: "victorias",
      aria: "{game} — racha de victorias: {current}; {best}",
    },
  };

  const keys = {
    solitaire: "profile.badges.competitiveSolitaire",
    puzzle: "profile.badges.competitivePuzzle",
    current: "profile.badges.competitiveCurrent",
    best: "profile.badges.competitiveBest",
    noCurrent: "profile.badges.competitiveNoCurrent",
    win: "profile.badges.competitiveWin",
    wins: "profile.badges.competitiveWins",
    aria: "profile.badges.competitiveAria",
  };

  for (const [lang, copy] of Object.entries(expected)) {
    for (const [field, key] of Object.entries(keys)) {
      assert.equal(
        resolve(APP_TEXT_TRANSLATIONS[lang], key),
        copy[field],
        `${lang} ${key} drifted`,
      );
    }
  }
});
