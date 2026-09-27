/**
 * mini-golf-competitive.test.mjs
 *
 * Mini Golf's integration into the EXISTING GRYND competitive systems:
 *   * the rated-game registry (`RATED_GAMES` in src/lib/rating.js) — Mini Golf
 *     must be a normal member, with no second registry of its own
 *   * the shared Elo writer (`applyRatingResult`) and trophy writer
 *     (`applyTrophyResult`) — behaviour tests live beside the harnesses that
 *     already exercise them (tests/elo-rating.test.mjs /
 *     tests/trophy-system.test.mjs); this file pins the wiring and the
 *     settlement contract
 *   * the existing leaderboard infrastructure, which derives its game list from
 *     the one registry
 *   * the authoritative settlement point in `src/lib/mini-golf/serverStore.ts`
 *     (only a completed match settles, exactly once) and the AI/practice guard
 *   * the anti-cheat chain: only { angle, power, expectedVersion } ever reach
 *     the server store, and no route reads a client-supplied winner / rating /
 *     trophies / hole wins / match result
 *
 * Run:  node --import tsx --test tests/mini-golf-competitive.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  RATED_GAMES,
  RATING_GAME_LABELS,
  isRatedGame,
  getRatingGameLabel,
  normalizeRatingGameKey,
} from "../src/lib/rating.js";
import {
  TROPHY_GAMES,
  isTrophyGame,
  getTrophyGameLabel,
  normalizeTrophyGameKey,
} from "../src/lib/trophies.js";
import { listTrophyGames } from "../src/lib/trophyStore.js";

const read = (path) => fs.readFileSync(path, "utf8");

const STORE = "src/lib/mini-golf/serverStore.ts";
const STORE_SRC = read(STORE);

// ════════════════════════════════════════════════════════════════════════
// 1. Rated-game registry — Mini Golf is a normal member
// ════════════════════════════════════════════════════════════════════════

test("registry: mini-golf is a rated game under the canonical key", () => {
  assert.equal(isRatedGame("mini-golf"), true);
  assert.equal(normalizeRatingGameKey("mini-golf"), "mini-golf");
});

test("registry: the display name is exactly \"Mini Golf\"", () => {
  assert.equal(getRatingGameLabel("mini-golf"), "Mini Golf");
  assert.equal(RATING_GAME_LABELS["mini-golf"], "Mini Golf");
});

test("registry: mini-golf appears exactly once (no duplicate entry)", () => {
  assert.equal(RATED_GAMES.filter((key) => key === "mini-golf").length, 1);
});

test("registry: trophies reuse the SAME game set as Elo (no drift)", () => {
  assert.deepEqual([...TROPHY_GAMES], [...RATED_GAMES]);
  assert.equal(isTrophyGame("mini-golf"), true);
  assert.equal(normalizeTrophyGameKey("mini-golf"), "mini-golf");
  assert.equal(getTrophyGameLabel("mini-golf"), "Mini Golf");
});

test("registry: mini-golf is NOT registered by any second list", () => {
  // A Mini Golf-specific registry would be drift. The store must speak the
  // shared game key and nothing must declare a competing rated-games list.
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".next") continue;
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx|js|jsx)$/.test(entry.name)) continue;
      const src = read(full);
      if (/MINI_GOLF_RATED_GAMES|RATED_GAMES_MINI_GOLF|miniGolfRatedGames/.test(src)) {
        offenders.push(full);
      }
    }
  };
  walk("src");
  assert.deepEqual(offenders, []);
});

// ════════════════════════════════════════════════════════════════════════
// 2. Leaderboard infrastructure — available through the existing boards
// ════════════════════════════════════════════════════════════════════════

test("leaderboard: the per-game Elo board derives its game list from RATED_GAMES", () => {
  const src = read("src/app/api/leaderboard/game/route.js");
  assert.match(src, /RATED_GAMES/);
  assert.match(src, /games: RATED_GAMES\.map\(/);
  assert.match(src, /getRatingGameLabel/);
  assert.doesNotMatch(src, /mini-golf/); // it must not special-case the game
});

test("leaderboard: the per-game trophy board derives its game list from TROPHY_GAMES", () => {
  const src = read("src/app/api/leaderboard/trophy/route.js");
  assert.match(src, /listTrophyGames/);
  assert.doesNotMatch(src, /mini-golf/);
});

test("leaderboard: listTrophyGames exposes Mini Golf with the right key and label", () => {
  const games = listTrophyGames();
  const entry = games.find((g) => g.key === "mini-golf");
  assert.ok(entry, "Mini Golf must appear in the trophy game picker");
  assert.equal(entry.label, "Mini Golf");
  // Exactly one entry, mirroring the registry.
  assert.equal(games.filter((g) => g.key === "mini-golf").length, 1);
  assert.deepEqual(
    games.map((g) => g.key),
    [...RATED_GAMES],
  );
});

test("leaderboard: the client fallback list includes Mini Golf (never drifts)", () => {
  const src = read("src/app/classement/PageClient.jsx");
  assert.match(src, /key: "mini-golf", label: "Mini Golf"/);
});

// ════════════════════════════════════════════════════════════════════════
// 3. Settlement contract — the shared writers, at the completion point
// ════════════════════════════════════════════════════════════════════════

test("settlement: the store uses the shared Elo + trophy writers, not its own", () => {
  assert.match(STORE_SRC, /import\s*\{[^}]*applyRatingResult[^}]*\}\s*from\s*"\.\.\/rating"/);
  assert.match(STORE_SRC, /import\s*\{[^}]*applyTrophyResult[^}]*\}\s*from\s*"\.\.\/trophyStore"/);
  // No mini-golf-specific Elo or trophy maths may exist.
  assert.doesNotMatch(STORE_SRC, /computeMatchRatings|K_FACTORS|expectedScore/);
  assert.doesNotMatch(STORE_SRC, /TROPHY_WIN|applyTrophyDelta|trophyDeltaForOutcome/);
});

test("settlement: both writers are called with the canonical game key", () => {
  const matches = STORE_SRC.match(/gameKey:\s*"mini-golf"/g) ?? [];
  // Two writers × (win path + draw path) = four call sites, all keyed.
  assert.ok(matches.length >= 4, `expected >= 4 gameKey sites, got ${matches.length}`);
});

test("settlement: a match settles only when the server derives the final outcome", () => {
  // The outcome is produced from the completed state, never from the request.
  assert.match(STORE_SRC, /const outcome = applied\.matchCompleted/);
  assert.match(STORE_SRC, /computeMatchResult\(nextState\)/);
  // Settlement is inside the `if (outcome)` branch, after the row update.
  const branchIndex = STORE_SRC.indexOf("if (outcome) {");
  const settleIndex = STORE_SRC.indexOf("await settleMatch(tx, match, outcome)");
  assert.ok(branchIndex !== -1, "the outcome branch must exist");
  assert.ok(settleIndex > branchIndex, "settlement must live inside the outcome branch");
});

test("settlement: an unfinished match never reaches settlement", () => {
  // `shoot` returns before the outcome branch while the match is still live:
  // `outcome` is only non-null when `applied.matchCompleted` is true.
  assert.match(STORE_SRC, /applied\.matchCompleted\s*\?[\s\S]*?:\s*null/);
});

test("settlement: forfeit and disconnect only settle an ACTIVE match", () => {
  // forfeit requires PLAYING…
  assert.match(STORE_SRC, /match\.status !== MATCH_STATUS\.PLAYING/);
  // …and disconnect treats a terminal match as an idempotent no-op.
  assert.match(
    STORE_SRC,
    /match\.status === MATCH_STATUS\.FINISHED\s*\|\|\s*match\.status === MATCH_STATUS\.CANCELLED/,
  );
  assert.match(STORE_SRC, /return \{ match, forfeited: false, cancelled: false \}/);
});

test("settlement: an open lobby is released without any rating/trophy write", () => {
  // The cancel branch (waiting, no opponent) never calls settleMatch.
  const cancelStart = STORE_SRC.indexOf("if (match.status === MATCH_STATUS.WAITING || !seats.player2Id) {");
  assert.ok(cancelStart !== -1);
  const cancelEnd = STORE_SRC.indexOf("await settleMatch", cancelStart);
  const nextSettle = cancelEnd === -1 ? Infinity : cancelEnd;
  // Between the waiting-branch start and the next settleMatch call there must be
  // a `return` — the lobby path exits before any settlement.
  assert.match(
    STORE_SRC.slice(cancelStart, nextSettle),
    /return \{ match: updated \?\? match, forfeited: false, cancelled: true \}/,
  );
});

test("settlement: the idempotency guard is the status flip + the writers' journals", () => {
  // The store documents the exactly-once contract and relies on the shared
  // (user, game, match) journals, not a bespoke guard.
  assert.match(STORE_SRC, /idempotent/i);
  assert.match(STORE_SRC, /status: outcome \? MATCH_STATUS\.FINISHED/);
  // Duplicate completion requests are rejected before simulation.
  assert.match(STORE_SRC, /Match is not active/);
});

// ════════════════════════════════════════════════════════════════════════
// 4. AI / practice matches — never competitive
// ════════════════════════════════════════════════════════════════════════

test("ai: the store refuses to settle a free vs-AI match", () => {
  assert.match(STORE_SRC, /if \(match\.isAi\) return;/);
  assert.match(STORE_SRC, /match\.isAi/);
});

test("ai: the AI seat identity is namespaced and marked never-rated", () => {
  const constants = read("src/lib/mini-golf/constants.ts");
  assert.match(constants, /MINI_GOLF_AI_PLAYER_ID/);
  assert.match(constants, /Never rated/i);
});

// ════════════════════════════════════════════════════════════════════════
// 5. Anti-cheat — the client cannot influence competitive progression
// ════════════════════════════════════════════════════════════════════════

test("security: the shoot route forwards ONLY angle, power and expectedVersion", () => {
  const src = read("src/app/api/mini-golf/match/[matchId]/shoot/route.ts");
  assert.match(src, /angle: body\?\.angle/);
  assert.match(src, /power: body\?\.power/);
  assert.match(src, /expectedVersion: body\?\.expectedVersion/);
  // No competitive field may be read off the body anywhere in the route.
  for (const field of ["winner", "winnerId", "elo", "eloDelta", "rating", "trophies", "holeWins", "matchResult", "result"]) {
    assert.doesNotMatch(
      src,
      new RegExp(`body\\??\\.${field}\\b`),
      `shoot route must not read body.${field}`,
    );
  }
});

test("security: the settlement outcome is derived, never submitted", () => {
  const src = read("src/app/api/mini-golf/match/[matchId]/shoot/route.ts");
  // The route hands the store raw inputs only; the store derives everything.
  assert.doesNotMatch(src, /winnerId\s*:\s*body/);
  assert.doesNotMatch(src, /result\s*:\s*body/);
  // The winner is computed from the persisted hole wins.
  assert.match(STORE_SRC, /outcome\.winnerSeat/);
  assert.match(STORE_SRC, /userIdForSeat\(seats, outcome\.winnerSeat\)/);
});

test("security: forfeit/disconnect cannot award a client-chosen winner", () => {
  const forfeit = read("src/app/api/mini-golf/match/[matchId]/forfeit/route.ts");
  const disconnect = read("src/app/api/mini-golf/disconnect-forfeit/route.ts");
  for (const src of [forfeit, disconnect]) {
    assert.doesNotMatch(src, /body\??\.(winner|winnerId|elo|trophies)/);
    assert.doesNotMatch(src, /winnerId\s*:\s*body/);
  }
  // The forfeit winner is the OTHER seat, derived server-side.
  assert.match(STORE_SRC, /const winnerSeat = otherSeat\(seat as Seat\)/);
});

// ════════════════════════════════════════════════════════════════════════
// 6. Transport contract — every Mini Golf mutation declares JSON
// ════════════════════════════════════════════════════════════════════════

test("every Mini Golf POST declares a JSON content-type", () => {
  // The proxy's transport guard answers 415 to ANY POST/PUT/PATCH whose
  // content-type is not application/json — body or no body. Create, join,
  // practice, forfeit and cancel are all bodyless POSTs, so a missing header
  // broke the whole lobby. Pin the pairing so it cannot regress.
  for (const file of [
    "src/app/casino/mini-golf/PageClient.tsx",
    "src/app/casino/mini-golf/[matchId]/PageClient.tsx",
  ]) {
    const src = read(file);
    const posts = (src.match(/method: "POST"/g) ?? []).length;
    const jsonHeaders = (src.match(/"Content-Type": "application\/json"/g) ?? []).length;
    assert.ok(posts > 0, `${file} is expected to issue POSTs`);
    assert.equal(
      jsonHeaders,
      posts,
      `${file}: ${posts} POST(s) but ${jsonHeaders} JSON content-type header(s) — a bodyless POST without one gets a 415`,
    );
  }
});
