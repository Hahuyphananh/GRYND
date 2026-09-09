"use client";

import { useState, useEffect, useRef, useMemo } from "react";
import { Chess } from "chess.js";
import { useRouter, useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";
import { AnimatePresence, motion } from "framer-motion";
// Shared Creator Mode foundation (admin-only): mounts the viewport
// recorder + overlay and auto-starts when the AI battle is live, stops
// once the game-over popup has been captured. No gameplay logic touched.
import CreatorModeHost from "../../../../components/creator-mode/CreatorModeHost";
import { CreatorResponsiveLayout } from "../../../../components/creator-mode/CreatorModeLayout";
import NavigationBar from "../../../../components/navigation-bar";
import PvpResultScreen from "../../../../components/result/PvpResultScreen";
import IconAvatar from "../../../../components/IconAvatar";
import useMySeatIdentity from "../../../../hooks/useMySeatIdentity";
import { turnBanner as turnBannerAnim } from "../../../../lib/animations";
import { playCardDraw, playVictory, playDefeat, playTick } from "../../../../lib/gameAudio";
import { useChessClock } from "../../../../lib/useChessClock";
import { usePostHog } from "posthog-js/react";
import {
  IconAlertTriangle,
  IconRobot,
  IconBulb,
  IconVolume,
  IconVolumeOff,
} from "@tabler/icons-react";

function formatClock(seconds: number) {
  const safe = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

const Chessboard = dynamic(
  async () => {
    const mod = await import("react-chessboard");
    return mod.Chessboard;
  },
  { ssr: false },
);

const PIECE_SYMBOLS: Record<string, string> = {
  p: "♟", n: "♞", b: "♝", r: "♜", q: "♛",
  P: "♙", N: "♘", B: "♗", R: "♖", Q: "♕",
};

const PIECE_VALS: Record<string, number> = {
  p: 1, n: 3, b: 3, r: 5, q: 9,
  P: 1, N: 3, B: 3, R: 5, Q: 9,
};

const INITIAL_PIECES: Record<string, number> = {
  p: 8, n: 2, b: 2, r: 2, q: 1,
  P: 8, N: 2, B: 2, R: 2, Q: 1,
};

const SYMBOL_TO_KEY: Record<string, string> = {};
for (const [k, v] of Object.entries(PIECE_SYMBOLS)) SYMBOL_TO_KEY[v] = k;

// ── AI evaluation tables ──

const PIECE_VALUES: Record<string, number> = {
  p: 100, n: 320, b: 330, r: 500, q: 900, k: 20000,
};

const PST: Record<string, number[]> = {
  p: [
    0, 0, 0, 0, 0, 0, 0, 0, 50, 50, 50, 50, 50, 50, 50, 50, 10, 10, 20, 30, 30,
    20, 10, 10, 5, 5, 10, 25, 25, 10, 5, 5, 0, 0, 0, 20, 20, 0, 0, 0, 5, -5,
    -10, 0, 0, -10, -5, 5, 5, 10, 10, -20, -20, 10, 10, 5, 0, 0, 0, 0, 0, 0, 0,
    0,
  ],
  n: [
    -50, -40, -30, -30, -30, -30, -40, -50, -40, -20, 0, 5, 5, 0, -20, -40, -30,
    5, 10, 15, 15, 10, 5, -30, -30, 0, 15, 20, 20, 15, 0, -30, -30, 5, 15, 20,
    20, 15, 5, -30, -30, 0, 10, 15, 15, 10, 0, -30, -40, -20, 0, 0, 0, 0, -20,
    -40, -50, -40, -30, -30, -30, -30, -40, -50,
  ],
  b: [
    -20, -10, -10, -10, -10, -10, -10, -20, -10, 5, 0, 0, 0, 0, 5, -10, -10, 10,
    10, 10, 10, 10, 10, -10, -10, 0, 10, 10, 10, 10, 0, -10, -10, 5, 5, 10, 10,
    5, 5, -10, -10, 0, 5, 10, 10, 5, 0, -10, -10, 0, 0, 0, 0, 0, 0, -10, -20,
    -10, -10, -10, -10, -10, -10, -20,
  ],
  r: [
    0, 0, 0, 0, 0, 0, 0, 0, 5, 10, 10, 10, 10, 10, 10, 5, -5, 0, 0, 0, 0, 0, 0,
    -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0,
    0, -5, -5, 0, 0, 0, 0, 0, 0, -5, 0, 0, 0, 5, 5, 0, 0, 0,
  ],
  q: [
    -20, -10, -10, -5, -5, -10, -10, -20, -10, 0, 5, 0, 0, 0, 0, -10, -10, 5, 5,
    5, 5, 5, 0, -10, 0, 0, 5, 5, 5, 5, 0, -5, -5, 0, 5, 5, 5, 5, 0, -5, -10, 0,
    5, 5, 5, 5, 0, -10, -10, 0, 0, 0, 0, 0, 0, -10, -20, -10, -10, -5, -5, -10,
    -10, -20,
  ],
  k: [
    -30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40,
    -30, -30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40,
    -40, -30, -20, -30, -30, -40, -40, -30, -30, -20, -10, -20, -20, -20, -20,
    -20, -20, -10, 20, 20, 0, 0, 0, 0, 20, 20, 20, 30, 10, 0, 0, 10, 30, 20,
  ],
};

function toIndex(square: string) {
  const file = square.charCodeAt(0) - 97;
  const rank = Number(square[1]) - 1;
  return (7 - rank) * 8 + file;
}

function pieceSquareValue(type: string, color: "w" | "b", square: string) {
  const table = PST[type] || null;
  if (!table) return 0;
  const idx = toIndex(square);
  return color === "w" ? table[idx] : table[63 - idx];
}

function evaluatePosition(game: Chess, aiColor: "w" | "b") {
  if (game.isCheckmate()) {
    return game.turn() === aiColor ? -999999 : 999999;
  }
  // isDraw() already covers stalemate / insufficient material / threefold
  // repetition — no need to re-check them separately (each check is a full
  // move generation or history scan, and this runs at every leaf).
  if (game.isDraw()) return 0;

  let score = 0;
  const board = game.board();
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const piece = board[r][f];
      if (!piece) continue;
      const square = String.fromCharCode(97 + f) + (8 - r);
      const val =
        PIECE_VALUES[piece.type] +
        pieceSquareValue(piece.type, piece.color as "w" | "b", square);
      score += piece.color === aiColor ? val : -val;
    }
  }
  // NOTE: the old mobility bonus (game.moves().length) is gone — it cost a
  // full move generation at every leaf, which dominated the search time on
  // the main thread and froze the tab at higher levels.
  return score;
}

function orderedMoves(game: Chess) {
  return game.moves({ verbose: true }).sort((a, b) => {
    const aScore =
      (a.captured ? 10 : 0) +
      (a.promotion ? 8 : 0) +
      (a.san.includes("+") ? 4 : 0);
    const bScore =
      (b.captured ? 10 : 0) +
      (b.promotion ? 8 : 0) +
      (b.san.includes("+") ? 4 : 0);
    return bScore - aScore;
  });
}

function minimax(
  game: Chess,
  depth: number,
  alpha: number,
  beta: number,
  maximizing: boolean,
  aiColor: "w" | "b",
  deadline: number,
) {
  if (depth === 0 || game.isGameOver()) {
    return evaluatePosition(game, aiColor);
  }
  // Hard CPU budget: once the deadline passes, stop searching this subtree
  // and score it statically. The root loop drops incomplete depths, so the
  // AI still answers fast even in the messiest middlegame.
  if (Date.now() >= deadline) {
    return evaluatePosition(game, aiColor);
  }

  const moves = orderedMoves(game);

  if (maximizing) {
    let best = -Infinity;
    for (const move of moves) {
      game.move(move);
      const val = minimax(game, depth - 1, alpha, beta, false, aiColor, deadline);
      game.undo();
      best = Math.max(best, val);
      alpha = Math.max(alpha, val);
      if (beta <= alpha) break;
    }
    return best;
  }

  let best = Infinity;
  for (const move of moves) {
    game.move(move);
    const val = minimax(game, depth - 1, alpha, beta, true, aiColor, deadline);
    game.undo();
    best = Math.min(best, val);
    beta = Math.min(beta, val);
    if (beta <= alpha) break;
  }
  return best;
}

function pickBestMove(game: Chess, aiColor: "w" | "b", aiLevel: number) {
  // The search runs synchronously on the main thread, so both the depth and
  // the time budget are capped hard: the AI answers in well under a second
  // and never pegs the CPU, even in a busy middlegame. Higher levels search
  // deeper and get a slightly bigger budget, just within a cheap band.
  const maxDepth = aiLevel <= 1 ? 1 : aiLevel <= 3 ? 2 : 3;
  const budgetMs = aiLevel <= 1 ? 300 : aiLevel <= 3 ? 450 : 650;
  const deadline = Date.now() + budgetMs;
  const maximizing = game.turn() === aiColor;
  const scored = orderedMoves(game).map((move) => ({ move, score: 0 }));
  let bestMove = scored[0].move;
  let bestScore = maximizing ? -Infinity : Infinity;

  // Iterative deepening: commit only FULLY completed depths, so the chosen
  // move always comes from a search that finished cleanly. Each completed
  // depth reorders the root moves by score (killer-move ordering), which
  // prunes the next depth harder.
  for (let depth = 1; depth <= maxDepth; depth++) {
    let depthBestMove = bestMove;
    let depthBestScore = bestScore;
    let completed = true;
    for (const item of scored) {
      if (Date.now() >= deadline) {
        completed = false;
        break;
      }
      game.move(item.move);
      const score = minimax(
        game,
        depth - 1,
        -Infinity,
        Infinity,
        !maximizing,
        aiColor,
        deadline,
      );
      game.undo();
      if (Date.now() >= deadline) {
        completed = false;
        break;
      }
      item.score = score;
      if (
        (maximizing && score > depthBestScore) ||
        (!maximizing && score < depthBestScore)
      ) {
        depthBestScore = score;
        depthBestMove = item.move;
      }
    }
    if (!completed) break;
    bestMove = depthBestMove;
    bestScore = depthBestScore;
    scored.sort((a, b) =>
      maximizing ? b.score - a.score : a.score - b.score,
    );
  }

  return bestMove;
}

// ── Captured pieces helpers ──

function getCapturedPieces(fen: string) {
  if (!fen) return { white: [], black: [] };
  const boardPart = fen.split(" ")[0];
  const pieceCounts: Record<string, number> = {};
  for (const ch of boardPart) {
    if (/[pnbrqkPNBRQK]/.test(ch)) {
      pieceCounts[ch] = (pieceCounts[ch] || 0) + 1;
    }
  }
  const captured: { white: string[]; black: string[] } = { white: [], black: [] };
  for (const [piece, initialCount] of Object.entries(INITIAL_PIECES)) {
    const currentCount = pieceCounts[piece] || 0;
    const diff = Math.max(0, initialCount - currentCount);
    for (let i = 0; i < diff; i++) {
      if (piece === piece.toUpperCase()) {
        captured.black.push(PIECE_SYMBOLS[piece]);
      } else {
        captured.white.push(PIECE_SYMBOLS[piece]);
      }
    }
  }
  captured.white.sort((a, b) => (PIECE_VALS[SYMBOL_TO_KEY[b]] || 0) - (PIECE_VALS[SYMBOL_TO_KEY[a]] || 0));
  captured.black.sort((a, b) => (PIECE_VALS[SYMBOL_TO_KEY[b]] || 0) - (PIECE_VALS[SYMBOL_TO_KEY[a]] || 0));
  return captured;
}

// ── Move annotation helper ──
const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

function computeAnnotation(fenBefore: string, fenAfter: string, perspectiveColor: "w" | "b"): string {
  try {
    const gameBefore = new Chess(fenBefore);
    const gameAfter = new Chess(fenAfter);
    const evalBefore = evaluatePosition(gameBefore, perspectiveColor);
    const evalAfter = evaluatePosition(gameAfter, perspectiveColor);
    const swing = evalAfter - evalBefore;
    if (swing >= 300) return "!!";
    if (swing >= 100) return "!";
    if (swing <= -300) return "??";
    if (swing <= -100) return "?";
    return "";
  } catch {
    return "";
  }
}

// ── Main component ──

export default function ChessAIPageInner() {
  const [game, setGame] = useState(new Chess());
  const [aiLevel, setAiLevel] = useState(3);
  const [gameOver, setGameOver] = useState(false);
  const [playerColor, setPlayerColor] = useState<"white" | "black">("white");
  const [gameResult, setGameResult] = useState<
    "win" | "lose" | "draw" | "pending"
  >("pending");
  const [winnerText, setWinnerText] = useState("");
  const [turnBanner, setTurnBanner] = useState<string | null>(null);
  const [showResultModal, setShowResultModal] = useState(false);

  // Move history (local tracking)
  const [moves, setMoves] = useState<{ moveSan: string; fenAfter: string; moveUci: string; annotation: string }[]>([]);
  const [moveIndex, setMoveIndex] = useState(-1);
  const promotionHandledRef = useRef(false);
  const aiTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const prevIsPlayerTurnRef = useRef<boolean | null>(null);
  const resultCelebratedRef = useRef(false);
  const [captureFlash, setCaptureFlash] = useState(false);
  const [boardShake, setBoardShake] = useState(false);
  const [clockResetKey, setClockResetKey] = useState(0);
  const [hintMove, setHintMove] = useState<{ from: string; to: string } | null>(null);
  const [tickMuted, setTickMuted] = useState(false);
  const [autoHint, setAutoHint] = useState(false);
  const posthog = usePostHog();

  const router = useRouter();
  const searchParams = useSearchParams();
  // Real username / official Grynd icon / equipped name color for the
  // human seat (client-side game — no server match payload).
  const myIdentity = useMySeatIdentity();
  const gameId = searchParams.get("gameId");
  const difficultyParam = searchParams.get("difficulty");
  const timerParam = searchParams.get("timer");
  const colorParam = searchParams.get("color");

  const endGameCalled = useRef(false);
  const initCompleteRef = useRef(false);
  const prevFenRef = useRef("");

  const aiColor = useMemo<"w" | "b">(
    () => (playerColor === "white" ? "b" : "w"),
    [playerColor],
  );

  // ── Chess clock ──
  const timerMs = (timerParam ? Number(timerParam) : 300) * 1000;
  const playerClockKey = playerColor === "white" ? "player1" : "player2";
  const aiClockKey = playerColor === "white" ? "player2" : "player1";

  const { p1TimeLeft, p2TimeLeft, setActivePlayer } = useChessClock({
    isActive: !gameOver,
    player1Time: timerMs,
    player2Time: timerMs,
    onPlayer1Expire: () => handleTimeout(playerClockKey === "player1"),
    onPlayer2Expire: () => handleTimeout(playerClockKey === "player2"),
    resetKey: clockResetKey,
  });

  const playerClock = playerClockKey === "player1" ? p1TimeLeft : p2TimeLeft;
  const aiClock = aiClockKey === "player1" ? p1TimeLeft : p2TimeLeft;

  // ── Display FEN (respect history navigation) ──
  const displayFen = useMemo(() => {
    if (moveIndex >= 0 && moves[moveIndex]?.fenAfter) {
      return moves[moveIndex].fenAfter;
    }
    return game.fen();
  }, [moveIndex, moves, game]);

  // ── Last move squares ──
  const lastMoveSquares = useMemo(() => {
    if (moves.length === 0) return null;
    const lastMove = moveIndex >= 0 ? moves[moveIndex] : moves[moves.length - 1];
    if (!lastMove?.moveUci || lastMove.moveUci.length < 4) return null;
    return {
      from: lastMove.moveUci.substring(0, 2),
      to: lastMove.moveUci.substring(2, 4),
    };
  }, [moves, moveIndex]);

  // ── Check detection ──
  const isInCheck = useMemo(() => {
    try {
      const chess = new Chess(displayFen);
      return chess.inCheck();
    } catch {
      return false;
    }
  }, [displayFen]);

  const checkSquare = useMemo(() => {
    if (!isInCheck) return null;
    try {
      const chess = new Chess(displayFen);
      const turn = chess.turn();
      const board = chess.board();
      for (let r = 0; r < 8; r++) {
        for (let f = 0; f < 8; f++) {
          const piece = board[r][f];
          if (piece && piece.type === "k" && piece.color === turn) {
            return String.fromCharCode(97 + f) + (8 - r);
          }
        }
      }
    } catch { /* ignore */ }
    return null;
  }, [isInCheck, displayFen]);

  // ── Captured pieces ──
  const capturedPieces = useMemo(() => getCapturedPieces(displayFen), [displayFen]);

  // ── Custom square styles ──
  const customSquareStyles = useMemo(() => {
    const styles: Record<string, Record<string, string>> = {};

    // Hint squares first (lowest priority)
    if (hintMove) {
      styles[hintMove.from] = {
        backgroundColor: "rgba(52, 211, 153, 0.5)",
        border: "2px solid rgba(52, 211, 153, 0.8)",
      };
      styles[hintMove.to] = {
        backgroundColor: "rgba(52, 211, 153, 0.6)",
        border: "2px solid rgba(52, 211, 153, 0.9)",
      };
    }

    if (lastMoveSquares) {
      styles[lastMoveSquares.from] = {
        backgroundColor: "rgba(255, 255, 0, 0.35)",
      };
      styles[lastMoveSquares.to] = {
        backgroundColor: "rgba(255, 255, 0, 0.45)",
      };
    }

    if (checkSquare) {
      styles[checkSquare] = {
        backgroundColor: "rgba(255, 50, 50, 0.7)",
        boxShadow: "inset 0 0 20px 4px rgba(255, 0, 0, 0.5)",
      };
    }

    return styles;
  }, [lastMoveSquares, checkSquare]);

  // ── endGame API call ──
  async function endGame(result?: "win" | "loss" | "draw") {
    if (endGameCalled.current) return;
    endGameCalled.current = true;

    try {
      await fetch("/api/chess/end-game", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          gameId: gameId || undefined,
          result,
        }),
      });
    } catch (e) {
      console.error("Failed to end game:", e);
    }
  }

  // ── beforeunload handler ──
  useEffect(() => {
    const handleLeave = () => {
      if (endGameCalled.current) return;
      const payload = JSON.stringify({
        gameId: gameId || undefined,
        result: "loss",
      });
      navigator.sendBeacon(
        "/api/chess/end-game",
        new Blob([payload], { type: "application/json" }),
      );
      endGameCalled.current = true;
    };

    window.addEventListener("beforeunload", handleLeave);
    return () => {
      handleLeave();
      window.removeEventListener("beforeunload", handleLeave);
    };
  }, [gameId]);

  // ── Initialize ──
  useEffect(() => {
    const level = difficultyParam ? Number(difficultyParam) : 3;
    setAiLevel(Math.min(5, Math.max(1, level)));

    const chosenColor =
      colorParam === "white" || colorParam === "black"
        ? colorParam
        : Math.random() > 0.5
          ? "white"
          : "black";
    const newGame = new Chess();
    setPlayerColor(chosenColor);
    setGame(newGame);
    setGameOver(false);
    setWinnerText("");
    setGameResult("pending");
    setMoves([]);
    setMoveIndex(-1);
    endGameCalled.current = false;
    initCompleteRef.current = false;
    prevFenRef.current = newGame.fen();
    setClockResetKey((k) => k + 1);

    posthog?.capture("chess_ai_game_started", {
      difficulty: level,
      color: chosenColor,
      timer_ms: timerMs,
    });

    if (chosenColor === "black") {
      setTimeout(() => {
        makeAIMMove(newGame);
        initCompleteRef.current = true;
      }, 300);
    } else {
      initCompleteRef.current = true;
    }
  }, []);

  // ── Helpers ──
  function isPlayersTurn(gameInstance: Chess) {
    const playerTurnChar = playerColor === "white" ? "w" : "b";
    return gameInstance.turn() === playerTurnChar;
  }

  function makeAIMMove(gameInstance: Chess) {
    if (!gameInstance || gameInstance.isGameOver()) {
      handleGameOver(gameInstance);
      return;
    }

    const move = pickBestMove(gameInstance, aiColor, aiLevel);
    if (!move) return;

    if (move.captured) {
      setCaptureFlash(true);
      setTimeout(() => setCaptureFlash(false), 400);
    }

    gameInstance.move(move);

    // Record move in history
    const fenBeforeAI = moves.length > 0 ? moves[moves.length - 1].fenAfter : START_FEN;
    const newMove = {
      moveSan: move.san,
      fenAfter: gameInstance.fen(),
      moveUci: `${move.from}${move.to}${move.promotion || ""}`,
      annotation: computeAnnotation(fenBeforeAI, gameInstance.fen(), (gameInstance.turn() === "w" ? "b" : "w") as "w" | "b"),
    };
    setMoves((prev) => [...prev, newMove]);
    setHintMove(null);

    // Detect if this AI move caused check for shake effect
    const prevParts = prevFenRef.current.split(" ");
    const newParts = gameInstance.fen().split(" ");
    if (newParts[1] !== prevParts[1]) {
      setBoardShake(true);
      setTimeout(() => setBoardShake(false), 300);
    }

    prevFenRef.current = gameInstance.fen();
    setGame(new Chess(gameInstance.fen()));

    // Switch clock to player
    setActivePlayer(playerClockKey as "player1" | "player2");

    // Auto-show hint if enabled
    if (autoHint && !gameInstance.isGameOver()) {
      const hintGame = new Chess(gameInstance.fen());
      const playerWb = gameInstance.turn() as "w" | "b";
      const bestMove = pickBestMove(hintGame, playerWb, aiLevel);
      if (bestMove) {
        setHintMove({ from: bestMove.from, to: bestMove.to });
      }
    }

    if (gameInstance.isGameOver()) handleGameOver(gameInstance);
  }

  // ── AI effect ──
  useEffect(() => {
    if (!game || game.isGameOver()) return;
    if (game.turn() !== aiColor) {
      // It's the player's turn — ensure player's clock is ticking
      if (initCompleteRef.current) {
        setActivePlayer(playerClockKey as "player1" | "player2");
      }
      return;
    }
    if (!initCompleteRef.current) return;

    // Switch clock to AI during its turn
    setActivePlayer(aiClockKey as "player1" | "player2");

    const t = setTimeout(() => makeAIMMove(new Chess(game.fen())), 200);
    aiTimeoutRef.current = t;
    return () => clearTimeout(t);
  }, [game, aiColor, aiLevel]);

  // ── Show hint ──
  function showHint() {
    if (gameOver || !isPlayersTurn(game) || moveIndex >= 0) return;
    const gameCopy = new Chess(game.fen());
    const playerWb: "w" | "b" = playerColor === "white" ? "w" : "b";
    const bestMove = pickBestMove(gameCopy, playerWb, aiLevel);
    if (bestMove) {
      setHintMove({ from: bestMove.from, to: bestMove.to });
    }
  }

  // ── Undo move ──
  function undoMove() {
    if (gameOver || moves.length === 0) return;

    // Cancel any pending AI move
    if (aiTimeoutRef.current) {
      clearTimeout(aiTimeoutRef.current);
      aiTimeoutRef.current = null;
    }

    // Clear hint
    setHintMove(null);

    // Reset history navigation to live
    setMoveIndex(-1);

    // If it's the AI's turn, the player just moved and AI hasn't responded — undo 1 move.
    // If it's the player's turn, AI just moved — undo 2 moves (AI + player).
    const isAITurn = game.turn() === aiColor;
    const movesToRemove = isAITurn ? 1 : Math.min(2, moves.length);

    const newMoves = moves.slice(0, moves.length - movesToRemove);
    setMoves(newMoves);

    // Rebuild game state from remaining moves (via UCI for precision)
    const newGame = new Chess();
    for (const m of newMoves) {
      const from = m.moveUci.substring(0, 2);
      const to = m.moveUci.substring(2, 4);
      const promo = m.moveUci.length > 4 ? m.moveUci.substring(4) : undefined;
      newGame.move({ from, to, promotion: promo });
    }
    setGame(newGame);
    prevFenRef.current = newGame.fen();
  }

  // ── onDrop (player move) ──
  function onDrop(sourceSquare: string, targetSquare: string) {
    const alreadyHandled = promotionHandledRef.current;
    promotionHandledRef.current = false;
    if (alreadyHandled) return true;

    if (game.isGameOver() || !isPlayersTurn(game)) return false;
    if (moveIndex >= 0) return false;

    const gameCopy = new Chess(game.fen());
    const move = gameCopy.move({
      from: sourceSquare,
      to: targetSquare,
      promotion: "q",
    });

    if (move === null) return false;

    if (move.captured) {
      setCaptureFlash(true);
      setTimeout(() => setCaptureFlash(false), 400);
    }

    // Record move
    const fenBeforePlayer = moves.length > 0 ? moves[moves.length - 1].fenAfter : START_FEN;
    const newMove = {
      moveSan: move.san,
      fenAfter: gameCopy.fen(),
      moveUci: `${move.from}${move.to}${move.promotion || ""}`,
      annotation: computeAnnotation(fenBeforePlayer, gameCopy.fen(), (gameCopy.turn() === "w" ? "b" : "w") as "w" | "b"),
    };
    setMoves((prev) => [...prev, newMove]);

    prevFenRef.current = gameCopy.fen();
    setGame(new Chess(gameCopy.fen()));
    setActivePlayer(aiClockKey as "player1" | "player2");
    setHintMove(null);
    playCardDraw();

    if (gameCopy.isGameOver()) handleGameOver(gameCopy);
    return true;
  }

  // ── Promotion piece selection ──
  function onPromotionPieceCheck(sourceSquare: string, targetSquare: string, piece: string) {
    if (game.isGameOver() || !isPlayersTurn(game)) return false;
    if (moveIndex >= 0) return false;

    promotionHandledRef.current = true;

    const promo = piece ? piece[1]?.toLowerCase() : "q";
    const gameCopy = new Chess(game.fen());
    const move = gameCopy.move({ from: sourceSquare, to: targetSquare, promotion: promo });
    if (!move) return false;

    if (move.captured) {
      setCaptureFlash(true);
      setTimeout(() => setCaptureFlash(false), 400);
    }

    const fenBeforePromo = moves.length > 0 ? moves[moves.length - 1].fenAfter : START_FEN;
    const newMove = {
      moveSan: move.san,
      fenAfter: gameCopy.fen(),
      moveUci: `${move.from}${move.to}${move.promotion || ""}`,
      annotation: computeAnnotation(fenBeforePromo, gameCopy.fen(), (gameCopy.turn() === "w" ? "b" : "w") as "w" | "b"),
    };
    setMoves((prev) => [...prev, newMove]);

    prevFenRef.current = gameCopy.fen();
    setGame(new Chess(gameCopy.fen()));
    setActivePlayer(aiClockKey as "player1" | "player2");
    setHintMove(null);
    playCardDraw();

    if (gameCopy.isGameOver()) handleGameOver(gameCopy);
    return true;
  }

  // ── Timeout handler ──
  function handleTimeout(playerTimedOut: boolean) {
    if (gameOver) return;
    if (playerTimedOut) {
      setGameOver(true);
      setWinnerText("AI wins! (Time's up)");
      setGameResult("lose");
      posthog?.capture("chess_ai_game_ended", { result: "lose", reason: "timeout" });
      if (!resultCelebratedRef.current) {
        resultCelebratedRef.current = true;
        playDefeat();
      }
      endGame("loss");
      setShowResultModal(true);
    } else {
      // AI timed out (shouldn't happen, but handle gracefully)
      setGameOver(true);
      setWinnerText("You win! (AI timeout)");
      setGameResult("win");
      posthog?.capture("chess_ai_game_ended", { result: "win", reason: "ai_timeout" });
      if (!resultCelebratedRef.current) {
        resultCelebratedRef.current = true;
        playVictory();
      }
      endGame("win");
      setShowResultModal(true);
    }
  }

  // ── Game over ──
  async function handleGameOver(gameInstance: Chess) {
    setGameOver(true);

    if (!gameInstance) {
      setWinnerText("Game Over!");
      setGameResult("draw");
      await endGame("draw");
      posthog?.capture("chess_ai_game_ended", { result: "draw", reason: "unknown" });
      setShowResultModal(true);
      return;
    }

    if (gameInstance.isCheckmate()) {
      const winnerColor = gameInstance.turn() === "w" ? "black" : "white";
      if (winnerColor === playerColor) {
        setWinnerText("You win!");
        setGameResult("win");
        await endGame("win");
        posthog?.capture("chess_ai_game_ended", { result: "win", reason: "checkmate" });
        if (!resultCelebratedRef.current) {
          resultCelebratedRef.current = true;
          playVictory();
        }
      } else {
        setWinnerText("AI wins!");
        setGameResult("lose");
        await endGame("loss");
        posthog?.capture("chess_ai_game_ended", { result: "lose", reason: "checkmate" });
        if (!resultCelebratedRef.current) {
          resultCelebratedRef.current = true;
          playDefeat();
        }
      }
      setShowResultModal(true);
      return;
    }

    if (gameInstance.isDraw()) {
      setWinnerText("Draw!");
      setGameResult("draw");
      await endGame("draw");
      posthog?.capture("chess_ai_game_ended", { result: "draw", reason: "stalemate" });
      setShowResultModal(true);
      return;
    }

    setWinnerText("Game Over!");
    setGameResult("draw");
    await endGame("draw");
    posthog?.capture("chess_ai_game_ended", { result: "draw", reason: "unknown" });
    setShowResultModal(true);
  }

  async function handleResign() {
    setGameOver(true);
    setWinnerText("AI wins! (You resigned)");
    setGameResult("lose");
    posthog?.capture("chess_ai_game_ended", { result: "lose", reason: "resign" });
    await endGame("loss");
    setShowResultModal(true);
  }

  function resetGame() {
    const newGame = new Chess();
    const chosenColor =
      colorParam === "white" || colorParam === "black"
        ? colorParam
        : Math.random() > 0.5
          ? "white"
          : "black";
    setPlayerColor(chosenColor);
    setGame(newGame);
    setGameOver(false);
    setWinnerText("");
    setGameResult("pending");
    setShowResultModal(false);
    setMoves([]);
    setMoveIndex(-1);
    setHintMove(null);
    endGameCalled.current = false;
    resultCelebratedRef.current = false;
    initCompleteRef.current = false;
    prevFenRef.current = newGame.fen();
    setClockResetKey((k) => k + 1);

    posthog?.capture("chess_ai_game_started", {
      difficulty: aiLevel,
      color: chosenColor,
      timer_ms: timerMs,
    });

    if (chosenColor === "black") {
      setTimeout(() => {
        makeAIMMove(newGame);
        initCompleteRef.current = true;
      }, 300);
    } else {
      initCompleteRef.current = true;
    }
  }

  const opponentColor = playerColor === "white" ? "Black" : "White";
  const myDisplayName = myIdentity.name || "You";
  const playerSideLabel = `${myDisplayName} (${playerColor === "white" ? "White" : "Black"})`;
  const aiSideLabel = `AI (${opponentColor})`;
  const isPlayerTurnNow = isPlayersTurn(game);

  // ── Low-time tick sound (under 10 seconds) ──
  const lastTickSecondRef = useRef(-1);
  useEffect(() => {
    if (gameOver || playerClock <= 0 || playerClock > 10000 || !isPlayerTurnNow || moveIndex >= 0) {
      lastTickSecondRef.current = -1;
      return;
    }
    const currentSecond = Math.ceil(playerClock / 1000);
    if (currentSecond !== lastTickSecondRef.current) {
      lastTickSecondRef.current = currentSecond;
      if (!tickMuted) playTick();
    }
  }, [playerClock, gameOver, isPlayerTurnNow, tickMuted]);

  const myCaptured = playerColor === "white" ? capturedPieces.white : capturedPieces.black;
  const oppCaptured = playerColor === "white" ? capturedPieces.black : capturedPieces.white;

  // ── Turn banner animation ──
  useEffect(() => {
    if (prevIsPlayerTurnRef.current !== null && prevIsPlayerTurnRef.current !== isPlayerTurnNow && !gameOver) {
      setTurnBanner(isPlayerTurnNow ? "Your Turn" : "AI's Turn");
      setTimeout(() => setTurnBanner(null), 1800);
    }
    prevIsPlayerTurnRef.current = isPlayerTurnNow;
  }, [isPlayerTurnNow, gameOver]);

  return (
    <div className="min-h-screen bg-[#050816] text-white px-4 py-8 overflow-x-hidden">
      <NavigationBar currentPath="/casino" />

      {/* Only the actual chess game (incl. the game-over popup) is
          recorded — nav stays outside the shared CreatorModeHost
          recording viewport. Recording auto-starts when the battle is
          live and stops once the result popup has been captured. */}
      <CreatorModeHost autoStart={!gameOver} autoStop={gameOver} gameLabel="chess-ai">
      <CreatorResponsiveLayout>

      {/* Turn Banner — chess-turn-banner: hidden in creator mode (see
          globals.css) since the popup covers the board in recorded clips. */}
      <AnimatePresence>
        {turnBanner && (
          <motion.div
            key="turn-banner"
            {...turnBannerAnim}
            className="chess-turn-banner fixed left-1/2 top-1/3 z-50 -translate-x-1/2 -translate-y-1/2 rounded-2xl border-4 border-amber-400 bg-gradient-to-r from-amber-700 to-orange-700 px-10 py-6 shadow-[0_0_60px_rgba(251,191,36,0.5)]"
          >
            <motion.div
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ delay: 0.15, type: "spring", stiffness: 400 }}
              className="text-center text-3xl font-black tracking-widest text-white drop-shadow-lg"
            >
              {turnBanner}
            </motion.div>
            <div className="mt-2 flex justify-center gap-1">
              {[0, 1, 2].map((i) => (
                <motion.div
                  key={i}
                  className="h-2 w-2 rounded-full bg-amber-300"
                  animate={{ scale: [1, 1.8, 1], opacity: [0.5, 1, 0.5] }}
                  transition={{ duration: 0.8, repeat: Infinity, delay: i * 0.2 }}
                />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Check Banner — chess-check-banner: hidden in creator mode (see
          globals.css) — same reason as the turn banner. */}
      <AnimatePresence>
        {isInCheck && !gameOver && (
          <motion.div
            key="check-banner"
            initial={{ opacity: 0, y: -30 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -30 }}
            className="chess-check-banner fixed left-1/2 top-24 z-40 -translate-x-1/2 rounded-xl border-2 border-red-500 bg-red-900/80 px-6 py-2 shadow-[0_0_24px_rgba(255,0,0,0.4)]"
          >
            <span className="inline-flex items-center gap-2 text-lg font-bold text-red-300 tracking-wider"><IconAlertTriangle size={20} /> CHECK!</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Game Over result screen */}
      {showResultModal && (
        <PvpResultScreen
          open
          outcome={gameResult === "win" ? "win" : gameResult === "draw" ? "draw" : "loss"}
          headline={winnerText || undefined}
          subline="Free practice match — no tokens were staked."
          gameName="Chess vs AI"
          opponent={{ name: "AI", iconKey: null, isAi: true }}
          summary={[
            { label: "Your Color", value: playerColor === "white" ? "White" : "Black" },
            { label: "Moves", value: String(moves.length) },
            { label: "Difficulty", value: `Level ${aiLevel}` },
          ]}
          playAgain={{ onClick: resetGame }}
          onReturnToLobby={() => router.push("/casino/chess")}
        />
      )}

      <div className="max-w-7xl mx-auto">
        {/* HEADER */}
        <div className="text-center mb-8">
          <h1 className="text-3xl font-black tracking-widest text-cyan-400 drop-shadow-[0_0_20px_#00ffff]">
            CHESS ARENA
          </h1>
          <p className="text-white/70 mt-3">
            AI Battle • Free to Play
          </p>
        </div>

        {/* MAIN */}
        {/* data-creator-stack: in the portrait (9:16) creator phone frame
            this board + sidebar grid collapses to a single column so the
            board keeps the full frame width. */}
        <div data-creator-stack className="grid lg:grid-cols-[1fr_340px] gap-8 items-start">
          {/* BOARD AREA */}
          <div className="flex justify-center">
            <div className="w-full max-w-[660px]">
              {/* AI (OPPONENT) */}
              <div className="mb-3 rounded-xl border border-cyan-400/30 bg-cyan-500/10 px-4 py-3 flex justify-between items-center backdrop-blur-md">
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center gap-1.5 font-bold text-cyan-300">
                    <IconRobot size={16} className="text-cyan-300" />
                    {aiSideLabel}
                  </span>
                  {oppCaptured.length > 0 && (
                    <span className="text-lg tracking-tight opacity-80">
                      {oppCaptured.join(" ")}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  {!gameOver && game.turn() === aiColor && (
                    <span className="inline-flex items-center gap-1 text-cyan-400 text-sm">
                      <motion.span
                        animate={{ rotate: 360 }}
                        transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
                        className="inline-block"
                      >
                        <IconRobot size={18} />
                      </motion.span>
                      Thinking...
                    </span>
                  )}
                  <span className={`font-mono text-xl ${aiClock <= 10000 ? "text-red-400 low-time-pulse" : "text-cyan-100"}`}>
                    {formatClock(aiClock / 1000)}
                  </span>
                </div>
              </div>

              {/* BOARD — chess-board-wrap: the shake effect is disabled in
                  creator mode (see globals.css); the board itself is kept. */}
              <div className={`chess-board-wrap relative p-[2px] rounded-2xl bg-gradient-to-r from-cyan-400 via-fuchsia-500 to-cyan-400 shadow-[0_0_35px rgba(0,255,255,0.35)] w-full max-w-[90vh] aspect-square mx-auto ${boardShake ? "animate-board-shake" : ""}`}>
                {/* chess-capture-flash: hidden in creator mode (see
                    globals.css) so recorded clips don't flash the board. */}
                <AnimatePresence>
                  {captureFlash && (
                    <motion.div
                      initial={{ opacity: 0.7 }}
                      animate={{ opacity: 0 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.4 }}
                      className="chess-capture-flash absolute inset-0 z-10 rounded-2xl bg-red-500 pointer-events-none"
                    />
                  )}
                </AnimatePresence>
                <div className="rounded-2xl overflow-hidden bg-[#0b1020] w-full h-full">
                  <Chessboard
                    id="AI-CyberBoard"
                    animationDuration={320}
                    arePiecesDraggable={!gameOver && moveIndex === -1}
                    boardOrientation={playerColor}
                    position={displayFen}
                    onPieceDrop={onDrop}
                    onPromotionPieceSelect={onPromotionPieceCheck}
                    promotionDialogVariant="modal"
                    customDarkSquareStyle={{
                      background: "linear-gradient(135deg,#131b3a,#1b2554)",
                    }}
                    customLightSquareStyle={{
                      background: "linear-gradient(135deg,#0ff6,#13d8ff)",
                    }}
                    customSquareStyles={customSquareStyles}
                    customBoardStyle={{
                      width: "100%",
                      height: "100%",
                      display: "block",
                    }}
                  />
                </div>
              </div>

              {/* PLAYER */}
              <div className="mt-3 rounded-xl border border-fuchsia-400/30 bg-fuchsia-500/10 px-4 py-3 flex justify-between items-center backdrop-blur-md">
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center gap-1.5 font-bold text-fuchsia-300">
                    <IconAvatar iconKey={myIdentity.iconKey} name={myDisplayName} size="h-5 w-5" />
                    <span style={myIdentity.nameColor ? { color: myIdentity.nameColor } : undefined}>
                      {playerSideLabel}
                    </span>
                  </span>
                  {myCaptured.length > 0 && (
                    <span className="text-lg tracking-tight opacity-80">
                      {myCaptured.join(" ")}
                    </span>
                  )}
                </div>
                <span className={`font-mono text-xl ${playerClock <= 10000 ? "text-red-400 low-time-pulse" : "text-fuchsia-100"}`}>
                  {formatClock(playerClock / 1000)}
                </span>
              </div>

              {/* STATUS */}
              <div className="mt-4 text-center font-semibold text-cyan-300 tracking-wide">
                {gameOver
                  ? "Game Over"
                  : isPlayerTurnNow
                    ? "Your turn"
                    : "AI is thinking..."}
              </div>
            </div>
          </div>

          {/* SIDEBAR */}
          <div className="rounded-2xl border border-white/10 bg-white/5 p-5 backdrop-blur-xl">
            <h2 className="text-2xl font-bold text-cyan-400 mb-4">
              Move History
            </h2>

            <div className="max-h-[260px] overflow-y-auto space-y-2 pr-1">
              {moves.length === 0 ? (
                <p className="text-white/60">No moves yet.</p>
              ) : (
                moves.map((move, i) => (
                  <button
                    key={i}
                    onClick={() => setMoveIndex(i)}
                    className="w-full text-left px-3 py-2 rounded-lg bg-white/5 hover:bg-cyan-400 hover:text-black transition-all duration-200"
                  >
                    <span className="text-white/40 text-xs mr-2">
                      {Math.floor(i / 2) + 1}{i % 2 === 0 ? "." : "..."}
                    </span>
                    {move.moveSan}
                    {move.annotation && (
                      <span className={`ml-1.5 text-xs font-bold ${
                        move.annotation === "!!" ? "text-emerald-400" :
                        move.annotation === "!" ? "text-green-400" :
                        move.annotation === "?" ? "text-amber-400" :
                        "text-red-400"
                      }`}>
                        {move.annotation}
                      </span>
                    )}
                  </button>
                ))
              )}
            </div>

            {/* Move navigation */}
            {moves.length > 0 && (
              <div className="flex gap-2 mt-3">
                <button
                  onClick={() => setMoveIndex(Math.max(-1, moveIndex - 1))}
                  disabled={moveIndex <= -1}
                  className="flex-1 px-2 py-1 text-xs rounded bg-white/10 hover:bg-white/20 disabled:opacity-30 transition"
                >
                  ◀ Prev
                </button>
                <button
                  onClick={() => setMoveIndex(-1)}
                  className={`flex-1 px-2 py-1 text-xs rounded transition ${moveIndex === -1 ? "bg-cyan-500/30 text-cyan-300" : "bg-white/10 hover:bg-white/20"}`}
                >
                  Live
                </button>
                <button
                  onClick={() => setMoveIndex(Math.min(moves.length - 1, moveIndex + 1))}
                  disabled={moveIndex >= moves.length - 1}
                  className="flex-1 px-2 py-1 text-xs rounded bg-white/10 hover:bg-white/20 disabled:opacity-30 transition"
                >
                  Next ▶
                </button>
              </div>
            )}

            {/* Undo */}
            <button
              onClick={undoMove}
              disabled={gameOver || moves.length === 0 || moveIndex >= 0}
              className="mt-3 w-full bg-yellow-600 hover:bg-yellow-500 py-2 rounded-xl font-bold transition disabled:opacity-40 text-sm"
            >
              ↩ Undo Move
            </button>

            {/* Hint */}
            <button
              onClick={showHint}
              disabled={gameOver || !isPlayerTurnNow || moveIndex >= 0}
              className="mt-2 w-full bg-emerald-600 hover:bg-emerald-500 py-2 rounded-xl font-bold transition disabled:opacity-40 text-sm"
            >
              <span className="inline-flex items-center gap-2"><IconBulb size={16} /> Show Best Move</span>
            </button>

            {/* Sound toggle */}
            <button
              onClick={() => setTickMuted((m) => !m)}
              className="mt-3 w-full text-left px-3 py-2 rounded-lg bg-white/5 hover:bg-white/10 transition text-sm"
            >
              <span className="inline-flex items-center gap-2">{tickMuted ? <><IconVolumeOff size={16} /> Tick sounds muted</> : <><IconVolume size={16} /> Tick sounds on</>}</span>
            </button>

            {/* Auto-hint toggle */}
            <button
              onClick={() => setAutoHint((a) => !a)}
              className="mt-2 w-full text-left px-3 py-2 rounded-lg bg-white/5 hover:bg-white/10 transition text-sm"
            >
              <span className="inline-flex items-center gap-2"><IconBulb size={16} /> Auto-hint: {autoHint ? "ON" : "OFF"}</span>
            </button>

            {/* Difficulty level */}
            <div className="mt-4">
              <label className="text-white/60 text-sm mb-1 block">AI Difficulty:</label>
              <select
                value={aiLevel}
                onChange={(e) => setAiLevel(Number(e.target.value))}
                className="w-full px-3 py-2 rounded-lg border border-cyan-400/30 bg-cyan-500/10 text-white text-sm"
              >
                <option value={1}>Beginner</option>
                <option value={2}>Casual</option>
                <option value={3}>Intermediate</option>
                <option value={4}>Advanced</option>
                <option value={5}>Expert</option>
              </select>
            </div>

            {/* Resign */}
            <button
              onClick={handleResign}
              disabled={gameOver}
              className="mt-3 w-full bg-red-600 hover:bg-red-700 py-3 rounded-xl font-bold transition disabled:opacity-50"
            >
              {gameOver ? "Game Over" : "Resign"}
            </button>

            {/* RETURN */}
            <button
              onClick={() => router.push("/casino/chess")}
              className="mt-4 w-full bg-cyan-400 text-black font-bold py-3 rounded-xl hover:scale-[1.02] transition"
            >
              Return to Lobby
            </button>
          </div>
        </div>
      </div>
      </CreatorResponsiveLayout>
      </CreatorModeHost>
    </div>
  );
}
