"use client";

import { CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { useSocket } from "../../../../../context/SocketProvider";
import { getDropRow } from "../../../../../lib/connectFour";
import useGamePresence from "../../../../../hooks/useGamePresence";
import ReportModal from "../../../../../components/ReportModal";
import { celebrateWin, gameOverModal } from "../../../../../lib/animations";

const DEFAULT_MOVE_LIMIT_SECONDS = 60;
const REPLAY_WINDOW_SECONDS = 20;

const CONFETTI_COLORS = ["#facc15", "#4ade80", "#60a5fa", "#f472b6", "#f97316"];

function playUiTone(type: "drop" | "win" = "drop") {
  if (typeof window === "undefined") return;
  const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain);
  gain.connect(ctx.destination);
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
  const color =
    value === 1
      ? "bg-green-500"
      : value === 2
        ? "bg-red-500"
        : "bg-slate-900/60";
  return (
    <div
      className={`w-11 h-11 md:w-14 md:h-14 rounded-full border border-black/50 shadow-inner ${color} ${className}`}
      style={style}
    />
  );
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

  useGamePresence({
    gameKey: "connect-four",
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
    const res = await fetch(`/api/connect-four/game-state?gameId=${gameId}`, {
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

  useEffect(() => {
    fetchState();
    const interval = setInterval(fetchState, 1000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameId]);

  useEffect(() => {
    if (!socket) return;
    const roomId = `connect-four:${gameId}`;

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
          `/api/spectators/count?gameKey=connect-four&gameId=${gameId}`,
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
            gameKey: "connect-four",
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
      const res = await fetch("/api/connect-four/play-move", {
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
        roomId: `connect-four:${gameId}`,
        event: "match:updated",
      });
      fetchState();
    } finally {
      setLoadingMove(false);
    }
  };

  const resignGame = async () => {
    const res = await fetch("/api/connect-four/end-game", {
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
      roomId: `connect-four:${gameId}`,
      event: "match:updated",
    });
    fetchState();
  };

  const respondReplay = async (action: "replay" | "quit") => {
    if (!game || sendingReplayDecision) return;

    setSendingReplayDecision(true);
    try {
      const res = await fetch("/api/connect-four/replay-response", {
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
          roomId: `connect-four:${gameId}`,
          event: "match:updated",
        });
        router.push(`/casino/connect-four/game/${data.gameId}`);
        return;
      }

      if (data.resolved === "quit") {
        setReplayMessage(data.reason || "Replay was not accepted.");
        setTimeout(() => router.push("/casino/connect-four"), 900);
        return;
      }

      setReplayMessage(
        action === "replay"
          ? "Replay requested. Waiting for opponent..."
          : "Quitting match...",
      );
      socket?.emit("room_event", {
        roomId: `connect-four:${gameId}`,
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
      router.push(`/casino/connect-four/game/${game.nextGameId}`);
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
        () => router.push("/casino/connect-four"),
        900,
      );
      return () => clearTimeout(timeoutId);
    }

    return undefined;
  }, [game, replayCountdown, router]);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.3 }}
      className="min-h-screen bg-[#02142c] text-white px-4 py-8 page-enter"
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
              gameType: "connect-four",
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
        gameType="Connect Four"
      />

      <div className="max-w-5xl mx-auto relative overflow-hidden rounded-2xl">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-3xl font-extrabold text-yellow-300">
              Connect Four — Match #{gameId}
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
            onClick={() => router.push("/casino/connect-four")}
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

        <div className="grid lg:grid-cols-[1fr_320px] gap-6">
          <div className="casino-surface p-4 rounded-2xl">
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
                <p className="text-sm text-white/70">
                  {game?.hostName || "Host"}
                </p>
                <p className="text-2xl font-mono font-bold">{hostTimer}s</p>
              </div>
              <div
                className={`rounded-lg p-2 border ${game?.currentTurn === "guest" ? "border-red-400 bg-red-500/10" : "border-white/15 bg-white/5"}`}
              >
                <p className="text-sm text-white/70">
                  {game?.guestName || "Guest"}
                </p>
                <p className="text-2xl font-mono font-bold">{guestTimer}s</p>
              </div>
            </div>

            <div className="mb-2 grid grid-cols-7 gap-2">
              {Array.from({ length: 7 }).map((_, col) => (
                <button
                  key={`drop-${col}`}
                  onClick={() => playColumn(col)}
                  disabled={!canPlay || getDropRow(game?.board || [], col) < 0}
                  className="h-8 rounded-lg bg-yellow-400 text-[#0b2f57] font-black hover:bg-yellow-300 disabled:bg-slate-700 disabled:text-slate-400"
                  title={`Drop in column ${col + 1}`}
                >
                  ↓
                </button>
              ))}
            </div>

            <div className="grid grid-cols-7 gap-2 bg-[#11457e] p-3 rounded-xl border border-[#1e5b9a]">
              {(game?.board || []).map((row: number[], rowIndex: number) =>
                row.map((value, colIndex) => {
                  const isAnimatedCell =
                    fallingDisc?.row === rowIndex &&
                    fallingDisc?.col === colIndex;
                  const discValue = isAnimatedCell ? fallingDisc.value : value;
                  return (
                    <Disc
                      key={`${rowIndex}-${colIndex}`}
                      value={discValue}
                      className={isAnimatedCell ? "connect-four-fall" : ""}
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
          </div>

          <div
            className={`casino-surface p-4 rounded-2xl ${canPlay ? "turn-active-glow" : ""}`}
          >
            <h2 className="text-xl font-bold text-yellow-300 mb-3">
              Match Details
            </h2>
            <p className="mb-2">
              Status: <span className="font-semibold">{statusText}</span>
            </p>
            {!isSpectator && spectatorCount > 0 && (
              <p className="text-xs text-cyan-300 mb-2">
                👀 {spectatorCount} spectator{spectatorCount > 1 ? "s" : ""}
              </p>
            )}
            <p className="mb-2">
              Your color:{" "}
              <span className="font-semibold">
                {game?.role === "host"
                  ? "Green"
                  : game?.role === "guest"
                    ? "Red"
                    : "-"}
              </span>
            </p>
            <p className="mb-2">
              Discs used:{" "}
              {game?.role === "host"
                ? game?.hostDiscsUsed
                : game?.guestDiscsUsed}{" "}
              / 21
            </p>
            <p className="mb-4">
              Opponent discs:{" "}
              {game?.role === "host"
                ? game?.guestDiscsUsed
                : game?.hostDiscsUsed}{" "}
              / 21
            </p>

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
                    🚩 Report Player
                  </button>
                )}
              </>
            )}

            {(game?.status === "finished" || game?.status === "cancelled") && (
              <button
                onClick={() => router.push("/casino/connect-four")}
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
                {playerWon ? "🏆" : "💥"}
              </motion.div>
              <motion.h3
                initial={{ y: 10, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                transition={{ delay: 0.4, duration: 0.3 }}
                className={`text-2xl font-extrabold mb-2 text-center ${playerWon ? "text-yellow-300" : "text-red-300"}`}
              >
                {playerWon ? "🏆 You Won!" : "💥 You Lost"}
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
    </motion.div>
  );
}
