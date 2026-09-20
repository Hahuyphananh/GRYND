"use client";

import {
  CSSProperties,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useRouter } from "next/navigation";
import { usePostHog } from "posthog-js/react";
import {
  playFiarDraw,
  playFiarLand,
  playFiarLoss,
  playFiarMatchStart,
  playFiarSelect,
  playFiarWin,
} from "../../../../lib/fourInARowAudio";
import {
  checkWinner,
  cloneBoard,
  createEmptyBoard,
  findWinningLine,
  getDropRow,
  isBoardFull,
  type FourInARowBoard,
} from "../../../../lib/fourInARow";
import NavigationBar from "../../../../components/navigation-bar";
import FrameAvatar from "../../../../components/FrameAvatar";
import useMySeatIdentity from "../../../../hooks/useMySeatIdentity";
// Shared creator-mode presentation layer (admin-only).
import CreatorModeHost from "../../../../components/creator-mode/CreatorModeHost";
import CreatorResultOverlay from "../../../../components/creator-mode/CreatorResultOverlay";
import {
  CreatorView,
  CreatorModeShell,
  CreatorPhoneFrame,
  ShellMain,
} from "../../../../components/creator-mode/CreatorModeLayout";

const HUMAN_PLAYER = 1 as const;
const AI_PLAYER = 2 as const;
const AI_THINK_DELAY_MS = 450;
// The AI chip's activity cue borrows the AI's own piece colour (purple).
const AI_CUE_COLOR = "rgba(192, 132, 252, .7)";
const DROP_DURATION_MS = 360;

// ── Falling-disc motion trail (technique transferred from Tower Arena) ──
// Three ghost copies of the falling disc, each one a frame BEHIND it on the
// very same fall path: identical cell, identical distance, identical easing —
// just started a few tens of milliseconds later. Because the drop is `easeIn`,
// that lag is invisible at the start and only opens into a visible gap once the
// disc is moving fast, so the trail reads as speed rather than a particle
// effect. The delays/opacities are Tower Arena's.
const TRAIL_FRAMES: Array<{ delay: number; opacity: number }> = [
  { delay: 0.03, opacity: 0.48 }, // trail 1 — closest to the disc
  { delay: 0.06, opacity: 0.28 }, // trail 2
  { delay: 0.09, opacity: 0.12 }, // trail 3 — faintest
];
// The disc is spawned this many CELLS above the board's top edge (measured
// from the live board, never a fixed row height). The fall is kept inside
// DROP_DURATION_MS so it still finishes before the move is finalized — the
// game's own pacing/timers are untouched.
const FALL_EXTRA_CELLS = 0.75;
const FALL_MIN_SECONDS = 0.26;
const FALL_MAX_SECONDS = 0.34;

/**
 * Pixel fall distance + duration for a disc landing at (row, col), measured
 * from the LIVE board so the fall works at every board size (desktop, tablet,
 * mobile and the zoomed creator frame) instead of a hard-coded row height.
 * `offsetTop`/`offsetHeight` are CSS px inside the board's own coordinate
 * space — the same space framer-motion animates in — so a zoomed creator frame
 * scales the measured distance and the rendered fall together.
 */
function measureDropDistance(
  board: HTMLElement | null,
  row: number,
  col: number,
) {
  const cell = board?.querySelector<HTMLElement>(`[data-cell="${row}-${col}"]`);
  const firstRow = board?.querySelector<HTMLElement>('[data-cell="0-0"]');
  const cellH = cell?.offsetHeight || 0;
  if (!board || !cell || !firstRow || cellH <= 0) {
    return { distance: 0, seconds: FALL_MIN_SECONDS };
  }
  const pitch = row > 0 ? (cell.offsetTop - firstRow.offsetTop) / row : cellH;
  const distance = row * pitch + FALL_EXTRA_CELLS * cellH;
  const cells = row + FALL_EXTRA_CELLS;
  const seconds = Math.min(
    FALL_MAX_SECONDS,
    Math.max(FALL_MIN_SECONDS, FALL_MIN_SECONDS + cells * 0.03),
  );
  return { distance, seconds };
}

const opponentOf = (player: 1 | 2): 1 | 2 => (player === 1 ? 2 : 1);

function countPieces(board: FourInARowBoard): number {
  let pieces = 0;
  for (const row of board) for (const cell of row) if (cell !== 0) pieces += 1;
  return pieces;
}

/**
 * Creator-mode board stage. A full-width column inside the creator phone
 * frame: the frame lays the game out at a real phone width (390px) and
 * `zoom`s it up to fill the recording frame, so the stage only has to fill
 * that phone width.
 *
 * The `four-in-a-row-creator-stage` class opts the board and the drop
 * controls into the creator sizing in globals.css — the board spans the
 * frame edge-to-edge and the drop buttons become full touch targets —
 * instead of the browser-viewport (svh/vw) sizing the normal page uses.
 */
function CreatorBoardStage({
  className = "",
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={`four-in-a-row-creator-stage ${className}`}>
      {children}
    </div>
  );
}


function Disc({
  value,
  className = "",
  style,
  cell,
}: {
  value: number;
  className?: string;
  style?: CSSProperties;
  /** Grid cell id (`row-col`), used to measure the fall distance from the live board. */
  cell?: string;
}) {
  const color = value === HUMAN_PLAYER ? "four-in-a-row-disc-blue" : value === AI_PLAYER ? "four-in-a-row-disc-purple" : "four-in-a-row-slot";
  return <div aria-hidden data-cell={cell} className={`four-in-a-row-disc ${color} ${className}`} style={style} />;
}

// ── Heuristic AI ─────────────────────────────────────────────────────
function scoreColForAi(
  board: FourInARowBoard,
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
  board: FourInARowBoard,
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

function countFalseThreats(board: FourInARowBoard, player: 1 | 2): number {
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

function pickAiMove(board: FourInARowBoard): number {
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
export default function FourInARowVsAiPage() {
  const router = useRouter();
  const posthog = usePostHog();
  // Real username / official Grynd icon / equipped name color for the
  // human seat (client-side game — no server match payload).
  const myIdentity = useMySeatIdentity();
  const myDisplayName = myIdentity.name || "You";
  const [board, setBoard] = useState<FourInARowBoard>(() => createEmptyBoard());
  const [status, setStatus] = useState<"playing" | "won" | "lost" | "draw">(
    "playing",
  );
  const [aiThinking, setAiThinking] = useState(false);
  const [score, setScore] = useState({ wins: 0, losses: 0, draws: 0 });
  // The disc currently falling into the board, plus everything the drop
  // animation needs: its identity (`key`), the fall distance measured for the
  // CURRENT board size, and the fall duration.
  const [dropAnim, setDropAnim] = useState<{
    col: number;
    row: number;
    value: 1 | 2;
    key: number;
    distance: number;
    seconds: number;
  } | null>(null);
  const boardRef = useRef<HTMLDivElement | null>(null);
  // Decorative motion only — reduced-motion viewers get the disc in place, no
  // fall and no trail (matching the Tower Arena trail's reduced-motion policy).
  const reduceMotion = useReducedMotion();
  // ── Interaction feedback (visual only — never gameplay state) ─────────
  // The hovered playable column drives ONE column rail + ONE landing-cell
  // preview (the human's own disc, faded). Nothing animates its own cell.
  const [hoverCol, setHoverCol] = useState<number | null>(null);
  const moveLockRef = useRef(false);
  const animSeqRef = useRef(0);
  // Incremented on every New Game reset; deferred setTimeout callbacks
  // bail out if the epoch has advanced so a stale move can't overwrite
  // freshly-reset state.
  const gameEpochRef = useRef(0);

  // ── Audio (reinforces the visual action — never gameplay state) ────────
  // Every cue is keyed on the identity of the real event that caused it, so a
  // React re-render, the AI's turn scheduling, or a New Game reset can never
  // replay a sound. All sound goes through lib/fourInARowAudio, which routes to
  // the shared AudioContext and is therefore already silenced by the app's
  // global mute setting and captured by Creator Mode automatically.
  const lastLandSoundRef = useRef<number | null>(null);
  const resultSoundedRef = useRef<string | null>(null);
  // The drop currently in flight, remembered past its own state being cleared
  // so the touchdown can be attributed to the right player.
  const fallingRef = useRef<{ key: number; mine: boolean } | null>(null);

  // Landing cue. A disc reaches the board at exactly the moment the fall state
  // clears — once per move, and under reduced motion too (no fall, so it clears
  // almost immediately). Deduped on the drop's own key so re-renders and the
  // AI's timers can't replay it.
  useEffect(() => {
    if (dropAnim) {
      fallingRef.current = {
        key: dropAnim.key,
        mine: dropAnim.value === HUMAN_PLAYER,
      };
      return;
    }
    const landed = fallingRef.current;
    if (!landed) return;
    fallingRef.current = null; // consumed — this move has had its cue
    if (lastLandSoundRef.current === landed.key) return;
    lastLandSoundRef.current = landed.key;
    playFiarLand(landed.mine);
  }, [dropAnim]);

  // Build a fresh post-move board and trigger a drop animation for one cell.
  const placeDisc = useCallback(
    (
      nextState: FourInARowBoard,
      col: number,
      row: number,
      value: 1 | 2,
    ) => {
      animSeqRef.current += 1;
      setDropAnim({
        col,
        row,
        value,
        key: animSeqRef.current,
        ...measureDropDistance(boardRef.current, row, col),
      });
      setBoard(nextState);
    },
    [],
  );

  const finalizeMoveOutcome = useCallback(
    (
      nextState: FourInARowBoard,
      row: number,
      col: number,
      mover: 1 | 2,
    ) => {
      setDropAnim(null);
      if (checkWinner(nextState, row, col, mover)) {
        const result: "won" | "lost" =
          mover === HUMAN_PLAYER ? "won" : "lost";
        // The win/loss cue is keyed on this move's own sequence number, so it
        // fires once when the result is established and sounds again only on a
        // genuinely new finished game (never on a re-render or a reset).
        const resultKey = `four-in-a-row-${result}-${animSeqRef.current}`;
        if (resultSoundedRef.current !== resultKey) {
          resultSoundedRef.current = resultKey;
          if (result === "won") playFiarWin();
          else playFiarLoss();
        }
        setStatus(result);
        setScore((s) => ({
          ...s,
          wins: result === "won" ? s.wins + 1 : s.wins,
          losses: result === "lost" ? s.losses + 1 : s.losses,
        }));
        posthog?.capture("four_in_a_row_ai_ended", { result });
      } else if (isBoardFull(nextState)) {
        const drawKey = `four-in-a-row-draw-${animSeqRef.current}`;
        if (resultSoundedRef.current !== drawKey) {
          resultSoundedRef.current = drawKey;
          playFiarDraw();
        }
        setStatus("draw");
        setScore((s) => ({ ...s, draws: s.draws + 1 }));
        posthog?.capture("four_in_a_row_ai_ended", { result: "draw" });
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
    (boardState: FourInARowBoard) => {
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

      // The column is committed — the interaction cue fires now, immediately on
      // the valid interaction, before the disc starts falling.
      playFiarSelect();
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
    // Drop the in-flight record first so clearing the board can't be mistaken
    // for a landing, then cue the new match starting.
    fallingRef.current = null;
    playFiarMatchStart();
    setAiThinking(false);
    setBoard(createEmptyBoard());
    setStatus("playing");
    setDropAnim(null);
    posthog?.capture("four_in_a_row_ai_reset");
  }, [posthog]);

  const statusText = useMemo(() => {
    if (status === "won") return "You won!";
    if (status === "lost") return "AI won.";
    if (status === "draw") return "Draw game.";
    if (aiThinking) return "AI is thinking...";
    return "Your move";
  }, [status, aiThinking]);

  const canPlay = status === "playing" && !aiThinking;

  const isPlayableCol = (col: number) => getDropRow(board, col) >= 0;

  // Delegated board hover: one handler covers all 42 cells and only ever sets
  // ONE column, so no cell animates on its own or wholesale.
  const handleBoardPointerOver = (event: MouseEvent<HTMLDivElement>) => {
    if (!canPlay) return;
    const cell = (event.target as Element | null)?.closest?.(
      "[data-cell]",
    ) as HTMLElement | null;
    const col = Number(cell?.dataset.cell?.split("-")[1]);
    if (Number.isInteger(col) && col >= 0 && col < 7 && isPlayableCol(col)) {
      setHoverCol(col);
    }
  };

  // Where the hovered column's disc would land, and whether the hint should
  // show. It yields to the real falling disc the instant a drop starts in that
  // column (the AI page drops immediately, so this is just the fall itself).
  const hintCol = canPlay ? hoverCol : null;
  const hintRow = hintCol !== null ? getDropRow(board, hintCol) : -1;
  const hintVisible =
    hintCol !== null &&
    hintRow >= 0 &&
    !(
      dropAnim &&
      !reduceMotion &&
      dropAnim.distance > 0 &&
      dropAnim.col === hintCol
    );

  // Drop the hover feedback the moment it stops being the player's turn (the
  // AI is thinking, or the game ended) so no column stays lit.
  useEffect(() => {
    if (!canPlay) setHoverCol(null);
  }, [canPlay]);

  // Creator mode signals
  const isGameActive = status === "playing";
  const isGameEnded = status !== "playing";

  // ── Winning-line emphasis (visual only) ───────────────────────────────
  // `checkWinner` still owns win detection — this only reads the finished
  // board for the coordinates, emphasises the four, and holds the result
  // overlay back so the connection is readable before the panel takes over.
  const winnerValue =
    status === "won" ? HUMAN_PLAYER : status === "lost" ? AI_PLAYER : null;
  const winLine = winnerValue ? findWinningLine(board, winnerValue) : null;
  const winLineKey = winLine
    ? winLine.map((cell) => `${cell.row}-${cell.col}`).join("|")
    : null;
  const winCells = new Set(
    winLine?.map((cell) => `${cell.row}-${cell.col}`) ?? [],
  );
  const winOrder = new Map<string, number>();
  winLine?.forEach((cell, index) =>
    winOrder.set(`${cell.row}-${cell.col}`, index),
  );
  // The drop animation has already finished by the time the game ends, so the
  // celebration can start immediately.
  const winVisible = Boolean(winLine) && !dropAnim;
  // Holds the result overlay back for the length of the reveal.
  //
  // The hold is DERIVED, not effect-set, so it is already in effect in the very
  // commit that makes the winning four visible — there is never a frame where
  // the board shows the connection AND the result panel is already up (that
  // used to mount the panel for one commit and flash it). `revealDoneKey`
  // records which line has already had its beat, so re-renders can't restart
  // it, while a genuinely new winning line starts a fresh hold.
  const [revealDoneKey, setRevealDoneKey] = useState<string | null>(null);
  const revealHolding =
    winVisible && winLineKey !== null && revealDoneKey !== winLineKey;
  useEffect(() => {
    if (!revealHolding || !winLineKey) return;
    const timer = window.setTimeout(
      () => setRevealDoneKey(winLineKey),
      reduceMotion ? 600 : 1100,
    );
    return () => window.clearTimeout(timer);
  }, [revealHolding, winLineKey, reduceMotion]);

  // ── Turn / state hierarchy (visual only) ──────────────────────────────
  // One derived state drives every turn cue:
  //   "mine"     your turn — the board is interactive (strongest)
  //   "thinking" the AI is to play / dropping (visibly secondary)
  //   "locked"   your own drop is in flight (clear, brief lock)
  //   "over"     the match is finished — the result state leads
  const turnState: "mine" | "thinking" | "locked" | "over" =
    status !== "playing"
      ? "over"
      : aiThinking
        ? "thinking"
        : dropAnim
          ? "locked"
          : "mine";
  const turnLabel =
    turnState === "mine"
      ? "Your move"
      : turnState === "thinking"
        ? "AI is thinking…"
        : turnState === "locked"
          ? "Dropping…"
          : "";
  // ── AI activity cue (visual only) ─────────────────────────────────────
  // ONE one-shot outline on the AI's chip when the AI takes the turn or its
  // disc starts falling. The key IS the event (the exact drop / the turn's
  // piece count), so it can never replay from a re-render. No new timing and
  // no invented delay — it only surfaces what `aiThinking`/`dropAnim` already
  // do, and it never shows while it is your move.
  const aiCueKey =
    reduceMotion
      ? null
      : dropAnim && dropAnim.value === AI_PLAYER
        ? `drop-${dropAnim.key}`
        : turnState === "thinking"
          ? `think-${countPieces(board)}`
          : null;
  const aiCueNode = aiCueKey ? (
    <span
      key={aiCueKey}
      aria-hidden="true"
      data-testid="fiar-opponent-cue"
      className="four-in-a-row-opponent-cue"
      style={{ "--cue-color": AI_CUE_COLOR } as CSSProperties}
    />
  ) : null;

  const aiTurnLineNode = turnLabel ? (
    <p
      data-testid="fiar-turn-line"
      data-turn-state={turnState}
      className={`four-in-a-row-turn-line four-in-a-row-turn-line--${turnState}`}
    >
      {turnLabel}
    </p>
  ) : null;

  /* Creator Mode bespoke 9:16 portrait: board large, status on top, controls below. */
  const creatorStatus = (
    <>
      <div className="mb-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-3">
            <div
              data-testid="fiar-player-you"
              data-active={turnState === "mine" ? "1" : undefined}
              className={`four-in-a-row-player flex items-center gap-1.5 rounded-md px-1.5 py-0.5 ${
                turnState === "mine"
                  ? "four-in-a-row-player--active"
                  : turnState === "over"
                    ? ""
                    : "four-in-a-row-player--idle"
              }`}
            >
              <span className="h-2.5 w-2.5 rounded-full bg-sky-400" />
              <FrameAvatar frame={myIdentity.profileFrame} iconKey={myIdentity.iconKey} name={myDisplayName} size="h-4 w-4" />
              <span
                className="text-xs text-white/70"
                style={myIdentity.nameColor ? { color: myIdentity.nameColor } : undefined}
              >
                {myDisplayName}
              </span>
            </div>
            <div
              data-testid="fiar-player-ai"
              data-active={turnState === "thinking" ? "1" : undefined}
              className={`four-in-a-row-player relative flex items-center gap-1.5 rounded-md px-1.5 py-0.5 ${
                turnState === "thinking"
                  ? "four-in-a-row-player--active"
                  : turnState === "over"
                    ? ""
                    : "four-in-a-row-player--idle"
              }`}
            >
              {aiCueNode}
              <span className="h-2.5 w-2.5 rounded-full bg-purple-400" />
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
      </div>
    </>
  );

  const creatorBoard = (
    <>
      <div className="bg-[#0b224f]/85 border border-[#00e5ff]/25 rounded-2xl shadow-[0_0_28px_rgba(0,229,255,0.15)] p-3 sm:p-4">
        {aiTurnLineNode}

        {/* Drop buttons */}
        <div
          className={`four-in-a-row-drop-controls mb-3 grid grid-cols-7 gap-2 ${
            turnState === "locked"
              ? "four-in-a-row-drop-controls--locked"
              : ""
          }`}
        >
          {Array.from({ length: 7 }).map((_, col) => (
            <button
              key={`ai-drop-${col}`}
              onClick={() => handleHumanMove(col)}
              onMouseEnter={() => {
                if (canPlay && isPlayableCol(col)) setHoverCol(col);
              }}
              onFocus={() => {
                if (canPlay && isPlayableCol(col)) setHoverCol(col);
              }}
              onBlur={() =>
                setHoverCol((current) => (current === col ? null : current))
              }
              disabled={!canPlay || getDropRow(board, col) < 0}
              className={`four-in-a-row-drop-button${
                hintVisible && hintCol === col
                  ? " four-in-a-row-drop-button--hint"
                  : ""
              }`}
              title={`Drop in column ${col + 1}`}
              aria-label={`Drop in column ${col + 1}`}
            >
              ↓
            </button>
          ))}
        </div>

        {/* Board */}
        <div
          ref={boardRef}
          className="four-in-a-row-board grid grid-cols-7 gap-2 p-3 rounded-2xl border"
          onMouseOver={handleBoardPointerOver}
          onMouseLeave={() => setHoverCol(null)}
        >
          {board.map((row, rowIndex) =>
            row.map((value, colIndex) => {
              // While the disc is in flight its landing cell shows the empty
              // slot, so the disc is only ever seen falling INTO the board.
              // Reduced motion (or an unmeasurable board) shows it in place.
              const isFallingCell =
                Boolean(dropAnim) &&
                !reduceMotion &&
                dropAnim!.distance > 0 &&
                dropAnim!.row === rowIndex &&
                dropAnim!.col === colIndex;
              const cellKey = `${rowIndex}-${colIndex}`;
              const isWinCell = winVisible && winCells.has(cellKey);
              const isDimmed = winVisible && !isWinCell;
              return (
                <Disc
                  key={cellKey}
                  cell={cellKey}
                  value={isFallingCell ? 0 : value}
                  className={
                    isWinCell
                      ? "four-in-a-row-win"
                      : isDimmed
                        ? "four-in-a-row-dim"
                        : ""
                  }
                  style={
                    isWinCell
                      ? ({
                          ["--win-order" as string]: winOrder.get(cellKey) ?? 0,
                        } as CSSProperties)
                      : undefined
                  }
                />
              );
            }),
          )}

          {/* Interaction feedback: ONE column rail + ONE landing-cell preview
              for the hovered column — never all 42 cells. Purely visual; the
              preview wears the human's own disc. */}
          {hintVisible && (
            <div
              aria-hidden
              data-testid="fiar-column-hint"
              className="four-in-a-row-column-hint"
              style={{
                gridColumnStart: hintCol! + 1,
                gridRowStart: 1,
                gridRowEnd: 7,
              }}
            />
          )}
          {hintVisible && (
            <div
              aria-hidden
              data-testid="fiar-column-preview"
              className="pointer-events-none"
              style={{
                gridColumnStart: hintCol! + 1,
                gridRowStart: hintRow + 1,
              }}
            >
              <Disc
                value={HUMAN_PLAYER}
                className="four-in-a-row-preview"
              />
            </div>
          )}

          {dropAnim && !reduceMotion && dropAnim.distance > 0 && (
            // The falling disc + its trail: a grid item pinned to the landing
            // cell (aligned at every board size), with the ghosts and the disc
            // absolutely stacked inside it. Ghosts are drawn BEFORE the disc so
            // the opaque disc paints on top of them, and they live only inside
            // this gate: the move finalizes after DROP_DURATION_MS and the
            // whole layer unmounts, so no ghost is ever left behind.
            <div
              key={dropAnim.key}
              aria-hidden
              className="pointer-events-none relative"
              style={{
                gridColumnStart: dropAnim.col + 1,
                gridRowStart: dropAnim.row + 1,
              }}
            >
              {TRAIL_FRAMES.map((frame, index) => (
                <motion.div
                  key={`trail-${dropAnim.key}-${index}`}
                  data-testid="fiar-trail-ghost"
                  className="absolute inset-0"
                  initial={{ y: -dropAnim.distance, opacity: frame.opacity }}
                  animate={{ y: 0, opacity: 0 }}
                  transition={{
                    // Same distance, same duration, same easing as the disc —
                    // only the start is delayed, which is what makes these
                    // "previous positions" rather than a competing animation.
                    y: {
                      duration: dropAnim.seconds,
                      ease: "easeIn",
                      delay: frame.delay,
                    },
                    opacity: {
                      duration: 0.18,
                      delay: dropAnim.seconds,
                      ease: "easeOut",
                    },
                  }}
                >
                  <Disc value={dropAnim.value} />
                </motion.div>
              ))}
              <motion.div
                data-testid="fiar-drop-disc"
                className="absolute inset-0"
                initial={{ y: -dropAnim.distance, opacity: 1 }}
                animate={{ y: 0, opacity: 1 }}
                transition={{
                  y: { duration: dropAnim.seconds, ease: "easeIn" },
                }}
              >
                <Disc value={dropAnim.value} />
              </motion.div>
            </div>
          )}
        </div>
      </div>
    </>
  );

  const creatorControls = (
    <>
      <div className="space-y-3">
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
            className="px-4 py-2.5 rounded-lg text-sm font-bold bg-white/10 hover:bg-white/20 text-white border border-white/15 transition-colors"
          >
            New Game
          </button>
          <button
            onClick={() => router.push("/casino/four-in-a-row")}
            className="px-4 py-2.5 rounded-lg text-sm font-bold bg-cyan-500/15 hover:bg-cyan-500/30 text-cyan-200 border border-cyan-400/30 transition-colors"
          >
            Back to Lobby
          </button>
        </div>
        <p className="text-center text-[10px] text-white/30">
          AI difficulty: casual · Uses win/block/threat heuristic
        </p>
      </div>
    </>
  );

  // Creator Mode shell: the game renders inside a phone-width viewport
  // (390px) that is `zoom`ed up to fill the recording frame — exactly how
  // <CreatorResponsiveLayout> makes the generic games look like a real
  // phone. Laid out directly at the frame's logical size (1080×1920) the
  // status text read as unreadable and the drop buttons were too small to
  // tap in the live preview; at phone width they are the real mobile sizes,
  // zoomed 2.77× (portrait) / 1.56× (landscape), so the board fills the
  // frame width and the controls are full touch targets. Same shell in every
  // ratio, so the capture always reads as a phone screen.
  const creatorShell = (
    <CreatorModeShell className="bg-gradient-to-br from-[#001933] to-[#000d1a]">
      <ShellMain className="overflow-hidden">
        <CreatorPhoneFrame className="px-3 pb-3 pt-2">
          <div className="shrink-0">{creatorStatus}</div>
          <CreatorBoardStage className="flex min-h-0 w-full flex-1 flex-col items-center justify-start gap-3 overflow-y-auto py-2">
            <div className="w-full shrink-0">{creatorBoard}</div>
          </CreatorBoardStage>
          <div className="shrink-0">{creatorControls}</div>
        </CreatorPhoneFrame>
      </ShellMain>
    </CreatorModeShell>
  );

  const desktopContent = (
    <>
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35 }}
      >
        <h1 className="text-2xl sm:text-3xl font-extrabold text-center mb-1 text-transparent bg-clip-text bg-gradient-to-r from-fuchsia-400 via-purple-400 to-indigo-500 drop-shadow-[0_0_18px_rgba(168,85,247,0.55)] tracking-wide">
          FOUR-IN-A-ROW vs AI
        </h1>
      </motion.div>
      <p className="text-center text-xs text-white/60 mb-3">
        Free play · No wager · You go first as{" "}
        <span className="text-sky-300 font-semibold">Blue</span>, AI plays as{" "}
        <span className="text-purple-300 font-semibold">Purple</span>.
      </p>
      {creatorStatus}
      {creatorBoard}
      {creatorControls}
    </>
  );

  // End-of-match result screen. Mounted inside <CreatorModeHost> (below), NOT
  // in `desktopContent`: <CreatorView> replaces the whole normal view with the
  // creator shell, so a result screen left inside `desktopContent` would never
  // render while recording — the clip ended on the board instead of the
  // WIN/LOSS popup. Recording auto-stops 2s after the game ends, so this is
  // the last thing the capture shows. <CreatorResultOverlay> picks the
  // sizing from the creator-mode flag (compact only while recording).
  // The deciding line itself, drawn with the game's own <Disc> in the winner's
  // real colours — passed through the result panel's supported "here is how it
  // ended" slot, so the winning four stay readable after the board dims behind
  // the backdrop (and at the compact recording size). A draw has no line and
  // passes nothing, so its treatment stays neutral.
  const winStrip = winLine && winnerValue ? (
    <div
      data-testid="fiar-result-win-line"
      className="rounded-xl border border-white/10 bg-black/25 px-3 py-2.5"
    >
      <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-white/45">
        Winning four
      </p>
      <div className="mt-2 flex items-center justify-center gap-1.5">
        {winLine.map((cell) => (
          <span key={`${cell.row}-${cell.col}`} className="block h-6 w-6">
            <Disc value={winnerValue} />
          </span>
        ))}
      </div>
    </div>
  ) : null;

  const resultPanel = (
    <CreatorResultOverlay
      open
      extraContent={winStrip}
      outcome={status === "won" ? "win" : status === "draw" ? "draw" : "loss"}
      headline={
        status === "won"
          ? "Great play. Congratulations!"
          : status === "lost"
            ? "The AI got you this round."
            : "Board is full. It's a draw."
      }
      subline="Free practice match — no tokens were staked."
      gameName="Four-in-a-Row vs AI"
      opponent={{ name: "AI", iconKey: null, isAi: true }}
      summary={[
        { label: "Session", value: `${score.wins}W – ${score.losses}L – ${score.draws}D` },
        { label: "Moves", value: String(countPieces(board)) },
      ]}
      playAgain={{ label: "New Game", onClick: resetGame }}
      onReturnToLobby={() => router.push("/casino/four-in-a-row")}
    />
  );

  // Hand the panel off through <AnimatePresence> so its own exit transition can
  // actually play. The shared panel already declares one, but a panel unmounted
  // by a condition never gets the chance — so on New Game (which resets the
  // status and the board immediately) it now fades out over ~0.28s instead of
  // vanishing, with its props frozen for the duration so nothing flickers to
  // the fresh game's values mid-fade. Still exactly ONE result system — this
  // only wraps the existing panel.
  const resultScreen = (
    <AnimatePresence initial={false}>
      {isGameEnded && !revealHolding && (
        <motion.div
          key="fiar-result"
          data-testid="fiar-result-transition"
          exit={{ opacity: 0 }}
          transition={{ duration: reduceMotion ? 0 : 0.28, ease: "easeOut" }}
        >
          {resultPanel}
        </motion.div>
      )}
    </AnimatePresence>
  );

  return (
    <div className="min-h-screen overflow-x-clip bg-gradient-to-br from-[#001933] to-[#000d1a] px-3 pb-24 pt-20 text-white sm:px-6 md:pb-8">
      <NavigationBar currentPath="/casino" />
      <div className="four-in-a-row-viewport mx-auto mt-2 max-w-3xl sm:mt-3 pb-4">
        <CreatorModeHost
          autoStart={isGameActive}
          autoStop={isGameEnded}
          autoStopDelayMs={2000}
          gameLabel="four-in-a-row-ai"
          backToLobbyHref="/casino/four-in-a-row"
        >
          <CreatorView
            normal={desktopContent}
            portrait={creatorShell}
            landscape={creatorShell}
          />

          {/* Result screen — inside the CreatorModeHost recording frame so the
              WIN/LOSS popup is captured too (exactly like the multiplayer
              four-in-a-row page). With creator mode off the host renders
              children directly, so normal play keeps its full-size overlay. */}
          {resultScreen}
        </CreatorModeHost>
      </div>

      {/* The falling-disc motion is a framer-motion drop + Towers-style trail
          (see measureDropDistance / TRAIL_FRAMES above) — the old single-disc
          CSS keyframe is gone. */}
    </div>
  );
}
