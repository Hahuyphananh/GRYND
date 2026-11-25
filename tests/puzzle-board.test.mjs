// tests/puzzle-board.test.mjs
//
// THE INTERACTIVE PUZZLE BOARD CONTRACT.
//
// Puzzle Ranked and Puzzle vs AI must reach a playable board from their
// lobbies, and that board must be the shipped `SolitaireBoard` talking to the
// server-authoritative session routes. The board may render a projected view
// and propose a move; it may never read a manifest, a seed or own a score.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { PLAY_HUB_TRANSLATIONS } from "../src/lib/playHubTranslations.js";

const ROOT = process.cwd();
const read = (relative) =>
  fs.readFileSync(path.join(ROOT, relative), "utf8").replace(/\r\n/g, "\n");

const PLAYER = "src/components/play/PuzzleSessionPlayer.tsx";
const RANKED = "src/components/play/PuzzleRankedLobby.tsx";
const AI = "src/components/play/PuzzleAiLobby.tsx";

test("both puzzle lobbies open the shared session board", () => {
  const ranked = read(RANKED);
  assert.match(ranked, /PuzzleSessionPlayer/);
  assert.match(ranked, /sessionId=\{queue\.sessionId\}/);
  assert.match(ranked, /mode="ranked"/);
  // A matched queue is the board, not another waiting message.
  assert.match(ranked, /if \(matched && queue\?\.sessionId\)/);

  const ai = read(AI);
  assert.match(ai, /PuzzleSessionPlayer/);
  assert.match(ai, /mode="ai"/);
  assert.match(ai, /onRestart=\{start\}/);
  assert.match(ai, /onChooseBot=\{reset\}/);
  // The picker is replaced only once the server returned a session id.
  assert.match(ai, /if \(sessionId\) \{/);
});

test("practice start mints a guest session for a signed-out visitor", () => {
  // GET/move need an existing guest, but CREATE must issue the signed guest
  // cookie itself — otherwise a signed-out visitor can never start practice.
  assert.match(
    read("src/app/api/solitaire-puzzle/ai/route.ts"),
    /requirePracticePlayer\(\{ create: true \}\)/,
  );
});

test("a cancel that loses the race re-reads the live match", () => {
  const ranked = read(RANKED);
  // DELETE may answer `cancelled: false` because an opponent took the seat in
  // the same instant; the lobby must not throw that live match away.
  assert.match(ranked, /cancelled\?: boolean/);
  assert.match(ranked, /cancelled === false[\s\S]{0,160}await read\(\);/);
});

test("the board uses the shipped SolitaireBoard and the server session routes", () => {
  const player = read(PLAYER);

  assert.match(player, /import SolitaireBoard from "\.\.\/solitaire-duel\/SolitaireBoard"/);
  assert.match(player, /view=\{view\.board\}/);
  assert.match(player, /interactive=\{live\}/);
  assert.match(player, /onMove=\{play\}/);

  // Reads and moves go through the authoritative endpoints.
  assert.match(player, /\/api\/solitaire-puzzle\/session\/\$\{sessionId\}/);
  assert.match(player, /\/api\/solitaire-puzzle\/session\/\$\{sessionId\}\/move/);
  assert.match(player, /method: "POST"/);
  assert.match(player, /body: JSON\.stringify\(\{ move, expectedPly: view\.ply \}\)/);

  // Practice/ranked pacing comes from server reads, not a local timer.
  assert.match(player, /setInterval\(\(\) => \{\s*void read\(\);/);

  // The only client state is what the projection returned.
  assert.doesNotMatch(player, /selectionSeed|selectionHash|manifest/);
  assert.doesNotMatch(player, /startState|stockOrder/);
  assert.doesNotMatch(player, /localStorage|sessionStorage/);

  // A projected board is null while waiting, and the board waits for GO.
  assert.match(player, /view\?\.status === "playing"/);
});

test("racing reads are reconciled and session failures are explicit", () => {
  const player = read(PLAYER);
  // A poll that resolves after a move must not roll the board back.
  assert.match(player, /reconcilePuzzleView\(current, next\)/);
  assert.match(player, /Math\.max\(offsetRef\.current, next\.serverNowMs - Date\.now\(\)\)/);
  // An expired ranked clock asks the server to finalize, once per session.
  assert.match(player, /expiryReadRef/);
  assert.match(player, /remainingMs > 0/);
  // Illegal (422) and stale/lifecycle (409) answers are told apart.
  assert.match(player, /res\.status === 422/);
  assert.match(player, /res\.status === 409/);
  assert.match(player, /puzzleBoard\.stale/);
  assert.match(player, /setVerdict\("illegal"\)/);
  assert.match(player, /playHub\.lobby\.puzzleBoard\.ended/);
  assert.match(player, /playHub\.lobby\.puzzleBoard\.stale/);
});

test("practice: a reload restores the same AI session and shows AI status", () => {
  const ai = read(AI);
  // The tab keeps only a session pointer; no match data is cached.
  assert.match(ai, /grynd:solitaire-puzzle:ai-session:v1/);
  assert.match(ai, /readStoredSession/);
  assert.match(ai, /storeSession/);
  assert.match(ai, /clearStoredSession/);
  assert.match(ai, /\/api\/solitaire-puzzle\/session\/\$\{stored\.sessionId\}/);
  assert.match(ai, /body\?\.data\?\.mode !== "ai"/);
  assert.match(ai, /restoredBotName/);
  assert.match(ai, /onRestart=\{start\}/);
  assert.match(ai, /onChooseBot=\{reset\}/);
  // The only match endpoints it touches are the AI create/roster reads and the
  // session board; it never calls a settlement, history or leaderboard route.
  assert.doesNotMatch(
    ai,
    /\/api\/(?:solitaire-puzzle\/history|leaderboard|rating|trophy)/i,
  );
  assert.match(ai, /\/api\/solitaire-puzzle\/ai/);

  const player = read(PLAYER);
  assert.match(player, /data-testid="puzzle-ai-status"/);
  assert.match(player, /puzzleBoard\.aiThinking/);
  assert.match(player, /puzzleBoard\.aiSolved/);
  assert.match(player, /puzzleBoard\.untimed/);
  // The AI's progress is the server count, never a local simulator.
  assert.match(player, /view\.opponentSolvedCount/);
});

test("forfeit stays on the ranked surface and is confirmed first", () => {
  const player = read(PLAYER);
  assert.match(player, /mode === "ranked" && view\.status === "playing"/);
  assert.match(player, /\/forfeit/);
  assert.match(player, /confirmingForfeit/);
  assert.match(player, /puzzle-session-forfeit-confirm/);
});

test("the result and both scores come from the server projection", () => {
  const player = read(PLAYER);
  assert.match(player, /const outcome = view\?\.result/);
  assert.match(player, /outcome\.winnerSeat === view\?\.seat/);
  assert.match(player, /outcome\.player1\.solved/);
  assert.match(player, /outcome\.player2\.solved/);
  assert.match(player, /outcome\.reward/);
  assert.match(player, /puzzle-session-rating/);
  assert.match(player, /puzzle-session-trophies/);
});

test("board copy exists in English, French and Spanish", () => {
  const keys = [
    "rankedKicker",
    "aiKicker",
    "puzzleOf",
    "objective",
    "you",
    "opponent",
    "human",
    "ai",
    "progress",
    "par",
    "remaining",
    "untimed",
    "aiThinking",
    "aiSolved",
    "aiNotSolved",
    "yourTurn",
    "checking",
    "illegal",
    "noProgress",
    "madeProgress",
    "complete",
    "win",
    "loss",
    "draw",
    "resolutionFinish",
    "resolutionDeadline",
    "resolutionForfeit",
    "resolutionDraw",
    "reconnecting",
    "forfeitWin",
    "forfeitLoss",
    "rating",
    "trophies",
    "forfeit",
    "forfeitAsk",
    "forfeitConfirm",
    "forfeitCancel",
    "backRanked",
    "backAi",
    "backPlay",
    "restart",
    "chooseBot",
    "loadError",
    "retry",
    "ended",
    "stale",
    "waiting",
    "loading",
  ];

  for (const language of ["en", "fr", "es"]) {
    const board = PLAY_HUB_TRANSLATIONS[language].lobby.puzzleBoard;
    assert.ok(board, `${language} needs a puzzleBoard bundle`);
    for (const key of keys) {
      assert.equal(typeof board[key], "string", `${language} missing ${key}`);
      assert.ok(board[key].trim().length > 0, `${language} empty ${key}`);
    }
  }
});
