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
import { usePostHog } from "posthog-js/react";
import {
  IconAlertTriangle,
  IconBolt,
  IconHeartHandshake,
  IconFlag,
} from "@tabler/icons-react";

const Chessboard = dynamic(
  async () => {
    const mod = await import("react-chessboard");
    return mod.Chessboard;
  },
  { ssr: false },
);

const CONFETTI_COLORS = ["#facc15", "#22c55e", "#38bdf8", "#fb7185", "#a78bfa"];

const PIECE_SYMBOLS = {
  p: "♟", n: "♞", b: "♝", r: "♜", q: "♛",
  P: "♙", N: "♘", B: "♗", R: "♖", Q: "♕",
};

const PIECE_VALUES = {
  p: 1, n: 3, b: 3, r: 5, q: 9,
  P: 1, N: 3, B: 3, R: 5, Q: 9,
};

const INITIAL_PIECES = {
  p: 8, n: 2, b: 2, r: 2, q: 1,
  P: 8, N: 2, B: 2, R: 2, Q: 1,
};

// Precomputed inverted symbol map for O(1) lookups
const SYMBOL_TO_KEY = {};
for (const [k, v] of Object.entries(PIECE_SYMBOLS)) SYMBOL_TO_KEY[v] = k;

function formatClock(seconds) {
  const safe = Math.max(0, Number(seconds || 0));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function getCapturedPieces(fen) {
  if (!fen) return { white: [], black: [] };
  const boardPart = fen.split(" ")[0];
  const pieceCounts = {};
  for (const ch of boardPart) {
    if (/[pnbrqkPNBRQK]/.test(ch)) {
      pieceCounts[ch] = (pieceCounts[ch] || 0) + 1;
    }
  }
  const captured = { white: [], black: [] };
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
  // Sort by value (high to low) for nice display
  captured.white.sort((a, b) => (PIECE_VALUES[SYMBOL_TO_KEY[b]] || 0) - (PIECE_VALUES[SYMBOL_TO_KEY[a]] || 0));
  captured.black.sort((a, b) => (PIECE_VALUES[SYMBOL_TO_KEY[b]] || 0) - (PIECE_VALUES[SYMBOL_TO_KEY[a]] || 0));
  return captured;
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
  const [resultPayout, setResultPayout] = useState("");
  const [showReportModal, setShowReportModal] = useState(false);
  const [turnBanner, setTurnBanner] = useState(null);
  const prevActiveTurnRef = useRef(null);
  const resultShownRef = useRef(false);
  const [captureFlash, setCaptureFlash] = useState(false);
  const [boardShake, setBoardShake] = useState(false);
  const prevFenRef = useRef("");
  const firstFetchDoneRef = useRef(false);
  const gameFinishedRef = useRef(false);
  const [loading, setLoading] = useState(false);
  const posthog = usePostHog();

  // Draw offer state
  const [drawOffered, setDrawOffered] = useState(false);
  const [drawOfferReceived, setDrawOfferReceived] = useState(false);
  // Handle promotion piece selection from react-chessboard dialog
  const promotionHandledRef = useRef(false);

  // Pre-move support
  const premoveRef = useRef(null); // { from, to } | null
  const [premove, setPremove] = useState(null); // mirror for re-renders

  const { socket } = useSocket();

  const activeColor = isSpectator ? spectatorFocus : color;

  useGamePresence({
    gameKey: "chess",
    gameId: Number(gameId),
    enabled: !isSpectator && Boolean(gameId),
  });

  const displayFen = useMemo(() => {
    if (moveIndex >= 0 && moves[moveIndex]?.fenAfter) {
      return moves[moveIndex].fenAfter;
    }
    return liveFen;
  }, [moveIndex, moves, liveFen]);

  // --- Derived board state ---

  // Last move highlight squares
  const lastMoveSquares = useMemo(() => {
    if (moves.length === 0) return null;
    const lastMove = moveIndex >= 0 ? moves[moveIndex] : moves[moves.length - 1];
    if (!lastMove?.moveUci || lastMove.moveUci.length < 4) return null;
    return {
      from: lastMove.moveUci.substring(0, 2),
      to: lastMove.moveUci.substring(2, 4),
    };
  }, [moves, moveIndex]);

  // Check detection
  const isInCheck = useMemo(() => {
    try {
      const chess = new Chess(displayFen);
      return chess.inCheck();
    } catch {
      return false;
    }
  }, [displayFen]);

  // King square in check
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

  // Captured pieces
  const capturedPieces = useMemo(() => getCapturedPieces(displayFen), [displayFen]);

  // Custom square styles: highlight last move + check
  const customSquareStyles = useMemo(() => {
    const styles = {};

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

    // Pre-move squares (blue highlight)
    if (premove) {
      styles[premove.from] = {
        backgroundColor: "rgba(59, 130, 246, 0.4)",
        border: "2px solid rgba(59, 130, 246, 0.7)",
      };
      styles[premove.to] = {
        backgroundColor: "rgba(59, 130, 246, 0.5)",
        border: "2px solid rgba(59, 130, 246, 0.8)",
      };
    }

    return styles;
  }, [lastMoveSquares, checkSquare, premove]);

  async function fetchState() {
    if (gameFinishedRef.current) return;

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

    // Detect opponent capture & check by comparing FENs (skip on first fetch)
    if (firstFetchDoneRef.current && prevFenRef.current && game.fen && prevFenRef.current !== game.fen && !isSpectator) {
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

    // Auto-reset move index to latest
    if (moveIndex !== -1 && game.moves && moveIndex !== game.moves.length - 1) {
      // Keep user's history view until they click latest
    }

    // Check for pre-move execution: turn just switched to us and we have a queued move
    if (!isSpectator && premoveRef.current && game.activeTurn === color && game.status === "in_progress") {
      const pm = premoveRef.current;
      // Clear pre-move before executing (avoid re-entry)
      premoveRef.current = null;
      setPremove(null);
      // Validate and execute the pre-move against the current position
      const chess = new Chess(game.fen || "start");
      const pmMove = chess.move({ from: pm.from, to: pm.to, promotion: pm.promotion || "q" });
      if (pmMove) {
        // Execute pre-move immediately
        const pmRes = await fetch("/api/chess/move", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            gameId: Number(gameId),
            from: pm.from,
            to: pm.to,
            promotion: pm.promotion || "q",
          }),
        });
        const pmData = await pmRes.json();
        if (pmRes.ok) {
          setLiveFen(pmData.data.fen);
          playCardDraw();
          if (pmMove.captured) {
            setCaptureFlash(true);
            setTimeout(() => setCaptureFlash(false), 400);
          }
          socket?.emit("move", { gameId });
          return;
        }
      }
    }

    if (!game.blackPlayerId) {
      setStatus("Waiting for opponent...");
      return;
    }

    if (game.status === "finished" || game.status === "expired") {
      gameFinishedRef.current = true;
      const myId = color === "white" ? game.whitePlayerId : game.blackPlayerId;

      let text = "Game Over.";
      let payoutText = "";

      if (game.result === "draw") {
        text = "Draw.";
        payoutText = "Stake returned.";
      } else if (game.result === "timeout") {
        const iWon = game.winnerId === myId;
        text = iWon ? "You won on time!" : "You lost on time.";
        if (iWon) {
          const houseFee = Number(game.betAmount) * 2 * 0.1;
          const payout = Number(game.betAmount) * 2 - houseFee;
          payoutText = `+$${payout.toFixed(2)}`;
        } else {
          payoutText = `-$${Number(game.betAmount).toFixed(2)}`;
        }
      } else if (game.winnerId) {
        const iWon = game.winnerId === myId;
        text = iWon ? "You won!" : "You lost.";
        if (iWon) {
          const payout = game.payout
            ? Number(game.payout).toFixed(2)
            : (Number(game.betAmount) * 2 * 0.9).toFixed(2);
          payoutText = `+$${payout}`;
        } else {
          payoutText = `-$${Number(game.betAmount).toFixed(2)}`;
        }
      } else if (game.result === "opponent_left") {
        const iWon = game.winnerId === myId;
        text = iWon ? "Opponent left. You win!" : "You left the game.";
        if (iWon && game.payout) {
          payoutText = `+$${Number(game.payout).toFixed(2)}`;
        }
      }

      setResultText(text);
      setResultPayout(payoutText);
      setStatus(text);
      setShowResultPopup(true);

      const resultType = text.includes("won") ? "win" : text.includes("Draw") ? "draw" : "lose";
      posthog?.capture("chess_pvp_game_ended", {
        game_id: Number(gameId),
        result: resultType,
        game_result: game.result,
        bet_amount: Number(game.betAmount),
      });

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
    if (!firstFetchDoneRef.current) {
      posthog?.capture("chess_pvp_game_started", {
        game_id: Number(gameId),
        color,
        bet_amount: Number(game.betAmount),
        opponent: game.whitePlayerId && game.blackPlayerId ? "matched" : "waiting",
      });
    }
    firstFetchDoneRef.current = true;
  }

  useEffect(() => {
    let cancelled = false;

    fetchState();
    const id = setInterval(() => {
      if (cancelled) return;
      fetchState();
    }, 2000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [gameId]);

  // Socket: game events + draw offers
  useEffect(() => {
    if (!socket) return;

    socket.emit("join_game", { gameId });

    socket.on("move", fetchState);

    // Draw offer handling
    socket.on("draw_offered", () => {
      setDrawOfferReceived(true);
    });
    socket.on("draw_declined", () => {
      setDrawOffered(false);
      setDrawOfferReceived(false);
    });
    socket.on("draw_accepted", () => {
      setDrawOfferReceived(false);
      setDrawOffered(false);
      fetchState();
    });

    return () => {
      socket.emit("leave_game", { gameId });
      socket.off("move", fetchState);
      socket.off("draw_offered");
      socket.off("draw_declined");
      socket.off("draw_accepted");
    };
  }, [socket, gameId]);

  async function onDrop(sourceSquare, targetSquare) {
    // Always reset promotion guard and check if promotion already handled
    const promotionAlreadyHandled = promotionHandledRef.current;
    promotionHandledRef.current = false;
    if (promotionAlreadyHandled) return true;

    if (isSpectator) return false;
    // Don't allow moves while browsing history
    if (moveIndex >= 0) return false;

    const myTurn = color === "white" ? "white" : "black";

    // If it's not our turn, try to queue as pre-move
    if (!gameData || gameData.activeTurn !== myTurn) {
      // Cancel pre-move if dropping on the pre-move source square
      if (premoveRef.current && sourceSquare === premoveRef.current.from && targetSquare === premoveRef.current.from) {
        premoveRef.current = null;
        setPremove(null);
        return false;
      }

      if (gameData?.status !== "in_progress") return false;

      // Validate the move locally
      const localGame = new Chess(displayFen);
      const localMove = localGame.move({ from: sourceSquare, to: targetSquare, promotion: "q" });
      localGame.undo();
      if (!localMove) return false;

      // Queue as pre-move (or replace existing one)
      premoveRef.current = { from: sourceSquare, to: targetSquare, promotion: "q" };
      setPremove({ from: sourceSquare, to: targetSquare });
      return true;
    }

    // Auto-promote to queen (promotion dialog handles selection)
    const localGame = new Chess(displayFen);
    const localMove = localGame.move({ from: sourceSquare, to: targetSquare, promotion: "q" });
    if (!localMove) return false;

    const isCapture = localMove.captured !== undefined;

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

    if (isCapture) {
      setCaptureFlash(true);
      setTimeout(() => setCaptureFlash(false), 400);
    }

    socket?.emit("move", { gameId });

    // Clear any pre-move after executing our own move
    premoveRef.current = null;
    setPremove(null);

    return true;
  }

  // Handle promotion piece selection from react-chessboard dialog
  async function onPromotionPieceCheck(sourceSquare, targetSquare, piece) {
    if (isSpectator) return false;
    if (moveIndex >= 0) return false;

    // If it's not our turn, queue as pre-move
    if (!gameData || gameData.activeTurn !== (color === "white" ? "white" : "black")) {
      if (gameData?.status !== "in_progress") return false;
      const promo = piece ? piece[1]?.toLowerCase() : "q";
      const localGame = new Chess(displayFen);
      const localMove = localGame.move({ from: sourceSquare, to: targetSquare, promotion: promo });
      localGame.undo();
      if (!localMove) return false;
      premoveRef.current = { from: sourceSquare, to: targetSquare, promotion: promo };
      setPremove({ from: sourceSquare, to: targetSquare });
      return true;
    }

    // Flag that promotion handled this move so onDrop skips it
    promotionHandledRef.current = true;

    const myTurn = color === "white" ? "white" : "black";
    if (gameData.activeTurn !== myTurn) return false;

    const promo = piece ? piece[1]?.toLowerCase() : "q"; // e.g., "wQ" → "q"
    const localGame = new Chess(displayFen);
    const localMove = localGame.move({ from: sourceSquare, to: targetSquare, promotion: promo });
    if (!localMove) return false;

    const isCapture = localMove.captured !== undefined;

    setLoading(true);

    const res = await fetch("/api/chess/move", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        gameId: Number(gameId),
        from: sourceSquare,
        to: targetSquare,
        promotion: promo,
      }),
    });

    const data = await res.json();
    setLoading(false);

    if (!res.ok) return false;

    setLiveFen(data.data.fen);
    playCardDraw();

    if (isCapture) {
      setCaptureFlash(true);
      setTimeout(() => setCaptureFlash(false), 400);
    }

    socket?.emit("move", { gameId });

    // Clear any pre-move after executing promotion
    premoveRef.current = null;
    setPremove(null);

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

  // Draw offer
  function offerDraw() {
    if (!gameData || gameData.status !== "in_progress") return;
    setDrawOffered(true);
    socket?.emit("draw_offer", { gameId });
  }

  function acceptDraw() {
    if (!gameData) return;
    setDrawOfferReceived(false);
    // End game as draw via API
    fetch("/api/chess/end-game", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        gameId: Number(gameId),
        result: "draw",
      }),
    }).then(() => {
      socket?.emit("draw_accepted", { gameId });
      fetchState();
    }).catch(() => {});
  }

  function declineDraw() {
    setDrawOfferReceived(false);
    socket?.emit("draw_decline", { gameId });
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

  const myCaptured = activeColor === "white" ? capturedPieces.white : capturedPieces.black;
  const oppCaptured = activeColor === "white" ? capturedPieces.black : capturedPieces.white;

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

      {/* Check Banner */}
      <AnimatePresence>
        {isInCheck && !gameData?.status?.match(/finished|expired/) && (
          <motion.div
            key="check-banner"
            initial={{ opacity: 0, y: -30 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -30 }}
            className="fixed left-1/2 top-24 z-40 -translate-x-1/2 rounded-xl border-2 border-red-500 bg-red-900/80 px-6 py-2 shadow-[0_0_24px_rgba(255,0,0,0.4)]"
          >
            <span className="inline-flex items-center gap-2 text-lg font-bold text-red-300 tracking-wider"><IconAlertTriangle size={20} /> CHECK!</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Draw offer notification */}
      <AnimatePresence>
        {drawOfferReceived && (
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9 }}
            className="fixed left-1/2 top-1/3 z-50 -translate-x-1/2 rounded-2xl border-2 border-yellow-400 bg-[#1a1a0d] p-6 shadow-[0_0_30px_rgba(250,204,21,0.3)]"
          >
            <p className="text-yellow-300 font-bold text-lg mb-3">Opponent offers a draw</p>
            <div className="flex gap-3 justify-center">
              <button
                onClick={acceptDraw}
                className="bg-green-600 hover:bg-green-500 text-white px-6 py-2 rounded-lg font-bold"
              >
                Accept
              </button>
              <button
                onClick={declineDraw}
                className="bg-gray-600 hover:bg-gray-500 text-white px-6 py-2 rounded-lg font-bold"
              >
                Decline
              </button>
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
              <div className="mb-3 rounded-xl border border-cyan-400/30 bg-cyan-500/10 px-4 py-3 flex justify-between items-center backdrop-blur-md">
                <div className="flex items-center gap-2">
                  <span className="font-bold text-cyan-300">
                    {opponentName || "Opponent"}
                  </span>
                  {oppCaptured.length > 0 && (
                    <span className="text-lg tracking-tight opacity-80">
                      {oppCaptured.join(" ")}
                    </span>
                  )}
                </div>
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
                    arePiecesDraggable={!isSpectator && moveIndex === -1}
                    boardOrientation={activeColor}
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

              {/* YOU */}
              <div className="mt-3 rounded-xl border border-fuchsia-400/30 bg-fuchsia-500/10 px-4 py-3 flex justify-between items-center backdrop-blur-md">
                <div className="flex items-center gap-2">
                  <span className="font-bold text-fuchsia-300">
                    {myName || "You"}
                  </span>
                  {myCaptured.length > 0 && (
                    <span className="text-lg tracking-tight opacity-80">
                      {myCaptured.join(" ")}
                    </span>
                  )}
                </div>
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
                {premove && !isSpectator && (
                  <span className="ml-2 inline-flex items-center gap-1 text-blue-400 text-sm">
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
                    <IconBolt size={12} /> Pre-move queued
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* SIDEBAR */}
          <div className="rounded-2xl border border-white/10 bg-white/5 p-5 backdrop-blur-xl">
            <h2 className="text-2xl font-bold text-cyan-400 mb-4">
              Move History
            </h2>

            <div className="max-h-[320px] overflow-y-auto space-y-2 pr-1">
              {moves.length === 0 ? (
                <p className="text-white/60">No moves yet.</p>
              ) : (
                moves.map((move, i) => (
                  <button
                    key={move.id ?? i}
                    onClick={() => setMoveIndex(i)}
                    className="w-full text-left px-3 py-2 rounded-lg bg-white/5 hover:bg-cyan-400 hover:text-black transition-all duration-200"
                  >
                    <span className="text-white/40 text-xs mr-2">
                      {Math.floor(i / 2) + 1}{i % 2 === 0 ? "." : "..."}
                    </span>
                    {move.moveSan}
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

            {/* ACTION BUTTONS */}
            {!isSpectator && (
              <>
                {/* Draw Offer */}
                {drawOffered ? (
                  <div className="mt-3 w-full text-center text-yellow-400 text-sm py-2 border border-yellow-400/30 rounded-lg bg-yellow-400/5">
                    Draw offered. Waiting...
                  </div>
                ) : (
                  <button
                    onClick={offerDraw}
                    disabled={gameData?.status !== "in_progress" || drawOfferReceived}
                    className="mt-3 w-full bg-yellow-600 hover:bg-yellow-500 py-2 rounded-xl font-bold transition disabled:opacity-40 text-sm"
                  >
                    <span className="inline-flex items-center gap-2"><IconHeartHandshake size={16} /> Offer Draw</span>
                  </button>
                )}

                {/* Resign */}
                <button
                  onClick={() => setShowResignConfirm(true)}
                  disabled={isResigning || gameData?.status === "finished"}
                  className="mt-2 w-full bg-red-600 hover:bg-red-700 py-3 rounded-xl font-bold transition disabled:opacity-50"
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
                <span className="inline-flex items-center gap-1"><IconFlag size={12} /> Report Player</span>
              </button>
            )}

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
              className="text-xl text-white mb-2"
            >
              {resultText}
            </motion.p>

            {resultPayout && (
              <motion.p
                initial={{ y: 20, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                transition={{ delay: 0.45 }}
                className={`text-lg font-bold mb-6 ${resultPayout.startsWith("+") ? "text-green-400" : resultPayout.startsWith("-") ? "text-red-400" : "text-yellow-300"}`}
              >
                {resultPayout}
              </motion.p>
            )}

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
