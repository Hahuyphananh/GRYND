"use client";

import { useState, useEffect, useRef, useMemo } from "react";
import { Chess } from "chess.js";
import { useRouter, useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";
import { AnimatePresence, motion } from "framer-motion";
// Page-level session host: records "recently played" and beats
// active-player presence, driven by the game's REAL lifecycle
// (autoStart/autoStop) — never by page load.
import GameSessionHost from "../../../../components/GameSessionHost";

import NavigationBar from "../../../../components/navigation-bar";
import PvpResultScreen from "../../../../components/result/PvpResultScreen";
import FrameAvatar from "../../../../components/FrameAvatar";
import { cosmeticEffectClass } from "../../../../lib/profileCosmetics";
import useMySeatIdentity from "../../../../hooks/useMySeatIdentity";
import { turnBanner as turnBannerAnim } from "../../../../lib/animations";
import { playCardDraw, playVictory, playDefeat, playTick } from "../../../../lib/gameAudio";
import { useChessClock } from "../../../../lib/useChessClock";
import { legalTargetsFrom, isPromotionMove } from "../../../../lib/chessClickMove";
import { resolveInitialPlayerColor } from "../../../../lib/chessAiSeat";
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

// The four pieces a pawn can become, in the order the picker shows them.
const PROMOTION_PIECES: { letter: string; name: string }[] = [
  { letter: "q", name: "Queen" },
  { letter: "r", name: "Rook" },
  { letter: "b", name: "Bishop" },
  { letter: "n", name: "Knight" },
];

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

/**
 * Total pieces in a FEN's placement field.
 *
 * The only thing the client uses it for is deciding whether an AI move that
 * arrived from the SERVER captured a piece — the move itself, its legality and
 * the resulting position all come from the server and are never re-derived here.
 */
function countPiecesInFen(fen: string): number {
  return (String(fen).split(" ")[0].match(/[a-zA-Z]/g) || []).length;
}

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
  const searchParams = useSearchParams();
  // Which side of the board the human plays. The lobby fills `color` with the
  // SERVER's resolved seat for this game (the creation response's `humanColor`),
  // so a concrete value is authoritative. It is resolved ONCE per URL, here, so
  // the board's first paint, the initialize effect below and a restart can never
  // disagree — a second roll could flip sides mid-mount, and a restart must not
  // move a seat the game's own row has already fixed. A URL carrying no resolved
  // colour (a bare practice board, or a page loaded by a pre-change bundle)
  // keeps the historical coin toss, and never assumes the human is White.
  const colorParam = searchParams.get("color");
  const serverColor = useMemo(
    () => resolveInitialPlayerColor(colorParam),
    [colorParam],
  );

  const [game, setGame] = useState(new Chess());
  const [aiLevel, setAiLevel] = useState(3);
  const [gameOver, setGameOver] = useState(false);
  const [playerColor, setPlayerColor] = useState<"white" | "black">(serverColor);
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

  // Click-to-move. Dragging is untouched; this adds the click, click flow on
  // top of it: the first click picks one of our pieces up (its legal
  // destinations light up), the second click on one of those squares plays it.
  const [selectedSquare, setSelectedSquare] = useState<string | null>(null);
  // Set when a picked pawn lands on the far rank — the move waits for a piece.
  const [promotionPrompt, setPromotionPrompt] = useState<{ from: string; to: string } | null>(null);
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
  // Real username / official Grynd icon / equipped name color for the
  // human seat (client-side game — no server match payload).
  const myIdentity = useMySeatIdentity();
  const gameId = searchParams.get("gameId");
  const difficultyParam = searchParams.get("difficulty");
  const timerParam = searchParams.get("timer");

  // ── Server-authoritative VS-AI play ──
  //
  // When this page has a game ROW (`gameId`), the board is a VIEW of that row:
  // the human's move is persisted by POST /api/chess/move and the AI's reply is
  // generated, validated and persisted by POST /api/chess/ai-move. In that mode
  // nothing the client computes is authoritative — the seat comes from the row's
  // player columns, the position from the persisted history, and `pickBestMove`
  // is used for HINTS ONLY (display/prediction), never as a played move.
  //
  // Without a `gameId` this is a bare practice board with no row to persist to;
  // there the local minimax still plays, and the server has no record of it to
  // contradict.
  const serverMode = Boolean(gameId);
  const [aiThinking, setAiThinking] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const aiTurnInFlightRef = useRef(false);
  // The human's write to `/api/chess/move`, while it is in flight. The AI-turn
  // endpoint reads the PERSISTED history, so asking for the reply before that
  // write lands would be refused as "not the AI's turn" — and the snapshot it
  // returns would not contain the move yet. The turn is therefore awaited
  // behind it rather than raced against it.
  const humanMoveInFlightRef = useRef<Promise<void> | null>(null);

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

  // ── Legal destinations of the picked-up piece (click-to-move) ──
  const selectedTargets = useMemo(
    () => legalTargetsFrom(displayFen, selectedSquare),
    [displayFen, selectedSquare],
  );

  // A pick only describes the position it was made on, so drop it whenever the
  // board changes: the AI replied, the player undid a move, or the player jumped
  // into move history.
  useEffect(() => {
    setSelectedSquare(null);
    setPromotionPrompt(null);
  }, [displayFen]);

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

    // ── Click-to-move (drawn last, so a pick always reads on top) ──
    // The picked square is highlighted and every legal destination is dotted;
    // a capture destination gets a ring so the piece it takes stays visible.
    for (const target of selectedTargets) {
      styles[target.to] = target.capture
        ? {
            background:
              "radial-gradient(circle, rgba(0,229,255,0) 58%, rgba(0,229,255,0.85) 60%)",
          }
        : {
            background:
              "radial-gradient(circle, rgba(0,229,255,0.85) 22%, rgba(0,229,255,0) 24%)",
          };
    }

    if (selectedSquare) {
      styles[selectedSquare] = {
        ...(styles[selectedSquare] || {}),
        backgroundColor: "rgba(0,229,255,0.35)",
        boxShadow: "inset 0 0 12px 3px rgba(0,229,255,0.65)",
      };
    }

    return styles;
  }, [hintMove, lastMoveSquares, checkSquare, selectedSquare, selectedTargets]);

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

  // ════════════════════════════════════════════════════════════════════
  // Server-authoritative state (VS-AI games with a row)
  // ════════════════════════════════════════════════════════════════════
  //
  // In server mode the board, the seat and the move list are all views of the
  // persisted row. These four functions are the only places that adopt server
  // state, so a client-side guess can never become the position of record.

  /** Put the server's position (and, when known, its seat) on the board. */
  function applyBoardFromServer(
    fen: string,
    humanColor?: "white" | "black",
  ): Chess {
    const next = new Chess(fen || START_FEN);
    if (humanColor === "white" || humanColor === "black") {
      setPlayerColor(humanColor);
    }
    prevFenRef.current = next.fen();
    setGame(next);
    setHintMove(null);
    setSelectedSquare(null);
    return next;
  }

  /**
   * Rebuild the move list from PERSISTED rows.
   *
   * The list is a display of the server's history: san/uci/fenAfter are the
   * stored values, and the `annotation` glyph is the only thing computed here
   * (it is a locally derived label — it is never stored and never sent back).
   */
  function applyMovesFromServer(
    rows: { moveSan: string; moveUci: string; fenAfter: string }[],
  ) {
    let before = START_FEN;
    const rebuilt = rows.map((row) => {
      const mover = (row.fenAfter.split(" ")[1] === "w" ? "b" : "w") as
        | "w"
        | "b";
      const entry = {
        moveSan: row.moveSan,
        moveUci: row.moveUci,
        fenAfter: row.fenAfter,
        annotation: computeAnnotation(before, row.fenAfter, mover),
      };
      before = row.fenAfter;
      return entry;
    });
    setMoves(rebuilt);
    return rebuilt;
  }

  /**
   * Adopt `GET /api/chess/game-state` for this game — the seat from the game's
   * own player columns (`viewerRole`), the position from its stored moves.
   *
   * Used on load and whenever a write is refused, so the board can never keep a
   * move the server did not accept.
   */
  async function resyncFromServer(): Promise<{
    position: Chess;
    humanColor: "white" | "black";
    aiColor: "white" | "black";
    /** True when the row is no longer open — the game is over or was closed. */
    finished: boolean;
  } | null> {
    if (!serverMode) return null;
    try {
      const res = await fetch(
        `/api/chess/game-state?gameId=${encodeURIComponent(gameId as string)}`,
        { credentials: "include" },
      );
      if (!res.ok) return null;
      const payload = await res.json();
      const state = payload?.data;
      if (!state) return null;

      const seat: "white" | "black" =
        state.viewerRole === "black" ? "black" : "white";
      applyMovesFromServer(state.moves ?? []);
      const position = applyBoardFromServer(state.fen || START_FEN, seat);

      const status = String(state.status ?? "");
      if (status !== "in_progress") {
        setGameOver(true);
        if (position.isGameOver()) {
          await handleGameOver(position, seat);
        } else {
          setWinnerText(status === "finished" ? "Game Over" : "Game ended");
          setGameResult("pending");
          setShowResultModal(true);
        }
      }

      return {
        position,
        humanColor: seat,
        aiColor: seat === "white" ? "black" : "white",
        finished: status !== "in_progress",
      };
    } catch {
      return null;
    }
  }

  /**
   * Persist the human's move through the SAME authoritative route PvP uses.
   *
   * The move is already on the board optimistically; if the server refuses it
   * (a stale turn, a finished game, a session the seat does not belong to) the
   * board is put back on the server's position rather than left disagreeing
   * with the row.
   */
  async function submitHumanMove(from: string, to: string, promotion: string) {
    if (!serverMode) return;
    try {
      const res = await fetch("/api/chess/move", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ gameId, from, to, promotion }),
      });
      if (res.ok) return;
      const loaded = await resyncFromServer();
      // The row is still open, so the board has been rewound to the server's
      // position: the optimistic move — and any result the local board thought
      // it had just produced — does not exist and is cleared here.
      if (loaded && !loaded.finished) {
        setGameOver(false);
        setShowResultModal(false);
        setWinnerText("");
        setGameResult("pending");
        endGameCalled.current = false;
      }
      setServerError(
        res.status === 409
          ? "That move was out of turn — the board has been reloaded."
          : "That move was not accepted — the board has been reloaded.",
      );
    } catch {
      await resyncFromServer();
      setServerError("Connection lost — the board has been reloaded.");
    }
  }

  /**
   * Ask the server for the bot's move.
   *
   * The response is authoritative: its `fen` becomes the board, its `aiMove`
   * becomes the last entry of the history, and a terminal `status` ends the game
   * exactly as a locally played finish would. A refusal carries the server's own
   * snapshot, which is adopted for the same reason; only a failure that left the
   * row open (an engine that could not answer) is offered as a retry.
   */
  async function requestAiTurn() {
    if (!serverMode || aiTurnInFlightRef.current) return;
    if (gameOver) return;

    // Only the server decides whose turn it is; this is just a request filter so
    // the page does not ask on every render.
    const aiChar = playerColor === "white" ? "b" : "w";
    if (game.turn() !== aiChar) return;

    aiTurnInFlightRef.current = true;
    setAiThinking(true);
    setServerError(null);

    try {
      // Let the human's move reach the row first. The endpoint's own assessment
      // is still the authority — this only stops the two requests from
      // crossing, which would otherwise be read as "the human has not moved".
      const pendingHumanMove = humanMoveInFlightRef.current;
      if (pendingHumanMove) await pendingHumanMove;

      const res = await fetch("/api/chess/ai-move", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ gameId }),
      });
      const payload = await res.json().catch(() => null);

      if (!res.ok) {
        if (payload?.state) adoptAiTurnState(payload.state, { appendMove: false });
        setServerError(
          payload?.error || "The AI could not move. Please try again.",
        );
        return;
      }

      const state = payload?.data;
      if (!state || !state.fen) {
        await resyncFromServer();
        setServerError("The AI's move could not be read — please try again.");
        return;
      }
      adoptAiTurnState(state, { appendMove: true });
    } catch {
      await resyncFromServer();
      setServerError("Connection lost — the AI could not move. Please try again.");
    } finally {
      aiTurnInFlightRef.current = false;
      setAiThinking(false);
    }
  }

  /** Adopt the state an `/api/chess/ai-move` answer carried (applied or snapshot). */
  function adoptAiTurnState(
    state: {
      fen: string;
      status?: string;
      isGameOver?: boolean;
      humanColor?: "white" | "black" | null;
      aiColor?: "white" | "black" | null;
      aiMove?: {
        san: string;
        uci: string;
        from: string;
        to: string;
        promotion: string | null;
      } | null;
    },
    options: { appendMove: boolean },
  ) {
    const seat =
      state.humanColor === "white" || state.humanColor === "black"
        ? state.humanColor
        : undefined;
    const aiColorChar: "w" | "b" =
      (state.aiColor === "black" || (!state.aiColor && playerColor === "white")
        ? "b"
        : "w") as "w" | "b";

    if (options.appendMove && state.aiMove) {
      const fenBefore =
        moves.length > 0 ? moves[moves.length - 1].fenAfter : START_FEN;
      // A capture is the one thing the client infers, and only for the flash
      // animation — the move, its legality and the resulting FEN are the
      // server's, byte for byte.
      if (countPiecesInFen(fenBefore) > countPiecesInFen(state.fen)) {
        setCaptureFlash(true);
        setTimeout(() => setCaptureFlash(false), 400);
      }
      const entry = {
        moveSan: state.aiMove.san,
        moveUci: state.aiMove.uci,
        fenAfter: state.fen,
        annotation: computeAnnotation(fenBefore, state.fen, aiColorChar),
      };
      setMoves((prev) => [...prev, entry]);
    }

    const position = applyBoardFromServer(state.fen, seat);
    setHintMove(null);
    setSelectedSquare(null);
    setActivePlayer(
      position.turn() === (playerColor === "white" ? "w" : "b")
        ? (playerClockKey as "player1" | "player2")
        : (aiClockKey as "player1" | "player2"),
    );

    if (state.isGameOver || state.status === "finished") {
      void handleGameOver(position, seat);
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
    setAiLevel(Math.min(5, Math.max(1, level)));  // The colour the SERVER assigned this page's game, resolved once per URL
    // above, so this pass agrees with the first paint and with a restart. In
    // server mode the row itself has the last word — the load below adopts the
    // seat from the persisted game state.
    const chosenColor = serverColor;
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

    if (!serverMode) {
      // Standalone practice board (no row): the local minimax opens for Black,
      // exactly as before. Nothing here is persisted.
      if (chosenColor === "black") {
        setTimeout(() => {
          makeAIMMove(newGame);
          initCompleteRef.current = true;
        }, 300);
      } else {
        initCompleteRef.current = true;
      }
      return;
    }

    // Server-backed game: adopt the PERSISTED position and the seat the row
    // gives us, then ask the server for the bot's move if it is the bot's turn
    // (which it is from move one when the human plays Black).
    let cancelled = false;
    (async () => {
      const loaded = await resyncFromServer();
      if (cancelled) return;
      if (!loaded) setServerError("This game could not be loaded from the server.");
      initCompleteRef.current = true;
      if (loaded && !loaded.position.isGameOver()) {
        const aiChar = loaded.aiColor === "white" ? "w" : "b";
        if (loaded.position.turn() === aiChar) void requestAiTurn();
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // ── Helpers ──
  function isPlayersTurn(gameInstance: Chess) {
    const playerTurnChar = playerColor === "white" ? "w" : "b";
    return gameInstance.turn() === playerTurnChar;
  }

  function makeAIMMove(gameInstance: Chess) {
    if (serverMode) {
      // The SERVER owns the bot's move: it validates it against the persisted
      // position, persists it, and decides whether the game is over. Nothing in
      // this component plays it or claims the turn is complete.
      void requestAiTurn();
      return;
    }

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
    // A server-backed game's history is the row's — rewinding only the board
    // would put the client out of step with the position the bot (and the
    // evaluator) reads. Undo stays available on the standalone practice board.
    if (serverMode) return;
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

    // A dragged pawn reaching the far rank is promoted by the library's own
    // dialog, which re-enters through onPromotionPieceCheck — so the drop path
    // always arrives with the default queen.
    return applyMove(sourceSquare, targetSquare, "q");
  }

  // The single place a player move is played, shared by the drag path (onDrop)
  // and click-to-move, so both record the same SAN/history and the same
  // annotation.
  function applyMove(sourceSquare: string, targetSquare: string, promotion: string) {
    if (game.isGameOver() || !isPlayersTurn(game)) return false;
    if (moveIndex >= 0) return false;

    const gameCopy = new Chess(game.fen());
    // chess.js v1 THROWS on an illegal move rather than returning null, so both
    // the drag path and the click path are guarded here — a bogus drop is an
    // ignored move, not a thrown handler.
    let move = null;
    try {
      move = gameCopy.move({
        from: sourceSquare,
        to: targetSquare,
        promotion,
      });
    } catch {
      return false;
    }

    if (!move) return false;

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

    // In server mode the move must reach the row before the bot may answer:
    // the AI-turn endpoint reads the PERSISTED history, so this POST is what
    // makes the reply possible at all. The local board is optimistic; the server
    // has the last word (see submitHumanMove).
    if (serverMode) {
      const pending = submitHumanMove(sourceSquare, targetSquare, promotion);
      humanMoveInFlightRef.current = pending;
      void pending.finally(() => {
        if (humanMoveInFlightRef.current === pending) {
          humanMoveInFlightRef.current = null;
        }
      });
    }
    return true;
  }

  // ── Click-to-move ──
  //
  // Dragging still works; this is the second, click-based way to move. A click
  // on one of our pieces picks it up (its legal destinations are dotted by
  // customSquareStyles), a click on one of those dots plays the move, and a
  // click anywhere else puts the piece back down. Only the pick is new — the
  // move itself goes through the same applyMove as a drop, so the recorded
  // history, the clock switch and the AI reply are untouched.
  function handleSquareClick(square: string, piece?: string) {
    // A pending promotion owns the board until it is answered.
    if (promotionPrompt) return;
    if (gameOver || moveIndex >= 0) return;

    // Picks are only offered on our own turn: chess.js generates moves for the
    // side to move, so a pick out of turn could not show real targets.
    if (game.isGameOver() || !isPlayersTurn(game)) {
      setSelectedSquare(null);
      return;
    }

    if (selectedSquare === square) {
      setSelectedSquare(null);
      return;
    }

    if (selectedSquare && selectedTargets.some((target) => target.to === square)) {
      const from = selectedSquare;
      setSelectedSquare(null);
      if (isPromotionMove(displayFen, from, square)) {
        setPromotionPrompt({ from, to: square });
        return;
      }
      onDrop(from, square);
      return;
    }

    // Pick a piece of ours; anything else (empty square, the AI's piece off the
    // target list) clears the current pick.
    const myPiece = playerColor === "white" ? "w" : "b";
    setSelectedSquare(piece && piece[0] === myPiece ? square : null);
  }

  // Answer the click-path promotion prompt with the chosen piece ("q"|"r"|"b"|"n").
  function confirmClickPromotion(pieceLetter: string) {
    const prompt = promotionPrompt;
    setPromotionPrompt(null);
    if (!prompt) return;
    applyMove(prompt.from, prompt.to, pieceLetter);
  }

  // ── Promotion piece selection ──
  //
  // react-chessboard v4 calls `onPromotionPieceSelect(piece, from, to)` — the
  // CHOSEN piece FIRST ("wQ"/"bN"), then the two squares (see PromotionOption
  // in react-chessboard/dist). Reading the squares first meant `sourceSquare`
  // received the piece string and `Chess.move()` threw on that bogus square,
  // so clicking a promotion piece did nothing at all.
  function onPromotionPieceCheck(
    piece: string,
    promoteFromSquare?: string,
    promoteToSquare?: string,
  ) {
    // The dialog's backdrop click calls this with no arguments: never a move.
    if (!promoteFromSquare || !promoteToSquare) return false;
    if (game.isGameOver() || !isPlayersTurn(game)) return false;
    if (moveIndex >= 0) return false;

    promotionHandledRef.current = true;

    const promo = piece ? piece[1]?.toLowerCase() : "q";

    // One promotion move, played exactly like every other one: `applyMove` is
    // the single place a HUMAN move is applied and (in server mode) persisted,
    // so this path cannot drift from the drag path — a divergence here would be
    // a move the row never saw.
    return applyMove(promoteFromSquare, promoteToSquare, promo);
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
  //
  // `seatOverride` is the seat the ROW gives the human. It matters when this is
  // called straight after adopting server state, where the `playerColor` state
  // update has not been applied yet and reading it would report the result from
  // the wrong side of the board.
  async function handleGameOver(
    gameInstance: Chess,
    seatOverride?: "white" | "black",
  ) {
    const seat = seatOverride ?? playerColor;
    setGameOver(true);

    // In SERVER mode the row is closed by the server: `/api/chess/move` and
    // `/api/chess/ai-move` persist the result in the same transaction as the move
    // that produced it. Re-posting `end-game` from here would race that write and
    // could expire a game the server is finishing. Resignation still closes its
    // own row — that path does not come through here.
    const settle = serverMode
      ? async () => {}
      : (result?: "win" | "loss" | "draw") => endGame(result);

    if (!gameInstance) {
      setWinnerText("Game Over!");
      setGameResult("draw");
      await settle("draw");
      posthog?.capture("chess_ai_game_ended", { result: "draw", reason: "unknown" });
      setShowResultModal(true);
      return;
    }

    if (gameInstance.isCheckmate()) {
      const winnerColor = gameInstance.turn() === "w" ? "black" : "white";
      if (winnerColor === seat) {
        setWinnerText("You win!");
        setGameResult("win");
        await settle("win");
        posthog?.capture("chess_ai_game_ended", { result: "win", reason: "checkmate" });
        if (!resultCelebratedRef.current) {
          resultCelebratedRef.current = true;
          playVictory();
        }
      } else {
        setWinnerText("AI wins!");
        setGameResult("lose");
        await settle("loss");
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
      await settle("draw");
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
    if (serverMode) {
      // This row is finished and the server owns its history; playing again
      // means a NEW game, which the lobby creates with the tier and colour the
      // player picks. Rewinding the board here could only disagree with the row.
      router.push("/casino/chess");
      return;
    }

    const newGame = new Chess();
    // A restart keeps the seat the SERVER already fixed for this game: it is the
    // same row, so the human must not be moved to the other side by a re-roll.
    const chosenColor = serverColor;
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
          recorded — nav stays outside the shared GameSessionHost
          recording viewport. Recording auto-starts when the battle is
          live and stops once the result popup has been captured. */}
      <GameSessionHost autoStart={!gameOver} autoStop={gameOver} gameLabel="chess-ai">

      {/* Turn Banner — chess-turn-banner. */}
      {/* framer-motion owns `transform` on this banner (it animates `y` and
          `scale`), so Tailwind's `-translate-x-1/2` was overwritten the moment
          the spring settled: the banner was drawn a half-width right of centre
          and was clipped off the right edge below ~350px. `inset-x-0 mx-auto
          w-fit` centres it without a transform, and the cap keeps a long label
          inside the viewport. */}
      <AnimatePresence>
        {turnBanner && (
          <motion.div
            key="turn-banner"
            {...turnBannerAnim}
            className="chess-turn-banner fixed inset-x-0 top-1/3 z-50 mx-auto w-fit max-w-[calc(100vw-1.5rem)] rounded-2xl border-4 border-amber-400 bg-gradient-to-r from-amber-700 to-orange-700 px-6 py-5 shadow-[0_0_60px_rgba(251,191,36,0.5)] sm:px-10 sm:py-6"
          >
            <motion.div
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ delay: 0.15, type: "spring", stiffness: 400 }}
              className="text-center text-2xl font-black tracking-widest text-white drop-shadow-lg sm:text-3xl"
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

      {/* Check Banner — chess-check-banner. Centred the same way: it is a
          `motion.div` animating `y`, so the Tailwind translate would be
          clobbered and the pill would sit off the right of centre. */}
      <AnimatePresence>
        {isInCheck && !gameOver && (
          <motion.div
            key="check-banner"
            initial={{ opacity: 0, y: -30 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -30 }}
            className="chess-check-banner fixed inset-x-0 top-24 z-40 mx-auto w-fit max-w-[calc(100vw-1.5rem)] rounded-xl border-2 border-red-500 bg-red-900/80 px-6 py-2 shadow-[0_0_24px_rgba(255,0,0,0.4)]"
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
          subline="Practice match vs GRYND AI."
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
        <div className="grid lg:grid-cols-[1fr_340px] gap-8 items-start">
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

              {/* BOARD — chess-board-wrap. */}
              <div className={`chess-board-wrap chess-board-frame relative p-[2px] rounded-2xl bg-gradient-to-r from-cyan-400 via-fuchsia-500 to-cyan-400 shadow-[0_0_35px rgba(0,255,255,0.35)] w-full aspect-square mx-auto ${boardShake ? "animate-board-shake" : ""}`}>
                {/* chess-capture-flash. */}
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
                {/* Click-move promotion picker — the drag path uses the
                    library's own dialog, which cannot be opened from a click. */}
                <AnimatePresence>
                  {promotionPrompt && (
                    <motion.div
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.15 }}
                      role="dialog"
                      aria-label="Choose a promotion piece"
                      className="absolute inset-0 z-20 flex items-center justify-center rounded-2xl bg-[#03081f]/85 backdrop-blur-sm"
                    >
                      <div className="flex gap-2 rounded-xl border border-cyan-400/40 bg-[#071531] p-3 shadow-[0_0_25px_rgba(0,229,255,.35)]">
                        {PROMOTION_PIECES.map((option) => (
                          <button
                            key={option.letter}
                            type="button"
                            onClick={() => confirmClickPromotion(option.letter)}
                            aria-label={`Promote to ${option.name}`}
                            className="flex h-12 w-12 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-3xl text-cyan-100 transition-colors hover:border-cyan-300 hover:bg-cyan-400/20"
                          >
                            {
                              PIECE_SYMBOLS[
                                playerColor === "white"
                                  ? option.letter.toUpperCase()
                                  : option.letter
                              ]
                            }
                          </button>
                        ))}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
                <div className="rounded-2xl overflow-hidden bg-[#0b1020] w-full h-full">
                  <Chessboard
                    id="AI-CyberBoard"
                    animationDuration={320}
                    arePiecesDraggable={!gameOver && moveIndex === -1 && !aiThinking}
                    boardOrientation={playerColor}
                    position={displayFen}
                    onPieceDrop={onDrop}
                    onSquareClick={handleSquareClick}
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
                    <FrameAvatar frame={myIdentity.profileFrame} iconKey={myIdentity.iconKey} name={myDisplayName} isGuest={myIdentity.isGuest} size="h-5 w-5" />
                    <span
                      className={cosmeticEffectClass(myIdentity.profileFrame?.usernameEffect?.visual) || undefined}
                      style={myIdentity.nameColor ? { color: myIdentity.nameColor } : undefined}
                    >
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
                  : serverError
                    ? serverError
                    : isPlayerTurnNow
                      ? "Your turn"
                      : aiThinking
                        ? "AI is thinking..."
                        : "AI's turn"}
              </div>

              {/*
                A failed AI turn leaves the row OPEN, so it is recoverable: the
                server still has the move to make. The button is offered only on
                the bot's turn — a move the server refused for the human has
                already been answered by reloading the board.
              */}
              {serverError && !gameOver && !isPlayerTurnNow && (
                <div className="mt-2 flex justify-center">
                  <button
                    type="button"
                    onClick={() => {
                      setServerError(null);
                      void requestAiTurn();
                    }}
                    disabled={aiThinking}
                    className="rounded-lg border border-cyan-300/40 bg-cyan-400/10 px-3 py-1.5 text-sm font-semibold text-cyan-100 transition-colors hover:border-cyan-300 hover:bg-cyan-400/20 disabled:opacity-40"
                  >
                    {aiThinking ? "Retrying…" : "Retry AI move"}
                  </button>
                </div>
              )}
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
              disabled={serverMode || gameOver || moves.length === 0 || moveIndex >= 0}
              title={
                serverMode
                  ? "The server holds this game's move history"
                  : undefined
              }
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
      </GameSessionHost>
    </div>
  );
}
