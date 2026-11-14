// tests/solitaire-mode-controls.test.mjs
//
// What each Solitaire mode offers the player while a run is live.
//
// SOLO and the DAILY CHALLENGE are single-player boards: undo, restart, a new
// deal and an exit. Undo rebuilds the board from the shortened move log, and an
// un-replayable stored log still rewinds to the deepest position the engine
// accepted — it can never leave the button doing nothing.
//
// RANKED is a live duel against another player. The server owns the board, so a
// move cannot be taken back (no undo) and leaving mid-match decides nothing (no
// exit): a ranked player either wins or loses, and the one way to concede is
// Resign, which stays.
//
// Run: node --test tests/solitaire-mode-controls.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");
const SOLO = "src/components/solitaire-duel/SoloSolitaireGame.tsx";
const MATCH = "src/app/casino/solitaire-duel/[matchId]/PageClient.tsx";
const RESULT = "src/components/result/PvpResultScreen.jsx";

test("solo keeps undo, restart, a new deal and an exit", () => {
  const solo = read(SOLO);

  assert.match(solo, /const undo = useCallback/, "the undo handler must exist");
  assert.match(solo, /onClick=\{undo\}/, "the Undo control runs it");
  assert.match(solo, /onClick=\{\(\) => guardExit\("restart", restart\)\}/);
  assert.match(solo, /onClick=\{\(\) => guardExit\("newDeal", newSoloGame\)\}/);
  assert.match(solo, /guardExit\("exit", \(\) => router\.push\("\/"\)\)/);
});

test("undo rewinds the last entry without ever becoming a silent no-op", () => {
  const solo = read(SOLO);

  // The board is the engine's own reconstruction of the shortened log.
  assert.match(solo, /const trimmed = current\.log\.slice\(0, -1\);/);
  assert.match(solo, /const replayed = replayMoves\(/);
  assert.match(solo, /state: replayed\.state, log/);
  assert.match(
    solo,
    /const log = replayed\.ok\s*\n\s*\? trimmed\s*\n\s*: trimmed\.slice\(0, Math\.max\(0, replayed\.rejectedAt \?\? 0\)\);/,
    "an un-replayable log must still rewind to the last accepted position",
  );
});

test("a ranked match offers Resign and neither undo nor an exit", () => {
  const match = read(MATCH);

  assert.match(match, /data-testid="solitaire-resign"/);
  assert.match(match, />\s*Resign\s*</, "Resign stays");
  // The rollback control is PRACTICE-only: it is mounted behind the `isPractice`
  // gate, so a ranked player — who is racing another person — never sees it.
  assert.match(match, /data-testid="solitaire-undo"/, "the control exists for practice");
  assert.match(
    match,
    /\{isPractice && phase === "racing" && !terminal && !expired && \(/,
    "and only a practice match can render it",
  );
  assert.match(match, /const canUndo =\s*\n\s*isPractice &&/);
  // No way out of a live match: the only exits are the waiting room (before a
  // match exists) and the result screen (after it has been decided).
  assert.doesNotMatch(match, />\s*Exit\s*</);
  // The other practice-only controls stay practice-only too.
  assert.match(match, /const canRestart = isPractice/);
});

test("practice undo is a server rollback of the seat's own log", () => {
  const match = read(MATCH);
  const route = read("src/app/api/solitaire-duel/match/[matchId]/undo/route.ts");
  const store = read("src/lib/solitaire-duel/serverStore.ts");

  // The page sends NOTHING but the request itself; the server owns the board.
  assert.match(match, /fetch\(`\$\{apiMatch\}\/undo`/);
  assert.match(match, /adopt\(data\.data\.match as MatchDto\)/);
  assert.match(route, /undoMove\(\{ userId, matchId \}\)/);
  assert.match(route, /requirePracticePlayer/);
  assert.match(
    store,
    /if \(!match\.isAi\) return err\("Undo is only available in a practice match", 409\)/,
  );
  // The rewind is the engine replaying the seat's own log without its last ply.
  assert.match(store, /const dropped = rows\[rows\.length - 1\];/);
  assert.match(store, /const replayed = replayMoves\(\{/);
  assert.match(store, /\.delete\(solitaireDuelMoves\)/);
  // A monotone settlement metric is never lowered by a rollback.
  assert.match(
    store,
    /nextState\.peakFoundation = Math\.max\(previousPeak, nextState\.peakFoundation \?\? 0\)/,
  );
});

test("ranked and practice results offer the shared post-match video", () => {
  const result = read(RESULT);

  assert.match(result, /<PostMatchAdSlot onDone=\{handleAdSettled\} \/>/);
  assert.match(result, /\{!compact && !portalSurface && adOpen && !postMatchAd && \(/);
});
