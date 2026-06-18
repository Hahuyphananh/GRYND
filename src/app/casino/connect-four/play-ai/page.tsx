"use client";

import { CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { useRouter } from "next/navigation";
import { usePostHog } from "posthog-js/react";
import {
  checkWinner,
  cloneBoard,
  createEmptyBoard,
  getDropRow,
  isBoardFull,
  type ConnectFourBoard,
} from "../../../../lib/connectFour";
import NavigationBar from "../../../../components/navigation-bar";
import { celebrateWin } from "../../../../lib/animations";

const HUMAN_PLAYER = 1 as const;
const AI_PLAYER = 2 as const;
const AI_THINK_DELAY_MS = 450;
const DROP_DURATION_MS = 360;

const opponentOf = (player: 1 | 2): 1 | 2 => (player === 1 ? 2 : 1);

function countPieces(board: ConnectFourBoard): number {
  let pieces = 0;
  for (const row of board) for (const cell of row) if (cell !== 0) pieces += 1;
  return pieces;
}

function Disc({
  value,
  className = "",
  style,
}: {
  value: number;
  className?: string;
  style?: CSSProperties;
}) {
  const color =
    value === HUMAN_PLAYER
      ? "bg-green-500"
      : value === AI_PLAYER
        ? "bg-red-500"
        : "bg-slate-900/60";
  return (
    <div
      className={`w-11 h-11 md:w-14 md:h-14 rounded-full border border-black/50 shadow-inner ${color} ${className}`}
      style={style}
    />
  );
}

// ── Heuristic AI ─────────────────────────────────────────────────────
function scoreColForAi(
  board: ConnectFourBoard,
  col: number,
  ai: 1 | 2,
): number {
  const row = getDropRow(board, col);
  if (row < 0) return -1000;

  const opp = opponentOf(ai);
  let score = 0;

  // Prefer the center columns.
  score += (3 - Math.abs(col - 3)) * 3;

  // Project my move.
  const mine = cloneBoard(board);
  mine[row][col] = ai;

  // Count of "open-3" lines I form on my next move.
  score += countProjectedLines(mine, row, col, ai) * 6;

  // Double-threat bonus: dropping here creates ≥2 disjoint winning lines.
  if (countFalseThreats(mine, ai) >= 2) score += 25;

  // Penalize giving opponent a forced follow-up win.
  score -= countFalseThreats(mine, opp) * 8;

  // Project opponent's reply if they were to drop next in this same column.
  const oppRow = getDropRow(mine, col);
  if (oppRow >= 0) {
    const oppView = cloneBoard(mine);
    oppView[oppRow][col] = opp;
    if (checkWinner(oppView, oppRow, col, opp)) score -= 50;
  }

  return score;
}

function countProjectedLines(
  board: ConnectFourBoard,
  row: number,
  col: number,
  player: 1 | 2,
): number {
  const dirs: Array<[number, number]> = [
    [0, 1],
    [1, 0],
    [1, 1],
    [1, -1],
  ];
  let total = 0;
  for (const [dr, dc] of dirs) {
    let mine = 1;
    let open = 0;
    for (const sign of [1, -1]) {
      let r = row + dr * sign;
      let c = col + dc * sign;
      let stepOpen = false;
      while (r >= 0 && r < 6 && c >= 0 && c < 7) {
        if (board[r][c] === player) mine += 1;
        else if (board[r][c] === 0) {
          if (!stepOpen) {
            open += 1;
            stepOpen = true;
          }
          break;
        } else break;
        r += dr * sign;
        c += dc * sign;
      }
    }
    if (mine >= 3 && open >= 1) total += 1;
  }
  return total;
}

function countFalseThreats(board: ConnectFourBoard, player: 1 | 2): number {
  let threatCells = 0;
  for (let r = 0; r < 6; r += 1) {
    for (let c = 0; c < 7; c += 1) {
      if (board[r][c] !== 0) continue;
      const test = cloneBoard(board);
      test[r][c] = player;
      if (checkWinner(test, r, c, player)) threatCells += 1;
    }
  }
  return threatCells;
}

function pickAiMove(board: ConnectFourBoard): number {
  const centerOrder = [3, 2, 4, 1, 5, 0, 6];
  const valid = centerOrder.filter((c) => getDropRow(board, c) >= 0);
  if (valid.length === 0) return -1;

  const opp = opponentOf(AI_PLAYER);

  // 1. Take a winning move immediately.
  for (const c of valid) {
    const r = getDropRow(board, c);
    const test = cloneBoard(board);
    test[r][c] = AI_PLAYER;
    if (checkWinner(test, r, c, AI_PLAYER)) return c;
  }

  // 2. Block opponent's immediate winning move (must-block).
  for (const c of valid) {
    const r = getDropRow(board, c);
    const test = cloneBoard(board);
    test[r][c] = opp;
    if (checkWinner(test, r, c, opp)) return c;
  }

  // 3. Score remaining candidates and pick the highest.
  let bestCol = valid[0];
  let bestScore = -Infinity;
  for (const c of valid) {
    const score = scoreColForAi(board, c, AI_PLAYER);
    if (score > bestScore) {
      bestScore = score;
      bestCol = c;
    }
  }
  return bestCol;
}

// ── Page ──────────────────────────────────────────────────────────────
export default function ConnectFourVsAiPage() {
  const router = useRouter();
  const posthog = usePostHog();
  const [board, setBoard] = useState<ConnectFourBoard>(() => createEmptyBoard());
  const [status, setStatus] = useState<"playing" | "won" | "lost" | "draw">(
    "playing",
  );
  const [aiThinking, setAiThinking] = useState(false);
  const [score, setScore] = useState({ wins: 0, losses: 0, draws: 0 });
  const [dropAnim, setDropAnim] = useState<{
    col: number;
    row: number;
    value: 1 | 2;
    key: number;
  } | null>(null);
  const moveLockRef = useRef(false);
  const animSeqRef = useRef(0);
  // Incremented on every New Game reset; deferred setTimeout callbacks
  // bail out if the epoch has advanced so a stale move can't overwrite
  // freshly-reset state.
  const gameEpochRef = useRef(0);

  // Build a fresh post-move board and trigger a drop animation for one cell.
  const placeDisc = useCallback(
    (
      nextState: ConnectFourBoard,
      col: number,
      row: number,
      value: 1 | 2,
    ) => {
      animSeqRef.current += 1;
      setDropAnim({ col, row, value, key: animSeqRef.current });
      setBoard(nextState);
    },
    [],
  );

  const finalizeMoveOutcome = useCallback(
    (
      nextState: ConnectFourBoard,
      row: number,
      col: number,
      mover: 1 | 2,
    ) => {
      setDropAnim(null);
      if (checkWinner(nextState, row, col, mover)) {
        const result: "won" | "lost" =
          mover === HUMAN_PLAYER ? "won" : "lost";
        setStatus(result);
        setScore((s) => ({
          ...s,
          wins: result === "won" ? s.wins + 1 : s.wins,
          losses: result === "lost" ? s.losses + 1 : s.losses,
        }));
        posthog?.capture("connect_four_ai_ended", { result });
      } else if (isBoardFull(nextState)) {
        setStatus("draw");
        setScore((s) => ({ ...s, draws: s.draws + 1 }));
        posthog?.capture("connect_four_ai_ended", { result: "draw" });
      }
    },
    [posthog],
  );

  // Schedule the AI's next move against the given board snapshot.
  // Called explicitly from handleHumanMove after the human's drop completes,
  // so we never depend on a useEffect re-running to trigger the AI — the previous
  // implementation relied on [board, aiThinking, status] but those deps don't
  // actually change after the human's lock release in normal play, so the AI
  // never got scheduled (it's locked in a frozen board "still your turn" state).
  const scheduleAiTurn = useCallback(
    (boardState: ConnectFourBoard) => {
      if (isBoardFull(boardState)) {
        return;
      }
      // The caller (handleHumanMove) just released the lock; re-acquire it for the AI's turn.
      moveLockRef.current = true;
      setAiThinking(true);

      const epoch = gameEpochRef.current;
      window.setTimeout(() => {
        if (gameEpochRef.current !== epoch) {
          return;
        }
        const col = pickAiMove(boardState);
        const row = col >= 0 ? getDropRow(boardState, col) : -1;
        if (row < 0) {
          setAiThinking(false);
          moveLockRef.current = false;
          return;
        }
        const next = cloneBoard(boardState);
        next[row][col] = AI_PLAYER;
        placeDisc(next, col, row, AI_PLAYER);

        window.setTimeout(() => {
          if (gameEpochRef.current !== epoch) return;
          finalizeMoveOutcome(next, row, col, AI_PLAYER);
          setAiThinking(false);
          moveLockRef.current = false;
        }, DROP_DURATION_MS);
      }, AI_THINK_DELAY_MS);
    },
    [placeDisc, finalizeMoveOutcome],
  );

  const handleHumanMove = useCallback(
    (col: number) => {
      if (status !== "playing" || aiThinking || moveLockRef.current) return;
      if (countPieces(board) % 2 !== 0) return; // not human's turn
      const row = getDropRow(board, col);
      if (row < 0) return;

      moveLockRef.current = true;
      const epoch = gameEpochRef.current;
      const next = cloneBoard(board);
      next[row][col] = HUMAN_PLAYER;
      placeDisc(next, col, row, HUMAN_PLAYER);

      window.setTimeout(() => {
        if (gameEpochRef.current !== epoch) return;
        finalizeMoveOutcome(next, row, col, HUMAN_PLAYER);
        moveLockRef.current = false;
        // Human is done — if the game continues, hand the turn to the AI.
        // Pass the snapshot board (`next`) so the AI move is computed against
        // the post-drop state without relying on a useEffect re-run.
        const humanWon = checkWinner(next, row, col, HUMAN_PLAYER);
        if (!humanWon) {
          scheduleAiTurn(next);
        }
      }, DROP_DURATION_MS);
    },
    [board, aiThinking, status, placeDisc, finalizeMoveOutcome, scheduleAiTurn],
  );

  const resetGame = useCallback(() => {
    gameEpochRef.current += 1;
    moveLockRef.current = false;
    setAiThinking(false);
    setBoard(createEmptyBoard());
    setStatus("playing");
    setDropAnim(null);
    posthog?.capture("connect_four_ai_reset");
  }, [posthog]);

  useEffect(() => {
    if (status === "won") celebrateWin();
  }, [status]);

  const statusText = useMemo(() => {
    if (status === "won") return "You won!";
    if (status === "lost") return "AI won.";
    if (status === "draw") return "Draw game.";
    if (aiThinking) return "AI is thinking...";
    return "Your move";
  }, [status, aiThinking]);

  const canPlay = status === "playing" && !aiThinking;

  return (
    <div className="min-h-screen overflow-x-clip bg-gradient-to-br from-[#001933] to-[#000d1a] px-3 pb-24 pt-20 text-white sm:px-6 md:pb-8">
      <NavigationBar currentPath="/casino" />
      <div className="mx-auto mt-4 max-w-3xl sm:mt-6">
        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35 }}
        >
          <h1 className="text-2xl sm:text-3xl font-extrabold text-center mb-1 text-transparent bg-clip-text bg-gradient-to-r from-fuchsia-400 via-purple-400 to-indigo-500 drop-shadow-[0_0_18px_rgba(168,85,247,0.55)] tracking-wide">
            CONNECT FOUR vs AI
          </h1>
        </motion.div>
        <p className="text-center text-xs text-white/60 mb-5">
          Free play · No wager · You go first as{" "}
          <span className="text-green-300 font-semibold">Green</span>, AI plays as{" "}
          <span className="text-red-300 font-semibold">Red</span>.
        </p>

        <div className="bg-[#0b224f]/85 border border-[#00e5ff]/25 rounded-2xl shadow-[0_0_28px_rgba(0,229,255,0.15)] p-4 sm:p-5">
          {/* Header stats row */}
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full bg-green-400" />
                <span className="text-xs text-white/70">You</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full bg-red-400" />
                <span className="text-xs text-white/70">AI</span>
              </div>
            </div>
            <div className="text-right">
              <p className="text-[10px] uppercase tracking-wider text-white/50">
                Status
              </p>
              <p
                className={`text-sm font-semibold ${
                  status === "won"
                    ? "text-green-300"
                    : status === "lost"
                      ? "text-red-300"
                      : status === "draw"
                        ? "text-amber-300"
                        : aiThinking
                          ? "text-fuchsia-300"
                          : "text-cyan-200"
                }`}
              >
                {statusText}
              </p>
            </div>
          </div>

          {/* Drop buttons */}
          <div className="mb-2 grid grid-cols-7 gap-2">
            {Array.from({ length: 7 }).map((_, col) => (
              <button
                key={`ai-drop-${col}`}
                onClick={() => handleHumanMove(col)}
                disabled={!canPlay || getDropRow(board, col) < 0}
                className="h-8 rounded-lg bg-yellow-400 text-[#0b2f57] font-black hover:bg-yellow-300 disabled:bg-slate-700 disabled:text-slate-400 transition-colors"
                title={`Drop in column ${col + 1}`}
              >
                ↓
              </button>
            ))}
          </div>

          {/* Board */}
          <div className="grid grid-cols-7 gap-2 bg-[#11457e] p-3 rounded-xl border border-[#1e5b9a]">
            {board.map((row, rowIndex) =>
              row.map((value, colIndex) => {
                const isDropping =
                  dropAnim?.row === rowIndex &&
                  dropAnim?.col === colIndex;
                return (
                  <Disc
                    key={`${rowIndex}-${colIndex}`}
                    value={value}
                    className={isDropping ? "c4-ai-fall" : ""}
                    style={
                      isDropping
                        ? ({
                            ["--c4-drop-distance" as string]: `${(rowIndex + 1) * 56}px`,
                          } as CSSProperties)
                        : undefined
                    }
                  />
                );
              }),
            )}
          </div>

          {/* Footer controls */}
          <div className="mt-4 flex flex-wrap items-center gap-3 justify-between">
            <div className="flex items-center gap-3 text-xs">
              <span className="text-white/50 uppercase tracking-wider text-[10px]">
                Score
              </span>
              <span className="text-green-300 font-semibold">
                {score.wins}W
              </span>
              <span className="text-red-300 font-semibold">
                {score.losses}L
              </span>
              <span className="text-amber-300 font-semibold">
                {score.draws}D
              </span>
            </div>
            <div className="flex gap-2">
              <button
                onClick={resetGame}
                className="px-3 py-1.5 rounded-lg text-xs font-bold bg-white/10 hover:bg-white/20 text-white border border-white/15 transition-colors"
              >
                New Game
              </button>
              <button
                onClick={() => router.push("/casino/connect-four")}
                className="px-3 py-1.5 rounded-lg text-xs font-bold bg-cyan-500/15 hover:bg-cyan-500/30 text-cyan-200 border border-cyan-400/30 transition-colors"
              >
                Back to Lobby
              </button>
            </div>
          </div>

          <p className="mt-3 text-center text-[10px] text-white/30">
            AI difficulty: casual · Uses win/block/threat heuristic
          </p>
        </div>

        {/* Status message after game ends */}
        {status !== "playing" && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            className="mt-4 rounded-xl border border-white/10 bg-[#0b224f]/70 p-4 text-center"
          >
            <p className="text-sm font-semibold mb-1">
              {status === "won" && "🏆 Great play — congratulations!"}
              {status === "lost" && "💥 The AI got you this round."}
              {status === "draw" && "🤝 Board is full — it's a draw."}
            </p>
            <p className="text-xs text-white/60">
              Hit <span className="font-semibold text-white">New Game</span> to
              take another match.
            </p>
          </motion.div>
        )}
      </div>

      <style jsx global>{`
        @keyframes c4-ai-fall {
          0% {
            transform: translateY(calc(var(--c4-drop-distance) * -1));
            opacity: 0.6;
          }
          80% {
            opacity: 1;
          }
          100% {
            transform: translateY(0);
            opacity: 1;
          }
        }
        .c4-ai-fall {
          animation: c4-ai-fall 360ms cubic-bezier(0.19, 1, 0.22, 1);
        }
      `}</style>
    </div>
  );
}
