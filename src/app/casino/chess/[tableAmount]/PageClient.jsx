"use client";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

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

  const precreatedGameId = Number(searchParams.get("gameId"));
  const presetColor = searchParams.get("color") || "white";
  const rawTimer = searchParams.get("timer") || "5min";
  const resolvedTimer = resolveTimerMode(rawTimer);
  const timerMode = resolvedTimer.mode;
  const timerSeconds = resolvedTimer.seconds;

  const [statusText, setStatusText] = useState("Creating game...");
  const [gameId, setGameId] = useState(
    Number.isFinite(precreatedGameId) && precreatedGameId > 0
      ? precreatedGameId
      : null,
  );
  const [color, setColor] = useState(presetColor);
  const [isCanceling, setIsCanceling] = useState(false);
  const pollFailuresRef = useRef(0);
  const pollIntervalRef = useRef(null);
  const isCreatingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    const beginPolling = (activeGameId, activeColor) => {
      // Clear any existing poll interval first
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }

      setStatusText("Waiting for opponent...");
      pollIntervalRef.current = setInterval(async () => {
        if (cancelled) return;
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
              if (pollIntervalRef.current) {
                clearInterval(pollIntervalRef.current);
                pollIntervalRef.current = null;
              }
            }
            return;
          }

          pollFailuresRef.current = 0;

          if (
            pollData.data.status === "in_progress" &&
            pollData.data.blackPlayerId
          ) {
            if (pollIntervalRef.current) {
              clearInterval(pollIntervalRef.current);
              pollIntervalRef.current = null;
            }
            router.push(
              `/casino/chess-game/${activeGameId}?color=${activeColor}&timer=${timerSeconds}`,
            );
          }
        } catch {
          const nextFailures = pollFailuresRef.current + 1;
          pollFailuresRef.current = nextFailures;

          if (nextFailures >= 3) {
            setStatusText("Unable to refresh waiting room. Please retry.");
            if (pollIntervalRef.current) {
              clearInterval(pollIntervalRef.current);
              pollIntervalRef.current = null;
            }
          }
        }
      }, 2000);
    };

    const createOrJoin = async () => {
      // If we already have a gameId from the URL, just poll it
      if (gameId) {
        beginPolling(gameId, color);
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

        // Start polling with the new game directly — don't trigger state change
        beginPolling(data.gameId, data.color || "white");
      } catch (error) {
        console.error("Failed to create or join chess game", error);
        setStatusText("Unable to create game");
      }
    };

    createOrJoin();

    return () => {
      cancelled = true;
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    };
  }, []); // Only run once on mount — stable closure over gameId from URL params

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
  );
}
