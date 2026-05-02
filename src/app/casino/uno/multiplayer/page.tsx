"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import UnoCard from "../../../../components/UnoCard";
import UnoBack from "../../../../components/UnoBack";
import NavigationBar from "../../../../components/navigation-bar";
import { useSocket } from "../../../../context/SocketProvider";
import useGamePresence from "../../../../hooks/useGamePresence";

const UNO_MULTI_SEAT_POSITIONS = [
  { left: "50%", top: "15%" },
  { left: "78%", top: "30%" },
  { left: "78%", top: "68%" },
  { left: "50%", top: "84%" },
  { left: "22%", top: "68%" },
  { left: "22%", top: "30%" },
];

export default function UnoMultiplayerPage() {
  const router = useRouter();
  const { socket } = useSocket();
  const roomSyncRef = useRef<NodeJS.Timeout | null>(null);

  const [game, setGame] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [tokens, setTokens] = useState<{ balance: number } | null>(null);
  const [unoMultiSettings, setUnoMultiSettings] = useState({
    gameName: "UNO Table",
    visibility: "private",
    betAmount: 100,
    maxPlayers: 4,
    startingCards: 7,
    turnTimeSeconds: 30,
  });
  const [unoMultiTableCode, setUnoMultiTableCode] = useState("");
  const [unoMultiPublicGames, setUnoMultiPublicGames] = useState<any[]>([]);
  const [unoMultiPlayers, setUnoMultiPlayers] = useState<any[]>([]);
  const [unoMultiHostId, setUnoMultiHostId] = useState<number | null>(null);
  const [unoMultiMyId, setUnoMultiMyId] = useState<number | null>(null);
  const [unoMultiStarted, setUnoMultiStarted] = useState(false);
  const [unoMultiMessage, setUnoMultiMessage] = useState("");
  const [unoMultiJoinCode, setUnoMultiJoinCode] = useState("");
  const [unoMultiSkipRound, setUnoMultiSkipRound] = useState(false);
  const [unoMultiBackendMode, setUnoMultiBackendMode] = useState<string | null>(null);
  const [unoMultiHandCounts, setUnoMultiHandCounts] = useState<any[]>([]);
  const [unoMultiTurnPlayerId, setUnoMultiTurnPlayerId] = useState<any>(null);
  const [showSeatPopup, setShowSeatPopup] = useState(false);

  const [playerHand, setPlayerHand] = useState<any[]>([]);
  const [topCard, setTopCard] = useState<any>(null);
  const [turnHistory, setTurnHistory] = useState<any[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [isPlayerTurn, setIsPlayerTurn] = useState(false);
  const [message, setMessage] = useState("");

  const [showColorPicker, setShowColorPicker] = useState(false);
  const [pendingCard, setPendingCard] = useState<any>(null);
  const [selectedSeat, setSelectedSeat] = useState<number | null>(null);

  useGamePresence({ gameKey: "uno", gameId: Number(game?.id), enabled: Boolean(game?.id) });

  useEffect(() => {
    const fetchTokens = async () => {
      try {
        const res = await fetch("/api/get-user-tokens", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
        });
        const data = await res.json();
        if (data.success) setTokens({ balance: Number(data.data.balance) });
      } catch (error) {
        console.error("Unable to load tokens", error);
      }
    };
    fetchTokens();
  }, []);

  const fetchUnoMultiplayerPublicGames = async () => {
    try {
      const res = await fetch("/api/uno/multiplayer", { method: "GET", credentials: "include" });
      const data = await res.json();
      setUnoMultiPublicGames(data.success ? data.rooms || [] : []);
    } catch (error) {
      console.error("Unable to fetch UNO multiplayer public games", error);
      setUnoMultiPublicGames([]);
    }
  };

  useEffect(() => {
    fetchUnoMultiplayerPublicGames();
  }, []);

  useEffect(() => {
    if (!socket) return;
    const roomId = "lobby:uno";
    const handleLobbyUpdate = () => fetchUnoMultiplayerPublicGames();
    socket.emit("join_room", { roomId });
    socket.on("lobby:updated", handleLobbyUpdate);

    return () => {
      socket.emit("leave_room", { roomId });
      socket.off("lobby:updated", handleLobbyUpdate);
    };
  }, [socket]);

  const hydrateUnoTableGame = (tableGame: any) => {
    if (!tableGame?.id) return;
    setGame({ id: tableGame.id, role: tableGame.role });
    setUnoMultiBackendMode(tableGame.mode || "table");
    setUnoMultiStarted(true);
    setTopCard(tableGame.topCard || null);
    setGame((prev: any) => ({
  ...prev,
  currentColor: tableGame.currentColor,
}));
    setUnoMultiHandCounts(Array.isArray(tableGame.handCounts) ? tableGame.handCounts : []);
    setUnoMultiTurnPlayerId(tableGame.turnPlayerId || null);
    setTurnHistory(tableGame.topCard ? [tableGame.topCard] : []);
    setHistoryIndex(null);
    setPlayerHand(Array.isArray(tableGame.playerHand) ? tableGame.playerHand : []);
    const myTurn = tableGame.turnPlayerId === tableGame.role;
    setIsPlayerTurn(Boolean(myTurn));
    setMessage(myTurn ? "Your turn" : "Opponent turn...");
  };

  useEffect(() => {
    if (!unoMultiTableCode) return;
    roomSyncRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/uno/multiplayer?code=${unoMultiTableCode}`, {
          method: "GET",
          credentials: "include",
        });
        const data = await res.json();
        if (!data.success) {
   setUnoMultiMessage(data.error || "Unable to sync room");
   return;
}

        setUnoMultiPlayers(data.room.players || []);
        setUnoMultiSettings((prev) => ({ ...prev, ...(data.room.settings || {}) }));
        setUnoMultiHostId(data.room.players.find((p: any) => p.isHost)?.id ?? null);
        const me = data.room.players.find((p: any) => p.userId === data.currentUserId) || data.room.players.find((p: any) => p.id === unoMultiMyId);
        if (me) setUnoMultiMyId(me.id);

        if (data.room.started) {
          setUnoMultiStarted(true);
          const syncRes = await fetch("/api/uno/multiplayer", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ action: "sync-active-game", code: unoMultiTableCode }),
          });
          const syncData = await syncRes.json();
          if (syncData.success && syncData.game) hydrateUnoTableGame(syncData.game);
        }
      } catch (error) {
        console.error("Unable to sync UNO multiplayer room", error);
      }
    }, 2500);

    return () => {
      if (roomSyncRef.current) clearInterval(roomSyncRef.current);
    };
  }, [unoMultiTableCode, unoMultiMyId]);

  useEffect(() => {
    if (!unoMultiTableCode) return;
    const syncSkip = async () => {
      try {
        await fetch("/api/uno/multiplayer", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ action: "toggle-skip", code: unoMultiTableCode, skipNextRound: unoMultiSkipRound }),
        });
      } catch (error) {
        console.error("Unable to toggle skip round", error);
      }
    };
    syncSkip();
  }, [unoMultiSkipRound, unoMultiTableCode]);

  useEffect(() => {
    if (!game?.id) return;

    const interval = setInterval(async () => {
      try {
        const res = await fetch("/api/uno/multiplayer/check-game", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: unoMultiTableCode }),
        });

        const data = await res.json();
        if (!data.success) return;
        if (data.shouldReturnToLobby || !data.data?.role) {
          setMessage("Game over. Returning to lobby...");
          setTimeout(() => resetUnoMultiplayerLobby(), 1200);
          return;
        }

        setPlayerHand(data.data.playerHand || []);
        setTopCard(data.data.topCard || null);
        setGame((prev: any) => ({
  ...prev,
  currentColor: data.data.currentColor,
}));
        setUnoMultiHandCounts(Array.isArray(data.data.handCounts) ? data.data.handCounts : []);
        setUnoMultiTurnPlayerId(data.data.turnPlayerId || null);
        setIsPlayerTurn(data.data.turnPlayerId === data.data.role);
        setTurnHistory((prev) => {
          const last = prev[prev.length - 1];
          const sameCard = last?.color === data.data.topCard?.color && last?.value === data.data.topCard?.value;
          return sameCard ? prev : [...prev, data.data.topCard];
        });
      } catch (error) {
        console.error("Unable to sync multiplayer game", error);
      }
    }, 2000);

    return () => clearInterval(interval);
  }, [game?.id, unoMultiTableCode]);

  const createUnoMultiplayerTable = async () => {
    try {
      const res = await fetch("/api/uno/multiplayer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ action: "create", settings: unoMultiSettings }),
      });
      const data = await res.json();
      if (!data.success) {
        setUnoMultiMessage(data.error || "Unable to create table.");
        return;
      }

    setUnoMultiTableCode(data.room.code);
setUnoMultiPlayers(data.room.players || []);
setUnoMultiHostId(data.room.players.find((p: any) => p.isHost)?.id ?? null);
setUnoMultiMyId(data.currentUserId); // store current user id only
setShowSeatPopup(false);

      setUnoMultiStarted(Boolean(data.room.started));
      setUnoMultiMessage("Table created. Add players or AI, then start.");
      fetchUnoMultiplayerPublicGames();
    } catch (error) {
      console.error("Unable to create multiplayer table", error);
    }
  };

  const joinUnoPublicTable = async (tableCode: string) => {
    try {
      const res = await fetch("/api/uno/multiplayer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ action: "join", code: tableCode }),
      });
      const data = await res.json();
      if (!data.success) {
        setUnoMultiMessage(data.error || "Unable to join table.");
        return;
      }

      const myPlayer = data.room.players.find((p: any) => p.userId === data.currentUserId) || data.room.players[data.room.players.length - 1];
      setUnoMultiTableCode(data.room.code);
      setUnoMultiPlayers(data.room.players || []);
      setUnoMultiHostId(data.room.players.find((p: any) => p.isHost)?.id ?? null);
      setUnoMultiMyId(myPlayer?.id ?? null);
      setUnoMultiStarted(Boolean(data.room.started));
      setUnoMultiSettings((prev) => ({ ...prev, ...(data.room.settings || {}) }));
      setUnoMultiMessage(`Joined table ${data.room.code}. Choose a seat to play.`);
      setShowSeatPopup(true);
      fetchUnoMultiplayerPublicGames();
    } catch (error) {
      console.error("Unable to join multiplayer table", error);
    }
  };

  const joinUnoPrivateTable = async () => {
    if (!unoMultiJoinCode.trim()) {
      setUnoMultiMessage("Enter a private code.");
      return;
    }
    joinUnoPublicTable(unoMultiJoinCode.trim().toUpperCase());
  };

  const isHost = useMemo(() => {
    const me = unoMultiPlayers.find((p) => p.id === unoMultiMyId);
    if (me?.isHost) return true;
    return Boolean(unoMultiMyId && unoMultiHostId && unoMultiMyId === unoMultiHostId);
  }, [unoMultiPlayers, unoMultiMyId, unoMultiHostId]);

 const meSeated = useMemo(
  () => unoMultiPlayers.some((p) => p.userId === unoMultiMyId),
  [unoMultiPlayers, unoMultiMyId]
);

  const sitAsHuman = async (seatIndex: number) => {
    try {
      const res = await fetch("/api/uno/multiplayer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ action: "sit-human", code: unoMultiTableCode, seatIndex }),
      });
      const data = await res.json();
      if (!data.success) return setUnoMultiMessage(data.error || "Unable to sit.");
      setUnoMultiPlayers(data.room.players || []);
      const me = data.room.players.find((p: any) => p.userId === data.currentUserId);
      if (me) setUnoMultiMyId(me.id);
      setShowSeatPopup(false);
    } catch (error) {
      console.error("Unable to sit as human", error);
    }
  };

  const addUnoMultiAiToSeat = async (seatIndex: number) => {
    if (!isHost || unoMultiStarted || !unoMultiTableCode) return;
    try {
      const res = await fetch("/api/uno/multiplayer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ action: "add-ai", code: unoMultiTableCode, seatIndex }),
      });
      const data = await res.json();
      if (!data.success) {
        setUnoMultiMessage(data.error || "Unable to add AI.");
        return;
      }
      setUnoMultiPlayers(data.room.players || []);
setUnoMultiHostId(data.room.players.find((p: any) => p.isHost)?.id ?? null);
setShowSeatPopup(false);
setSelectedSeat(null);
    } catch (error) {
      console.error("Unable to add AI", error);
    }
  };

  const startUnoMultiplayerGame = async () => {
    if (unoMultiPlayers.length < 2) {
      setUnoMultiMessage("Need at least 2 players.");
      return;
    }

    try {
      const res = await fetch("/api/uno/multiplayer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ action: "start", code: unoMultiTableCode }),
      });
      const data = await res.json();
      if (!data.success) {
        setUnoMultiMessage(data.error || "Unable to start.");
        return;
      }
      setUnoMultiStarted(true);
      setUnoMultiPlayers(data.room.players || []);
      setUnoMultiHostId(data.room.players.find((p: any) => p.isHost)?.id ?? null);
      if (data.game) hydrateUnoTableGame(data.game);
      if (typeof data.game?.newBalance !== "undefined") {
        setTokens({ balance: Number(data.game.newBalance) });
      }
      setUnoMultiMessage("Game started.");
      fetchUnoMultiplayerPublicGames();
    } catch (error) {
      console.error("Unable to start table game", error);
    }
  };

  const resetUnoMultiplayerLobby = async () => {
    if (unoMultiTableCode) {
      try {
        await fetch("/api/uno/multiplayer", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ action: "leave", code: unoMultiTableCode }),
        });
      } catch (error) {
        console.error("Unable to leave table", error);
      }
    }

    setGame(null);
    setUnoMultiTableCode("");
    setUnoMultiPlayers([]);
    setUnoMultiHostId(null);
    setUnoMultiMyId(null);
    setUnoMultiStarted(false);
    setUnoMultiMessage("");
    setUnoMultiBackendMode(null);
    setUnoMultiSkipRound(false);
    setUnoMultiHandCounts([]);
    setUnoMultiTurnPlayerId(null);
    setPlayerHand([]);
    setTopCard(null);
    setTurnHistory([]);
    setHistoryIndex(null);
    setIsPlayerTurn(false);
    setMessage("");
    fetchUnoMultiplayerPublicGames();
  };

  const sendPlayCard = async (card: any, chosenColor: string | null = null) => {
    if (!isPlayerTurn || loading || historyIndex !== null) return;

   const isWild =
  card.value.toLowerCase() === "wild" ||
  card.value.toLowerCase() === "wild draw four";

if (isWild && !chosenColor) {
  setPendingCard(card);
  setShowColorPicker(true);
  return;
}

    setLoading(true);
    try {
      const res = await fetch("/api/uno/multiplayer/play-card", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: unoMultiTableCode, card, chosenColor }),
      });
      const data = await res.json();

      if (!data.success) {
        setMessage(data.error || "Move rejected.");
        return;
      }
      if (data.shouldReturnToLobby || !data.data?.role) {
        setMessage("Game over. Returning to lobby...");
        setTimeout(() => resetUnoMultiplayerLobby(), 1000);
        return;
      }

      setPlayerHand(data.data.playerHand || []);
      setTopCard(data.data.topCard || null);
      setTurnHistory((prev) => [...prev, data.data.topCard]);
      setHistoryIndex(null);
      setUnoMultiHandCounts(Array.isArray(data.data.handCounts) ? data.data.handCounts : []);
      setUnoMultiTurnPlayerId(data.data.turnPlayerId || null);
      setIsPlayerTurn(data.data.turnPlayerId === data.data.role);
      setMessage(data.data.message || "Move played.");
      setPendingCard(null);
      setShowColorPicker(false);
    } finally {
      setLoading(false);
    }
  };

  const drawCard = async () => {
    if (!isPlayerTurn || loading || historyIndex !== null) return;
    setLoading(true);

    try {
      const res = await fetch("/api/uno/multiplayer/draw-card", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: unoMultiTableCode }),
      });
      const data = await res.json();
      if (!data.success) {
        setMessage(data.error || "Unable to draw.");
        return;
      }
      if (data.shouldReturnToLobby || !data.data?.role) {
        setMessage("Game over. Returning to lobby...");
        setTimeout(() => resetUnoMultiplayerLobby(), 1000);
        return;
      }

      setPlayerHand(data.data.playerHand || []);
      setTopCard(data.data.topCard || null);
      setTurnHistory((prev) => [...prev, data.data.topCard]);
      setHistoryIndex(null);
      setUnoMultiHandCounts(Array.isArray(data.data.handCounts) ? data.data.handCounts : []);
      setUnoMultiTurnPlayerId(data.data.turnPlayerId || null);
      setIsPlayerTurn(data.data.turnPlayerId === data.data.role);
      setMessage(data.data.message || "Card drawn.");
    } finally {
      setLoading(false);
    }
  };

  const resignGame = async () => {
    if (!game?.id || loading) return;
    setLoading(true);
    try {
      const res = await fetch("/api/uno/multiplayer/resign-and-leave", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: unoMultiTableCode }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMessage(data.error || "Unable to resign.");
        return;
      }
      if (typeof data.newBalance !== "undefined") {
        setTokens({ balance: Number(data.newBalance) });
      }
      setMessage("You resigned. Returning to lobby...");
      setTimeout(() => resetUnoMultiplayerLobby(), 800);
    } finally {
      setLoading(false);
    }
  };

  const displayedCard = historyIndex === null ? topCard : turnHistory[historyIndex];
  const orderedOpponents = useMemo(
    () => unoMultiHandCounts.filter((entry) => entry.playerId !== game?.role).sort((a, b) => a.seatIndex - b.seatIndex),
    [unoMultiHandCounts, game?.role],
  );

  const currentPlayer = unoMultiPlayers.find(
  (p) => p.id === unoMultiTurnPlayerId
);

const isAiThinking =
  currentPlayer?.type === "ai" && !loading;

  return (
    <div className="bg-gradient-to-br from-[#001933] mt-12 to-[#000d1a] min-h-screen flex flex-col items-center text-white px-4 py-8">
      <NavigationBar currentPath="/casino" />
      <h1 className="text-3xl mb-6 font-bold">UNO Multiplayer Table</h1>
      {tokens && <p className="text-yellow-300 mb-4 text-lg">Tokens : {tokens.balance}</p>}

      {!game ? (
        <div className="w-full max-w-4xl rounded-[2rem] bg-[#0b224f]/85 border-2 border-[#00e5ff]/35 shadow-[0_0_28px_rgba(0,229,255,0.2)] p-6">
          <div className="flex justify-between items-center gap-2 mb-4">
            <h2 className="text-xl font-bold">Lobby</h2>
            <button onClick={() => router.push("/casino/uno")} className="px-4 py-2 bg-[#f5ff3b] text-[#031026] rounded-lg font-semibold">Back to UNO</button>
          </div>

          {!unoMultiTableCode ? (
            <>
              <div className="grid md:grid-cols-2 gap-3">
                <input value={unoMultiSettings.gameName} onChange={(e) => setUnoMultiSettings((s) => ({ ...s, gameName: e.target.value }))} className="bg-[#001933] border border-[#00e5ff]/35 rounded px-3 py-2" placeholder="Table name" />
                <select value={unoMultiSettings.visibility} onChange={(e) => setUnoMultiSettings((s) => ({ ...s, visibility: e.target.value }))} className="bg-[#001933] border border-[#00e5ff]/35 rounded px-3 py-2">
                  <option value="private">Private</option>
                  <option value="public">Public</option>
                </select>
                <input type="number" min={1} max={1000} value={unoMultiSettings.betAmount} onChange={(e) => setUnoMultiSettings((s) => ({ ...s, betAmount: Number(e.target.value) || 1 }))} className="bg-[#001933] border border-[#00e5ff]/35 rounded px-3 py-2" placeholder="Bet amount" />
                <select value={unoMultiSettings.maxPlayers} onChange={(e) => setUnoMultiSettings((s) => ({ ...s, maxPlayers: Number(e.target.value) }))} className="bg-[#001933] border border-[#00e5ff]/35 rounded px-3 py-2">
                  <option value={3}>3 Players</option><option value={4}>4 Players</option><option value={5}>5 Players</option><option value={6}>6 Players</option>
                </select>
              </div>
              <button onClick={createUnoMultiplayerTable} className="mt-4 w-full rounded-lg bg-[#f5ff3b] text-[#031026] font-bold py-2">Create Table</button>

              <div className="mt-3 flex gap-2">
                <input value={unoMultiJoinCode} onChange={(e) => setUnoMultiJoinCode(e.target.value.toUpperCase())} className="flex-1 bg-[#001933] border border-[#00e5ff]/35 rounded px-3 py-2" placeholder="Invite code" />
                <button onClick={joinUnoPrivateTable} className="px-4 py-2 rounded bg-[#00e5ff] text-[#001933] font-semibold">Join code</button>
              </div>
            </>
          ) : (
            <>
              <p className="text-sm text-[#a5f3fc] mb-2">Table code: <span className="font-bold text-yellow-300">{unoMultiTableCode}</span></p>
              <label className="inline-flex items-center gap-2 mb-3 text-sm text-yellow-100">
                <input type="checkbox" checked={unoMultiSkipRound} onChange={(e) => setUnoMultiSkipRound(e.target.checked)} /> Skip next round
              </label>
              <div className="relative w-full h-[320px] rounded-3xl bg-green-800/70 border-4 border-green-950">
                {UNO_MULTI_SEAT_POSITIONS.map((pos, seatIndex) => {
                  const isEnabledSeat = seatIndex < unoMultiSettings.maxPlayers;
                  const occupant = unoMultiPlayers.find((p) => p.seatIndex === seatIndex);
                  return (
                    <div key={seatIndex} className="absolute" style={{ left: pos.left, top: pos.top, transform: "translate(-50%, -50%)" }}>
                      {isEnabledSeat ? (
                        occupant ? (
                          <div className={`w-28 h-12 rounded-xl border flex items-center justify-center text-xs font-semibold ${occupant.id === unoMultiMyId ? "bg-yellow-300 text-black border-yellow-100" : "bg-[#08142f] border-[#00e5ff]/35"}`}>
                            {occupant.type === "ai" ? "🤖" : "👤"} {occupant.name}
                          </div>
                        ) : (
                          <button
  onClick={() => {
    setSelectedSeat(seatIndex);
    setShowSeatPopup(true);
  }}
                            disabled={meSeated ? !isHost : false}
                            className={`w-28 h-12 rounded-xl border border-dashed text-xs ${isHost ? "border-[#00e5ff]/45 hover:bg-[#00e5ff]/20" : "border-gray-500 text-gray-400 cursor-not-allowed"}`}
                          >
                            {!meSeated ? "Sit as Human" : isHost ? "+ Add AI" : "Open seat"}
                          </button>
                        )
                      ) : <div className="w-28 h-12 rounded-xl border border-gray-600 bg-gray-800/40 text-[10px] flex items-center justify-center text-gray-400">Disabled</div>}
                    </div>
                  );
                })}
              </div>

              <div className="mt-4 flex gap-3">
                <button onClick={startUnoMultiplayerGame} disabled={meSeated ? !isHost : false} className="flex-1 bg-green-600 hover:bg-green-500 disabled:bg-gray-600 px-4 py-2 rounded font-bold">Start</button>
                <button onClick={resetUnoMultiplayerLobby} className="flex-1 bg-red-600 hover:bg-red-500 px-4 py-2 rounded font-bold">Leave</button>
              </div>
            </>
          )}

          <div className="mt-4 rounded-lg border border-[#00e5ff]/30 p-3 bg-[#001933]">
            <div className="mb-2 flex justify-between items-center">
              <p className="font-semibold">Available public games</p>
              <button onClick={fetchUnoMultiplayerPublicGames} className="px-2 py-1 rounded bg-[#00e5ff] text-[#001933] text-xs font-semibold">Refresh</button>
            </div>
            <div className="space-y-2">
              {unoMultiPublicGames.length === 0 && <p className="text-sm text-gray-300">No public games right now.</p>}
              {unoMultiPublicGames.slice(0, 8).map((entry) => (
                <div key={entry.code} className="flex items-center justify-between bg-[#0d335f]/80 rounded px-3 py-2">
                  <span className="text-sm">{entry.name} ({entry.occupiedSeats}/{entry.maxPlayers}) • Bet {entry.betAmount}</span>
                  <button onClick={() => joinUnoPublicTable(entry.code)} className="px-3 py-1 rounded bg-[#00e5ff] text-[#001933] font-semibold">Join</button>
                </div>
              ))}
            </div>
          </div>

          {showSeatPopup && selectedSeat !== null && (
  <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center">
    <div className="bg-[#08142f] border border-[#00e5ff]/40 rounded-2xl p-6 w-[320px] text-center">
      <h2 className="text-xl font-bold mb-4">
        Seat {selectedSeat + 1}
      </h2>

      {!meSeated && (
        <button
          onClick={() => sitAsHuman(selectedSeat)}
          className="w-full mb-3 py-2 rounded bg-yellow-300 text-black font-bold"
        >
          Sit Here
        </button>
      )}

      {isHost && (
        <button
          onClick={() => addUnoMultiAiToSeat(selectedSeat)}
          className="w-full mb-3 py-2 rounded bg-cyan-400 text-black font-bold"
        >
          Add AI Here
        </button>
      )}

      <button
        onClick={() => {
          setShowSeatPopup(false);
          setSelectedSeat(null);
        }}
        className="w-full py-2 rounded bg-red-600 font-bold"
      >
        Cancel
      </button>
    </div>
  </div>
)}
          {unoMultiMessage && <p className="mt-4 text-yellow-200 text-sm">{unoMultiMessage}</p>}
        </div>
      ) : (
        <div className="w-full max-w-5xl min-h-[650px] bg-green-700/90 rounded-[2.5rem] flex flex-col justify-between items-center shadow-2xl border-8 border-green-950 p-6 pb-40 relative overflow-hidden">
          <button onClick={resignGame} className="fixed top-24 right-5 z-50 px-4 py-2 bg-red-600 hover:bg-red-500 rounded-lg font-bold">Resign</button>
          <button onClick={resetUnoMultiplayerLobby} className="fixed top-24 left-5 z-50 px-4 py-2 bg-[#f5ff3b] text-[#031026] rounded-lg font-bold">Back to lobby</button>

          <div className="relative w-full h-[480px] mt-2 rounded-full border-8 border-yellow-900/80 bg-green-800/80">
            <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-center">
<p className="text-xs text-white/70">
  Current color:{" "}
  <span className="font-bold uppercase">
    {game?.currentColor || topCard?.color}
  </span>
</p>
              <div className="flex gap-3 justify-center">
                <button onClick={drawCard}><UnoBack /></button>
                {displayedCard ? <UnoCard color={displayedCard.color} value={displayedCard.value} onClick={() => {}} style={{}} /> : <div className="w-16 h-24 rounded-lg bg-[#0f172a]/60 border border-white/25" />}
              </div>
            </div>

            {UNO_MULTI_SEAT_POSITIONS.map((pos, seatIndex) => {
              const player = unoMultiPlayers.find((p) => p.seatIndex === seatIndex);
              if (!player || seatIndex >= unoMultiSettings.maxPlayers) return null;
              const hand = unoMultiHandCounts.find((h) => h.playerId === player.id);
              return (
                <div key={`${player.id}-${seatIndex}`} className="absolute" style={{ left: pos.left, top: pos.top, transform: "translate(-50%, -50%)" }}>
                  <div className={`w-32 rounded-xl border px-2 py-2 text-center ${unoMultiTurnPlayerId === player.id ? "border-yellow-300 bg-yellow-300/25 shadow-[0_0_20px_rgba(253,224,71,0.7)]" : "bg-[#08142f] border-[#00e5ff]/35 text-white"}`}>
                    <p className="text-xs font-bold truncate">{player.type === "ai" ? "🤖" : "👤"} {player.name}</p>
                    <p className="text-[11px] opacity-80">{hand?.count ?? 0} cards</p>
                  </div>
                </div>
              );
            })}
          </div>

          {showColorPicker && (
            <div className="absolute inset-0 bg-black/70 flex items-center justify-center z-50">
              <div className="bg-white p-8 rounded-2xl text-black flex flex-col items-center gap-4">
                <h2 className="text-xl font-bold">Pick a color</h2>
                <div className="grid grid-cols-2 gap-3">
                  {["red", "blue", "green", "yellow"].map((color) => (
                    <button key={color} onClick={() => sendPlayCard(pendingCard, color)} className="w-20 h-20 rounded-xl text-white font-bold capitalize" style={{ backgroundColor: color }}>{color}</button>
                  ))}
                </div>
              </div>
            </div>
          )}

         <div className="absolute bottom-28 left-1/2 -translate-x-1/2 text-sm text-yellow-200">
  {isPlayerTurn
  ? "Your turn"
  : isAiThinking
  ? `🤖 ${currentPlayer?.name} is thinking...`
  : "Waiting for player..."}
</div>

          <div className="absolute bottom-4 w-full px-6">
            <div className="flex justify-center items-center gap-3 mb-2">
              <button onClick={drawCard} disabled={!isPlayerTurn || loading} className="px-4 py-2 bg-[#f5ff3b] text-[#031026] rounded-full font-bold disabled:opacity-40">Draw card</button>
              <button className="px-4 py-2 bg-[#00e5ff] text-[#001933] rounded-full font-bold opacity-80">UNO (coming soon)</button>
              <button onClick={() => setHistoryIndex((prev) => (prev === null ? Math.max(turnHistory.length - 2, 0) : Math.max(prev - 1, 0)))} className="px-3 py-1 bg-black/40 rounded">◀</button>
              <button onClick={() => setHistoryIndex((prev) => (prev === null || prev >= turnHistory.length - 2 ? null : prev + 1))} className="px-3 py-1 bg-black/40 rounded">▶</button>
            </div>
            <div className={`flex flex-wrap justify-center gap-2 rounded-2xl p-3 ${isPlayerTurn ? "ring-2 ring-yellow-300/70 shadow-[0_0_16px_rgba(253,224,71,0.6)]" : ""}`}>
              {playerHand.map((card, index) => (
                <div key={`${card.color}-${card.value}-${index}`} className="transition-transform hover:-translate-y-2 duration-200">
                  <UnoCard color={card.color} value={card.value} onClick={() => sendPlayCard(card)} style={{}} />
                </div>
              ))}
            </div>
          </div>

          {orderedOpponents.length > 0 && (
            <div className="absolute top-4 left-1/2 -translate-x-1/2 flex gap-2 flex-wrap justify-center max-w-[90%]">
              {orderedOpponents.map((entry) => (
                <div key={entry.playerId} className={`rounded-xl px-2 py-1 border ${unoMultiTurnPlayerId === entry.playerId ? "border-yellow-300 bg-yellow-300/20" : "border-white/25 bg-black/20"}`}>
                  <p className="text-[10px] font-semibold truncate">{entry.name}</p>
                  <p className="text-[10px] text-center">{entry.count} cards</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
