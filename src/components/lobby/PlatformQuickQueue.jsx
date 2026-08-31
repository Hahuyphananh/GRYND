"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSocket } from "../../context/SocketProvider";
import { useRouter } from "next/navigation";
import { QuickQueueStatus } from "./QuickQueueStatus";

export const QUICK_QUEUE_GAME_OPTIONS = [
  ["keno-pvp", "Keno"],
  ["mines-pvp", "Mines"],
  ["plinko-pvp", "Plinko"],
  ["blackjack-pvp", "Blackjack"],
  ["roulette-pvp", "Roulette"],
  ["lane-rush-duel", "Lane Rush"],
  ["four-in-a-row", "Four-In-A-Row"],
  ["memory-grid", "Memory Grid"],
  ["dots-and-boxes", "Dots & Boxes"],
  ["rps-pvp", "RPS"],
  ["uno", "UNO"],
  ["tower-arena", "Tower Arena"],
  ["pool-masters", "Pool Masters"],
  ["precision", "Precision"],
  ["hex-duel", "Hex Duel"],
  ["chess", "Chess"],
  ["dice-flush", "Dice Flush"],
  ["crash-arena", "Crash Arena"],
];

const EMPTY_READINESS_BODY = Object.freeze({});

const GAME_ROUTES = {
  "keno-pvp": "/casino/keno-pvp",
  "mines-pvp": "/casino/mines-pvp",
  "plinko-pvp": "/casino/plinko",
  "blackjack-pvp": "/casino/blackjack",
  "roulette-pvp": "/casino/roulette",
  "lane-rush-duel": "/casino/lane-runner",
  "four-in-a-row": "/casino/four-in-a-row/game",
  "memory-grid": "/casino/memory-grid",
  "dots-and-boxes": "/casino/dots-and-boxes/game",
  "rps-pvp": "/casino/rps/game",
  "uno": "/casino/uno",
  "tower-arena": "/casino/tower-arena/game",
  "pool-masters": "/casino/pool-masters/game",
  "precision": "/casino/precision/game",
  "hex-duel": "/casino/hex-duel/game",
  "chess": "/casino/chess-game",
  "dice-flush": "/casino/dice-flush",
  "crash-arena": "/casino/crash-arena/table",
};

export function quickQueueGameRoute(gameKey, matchId) {
  const base = GAME_ROUTES[gameKey];
  const destination = typeof matchId === "string" || typeof matchId === "number" ? String(matchId).trim() : "";
  return base && destination ? `${base}/${encodeURIComponent(destination)}` : null;
}

export function usePlatformQuickQueue(options = {}) {
  const { readinessBody } = options;
  const stableReadinessBody = readinessBody && typeof readinessBody === "object" ? readinessBody : EMPTY_READINESS_BODY;
  const preferredGamesFromOptions = stableReadinessBody.preferredGames;
  const preferredGamesKey = Array.isArray(preferredGamesFromOptions)
    ? preferredGamesFromOptions.join("\u0001")
    : "";
  const defaultPreferredGames = useRef(QUICK_QUEUE_GAME_OPTIONS.map(([key]) => key)).current;
  const [preferredGames, setPreferredGames] = useState(
    Array.isArray(preferredGamesFromOptions) ? preferredGamesFromOptions : defaultPreferredGames,
  );
  const previousPreferredGamesKey = useRef(preferredGamesKey);
  useEffect(() => {
    if (previousPreferredGamesKey.current === preferredGamesKey) return;
    previousPreferredGamesKey.current = preferredGamesKey;
    setPreferredGames(
      Array.isArray(preferredGamesFromOptions) ? preferredGamesFromOptions : defaultPreferredGames,
    );
  }, [defaultPreferredGames, preferredGamesFromOptions, preferredGamesKey]);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notification, setNotification] = useState(null);
  const [statusRefreshKey, setStatusRefreshKey] = useState(0);
  const { socket, userId } = useSocket();
  const router = useRouter();

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/quick-queue/readiness", { cache: "no-store", credentials: "include" });
      if (!response.ok) return;
      const data = await response.json();
      if (data?.success) setReady(Boolean(data.ready));
    } catch {
      // The toggle remains usable; the next refresh retries.
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!socket) return;
    const handleAssignment = (payload) => {
      setNotification({ type: "assignment", message: "A compatible game is ready.", payload });
      setReady(false);
      setStatusRefreshKey((key) => key + 1);
      const route = quickQueueGameRoute(
        payload?.gameKey || payload?.game_key,
        payload?.destinationMatchId || payload?.destination_match_id || payload?.matchId || payload?.match_id,
      );
      if (route) router.push(route);
      refresh();
    };
    const handleAvailability = (payload) => {
      setNotification({ type: "availability", message: payload?.notification || "A compatible game is available.", payload });
    };
    if (!userId) return;
    const roomId = `quick-queue:user:${userId}`;
    socket.emit("join_room", { roomId });
    socket.on("quick_queue:ready", handleAssignment);
    socket.on("quick-queue:availability", handleAvailability);
    return () => {
      socket.emit("leave_room", { roomId });
      socket.off("quick_queue:ready", handleAssignment);
      socket.off("quick-queue:availability", handleAvailability);
    };
  }, [socket, userId, refresh, router]);

  const toggleGame = useCallback((gameKey) => {
    setPreferredGames((current) => current.includes(gameKey)
      ? current.filter((key) => key !== gameKey)
      : [...current, gameKey]);
  }, []);

  const toggle = useCallback(async () => {
    if (preferredGames.length === 0) {
      setError("Select at least one game for Quick Queue.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/quick-queue/readiness", {
        method: ready ? "DELETE" : "POST",
        credentials: "include",
        headers: ready ? undefined : { "Content-Type": "application/json" },
        body: ready ? undefined : JSON.stringify({ ...stableReadinessBody, preferredGames }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.success) {
        setError(data?.error || "Unable to update Quick Queue readiness");
        return;
      }
      setReady(Boolean(data.ready));
    } catch {
      setError("Unable to update Quick Queue readiness");
    } finally {
      setBusy(false);
    }
  }, [ready, stableReadinessBody, preferredGames]);

  const preferences = (
    <div className="mt-3">
      <p className="mb-2 text-xs text-cyan-100/70">Monitoring {preferredGames.length} selected game{preferredGames.length === 1 ? "" : "s"}: {preferredGames.length > 0 ? QUICK_QUEUE_GAME_OPTIONS.filter(([key]) => preferredGames.includes(key)).map(([, label]) => label).join(", ") : "none"}</p>
      <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-white/50">Games to include</p>
      <div className="flex flex-wrap gap-1.5">
        {QUICK_QUEUE_GAME_OPTIONS.map(([key, label]) => {
          const selected = preferredGames.includes(key);
          return <button key={key} type="button" aria-pressed={selected} onClick={() => toggleGame(key)} className={`rounded-full border px-2.5 py-1 text-[11px] font-bold transition ${selected ? "border-cyan-400 bg-cyan-500/20 text-cyan-200" : "border-gray-600 bg-gray-800/50 text-gray-400"}`}>{label}</button>;
        })}
      </div>
    </div>
  );

  return { ready, busy, error, notification, preferences: <><QuickQueueStatus refreshKey={statusRefreshKey} />{preferences}</>, emptySelection: preferredGames.length === 0, onToggle: toggle };
}
