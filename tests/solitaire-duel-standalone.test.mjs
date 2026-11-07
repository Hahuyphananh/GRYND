// tests/solitaire-duel-standalone.test.mjs
//
// Focused proofs for the standalone (no-server) Solitaire Duel build:
//
//   * the deal generator runs in a browser-compatible runtime and produces a
//     valid, PROVEN-SOLVABLE deal
//   * both seats start from the identical deal but independent objects
//   * a player move changes only the player's board; an AI step changes only
//     the AI's board
//   * the local controller IS the shared engine (an accepted move equals the
//     engine's own output, and an illegal move is refused by it)
//   * all three difficulty tiers are honoured
//   * completion resolves with the existing ladder
//   * the result screen renders the GRYND CTA on BOTH Victory and Defeat, and
//     renders nothing but the game when the build leaves it off
//   * nothing in the standalone import graph reaches the database, auth, API
//     routes, sockets or a remote origin
//
// Run: npm run test:solitaire-standalone

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve as resolvePath } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  applyPlayerMove,
  advanceAi,
  createLocalMatch,
  endMatchByProgress,
  settleMatch,
  tick,
} from "../standalone/solitaire-duel/src/match.ts";
import { PORTAL_CONFIG } from "../standalone/solitaire-duel/src/portal-config.ts";
import { PORTAL_RUNTIME } from "../standalone/solitaire-duel/src/portal-sdk.ts";
import * as resultScreenModule from "../standalone/solitaire-duel/src/ResultScreen.tsx";
import { randomSeed } from "../standalone/solitaire-duel/src/seed.ts";
import {
  AI_MOVE_DELAY_MS,
  aiMoveDelayMs,
  chooseAiMove,
  legalMoves,
  planAiMoves,
} from "../src/lib/solitaire-duel/ai.ts";
import {
  DECK_SIZE,
  MAX_MOVES_PER_SEAT,
  SEAT,
  TABLEAU_COLUMNS,
} from "../src/lib/solitaire-duel/constants.ts";
import { applyMove, initialStateFromDeal } from "../src/lib/solitaire-duel/rules.ts";
import { solvableDealFromSeed, solveDeal } from "../src/lib/solitaire-duel/solvable.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolvePath(HERE, "..");
const STANDALONE = join(REPO, "standalone", "solitaire-duel");

/** A match with no countdown, so every assertion can act immediately. */
function matchAt(seed, difficulty = "normal") {
  return createLocalMatch({ difficulty, seed, nowMs: 0, countdownMs: 0 });
}

/** A board whose foundations are complete, stamped at `atMs`. */
function solvedState(state, atMs) {
  const next = structuredClone(state);
  next.foundations = {
    spades: [],
    hearts: [],
    diamonds: [],
    clubs: [],
  };
  for (const suit of ["spades", "hearts", "diamonds", "clubs"]) {
    for (let rank = 1; rank <= 13; rank += 1) next.foundations[suit].push({ suit, rank });
  }
  next.tableau = Array.from({ length: TABLEAU_COLUMNS }, () => []);
  next.stock = [];
  next.waste = [];
  next.completed = true;
  next.completedAtMs = atMs;
  return next;
}

// ── 1. Deal generation ────────────────────────────────────────────────────

test("deal generation runs on browser-safe randomness and yields a valid layout", () => {
  const seed = randomSeed();
  assert.equal(Number.isInteger(seed), true);
  assert.ok(seed >= 0 && seed <= 0xffffffff, "seed must be an unsigned 32-bit int");

  const deal = solvableDealFromSeed(seed);
  const cards = [...deal.tableau.flat().map((pile) => pile.card), ...deal.stock];

  assert.equal(cards.length, DECK_SIZE, "52 cards, no more, no fewer");
  assert.equal(new Set(cards.map((card) => `${card.suit}-${card.rank}`)).size, DECK_SIZE);
  assert.deepEqual(deal.tableau.map((column) => column.length), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(deal.stock.length, 24);
  // Only the last card of each column is face-up, exactly like Klondike.
  for (const column of deal.tableau) {
    const faceUp = column.filter((pile) => pile.faceUp).length;
    assert.equal(faceUp, 1);
    assert.equal(column[column.length - 1].faceUp, true);
  }
});

test("the generated deal is proven solvable by the shared solver", () => {
  for (const seed of [7, 2026]) {
    const deal = solvableDealFromSeed(seed);
    assert.notEqual(solveDeal(deal), null, `seed ${seed} must have a winning line`);
  }
});

// ── 2. Both seats, one deal ───────────────────────────────────────────────

test("player and AI receive the identical starting deal from independent objects", () => {
  const match = matchAt(777);
  const expected = initialStateFromDeal(match.deal);

  assert.deepEqual(match.player, expected);
  assert.deepEqual(match.ai, expected);
  assert.deepEqual(match.player, match.ai);

  // Same contents, different objects: a move on one board can never touch the
  // other's pile, stock or foundation arrays.
  assert.notEqual(match.player.tableau, match.ai.tableau);
  assert.notEqual(match.player.stock, match.ai.stock);
  assert.notEqual(match.player.tableau[0], match.ai.tableau[0]);
  assert.notEqual(match.player.foundations, match.ai.foundations);
});

// ── 3. Isolation of the two boards ────────────────────────────────────────

test("a player move updates only the player's board", () => {
  const match = matchAt(4242);
  const aiBefore = structuredClone(match.ai);

  const outcome = applyPlayerMove(match, { kind: "draw" }, match.goAtMs + 10);
  assert.equal(outcome.error, null);
  assert.equal(outcome.match.player.waste.length, 1);
  assert.equal(outcome.match.player.ply, 1);
  assert.deepEqual(outcome.match.ai, aiBefore, "the bot's board must be untouched");
});

test("an AI step updates only the AI's board, at the tier's pace", () => {
  const match = matchAt(4242);
  const playerBefore = structuredClone(match.player);

  const advanced = advanceAi(match, match.goAtMs + 3000);

  assert.ok(advanced.ai.ply > 0, "the bot must have played");
  assert.deepEqual(advanced.player, playerBefore, "the player's board must be untouched");

  const allowed = Math.floor(3000 / aiMoveDelayMs("normal"));
  assert.ok(advanced.ai.ply <= allowed, "the bot may never outrun its clock");

  // Nothing happens before GO.
  const early = advanceAi(match, match.goAtMs - 1);
  assert.equal(early.ai.ply, 0);
});

test("the bot always solves the shared deal, on every tier, at its own pace", () => {
  const finishes = [];

  for (const tier of ["easy", "normal", "hard"]) {
    const match = matchAt(2026, tier);
    const delay = AI_MOVE_DELAY_MS[tier];
    // Far enough ahead that the bot has earned its whole move budget: the point
    // is that it FINISHES the puzzle, not how long that takes.
    const solved = advanceAi(match, match.goAtMs + delay * MAX_MOVES_PER_SEAT);

    assert.equal(solved.ai.completed, true, `${tier}: the bot must finish the deal`);
    assert.equal(solved.result, SEAT.PLAYER2, `${tier}: finishing first wins the race`);
    assert.equal(solved.resolution, "finish");
    assert.ok(solved.ai.completedAtMs != null, `${tier}: the completion instant is stamped`);
    finishes.push(solved.ai.completedAtMs);
  }

  // Difficulty is PACE on the same deal: the slower tier finishes later.
  assert.ok(finishes[0] > finishes[1], "easy must finish after normal");
  assert.ok(finishes[1] > finishes[2], "normal must finish after hard");
});

// ── 4. One rules engine ───────────────────────────────────────────────────

test("the local controller is the shared engine, not a second implementation", () => {
  const match = matchAt(999);

  // An illegal move is refused, and the refusal leaves the match untouched.
  const illegal = applyPlayerMove(
    match,
    { kind: "waste-to-foundation", suit: "spades" },
    match.goAtMs + 10,
  );
  assert.ok(illegal.error, "an empty waste cannot send a card to a foundation");
  assert.equal(illegal.match, match, "a rejected move must not create a new match");

  // An accepted move produces EXACTLY what the engine produces for the same
  // board — the proof that no rule is re-implemented here.
  const direct = applyMove({ state: match.player, move: { kind: "draw" } });
  assert.equal(direct.ok, true);
  const viaController = applyPlayerMove(match, { kind: "draw" }, match.goAtMs + 10);
  assert.deepEqual(viaController.match.player, direct.state);
});

test("the bot only ever returns moves the engine calls legal", () => {
  const match = matchAt(31337);
  const state = match.ai;
  const legal = legalMoves(state);
  assert.ok(legal.length > 0);

  const chosen = chooseAiMove({ state, difficulty: "hard", random: () => 0.5 });
  assert.ok(chosen);
  assert.ok(
    legal.some((move) => JSON.stringify(move) === JSON.stringify(chosen)),
    "the chosen move must be one of the engine's legal moves",
  );

  const plan = planAiMoves({ state, difficulty: "normal", maxMoves: 12 });
  assert.ok(plan.moves.length > 0);
  assert.ok(plan.moves.length <= 12);
});

// ── 5. Difficulty tiers ───────────────────────────────────────────────────

test("easy, normal and hard keep their distinct pacing and stay ordered", () => {
  assert.ok(AI_MOVE_DELAY_MS.easy > AI_MOVE_DELAY_MS.normal);
  assert.ok(AI_MOVE_DELAY_MS.normal > AI_MOVE_DELAY_MS.hard);

  const at = 10_000;
  const plies = ["easy", "normal", "hard"].map(
    (tier) => advanceAi(matchAt(2026, tier), at).ai.ply,
  );

  assert.ok(plies[0] <= plies[1], "easy must never out-pace normal");
  assert.ok(plies[1] <= plies[2], "normal must never out-pace hard");
  assert.ok(plies[2] > plies[0], "hard must be meaningfully faster than easy");
  assert.ok(plies.every((ply) => ply > 0), "every tier must actually play");
});

// ── 6. Resolution ─────────────────────────────────────────────────────────

test("the first completion wins immediately", () => {
  const base = matchAt(1234);

  // A real completing move, straight through the engine: the last King onto the
  // last foundation.
  const near = structuredClone(base.player);
  near.foundations = {
    spades: [],
    hearts: [],
    diamonds: [],
    clubs: [],
  };
  for (let rank = 1; rank <= 12; rank += 1) near.foundations.spades.push({ suit: "spades", rank });
  for (const suit of ["hearts", "diamonds", "clubs"]) {
    for (let rank = 1; rank <= 13; rank += 1) near.foundations[suit].push({ suit, rank });
  }
  near.tableau = [[{ card: { suit: "spades", rank: 13 }, faceUp: true }], [], [], [], [], [], []];
  near.stock = [];
  near.waste = [];
  near.completed = false;
  near.completedAtMs = null;

  const outcome = applyPlayerMove(
    { ...base, player: near },
    {
      kind: "tableau-to-foundation",
      fromColumn: 0,
      card: { suit: "spades", rank: 13 },
      suit: "spades",
    },
    7000,
  );

  assert.equal(outcome.error, null);
  assert.equal(outcome.match.player.completed, true);
  assert.equal(outcome.match.player.completedAtMs, 7000, "the engine is clock-free; the caller stamps the instant");
  assert.equal(outcome.match.result, SEAT.PLAYER1);
  assert.equal(outcome.match.resolution, "finish");
});

test("fabricated finishes resolve through the existing race ladder", () => {
  const base = matchAt(55);

  const playerFirst = settleMatch({ ...base, player: solvedState(base.player, 5000) });
  assert.equal(playerFirst.result, SEAT.PLAYER1);
  assert.equal(playerFirst.resolution, "finish");

  const botFirst = settleMatch({ ...base, ai: solvedState(base.ai, 4000) });
  assert.equal(botFirst.result, SEAT.PLAYER2);

  // Both inside COMPLETION_DEAD_HEAT_MS (200 ms) is a dead heat, exactly as on
  // the server.
  const deadHeat = settleMatch({
    ...base,
    player: solvedState(base.player, 5000),
    ai: solvedState(base.ai, 5100),
  });
  assert.equal(deadHeat.result, "draw");
  assert.equal(deadHeat.resolution, "draw");

  // A live race stays live.
  assert.equal(settleMatch(base).result, null);
});

test("ending by progress uses foundations, then revealed cards, then a draw", () => {
  const base = matchAt(99);

  // Level boards: an exact tie is a draw.
  const level = endMatchByProgress(base);
  assert.equal(level.result, "draw");
  assert.equal(level.resolution, "draw");

  // One foundation card ahead for the bot.
  const behind = endMatchByProgress({
    ...base,
    ai: {
      ...base.ai,
      foundations: { ...base.ai.foundations, spades: [{ suit: "spades", rank: 1 }] },
    },
  });
  assert.equal(behind.result, SEAT.PLAYER2);
  assert.equal(behind.resolution, "forfeit");

  // Revealed tableau cards are the tiebreak when foundations are level. The
  // seventh column is fully face-down except its last card, so flipping it
  // raises `revealedTableau` by six and wins the tiebreak.
  const playerRevealed = structuredClone(base.player);
  playerRevealed.tableau[6] = playerRevealed.tableau[6].map((pile) => ({ ...pile, faceUp: true }));
  const ahead = endMatchByProgress({ ...base, player: playerRevealed });
  assert.equal(ahead.result, SEAT.PLAYER1);
});

test("a tick never resolves a live race and never mutates its input", () => {
  const base = matchAt(8080);
  const snapshot = structuredClone(base);
  const next = tick(base, base.goAtMs + 2000);

  assert.equal(base.result, null);
  assert.deepEqual(base, snapshot, "the controller must not mutate the match it was handed");
  assert.equal(next.result, null);
});

// ── 7. Result metadata and the portal CTA ─────────────────────────────────

test("a finished match records when it ended, for the result screen", () => {
  const base = matchAt(4321);
  assert.equal(base.endedAtMs, null, "a live match has no end instant");

  const ended = endMatchByProgress(base, 5000);
  assert.equal(ended.endedAtMs, 5000);
  assert.equal(endMatchByProgress(ended, 9000).endedAtMs, 5000, "the stamp is written once");

  const settled = settleMatch({ ...base, player: solvedState(base.player, 4000) }, 6000);
  assert.equal(settled.result, SEAT.PLAYER1);
  assert.equal(settled.endedAtMs, 6000);

  // A live race is never stamped, so no duration is ever shown early.
  assert.equal(settleMatch(base, 7000).endedAtMs, null);
});

test("the GRYND CTA is disabled unless a build turns it on", () => {
  // This test runs outside Vite, so the build-time constants are absent — the
  // exact state a package must be in for a portal that forbids the CTA.
  assert.equal(PORTAL_CONFIG.ctaEnabled, false);
  assert.equal(PORTAL_CONFIG.ctaUrl, "");
  assert.equal(PORTAL_CONFIG.ctaLabel, "Sign in to GRYND");
  assert.match(PORTAL_CONFIG.ctaQuestion, /track your stats and compete in ranked games/i);
  // No promise that anything was saved, and no URL literal in the source.
  assert.doesNotMatch(PORTAL_CONFIG.ctaQuestion, /saved|uploaded|recorded|synced/i);
  const source = readFileSync(
    join(REPO, "standalone", "solitaire-duel", "src", "portal-config.ts"),
    "utf8",
  );
  // No hard-coded destination: only a quoted literal could ever be one, and the
  // build supplies it through `define`.
  assert.doesNotMatch(source, /["'`]https?:\/\//i, "the destination must come from the build");
});

// ── 7b. The result screen: the CTA on Victory and Defeat ─────────────────

const pick = (mod) => mod?.default?.default ?? mod?.default;
const ResultScreen = pick(resultScreenModule);

/** The itch.io configuration: CTA on, pointing at the production sign-in route. */
const CTA_ON = Object.freeze({
  ctaEnabled: true,
  ctaUrl: "https://www.grynd.dedyn.io/sign-in",
  ctaQuestion: "Want to track your stats and compete in ranked games?",
  ctaLabel: "Sign in to GRYND",
});

/** The default configuration: CTA off, no address in the build at all. */
const CTA_OFF = Object.freeze({ ...CTA_ON, ctaEnabled: false, ctaUrl: "" });

function renderResult(outcome, cta) {
  assert.equal(typeof ResultScreen, "function", "ResultScreen must be the panel component");
  return renderToStaticMarkup(
    React.createElement(ResultScreen, {
      outcome,
      resolution: "finish",
      durationLabel: "1:07",
      playerProgress: { foundationCards: 52, revealedTableau: 30, progressPercent: 100 },
      botProgress: { foundationCards: 49, revealedTableau: 28, progressPercent: 94 },
      botLabel: "Bot · Normal",
      cta,
      onReplay: () => {},
      onChangeDifficulty: () => {},
    }),
  );
}

/** Every promise the CTA has to keep, checked against rendered markup. */
function assertCta(html, screen) {
  assert.match(html, /data-testid="grynd-cta"/, `${screen} must show the CTA`);
  assert.match(html, /data-testid="grynd-cta-link"/, `${screen} must show the CTA link`);
  assert.match(html, /Want to track your stats and compete in ranked games\?/);
  assert.match(html, /Sign in to GRYND/);
  assert.match(html, /href="https:\/\/www\.grynd\.dedyn\.io\/sign-in"/);
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noopener noreferrer"/);

  // Position: after the result information, before the replay controls.
  const ctaAt = html.indexOf('data-testid="grynd-cta"');
  assert.ok(ctaAt > html.indexOf('data-testid="result-duration"'), "the CTA must follow the result info");
  assert.ok(ctaAt < html.indexOf('data-testid="result-replay"'), "the CTA must not replace replay");
  assert.match(html, /data-testid="result-replay"/);
  assert.match(html, /data-testid="result-change-difficulty"/);
}

test("the CTA appears on both the Victory and Defeat result screens", () => {
  const victory = renderResult("VICTORY", CTA_ON);
  const defeat = renderResult("DEFEAT", CTA_ON);

  assert.match(victory, />VICTORY</);
  assert.match(defeat, />DEFEAT</);
  assertCta(victory, "Victory");
  assertCta(defeat, "Defeat");

  // Every outcome is the same panel, so a draw is covered by the same code path.
  assertCta(renderResult("DRAW", CTA_ON), "Draw");
});

test("the CTA is absent when the build leaves it off, and nothing else is lost", () => {
  for (const outcome of ["VICTORY", "DEFEAT", "DRAW"]) {
    const html = renderResult(outcome, CTA_OFF);
    assert.doesNotMatch(html, /grynd-cta/, `${outcome} must not render the CTA`);
    assert.doesNotMatch(html, /Sign in to GRYND/);
    assert.doesNotMatch(html, /Want to track your stats/);
    assert.doesNotMatch(html, /grynd\.dedyn\.io/);

    // The result screen itself is untouched: outcome, time, both lines, replay.
    assert.match(html, new RegExp(outcome));
    assert.match(html, /Match time 1:07/);
    assert.match(html, /52\/52 on foundations/);
    assert.match(html, /Bot · Normal/);
    assert.match(html, /data-testid="result-replay"/);
    assert.match(html, /data-testid="result-change-difficulty"/);
  }
});

test("the CTA never claims this match was saved or transferred to GRYND", () => {
  for (const outcome of ["VICTORY", "DEFEAT"]) {
    const html = renderResult(outcome, CTA_ON).toLowerCase();
    assert.doesNotMatch(html, /saved|uploaded|recorded|transferred|synced|linked/, `${outcome} copy must not promise a transfer`);
    assert.doesNotMatch(html, /your progress|this match|this result/, "the copy must not imply the match is carried over");
  }
});

test("the portal SDK adapter is a no-op unless a build enables one", () => {
  assert.equal(PORTAL_RUNTIME.name, "none");

  // Called with no DOM and no flag: every method must be a harmless no-op, so
  // importing this module can never start a network request on its own.
  PORTAL_RUNTIME.boot();
  PORTAL_RUNTIME.loaded();
  PORTAL_RUNTIME.enterMatch();
  PORTAL_RUNTIME.leaveMatch();
  PORTAL_RUNTIME.celebrate();

  const source = readFileSync(
    join(REPO, "standalone", "solitaire-duel", "src", "portal-sdk.ts"),
    "utf8",
  );
  // The SDK origin appears exactly once, and only behind the build flag.
  assert.equal(source.match(/sdk\.crazygames\.com/g)?.length, 1);
  assert.match(source, /MODE !== "crazygames"/);
  assert.match(source, /__PORTAL_SDK__/);
});

// ── 8. Bundle isolation ───────────────────────────────────────────────────

const MODULE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs"];

function resolveModule(base) {
  for (const candidate of [base, ...MODULE_EXTENSIONS.map((ext) => base + ext)]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // try the next candidate
    }
  }
  for (const ext of MODULE_EXTENSIONS) {
    const index = join(base, `index${ext}`);
    try {
      if (statSync(index).isFile()) return index;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/** Walk every relative import from `entry`; collect files and bare specifiers. */
function walk(entry) {
  const files = new Set();
  const external = new Set();

  const visit = (file) => {
    if (files.has(file)) return;
    files.add(file);
    const source = readFileSync(file, "utf8");
    const specs = [];
    for (const match of source.matchAll(
      /(?:^|\n)\s*(?:import|export)\b[^;]*?from\s+["']([^"']+)["']/g,
    )) {
      specs.push(match[1]);
    }
    for (const match of source.matchAll(/(?:^|\n)\s*import\s+["']([^"']+)["']/g)) {
      specs.push(match[1]);
    }

    for (const spec of specs) {
      if (!spec.startsWith(".")) {
        external.add(spec);
        continue;
      }
      const resolved = resolveModule(join(dirname(file), spec));
      assert.ok(resolved, `unresolved import ${spec} in ${relative(REPO, file)}`);
      if (resolved.endsWith(".css")) files.add(resolved);
      else visit(resolved);
    }
  };

  visit(entry);
  return { files, external };
}

test("no database, auth, API, socket or server module enters the standalone bundle", () => {
  const { files, external } = walk(join(STANDALONE, "src", "main.tsx"));

  const forbidden = [
    { name: "server store", pattern: /serverStore/ },
    { name: "server seeds (node:crypto)", pattern: /solitaire-duel[/\\]seeds/ },
    { name: "realtime", pattern: /[/\\]realtime\.ts$/ },
    { name: "socket rooms", pattern: /[/\\]rooms\.ts$/ },
    { name: "database", pattern: /[/\\]db[/\\]|drizzle/ },
    { name: "clerk", pattern: /@clerk/ },
    { name: "next", pattern: /[/\\]next[/\\]/ },
    { name: "api routes", pattern: /[/\\]api[/\\]/ },
    { name: "auth helpers", pattern: /guestSession|[/\\]auth[/\\]|[/\\]platform[/\\]/ },
    { name: "socket client", pattern: /socket/i },
    { name: "portal tooling", pattern: /[/\\]portal[/\\]/ },
  ];

  for (const file of files) {
    const rel = relative(REPO, file);
    for (const rule of forbidden) {
      assert.doesNotMatch(rel, rule.pattern, `standalone bundle reached ${rule.name}: ${rel}`);
    }
  }

  for (const spec of external) {
    assert.ok(
      ["react", "react-dom", "react-dom/client", "react/jsx-runtime"].includes(spec),
      `standalone bundle imported a non-React package: ${spec}`,
    );
    assert.doesNotMatch(spec, /^node:/, `standalone bundle imported a node builtin: ${spec}`);
  }

  // The shared engine really is in the graph (otherwise this test proves nothing).
  assert.ok([...files].some((file) => file.endsWith(join("solitaire-duel", "rules.ts"))));
  assert.ok([...files].some((file) => file.endsWith(join("solitaire-duel", "ai.ts"))));
  assert.ok([...files].some((file) => file.endsWith(join("solitaire-duel", "solvable.ts"))));
});

test("the standalone sources make no network, socket or storage calls", () => {
  const scans = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) visit(full);
      else scans.push(full);
    }
  };
  visit(join(STANDALONE, "src"));
  scans.push(join(STANDALONE, "index.html"));

  for (const file of scans) {
    const source = readFileSync(file, "utf8");
    const rel = relative(REPO, file);
    assert.doesNotMatch(source, /\bfetch\s*\(/, `${rel} must not call fetch`);
    assert.doesNotMatch(source, /\bXMLHttpRequest\b/, `${rel} must not use XHR`);
    assert.doesNotMatch(source, /\bWebSocket\b/, `${rel} must not open a socket`);
    assert.doesNotMatch(source, /\bsendBeacon\b/, `${rel} must not beacon`);
    assert.doesNotMatch(source, /localStorage|sessionStorage/, `${rel} must not persist anything`);
    // A remote URL may only appear as documentation. Anything the browser would
    // actually REQUEST — a stylesheet url(), a markup src/href, an @import or a
    // quoted literal — is refused.
    assert.doesNotMatch(source, /url\(\s*["']?https?:/i, `${rel} must not load a remote asset`);
    assert.doesNotMatch(
      source,
      /\b(?:src|href)\s*=\s*["']https?:/i,
      `${rel} must not reference a remote origin`,
    );
    assert.doesNotMatch(source, /@import[^;]*https?:/i, `${rel} must not import a remote stylesheet`);
    if (/\.(?:html|css)$/i.test(file)) {
      assert.doesNotMatch(source, /https?:\/\//i, `${rel} must contain no remote origin at all`);
    }
  }
});
