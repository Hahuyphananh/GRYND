"use client";

import { CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
// Shared Creator Mode foundation (admin-only): mounts the viewport
// recorder + overlay and auto-starts when the actual game begins
// (in_progress), auto-stops when it finishes or the user quits. The
// waiting takeover stays OUTSIDE so nothing is recorded until real
// gameplay starts.
import CreatorModeHost from "../../../../../components/creator-mode/CreatorModeHost";
import {
  CreatorView,
  CreatorModeShell,
  ShellHeader,
  ShellMain,
  ShellAside,
} from "../../../../../components/creator-mode/CreatorModeLayout";
import { useSocket } from "../../../../../context/SocketProvider";
import EmotePicker, { EmoteBubble } from "../../../../../components/game/EmotePicker";
import useGameEmotes from "../../../../../hooks/useGameEmotes";
import { getDropRow } from "../../../../../lib/fourInARow";
import {
  getSharedAudioContext,
  getSharedOutputNode,
} from "../../../../../lib/creator-mode/audioTap";
import useGamePresence from "../../../../../hooks/useGamePresence";
import ReportModal from "../../../../../components/ReportModal";
import MatchWaiting from "../../../../../components/lobby/MatchWaiting";
import { celebrateWin, gameOverModal, turnBanner as turnBannerAnim } from "../../../../../lib/animations";
import {
  IconTarget,
  IconEye,
  IconFlag,
  IconTrophy,
  IconBomb,
} from "@tabler/icons-react";

const DEFAULT_MOVE_LIMIT_SECONDS = 60;
const REPLAY_WINDOW_SECONDS = 20;

const CONFETTI_COLORS = ["#facc15", "#4ade80", "#60a5fa", "#f472b6", "#f97316"];

function playUiTone(type: "drop" | "win" = "drop") {
  const ctx = getSharedAudioContext();
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain);
  gain.connect(getSharedOutputNode() || ctx.destination);
  const settings =
    type === "win"
      ? { freq: 640, duration: 0.18 }
      : { freq: 360, duration: 0.09 };
  osc.frequency.value = settings.freq;
  gain.gain.setValueAtTime(0.001, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.08, ctx.currentTime + 0.01);
  gain.gain.exponentialRampToValueAtTime(
    0.001,
    ctx.currentTime + settings.duration,
  );
  osc.start();
  osc.stop(ctx.currentTime + settings.duration);
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
  const color = value === 1 ? "four-in-a-row-disc-blue" : value === 2 ? "four-in-a-row-disc-purple" : "four-in-a-row-slot";
  return <div aria-hidden className={`four-in-a-row-disc ${color} ${className}`} style={style} />;
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
  const [fallingDisc, setFallingDisc] = useState<{
    row: number;
    col: number;
    value: number;
  } | null>(null);
  const [sendingReplayDecision, setSendingReplayDecision] = useState(false);
  const [replayMessage, setReplayMessage] = useState("");
  const [spectatorCount, setSpectatorCount] = useState(0);
  const [showReportModal, setShowReportModal] = useState(false);
  const [turnBanner, setTurnBanner] = useState<string | null>(null);
  const prevStatusTextRef = useRef<string | null>(null);

  useGamePresence({
    gameKey: "four-in-a-row",
    gameId: Number(gameId),
    enabled: !isSpectator && Boolean(gameId),
  });
  const previousBoardRef = useRef<number[][] | null>(null);

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
      setFallingDisc(latestDrop);
      playUiTone("drop");
      window.setTimeout(() => setFallingDisc(null), 450);
    }

    previousBoardRef.current = nextBoard.map((row: number[]) => [...row]);

    if (gameData.status === "waiting") {
      setStatusText("Waiting for opponent to join...");
      return;
    }

    if (gameData.status === "finished") {
      if (gameData.result === "draw") setStatusText("Draw game.");
      else if (
        gameData.winnerClerkId &&
        ((gameData.role === "host" &&
          gameData.winnerClerkId === gameData.hostClerkId) ||
          (gameData.role === "guest" &&
            gameData.winnerClerkId === gameData.guestClerkId))
      ) {
        setStatusText("You won!");
        playUiTone("win");
        celebrateWin();
      } else {
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

  useEffect(() => {
    fetchState();
    // Socket room ("match:updated") pushes opponent moves instantly; this
    // HTTP poll is a reconnect/consistency safety net. Turn pacing comes
    // from server deadlines + the clock tick, never from the poll rate, so
    // 5s is safe and keeps match-time DB reads minimal.
    const interval = setInterval(fetchState, 5000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameId]);

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
    const id = setInterval(pollSpectators, 5000);

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
      hb = setInterval(beat, 5000);
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

  // Turn banner detection
  useEffect(() => {
    if (!statusText || !game) return;
    const isMyTurn = statusText === "Your move";
    const isOppTurn = statusText === "Opponent's move";
    if (prevStatusTextRef.current !== null && prevStatusTextRef.current !== statusText && (isMyTurn || isOppTurn)) {
      setTurnBanner(isMyTurn ? "Your Turn" : "Opponent's Turn");
      setTimeout(() => setTurnBanner(null), 1800);
    }
    prevStatusTextRef.current = statusText;
  }, [statusText, game]);

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
  const showResultPopup = game?.status === "finished" && !game?.nextGameId;

  const playColumn = async (column: number) => {
    if (!canPlay || loadingMove) return;
    if (getDropRow(game.board, column) < 0) return;

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

  // ── Creator Mode bespoke portrait/landscape shell (shared recorder) ──
  // Board-centric 9:16 presentation: compact header keeps the match info
  // and turn timers readable, the board fills the main area, and the
  // drop controls + Match Details stay pinned below. Same shell adapts to
  // landscape/square via the shared layout primitives. Gameplay untouched.
  const c4BoardNode = (
    <div className="four-in-a-row-board grid grid-cols-7 gap-2 p-3 rounded-2xl border">
      {(game?.board || []).map((row: number[], rowIndex: number) =>
        row.map((value, colIndex) => {
          const isAnimatedCell =
            fallingDisc?.row === rowIndex && fallingDisc?.col === colIndex;
          const discValue = isAnimatedCell ? fallingDisc.value : value;
          return (
            <Disc
              key={`${rowIndex}-${colIndex}`}
              value={discValue}
              className={isAnimatedCell ? "four-in-a-row-fall" : ""}
              style={
                isAnimatedCell
                  ? ({
                      ["--drop-distance" as string]: `${(rowIndex + 1) * 66}px`,
                    } as CSSProperties)
                  : undefined
              }
            />
          );
        }),
      )}
    </div>
  );
  const c4DropControlsNode = (
    <div className="four-in-a-row-drop-controls grid grid-cols-7 gap-2">
      {Array.from({ length: 7 }).map((_, col) => (
        <button
          key={`drop-${col}`}
          onClick={() => playColumn(col)}
          disabled={!canPlay || getDropRow(game?.board || [], col) < 0}
          className="four-in-a-row-drop-button"
          title={`Drop in column ${col + 1}`}
        >
          ↓
        </button>
      ))}
    </div>
  );
  const c4Shell = (
    <CreatorModeShell className="bg-gradient-to-br from-[#0a0118] to-[#061b3d]">
      <ShellHeader className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="text-[10px] font-black uppercase tracking-widest text-yellow-300">Four-In-A-Row</p>
            <p className="truncate text-xs text-white/70">
              {game?.hostName || "Host"} vs {game?.guestName || "Guest"} ·{" "}
              {Number(game?.betAmount || 0).toFixed(2)} tokens
            </p>
          </div>
          <span
            className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-bold ${activeTimer <= 10 ? "bg-red-500/20 text-red-300" : "bg-green-500/15 text-green-300"}`}
          >
            ⏱ {activeTimer}s
          </span>
        </div>
        <div className="grid grid-cols-2 gap-1.5 text-[11px]">
          <span className="rounded-md bg-black/30 px-2 py-1 font-bold text-white/80">
            {game?.hostName || "Host"} · {hostTimer}s
          </span>
          <span className="rounded-md bg-black/30 px-2 py-1 font-bold text-white/80">
            {game?.guestName || "Guest"} · {guestTimer}s
          </span>
        </div>
      </ShellHeader>

      <ShellMain className="flex-col justify-center">
        <div className="w-full max-w-[560px] px-2">{c4BoardNode}</div>
      </ShellMain>

      <ShellAside>
        <p className="mb-2 text-[11px] font-bold uppercase tracking-widest text-white/50">
          Drop a disc … {game?.currentTurn === "host" ? game?.hostName || "Host" : game?.guestName || "Guest"}
        </p>
        {c4DropControlsNode}
        <div className="mt-3 flex justify-center">
          <EmotePicker compact hideBubbles incomingEmote={incomingEmote} myEmote={myEmote} onSend={(emote) => sendEmote(emote)} />
        </div>
      </ShellAside>
    </CreatorModeShell>
  );

  return (
    <>
      {/* Unified full-screen waiting takeover */}
      {game?.status === "waiting" && (
        <MatchWaiting
          state="waiting"
          gameName="Four-In-A-Row"
          subtitle="Waiting for an opponent to join…"
          seats={[
            { label: "You", name: "You", occupied: true },
            { label: "Opponent", occupied: false },
          ]}
          onLeave={() => router.push("/casino/four-in-a-row")}
        />
      )}

      {/* Turn Banner */}
      <AnimatePresence>
        {turnBanner && (
          <motion.div
            key="turn-banner"
            {...turnBannerAnim}
            className="fixed left-1/2 top-1/3 z-50 -translate-x-1/2 -translate-y-1/2 rounded-2xl border-4 border-amber-400 bg-gradient-to-r from-amber-700 to-orange-700 px-10 py-6 shadow-[0_0_60px_rgba(251,191,36,0.5)]"
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

  {/* Only the actual game content is recorded — the waiting takeover
      above stays outside the shared CreatorModeHost recording viewport.
      Recording auto-starts when the game goes in_progress and stops when
      it finishes/cancels or the user quits. */}
  <CreatorModeHost
    autoStart={game?.status === "in_progress"}
    autoStop={game?.status === "finished" || game?.status === "cancelled"}
    gameLabel="four-in-a-row"
  >
  <CreatorView normal={<motion.div
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
            <h1 className="text-3xl font-extrabold text-yellow-300">
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
            className="px-4 py-2 rounded-lg bg-white/10 hover:bg-white/20 hover-lift"
          >
            Back to Lobby
          </button>
        </div>

        {playerWon && (
          <div className="confetti-overlay">
            {Array.from({ length: 24 }).map((_, index) => (
              <span
                key={`c4-confetti-${index}`}
                className="confetti-piece"
                style={{
                  left: `${(index * 19) % 100}%`,
                  backgroundColor:
                    CONFETTI_COLORS[index % CONFETTI_COLORS.length],
                  animationDelay: `${(index % 6) * 0.06}s`,
                }}
              />
            ))}
          </div>
        )}

        <div className="grid lg:grid-cols-[minmax(0,1fr)_320px] gap-4">
          <div className="casino-surface p-3 rounded-2xl">
            <div className="flex justify-between items-center mb-4">
              <div>
                <p className="text-white/70 text-sm">
                  {game?.hostName || "Host"} (Green) vs{" "}
                  {game?.guestName || "Guest"} (Red)
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
                className={`rounded-lg p-2 border ${game?.currentTurn === "host" ? "border-green-400 bg-green-500/10" : "border-white/15 bg-white/5"}`}
              >
                <p className="relative text-sm text-white/70">
                  {game?.hostName || "Host"}
                  <EmoteBubble emote={game?.role === "host" ? myEmote : incomingEmote} side={game?.role === "host" ? "mine" : "incoming"} />
                </p>
                <p className="text-2xl font-mono font-bold">{hostTimer}s</p>
              </div>
              <div
                className={`rounded-lg p-2 border ${game?.currentTurn === "guest" ? "border-red-400 bg-red-500/10" : "border-white/15 bg-white/5"}`}
              >
                <p className="relative text-sm text-white/70">
                  {game?.guestName || "Guest"}
                  <EmoteBubble emote={game?.role === "guest" ? myEmote : incomingEmote} side={game?.role === "guest" ? "mine" : "incoming"} />
                </p>
                <p className="text-2xl font-mono font-bold">{guestTimer}s</p>
              </div>
            </div>

            {c4DropControlsNode}

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

            {c4BoardNode}
          </div>

          <div
            className={`casino-surface p-4 rounded-2xl ${canPlay ? "turn-active-glow" : ""}`}
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
                className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-semibold ${
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

        <AnimatePresence>
        {showResultPopup && (
          <motion.div
            key="cf-result-popup"
            {...gameOverModal.backdrop}
            className="fixed inset-0 z-50 bg-black/65 flex items-center justify-center p-4"
          >
            <motion.div
              {...gameOverModal.panel}
              className={`w-full max-w-md rounded-2xl border p-6 shadow-2xl ${
                playerWon
                  ? "border-yellow-400/40 bg-gradient-to-b from-[#0a2a1a] to-[#031a0a] shadow-[0_0_40px_rgba(250,204,21,0.2)]"
                  : "border-white/20 bg-[#031a37]"
              }`}
            >
              <motion.div
                initial={{ scale: 0, rotate: -30 }}
                animate={{ scale: 1, rotate: 0 }}
                transition={{ type: "spring", stiffness: 300, damping: 12, delay: 0.25 }}
                className="mb-2 text-6xl text-center"
              >
                {playerWon ? <IconTrophy size={56} className="text-yellow-400" /> : <IconBomb size={56} className="text-red-400" />}
              </motion.div>
              <motion.h3
                initial={{ y: 10, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                transition={{ delay: 0.4, duration: 0.3 }}
                className={`text-2xl font-extrabold mb-2 text-center ${playerWon ? "text-yellow-300" : "text-red-300"}`}
              >
                {playerWon ? <span className="inline-flex items-center gap-2"><IconTrophy size={24} /> You Won!</span> : <span className="inline-flex items-center gap-2"><IconBomb size={24} /> You Lost</span>}
              </motion.h3>
              <motion.p
                initial={{ y: 10, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                transition={{ delay: 0.5, duration: 0.3 }}
                className="text-white/80 mb-3 text-center"
              >
                Choose replay or quit. Auto-quit in{" "}
                <span className="font-mono font-bold text-yellow-300">
                  {replayCountdown}s
                </span>
                .
              </motion.p>
              {replayMessage && (
                <motion.p
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 0.6 }}
                  className="text-sm text-cyan-300 mb-4 text-center"
                >
                  {replayMessage}
                </motion.p>
              )}

              <motion.div
                initial={{ y: 10, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                transition={{ delay: 0.7, duration: 0.3 }}
                className="grid grid-cols-2 gap-3"
              >
                <button
                  onClick={() => respondReplay("replay")}
                  disabled={sendingReplayDecision}
                  className="py-2 rounded-lg bg-yellow-400 text-[#08213d] font-bold hover:bg-yellow-300 disabled:bg-slate-500"
                >
                  Replay
                </button>
                <button
                  onClick={() => respondReplay("quit")}
                  disabled={sendingReplayDecision}
                  className="py-2 rounded-lg bg-slate-700 text-white font-bold hover:bg-slate-600 disabled:bg-slate-500"
                >
                  Quit
                </button>
              </motion.div>
            </motion.div>
          </motion.div>
        )}
        </AnimatePresence>
      </div>
    </motion.div>}
      portrait={c4Shell}
      landscape={c4Shell}
    />
    </CreatorModeHost>
    </>
  );
}
