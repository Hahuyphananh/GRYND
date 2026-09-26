/**
 * stakes-retired.test.mjs
 *
 * Wagering is retired: a match costs nothing to enter and moves no tokens.
 *
 * These are contract tests over the seam (src/lib/games/stakes.js), the queue
 * chokepoint (src/lib/quickQueueWorker.ts), the game pages (no page may still
 * ask for a stake) and every entry point that has been converted.
 * They exist so the migration cannot silently regress: an entry point that goes
 * back to rejecting a zero stake — or to reading a stake the client sent —
 * fails here instead of charging a player again.
 *
 * Run:  node --import tsx --test tests/stakes-retired.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  FREE_STAKE,
  STAKES_RETIRED,
  STAKE_LABEL,
  isStakeAccepted,
  normalizeStake,
  tokensMoveForMatches,
} from "../src/lib/games/stakes.js";

// ════════════════════════════════════════════════════════════════════════
// 1. The seam itself
// ════════════════════════════════════════════════════════════════════════

test("stakes are retired and a match can never move tokens", () => {
  assert.equal(STAKES_RETIRED, true);
  assert.equal(FREE_STAKE, 0);
  assert.equal(tokensMoveForMatches(), false);
  assert.equal(STAKE_LABEL, "Free play");
});

test("normalizeStake ignores ANY client-supplied stake", () => {
  // A number, a string, a legacy big bet, a negative, garbage, or nothing at
  // all: whatever a client (or a stale cached page) sends, the match gets 0,
  // so no request can create a stake the platform would honour.
  for (const requested of [50, "50", 100000, -5, 0.5, NaN, Infinity, null, undefined, {}, "abc"]) {
    assert.equal(
      normalizeStake(requested),
      0,
      `normalizeStake(${String(requested)}) must be 0`,
    );
  }
});

test("a non-zero stake is never an accepted entry value", () => {
  assert.equal(isStakeAccepted(50), false);
  assert.equal(isStakeAccepted(1), false);
  assert.equal(isStakeAccepted(0), false);
  assert.equal(isStakeAccepted(undefined), false);
});

// ════════════════════════════════════════════════════════════════════════
// 2. The client chokepoint — no game page may start with a stake
// ════════════════════════════════════════════════════════════════════════

const HOOK = "src/hooks/useDefaultWager.js";

test("no game page can start with a stake (the default-wager hook is gone)", () => {
  // The per-game default-wager hook and the Settings card that wrote to it are
  // deleted: there is no control left through which a stake could be set, so no
  // page can be returned to a state where tokens have to be put up to play.
  assert.equal(
    fs.existsSync(HOOK),
    false,
    `${HOOK} must be deleted while stakes are retired`,
  );
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!/\.(js|ts|jsx|tsx)$/.test(entry.name)) continue;
      if (fs.readFileSync(path, "utf8").includes("useDefaultWager")) {
        offenders.push(path);
      }
    }
  };
  walk("src/app");
  assert.deepEqual(
    offenders,
    [],
    `a page still imports the retired stake hook:\n${offenders.join("\n")}`,
  );
});

// ════════════════════════════════════════════════════════════════════════
// 3. The queue chokepoint — all 18 queue games are created through it
// ════════════════════════════════════════════════════════════════════════

const WORKER = "src/lib/quickQueueWorker.ts";

test("the quick-queue worker creates every match at a retired stake", () => {
  const src = fs.readFileSync(WORKER, "utf8");
  assert.match(src, /import \{ normalizeStake \} from "\.\/games\/stakes"/);
  assert.match(
    src,
    /const sourceStake = normalizeStake\(/,
    "the queue's stake envelope must be normalized at the source",
  );
  assert.match(
    src,
    /const partnerStake = normalizeStake\(/,
    "the partner's stake must be normalized too",
  );
  // The raw reads must be gone: a stake read straight off a queue row is how a
  // pre-retirement row would leak into a match.
  assert.doesNotMatch(
    src,
    /Number\(pair\.(source|partner)\.row\?\.minesStakeAmount/,
    "no raw stake read may remain in the worker",
  );
});

// ════════════════════════════════════════════════════════════════════════
// 4. Converted entry points
// ════════════════════════════════════════════════════════════════════════

// Every entry point that takes a stake from the client and has been converted.
// Adding a game here is part of converting it; removing one would mean charging
// players again and must fail this test.
const CONVERTED = [
  // Lobby / create routes
  "src/app/api/chess/create-game/route.js",
  "src/app/api/four-in-a-row/create-game/route.js",
  "src/app/api/dots-and-boxes/create-game/route.js",
  "src/app/api/rps/pvp/create/route.js",
  "src/app/api/odds/create/route.ts",
  "src/app/api/hex-duel/multiplayer/create/route.ts",
  "src/app/api/tower-arena/create-lobby/route.ts",
  "src/app/api/pool/create-lobby/route.ts",
  "src/app/api/pool/join-lobby/route.ts",
  "src/app/api/pool/resign/route.ts",
  "src/app/api/dice-flush/create/route.js",
  "src/app/api/dice-flush/start-ai/route.js",
  "src/app/api/dice-flush/_lib.js",
  // PvP matchmaking entry points
  "src/app/api/blackjack-pvp/create-or-join/route.js",
  "src/app/api/keno-pvp/create-or-join/route.js",
  "src/app/api/lane-rush-duel/create-or-join/route.js",
  "src/app/api/memory-grid/create-or-join/route.js",
  "src/app/api/mines-pvp/create-or-join/route.js",
  "src/app/api/plinko-pvp/create-or-join/route.js",
  "src/app/api/roulette-pvp/create-or-join/route.js",
  // PvP stores that escrow the stake
  "src/lib/blackjack-pvp/serverStore.js",
  "src/lib/keno-pvp/serverStore.js",
  "src/lib/lane-rush-duel/serverStore.js",
  "src/lib/memory-grid/serverStore.js",
  "src/lib/mines-pvp/serverStore.js",
  "src/lib/plinko-pvp/serverStore.js",
  "src/lib/roulette-pvp/serverStore.js",
  // Single-player / AI games
  "src/app/api/play-plinko/route.js",
  "src/app/api/roulette/save-game/route.js",
  "src/app/api/rps/play/route.js",
  "src/app/api/odds/ai/start/route.ts",
  "src/app/api/hex-duel/start-game/route.ts",
  "src/app/api/hex-duel/end-game/route.ts",
  "src/app/api/uno/initialize-vs-ai/route.js",
  "src/app/api/uno/join-online/route.js",
  "src/app/api/uno/multiplayer/route.js",
  // Settlement / payout paths
  "src/lib/precision/finishMatch.ts",
];

// The phrases that only exist to police a charge. A converted entry point must
// not contain them: they would reject the free play that replaced the stake.
const RETIRED_REJECTIONS = [
  /Invalid stake amount/,
  /Invalid bet amount/,
  /Invalid wager amount/,
  /exceeds the maximum of [\d,]+ tokens/i,
  /Wager exceeds maximum limit/,
];

test("every converted entry point takes its stake from the seam", () => {
  for (const file of CONVERTED) {
    const src = fs.readFileSync(file, "utf8");
    assert.match(
      src,
      /import \{[^}]*normalizeStake[^}]*\} from "[^"]*games\/stakes"/,
      `${file} must read the seam`,
    );
    assert.match(
      src,
      /normalizeStake\(/,
      `${file} must normalize the requested stake`,
    );
    for (const rejection of RETIRED_REJECTIONS) {
      assert.doesNotMatch(
        src,
        rejection,
        `${file} still rejects a free entry (${rejection})`,
      );
    }
    assert.doesNotMatch(
      src,
      /Number\(body\.(tableAmount|betAmount|wager)\)/,
      `${file} still reads a client-supplied stake directly`,
    );
  }
});

// Every entry point/store whose debit, refund or payout machinery was deleted
// once stakes were retired. None of them may ever move a token balance again.
const NO_TOKEN_MOVES = [
  "src/lib/blackjack-pvp/serverStore.js",
  "src/lib/roulette-pvp/serverStore.js",
  "src/lib/keno-pvp/serverStore.js",
  "src/lib/plinko-pvp/serverStore.js",
  "src/lib/mines-pvp/serverStore.js",
  "src/lib/memory-grid/serverStore.js",
  "src/lib/lane-rush-duel/serverStore.js",
  "src/lib/rps-pvp/serverStore.js",
  "src/lib/quickQueueChess.ts",
  "src/lib/quickQueueCrashArena.ts",
  "src/lib/quickQueueDiceFlush.ts",
  "src/lib/quickQueueDotsAndBoxes.ts",
  "src/lib/quickQueueFourInARow.ts",
  "src/lib/quickQueueHexDuel.ts",
  "src/lib/quickQueueRps.ts",
  "src/lib/quickQueueUno.ts",
  "src/lib/quickQueuePool.ts",
  "src/lib/quickQueuePrecision.ts",
  "src/lib/dotsAndBoxesServer.js",
  "src/lib/fourInARowServer.js",
  "src/lib/tower-arena/serverStore.ts",
  "src/lib/crash-arena/cleanup.ts",
  "src/app/api/chess/create-game/route.js",
  "src/app/api/chess/join-game/route.js",
  "src/app/api/chess/cancel-game/route.js",
  "src/app/api/chess/end-game/route.js",
  "src/app/api/chess/game-state/route.js",
  "src/app/api/chess/move/route.js",
  "src/app/api/dots-and-boxes/create-game/route.js",
  "src/app/api/dots-and-boxes/join-game/route.js",
  "src/app/api/dots-and-boxes/cancel/route.js",
  "src/app/api/four-in-a-row/create-game/route.js",
  "src/app/api/four-in-a-row/join-game/route.js",
  "src/app/api/four-in-a-row/replay-response/route.js",
  "src/app/api/hex-duel/multiplayer/create/route.ts",
  "src/app/api/hex-duel/multiplayer/join/route.ts",
  "src/app/api/hex-duel/multiplayer/end/route.ts",
  "src/app/api/uno/resign/route.js",
  "src/app/api/pool/join-lobby/route.ts",
  "src/app/api/pool/resign/route.ts",
  "src/app/api/rps/pvp/create/route.js",
  "src/app/api/rps/pvp/join/route.js",
  "src/app/api/rps/pvp/cancel/route.js",
  "src/app/api/rps/pvp/choose/route.js",
  "src/app/api/odds/create/route.ts",
  "src/app/api/odds/join/route.ts",
  "src/app/api/odds/cancel/route.ts",
  "src/app/api/odds/ai/end/route.ts",
  "src/app/api/odds/ai/pick/route.ts",
  "src/app/api/odds/pvp/cleanup/route.ts",
  "src/app/api/odds/pvp/forfeit/route.ts",
  "src/app/api/odds/pvp/pick/route.ts",
  "src/app/api/crash-arena/join/route.ts",
  "src/app/api/dice-flush/_lib.js",
  "src/app/api/dice-flush/resign/route.js",
];

// The shapes that only exist to move tokens. Any one of them reappearing in a
// converted file means the retirement has been undone.
const TOKEN_MOVE_SHAPES = [
  /balance: sql/,
  /Insufficient balance/i,
  /users\.balance} [+-]/, // sql`${users.balance} + …`
];

test("no converted entry point can move a token balance again", () => {
  const offenders = [];
  for (const file of NO_TOKEN_MOVES) {
    const src = fs.readFileSync(file, "utf8");
    for (const shape of TOKEN_MOVE_SHAPES) {
      if (shape.test(src)) offenders.push(`${file} — ${shape}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `retired stake machinery is back:\n${offenders.join("\n")}`,
  );
});

test("crash arena treats every join as play-money, whatever the table", () => {
  // Crash Arena's buy-in is a chip stack, not a charge, but the PUBLIC-table
  // path used to debit `users.balance`. With stakes retired no table may spend
  // real tokens, so the join route must treat every table as virtual.
  const src = fs.readFileSync("src/app/api/crash-arena/join/route.ts", "utf8");
  assert.match(src, /tokensMoveForMatches\(\)/);
  assert.match(
    src,
    /Boolean\(table\.isPrivate\) \|\| !tokensMoveForMatches\(\)/,
    "every crash arena join must be play-money",
  );
});

test("no stake rejection or raw client stake read survives in src/app/api", () => {
  // The migration is only done when the whole surface is free: a single
  // leftover `stake <= 0` branch is enough to make a game unplayable without
  // tokens. Sweep every API file rather than trusting the CONVERTED list.
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!/\.(js|ts|jsx|tsx)$/.test(entry.name)) continue;
      const src = fs.readFileSync(path, "utf8");
      for (const rejection of RETIRED_REJECTIONS) {
        if (rejection.test(src)) offenders.push(`${path} — ${rejection}`);
      }
      if (/Number\(body\.(tableAmount|betAmount|wager)\)/.test(src)) {
        offenders.push(`${path} — raw client stake read`);
      }
    }
  };
  walk("src/app/api");
  assert.deepEqual(
    offenders,
    [],
    `a free match would still be rejected:\n${offenders.join("\n")}`,
  );
});
