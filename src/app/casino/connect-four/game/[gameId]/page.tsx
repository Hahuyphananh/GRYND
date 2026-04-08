"use client";

import { CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useSocket } from "../../../../../context/SocketProvider";
import { getDropRow } from "../../../../../lib/connectFour";

const MOVE_LIMIT_SECONDS = 60;

const CONFETTI_COLORS = ["#facc15", "#4ade80", "#60a5fa", "#f472b6", "#f97316"];

function playUiTone(type: "drop" | "win" = "drop") {
  if (typeof window === "undefined") return;
  const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain);
  gain.connect(ctx.destination);
  const settings = type === "win" ? { freq: 640, duration: 0.18 } : { freq: 360, duration: 0.09 };
  osc.frequency.value = settings.freq;
  gain.gain.setValueAtTime(0.001, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.08, ctx.currentTime + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + settings.duration);
  osc.start();
  osc.stop(ctx.currentTime + settings.duration);
}


function Disc({ value, className = "", style }: { value: number; className?: string; style?: CSSProperties }) {
  const color = value === 1 ? "bg-green-500" : value === 2 ? "bg-red-500" : "bg-slate-900/60";
  return <div className={`w-11 h-11 md:w-14 md:h-14 rounded-full border border-black/50 shadow-inner ${color} ${className}`} style={style} />;
}

export default function ConnectFourGamePage() {
  const { gameId } = useParams<{ gameId: string }>();
  const router = useRouter();
  const { socket } = useSocket();

  const [game, setGame] = useState<any>(null);
  const [loadingMove, setLoadingMove] = useState(false);
  const [statusText, setStatusText] = useState("Loading game...");
  const [fallingDisc, setFallingDisc] = useState<{ row: number; col: number; value: number } | null>(null);
  const previousBoardRef = useRef<number[][] | null>(null);


  const detectLatestDrop = (previousBoard: number[][] | null, nextBoard: number[][]) => {
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
    const res = await fetch(`/api/connect-four/game-state?gameId=${gameId}`, { cache: "no-store" });
    const data = await res.json();
    if (!res.ok) {
      setStatusText(data.error || "Unable to load game");
      return;
    }

    const nextBoard = data?.data?.board || [];
    const latestDrop = detectLatestDrop(previousBoardRef.current, nextBoard);

    setGame(data.data);

    if (latestDrop) {
      setFallingDisc(latestDrop);
      playUiTone("drop");
      window.setTimeout(() => setFallingDisc(null), 450);
    }

    previousBoardRef.current = nextBoard.map((row: number[]) => [...row]);

    if (data.data.status === "waiting") {
      setStatusText("Waiting for opponent to join...");
      return;
    }

    if (data.data.status === "finished") {
      if (data.data.result === "draw") setStatusText("Draw game.");
      else if (data.data.winnerClerkId && ((data.data.role === "host" && data.data.winnerClerkId === data.data.hostClerkId) || (data.data.role === "guest" && data.data.winnerClerkId === data.data.guestClerkId))) {
        setStatusText("You won!");
        playUiTone("win");
      } else {
        setStatusText("You lost.");
      }
      return;
    }

    const myTurn = data.data.currentTurn === data.data.role;
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

  const canPlay = useMemo(() => {
    if (!game) return false;
    return game.status === "in_progress" && game.currentTurn === game.role;
  }, [game]);

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
        alert(data.error || "Move rejected");
        return;
      }

      socket?.emit("room_event", { roomId: `connect-four:${gameId}`, event: "match:updated" });
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

    socket?.emit("room_event", { roomId: `connect-four:${gameId}`, event: "match:updated" });
    fetchState();
  };

  const timer = game?.status === "in_progress" ? Math.min(MOVE_LIMIT_SECONDS, Math.max(0, Number(game.moveTimeRemaining || 0))) : 0;

  return (
    <div className="min-h-screen bg-[#02142c] text-white px-4 py-8 page-enter">
      <div className="max-w-5xl mx-auto relative overflow-hidden rounded-2xl">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-3xl font-extrabold text-yellow-300">Connect Four — Match #{gameId}</h1>
          <button onClick={() => router.push("/casino/connect-four")} className="px-4 py-2 rounded-lg bg-white/10 hover:bg-white/20 hover-lift">
            Back to Lobby
          </button>
        </div>

        {statusText.includes("You won") && (
          <div className="confetti-overlay">
            {Array.from({ length: 24 }).map((_, index) => (
              <span
                key={`c4-confetti-${index}`}
                className="confetti-piece"
                style={{
                  left: `${(index * 19) % 100}%`,
                  backgroundColor: CONFETTI_COLORS[index % CONFETTI_COLORS.length],
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
                <p className="text-white/70 text-sm">{game?.hostName || "Host"} (Green) vs {game?.guestName || "Guest"} (Red)</p>
                <p className="font-bold text-lg">Bet: {Number(game?.betAmount || 0).toFixed(2)} tokens each</p>
              </div>
              <div className="text-right">
                <p className="text-sm text-white/70">Move timer</p>
                <p className={`text-3xl font-mono font-bold ${timer <= 10 ? "text-red-400 low-time-pulse" : "text-green-300"}`}>{timer}s</p>
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
                  const isAnimatedCell = fallingDisc?.row === rowIndex && fallingDisc?.col === colIndex;
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
                })
              )}
            </div>
          </div>

          <div className={`casino-surface p-4 rounded-2xl ${canPlay ? "turn-active-glow" : ""}` }>
            <h2 className="text-xl font-bold text-yellow-300 mb-3">Match Details</h2>
            <p className="mb-2">Status: <span className="font-semibold">{statusText}</span></p>
            <p className="mb-2">Your color: <span className="font-semibold">{game?.role === "host" ? "Green" : game?.role === "guest" ? "Red" : "-"}</span></p>
            <p className="mb-2">Discs used: {game?.role === "host" ? game?.hostDiscsUsed : game?.guestDiscsUsed} / 21</p>
            <p className="mb-4">Opponent discs: {game?.role === "host" ? game?.guestDiscsUsed : game?.hostDiscsUsed} / 21</p>

            {game?.status === "in_progress" && (
              <button onClick={resignGame} className="w-full py-2 rounded-lg bg-red-600 hover:bg-red-500 font-bold hover-lift">
                Resign Match
              </button>
            )}

            {(game?.status === "finished" || game?.status === "cancelled") && (
              <button onClick={() => router.push("/casino/connect-four")} className="w-full py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 font-bold hover-lift">
                Return to Lobby
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
