// tests/chess-ai-standalone.test.mjs
//
// Phase 2 contract tests for the standalone Chess AI game. Everything here runs
// in Node with no browser, no WASM and no network:
//
//   * src/match.ts    — rules, seats, clocks, undo, result classification
//   * src/engine.ts   — worker protocol, serialisation, timeouts, legality
//   * src/selfplay.ts — a whole game through the adapter, with a fake engine
//
// The engine is faked at the TRANSPORT seam (the same seam the browser uses), so
// the queue/timeout/validation logic under test is the real production logic.

import assert from "node:assert/strict";
import test from "node:test";
import { Chess } from "chess.js";

import {
  CHESS_AI_SEARCH_SETTINGS,
  coerceChessAiDifficulty,
  settingsForChessAiDifficulty,
} from "../standalone/chess-ai/src/chessDifficulty.ts";
import {
  applyMove,
  applyUci,
  clockRemaining,
  createLocalMatch,
  DEFAULT_INITIAL_TIME_MS,
  legalUci,
  resign,
  terminationOf,
  tick,
  undo,
  view,
} from "../standalone/chess-ai/src/match.ts";
import { ChessEngineError, createChessEngine } from "../standalone/chess-ai/src/engine.ts";
import { playSelfPlay } from "../standalone/chess-ai/src/selfplay.ts";
import {
  boardOrientation,
  capturedPieces,
  formatClock,
  isPromotionMove,
  kingSquare,
  legalTargetsFrom,
  moveRows,
  resultCopy,
} from "../standalone/chess-ai/src/uiLogic.ts";

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const MATE_IN_ONE = "6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1";
const MATED = "R5k1/5ppp/8/8/8/8/5PPP/6K1 b - - 0 1";
const STALEMATE = "7k/5Q2/6K1/8/8/8/8/8 b - - 0 1";

/** First legal move, as stored UCI. */
function firstLegal(fen) {
  const chess = new Chess(fen);
  const moves = chess.moves({ verbose: true });
  if (moves.length === 0) return null;
  const move = moves[0];
  return `${move.from}${move.to}${move.promotion ?? ""}`;
}

/** A fake UCI engine at the transport seam. */
function fakeTransport({ choose, silent = false, bootSilent = false } = {}) {
  const lineListeners = new Set();
  const sent = [];
  let fen = null;
  let goCount = 0;

  const emit = (line, delay = 0) => {
    setTimeout(() => {
      for (const listener of [...lineListeners]) listener(line);
    }, delay);
  };

  return {
    sent,
    get goCount() {
      return goCount;
    },
    send(command) {
      sent.push(command);
      if (command === "uci") {
        if (!bootSilent) {
          emit("id name Fakefish 1");
          emit("uciok");
        }
        return;
      }
      if (command === "isready") {
        if (!bootSilent) emit("readyok");
        return;
      }
      if (command.startsWith("position fen ")) {
        fen = command.slice("position fen ".length);
        return;
      }
      if (command.startsWith("go ")) {
        goCount += 1;
        if (silent) return;
        const move = choose ? choose(fen) : firstLegal(fen);
        emit(`bestmove ${move ?? "(none)"}`, 1);
      }
    },
    subscribeLine(listener) {
      lineListeners.add(listener);
      return () => lineListeners.delete(listener);
    },
    subscribeError() {
      return () => {};
    },
    terminate() {},
  };
}

function engineWith(transport, options = {}) {
  return createChessEngine({
    url: "fake://engine",
    transport: () => transport,
    ...options,
  });
}

// ── difficulty table (copied pure module) ───────────────────────────────

test("the three shipped tiers keep their production settings", () => {
  assert.equal(CHESS_AI_SEARCH_SETTINGS.easy.skillLevel, 0);
  assert.equal(CHESS_AI_SEARCH_SETTINGS.medium.skillLevel, 8);
  assert.equal(CHESS_AI_SEARCH_SETTINGS.hard.skillLevel, 20);
  assert.equal(CHESS_AI_SEARCH_SETTINGS.hard.slipTier, null);
  assert.equal(settingsForChessAiDifficulty("normal").skillLevel, 8);
});

test("legacy 1–5 levels still resolve to the same tiers", () => {
  assert.equal(coerceChessAiDifficulty(1), "easy");
  assert.equal(coerceChessAiDifficulty(3), "medium");
  assert.equal(coerceChessAiDifficulty(5), "hard");
  assert.equal(coerceChessAiDifficulty("expert"), "hard");
  assert.equal(coerceChessAiDifficulty(undefined), "medium");
});

// ── match controller ────────────────────────────────────────────────────

test("a new match starts on the human's seat with the default clock", () => {
  const match = createLocalMatch({ humanColor: "white", now: 1_000 });
  assert.equal(match.status, "playing");
  assert.equal(match.chess.fen(), START_FEN);
  assert.equal(match.clockMs.white, DEFAULT_INITIAL_TIME_MS);
  assert.equal(match.clockMs.black, DEFAULT_INITIAL_TIME_MS);
  assert.equal(view(match, 1_000).isHumanTurn, true);
  assert.equal(view(match, 1_000).aiColor, "black");
  assert.deepEqual(match.history, []);
});

test("a human move is recorded and hands the turn to the AI", () => {
  const match = createLocalMatch({ humanColor: "white", now: 0 });
  const result = applyMove(match, { from: "e2", to: "e4" }, 1_000);
  assert.equal(result.ok, true);
  assert.equal(result.record.san, "e4");
  assert.equal(result.record.uci, "e2e4");
  assert.equal(match.history.length, 1);
  assert.equal(view(match, 1_000).isAiTurn, true);
  assert.equal(match.chess.turn(), "b");
});

test("an illegal move is refused without touching the position or history", () => {
  const match = createLocalMatch({ humanColor: "white", now: 0 });
  const result = applyMove(match, { from: "e2", to: "e5" }, 1_000);
  assert.equal(result.ok, false);
  assert.equal(match.history.length, 0);
  assert.equal(match.chess.fen(), START_FEN);
});

test("the AI reply is applied through the same path", () => {
  const match = createLocalMatch({ humanColor: "white", now: 0 });
  applyUci(match, "e2e4", 1_000);
  const reply = applyUci(match, "e7e5", 2_000);
  assert.equal(reply.ok, true);
  assert.equal(reply.record.color, "black");
  assert.equal(match.history.length, 2);
  assert.equal(view(match, 2_000).isHumanTurn, true);
});

test("undo takes back the human move and the AI reply as one pair", () => {
  const match = createLocalMatch({ humanColor: "white", now: 0 });
  applyUci(match, "e2e4", 1_000);
  applyUci(match, "e7e5", 2_000);
  assert.equal(undo(match, 3_000), true);
  assert.equal(match.history.length, 0);
  assert.equal(match.chess.fen(), START_FEN);
  assert.equal(view(match, 3_000).isHumanTurn, true);
});

test("undo after the human moved but before the AI replied removes one ply", () => {
  const match = createLocalMatch({ humanColor: "white", now: 0 });
  applyUci(match, "e2e4", 1_000);
  assert.equal(undo(match, 2_000), true);
  assert.equal(match.history.length, 0);
  assert.equal(match.chess.turn(), "w");
});

test("undo is refused once the match is over", () => {
  const match = createLocalMatch({ humanColor: "black", fen: MATE_IN_ONE, now: 0 });
  applyUci(match, "a1a8", 1_000);
  assert.equal(match.status, "finished");
  assert.equal(undo(match, 2_000), false);
});

test("resigning is a loss for the human", () => {
  const match = createLocalMatch({ humanColor: "white", now: 0 });
  resign(match);
  assert.equal(match.status, "finished");
  assert.equal(match.outcome, "loss");
  assert.equal(match.reason, "resign");
});

test("checkmate is a win for the side that delivered it", () => {
  const match = createLocalMatch({ humanColor: "white", fen: MATE_IN_ONE, now: 0 });
  const result = applyUci(match, "a1a8", 1_000);
  assert.equal(result.ok, true);
  assert.equal(result.record.san, "Ra8#");
  assert.equal(match.status, "finished");
  assert.equal(match.outcome, "win");
  assert.equal(match.reason, "checkmate");
});

test("a mated human reports a loss", () => {
  // Human plays black; white is already delivering mate with the same move.
  const match = createLocalMatch({ humanColor: "black", fen: MATE_IN_ONE, now: 0 });
  applyUci(match, "a1a8", 1_000);
  assert.equal(match.outcome, "loss");
  assert.equal(match.reason, "checkmate");
});

test("a position that starts in stalemate finishes as a draw immediately", () => {
  const match = createLocalMatch({ humanColor: "white", fen: STALEMATE, now: 0 });
  assert.equal(match.status, "finished");
  assert.equal(match.outcome, "draw");
  assert.equal(match.reason, "stalemate");
  assert.equal(terminationOf(new Chess(STALEMATE)), "stalemate");
});

test("running out of time loses for the human and stops the clock", () => {
  const match = createLocalMatch({ humanColor: "white", initialTimeMs: 1_000, now: 0 });
  const after = tick(match, 1_500);
  assert.equal(after.finished, true);
  assert.equal(match.status, "finished");
  assert.equal(match.outcome, "loss");
  assert.equal(match.reason, "timeout");
  assert.equal(match.turnStartedAt, null);
  assert.equal(tick(match, 2_000).finished, true);
});

test("clocks only tick for the side to move, and moves settle the mover", () => {
  const match = createLocalMatch({ humanColor: "white", initialTimeMs: 60_000, now: 1_000 });
  applyUci(match, "e2e4", 6_000); // white spent 5s
  const clocks = clockRemaining(match, 8_000); // black has been thinking 2s
  assert.equal(clocks.white, 55_000);
  assert.equal(clocks.black, 58_000);
  assert.equal(match.clockMs.white, 55_000);
});

test("a malformed UCI string is rejected, never guessed", () => {
  const match = createLocalMatch({ humanColor: "white", now: 0 });
  assert.equal(applyUci(match, "not-a-move", 1_000).ok, false);
  assert.equal(applyUci(match, "", 1_000).ok, false);
  assert.equal(match.history.length, 0);
});

test("legalUci lists exactly the position's legal moves", () => {
  const match = createLocalMatch({ humanColor: "white", now: 0 });
  assert.equal(legalUci(match).length, 20);
  applyUci(match, "e2e4", 1_000);
  assert.equal(legalUci(match).length, 20);
});

test("view() reports the seat, clocks and undo affordance", () => {
  const match = createLocalMatch({ humanColor: "black", now: 0 });
  const start = view(match, 0);
  assert.equal(start.isAiTurn, true);
  assert.equal(start.canUndo, false);
  applyUci(match, "e2e4", 1_000); // the AI opens as White
  const after = view(match, 1_000);
  assert.equal(after.isHumanTurn, true);
  assert.equal(after.canUndo, true);
});

// ── engine adapter ──────────────────────────────────────────────────────

test("the adapter completes the UCI handshake and reports identity", async () => {
  const transport = fakeTransport();
  const engine = engineWith(transport);
  const ready = await engine.ready();
  assert.match(ready.identity, /Fakefish/);
  assert.ok(ready.bootMs >= 0);
  engine.dispose();
});

test("chooseMove returns a legal move and the tier's settings", async () => {
  const transport = fakeTransport();
  const engine = engineWith(transport);
  const choice = await engine.chooseMove(START_FEN, "hard");
  assert.ok(choice.uci);
  assert.ok(legalUci(createLocalMatch({ fen: START_FEN })).includes(choice.uci));
  assert.equal(choice.settings.skillLevel, 20);
  assert.ok(choice.ms >= 0);
  engine.dispose();
});

test("an engine answer that is illegal in the position is an error, not a move", async () => {
  const transport = fakeTransport({ choose: () => "e2e5" });
  const engine = engineWith(transport);
  await assert.rejects(() => engine.chooseMove(START_FEN, "easy"), ChessEngineError);
  engine.dispose();
});

test("a malformed engine answer is an error", async () => {
  const transport = fakeTransport({ choose: () => "definitely-not-uci" });
  const engine = engineWith(transport);
  await assert.rejects(() => engine.chooseMove(START_FEN, "easy"), ChessEngineError);
  engine.dispose();
});

test("a mated position resolves to no move without searching", async () => {
  const transport = fakeTransport();
  const engine = engineWith(transport);
  const choice = await engine.chooseMove(MATED, "hard");
  assert.equal(choice.uci, null);
  assert.equal(transport.goCount, 0);
  engine.dispose();
});

test("searches are serialised — a second move never overlaps the first", async () => {
  const lineListeners = new Set();
  let fen = null;
  let inFlight = false;
  let overlap = false;
  const transport = {
    send(command) {
      if (command === "uci") {
        setTimeout(() => lineListeners.forEach((l) => l("uciok")), 1);
        return;
      }
      if (command === "isready") {
        setTimeout(() => lineListeners.forEach((l) => l("readyok")), 1);
        return;
      }
      if (command.startsWith("position fen ")) {
        fen = command.slice("position fen ".length);
        return;
      }
      if (command.startsWith("go ")) {
        if (inFlight) overlap = true;
        inFlight = true;
        const move = firstLegal(fen);
        setTimeout(() => {
          inFlight = false;
          lineListeners.forEach((l) => l(`bestmove ${move}`));
        }, 20);
      }
    },
    subscribeLine(listener) {
      lineListeners.add(listener);
      return () => lineListeners.delete(listener);
    },
    subscribeError() {
      return () => {};
    },
    terminate() {},
  };

  const engine = engineWith(transport);
  const [first, second] = await Promise.all([
    engine.chooseMove(START_FEN, "easy"),
    engine.chooseMove(START_FEN, "easy"),
  ]);
  assert.equal(overlap, false);
  assert.ok(first.uci && second.uci);
  engine.dispose();
});

test("a search that never answers fails at its deadline", async () => {
  const engine = engineWith(fakeTransport({ silent: true }));
  await assert.rejects(
    () => engine.chooseMove(START_FEN, "easy", { timeoutMs: 60 }),
    /timed out waiting for bestmove/
  );
  engine.dispose();
});

test("a boot that never answers fails at its deadline", async () => {
  const engine = engineWith(fakeTransport({ bootSilent: true }), { bootTimeoutMs: 60 });
  await assert.rejects(() => engine.ready(), /timed out waiting for uciok/);
  engine.dispose();
});

test("a disposed engine refuses further work", async () => {
  const engine = engineWith(fakeTransport());
  await engine.ready();
  engine.dispose();
  await assert.rejects(() => engine.chooseMove(START_FEN, "easy"), /disposed/);
});

// ── self-play driver ────────────────────────────────────────────────────

const fakeEngine = {
  async chooseMove(fen) {
    return { uci: firstLegal(fen), ms: 0, settings: {} };
  },
};

test("self-play plays a run of legal plies and records them", async () => {
  const report = await playSelfPlay(fakeEngine, {
    whiteTier: "easy",
    blackTier: "easy",
    maxPlies: 12,
  });
  assert.equal(report.plies, 12);
  assert.equal(report.moves.length, 12);
  assert.ok(report.moves.every((move) => move.san.length > 0 && move.uci.length >= 4));
  assert.equal(report.stalled, false);
});

test("self-play detects a checkmate and its winner", async () => {
  // A ``mate first`` engine, so the game ends on the mating move rather than on
  // whichever move happens to be generated first.
  const matingEngine = {
    async chooseMove(fen) {
      const moves = new Chess(fen).moves({ verbose: true });
      const mate = moves.find((move) => move.san.includes("#")) ?? moves[0];
      if (!mate) return { uci: null, ms: 0, settings: {} };
      return { uci: `${mate.from}${mate.to}${mate.promotion ?? ""}`, ms: 0, settings: {} };
    },
  };
  const report = await playSelfPlay(matingEngine, {
    whiteTier: "hard",
    blackTier: "easy",
    fen: MATE_IN_ONE,
    maxPlies: 5,
  });
  assert.equal(report.termination, "checkmate");
  assert.equal(report.winner, "white");
  assert.equal(report.plies, 1);
});

// ── board presentation (Phase 3) ────────────────────────────────────────

test("ui: clocks render as mm:ss and never go negative", () => {
  assert.equal(formatClock(300_000), "05:00");
  assert.equal(formatClock(61_000), "01:01");
  assert.equal(formatClock(999), "00:00");
  assert.equal(formatClock(-5_000), "00:00");
});

test("ui: click targets are exactly the legal moves from a square", () => {
  const targets = legalTargetsFrom(START_FEN, "e2");
  assert.deepEqual(targets.map((target) => target.to).sort(), ["e3", "e4"]);
  assert.ok(targets.every((target) => target.capture === false));
  assert.deepEqual(legalTargetsFrom(START_FEN, "e7"), []);
  assert.deepEqual(legalTargetsFrom(START_FEN, null), []);
  assert.deepEqual(legalTargetsFrom("not-a-fen", "e2"), []);
});

test("ui: promotion is detected only for a pawn reaching the far rank", () => {
  const promotionFen = "4k3/P7/8/8/8/8/8/4K3 w - - 0 1";
  assert.equal(isPromotionMove(promotionFen, "a7", "a8"), true);
  assert.equal(isPromotionMove(promotionFen, "a8", "a7"), false);
  assert.equal(isPromotionMove(START_FEN, "e2", "e4"), false);
  assert.equal(isPromotionMove(START_FEN, null, "e4"), false);
  const queenOnFarRank = "4k3/Q7/8/8/8/8/8/4K3 w - - 0 1";
  assert.equal(isPromotionMove(queenOnFarRank, "a7", "a8"), false);
});

test("ui: the checked king is the square the board highlights", () => {
  assert.equal(kingSquare("4k3/8/8/8/8/8/4R3/4K3 b - - 0 1"), "e8");
  assert.equal(kingSquare(START_FEN), null);
  assert.equal(kingSquare("not-a-fen"), null);
});

test("ui: captured pieces are grouped by the seat that took them", () => {
  const missingBlackQueen = "rnb1kbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
  const captured = capturedPieces(missingBlackQueen);
  assert.deepEqual(captured.byWhite, ["♛"]);
  assert.deepEqual(captured.byBlack, []);
  assert.deepEqual(capturedPieces(START_FEN), { byWhite: [], byBlack: [] });
});

test("ui: the move list pairs plies into numbered rows", () => {
  const match = createLocalMatch({ humanColor: "white", now: 0 });
  applyUci(match, "e2e4", 1_000);
  applyUci(match, "e7e5", 2_000);
  applyUci(match, "g1f3", 3_000);
  const rows = moveRows(match.history);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].number, 1);
  assert.equal(rows[0].white.san, "e4");
  assert.equal(rows[0].black.san, "e5");
  assert.equal(rows[1].number, 2);
  assert.equal(rows[1].white.san, "Nf3");
  assert.equal(rows[1].black, null);
});

test("ui: result copy speaks from the human's seat", () => {
  const win = resultCopy("win", "checkmate");
  assert.equal(win.title, "You win");
  assert.equal(win.detail, "Checkmate.");
  const loss = resultCopy("loss", "timeout");
  assert.equal(loss.title, "You lose");
  assert.match(loss.detail, /clock/i);
  const draw = resultCopy("draw", "stalemate");
  assert.equal(draw.title, "Draw");
  assert.equal(draw.tone, "draw");
});

test("ui: the board faces the human's seat", () => {
  assert.equal(boardOrientation("white"), "white");
  assert.equal(boardOrientation("black"), "black");
});

test("self-play refuses an illegal engine move instead of playing it", async () => {
  const cheating = { chooseMove: async () => ({ uci: "e2e5", ms: 0, settings: {} }) };
  await assert.rejects(
    () =>
      playSelfPlay(cheating, {
        whiteTier: "easy",
        blackTier: "easy",
        maxPlies: 4,
      }),
    /illegal move/
  );
});
