"use client";

import {
  CSSProperties,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
// Page-level session host: records "recently played" and beats
// active-player presence, driven by the game's REAL lifecycle
// (autoStart/autoStop) — never by page load.
import GameSessionHost from "../../../../../components/GameSessionHost";

import { useSocket } from "../../../../../context/SocketProvider";
import EmotePicker, { EmoteBubble } from "../../../../../components/game/EmotePicker";
import useGameEmotes from "../../../../../hooks/useGameEmotes";
import { findWinningLine, getDropRow } from "../../../../../lib/fourInARow";
import {
  playFiarDraw,
  playFiarLand,
  playFiarLoss,
  playFiarMatchStart,
  playFiarSelect,
  playFiarWin,
} from "../../../../../lib/fourInARowAudio";
import useGamePresence from "../../../../../hooks/useGamePresence";
import ReportModal from "../../../../../components/ReportModal";
import MatchWaiting from "../../../../../components/lobby/MatchWaiting";
import PvpResultScreen from "../../../../../components/result/PvpResultScreen";
import FrameAvatar from "../../../../../components/FrameAvatar";
import { turnBanner as turnBannerAnim } from "../../../../../lib/animations";
import {
  IconTarget,
  IconEye,
  IconFlag,
} from "@tabler/icons-react";

const DEFAULT_MOVE_LIMIT_SECONDS = 60;
const REPLAY_WINDOW_SECONDS = 20;

// ── Falling-disc motion trail (technique transferred from Tower Arena) ──
// Three ghost copies of the falling disc, each one a frame BEHIND it on the
// very same fall path: identical cell, identical distance, identical easing —
// just started a few tens of milliseconds later. Because the drop is `easeIn`,
// that lag is invisible at the start and only opens into a visible gap once the
// disc is moving fast, so the trail reads as speed instead of a particle
// effect. The delays/opacities are Tower Arena's, so the motion reads the same.
const TRAIL_FRAMES: Array<{ delay: number; opacity: number }> = [
  { delay: 0.03, opacity: 0.48 }, // trail 1 — closest to the disc
  { delay: 0.06, opacity: 0.28 }, // trail 2
  { delay: 0.09, opacity: 0.12 }, // trail 3 — faintest
];
// The disc is spawned this many CELLS above the board's top edge (measured
// from the live board, never a fixed row height) so it visibly enters the
// column, and the fall length/duration stay honest at every board size.
const FALL_EXTRA_CELLS = 0.75;
const FALL_MIN_SECONDS = 0.3;
const FALL_MAX_SECONDS = 0.8;

// The opponent cue borrows each seat's own border colour (green = host,
// red = guest) so the feedback never introduces a new palette.
const HOST_CUE_COLOR = "rgba(74, 222, 128, .7)";
const GUEST_CUE_COLOR = "rgba(248, 113, 113, .7)";

// Reduced-motion variant of the brief turn cue: a plain fade, no travel.
const TURN_PILL_REDUCED_MOTION = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  transition: { duration: 0.12, ease: "easeOut" as const },
};

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
  const color = value === 1 ? "four-in-a-row-disc-blue" : value === 2 ? "four-in-a-row-disc-purple" : "four-in-a-row-slot";
  return <div aria-hidden data-cell={cell} className={`four-in-a-row-disc ${color} ${className}`} style={style} />;
}

export default function ConnectFourGamePage() {
  const { gameId } = useParams<{ gameId: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const isSpectator = searchParams.get("spectator") === "1";
  const focusTarget = searchParams.get("focusTarget") || "";
  const [spectatorFocus, setSpectatorFocus] = useState<"host" | "guest">(
    (searchParams.get("focus") as any) === "guest" ? "guest" : "host",
  );
  const { socket } = useSocket();

  const [game, setGame] = useState<any>(null);
  // Emotes — both players already join the four-in-a-row room, so reuse it.
  const { incomingEmote, myEmote, sendEmote } = useGameEmotes({
    socket,
    roomId: gameId ? `four-in-a-row:${gameId}` : null,
    eventName: "four-in-a-row:emote",
    selfId: game?.role ?? null,
  });
  const [loadingMove, setLoadingMove] = useState(false);
  const [statusText, setStatusText] = useState("Loading game...");
  // The disc currently falling into the board, plus everything the drop
  // animation needs: its identity (`key`), the fall distance measured for the
  // CURRENT board size, and the fall duration.
  const [fallingDisc, setFallingDisc] = useState<{
    row: number;
    col: number;
    value: number;
    key: string;
    distance: number;
    seconds: number;
  } | null>(null);
  const [sendingReplayDecision, setSendingReplayDecision] = useState(false);
  const [replayMessage, setReplayMessage] = useState("");
  const [spectatorCount, setSpectatorCount] = useState(0);
  const [showReportModal, setShowReportModal] = useState(false);
  const [turnBanner, setTurnBanner] = useState<string | null>(null);
  // Local clock — drives the ready-takeover countdown (server deadlines
  // remain the source of truth; this only renders).
  const [now, setNow] = useState<number>(() => Date.now());
  const prevStatusTextRef = useRef<string | null>(null);
  const turnBannerTimerRef = useRef<number | null>(null);

  useGamePresence({
    gameKey: "four-in-a-row",
    gameId: Number(gameId),
    enabled: !isSpectator && Boolean(gameId),
  });
  const previousBoardRef = useRef<number[][] | null>(null);
  // Board element (for measuring the fall) and the last move that was animated
  // (so polling/socket echoes of the same move can never re-run the drop).
  const boardRef = useRef<HTMLDivElement | null>(null);
  const lastAnimatedMoveRef = useRef<string | null>(null);
  // ── Audio dedup keys (sound only — never gameplay state) ──────────────
  // Each cue is keyed on the REAL event, so a repeated poll, a socket echo,
  // a re-render or a reconnect can never replay it: the landing is keyed on
  // the exact move, the result on the settled match, and the match-start cue
  // on an actual status transition (never the first observation after a load,
  // so reconnecting mid-match stays quiet).
  const lastLandSoundRef = useRef<string | null>(null);
  const resultSoundedRef = useRef<string | null>(null);
  const prevGameStatusRef = useRef<string | null>(null);
  // Decorative motion only — reduced-motion viewers get the disc in place, no
  // fall and no trail (matching the Tower Arena trail's reduced-motion policy).
  const reduceMotion = useReducedMotion();
  // ── Interaction feedback (visual only — never gameplay state) ─────────
  // `hoverCol`   the playable column the pointer/keyboard focus is on.
  // `pendingCol` the column whose move was just sent, while it is in flight.
  // Only ONE column and ONE landing cell are ever marked from these.
  const [hoverCol, setHoverCol] = useState<number | null>(null);
  const [pendingCol, setPendingCol] = useState<number | null>(null);

  const detectLatestDrop = (
    previousBoard: number[][] | null,
    nextBoard: number[][],
  ) => {
    if (!previousBoard || previousBoard.length === 0) return null;

    for (let row = nextBoard.length - 1; row >= 0; row -= 1) {
      for (let col = 0; col < nextBoard[row].length; col += 1) {
        if (previousBoard[row]?.[col] === 0 && nextBoard[row][col] !== 0) {
          return { row, col, value: nextBoard[row][col] };
        }
      }
    }

    return null;
  };

  /**
   * Pixel fall distance + duration for a disc landing at (row, col), measured
   * from the LIVE board so the fall works at every board size (desktop,
   * tablet, mobile) instead of a hard-coded row height. `offsetTop`/
   * `offsetHeight` are CSS px inside the board's own coordinate space — the
   * same space framer-motion animates in — so a scaled board keeps the
   * measured distance and the rendered fall together.
   */
  const measureDrop = (row: number, col: number) => {
    const board = boardRef.current;
    const cell = board?.querySelector<HTMLElement>(`[data-cell="${row}-${col}"]`);
    const firstRow = board?.querySelector<HTMLElement>('[data-cell="0-0"]');
    const cellH = cell?.offsetHeight || 0;
    if (!board || !cell || !firstRow || cellH <= 0) {
      // Board not measurable yet — show the disc in place rather than fall
      // from an invented offset.
      return { distance: 0, seconds: FALL_MIN_SECONDS };
    }
    const pitch = row > 0 ? (cell.offsetTop - firstRow.offsetTop) / row : cellH;
    const distance = row * pitch + FALL_EXTRA_CELLS * cellH;
    const cells = row + FALL_EXTRA_CELLS;
    const seconds = Math.min(
      FALL_MAX_SECONDS,
      Math.max(FALL_MIN_SECONDS, FALL_MIN_SECONDS + cells * 0.05),
    );
    return { distance, seconds };
  };

  const fetchState = async () => {
    const res = await fetch(`/api/four-in-a-row/game-state?gameId=${gameId}`, {
      cache: "no-store",
    });
    const data = await res.json();
    if (!res.ok) {
      setStatusText(data.error || "Unable to load game");
      return;
    }

    const gameData = data.data;
    if (isSpectator && focusTarget) {
      if (String(focusTarget) === String(gameData.hostClerkId))
        setSpectatorFocus("host");
      else if (String(focusTarget) === String(gameData.guestClerkId))
        setSpectatorFocus("guest");
    }
    const nextBoard = gameData?.board || [];
    const latestDrop = detectLatestDrop(previousBoardRef.current, nextBoard);

    setGame(gameData);

    if (latestDrop) {
      // One move = exactly one animation. The key ties this drop to the exact
      // move (game + landing cell + the discs on the board), so a repeated
      // poll or a socket echo of the same state can never replay the fall,
      // while a new player OR AI drop always gets its own.
      const moveKey = `${gameId}-${latestDrop.row}-${latestDrop.col}-${
        latestDrop.value
      }-${Number(gameData.hostDiscsUsed || 0) + Number(gameData.guestDiscsUsed || 0)}`;
      if (lastAnimatedMoveRef.current !== moveKey) {
        lastAnimatedMoveRef.current = moveKey;
        // No sound here: the drop cue belongs at touchdown (the disc reaching
        // the board), not at the moment the state arrives — see the landing
        // effect below, which keys on this same move identity.
        setFallingDisc({
          ...latestDrop,
          key: moveKey,
          ...measureDrop(latestDrop.row, latestDrop.col),
        });
      }
    }

    previousBoardRef.current = nextBoard.map((row: number[]) => [...row]);

    if (gameData.status === "waiting") {
      setStatusText("Waiting for opponent to join...");
      return;
    }

    if (gameData.status === "finished") {
      const wonByMe =
        Boolean(gameData.winnerClerkId) &&
        ((gameData.role === "host" &&
          gameData.winnerClerkId === gameData.hostClerkId) ||
          (gameData.role === "guest" &&
            gameData.winnerClerkId === gameData.guestClerkId));
      // The result cue fires ONCE per settled match. It is keyed on the real
      // outcome, so the 5s poll (and any socket echo) of the same finished
      // state can never replay it — previously the win tone re-fired on every
      // poll for as long as the result screen stayed open.
      const resultKey = `${gameId}-${gameData.result}-${gameData.winnerClerkId || "none"}`;
      if (resultSoundedRef.current !== resultKey) {
        resultSoundedRef.current = resultKey;
        if (gameData.result === "draw") playFiarDraw();
        else if (wonByMe) playFiarWin();
        else playFiarLoss();
      }
      if (gameData.result === "draw") setStatusText("Draw game.");
      else if (wonByMe) setStatusText("You won!"); // Confetti: shared PvpResultScreen.
      else {
        setStatusText(
          gameData.result === "timeout" ? "You lost on time." : "You lost.",
        );
      }
      return;
    }

    const myTurn = gameData.currentTurn === gameData.role;
    setStatusText(myTurn ? "Your move" : "Opponent's move");
  };

  const aiMoveKeyRef = useRef<number | null>(null);
  useEffect(() => {
    if (!game?.isAiGame || game.status !== "in_progress" || game.currentTurn !== "guest") return;
    const key = Number(game.guestDiscsUsed || 0) + Number(game.hostDiscsUsed || 0);
    if (aiMoveKeyRef.current === key) return;
    const timer = window.setTimeout(async () => {
      aiMoveKeyRef.current = key;
      const res = await fetch("/api/four-in-a-row/ai-turn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ gameId: Number(gameId) }),
      });
      if (!res.ok) aiMoveKeyRef.current = null;
      await fetchState();
    }, 700);
    return () => window.clearTimeout(timer);
  }, [game?.isAiGame, game?.status, game?.currentTurn, game?.guestDiscsUsed, game?.hostDiscsUsed, gameId]);

  // Tear the falling disc (and its trail) down once it has landed. Key-guarded
  // so a new drop that replaced one mid-flight is never cleared early, and the
  // timer is cleaned up on unmount so nothing keeps running behind a finished
  // match. Reduced motion skips the fall, so it clears almost immediately.
  useEffect(() => {
    if (!fallingDisc) return;
    const key = fallingDisc.key;
    const isMine = fallingDisc.value === (game?.role === "host" ? 1 : 2);
    const ms = reduceMotion ? 160 : fallingDisc.seconds * 1000 + 140;
    const timer = window.setTimeout(() => {
      // The disc has reached its cell — the true landing moment, once per
      // move. Keyed so a re-armed timer (reduced-motion toggle, a role change)
      // can never sound the same landing twice.
      if (lastLandSoundRef.current !== key) {
        lastLandSoundRef.current = key;
        playFiarLand(isMine);
      }
      setFallingDisc((current) =>
        current && current.key === key ? null : current,
      );
    }, ms);
    return () => window.clearTimeout(timer);
  }, [fallingDisc, reduceMotion, game?.role]);

  // The match actually starting (the matchmaking takeover handing over) — one
  // cue per real waiting/ready → in_progress transition.
  useEffect(() => {
    const status = game?.status ?? null;
    if (
      prevGameStatusRef.current !== null &&
      prevGameStatusRef.current !== status &&
      status === "in_progress"
    ) {
      playFiarMatchStart();
    }
    prevGameStatusRef.current = status;
  }, [game?.status]);

  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    fetchState();
    // Socket room ("match:updated") pushes opponent moves instantly; this
    // HTTP poll is a reconnect/consistency safety net. Turn pacing comes
    // from server deadlines + the clock tick, never from the poll rate.
    // Poll faster while matchmaking so the ready takeover (3s window)
    // renders promptly on both sides, then settle at 5s during play.
    const delay =
      game?.status === "waiting" || game?.status === "ready" ? 1500 : 5000;
    const interval = setInterval(fetchState, delay);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameId, game?.status]);

  useEffect(() => {
    if (!socket) return;
    const roomId = `four-in-a-row:${gameId}`;

    const refresh = () => fetchState();
    socket.emit("join_room", { roomId });
    socket.on("match:updated", refresh);

    return () => {
      socket.emit("leave_room", { roomId });
      socket.off("match:updated", refresh);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, gameId]);

  useEffect(() => {
    if (!game) return;
    const focusId =
      spectatorFocus === "host" ? game.hostClerkId : game.guestClerkId;
    if (!focusId) return;

    const pollSpectators = async () => {
      try {
        const res = await fetch(
          `/api/spectators/count?gameKey=four-in-a-row&gameId=${gameId}`,
          { credentials: "include" },
        );
        const data = await res.json();
        if (res.ok && data.success) setSpectatorCount(Number(data.count || 0));
      } catch {}
    };

    pollSpectators();
    // The spectator-count window is 20s, so a 15s poll keeps the count
    // accurate while cutting reads/writes 3x vs. the old 5s cadence.
    const id = setInterval(pollSpectators, 15000);

    let hb;
    if (isSpectator) {
      const beat = async () => {
        await fetch("/api/spectators/heartbeat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            gameKey: "four-in-a-row",
            gameId: Number(gameId),
            targetClerkId: focusId,
          }),
        });
      };
      beat();
      // Heartbeat only needs to land inside the 20s count window — 15s
      // cadence guarantees that with margin, 3x fewer UPSERTs + cleanup
      // DELETEs than the old 5s beat.
      hb = setInterval(beat, 15000);
    }

    return () => {
      clearInterval(id);
      if (hb) clearInterval(hb);
    };
  }, [game, spectatorFocus, isSpectator, gameId]);

  const canPlay = useMemo(() => {
    if (!game) return false;
    if (isSpectator) return false;
    return game.status === "in_progress" && game.currentTurn === game.role;
  }, [game, isSpectator]);

  // Null-safe column availability for the feedback layer. `getDropRow` indexes
  // `board[row]`, so it must never be called on a missing/empty board — the
  // existing short-circuits in the button handled that implicitly.
  const isPlayableCol = (col: number) =>
    Array.isArray(game?.board) &&
    (game?.board?.length ?? 0) > 0 &&
    getDropRow(game!.board, col) >= 0;

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

  // Drop the hover feedback the moment it stops being the player's turn (the
  // move is away, or the match ended) so no column stays lit.
  useEffect(() => {
    if (!canPlay) setHoverCol(null);
  }, [canPlay]);

  // Brief turn-transition cue. It is a small pill, shown for a moment on a
  // real turn switch only — the previous timer is always cancelled first so
  // rapid turn changes can't stack or strand it.
  useEffect(() => {
    if (!statusText || !game) return;
    const isMyTurn = statusText === "Your move";
    const isOppTurn = statusText === "Opponent's move";
    if (prevStatusTextRef.current !== null && prevStatusTextRef.current !== statusText && (isMyTurn || isOppTurn)) {
      setTurnBanner(isMyTurn ? "Your Turn" : "Opponent's Turn");
      if (turnBannerTimerRef.current) window.clearTimeout(turnBannerTimerRef.current);
      turnBannerTimerRef.current = window.setTimeout(() => setTurnBanner(null), 1200);
    }
    prevStatusTextRef.current = statusText;
  }, [statusText, game]);

  useEffect(
    () => () => {
      if (turnBannerTimerRef.current) window.clearTimeout(turnBannerTimerRef.current);
    },
    [],
  );

  const playerWon = useMemo(() => {
    if (!game || game.status !== "finished") return false;
    if (!game.winnerClerkId) return false;
    return (
      (game.role === "host" && game.winnerClerkId === game.hostClerkId) ||
      (game.role === "guest" && game.winnerClerkId === game.guestClerkId)
    );
  }, [game, isSpectator]);

  const moveLimit = Number(
    game?.moveTimeLimit || game?.timerSeconds || DEFAULT_MOVE_LIMIT_SECONDS,
  );
  const activeTimer =
    game?.status === "in_progress"
      ? Math.min(moveLimit, Math.max(0, Number(game?.moveTimeRemaining || 0)))
      : 0;
  const hostTimer =
    game?.status === "in_progress"
      ? game.currentTurn === "host"
        ? activeTimer
        : moveLimit
      : 0;
  const guestTimer =
    game?.status === "in_progress"
      ? game.currentTurn === "guest"
        ? activeTimer
        : moveLimit
      : 0;

  const replayCountdown = Math.max(
    0,
    Math.min(REPLAY_WINDOW_SECONDS, Number(game?.replayTimeRemaining || 0)),
  );
  // ── Turn / state hierarchy (visual only — never gameplay state) ───────
  // One derived state drives every turn cue, so they can never disagree:
  //   "mine"   it is your turn and the board is interactive (strongest)
  //   "theirs" the opponent is to play (visibly secondary)
  //   "locked" your move is in flight (clear, brief lock)
  //   "over"   the match is not in play, so the result/winning state leads
  // Spectators never own a turn, so their cue follows the real seat on the clock.
  const moveInProgress = loadingMove || pendingCol !== null;
  const inProgress = game?.status === "in_progress";
  const activeSeat: "host" | "guest" | null =
    inProgress && game?.currentTurn ? game.currentTurn : null;
  const isMyTurn = inProgress && !isSpectator && game?.currentTurn === game?.role;
  const turnState: "mine" | "theirs" | "locked" | "over" = !inProgress
    ? "over"
    : moveInProgress
      ? "locked"
      : isMyTurn
        ? "mine"
        : "theirs";
  const activeName =
    activeSeat === "host"
      ? game?.hostName || "Host"
      : activeSeat === "guest"
        ? game?.guestName || "Guest"
        : "";
  const opponentName =
    game?.role === "host"
      ? game?.guestName || "Opponent"
      : game?.hostName || "Opponent";
  const turnLabel =
    turnState === "mine"
      ? "Your move"
      : turnState === "theirs"
        ? isSpectator
          ? `${activeName} to play`
          : `Waiting for ${opponentName}`
        : turnState === "locked"
          ? "Sending your move…"
          : "";
  const c4TurnLineNode = turnLabel ? (
    <p
      data-testid="fiar-turn-line"
      data-turn-state={turnState}
      className={`four-in-a-row-turn-line four-in-a-row-turn-line--${turnState}`}
    >
      {turnLabel}
    </p>
  ) : null;

  // ── Winning-line emphasis (visual only) ───────────────────────────────
  // The winning four get a coordinated highlight while the rest of the board
  // steps back, and only THEN does the existing result overlay take over.
  // Win detection is still the server's / `checkWinner`'s — this just reads
  // the finished board for the coordinates to emphasise.
  const winLine = (() => {
    const board = game?.board;
    if (
      game?.status !== "finished" ||
      game?.result === "draw" ||
      !game?.winnerClerkId ||
      !Array.isArray(board) ||
      board.length === 0
    ) {
      return null;
    }
    const winnerValue = game.winnerClerkId === game.hostClerkId ? 1 : 2;
    return findWinningLine(board, winnerValue);
  })();
  // The winner's disc colour, for the result panel's winning-four strip. Only
  // read when `winLine` exists, so it can never invent a colour for a draw.
  const winnerDiscValue =
    game?.winnerClerkId && game.winnerClerkId === game.hostClerkId ? 1 : 2;
  // A stable identity for the line so a poll that returns the same finished
  // state can never restart the reveal timer.
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
  // Celebrate only once the final disc has landed, so the pop plays on the
  // real piece rather than the empty slot the disc is falling into.
  const winVisible = Boolean(winLine) && !fallingDisc;
  // Holds the result overlay back for the length of the reveal.
  //
  // The hold is DERIVED, not effect-set: it is already in effect in the very
  // commit that makes the winning four visible, so there is never a frame in
  // which the board shows the connection AND the result panel is already up
  // (that used to mount the panel for one commit and flash it). `revealDoneKey`
  // records which line has already had its beat, so a poll/socket echo of the
  // same finished state can never restart it, while a genuinely new winning
  // line starts a fresh hold.
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

  const showResultPopup =
    game?.status === "finished" && !game?.nextGameId && !revealHolding;

  // Wager chip shown on the takeover seats (AI/free games wager nothing).
  const seatWagerLabel =
    game?.isAiGame || Number(game?.betAmount || 0) === 0
      ? "Free play"
      : `${Number(game?.betAmount || 0).toFixed(2)} tokens`;

  // ── Result screen — shared PvpResultScreen (UX plan P3-3) ───────
  // Rendered as a fixed overlay when the match finishes (no pending
  // rematch). Every number comes from the real game row
  // (winnerClerkId / result / payout / betAmount / hostName–guestName)
  // — nothing is invented. Winner/payout logic is untouched; the old
  // win/loss popup + confetti overlay are gone.
  function renderResult() {
    if (!showResultPopup || !game) return null;
    const isDraw = game.result === "draw";
    const outcome = isDraw ? "draw" : playerWon ? "win" : "loss";
    const bet = Number(game.betAmount || 0);
    // Settlement (settleFourInARowGame): the winner is credited
    // `payout` (= bet × 1.9, stake included); a draw refunds both in
    // full; a loss forfeits the stake. AI/free games never move
    // tokens.
    const tokenDelta = game.isAiGame
      ? null
      : isDraw
        ? 0
        : playerWon
          ? Number(game.payout || 0) - bet
          : -bet;

    const oppName =
      game.role === "host"
        ? game.guestName || "Opponent"
        : game.hostName || "Opponent";
    const oppIconKey =
      game.role === "host" ? game.guestIconKey : game.hostIconKey;
    const oppProfileFrame =
      game.role === "host" ? game.guestProfileFrame : game.hostProfileFrame;
    const headline = isDraw
      ? "Draw game — no winner"
      : playerWon
        ? `Four in a row! You beat ${oppName}`
        : `${oppName} connected four first`;
    const subline = game.isAiGame
      ? "Free practice match — no tokens were staked."
      : isDraw
        ? "Board filled with no winner. Both stakes refunded in full."
        : playerWon
          ? `Your ${bet.toFixed(2)} stake back plus ${(Number(game.payout || 0) - bet).toFixed(2)} in winnings.`
          : `You lost your ${bet.toFixed(2)} stake.`;

    // The deciding line itself, drawn with the game's own <Disc> in the
    // winner's real colours — passed through the result panel's supported
    // "here is how it ended" slot (the same one Precision uses for its frozen
    // rockets). It keeps the winning four readable on the panel itself, so the
    // connection still reads after the board dims behind the backdrop, and it
    // is at every panel size because it is sized in cell-relative units. A
    // draw has no line and passes nothing, so its treatment stays neutral.
    const winStrip = winLine ? (
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
              <Disc value={winnerDiscValue} />
            </span>
          ))}
        </div>
      </div>
    ) : null;

    return (
      <PvpResultScreen
        open
        compact
        outcome={outcome}
        extraContent={winStrip}
        headline={headline}
        subline={subline}
        gameName="Four in a Row"
        opponent={{ name: oppName, iconKey: oppIconKey || null, profileFrame: oppProfileFrame || null }}
        tokenDelta={tokenDelta}
        summary={[
          {
            label: "Result",
            value: outcome === "win" ? "Win" : outcome === "loss" ? "Loss" : "Draw",
          },
        ]}
        details={[
          { label: "Game ID", value: String(gameId) },
          ...(game.isAiGame || bet === 0
            ? []
            : [
                { label: "Stake", value: `${bet.toFixed(2)} tokens` },
                ...(playerWon
                  ? [
                      {
                        label: "Prize paid",
                        value: `${Number(game.payout || 0).toFixed(2)} tokens`,
                      },
                    ]
                  : []),
              ]),
          { label: "Winner", value: isDraw ? "Draw" : playerWon ? "You" : oppName },
        ]}
        detailsContent={
          <div className="mt-3 text-center">
            <p className="text-xs font-bold uppercase tracking-widest text-yellow-200">
              Auto-quit in{" "}
              <span className="font-mono font-bold text-yellow-300">
                {replayCountdown}s
              </span>
            </p>
            {replayMessage && (
              <p className="mt-1 text-xs text-cyan-300">{replayMessage}</p>
            )}
          </div>
        }
        playAgain={{ label: "Replay", onClick: () => respondReplay("replay") }}
        onReturnToLobby={() => respondReplay("quit")}
      />
    );
  }

  const playColumn = async (column: number) => {
    if (!canPlay || loadingMove) return;
    if (getDropRow(game.board, column) < 0) return;

    // Immediate: the column has been committed, so the interaction cue fires
    // now (before the request even leaves) and the landing cell shows the
    // pending ring until the falling disc takes over.
    playFiarSelect();
    setPendingCol(column);
    setLoadingMove(true);
    try {
      const res = await fetch("/api/four-in-a-row/play-move", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gameId: Number(gameId), column }),
      });
      const data = await res.json();

      if (!res.ok || !data.success) {
        fetchState();
        return;
      }

      socket?.emit("room_event", {
        roomId: `four-in-a-row:${gameId}`,
        event: "match:updated",
      });
      fetchState();
    } finally {
      setLoadingMove(false);
      setPendingCol((current) => (current === column ? null : current));
    }
  };

  const resignGame = async () => {
    const res = await fetch("/api/four-in-a-row/end-game", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ gameId: Number(gameId) }),
    });

    if (!res.ok) {
      const data = await res.json();
      alert(data.error || "Unable to resign");
      return;
    }

    socket?.emit("room_event", {
      roomId: `four-in-a-row:${gameId}`,
      event: "match:updated",
    });
    fetchState();
  };

  const respondReplay = async (action: "replay" | "quit") => {
    if (!game || sendingReplayDecision) return;

    setSendingReplayDecision(true);
    try {
      const res = await fetch("/api/four-in-a-row/replay-response", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gameId: Number(gameId), action }),
      });
      const data = await res.json();

      if (!res.ok || !data.success) {
        setReplayMessage(data.error || "Unable to send your choice.");
        return;
      }

      if (data.resolved === "replay" && data.gameId) {
        socket?.emit("room_event", {
          roomId: `four-in-a-row:${gameId}`,
          event: "match:updated",
        });
        router.push(`/casino/four-in-a-row/game/${data.gameId}`);
        return;
      }

      if (data.resolved === "quit") {
        setReplayMessage(data.reason || "Replay was not accepted.");
        setTimeout(() => router.push("/casino/four-in-a-row"), 900);
        return;
      }

      setReplayMessage(
        action === "replay"
          ? "Replay requested. Waiting for opponent..."
          : "Quitting match...",
      );
      socket?.emit("room_event", {
        roomId: `four-in-a-row:${gameId}`,
        event: "match:updated",
      });
      fetchState();
    } finally {
      setSendingReplayDecision(false);
    }
  };

  useEffect(() => {
    if (!game || game.status !== "finished") return;

    if (game.nextGameId) {
      router.push(`/casino/four-in-a-row/game/${game.nextGameId}`);
      return;
    }

    if (replayCountdown <= 0) {
      if (
        game.hostReplayDecision === "replay" ||
        game.guestReplayDecision === "replay"
      ) {
        setReplayMessage(
          "Replay was refused or expired. Returning to lobby...",
        );
      }
      const timeoutId = setTimeout(
        () => router.push("/casino/four-in-a-row"),
        900,
      );
      return () => clearTimeout(timeoutId);
    }

    return undefined;
  }, [game, replayCountdown, router]);

  // The drop animation is decorative: with reduced motion, or before the board
  // can be measured, the disc simply appears in its cell (no fall, no trail).
  const showFall =
    Boolean(fallingDisc) && !reduceMotion && fallingDisc!.distance > 0;

  // Hover/selection affordance. The pending column wins while a move is in
  // flight, otherwise the hovered one — and only while it is the player's turn,
  // so an opponent's turn shows nothing. The hint yields to the real falling
  // disc the instant a drop starts in that column.
  const myDiscValue = game?.role === "host" ? 1 : 2;

  // ── Opponent activity cue (visual only) ───────────────────────────────
  // ONE one-shot outline on the other seat's card, fired when it takes the
  // turn or when its disc starts falling. The key IS the event (the exact
  // move / the turn's move count), so a repeated poll or socket echo can
  // never replay it. A spectator has no seat of their own, so the cue follows
  // whoever is really on the clock.
  // It only ever shows while it is NOT your move — the local player's own
  // feedback stays the loudest thing on the board.
  const cueSeat: "host" | "guest" | null = isSpectator
    ? activeSeat
    : game?.role === "host"
      ? "guest"
      : game?.role === "guest"
        ? "host"
        : null;
  const fallingSeat: "host" | "guest" | null = fallingDisc
    ? fallingDisc.value === 1
      ? "host"
      : "guest"
    : null;
  const moveCount =
    Number(game?.hostDiscsUsed || 0) + Number(game?.guestDiscsUsed || 0);
  const opponentCueKey = reduceMotion || !cueSeat
    ? null
    : fallingSeat === cueSeat
      ? `drop-${fallingDisc!.key}`
      : turnState === "theirs"
        ? `turn-${cueSeat}-${moveCount}`
        : null;
  const opponentCueNode = opponentCueKey ? (
    <span
      key={opponentCueKey}
      aria-hidden="true"
      data-testid="fiar-opponent-cue"
      className="four-in-a-row-opponent-cue"
      style={
        { "--cue-color": cueSeat === "host" ? HOST_CUE_COLOR : GUEST_CUE_COLOR } as CSSProperties
      }
    />
  ) : null;
  const hintCol = pendingCol !== null ? pendingCol : canPlay ? hoverCol : null;
  const hintBoard = game?.board;
  const hintRow =
    hintCol !== null && Array.isArray(hintBoard) && hintBoard.length > 0
      ? getDropRow(hintBoard, hintCol)
      : -1;
  const hintVisible =
    hintCol !== null &&
    hintRow >= 0 &&
    !(showFall && fallingDisc!.col === hintCol);

  const c4BoardNode = (
    <div
      ref={boardRef}
      className="four-in-a-row-board grid grid-cols-7"
      onMouseOver={handleBoardPointerOver}
      onMouseLeave={() => setHoverCol(null)}
    >
      {(game?.board || []).map((row: number[], rowIndex: number) =>
        row.map((value, colIndex) => {
          // While the disc is in flight its landing cell shows the empty slot,
          // so the disc is only ever seen falling INTO the board (never
          // already sitting in its cell). When the fall ends the cell renders
          // the real disc at exactly the spot the falling disc landed.
          const isFallingCell =
            showFall &&
            fallingDisc!.row === rowIndex &&
            fallingDisc!.col === colIndex;
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
                {
                  // Explicit placement for EVERY cell. The interaction
                  // feedback (column rail + landing preview) and the
                  // falling-disc layer are grid items too, and the grid places
                  // definite-position items before auto-placed ones — so an
                  // auto-placed coin board would flow around them and the
                  // whole board would shift the moment a column is hovered.
                  gridRowStart: rowIndex + 1,
                  gridColumnStart: colIndex + 1,
                  ...(isWinCell
                    ? {
                        ["--win-order" as string]: winOrder.get(cellKey) ?? 0,
                      }
                    : {}),
                } as CSSProperties
              }
            />
          );
        }),
      )}

      {/* Interaction feedback: ONE column rail + ONE landing-cell preview for
          the hovered/selected column — never all 42 cells, never the whole
          board. Purely visual; the preview wears the player's own disc. */}
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
            value={myDiscValue}
            className={`four-in-a-row-preview${
              pendingCol === hintCol ? " four-in-a-row-preview--pending" : ""
            }`}
          />
        </div>
      )}

      {showFall && (
        // The falling disc + its trail: a grid item pinned to the landing
        // cell (so it stays aligned at every board size), with the ghosts and
        // the disc absolutely stacked inside that one cell. The ghosts are
        // drawn BEFORE the disc so the opaque disc always paints on top of its
        // own ghosts, and they live only inside this gate: when the drop is
        // cleared the whole layer unmounts, so no ghost is ever left behind.
        // Purely visual — no state and no timers of its own.
        <div
          key={fallingDisc!.key}
          aria-hidden
          className="pointer-events-none relative"
          style={{
            gridColumnStart: fallingDisc!.col + 1,
            gridRowStart: fallingDisc!.row + 1,
          }}
        >
          {TRAIL_FRAMES.map((frame, index) => (
            <motion.div
              key={`trail-${fallingDisc!.key}-${index}`}
              data-testid="fiar-trail-ghost"
              className="absolute inset-0"
              initial={{ y: -fallingDisc!.distance, opacity: frame.opacity }}
              animate={{ y: 0, opacity: 0 }}
              transition={{
                // Same distance, same duration, same easing as the disc — only
                // the start is delayed, which is what makes these "previous
                // positions" rather than a second, competing animation.
                y: {
                  duration: fallingDisc!.seconds,
                  ease: "easeIn",
                  delay: frame.delay,
                },
                // Held at the frame's opacity for the whole fall, then faded
                // out the instant the disc lands, so the trail is never visible
                // at rest.
                opacity: {
                  duration: 0.18,
                  delay: fallingDisc!.seconds,
                  ease: "easeOut",
                },
              }}
            >
              <Disc value={fallingDisc!.value} />
            </motion.div>
          ))}
          <motion.div
            data-testid="fiar-drop-disc"
            className="absolute inset-0"
            initial={{ y: -fallingDisc!.distance, opacity: 1 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{
              // Gravity-style accelerated fall for the whole drop height,
              // landing exactly on the cell.
              y: { duration: fallingDisc!.seconds, ease: "easeIn" },
            }}
          >
            <Disc value={fallingDisc!.value} />
          </motion.div>
        </div>
      )}
    </div>
  );
  const c4DropControlsNode = (
    <div
      className={`four-in-a-row-drop-controls grid grid-cols-7 ${
        turnState === "locked" ? "four-in-a-row-drop-controls--locked" : ""
      }`}
    >
      {Array.from({ length: 7 }).map((_, col) => {
        // `!canPlay` short-circuits before `isPlayableCol`, which must never be
        // called on a missing board.
        const playable = !canPlay ? false : isPlayableCol(col);
        const highlighted = hintVisible && hintCol === col;
        const pending = pendingCol === col;
        return (
          <button
            key={`drop-${col}`}
            onClick={() => playColumn(col)}
            onMouseEnter={() => {
              if (canPlay && playable) setHoverCol(col);
            }}
            onFocus={() => {
              if (canPlay && playable) setHoverCol(col);
            }}
            onBlur={() =>
              setHoverCol((current) => (current === col ? null : current))
            }
            disabled={!canPlay || !playable}
            className={`four-in-a-row-drop-button min-h-[44px]${
              highlighted ? " four-in-a-row-drop-button--hint" : ""
            }${pending ? " four-in-a-row-drop-button--pending" : ""}`}
            title={`Drop in column ${col + 1}`}
            aria-label={`Drop in column ${col + 1}`}
          >
            ↓
          </button>
        );
      })}
    </div>
  );
  // Matchmaking takeover, built once so the return can mount it either bare
  // (reduced motion — instant removal, exactly as before) or inside
  // <AnimatePresence>, which lets the takeover's OWN exit fade (MatchWaiting
  // already declares one) actually play: the hand-off from matchmaking to the
  // board becomes a short cross-fade instead of a hard cut. It can never
  // replay because of a poll — the child only leaves when the status
  // genuinely changes.
  const matchWaitingNode =
    game?.status === "waiting" || game?.status === "ready" ? (
      <MatchWaiting
        key="fiar-match-waiting"
        state={game.status === "ready" ? "ready" : "waiting"}
        gameName="Four-In-A-Row"
        subtitle={
          game.status === "ready"
            ? "Match found! Both players are in — starting in a few seconds…"
            : "Waiting for an opponent to join… the game starts the moment they do."
        }
        seats={[
          // Real username + wager on the occupied seat — same avatar +
          // wager treatment as the other casino match views. Once the
          // opponent joins (ready) both seats fill with real names.
          {
            label: "You",
            name:
              game?.role === "host"
                ? game?.hostName || "You"
                : game?.guestName || "You",
            occupied: true,
            wager: seatWagerLabel,
          },
          game.status === "ready"
            ? {
                label: "Opponent",
                name:
                  game?.role === "host"
                    ? game?.guestName || "Opponent"
                    : game?.hostName || "Opponent",
                occupied: true,
                wager: seatWagerLabel,
              }
            : { label: "Opponent", occupied: false },
        ]}
        countdown={
          game.status === "ready"
            ? Math.max(
                0,
                Math.ceil(
                  ((game.readyDeadlineAt
                    ? new Date(game.readyDeadlineAt).getTime()
                    : Date.now()) -
                    now) /
                    1000,
                ),
              )
            : null
        }
        onLeave={
          game.status === "waiting"
            ? () => router.push("/casino/four-in-a-row")
            : null
        }
      />
    ) : null;

  return (
    <>
      {reduceMotion ? (
        matchWaitingNode
      ) : (
        <AnimatePresence>{matchWaitingNode}</AnimatePresence>
      )}

      {/* Brief turn-transition cue — a small pill, not a giant banner, and no
          looping pulse. The centering lives on a motion-free wrapper so the
          pill's own animation never fights a Tailwind transform. */}
      <div className="pointer-events-none fixed left-1/2 top-[20%] z-50 -translate-x-1/2">
        <AnimatePresence>
          {turnBanner && (
            <motion.div
              key={turnBanner}
              {...(reduceMotion ? TURN_PILL_REDUCED_MOTION : turnBannerAnim)}
              data-testid="fiar-turn-pill"
              className="four-in-a-row-turn-pill"
            >
              {turnBanner}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

  {/* Only the actual game content is recorded — the waiting takeover
      above stays outside the shared GameSessionHost recording viewport.
      Recording auto-starts when the game goes in_progress and stops when
      it finishes/cancels or the user quits. */}
  <GameSessionHost
    autoStart={game?.status === "in_progress"}
    autoStop={game?.status === "finished" || game?.status === "cancelled"}
    gameLabel="four-in-a-row"
    // A spectator watching a shared link is on a live match too, so
    // watching must never be counted as playing.
    presenceEnabled={!isSpectator}
  >
  <motion.div
  initial={{ opacity: 0, y: 8 }}
  animate={{ opacity: 1, y: 0 }}
  transition={{ duration: 0.35, ease: "easeOut" }}
  className="text-base"
>
      {/* Report Modal */}
      <ReportModal
        isOpen={showReportModal}
        onClose={() => setShowReportModal(false)}
        onSubmit={async (reason, details) => {
          const opponentId = game?.role === "host" ? game?.guestClerkId : game?.hostClerkId;
          const res = await fetch("/api/reports/submit", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              reportedClerkId: opponentId,
              gameType: "four-in-a-row",
              gameId: String(gameId),
              reason,
              details: details || undefined,
            }),
          });
          const data = await res.json();
          if (!data.success) throw new Error(data.error || "Failed to submit report");
        }}
        reportedPlayerName={
          game?.role === "host"
            ? (game?.guestName || "Opponent")
            : (game?.hostName || "Opponent")
        }
        gameType="Four-In-A-Row"
      />

      <div className="four-in-a-row-viewport max-w-5xl mx-auto relative overflow-visible rounded-2xl pb-4">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="logo-text text-2xl font-black uppercase tracking-[0.08em] text-[#f5ff3b] drop-shadow-[0_0_14px_rgba(245,255,59,0.35)] sm:text-3xl">
              Four-In-A-Row: Match #{gameId}
            </h1>
            {isSpectator && (
              <div className="mt-2 flex items-center gap-2">
                <span className="text-xs rounded bg-cyan-500/20 px-2 py-1">
                  Spectator mode
                </span>
                <button
                  onClick={() => setSpectatorFocus("host")}
                  className="px-2 py-1 text-xs rounded bg-white/10"
                >
                  View Host
                </button>
                <button
                  onClick={() => setSpectatorFocus("guest")}
                  className="px-2 py-1 text-xs rounded bg-white/10"
                >
                  View Guest
                </button>
              </div>
            )}
          </div>
          <button
            onClick={() => router.push("/casino/four-in-a-row")}
            className="rounded-sm border border-cyan-400/30 bg-cyan-500/10 px-4 py-2 text-cyan-200 transition-colors hover:bg-cyan-500/20"
          >
            Back to Lobby
          </button>
        </div>

        <div className="grid lg:grid-cols-[minmax(0,1fr)_320px] gap-4">
          <div className="casino-surface four-in-a-row-panel p-3">
            <div className="flex justify-between items-center mb-4">
              <div>
                <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-white/70 text-sm">
                  <span className="inline-flex items-center gap-1.5">
                    <FrameAvatar frame={game?.hostProfileFrame} iconKey={game?.hostIconKey || null} name={game?.hostName} size="h-4 w-4" />
                    <span style={game?.hostNameColor ? { color: game.hostNameColor } : undefined}>
                      {game?.hostName || "Host"}
                    </span>
                    <span className="text-white/40">(Green)</span>
                  </span>
                  <span className="text-white/40">vs</span>
                  <span className="inline-flex items-center gap-1.5">
                    <FrameAvatar frame={game?.guestProfileFrame} iconKey={game?.guestIconKey || null} name={game?.guestName} size="h-4 w-4" />
                    <span style={game?.guestNameColor ? { color: game.guestNameColor } : undefined}>
                      {game?.guestName || "Guest"}
                    </span>
                    <span className="text-white/40">(Red)</span>
                  </span>
                </p>
                <p className="font-bold text-lg">
                  Bet: {Number(game?.betAmount || 0).toFixed(2)} tokens each
                </p>
                <p className="text-white/70 text-sm">
                  Turn timer: {moveLimit}s
                </p>
              </div>
              <div className="text-right">
                <p className="text-sm text-white/70">Move timer</p>
                <p
                  className={`text-3xl font-mono font-bold ${activeTimer <= 10 ? "text-red-400 low-time-pulse" : "text-green-300"}`}
                >
                  {activeTimer}s
                </p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 mb-4">
              <div
                data-testid="fiar-player-host"
                data-active={activeSeat === "host" ? "1" : undefined}
                className={`four-in-a-row-player relative rounded-lg p-2 border ${
                  activeSeat === "host"
                    ? "four-in-a-row-player--active border-green-400 bg-green-500/10"
                    : inProgress
                      ? "four-in-a-row-player--idle border-white/15 bg-white/5"
                      : "border-white/15 bg-white/5"
                }`}
              >
                {cueSeat === "host" && opponentCueNode}
                <p className="relative flex items-center gap-1.5 text-sm text-white/70">
                  <FrameAvatar frame={game?.hostProfileFrame} iconKey={game?.hostIconKey || null} name={game?.hostName} size="h-4 w-4" />
                  <span style={game?.hostNameColor ? { color: game.hostNameColor } : undefined}>
                    {game?.hostName || "Host"}
                  </span>
                  <EmoteBubble emote={game?.role === "host" ? myEmote : incomingEmote} side={game?.role === "host" ? "mine" : "incoming"} />
                </p>
                <p className="text-2xl font-mono font-bold">{hostTimer}s</p>
              </div>
              <div
                data-testid="fiar-player-guest"
                data-active={activeSeat === "guest" ? "1" : undefined}
                className={`four-in-a-row-player relative rounded-lg p-2 border ${
                  activeSeat === "guest"
                    ? "four-in-a-row-player--active border-red-400 bg-red-500/10"
                    : inProgress
                      ? "four-in-a-row-player--idle border-white/15 bg-white/5"
                      : "border-white/15 bg-white/5"
                }`}
              >
                {cueSeat === "guest" && opponentCueNode}
                <p className="relative flex items-center gap-1.5 text-sm text-white/70">
                  <FrameAvatar frame={game?.guestProfileFrame} iconKey={game?.guestIconKey || null} name={game?.guestName} size="h-4 w-4" />
                  <span style={game?.guestNameColor ? { color: game.guestNameColor } : undefined}>
                    {game?.guestName || "Guest"}
                  </span>
                  <EmoteBubble emote={game?.role === "guest" ? myEmote : incomingEmote} side={game?.role === "guest" ? "mine" : "incoming"} />
                </p>
                <p className="text-2xl font-mono font-bold">{guestTimer}s</p>
              </div>
            </div>

            {/* Emotes */}
            <div className="mb-3 flex justify-center">
              <EmotePicker
                compact
                hideBubbles
                incomingEmote={incomingEmote}
                myEmote={myEmote}
                onSend={(emote) => sendEmote(emote)}
              />
            </div>

            {c4TurnLineNode}

            {/* The drop rail sits directly on the board it commands, one
                arrow per column. */}
            {c4DropControlsNode}

            {c4BoardNode}
          </div>

          <div
            className={`casino-surface four-in-a-row-panel p-4 ${canPlay ? "turn-active-glow" : ""}`}
          >
            <h2 className="text-base font-bold text-yellow-300 mb-3 flex items-center gap-2 uppercase tracking-wider">
              <IconTarget size={16} aria-hidden />
              <span>Match Details</span>
            </h2>

            <div className="mb-3 flex items-baseline gap-2">
              <span className="text-[10px] uppercase tracking-wider text-white/50">
                Status
              </span>
              <span className="text-sm font-semibold text-white">
                {statusText}
              </span>
            </div>

            {!isSpectator && spectatorCount > 0 && (
              <div className="mb-3 flex items-center gap-1.5 text-xs text-cyan-300">
                <IconEye size={14} aria-hidden />
                <span>
                  {spectatorCount} spectator{spectatorCount > 1 ? "s" : ""}
                </span>
              </div>
            )}

            <div className="mb-3 flex items-center gap-2">
              <span className="text-[10px] uppercase tracking-wider text-white/50">
                Color
              </span>
              <span
                className={`inline-flex items-center gap-1.5 rounded-sm px-2 py-0.5 text-xs font-semibold ${
                  game?.role === "host"
                    ? "bg-green-500/15 text-green-300 border border-green-400/30"
                    : game?.role === "guest"
                      ? "bg-red-500/15 text-red-300 border border-red-400/30"
                      : "bg-white/5 text-white/60 border border-white/10"
                }`}
              >
                <span
                  className={`inline-block h-2 w-2 rounded-full ${
                    game?.role === "host"
                      ? "bg-green-400"
                      : game?.role === "guest"
                        ? "bg-red-400"
                        : "bg-white/40"
                  }`}
                />
                {game?.role === "host"
                  ? "Green"
                  : game?.role === "guest"
                    ? "Red"
                    : "-"}
              </span>
            </div>

            <div className="mb-1 flex items-center justify-between gap-2 text-xs">
              <span className="text-white/50">Your discs</span>
              <span className="font-mono font-semibold text-white">
                {game?.role === "host"
                  ? game?.hostDiscsUsed
                  : game?.guestDiscsUsed}{" "}
                <span className="text-white/40">/ 21</span>
              </span>
            </div>
            <div className="mb-4 flex items-center justify-between gap-2 text-xs">
              <span className="text-white/50">Opponent discs</span>
              <span className="font-mono font-semibold text-white">
                {game?.role === "host"
                  ? game?.guestDiscsUsed
                  : game?.hostDiscsUsed}{" "}
                <span className="text-white/40">/ 21</span>
              </span>
            </div>

            {game?.status === "in_progress" && (
              <>
                <button
                  onClick={resignGame}
                  className="w-full py-2 rounded-lg bg-red-600 hover:bg-red-500 font-bold hover-lift"
                >
                  Resign Match
                </button>
                {game && game.guestClerkId && (
                  <button
                    onClick={() => setShowReportModal(true)}
                    className="mt-2 w-full text-xs text-slate-500 hover:text-red-400 transition underline underline-offset-4"
                  >
                    <span className="inline-flex items-center gap-1"><IconFlag size={12} /> Report Player</span>
                  </button>
                )}
              </>
            )}

            {(game?.status === "finished" || game?.status === "cancelled") && (
              <button
                onClick={() => router.push("/casino/four-in-a-row")}
                className="w-full py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 font-bold hover-lift"
              >
                Return to Lobby
              </button>
            )}
          </div>
        </div>

      </div>
    </motion.div>

    {/* Post-match result screen — the shared PvpResultScreen (UX plan P3-3),
        mounted INSIDE GameSessionHost so it appears in the recording (its
        compact styling keeps it sized for the phone frame).
        Hand-off: the shared panel already declares its own exit, but a panel
        unmounted by a condition never gets to play it — so it is handed off
        through <AnimatePresence> instead. When the match leaves the result
        state (a rematch was accepted, or the row gained a nextGameId) it fades
        out over ~0.28s rather than vanishing, and its props — including the
        winning-four strip — are frozen for the duration so nothing flickers.
        Still exactly ONE result system; this only wraps the existing panel. */}
    <AnimatePresence initial={false}>
      {showResultPopup && (
        <motion.div
          key="fiar-result"
          data-testid="fiar-result-transition"
          exit={{ opacity: 0 }}
          transition={{ duration: reduceMotion ? 0 : 0.28, ease: "easeOut" }}
        >
          {renderResult()}
        </motion.div>
      )}
    </AnimatePresence>
    </GameSessionHost>
    </>
  );
}
