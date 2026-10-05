"use client";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSocket } from "../../../../context/SocketProvider";
import MatchWaiting from "../../../../components/lobby/MatchWaiting";

const TIMER_OPTIONS = [
  { id: "1min", label: "1 Min", time: 60 },
  { id: "2min", label: "2 Min", time: 120 },
  { id: "3min", label: "3 Min", time: 180 },
  { id: "5min", label: "5 Min", time: 300 },
  { id: "10min", label: "10 Min", time: 600 },
  { id: "30min", label: "30 Min", time: 1800 },
  // Legacy numeric handlers for backward compatibility
];

function resolveTimerMode(rawTimer) {
  // If it's a valid timer key already, use it
  const knownKey = TIMER_OPTIONS.find((t) => t.id === rawTimer);
  if (knownKey) return { mode: knownKey.id, seconds: knownKey.time };

  // If it's a numeric value (seconds), find the matching timer
  const num = Number(rawTimer);
  if (Number.isFinite(num) && num > 0) {
    const match = TIMER_OPTIONS.find((t) => t.time === num);
    if (match) return { mode: match.id, seconds: match.time };
  }

  // Fallback to blitz
  return { mode: "5min", seconds: 300 };
}

export default function MatchmakingPage() {
  const { tableAmount } = useParams();
  const searchParams = useSearchParams();
  const router = useRouter();
  const { socket } = useSocket();

  const precreatedGameId = (searchParams.get("gameId") || "").trim();
  const presetColor = searchParams.get("color") || "white";
  const rawTimer = searchParams.get("timer") || "5min";
  const resolvedTimer = resolveTimerMode(rawTimer);
  const timerMode = resolvedTimer.mode;
  const timerSeconds = resolvedTimer.seconds;

  const [statusText, setStatusText] = useState("Creating game...");
  const [gameId, setGameId] = useState(precreatedGameId || null);
  const [color, setColor] = useState(presetColor);
  const [isCanceling, setIsCanceling] = useState(false);
  const pollFailuresRef = useRef(0);
  const isCreatingRef = useRef(false);
  // The game this page is waiting on, kept in a ref so the socket listeners can
  // stay bound once (the effect never re-runs on a state change).
  const activeGameRef = useRef({ gameId: null, color: "white" });
  // Single-flight + coalescing guards for the edge-triggered authoritative read.
  const checkingRef = useRef(false);
  const queuedRef = useRef(false);
  // Stable handle to the latest checker so listeners never re-bind.
  const checkForOpponentRef = useRef(null);

  // ONE authoritative read of the waiting game. Called only on an explicit edge
  // — mount, a `lobby:updated` push (the opponent joined via the lobby emits
  // this), or a socket reconnect — so it can never become a polling loop.
  const checkForOpponent = useCallback(async () => {
    const { gameId: activeGameId, color: activeColor } = activeGameRef.current;
    if (!activeGameId) return;
    if (checkingRef.current) {
      queuedRef.current = true;
      return;
    }
    checkingRef.current = true;
    try {
      const pollRes = await fetch(
        `/api/chess/game-state?gameId=${activeGameId}`,
        { cache: "no-store", credentials: "include" },
      );
      const pollData = await pollRes.json();
      if (!pollRes.ok) {
        const nextFailures = pollFailuresRef.current + 1;
        pollFailuresRef.current = nextFailures;

        if (nextFailures >= 3) {
          setStatusText(
            pollData?.error ||
              "Unable to refresh waiting room. Please retry.",
          );
        }
        return;
      }

      pollFailuresRef.current = 0;

      if (
        pollData.data.status === "in_progress" &&
        pollData.data.blackPlayerId
      ) {
        router.push(
          `/casino/chess-game/${activeGameId}?color=${activeColor}&timer=${timerSeconds}`,
        );
      }
    } catch {
      const nextFailures = pollFailuresRef.current + 1;
      pollFailuresRef.current = nextFailures;

      if (nextFailures >= 3) {
        setStatusText("Unable to refresh waiting room. Please retry.");
      }
    } finally {
      checkingRef.current = false;
      if (queuedRef.current) {
        queuedRef.current = false;
        checkForOpponentRef.current?.();
      }
    }
  }, [router, timerSeconds]);

  checkForOpponentRef.current = checkForOpponent;

  useEffect(() => {
    let cancelled = false;

    const beginWaiting = (activeGameId, activeColor) => {
      activeGameRef.current = { gameId: activeGameId, color: activeColor };
      pollFailuresRef.current = 0;
      setStatusText("Waiting for opponent...");
      void checkForOpponentRef.current?.();
    };

    const createOrJoin = async () => {
      // If we already have a gameId from the URL, just wait on it
      if (gameId) {
        beginWaiting(gameId, color);
        return;
      }

      // Prevent duplicate create calls
      if (isCreatingRef.current) return;
      isCreatingRef.current = true;

      try {
        const res = await fetch("/api/chess/create-game", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            tableAmount: Number(tableAmount),
            timerMode,
            timeLimit: timerSeconds,
          }),
        });

        const data = await res.json();
        if (!res.ok) {
          setStatusText(data.error || "Unable to create game");
          return;
        }

        if (cancelled) return;

        // Set state for UI display (effect won't re-run with [] deps)
        setGameId(data.gameId);
        setColor(data.color || "white");

        if (data.ready || data.status === "in_progress") {
          router.push(
            `/casino/chess-game/${data.gameId}?color=${data.color}&timer=${timerSeconds}`,
          );
          return;
        }

        // Start waiting with the new game directly — don't trigger state change
        beginWaiting(data.gameId, data.color || "white");
      } catch (error) {
        console.error("Failed to create or join chess game", error);
        setStatusText("Unable to create game");
      }
    };

    createOrJoin();

    return () => {
      cancelled = true;
    };
  }, []); // Only run once on mount — stable closure over gameId from URL params

  // Matchmaking push path. The opponent joining from the lobby emits a bare
  // `lobby:updated` hint on `lobby:chess`; that hint triggers ONE authoritative
  // game-state read above. A reconnect re-joins the room and reconciles once.
  useEffect(() => {
    if (!socket) return undefined;
    const roomId = "lobby:chess";

    const joinRoom = () => socket.emit("join_room", { roomId });
    joinRoom();

    const handleLobbyUpdate = () => {
      void checkForOpponentRef.current?.();
    };

    const handleConnect = () => {
      joinRoom();
      void checkForOpponentRef.current?.();
    };

    socket.on("connect", handleConnect);
    socket.on("lobby:updated", handleLobbyUpdate);

    return () => {
      socket.emit("leave_room", { roomId });
      socket.off("connect", handleConnect);
      socket.off("lobby:updated", handleLobbyUpdate);
    };
  }, [socket]);

  async function cancelWaitingGame() {
    if (!gameId) return;

    setIsCanceling(true);
    try {
      const res = await fetch("/api/chess/cancel-game", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ gameId }),
      });
      const data = await res.json();

      if (!res.ok || !data.success) {
        setStatusText(data.error || "Unable to cancel game");
        return;
      }

      router.push("/casino/chess");
    } catch (error) {
      console.error("Failed to cancel chess game", error);
      setStatusText("Unable to cancel game");
    } finally {
      setIsCanceling(false);
    }
  }

  const showCancel =
    statusText === "Waiting for opponent..." && gameId && color === "white";

  return (
    <>
      {/* Unified full-screen waiting takeover */}
      {statusText === "Waiting for opponent..." && (
        <MatchWaiting
          state="waiting"
          gameName="Chess"
          subtitle={`Stake: $${tableAmount} · ${timerMode}`}
          seats={[
            {
              label: "You",
              name: color === "white" ? "White" : "Black",
              occupied: true,
            },
            { label: "Opponent", occupied: false },
          ]}
          onCancel={showCancel ? cancelWaitingGame : null}
          cancelLabel="Cancel & Return to Lobby"
          cancelling={isCanceling}
        />
      )}

      <div className="min-h-screen bg-[#030817] text-white flex items-center justify-center">
      <div className="text-center">
        <h2 className="text-3xl font-bold text-[#FFD700] mb-4">{statusText}</h2>
        <p className="mb-2">Stake: ${tableAmount}</p>
        <p className="mb-2">Timer: {timerMode}</p>
        {gameId && (
          <p className="text-sm opacity-80 mb-5">
            Game #{gameId} · You are {color}
          </p>
        )}

        {showCancel && (
          <button
            onClick={cancelWaitingGame}
            disabled={isCanceling}
            className="bg-red-600 hover:bg-red-700 disabled:bg-red-900 disabled:cursor-not-allowed px-5 py-2 rounded-lg font-semibold"
          >
            {isCanceling ? "Canceling..." : "Cancel & Return to Lobby"}
          </button>
        )}
      </div>
      </div>
    </>
  );
}
