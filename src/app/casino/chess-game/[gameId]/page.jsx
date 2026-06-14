"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";
import { Chess } from "chess.js";
import { motion, AnimatePresence } from "framer-motion";
import { useSocket } from "../../../../context/SocketProvider";
import useGamePresence from "../../../../hooks/useGamePresence";
import ReportModal from "../../../../components/ReportModal";
import { celebrateWin, turnBanner as turnBannerAnim } from "../../../../lib/animations";
import { playCardDraw, playVictory, playDefeat } from "../../../../lib/gameAudio";

const Chessboard = dynamic(
  async () => {
    const mod = await import("react-chessboard");
    return mod.Chessboard;
  },
  { ssr: false },
);

const CONFETTI_COLORS = ["#facc15", "#22c55e", "#38bdf8", "#fb7185", "#a78bfa"];

function formatClock(seconds) {
  const safe = Math.max(0, Number(seconds || 0));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

export default function ChessGamePage() {
  const { gameId } = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();

  const color = searchParams.get("color") || "white";
  const isSpectator = searchParams.get("spectator") === "1";

  const focusTarget = searchParams.get("focusTarget") || "";
  const [spectatorFocus, setSpectatorFocus] = useState(
    searchParams.get("focus") || "white",
  );

  const [liveFen, setLiveFen] = useState("start");
  const [status, setStatus] = useState("Loading match...");
  const [gameData, setGameData] = useState(null);
  const [moves, setMoves] = useState([]);
  const [moveIndex, setMoveIndex] = useState(-1);
  const [isResigning, setIsResigning] = useState(false);
  const [showResignConfirm, setShowResignConfirm] = useState(false);
  const [showResultPopup, setShowResultPopup] = useState(false);
  const [resultText, setResultText] = useState("");
  const [showReportModal, setShowReportModal] = useState(false);
  const [turnBanner, setTurnBanner] = useState(null);
  const prevActiveTurnRef = useRef(null);
  const resultShownRef = useRef(false);
  const [captureFlash, setCaptureFlash] = useState(false);
  const [boardShake, setBoardShake] = useState(false);
  const prevFenRef = useRef("");
  const [loading, setLoading] = useState(false);

  const { socket } = useSocket();

  const activeColor = isSpectator ? spectatorFocus : color;

  useGamePresence({
    gameKey: "chess",
    gameId: Number(gameId),
    enabled: !isSpectator && Boolean(gameId),
  });

  const boardSize =
    typeof window !== "undefined" ? Math.min(window.innerWidth - 32, 640) : 640;

  const displayFen = useMemo(() => {
    if (moveIndex >= 0 && moves[moveIndex]?.fenAfter) {
      return moves[moveIndex].fenAfter;
    }
    return liveFen;
  }, [moveIndex, moves, liveFen]);

  async function fetchState() {
    const res = await fetch(`/api/chess/game-state?gameId=${gameId}`, {
      cache: "no-store",
      credentials: "include",
    });

    const data = await res.json();

    if (!res.ok) {
      setStatus("Unable to load game");
      return;
    }

    const game = data.data;
    if (isSpectator && focusTarget) {
      const normalizedTarget = String(focusTarget);
      if (normalizedTarget === String(game.whitePlayerId))
        setSpectatorFocus("white");
      else if (normalizedTarget === String(game.blackPlayerId))
        setSpectatorFocus("black");
    }

    // Turn banner detection
    if (game.activeTurn && prevActiveTurnRef.current !== null && prevActiveTurnRef.current !== game.activeTurn) {
      const myTurn = game.activeTurn === color;
      setTurnBanner(myTurn ? "Your Turn" : "Opponent's Turn");
      setTimeout(() => setTurnBanner(null), 1800);
    }
    prevActiveTurnRef.current = game.activeTurn;

    // Detect opponent capture & check by comparing FENs
    if (prevFenRef.current && game.fen && prevFenRef.current !== game.fen && !isSpectator) {
      const prevCount = (prevFenRef.current.match(/[pnbrqkPNBRQK]/g) || []).length;
      const newCount = (game.fen.match(/[pnbrqkPNBRQK]/g) || []).length;
      if (newCount < prevCount) {
        setCaptureFlash(true);
        setTimeout(() => setCaptureFlash(false), 400);
      }
      const prevFenParts = prevFenRef.current.split(" ");
      const newFenParts = game.fen.split(" ");
      if (newFenParts[1] !== prevFenParts[1]) {
        const prevTurn = game.activeTurn === color;
        if (!prevTurn) {
          setBoardShake(true);
          setTimeout(() => setBoardShake(false), 300);
        }
      }
    }
    prevFenRef.current = game.fen || "";

    setGameData(game);
    setMoves(game.moves || []);
    setLiveFen(game.fen || "start");

    if (!game.blackPlayerId) {
      setStatus("Waiting for opponent...");
      return;
    }

    if (game.status === "finished" || game.status === "expired") {
      const myId = color === "white" ? game.whitePlayerId : game.blackPlayerId;

      let text = "Game Over.";

      if (game.result === "draw") {
        text = "Draw.";
      } else if (game.winnerId) {
        text = game.winnerId === myId ? "You won!" : "You lost.";
      }

      setResultText(text);
      setStatus(text);
      setShowResultPopup(true);

      if (text.includes("won") && !resultShownRef.current) {
        resultShownRef.current = true;
        playVictory();
        celebrateWin();
      } else if (text.includes("lost") && !resultShownRef.current) {
        resultShownRef.current = true;
        playDefeat();
      }

      return;
    }

    setStatus("Game active");
  }

  useEffect(() => {
    fetchState();
    const id = setInterval(fetchState, 2000);
    return () => clearInterval(id);
  }, [gameId]);

  useEffect(() => {
    if (!socket) return;

    socket.emit("join_game", { gameId });

    socket.on("move", fetchState);

    return () => {
      socket.emit("leave_game", { gameId });
      socket.off("move", fetchState);
    };
  }, [socket, gameId]);

  async function onDrop(sourceSquare, targetSquare) {
    if (isSpectator) return false;

    // Turn guard — only allow moves during your turn
    const myTurn = color === "white" ? "white" : "black";
    if (!gameData || gameData.activeTurn !== myTurn) return false;

    // Detect capture locally
    const localGame = new Chess(displayFen);
    const localMove = localGame.move({ from: sourceSquare, to: targetSquare, promotion: "q" });
    const isCapture = localMove?.captured !== undefined;

    setLoading(true);

    const res = await fetch("/api/chess/move", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      credentials: "include",
      body: JSON.stringify({
        gameId: Number(gameId),
        from: sourceSquare,
        to: targetSquare,
        promotion: "q",
      }),
    });

    const data = await res.json();
    setLoading(false);

    if (!res.ok) return false;

    setLiveFen(data.data.fen);
    playCardDraw();

    // Capture flash
    if (isCapture) {
      setCaptureFlash(true);
      setTimeout(() => setCaptureFlash(false), 400);
    }

    socket?.emit("move", { gameId });

    return true;
  }

  async function resignGame() {
    if (!gameData || gameData.status !== "in_progress" || isResigning) return;
    setShowResignConfirm(false);

    setIsResigning(true);
    setLoading(true);

    try {
      const res = await fetch("/api/chess/end-game", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include",
        body: JSON.stringify({
          gameId: Number(gameId),
          result: "loss",
        }),
      });

      if (!res.ok) {
        setStatus("Failed to resign.");
        return;
      }

      await fetchState();
    } catch {
      setStatus("Failed to resign.");
    } finally {
      setIsResigning(false);
      setLoading(false);
    }
  }

  const myName =
    activeColor === "white"
      ? gameData?.whitePlayerName
      : gameData?.blackPlayerName;

  const opponentName =
    activeColor === "white"
      ? gameData?.blackPlayerName
      : gameData?.whitePlayerName;

  const myClock =
    activeColor === "white"
      ? gameData?.whiteTimeRemaining
      : gameData?.blackTimeRemaining;

  const oppClock =
    activeColor === "white"
      ? gameData?.blackTimeRemaining
      : gameData?.whiteTimeRemaining;

  return (
    <>
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

      <div className="min-h-screen bg-[#050816] text-white px-4 py-8 overflow-x-hidden">
      <div className="max-w-7xl mx-auto">
        {/* HEADER */}
        <div className="text-center mb-8">
          <h1 className="text-3xl font-black tracking-widest text-cyan-400 drop-shadow-[0_0_20px_#00ffff]">
            CHESS ARENA
          </h1>

          <p className="text-white/70 mt-3">
            Game #{gameId} •{" "}
            {isSpectator ? "Spectating" : `Playing as ${color}`}
          </p>
        </div>

        {/* MAIN */}
        <div className="grid lg:grid-cols-[1fr_340px] gap-8 items-start">
          {/* BOARD AREA */}
          <div className="flex justify-center">
            <div className="w-full max-w-[660px]">
              {/* OPPONENT */}
              <div className="mb-3 rounded-xl border border-cyan-400/30 bg-cyan-500/10 px-4 py-3 flex justify-between backdrop-blur-md">
                <span className="font-bold text-cyan-300">
                  {opponentName || "Opponent"}
                </span>
                <span className={`font-mono text-xl ${oppClock !== undefined && oppClock <= 10 ? "text-red-400 low-time-pulse" : "text-cyan-100"}`}>
                  {formatClock(oppClock)}
                </span>
              </div>

              {/* BOARD */}
              <div className={`relative p-[2px] rounded-2xl bg-gradient-to-r from-cyan-400 via-fuchsia-500 to-cyan-400 shadow-[0_0_35px rgba(0,255,255,0.35)] w-full max-w-[90vh] aspect-square mx-auto ${boardShake ? "animate-board-shake" : ""}`}>
                {/* Capture flash overlay */}
                <AnimatePresence>
                  {captureFlash && (
                    <motion.div
                      initial={{ opacity: 0.7 }}
                      animate={{ opacity: 0 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.4 }}
                      className="absolute inset-0 z-10 rounded-2xl bg-red-500 pointer-events-none"
                    />
                  )}
                </AnimatePresence>
                <div className="rounded-2xl overflow-hidden bg-[#0b1020] w-full h-full">
                  <Chessboard
                    id="CyberBoard"
                    animationDuration={320}
                    arePiecesDraggable={!isSpectator}
                    boardOrientation={activeColor}
                    position={displayFen}
                    onPieceDrop={onDrop}
                    customDarkSquareStyle={{
                      background: "linear-gradient(135deg,#131b3a,#1b2554)",
                    }}
                    customLightSquareStyle={{
                      background: "linear-gradient(135deg,#0ff6,#13d8ff)",
                    }}
                    // Removed fixed boardWidth
                    // Added styling to ensure it fills the container
                    customBoardStyle={{
                      width: "100%",
                      height: "100%",
                      display: "block",
                    }}
                  />
                </div>
              </div>

              {/* YOU */}
              <div className="mt-3 rounded-xl border border-fuchsia-400/30 bg-fuchsia-500/10 px-4 py-3 flex justify-between backdrop-blur-md">
                <span className="font-bold text-fuchsia-300">
                  {myName || "You"}
                </span>
                <span className={`font-mono text-xl ${myClock !== undefined && myClock <= 10 ? "text-red-400 low-time-pulse" : "text-fuchsia-100"}`}>
                  {formatClock(myClock)}
                </span>
              </div>

              {/* STATUS */}
              {loading && (
                <div className="mt-4 text-center">
                  <span className="inline-block w-5 h-5 border-2 border-cyan-400 border-t-transparent rounded-full animate-spin mr-2 align-middle"></span>
                  <span className="text-cyan-300 text-sm">Processing...</span>
                </div>
              )}
              <div className="mt-4 text-center font-semibold text-cyan-300 tracking-wide">
                {status}
              </div>
            </div>
          </div>

          {/* SIDEBAR */}
          <div className="rounded-2xl border border-white/10 bg-white/5 p-5 backdrop-blur-xl">
            <h2 className="text-2xl font-bold text-cyan-400 mb-4">
              Move History
            </h2>

            <div className="max-h-[420px] overflow-y-auto space-y-2 pr-1">
              {moves.length === 0 ? (
                <p className="text-white/60">No moves yet.</p>
              ) : (
                moves.map((move, i) => (
                  <button
                    key={move.id}
                    onClick={() => setMoveIndex(i)}
                    className="w-full text-left px-3 py-2 rounded-lg bg-white/5 hover:bg-cyan-400 hover:text-black transition-all duration-200"
                  >
                    {i + 1}. {move.moveSan}
                  </button>
                ))
              )}
            </div>

            {/* RESIGN BUTTON */}
            {!isSpectator && (
              <>
                <button
                  onClick={() => setShowResignConfirm(true)}
                  disabled={isResigning || gameData?.status === "finished"}
                  className="mt-5 w-full bg-red-600 hover:bg-red-700 py-3 rounded-xl font-bold transition disabled:opacity-50"
                >
                  {isResigning ? "Resigning..." : "Resign"}
                </button>

                {/* Resign confirmation modal */}
                <AnimatePresence>
                  {showResignConfirm && (
                    <motion.div
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/70 px-4"
                    >
                      <motion.div
                        initial={{ scale: 0.9 }}
                        animate={{ scale: 1 }}
                        exit={{ scale: 0.9 }}
                        className="bg-[#0b1020] border border-red-500/40 rounded-2xl p-6 max-w-sm w-full text-center shadow-[0_0_30px_rgba(239,68,68,0.3)]"
                      >
                        <h3 className="text-xl font-bold text-red-400 mb-3">Resign?</h3>
                        <p className="text-white/70 mb-5">You will lose this game. Are you sure?</p>
                        <div className="flex gap-3">
                          <button
                            onClick={() => setShowResignConfirm(false)}
                            className="flex-1 px-4 py-2 rounded-lg bg-gray-600 hover:bg-gray-500 font-semibold transition"
                          >
                            Cancel
                          </button>
                          <button
                            onClick={resignGame}
                            className="flex-1 px-4 py-2 rounded-lg bg-red-600 hover:bg-red-500 font-bold transition"
                          >
                            Resign
                          </button>
                        </div>
                      </motion.div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </>
            )}

            {/* REPORT PLAYER */}
            {!isSpectator && gameData && (gameData.whitePlayerId && gameData.blackPlayerId) && (
              <button
                onClick={() => setShowReportModal(true)}
                className="mt-2 w-full text-xs text-slate-500 hover:text-red-400 transition underline underline-offset-4"
              >
                🚩 Report Player
              </button>
            )}

            {/* RETURN */}
            <button
              onClick={() => router.push("/casino/chess")}
              className="mt-4 w-full bg-cyan-400 text-black font-bold py-3 rounded-xl hover:scale-[1.02] transition"
            >
              Return Lobby
            </button>
          </div>
        </div>
      </div>
      {/* Report Modal */}
      <ReportModal
        isOpen={showReportModal}
        onClose={() => setShowReportModal(false)}
        onSubmit={async (reason, details) => {
          const opponentId = gameData
            ? (color === "white" ? gameData.blackPlayerId : gameData.whitePlayerId)
            : "";
          const opponentName =
            color === "white" ? (gameData?.blackPlayerName || "Opponent") : (gameData?.whitePlayerName || "Opponent");
          const res = await fetch("/api/reports/submit", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              reportedClerkId: opponentId,
              gameType: "chess",
              gameId: String(gameId),
              reason,
              details: details || undefined,
            }),
          });
          const data = await res.json();
          if (!data.success) throw new Error(data.error || "Failed to submit report");
        }}
        reportedPlayerName={
          gameData
            ? (color === "white" ? (gameData.blackPlayerName || "Opponent") : (gameData.whitePlayerName || "Opponent"))
            : "Opponent"
        }
        gameType="Chess"
      />

      {showResultPopup && (
        <AnimatePresence>
        <div className="fixed inset-0 bg-black/75 z-50 flex items-center justify-center px-4">
          <motion.div
            key="chess-game-over"
            initial={{ scale: 0.6, opacity: 0, y: 40 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.6, opacity: 0, y: 40 }}
            transition={{ type: "spring", stiffness: 250, damping: 18 }}
            className="relative w-full max-w-md rounded-2xl border border-cyan-400/30 bg-[#0b1020] p-6 text-center overflow-hidden shadow-[0_0_40px_rgba(0,255,255,0.25)]"
          >
            <motion.h2
              initial={{ y: 20, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              transition={{ delay: 0.2 }}
              className="text-3xl font-black text-cyan-300 mb-3"
            >
              MATCH FINISHED
            </motion.h2>

            <motion.p
              initial={{ y: 20, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              transition={{ delay: 0.35 }}
              className="text-xl text-white mb-6"
            >
              {resultText}
            </motion.p>

            {resultText.includes("won") && (
              <div className="absolute inset-0 pointer-events-none">
                {Array.from({ length: 24 }).map((_, i) => (
                  <span
                    key={i}
                    className="absolute w-2 h-5 animate-bounce"
                    style={{
                      left: `${(i * 17) % 100}%`,
                      top: `${(i % 6) * 10}%`,
                      backgroundColor:
                        CONFETTI_COLORS[i % CONFETTI_COLORS.length],
                      animationDelay: `${i * 0.05}s`,
                    }}
                  />
                ))}
              </div>
            )}

            <button
              onClick={() => router.push("/casino/chess")}
              className="w-full bg-cyan-400 hover:bg-cyan-300 text-black font-bold py-3 rounded-xl transition"
            >
              Return to Lobby
            </button>
          </motion.div>
        </div>
        </AnimatePresence>
      )}
    </div>
    </>
  );
}
