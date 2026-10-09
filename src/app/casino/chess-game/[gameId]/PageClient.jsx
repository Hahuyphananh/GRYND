"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";
import { Chess } from "chess.js";
import { motion, AnimatePresence } from "framer-motion";
import { useSocket } from "../../../../context/SocketProvider";
import useGamePresence from "../../../../hooks/useGamePresence";
import { useRealtimeSubscription } from "../../../../hooks/useRealtimeSubscription";
import ReportModal from "../../../../components/ReportModal";
import MatchWaiting from "../../../../components/lobby/MatchWaiting";
import PvpResultScreen from "../../../../components/result/PvpResultScreen";
import EmotePicker, { EmoteArtwork } from "../../../../components/game/EmotePicker";
import GameSessionHost from "../../../../components/GameSessionHost";


import { turnBanner as turnBannerAnim } from "../../../../lib/animations";
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
  const [showReportModal, setShowReportModal] = useState(false);
  const [turnBanner, setTurnBanner] = useState(null);
  const prevActiveTurnRef = useRef(null);
  const resultShownRef = useRef(false);
  const [captureFlash, setCaptureFlash] = useState(false);
  const [boardShake, setBoardShake] = useState(false);
  const prevFenRef = useRef("");
  const firstFetchDoneRef = useRef(false);
  const gameFinishedRef = useRef(false);
  // React state mirror of the finished flag, so the realtime subscription can
  // be torn down once the final state has been processed (objective: stop
  // listening after the game ends).
  const [gameFinished, setGameFinished] = useState(false);
  // ── Realtime sync state (replaces the old 2s /api/chess/game-state poll) ──
  // Local, ticking clock seeded by the authoritative snapshot; advanced by the
  // 1s UI ticker and corrected on each move event. Pure UI computation.
  const [clocks, setClocks] = useState({ white: null, black: null, activeTurn: "white", at: 0 });
  const [clockNow, setClockNow] = useState(() => Date.now());
  // Highest move id already applied, so a duplicate Realtime event is a no-op.
  const appliedMoveIdRef = useRef(0);
  // Single-flight guard for the edge-triggered authoritative refresh.
  const refreshInFlightRef = useRef(false);
  const refreshQueuedRef = useRef(false);
  // Set when the Realtime channel drops, so the next SUBSCRIBED reconciles once.
  const realtimeRecoveryRef = useRef({ needsRecovery: false });
  // Counts socket connections so only a RECONNECT (not the first connect) refreshes.
  const socketConnectCountRef = useRef(0);
  // Guards the one-shot timeout settlement so it can never fire in a loop.
  const timeoutSettledRef = useRef(false);
  // Stable handle to the latest fetchState (avoids re-binding effects).
  const fetchStateRef = useRef(null);
  const [loading, setLoading] = useState(false);
  const posthog = usePostHog();

  // Draw offer state
  const [drawOffered, setDrawOffered] = useState(false);
  const [drawOfferReceived, setDrawOfferReceived] = useState(false);
  // Emote state
  const [incomingEmote, setIncomingEmote] = useState(null);
  const [myEmote, setMyEmote] = useState(null);
  // Handle promotion piece selection from react-chessboard dialog
  const promotionHandledRef = useRef(false);

  // Pre-move support
  const premoveRef = useRef(null); // { from, to } | null
  const [premove, setPremove] = useState(null); // mirror for re-renders

  const { socket } = useSocket();

  const activeColor = isSpectator ? spectatorFocus : color;

  useGamePresence({
    gameKey: "chess",
    gameId: gameId,
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

    // Seed the LOCAL clock from this authoritative snapshot. The 1s UI ticker
    // (and each move event) advances it from here; no further server reads are
    // needed to keep the displayed clock accurate.
    setClocks({
      white: Number(game.whiteTimeRemaining ?? 0),
      black: Number(game.blackTimeRemaining ?? 0),
      activeTurn: game.activeTurn === "black" ? "black" : "white",
      at: Date.now(),
    });
    if (Array.isArray(game.moves) && game.moves.length > 0) {
      appliedMoveIdRef.current = Math.max(
        appliedMoveIdRef.current,
        ...game.moves.map((m) => Number(m.id) || 0),
      );
    }
    timeoutSettledRef.current = false;

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
            gameId: gameId,
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
      setGameFinished(true);
      const myId = color === "white" ? game.whitePlayerId : game.blackPlayerId;

      // Result copy only — no stake/payout figure is produced or shown.
      let text = "Game Over.";

      if (game.result === "draw") {
        text = "Draw.";
      } else if (game.result === "timeout") {
        text = game.winnerId === myId ? "You won on time!" : "You lost on time.";
      } else if (game.winnerId) {
        text = game.winnerId === myId ? "You won!" : "You lost.";
      } else if (game.result === "opponent_left") {
        text = game.winnerId === myId ? "Opponent left. You win!" : "You left the game.";
      }

      setResultText(text);
      setStatus(text);
      setShowResultPopup(true);

      const resultType = text.includes("won") ? "win" : text.includes("Draw") ? "draw" : "lose";
      posthog?.capture("chess_pvp_game_ended", {
        game_id: gameId,
        result: resultType,
        game_result: game.result,
        bet_amount: Number(game.betAmount),
      });

      if (text.includes("won") && !resultShownRef.current) {
        resultShownRef.current = true;
        playVictory();
        // Confetti is handled by the shared PvpResultScreen.
      } else if (text.includes("lost") && !resultShownRef.current) {
        resultShownRef.current = true;
        playDefeat();
      }

      return;
    }

    setStatus("Game active");
    if (!firstFetchDoneRef.current) {
      posthog?.capture("chess_pvp_game_started", {
        game_id: gameId,
        color,
        bet_amount: Number(game.betAmount),
        opponent: game.whitePlayerId && game.blackPlayerId ? "matched" : "waiting",
      });
    }
    firstFetchDoneRef.current = true;
  }

  // ── Realtime state sync (replaces the old 2s /api/chess/game-state poll) ───
  //
  // A move is still made through the authoritative POST /api/chess/move; the
  // row it writes to `chess_moves` is published to Supabase Realtime, so BOTH
  // players receive the move with no recurring HTTP read. Transitions a move
  // row cannot express (opponent joined, resign, draw, opponent left, clock
  // timeout) arrive as a Socket.IO room "poke" that triggers ONE authoritative
  // fetch — never a permanent poll.
  fetchStateRef.current = fetchState;

  // Coalesced, single-flight authoritative refresh. Only ever called on an
  // explicit edge (initial load, reconnect, visibility regain, a poke, or a
  // local clock hitting zero), so it can never become a polling loop.
  const scheduleRefresh = useCallback(() => {
    if (gameFinishedRef.current) return;
    if (refreshInFlightRef.current) {
      refreshQueuedRef.current = true;
      return;
    }
    refreshInFlightRef.current = true;
    Promise.resolve(fetchStateRef.current?.()).finally(() => {
      refreshInFlightRef.current = false;
      if (refreshQueuedRef.current) {
        refreshQueuedRef.current = false;
        scheduleRefresh();
      }
    });
  }, []);

  // Apply a pushed `chess_moves` INSERT to the same React state the old poll
  // updated. Duplicate deliveries of the same move are ignored by id.
  const applyRemoteMove = useCallback(
    (row) => {
      if (!row || gameFinishedRef.current) return;
      const moveId = Number(row.id);
      if (Number.isFinite(moveId) && moveId > 0) {
        if (moveId <= appliedMoveIdRef.current) return; // duplicate event
        appliedMoveIdRef.current = moveId;
      }
      const fen = row.fen_after ?? row.fenAfter;
      if (!fen) {
        // No usable payload — reconcile once with the authority.
        scheduleRefresh();
        return;
      }

      const move = {
        id: row.id,
        playedBy: row.played_by ?? row.playedBy,
        moveUci: row.move_uci ?? row.moveUci,
        moveSan: row.move_san ?? row.moveSan,
        fenAfter: fen,
        createdAt: row.created_at ?? row.createdAt,
      };

      setMoves((prev) =>
        prev.some((m) => String(m.id) === String(move.id)) ? prev : [...prev, move],
      );
      setLiveFen(fen);
      timeoutSettledRef.current = false;

      // Flip the turn and charge the mover's clock locally, mirroring the
      // server's computeClocks. The server remains the clock's authority.
      setClocks((prev) => {
        if (prev.white === null && prev.black === null) return prev;
        const now = Date.now();
        const mover = prev.activeTurn === "black" ? "black" : "white";
        const elapsed = Math.max(0, Math.floor((now - (prev.at || now)) / 1000));
        return {
          ...prev,
          [mover]: Math.max(0, Number(prev[mover] ?? 0) - elapsed),
          activeTurn: mover === "white" ? "black" : "white",
          at: now,
        };
      });
      setGameData((prev) =>
        prev
          ? {
              ...prev,
              fen,
              activeTurn: prev.activeTurn === "white" ? "black" : "white",
            }
          : prev,
      );

      // Read-only derivation from the authoritative FEN: when the move ended the
      // game, reconcile ONE authoritative fetch so the result/trophy UI reflects
      // the server's decision (the server already applied rewards on the move).
      try {
        const board = new Chess(fen);
        if (board.isGameOver()) scheduleRefresh();
      } catch {
        // ignore — a later refresh reconciles
      }
    },
    [scheduleRefresh],
  );

  // Low-latency signal for transitions the move stream cannot express. A poke
  // is a "refetch the authoritative snapshot" hint, never a state payload.
  const emitStatePoke = useCallback(() => {
    if (!socket || !gameId) return;
    socket.emit("room_event", {
      roomId: `chess:game:${gameId}`,
      event: "chess:state",
    });
  }, [socket, gameId]);

  // ONE authoritative read on load — the only game-state request this page
  // makes while Realtime is healthy.
  useEffect(() => {
    if (!gameId) return undefined;
    void fetchStateRef.current?.();
    return undefined;
  }, [gameId]);

  // Event-driven move stream. Realtime pushes the authoritative row; no poll.
  useRealtimeSubscription({
    table: "chess_moves",
    event: "INSERT",
    filter: `game_id=eq.${gameId}`,
    enabled: Boolean(gameId) && !gameFinished,
    onEvent: (payload) => applyRemoteMove(payload.new),
    onStatus: (status) => {
      if (status === "SUBSCRIBED") {
        if (realtimeRecoveryRef.current.needsRecovery) {
          realtimeRecoveryRef.current.needsRecovery = false;
          scheduleRefresh();
        }
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        // Remember the drop; the next SUBSCRIBED reconciles exactly once.
        realtimeRecoveryRef.current.needsRecovery = true;
      }
    },
  });

  // Local clock ticker — pure UI computation, no network.
  useEffect(() => {
    const id = setInterval(() => setClockNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Returning to a hidden tab may have missed events — reconcile once.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "visible" && !gameFinishedRef.current) {
        scheduleRefresh();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [scheduleRefresh]);

  // When the displayed active clock reaches zero, ONE authoritative fetch lets
  // the server settle the timeout. Guarded so it fires at most once per game.
  useEffect(() => {
    if (gameFinishedRef.current) return;
    if (!gameData || gameData.status !== "in_progress") return;
    const active = clocks.activeTurn === "black" ? "black" : "white";
    const base = active === "white" ? clocks.white : clocks.black;
    if (base === null || base === undefined) return;
    const elapsed = Math.max(0, Math.floor((clockNow - clocks.at) / 1000));
    if (base - elapsed > 0) return;
    if (timeoutSettledRef.current) return;
    timeoutSettledRef.current = true;
    scheduleRefresh();
  }, [clockNow, clocks, gameData, scheduleRefresh]);

  // Socket: game events, draw offers, and the realtime "poke" room.
  useEffect(() => {
    if (!socket) return;

    socket.emit("join_game", { gameId });

    // Emote room — dedicated per-match room so emotes work even though chess
    // is event-synced (the server's join_game is a no-op). Both players join
    // this room and the generic room_event handler broadcasts between them.
    const emoteRoomId = `chess:emote:${gameId}`;
    socket.emit("join_room", { roomId: emoteRoomId });
    const handleEmote = (payload) => {
      if (payload?.senderId && payload.senderId === color) return;
      setIncomingEmote(payload?.emote || null);
      window.setTimeout(() => setIncomingEmote(null), 3000);
    };
    socket.on("chess:emote", handleEmote);

    // State-poke room — signals the transitions the move stream cannot express
    // (opponent joined, resign, draw accepted, opponent left, clock timeout).
    // A poke triggers ONE authoritative fetch; it is not a poll.
    const stateRoomId = `chess:game:${gameId}`;
    socket.emit("join_room", { roomId: stateRoomId });
    const handleStatePoke = () => scheduleRefresh();
    socket.on("chess:state", handleStatePoke);

    // Announce our arrival ONCE so a player already waiting on this game
    // reconciles (e.g. the opponent joining turns the host's "Waiting for
    // opponent..." into an active game). This is a bare hint, never state.
    socket.emit("room_event", { roomId: stateRoomId, event: "chess:state" });

    // A socket reconnect may have missed a poke — reconcile exactly once.
    const handleConnect = () => {
      socketConnectCountRef.current += 1;
      if (socketConnectCountRef.current > 1) scheduleRefresh();
    };
    socket.on("connect", handleConnect);

    socket.on("move", scheduleRefresh);

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
      scheduleRefresh();
    });

    return () => {
      socket.emit("leave_game", { gameId });
      socket.emit("leave_room", { roomId: emoteRoomId });
      socket.emit("leave_room", { roomId: stateRoomId });
      socket.off("move", scheduleRefresh);
      socket.off("chess:state", handleStatePoke);
      socket.off("connect", handleConnect);
      socket.off("chess:emote", handleEmote);
      socket.off("draw_offered");
      socket.off("draw_declined");
      socket.off("draw_accepted");
    };
  }, [socket, gameId, scheduleRefresh, color]);

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
        gameId: gameId,
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

  // Handle promotion piece selection from the react-chessboard dialog.
  //
  // react-chessboard v4 calls `onPromotionPieceSelect(piece, from, to)` — the
  // CHOSEN piece FIRST ("wQ"/"bN"), then the two squares (see PromotionOption
  // in react-chessboard/dist). This handler used to read the squares first, so
  // `sourceSquare` was handed the piece string, `Chess.move()` threw on that
  // bogus square and the whole selection blew up inside the click — which is
  // why choosing a piece did nothing at all.
  async function onPromotionPieceCheck(piece, promoteFromSquare, promoteToSquare) {
    // The dialog's backdrop click calls this with no arguments: never a move.
    if (!promoteFromSquare || !promoteToSquare) return false;
    const sourceSquare = promoteFromSquare;
    const targetSquare = promoteToSquare;
    if (isSpectator) return false;
    if (moveIndex >= 0) return false;

    // If it's not our turn, queue as pre-move
    if (!gameData || gameData.activeTurn !== (color === "white" ? "white" : "black")) {
      if (gameData?.status !== "in_progress") return false;
      const promo = piece ? piece[1]?.toLowerCase() : "q";
      const localGame = new Chess(displayFen);
      // chess.js v1 THROWS on an illegal move (it does not return null), so a
      // stale board must read as "not promoted" rather than escape the click.
      let localMove = null;
      try {
        localMove = localGame.move({ from: sourceSquare, to: targetSquare, promotion: promo });
      } catch {
        return false;
      }
      localGame.undo();
      if (!localMove) return false;
      // The pre-move is queued HERE, with the piece the player actually chose.
      // react-chessboard calls onDrop right after this handler, and that path
      // queues its own pre-move with promotion "q" — so the guard must be set
      // too, or a knight promotion would silently become a queen.
      promotionHandledRef.current = true;
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
    // chess.js v1 THROWS on an illegal move (it does not return null), so a
    // stale board must read as "not promoted" rather than escape the click.
    let localMove = null;
    try {
      localMove = localGame.move({ from: sourceSquare, to: targetSquare, promotion: promo });
    } catch {
      return false;
    }
    if (!localMove) return false;

    const isCapture = localMove.captured !== undefined;

    setLoading(true);

    const res = await fetch("/api/chess/move", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        gameId: gameId,
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
          gameId: gameId,
          result: "loss",
        }),
      });

      if (!res.ok) {
        setStatus("Failed to resign.");
        return;
      }

      // Tell the opponent to reconcile their authoritative state now.
      emitStatePoke();
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
        gameId: gameId,
        result: "draw",
      }),
    }).then(() => {
      socket?.emit("draw_accepted", { gameId });
      emitStatePoke();
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

  // Local, ticking clocks seeded by the authoritative snapshot and advanced by
  // the 1s ticker / each move event. Pure UI computation — the server remains
  // the authority for timeouts (settled by the one-shot fetch above).
  const remainingClock = (colorKey) => {
    const base = colorKey === "white" ? clocks.white : clocks.black;
    if (base === null || base === undefined) {
      return colorKey === "white"
        ? gameData?.whiteTimeRemaining
        : gameData?.blackTimeRemaining;
    }
    const running =
      clocks.activeTurn === colorKey &&
      gameData?.status === "in_progress" &&
      !gameFinishedRef.current;
    if (!running) return base;
    const elapsed = Math.max(0, Math.floor((clockNow - clocks.at) / 1000));
    return Math.max(0, base - elapsed);
  };

  const myClock = remainingClock(activeColor === "white" ? "white" : "black");
  const oppClock = remainingClock(activeColor === "white" ? "black" : "white");

  const myCaptured = activeColor === "white" ? capturedPieces.white : capturedPieces.black;
  const oppCaptured = activeColor === "white" ? capturedPieces.black : capturedPieces.white;


  /* Match header — title, game id and who you are playing as. */
  const headerNode = (
    <><div className="text-center mb-8">
          <h1 className="text-3xl font-black tracking-widest text-cyan-400 drop-shadow-[0_0_20px_#00ffff]">
            CHESS ARENA
          </h1>

          <p className="text-white/70 mt-3">
            Game #{gameId} •{" "}
            {isSpectator ? "Spectating" : `Playing as ${color}`}
          </p>
        </div>
    </>
  );
  const boardNode = (
    <><div className="w-full max-w-[660px]">
              {/* OPPONENT */}
              <div className="relative mb-3 rounded-xl border border-cyan-400/30 bg-cyan-500/10 px-4 py-3 flex justify-between items-center backdrop-blur-md">
                <div className="flex items-center gap-2">
                  <span className="relative font-bold text-cyan-300">
                    {opponentName || "Opponent"}
                    {incomingEmote && (
                      <span className="absolute bottom-full left-0 mb-1 whitespace-nowrap rounded-xl rounded-bl-sm border border-fuchsia-300/60 bg-[#071531] px-2 py-1 text-base shadow-[0_0_18px_rgba(255,60,172,.35)]">
                        <EmoteArtwork emote={incomingEmote} imageClassName="h-7 w-7" />
                      </span>
                    )}
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
              <div className={`chess-board-frame relative p-[2px] rounded-2xl bg-gradient-to-r from-cyan-400 via-fuchsia-500 to-cyan-400 shadow-[0_0_35px rgba(0,255,255,0.35)] w-full aspect-square mx-auto ${boardShake ? "animate-board-shake" : ""}`}>
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
              <div className="relative mt-3 rounded-xl border border-fuchsia-400/30 bg-fuchsia-500/10 px-4 py-3 flex justify-between items-center backdrop-blur-md">
                <div className="flex items-center gap-2">
                  <span className="relative font-bold text-fuchsia-300">
                    {myName || "You"}
                    {myEmote && (
                      <span className="absolute bottom-full left-0 mb-1 whitespace-nowrap rounded-xl rounded-bl-sm border border-cyan-300/60 bg-[#071531] px-2 py-1 text-base shadow-[0_0_18px_rgba(0,229,255,.35)]">
                        <EmoteArtwork emote={myEmote} imageClassName="h-7 w-7" />
                      </span>
                    )}
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
    </>
  );
  const sidebarNode = (
    <><div className="rounded-2xl border border-white/10 bg-white/5 p-5 backdrop-blur-xl">
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

                {/* Emotes */}
                <div className="mt-3 flex justify-center">
                  <EmotePicker
                    compact
                    hideBubbles
                    incomingEmote={incomingEmote}
                    myEmote={myEmote}
                    onSend={(emote) => {
                      setMyEmote(emote);
                      socket?.emit("room_event", {
                        roomId: `chess:emote:${gameId}`,
                        event: "chess:emote",
                        payload: { emote, senderId: color },
                      });
                      window.setTimeout(() => setMyEmote(null), 3000);
                    }}
                  />
                </div>

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
    </>
  );
  // ── Result screen — shared PvpResultScreen (UX plan P3-3) ───────
  // Rendered when the match finishes (game status finished/expired —
  // gated by the same `showResultPopup` flag the old popup used).
  // Every value comes from the real game row (winnerId / result) —
  // nothing is invented, and no token/stake figure is ever shown.
  // Winner logic is untouched; the old bespoke "MATCH FINISHED" popup is
  // deleted.
  function renderResult() {
    if (!showResultPopup || !gameData) return null;

    const myId =
      color === "white" ? gameData.whitePlayerId : gameData.blackPlayerId;
    const iWon = Boolean(gameData.winnerId) && gameData.winnerId === myId;
    const isDraw = gameData.result === "draw";
    const outcome = isDraw ? "draw" : iWon ? "win" : "loss";

    const oppName =
      color === "white"
        ? gameData.blackPlayerName || "Opponent"
        : gameData.whitePlayerName || "Opponent";

    const headline =
      resultText ||
      (isDraw ? "Game drawn" : iWon ? "You win!" : "You lost.");

    // The extra action opens this match's engine-backed evaluation at
    // /evaluation/chess/[gameId]. It is offered ONLY for a genuinely finished
    // match: an `expired` game cannot be evaluated (the API answers 409), so
    // the button never sends the player to a guaranteed dead end.
    return (
      <PvpResultScreen
        open
        compact
        outcome={outcome}
        headline={headline}
        gameName="Chess Arena"
        opponent={{ name: oppName }}
        summary={[
          {
            label: "Result",
            value: outcome === "win" ? "Win" : outcome === "loss" ? "Loss" : "Draw",
          },
        ]}
        details={[
          { label: "Game ID", value: String(gameId) },
          { label: "Winner", value: isDraw ? "Draw" : iWon ? "You" : oppName },
        ]}
        secondaryAction={
          gameData.status === "finished"
            ? { label: "See Evaluation", href: `/evaluation/chess/${gameId}` }
            : null
        }
        playAgain={{ label: "RUN IT BACK", onClick: () => router.push("/casino/chess") }}
        onReturnToLobby={() => router.push("/casino")}
        onDismiss={() => setShowResultPopup(false)}
        dismissLabel="View Match Results"
      />
    );
  }

  const desktopContent = (
    <>
      <div className="max-w-7xl mx-auto">
        {headerNode}
        <div className="grid lg:grid-cols-[1fr_340px] gap-8 items-start">
          <div className="flex justify-center">
            {boardNode}
          </div>
          {sidebarNode}
        </div>
      </div>
    </>
  );

  return (
    <>
      {/* Unified full-screen waiting takeover — no opponent seated yet */}
      {gameData && !gameData.blackPlayerId && (
        <MatchWaiting
          state="waiting"
          gameName="Chess Arena"
          subtitle={`Game #${gameId} · Waiting for an opponent to join…`}
          seats={[
            {
              label: "You",
              name: color === "white" ? "White" : "Black",
              occupied: true,
            },
            { label: "Opponent", occupied: false },
          ]}
        />
      )}

      {/* Turn Banner.
          framer-motion owns `transform` on the banner (it animates `y` and
          `scale`), so Tailwind's `-translate-x-1/2` was overwritten the moment
          the spring settled: it drew a half-width right of centre and was
          clipped off the right edge below ~350px. `inset-x-0 mx-auto w-fit`
          centres it without a transform. */}
      <AnimatePresence>
        {turnBanner && (
          <motion.div
            key="turn-banner"
            {...turnBannerAnim}
            className="fixed inset-x-0 top-1/3 z-50 mx-auto w-fit max-w-[calc(100vw-1.5rem)] rounded-2xl border-4 border-amber-400 bg-gradient-to-r from-amber-700 to-orange-700 px-6 py-5 shadow-[0_0_60px_rgba(251,191,36,0.5)] sm:px-10 sm:py-6"
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

      {/* Check Banner — same centring constraint as the turn banner. */}
      <AnimatePresence>
        {isInCheck && !gameData?.status?.match(/finished|expired/) && (
          <motion.div
            key="check-banner"
            initial={{ opacity: 0, y: -30 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -30 }}
            className="fixed inset-x-0 top-24 z-40 mx-auto w-fit max-w-[calc(100vw-1.5rem)] rounded-xl border-2 border-red-500 bg-red-900/80 px-6 py-2 shadow-[0_0_24px_rgba(255,0,0,0.4)]"
          >
            <span className="inline-flex items-center gap-2 text-lg font-bold text-red-300 tracking-wider"><IconAlertTriangle size={20} /> CHECK!</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Draw offer notification — `scale`-animated, so centred by margin. */}
      <AnimatePresence>
        {drawOfferReceived && (
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9 }}
            className="fixed inset-x-0 top-1/3 z-50 mx-auto w-fit max-w-[calc(100vw-1.5rem)] rounded-2xl border-2 border-yellow-400 bg-[#1a1a0d] p-6 shadow-[0_0_30px_rgba(250,204,21,0.3)]"
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
        <GameSessionHost
        autoStart={Boolean(gameData && gameData.status === "in_progress")}
        autoStop={Boolean(gameData && (gameData.status === "finished" || gameData.status === "expired"))}
        gameLabel="chess"
        // A spectator watching a shared link is on a live match too, so
        // watching must never be counted as playing.
        presenceEnabled={!isSpectator}
      >
        {desktopContent}

        {/* Post-match result screen — shared PvpResultScreen (UX plan
            P3-3). Mounted INSIDE GameSessionHost so it appears in the
            recording; compact styling keeps it sized for the phone frame. */}
        {renderResult()}
      </GameSessionHost>
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

      
    </div>
    </>
  );
}
