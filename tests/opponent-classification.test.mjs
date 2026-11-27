/**
 * opponent-classification.test.mjs
 *
 * One classification, everywhere. The regression this file exists for: a ghost
 * (recorded human) match was labelled "Live player" in the lobby history
 * because the only test was `row.isAi`.
 *
 * Also pins the ghost settlement invariants: a recorded run settles into the
 * HUMAN's ladder only; the ghost seat is never rated.
 *
 * Run:  node --import tsx --test tests/opponent-classification.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  OPPONENT_LABELS,
  classifyOpponent,
  isLiveHuman,
  opponentAnalyticsType,
  opponentLabel,
} from "../src/lib/solitaire-duel/opponentKind.ts";
import { SOLITAIRE_GHOST_PLAYER_PREFIX } from "../src/lib/solitaire-duel/constants.ts";
import {
  ALLOWED_PROPERTY_KEYS,
  sanitizeSolitaireProperties,
} from "../src/lib/solitaire-analytics.ts";

const read = (path) => fs.readFileSync(path, "utf8").replace(/\r\n/g, "\n");

const LOBBY = "src/app/api/solitaire-duel/lobby/route.ts";
const STORE = "src/lib/solitaire-duel/serverStore.ts";
const MATCH_PAGE = "src/app/casino/solitaire-duel/[matchId]/PageClient.tsx";
const RESULT = "src/components/result/PvpResultScreen.jsx";
const PVP_LOBBY = "src/components/lobby/PvpLobby.jsx";

test("ai, recorded and human are classified from server flags", () => {
  assert.equal(classifyOpponent({ isAi: true }), "ai");
  assert.equal(classifyOpponent({ isAi: false, isGhost: true }), "recorded");
  assert.equal(classifyOpponent({ isAi: false, isGhost: false }), "human");
  assert.equal(classifyOpponent(null), "human");
});

test("a ghost seat id is recorded even without the flag (legacy rows)", () => {
  assert.equal(
    classifyOpponent({ isAi: false, player2Id: `${SOLITAIRE_GHOST_PLAYER_PREFIX}abc` }),
    "recorded",
  );
  assert.equal(
    classifyOpponent({ isAi: false, player1Id: `${SOLITAIRE_GHOST_PLAYER_PREFIX}xyz` }),
    "recorded",
  );
});

test("isAi wins over a ghost id: a bot seat is ai, not recorded", () => {
  assert.equal(
    classifyOpponent({ isAi: true, player2Id: `${SOLITAIRE_GHOST_PLAYER_PREFIX}abc` }),
    "ai",
  );
});

test("classification never consults a display name", () => {
  // A human literally named "GRYND AI" is still a human; the helper has no
  // name parameter at all, which is the structural guarantee.
  const src = read("src/lib/solitaire-duel/opponentKind.ts")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  // No code path (only prose comments) may mention a name.
  assert.doesNotMatch(src, /\bname\b/i);
});

test("labels are exactly the three user-facing strings", () => {
  assert.deepEqual(OPPONENT_LABELS, {
    human: "Live player",
    recorded: "Recorded opponent",
    ai: "GRYND AI",
  });
  assert.equal(opponentLabel("recorded"), "Recorded opponent");
  assert.equal(isLiveHuman("recorded"), false);
  assert.equal(opponentAnalyticsType("recorded"), "recorded");
});

test("the lobby classifies from row flags, not from isAi alone", () => {
  const src = read(LOBBY);
  assert.doesNotMatch(src, /row\.isAi \? "GRYND AI" : "Live player"/);
  assert.match(src, /classifyOpponent\(/);
  assert.match(src, /isGhost: solitaireDuelMatches\.isGhost/);
  assert.match(src, /player2Id: solitaireDuelMatches\.player2Id/);
  assert.match(src, /opponent: opponentLabel\(opponentKind\)/);
  assert.match(src, /opponentKind,/);
});

test("the match DTO carries the server's classification", () => {
  const src = read(STORE);
  assert.match(src, /opponentKind: classifyOpponent\(\{/);
});

test("settlement analytics distinguish recorded from live human", () => {
  const src = read(STORE);
  const idx = src.indexOf("opponent_type: classifyOpponent(");
  assert.ok(idx > -1, "settlement must use the classifier");
  assert.doesNotMatch(src, /opponent_type: finalRow\.isAi \? "ai" : "human"/);
});

test("the result screen shows the classification and never infers from names", () => {
  const src = read(RESULT);
  assert.match(src, /result-opponent-kind/);
  assert.match(src, /Recorded opponent/);
  assert.match(src, /GRYND AI/);
  assert.match(src, /Live player/);
  assert.doesNotMatch(src, /opponent\.name !== "GRYND AI"/);
  assert.match(src, /You beat a recorded opponent/);
  assert.match(src, /Beaten by a recorded opponent/);
});

test("the match page passes the server kind into the result", () => {
  const src = read(MATCH_PAGE);
  assert.match(src, /opponentKind\?: "human" \| "recorded" \| "ai"/);
  assert.match(src, /match\?\.opponentKind \?\? \(isPractice \? "ai" : ghost \? "recorded" : "human"\)/);
  assert.match(src, /Recorded opponent/);
});

test("the ranked lobby copy no longer promises a live player unconditionally", () => {
  const src = read(PVP_LOBBY);
  assert.doesNotMatch(src, /\["Opponent", "Live player"\]/);
  assert.match(src, /Live player or recorded run/);
});

test("matchmaking metrics are allowed and sanitized", () => {
  assert.ok(ALLOWED_PROPERTY_KEYS.includes("queue_duration_ms"));
  assert.ok(ALLOWED_PROPERTY_KEYS.includes("rating_diff"));
  const clean = sanitizeSolitaireProperties({
    mode: "ranked",
    queue_duration_ms: 12_345.6,
    rating_diff: 87,
    opponent_type: "recorded",
  });
  assert.equal(clean.queue_duration_ms, 12_346);
  assert.equal(clean.rating_diff, 87);
  assert.equal(clean.opponent_type, "recorded");
  // A negative or non-numeric gap is dropped, never guessed at.
  assert.deepEqual(
    sanitizeSolitaireProperties({ queue_duration_ms: -1, rating_diff: "90" }),
    {},
  );
});

const LOBBY_UI = "src/components/solitaire-duel/SolitaireLobby.tsx";

test("the lobby emits queue started/found/cancelled only on server success", () => {
  const src = read(LOBBY_UI);
  assert.match(src, /SOLITAIRE_EVENTS\.rankedQueueStarted/);
  assert.match(src, /SOLITAIRE_EVENTS\.rankedMatchFound/);
  assert.match(src, /SOLITAIRE_EVENTS\.rankedQueueCancelled/);
  assert.match(src, /queue_duration_ms: queueDuration\(\)/);
  // Cancellation is emitted inside the `res.ok` branch.
  const cancelBlock = src.slice(src.indexOf("const cancelWaiting"));
  const okAt = cancelBlock.indexOf("if (res.ok)");
  const eventAt = cancelBlock.indexOf("rankedQueueCancelled");
  assert.ok(okAt > -1 && eventAt > okAt);
});

test("match started carries the server kind and rating gap", () => {
  const src = read(MATCH_PAGE);
  assert.match(src, /opponent_type: match\.opponentKind \?\? "human"/);
  assert.match(src, /rating_diff: p1 != null && p2 != null \? Math\.abs\(p1 - p2\) : undefined/);
});

test("ghost settlement rates the human only, before any two-seat path", () => {
  const src = read(STORE);
  const fn = src.slice(src.indexOf("async function settleSolitaireDuelMatch("));
  const ghostAt = fn.indexOf("if (match.isGhost)");
  const aiAt = fn.indexOf("if (match.isAi)");
  assert.ok(ghostAt > -1 && aiAt > ghostAt, "ghost branch must run before the AI guard");
  const ghostBlock = fn.slice(ghostAt, aiAt);
  assert.match(ghostBlock, /applyGhostRatingResult\(/);
  assert.match(ghostBlock, /applyGhostTrophyResult\(/);
  // The ghost seat itself is never passed to a rating writer.
  assert.doesNotMatch(ghostBlock, /clerkId: match\.player2Id/);
  assert.match(ghostBlock, /const humanId = isGhostPlayerId\(match\.player2Id\)/);
});
