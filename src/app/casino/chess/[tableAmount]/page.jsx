"use client";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

export default function MatchmakingPage() {
  const { tableAmount } = useParams();
  const searchParams = useSearchParams();
  const router = useRouter();

  const precreatedGameId = Number(searchParams.get("gameId"));
  const presetColor = searchParams.get("color") || "white";
  const timerMode = searchParams.get("timer") || "blitz";

  const [statusText, setStatusText] = useState("Creating game...");
  const [gameId, setGameId] = useState(
    Number.isFinite(precreatedGameId) && precreatedGameId > 0
      ? precreatedGameId
      : null,
  );
  const [color, setColor] = useState(presetColor);
  const [isCanceling, setIsCanceling] = useState(false);
  const pollFailuresRef = useRef(0);

  useEffect(() => {
    let pollId;

    const beginPolling = (activeGameId, activeColor) => {
      setStatusText("Waiting for opponent...");
      pollId = setInterval(async () => {
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
              clearInterval(pollId);
            }
            return;
          }

          pollFailuresRef.current = 0;

          if (
            pollData.data.status === "in_progress" &&
            pollData.data.blackPlayerId
          ) {
            clearInterval(pollId);
            router.push(
              `/casino/chess-game/${activeGameId}?color=${activeColor}&timer=${pollData.data.timerMode || timerMode}`,
            );
          }
        } catch {
          const nextFailures = pollFailuresRef.current + 1;
          pollFailuresRef.current = nextFailures;

          if (nextFailures >= 3) {
            setStatusText("Unable to refresh waiting room. Please retry.");
            clearInterval(pollId);
          }
        }
      }, 2000);
    };

    const createOrJoin = async () => {
      if (gameId) {
        beginPolling(gameId, color);
        return;
      }

      try {
        const res = await fetch("/api/chess/create-game", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ tableAmount: Number(tableAmount), timerMode }),
        });

        const data = await res.json();
        if (!res.ok) {
          setStatusText(data.error || "Unable to create game");
          return;
        }

        setGameId(data.gameId);
        setColor(data.color || "white");

        if (data.ready || data.status === "in_progress") {
          router.push(
            `/casino/chess-game/${data.gameId}?color=${data.color}&timer=${data.timerMode || timerMode}`,
          );
          return;
        }

        beginPolling(data.gameId, data.color || "white");
      } catch (error) {
        console.error("Failed to create or join chess game", error);
        setStatusText("Unable to create game");
      }
    };

    createOrJoin();

    return () => {
      if (pollId) clearInterval(pollId);
    };
  }, [tableAmount, router, gameId, color, timerMode]);

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
