/**
 * Chess VS-AI — evaluation persistence boundary.
 *
 * WHY THIS FILE EXISTS (and what it deliberately does NOT do)
 * -----------------------------------------------------------
 * Phase 4 asked for Chess VS-AI games to persist their move history through the
 * existing server-authoritative flow so eligible completed games can be
 * evaluated. The investigation found that the AI's move CANNOT be produced or
 * attested by the server today, so no persistence behavior was added. These
 * tests pin the boundary that makes any shortcut unsafe, plus the invariants a
 * correct fix must preserve. They intentionally do NOT assert a move-persistence
 * behavior that does not exist (such a test would fail by construction).
 *
 * THE BLOCKER, precisely:
 *   - The AI opponent is a CLIENT-SIDE minimax with a `Date.now()` deadline
 *     (src/app/casino/chess/ai/ChessAIPageInner.tsx → `pickBestMove`). Its chosen
 *     move depends on the device's CPU speed, so the server cannot reproduce it.
 *   - The only server-authoritative chess move route authorizes the caller as a
 *     SEAT of the game and stores `playedBy` = the authenticated caller. No
 *     authenticated caller can move for the AI. Recording the AI's move would
 *     require trusting a client-supplied move — forbidden by the task ("Do not
 *     trust a client to report arbitrary AI moves").
 *   A safe fix therefore needs the AI move to be generated server-side — a larger
 *   change that was intentionally not attempted.
 *
 * WHAT HAS SINCE CHANGED, AND WHAT HAS NOT
 *   The SEAT half of that redesign has landed: a VS-AI row now seats the human in
 *   the colour they chose and the `chess_ai_bot` sentinel in the other seat
 *   (src/lib/chessAiSeat.ts, src/lib/chessAiGameCreation.ts), so an AI game finally
 *   HAS an AI seat for a later stage to move from, and the server — not the
 *   browser — decides which side the human plays.
 *   The MOVE half has not: the bot's move is still generated in the browser, no
 *   move is persisted for an AI game, and nothing in this file asserts otherwise.
 *   The tests below were updated to pin the new seat model and the unchanged
 *   boundary around it.
 *
 * Run: npm run test:chess-ai-evaluation
 */

import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  MIN_EVALUABLE_PLIES,
  analyzeChessGame,
} from "../src/lib/evaluation/games/chessEvaluator.ts";
import { disposeChessEngine } from "../src/lib/evaluation/engine/stockfishEngine.ts";

// The engine is one shared, stateful WASM instance; release it so the process
// can exit on its own (no engine is started by these cases, but the module is
// imported transitively).
after(async () => {
  await disposeChessEngine();
});

const read = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");

const MOVE = read("src/app/api/chess/move/route.js");
const END_GAME = read("src/app/api/chess/end-game/route.js");
const CREATE_AI = read("src/app/api/chess/create-ai-game/route.js");
const SERVICE = read("src/lib/evaluation/evaluationService.ts");
const AI_PAGE = read("src/app/casino/chess/ai/ChessAIPageInner.tsx");
const PVP_PAGE = read("src/app/casino/chess-game/[gameId]/PageClient.jsx");

const UUID = "11111111-1111-4111-8111-111111111111";

// ════════════════════════════════════════════════════════════════════
// 1. The move route authorizes ONLY a verified seat of the game
// ════════════════════════════════════════════════════════════════════

test("the move route derives the mover from the game's seats — never from the request", () => {
  assert.match(MOVE, /const isWhitePlayer = userAliases\.has\(String\(game\.playerWhiteId\)\)/);
  assert.match(MOVE, /const isBlackPlayer = userAliases\.has\(String\(game\.playerBlackId\)\)/);
  assert.match(MOVE, /if \(!isWhitePlayer && !isBlackPlayer\) \{/);
  // The stored mover is the AUTHENTICATED caller, not a body field.
  assert.match(MOVE, /playedBy: userId,/);
});

test("the turn and the move's legality come from the stored history", () => {
  // The position is rebuilt from the persisted moves, so a retry or a replayed
  // request cannot insert a second row once the turn has flipped.
  assert.match(MOVE, /const moves = await db\s*\.select\(\)\s*\.from\(chessMoves\)/);
  assert.match(MOVE, /const expectedTurn = isWhite \? "w" : "b"/);
  assert.match(MOVE, /if \(chess\.turn\(\) !== expectedTurn\) \{/);
  assert.match(MOVE, /\{ error: "Not your turn" \},\s*\{ status: 409 \}/);
  // Only chess.js decides legality; a rejected move is never persisted.
  assert.match(MOVE, /const playedMove = chess\.move\(\{ from, to, promotion \}\)/);
  assert.match(MOVE, /\{ error: "Illegal move" \},\s*\{ status: 400 \}/);
});

// ════════════════════════════════════════════════════════════════════
// 2. An AI game has NO AI seat, so the route cannot carry an AI move
// ════════════════════════════════════════════════════════════════════

test("an AI game seats the human AND the bot, so a later stage has a seat to move from", () => {
  // The seats are decided by the tested module, not spelled out in the route.
  assert.match(CREATE_AI, /const result = await createChessAiGame\(/);
  assert.match(CREATE_AI, /humanColor: result\.humanColor,/);
  assert.ok(
    !CREATE_AI.includes("playerBlackId: null"),
    "the bot occupies a seat now; a NULL seat means 'unclaimed' everywhere else",
  );
  // The AI is identified by the shared sentinel, so `is_ai_game` keeps saying a
  // bot is playing and `ai_difficulty` keeps saying how strong it is.
  const SEAT = read("src/lib/chessAiSeat.ts");
  assert.match(SEAT, /export const CHESS_AI_PLAYER_ID = "chess_ai_bot";/);
  assert.match(SEAT, /export function chessSeatsForHumanColor\(/);
});

test("the AI page draws its colour from the server's resolved seat, and still moves the bot locally", () => {
  // The colour is no longer rolled in the browser: the lobby puts the creation
  // response's `humanColor` in the URL, and the page treats a concrete value as
  // the server's answer — resolved once per URL, so the first paint, the
  // initialise pass and a restart cannot disagree.
  assert.match(
    AI_PAGE,
    /const serverColor = useMemo\(\s*\(\) => resolveInitialPlayerColor\(colorParam\),/,
  );
  assert.match(AI_PAGE, /const \[playerColor, setPlayerColor\] = useState<"white" \| "black">\(serverColor\);/);
  assert.ok(!AI_PAGE.includes("Math.random"), "no independent colour roll is left");
  // The AI's move, however, is STILL generated locally with a wall-clock budget
  // — not reproducible server-side. That is the half of the blocker this stage
  // deliberately left alone, and it is why no move is persisted here.
  assert.match(AI_PAGE, /function pickBestMove\(game: Chess, aiColor: "w" \| "b", aiLevel: number\)/);
  assert.match(AI_PAGE, /const deadline = Date\.now\(\) \+ budgetMs;/);
});

// ════════════════════════════════════════════════════════════════════
// 3. Abandoned AI games are expired, never finished
// ════════════════════════════════════════════════════════════════════

test("ending an AI game marks it expired and never fabricates a finish", () => {
  assert.match(
    END_GAME,
    /if \(lockedGame\.isAiGame\) \{\s*await tx[\s\S]{0,200}\{ status: "expired", endedAt: new Date\(\) \}/,
  );
  // The AI branch returns before any `status: "finished"` write can run.
  const aiBranch = END_GAME.indexOf("if (lockedGame.isAiGame)");
  const finishedWrite = END_GAME.indexOf('status: "finished"');
  assert.ok(aiBranch > -1, "the AI branch must exist");
  assert.ok(
    finishedWrite > aiBranch,
    "no finish write may precede the AI branch",
  );
  assert.match(
    END_GAME.slice(aiBranch, aiBranch + 400),
    /return;/,
    "the AI branch must return before the PvP finish path",
  );
});

test("the evaluation service refuses anything that is not finished (409)", () => {
  assert.match(SERVICE, /if \(String\(match\.status\) !== "finished"\) \{/);
  assert.match(SERVICE, /code: "match_not_finished"/);
  // The behavioural proof (in_progress/waiting/expired/active → 409) already
  // lives in tests/evaluation-route.test.mjs.
});

// ════════════════════════════════════════════════════════════════════
// 4. With no persisted history, a game is not evaluable — nothing invented
// ════════════════════════════════════════════════════════════════════

test("zero persisted moves is reported as too_few_moves, never as an analysis", async () => {
  assert.equal(MIN_EVALUABLE_PLIES, 5);

  const empty = await analyzeChessGame({
    gameId: UUID,
    playerWhiteId: "u-white",
    playerBlackId: null,
    moves: [],
  });
  assert.equal(empty.sufficient, false);
  assert.equal(empty.reason, "too_few_moves");
  assert.equal(empty.plyCount, 0);
  assert.match(empty.detail, /0 plies/);
});

test("a short AI history below the threshold is also refused, honestly", async () => {
  // Four plies (the classic 1.e4 e5 2.Nf3 Nc6) is below MIN_EVALUABLE_PLIES.
  const fen1 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1";
  const fen2 = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2";
  const fen3 = "rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2";
  const fen4 = "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3";
  const withMoves = await analyzeChessGame({
    gameId: UUID,
    playerWhiteId: "u-white",
    playerBlackId: "ai",
    moves: [
      { san: "e4", uci: "e2e4", fenAfter: fen1, playedBy: "u-white" },
      { san: "e5", uci: "e7e5", fenAfter: fen2, playedBy: "ai" },
      { san: "Nf3", uci: "g1f3", fenAfter: fen3, playedBy: "u-white" },
      { san: "Nc6", uci: "b8c6", fenAfter: fen4, playedBy: "ai" },
    ],
  });
  assert.equal(withMoves.sufficient, false);
  assert.equal(withMoves.reason, "too_few_moves");
  assert.equal(withMoves.plyCount, 4);
});

// ════════════════════════════════════════════════════════════════════
// 5. Existing PvP move behavior is unchanged
// ════════════════════════════════════════════════════════════════════

test("PvP still posts every move to POST /api/chess/move", () => {
  assert.ok(
    PVP_PAGE.includes('fetch("/api/chess/move"'),
    "the PvP page must keep using the authoritative move route",
  );
});

test("the move route inserts exactly one row per accepted move and finalizes server-side", () => {
  // One insert call in the route — an accepted move writes a single row.
  assert.equal(MOVE.split("db.insert(chessMoves)").length - 1, 1);
  // Completion is decided by the server's own chess.js instance, and the winner
  // is the mover who delivered it (or null for a draw).
  assert.match(MOVE, /if \(chess\.isGameOver\(\)\) \{/);
  assert.match(MOVE, /const winnerId = isDraw \? null : userId;/);
  assert.match(
    MOVE,
    /status: "finished",\s*winnerId,\s*result: isDraw \? "draw" : "win",/,
  );
  // AI games never move Elo or trophies (unchanged, and why an AI finish would
  // not be a competitive result).
  assert.match(MOVE, /if \(!isDraw && !lockedGame\.isAiGame && winnerId\) \{/);
});
