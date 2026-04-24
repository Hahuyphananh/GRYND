"use client";

import { useState, useEffect, useRef } from "react";
import UnoCard from "../../../components/UnoCard"; 
import UnoBack from "../../../components/UnoBack"; 
import NavigationBar from "../../../components/navigation-bar";
import { useSocket } from "../../../context/SocketProvider";
import useGamePresence from '../../../hooks/useGamePresence';

const CONFETTI_COLORS = ["#facc15", "#60a5fa", "#4ade80", "#f472b6", "#fb923c"];
const UNO_MULTI_SEAT_POSITIONS = [
  { left: "50%", top: "15%" },
  { left: "78%", top: "30%" },
  { left: "78%", top: "68%" },
  { left: "50%", top: "84%" },
  { left: "22%", top: "68%" },
  { left: "22%", top: "30%" },
];

function playUiTone(type = "draw") {
  if (typeof window === "undefined") return;
  const context = new (window.AudioContext || window.webkitAudioContext)();
  const osc = context.createOscillator();
  const gain = context.createGain();
  osc.connect(gain);
  gain.connect(context.destination);

  const tones = {
    draw: { freq: 430, duration: 0.08 },
    play: { freq: 520, duration: 0.08 },
    win: { freq: 700, duration: 0.18 },
  };

  const tone = tones[type] || tones.draw;
  osc.frequency.value = tone.freq;
  gain.gain.setValueAtTime(0.001, context.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.06, context.currentTime + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + tone.duration);
  osc.start();
  osc.stop(context.currentTime + tone.duration);
}

export default function UnoGamePage() {
  const { socket } = useSocket();
  const [game, setGame] = useState(null);
  const [gameMode, setGameMode] = useState("ai");
  const [lobbyMode, setLobbyMode] = useState("classic");
  const [playerHand, setPlayerHand] = useState([]);
  const [aiHandCount, setAiHandCount] = useState(0);
  const [topCard, setTopCard] = useState(null);
  const [isPlayerTurn, setIsPlayerTurn] = useState(true);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [betAmount, setBetAmount] = useState(100);
  const [tokens, setTokens] = useState(null);
const [showColorPicker, setShowColorPicker] = useState(false);
const [pendingCard, setPendingCard] = useState(null);
const [turnHistory, setTurnHistory] = useState([]);
const [historyIndex, setHistoryIndex] = useState(null); // null = live game
const [showGameModeModal, setShowGameModeModal] = useState(false);
const [availableGames, setAvailableGames] = useState([]);
const [isLoadingAvailableGames, setIsLoadingAvailableGames] = useState(false);
const [waitingGameId, setWaitingGameId] = useState(null);
const [isCancellingWaitingGame, setIsCancellingWaitingGame] = useState(false);
const waitingPollRef = useRef(null);
const centerCardRef = useRef(null);
const [showRules, setShowRules] = useState(false);
const [isResigning, setIsResigning] = useState(false);
const [drawnCardAnimation, setDrawnCardAnimation] = useState(null);
const [playedCardAnimation, setPlayedCardAnimation] = useState(null);
const [unoMultiSettings, setUnoMultiSettings] = useState({
  gameName: "UNO Table",
  visibility: "private",
  betAmount: 100,
  maxPlayers: 4,
  startingCards: 7,
  turnTimeSeconds: 30,
});
const [unoMultiTableCode, setUnoMultiTableCode] = useState("");
const [unoMultiPublicGames, setUnoMultiPublicGames] = useState([]);
const [unoMultiPlayers, setUnoMultiPlayers] = useState([]);
const [unoMultiHostId, setUnoMultiHostId] = useState(null);
const [unoMultiMyId, setUnoMultiMyId] = useState(null);
const [unoMultiStarted, setUnoMultiStarted] = useState(false);
const [unoMultiMessage, setUnoMultiMessage] = useState("");
const [unoMultiJoinCode, setUnoMultiJoinCode] = useState("");
const [unoMultiSkipRound, setUnoMultiSkipRound] = useState(false);
const [unoMultiBackendMode, setUnoMultiBackendMode] = useState(null);
const [unoMultiHandCounts, setUnoMultiHandCounts] = useState([]);
const [unoMultiTurnPlayerId, setUnoMultiTurnPlayerId] = useState(null);

useGamePresence({ gameKey: "uno", gameId: Number(game?.id), enabled: Boolean(game?.id) });

useEffect(() => {
  fetchAvailableGames();
}, []);



useEffect(() => {
  if (!socket) return;
  const roomId = "lobby:uno";
  const handleLobbyUpdate = () => fetchAvailableGames();
  socket.emit("join_room", { roomId });
  socket.on("lobby:updated", handleLobbyUpdate);
  return () => {
    socket.emit("leave_room", { roomId });
    socket.off("lobby:updated", handleLobbyUpdate);
  };
}, [socket, game, waitingGameId]);

  // ✅ Load tokens on page mount
  useEffect(() => {
    const fetchTokens = async () => {
      try {
        const res = await fetch("/api/get-user-tokens", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
        });
        const data = await res.json();
        if (data.success) {
          setTokens({ balance: data.data.balance });
        }
      } catch (err) {
        console.error("Erreur lors du chargement des tokens:", err);
      }
    };
    fetchTokens();
  }, []);

  const fetchUnoMultiplayerPublicGames = async () => {
    try {
      const res = await fetch("/api/uno/multiplayer", {
        method: "GET",
        credentials: "include",
      });
      const data = await res.json();
      if (data.success) {
        setUnoMultiPublicGames(data.rooms || []);
      }
    } catch (err) {
      console.error("Unable to fetch UNO multiplayer public games:", err);
      setUnoMultiPublicGames([]);
    }
  };

  useEffect(() => {
    fetchUnoMultiplayerPublicGames();
  }, []);

  const hydrateUnoTableGame = (tableGame) => {
    if (!tableGame?.id) return;
    setGame({ id: tableGame.id, role: tableGame.role });
    setGameMode("multi-online");
    setUnoMultiBackendMode(tableGame.mode);
    setUnoMultiStarted(true);
    setTopCard(tableGame.topCard || null);
    setUnoMultiHandCounts(Array.isArray(tableGame.handCounts) ? tableGame.handCounts : []);
    setUnoMultiTurnPlayerId(tableGame.turnPlayerId || null);
    setTurnHistory(tableGame.topCard ? [tableGame.topCard] : []);
    setHistoryIndex(null);
    const isAiMode = tableGame.mode === "ai";
    const isTableMode = tableGame.mode === "table";
    const normalizedHand = Array.isArray(tableGame.playerHand) ? tableGame.playerHand : [];
    setPlayerHand(normalizedHand);
    setAiHandCount(isAiMode ? (tableGame.aiHandCount ?? 0) : (tableGame.opponentHandCount ?? 0));
    const turnRole = tableGame.turn || tableGame.turnPlayerId;
    const myTurn = isTableMode ? tableGame.turnPlayerId === tableGame.role : (isAiMode ? turnRole === "player" : turnRole === tableGame.role);
    setIsPlayerTurn(Boolean(myTurn));
    setMessage(myTurn ? "À ton tour !" : "Tour adverse...");
  };

  useEffect(() => {
    if (!unoMultiTableCode) return;
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/uno/multiplayer?code=${unoMultiTableCode}`, {
          method: "GET",
          credentials: "include",
        });
        const data = await res.json();
        if (!data.success) return;
        setUnoMultiPlayers(data.room.players || []);
        setUnoMultiSettings((prev) => ({ ...prev, ...(data.room.settings || {}) }));
        setUnoMultiHostId(data.room.players.find((p) => p.isHost)?.id ?? null);
        const me = data.room.players.find((p) => p.id === unoMultiMyId || p.name === "You");
        if (me) setUnoMultiMyId(me.id);
        if (data.room.started) {
          setUnoMultiStarted(true);
          const stateRes = await fetch("/api/uno/multiplayer", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ action: "sync-active-game", code: unoMultiTableCode }),
          });
          const stateData = await stateRes.json();
          if (stateData.success && stateData.game) {
            hydrateUnoTableGame(stateData.game);
          }
        }
      } catch (err) {
        console.error("Unable to sync UNO multiplayer room:", err);
      }
    }, 2500);

    return () => clearInterval(interval);
  }, [unoMultiTableCode, unoMultiStarted, unoMultiMyId]);

  const resetUnoMultiplayerLobby = async () => {
    if (unoMultiTableCode) {
      try {
        const res = await fetch("/api/uno/multiplayer", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ action: "leave", code: unoMultiTableCode }),
        });
        const data = await res.json();
        if (!data.success) {
          setUnoMultiMessage(data.error || "Unable to leave table.");
          return;
        }
      } catch (err) {
        console.error("Unable to leave UNO multiplayer table:", err);
      }
    }
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
    await fetchUnoMultiplayerPublicGames();
  };

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
      } catch (err) {
        console.error("Unable to toggle skip round:", err);
      }
    };
    syncSkip();
  }, [unoMultiSkipRound, unoMultiTableCode]);

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
        setUnoMultiMessage(data.error || "Unable to create multiplayer table.");
        return;
      }

      const myPlayer = data.room.players.find((p) => p.userId === data.currentUserId) ?? data.room.players[0];
      setUnoMultiTableCode(data.room.code);
      setUnoMultiPlayers(data.room.players || []);
      setUnoMultiHostId(myPlayer?.id ?? null);
      setUnoMultiMyId(myPlayer?.id ?? null);
      setUnoMultiStarted(Boolean(data.room.started));
      setUnoMultiBackendMode(null);
      setUnoMultiMessage("Table created. Add players or bots, then start the game.");
      await fetchUnoMultiplayerPublicGames();
    } catch (err) {
      console.error("Unable to create UNO multiplayer table:", err);
      setUnoMultiMessage("Unable to create multiplayer table.");
    }
  };

  const joinUnoPublicTable = async (tableCode) => {
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
      const myPlayer = data.room.players.find((p) => p.userId === data.currentUserId) || data.room.players[data.room.players.length - 1];
      setUnoMultiTableCode(data.room.code);
      setUnoMultiPlayers(data.room.players || []);
      setUnoMultiHostId(data.room.players.find((p) => p.isHost)?.id ?? null);
      setUnoMultiMyId(myPlayer?.id ?? null);
      setUnoMultiStarted(Boolean(data.room.started));
      setUnoMultiSettings((prev) => ({ ...prev, ...(data.room.settings || {}) }));
      setUnoMultiMessage(`Joined public table ${data.room.code}. Waiting for host to start.`);
      await fetchUnoMultiplayerPublicGames();
    } catch (err) {
      console.error("Unable to join UNO multiplayer table:", err);
      setUnoMultiMessage("Unable to join table.");
    }
  };

  const joinUnoPrivateTable = async () => {
    if (!unoMultiJoinCode.trim()) {
      setUnoMultiMessage("Enter an invite code to join a private table.");
      return;
    }
    await joinUnoPublicTable(unoMultiJoinCode.trim().toUpperCase());
  };

  const addUnoMultiAiToSeat = async (seatIndex) => {
    if (!unoMultiHostId || unoMultiStarted || !unoMultiTableCode) return;
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
    } catch (err) {
      console.error("Unable to add UNO AI to seat:", err);
    }
  };

  const startUnoMultiplayerGame = async () => {
    if (unoMultiPlayers.length < 2) {
      setUnoMultiMessage("Add at least one more player or AI before starting.");
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
        setUnoMultiMessage(data.error || "Unable to start UNO table.");
        return;
      }
      setUnoMultiStarted(true);
      setUnoMultiPlayers(data.room.players || []);
      if (data.game) {
        hydrateUnoTableGame(data.game);
      }
      if (data.game?.newBalance) {
        setTokens({ balance: data.game.newBalance });
      }
      setUnoMultiMessage("UNO multiplayer table started.");
      await fetchUnoMultiplayerPublicGames();
    } catch (err) {
      console.error("Unable to start UNO multiplayer table:", err);
    }
  };

  const fetchAvailableGames = async () => {
    if (typeof document !== "undefined" && document.hidden) return;
    if (game || waitingGameId) return;
    setIsLoadingAvailableGames(true);
    try {
      const res = await fetch("/api/uno/available-games", {
        method: "GET",
        credentials: "include",
      });
      const data = await res.json();
      if (data.success) {
        setAvailableGames(data.data || []);
      }
    } catch (err) {
      console.error("Erreur lors du chargement des parties disponibles:", err);
    }
    setIsLoadingAvailableGames(false);
  };
  // ✅ Winner check helper
  const checkForWinner = async (gameId) => {
    if (gameMode === "multi-online" && unoMultiBackendMode === "table") return;
    try {
      const res = await fetch("/api/uno/determine-winner", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gameId }),
      });
      const data = await res.json();
      if (data.winner) {
        if (gameMode === "online") {
          const youWon = data.result === "win";
          setMessage(youWon ? "Tu as gagné la partie !" : "Ton adversaire a gagné la partie !");
          if (youWon) playUiTone("win");
        } else {
          setMessage(`${data.winner} a gagné la partie !`);
          if (data.winner === "player") playUiTone("win");
        }
        setIsPlayerTurn(false);
      }
    } catch (err) {
      console.error("Erreur lors de la vérification du gagnant:", err);
    }
  };

  const initializeGame = async () => {
    setLoading(true);
    const res = await fetch("/api/uno/initialize-vs-ai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ betAmount }),
    });

    const data = await res.json();
    if (data.success) {
      setGameMode("ai");
      setGame(data.data);
      setPlayerHand(data.data.playerHand);
      setAiHandCount(data.data.aiHand.length);
      if (data.data.topCard) {
  setTopCard(data.data.topCard);
  setTurnHistory((prev) => [...prev, data.data.topCard]);
}
setHistoryIndex(null); // back to live mode
      setIsPlayerTurn(true);
      setMessage("À ton tour !");
      setTokens({ balance: data.data.newBalance }); // ✅ update tokens
    } else {
      setMessage("Erreur d'initialisation");
    }
    setLoading(false);
  };

  const handleAITurn = async (gameId) => {
    try {
      const res = await fetch("/api/uno/ai-turn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gameId }),
      });
      const data = await res.json();
      if (data.success) {
  setPlayerHand(data.data.playerHand);
  setAiHandCount(data.data.aiHandCount);
  setTopCard(data.data.topCard);
setTurnHistory((prev) => [...prev, data.data.topCard]);
setHistoryIndex(null); // back to live mode

  setIsPlayerTurn(data.data.isPlayerTurn);
  setMessage(data.data.message || "À ton tour !");
  setTokens({ balance: data.data.newBalance });
  await checkForWinner(gameId);
}


    } catch (err) {
      console.error("Erreur IA:", err);
    }
  };

 const playCard = async (card, clickEvent = null) => {
  if (!isPlayerTurn || loading) return;
  if (historyIndex !== null) return; // block while browsing history

  // If it's a wild or black card, ask for color first
  if (card.color === "wild" || card.color === "black") {
    setPendingCard(card);
    setShowColorPicker(true);
    return;
  }

  // Otherwise play as usual
  if (clickEvent?.currentTarget && centerCardRef.current) {
    const fromRect = clickEvent.currentTarget.getBoundingClientRect();
    const toRect = centerCardRef.current.getBoundingClientRect();
    setPlayedCardAnimation({
      card,
      dx: toRect.left - fromRect.left,
      dy: toRect.top - fromRect.top,
    });
    window.setTimeout(() => setPlayedCardAnimation(null), 420);
  }

  playUiTone("play");
  await sendPlayCard(card);
};

const sendPlayCard = async (card, chosenColor = null) => {
  setLoading(true);

  // Only ask for color if it's wild AND no color has been chosen yet
  if ((card.color === "wild" || card.color === "black") && !chosenColor) {
    setPendingCard(card);
    setShowColorPicker(true);
    setLoading(false);
    return;
  }

  const playEndpoint = gameMode === "multi-online" && unoMultiBackendMode === "table" ? "/api/uno/multiplayer/play-card" : "/api/uno/play-card";
  const res = await fetch(playEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(gameMode === "multi-online" && unoMultiBackendMode === "table" ? { code: unoMultiTableCode, card, chosenColor } : { gameId: game.id, card, chosenColor }),
  });

  const data = await res.json();

  if (data.success) {
    if (data.needsColorChoice) {
      setPendingCard(data.card);
      setShowColorPicker(true);
      setLoading(false);
      return;
    }

    setPlayerHand(data.data.playerHand);
    setTopCard(data.data.topCard);
    setTurnHistory((prev) => [...prev, data.data.topCard]);
    setHistoryIndex(null); // back to live mode
    setAiHandCount(data.data.aiHandCount ?? data.data.opponentHandCount ?? 0);
    setUnoMultiHandCounts(Array.isArray(data.data.handCounts) ? data.data.handCounts : unoMultiHandCounts);
    setUnoMultiTurnPlayerId(data.data.turnPlayerId || null);
    setIsPlayerTurn((gameMode === "multi-online" && unoMultiBackendMode === "table") ? data.data.turnPlayerId === data.data.role : data.data.isPlayerTurn);
    setMessage(data.data.message || "À ton tour !");
    setPendingCard(null);       // ✅ clear pending card
    setShowColorPicker(false);  // ✅ make sure popup closes
    await checkForWinner(game.id);

    if (!data.data.isPlayerTurn && (gameMode === "ai" || (gameMode === "multi-online" && unoMultiBackendMode === "ai"))) {
      setTimeout(() => handleAITurn(game.id), 1000);
    }
  } else {
    setMessage(data.error);
  }

  setLoading(false);
};
const waitForOnlineGameStart = (gameId) => {
  if (waitingPollRef.current) {
    clearInterval(waitingPollRef.current);
    waitingPollRef.current = null;
  }

  waitingPollRef.current = setInterval(async () => {
    try {
      const res2 = await fetch("/api/uno/check-game", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gameId }),
      });
      const d2 = await res2.json();

      if (d2.success && d2.status === "active") {
        clearInterval(waitingPollRef.current);
        waitingPollRef.current = null;
        setWaitingGameId(null);
        setGameMode("online");
        setGame(d2.data);
        setPlayerHand(d2.data.playerHand);
        setAiHandCount(d2.data.opponentHandCount);
        setTopCard(d2.data.topCard);
        setTurnHistory([d2.data.topCard]);
        const isMyTurn = d2.data.turn === d2.data.role;
        setIsPlayerTurn(isMyTurn);
        setMessage(isMyTurn ? "✅ Partie trouvée ! Tu commences." : "✅ Partie trouvée ! L'adversaire commence.");
      }
    } catch (err) {
      console.error("Erreur check-game:", err);
    }
  }, 3000);
};

const cancelWaitingOnlineGame = async () => {
  if (!waitingGameId || isCancellingWaitingGame) return;

  setIsCancellingWaitingGame(true);
  try {
    const res = await fetch("/api/uno/cancel-waiting", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ gameId: waitingGameId }),
    });
    const data = await res.json();

    if (data.success) {
      if (waitingPollRef.current) {
        clearInterval(waitingPollRef.current);
        waitingPollRef.current = null;
      }
      setWaitingGameId(null);
      setMessage("✅ Partie annulée.");
      if (data.newBalance) {
        setTokens({ balance: data.newBalance });
      }
      fetchAvailableGames();
      socket?.emit("room_event", { roomId: "lobby:uno", event: "lobby:updated" });
    } else {
      setMessage(data.error || "Impossible d'annuler la partie.");
    }
  } catch (err) {
    console.error("Erreur cancelWaitingOnlineGame:", err);
    setMessage("Impossible d'annuler la partie.");
  }
  setIsCancellingWaitingGame(false);
};

const joinSpecificOnlineGame = async (gameId) => {
  if (loading) return;
  setLoading(true);
  try {
    const res = await fetch("/api/uno/join-online", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ mode: "join-specific", gameId }),
    });

    const data = await res.json();

    if (data.success) {
      setWaitingGameId(null);
      setGameMode("online");
      setGame(data.data);
      setPlayerHand(data.data.playerHand);
      setAiHandCount(data.data.opponentHandCount);
      setTopCard(data.data.topCard);
      setTurnHistory([data.data.topCard]);
      const isMyTurn = data.data.turn === (data.data.role || "player2");
      setIsPlayerTurn(isMyTurn);
      setMessage(isMyTurn ? "✅ Partie en ligne trouvée ! Tu commences." : "✅ Partie en ligne trouvée ! L'adversaire commence.");
      setTokens({ balance: data.data.newBalance });
      fetchAvailableGames();
      socket?.emit("room_event", { roomId: "lobby:uno", event: "lobby:updated" });
    } else {
      setMessage(data.error || "Impossible de rejoindre cette partie");
      fetchAvailableGames();
      socket?.emit("room_event", { roomId: "lobby:uno", event: "lobby:updated" });
    }
  } catch (err) {
    console.error("Erreur joinSpecificOnlineGame:", err);
    setMessage("Impossible de rejoindre cette partie");
  }
  setLoading(false);
};

const joinOnlineGame = async () => {
  setLoading(true);
  try {
    const res = await fetch("/api/uno/join-online", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ mode: "join-random" }),
    });

    const data = await res.json();

    if (data.success) {
      if (waitingPollRef.current) {
        clearInterval(waitingPollRef.current);
        waitingPollRef.current = null;
      }
      setWaitingGameId(null);
      setGameMode("online");
      setGame(data.data);
      setPlayerHand(data.data.playerHand);
      setAiHandCount(data.data.opponentHandCount);
      setTopCard(data.data.topCard);
      setTurnHistory([data.data.topCard]);
      const isMyTurn = data.data.turn === (data.data.role || "player2");
      setIsPlayerTurn(isMyTurn);
      setMessage(isMyTurn ? "✅ Partie en ligne trouvée ! Tu commences." : "✅ Partie en ligne trouvée ! L'adversaire commence.");
      setTokens({ balance: data.data.newBalance });
      fetchAvailableGames();
      socket?.emit("room_event", { roomId: "lobby:uno", event: "lobby:updated" });
    } else {
      setMessage(data.error || "Erreur lors de la recherche de partie");
    }
  } catch (err) {
    console.error("Erreur joinOnlineGame:", err);
    setMessage("Impossible de rejoindre une partie");
  }
  setLoading(false);
};

const createOnlineGame = async () => {
  setLoading(true);
  setShowGameModeModal(false);

  try {
    const res = await fetch("/api/uno/join-online", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ mode: "create", betAmount }),
    });

    const data = await res.json();
    if (data.success && data.waiting) {
      setMessage("⏳ En attente d'un autre joueur...");
      setGameMode("online");
      setWaitingGameId(data.gameId);
      if (data.newBalance) {
        setTokens({ balance: data.newBalance });
      }
      waitForOnlineGameStart(data.gameId);
      fetchAvailableGames();
    } else {
      setMessage(data.error || "Impossible de créer la partie en ligne");
    }
  } catch (err) {
    console.error("Erreur createOnlineGame:", err);
    setMessage("Impossible de créer la partie en ligne");
  }
  setLoading(false);
};

useEffect(() => {
  if (!game?.id || !["online", "multi-online"].includes(gameMode)) return;

  const interval = setInterval(async () => {
    try {
      const isTableMode = gameMode === "multi-online" && unoMultiBackendMode === "table";
      const res = await fetch(isTableMode ? "/api/uno/multiplayer/check-game" : "/api/uno/check-game", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(isTableMode ? { code: unoMultiTableCode } : { gameId: game.id }),
      });
      const data = await res.json();

      if (!data.success || !data.data) return;

      setPlayerHand(data.data.playerHand || []);
      const multiplayerAi = gameMode === "multi-online" && unoMultiBackendMode === "ai";
      const tableMode = gameMode === "multi-online" && unoMultiBackendMode === "table";
      setAiHandCount(multiplayerAi ? (data.data.aiHandCount ?? 0) : (data.data.opponentHandCount ?? aiHandCount));
      setTopCard(data.data.topCard);
      setUnoMultiHandCounts(Array.isArray(data.data.handCounts) ? data.data.handCounts : []);
      setUnoMultiTurnPlayerId(data.data.turnPlayerId || null);
      setIsPlayerTurn(tableMode ? data.data.turnPlayerId === data.data.role : (multiplayerAi ? data.data.turn === "player" : data.data.turn === data.data.role));

     if (data.status === "finished") {
  const youWon = data.data.winner === data.data.role;

  setMessage(
    youWon
      ? "Tu as gagné la partie !"
      : "Ton adversaire a gagné la partie !"
  );

  setIsPlayerTurn(false);
}
      setTurnHistory((prev) => {
        const last = prev[prev.length - 1];
        const sameCard =
          last?.color === data.data.topCard?.color &&
          last?.value === data.data.topCard?.value;
        if (sameCard) return prev;
        return [...prev, data.data.topCard];
      });
    } catch (err) {
      console.error("Erreur sync online:", err);
    }
  }, 2000);

  return () => clearInterval(interval);
}, [game?.id, gameMode, unoMultiBackendMode, unoMultiTableCode, aiHandCount]);

useEffect(() => {
  return () => {
    if (waitingPollRef.current) {
      clearInterval(waitingPollRef.current);
      waitingPollRef.current = null;
    }
  };
}, []);

const isGameFinished =
  game && !isPlayerTurn && (
    message.includes("gagné") ||
    message.includes("abandonné")
  );

 const resignGame = async () => {
  if (!game?.id || isResigning) return;

  setIsResigning(true);

  try {
    const res = await fetch(gameMode === "multi-online" && unoMultiBackendMode === "table" ? "/api/uno/multiplayer/resign" : "/api/uno/resign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(gameMode === "multi-online" && unoMultiBackendMode === "table" ? { code: unoMultiTableCode } : {
        gameId: game.id,
        gameMode, // "ai" or "online"
      }),
    });

    const data = await res.json();

    if (!res.ok) {
      alert(data.error || "Impossible d'abandonner");
      return;
    }

    // Show result instantly
    if (gameMode === "online" || gameMode === "multi-online") {
      setMessage("😢 Tu as abandonné la partie.");
    } else {
      setMessage("😢 Tu as abandonné contre l'IA.");
    }

    setIsPlayerTurn(false);

    // Optional: refresh tokens if backend returns them
    if (data.newBalance) {
      setTokens({ balance: data.newBalance });
    }

  } catch (err) {
    console.error("Erreur resign:", err);
    alert("Erreur lors de l'abandon");
  }

  setIsResigning(false);
};

const drawCard = async () => {
    if (!isPlayerTurn || loading) return;
    if (historyIndex !== null) return; // block while browsing history
    const previousHandLength = playerHand.length;
    setLoading(true);
    const drawEndpoint = gameMode === "multi-online" && unoMultiBackendMode === "table" ? "/api/uno/multiplayer/draw-card" : "/api/uno/draw-card";
    const res = await fetch(drawEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(gameMode === "multi-online" && unoMultiBackendMode === "table" ? { code: unoMultiTableCode } : { gameId: game.id }),
    });

    const data = await res.json();
    if (data.success) {
  setPlayerHand(data.data.playerHand);
  if (data.data.playerHand.length > previousHandLength) {
    const latestCard = data.data.playerHand[data.data.playerHand.length - 1];
    if (latestCard) {
      setDrawnCardAnimation(latestCard);
      playUiTone("draw");
      window.setTimeout(() => setDrawnCardAnimation(null), 500);
    }
  }
  setTopCard(data.data.topCard);
setTurnHistory((prev) => [...prev, data.data.topCard]);
setHistoryIndex(null); // back to live mode

  setAiHandCount(data.data.aiHandCount ?? data.data.opponentHandCount ?? aiHandCount);
  setIsPlayerTurn(data.data.isPlayerTurn);
  setMessage(gameMode === "ai" ? "L'IA joue..." : "Tour suivant...");
  await checkForWinner(game.id);

  const shouldTriggerAiTurn = gameMode === "ai" || (gameMode === "multi-online" && unoMultiBackendMode === "ai");
  if (shouldTriggerAiTurn) {
    setTimeout(() => handleAITurn(game.id), 1000);
  }
}
else {
      setMessage(data.error);
    }
    setLoading(false);
  };
const displayedCard =
  historyIndex === null
    ? topCard
    : turnHistory[historyIndex];

const showUnoMultiBoard = gameMode === "multi-online" && unoMultiBackendMode === "table";

    const returnToLobby = () => {
  setGame(null);
  setGameMode("ai");
  setLobbyMode("classic");
  setPlayerHand([]);
  setAiHandCount(0);
  setTopCard(null);
  setIsPlayerTurn(true);
  setMessage("");
  setPendingCard(null);
  setShowColorPicker(false);
  setTurnHistory([]);
  setHistoryIndex(null);
  setWaitingGameId(null);
  setDrawnCardAnimation(null);
  setPlayedCardAnimation(null);
  setUnoMultiBackendMode(null);
  resetUnoMultiplayerLobby();

  // Optional: refresh available games when returning
  fetchAvailableGames();
};

return (

  <div className="bg-gradient-to-br from-[#001933] mt-12 to-[#000d1a] min-h-screen flex flex-col items-center justify-center text-white px-4 py-8 page-enter">
 <NavigationBar currentPath="/casino" />
    <h1 className="text-3xl mb-2 font-bold">{showUnoMultiBoard || lobbyMode === "multi" ? "UNO Multijoueur" : gameMode === "online" ? "UNO 1v1 en ligne" : "UNO vs IA"}</h1>

    {tokens && (
      <p className="text-yellow-300 mb-4 text-lg">
        Tokens : {tokens.balance}
      </p>
    )}

    {!game ? (
  <div className="w-full max-w-4xl aspect-[2/1] bg-[#0b224f]/85 rounded-[2rem] flex flex-col items-center justify-center shadow-[0_0_28px_rgba(0,229,255,0.2)] border-2 border-[#00e5ff]/35 p-8 text-center casino-surface">
    <div className="mb-6 flex items-center gap-3">
      <button
        onClick={() => setLobbyMode("classic")}
        className={`px-4 py-2 rounded-full font-semibold transition ${lobbyMode === "classic" ? "bg-[#00e5ff] text-[#001933]" : "bg-[#08142f] text-white border border-[#00e5ff]/30"}`}
      >
        Solo & 1v1
      </button>
      <button
        onClick={() => setLobbyMode("multi")}
        className={`px-4 py-2 rounded-full font-semibold transition ${lobbyMode === "multi" ? "bg-[#00e5ff] text-[#001933]" : "bg-[#08142f] text-white border border-[#00e5ff]/30"}`}
      >
        Multiplayer Table
      </button>
    </div>

    {lobbyMode === "classic" ? (
      <>
        <h2 className="text-2xl font-bold mb-6 text-white">Prépare ta partie</h2>

    <label className="mb-6 text-lg font-semibold flex flex-col items-center">
      <span className="mb-2">Mise :</span>
      <input
        type="number"
        value={betAmount}
        onChange={(e) => setBetAmount(Number(e.target.value))}
        className="bg-[#08142f] border border-[#00e5ff]/40 text-white px-3 py-1 rounded text-center w-32"
        min={1}
        max={1000}
      />
    </label>

    <button
      onClick={() => setShowGameModeModal(true)}
      disabled={loading || !!waitingGameId}
      className="px-8 py-3 rounded-full font-bold text-[#031026]
bg-[#f5ff3b] hover:bg-[#edf734]
shadow-[0_0_18px_rgba(245,255,59,0.55),0_0_40px_rgba(245,255,59,0.25)]
hover:scale-105 transition-all duration-300"
    >
      {loading ? "Chargement..." : "Commencer une partie"}
    </button>
<button
  onClick={joinOnlineGame}
  disabled={loading || !!waitingGameId}
  className="mt-4 px-8 py-3 rounded-full font-bold text-[#001933]
bg-[#00e5ff] hover:bg-[#49eeff]
shadow-[0_0_18px_rgba(0,229,255,0.7),0_0_50px_rgba(0,229,255,0.3)]
hover:scale-105 transition-all duration-300"
>
  {loading ? "Recherche..." : "Rejoindre une partie"}
</button>
{waitingGameId && (
  <button
    onClick={cancelWaitingOnlineGame}
    disabled={isCancellingWaitingGame}
    className="mt-3 bg-red-600 hover:bg-red-500 text-white px-8 py-2 rounded-full font-bold shadow-[0_0_12px_rgba(239,68,68,0.35)] transition"
  >
    {isCancellingWaitingGame ? "Annulation..." : "Annuler la partie en attente"}
  </button>
)}

    <div className="mt-6 w-full max-w-md bg-[#08142f] rounded-2xl p-4 border border-[#00e5ff]/30 shadow-[0_0_16px_rgba(0,229,255,0.16)]">
      <div className="flex justify-between items-center mb-3">
  <h3 className="text-lg font-bold">Parties en ligne disponibles</h3>
  <button
    onClick={fetchAvailableGames}
    disabled={isLoadingAvailableGames}
    className="bg-[#00e5ff] hover:bg-[#49eeff] text-[#001933] px-3 py-1 rounded-md text-sm font-semibold shadow-[0_0_10px_rgba(0,229,255,0.35)]"
  >
    {isLoadingAvailableGames ? "..." : "🔄 Refresh"}
  </button>
</div>
      {isLoadingAvailableGames ? (
        <p className="text-sm text-gray-200">Chargement des parties...</p>
      ) : availableGames.length === 0 ? (
        <p className="text-sm text-gray-200">Aucune partie en attente pour le moment.</p>
      ) : (
        <ul className="space-y-2 text-sm">
          {availableGames.slice(0, 6).map((onlineGame) => (
            <li
              key={onlineGame.id}
              className="flex justify-between items-center bg-[#0d335f]/80 border border-[#00e5ff]/20 rounded-lg px-3 py-2"
            >
              <span>
                {onlineGame.hostName} • Mise: {onlineGame.betAmount}
              </span>
              <button
                onClick={() => joinSpecificOnlineGame(onlineGame.id)}
                disabled={!onlineGame.canAfford || loading || !!waitingGameId}
                className={`px-3 py-1 rounded-md font-semibold ${
                  onlineGame.canAfford && !waitingGameId
                    ? "bg-[#00e5ff] hover:bg-[#49eeff] text-[#001933]"
                    : "bg-gray-600 text-gray-200 cursor-not-allowed"
                }`}
              >
                {onlineGame.canAfford ? "Rejoindre" : "Solde insuffisant"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>

    {showGameModeModal && (
      <div className="fixed inset-0 bg-black bg-opacity-60 flex items-center justify-center z-50">
        <div className="bg-[#08142f] text-white border border-[#00e5ff]/40 rounded-2xl p-6 w-full max-w-sm shadow-[0_0_20px_rgba(0,229,255,0.22)]">
          <h3 className="text-xl font-bold mb-4 text-center text-[#FFD700]">Choisir un mode</h3>
          <div className="flex flex-col gap-3">
            <button
              onClick={() => {
                setShowGameModeModal(false);
                initializeGame();
              }}
              className="px-4 py-2 rounded-lg font-bold
bg-[#00e5ff] hover:bg-[#49eeff]
text-[#001933]
shadow-[0_0_14px_rgba(0,229,255,0.6)]
hover:scale-105 transition-all duration-300"
            >
              Jouer contre l'IA
            </button>
            <button
              onClick={createOnlineGame}
              disabled={!!waitingGameId}
              className="px-4 py-2 rounded-lg font-bold
bg-[#00e5ff] hover:bg-[#49eeff]
text-[#001933]
shadow-[0_0_14px_rgba(0,229,255,0.6)]
hover:scale-105 transition-all duration-300"
            >
              Créer une partie multijoueur
            </button>
            <button
              onClick={() => setShowGameModeModal(false)}
              className="bg-red-600 hover:bg-red-500 text-white px-4 py-2 rounded-lg font-semibold shadow-[0_0_10px_rgba(239,68,68,0.35)]"
            >
              Annuler
            </button>
          </div>
        </div>
      </div>
    )}


        {message && (
          <p className="mt-6 text-yellow-300 text-lg font-medium">{message}</p>
        )}
      </>
    ) : (
      <div className="w-full max-w-3xl text-left bg-[#08142f] border border-[#00e5ff]/30 rounded-2xl p-5">
        <h2 className="text-xl font-bold mb-4 text-center">Create UNO Multiplayer Table</h2>
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
                <option value={3}>3 Players</option>
                <option value={4}>4 Players</option>
                <option value={5}>5 Players</option>
                <option value={6}>6 Players</option>
              </select>
              <select value={unoMultiSettings.startingCards} onChange={(e) => setUnoMultiSettings((s) => ({ ...s, startingCards: Number(e.target.value) }))} className="bg-[#001933] border border-[#00e5ff]/35 rounded px-3 py-2">
                <option value={5}>5 starting cards</option>
                <option value={7}>7 starting cards</option>
                <option value={9}>9 starting cards</option>
              </select>
              <select value={unoMultiSettings.turnTimeSeconds} onChange={(e) => setUnoMultiSettings((s) => ({ ...s, turnTimeSeconds: Number(e.target.value) }))} className="bg-[#001933] border border-[#00e5ff]/35 rounded px-3 py-2">
                <option value={20}>20 sec / turn</option>
                <option value={30}>30 sec / turn</option>
                <option value={45}>45 sec / turn</option>
              </select>
            </div>
            <button onClick={createUnoMultiplayerTable} className="mt-4 w-full rounded-lg bg-[#f5ff3b] text-[#031026] font-bold py-2">Create Multiplayer Table</button>
            <div className="mt-3 flex gap-2">
              <input value={unoMultiJoinCode} onChange={(e) => setUnoMultiJoinCode(e.target.value.toUpperCase())} className="flex-1 bg-[#001933] border border-[#00e5ff]/35 rounded px-3 py-2" placeholder="Invite code" />
              <button onClick={joinUnoPrivateTable} className="px-4 py-2 rounded bg-[#00e5ff] text-[#001933] font-semibold">Join Private Game</button>
            </div>

            {unoMultiPublicGames.length > 0 && (
              <div className="mt-4 rounded-lg border border-[#00e5ff]/30 p-3 bg-[#001933]">
                <p className="font-semibold mb-2">Public UNO Tables</p>
                <div className="space-y-2">
                  {unoMultiPublicGames.slice(0, 4).map((entry) => (
                    <div key={entry.code} className="flex items-center justify-between bg-[#0d335f]/80 rounded px-3 py-2">
                      <span className="text-sm">{entry.name} ({entry.occupiedSeats}/{entry.maxPlayers}) • {entry.betAmount}</span>
                      <button onClick={() => joinUnoPublicTable(entry.code)} className="px-3 py-1 rounded bg-[#00e5ff] text-[#001933] font-semibold">Join</button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        ) : (
          <div>
            <p className="text-sm text-[#a5f3fc] mb-2">Table code: <span className="font-bold text-yellow-300">{unoMultiTableCode}</span> · {unoMultiSettings.visibility}</p>
            <p className="text-xs text-gray-300 mb-3">Click empty seats to add AI players (host only), then start the table.</p>
            <label className="inline-flex items-center gap-2 mb-3 text-sm text-yellow-100">
              <input type="checkbox" checked={unoMultiSkipRound} onChange={(e) => setUnoMultiSkipRound(e.target.checked)} />
              Skip next round (you stay at table but won't be selected in next game)
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
                        <button onClick={() => addUnoMultiAiToSeat(seatIndex)} className="w-28 h-12 rounded-xl border border-dashed border-[#00e5ff]/45 text-xs hover:bg-[#00e5ff]/20">+ Add AI</button>
                      )
                    ) : (
                      <div className="w-28 h-12 rounded-xl border border-gray-600 bg-gray-800/40 text-[10px] flex items-center justify-center text-gray-400">Disabled seat</div>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="mt-4 flex gap-3">
              <button onClick={startUnoMultiplayerGame} disabled={!unoMultiHostId} className="flex-1 bg-green-600 hover:bg-green-500 disabled:bg-gray-600 px-4 py-2 rounded font-bold">Start Game</button>
              <button onClick={resetUnoMultiplayerLobby} className="flex-1 bg-red-600 hover:bg-red-500 px-4 py-2 rounded font-bold">Leave Table (out of game only)</button>
            </div>
            {unoMultiPublicGames.length > 0 && (
              <div className="mt-4 rounded-lg border border-[#00e5ff]/30 p-3 bg-[#001933]">
                <p className="font-semibold mb-2">Available multiplayer games</p>
                <div className="space-y-2">
                  {unoMultiPublicGames.slice(0, 6).map((entry) => (
                    <div key={entry.code} className="flex items-center justify-between bg-[#0d335f]/80 rounded px-3 py-2">
                      <span className="text-sm">{entry.name} ({entry.occupiedSeats}/{entry.maxPlayers}) • Bet {entry.betAmount}</span>
                      <button onClick={() => joinUnoPublicTable(entry.code)} className="px-3 py-1 rounded bg-[#00e5ff] text-[#001933] font-semibold">Join Game</button>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {unoMultiMessage && <p className="text-sm text-yellow-200 mt-3">{unoMultiMessage}</p>}
          </div>
        )}
      </div>
    )}
  </div>
) : showUnoMultiBoard ? (
  <div className="w-full max-w-5xl min-h-[640px] bg-green-700/90 rounded-[2.5rem] shadow-2xl border-8 border-green-950 p-6 relative casino-surface overflow-hidden">
    <div className="flex items-center justify-between">
      <h2 className="text-xl font-bold">UNO Multiplayer Table</h2>
      <button onClick={returnToLobby} className="bg-[#f5ff3b] text-[#031026] px-4 py-2 rounded font-bold">Lobby</button>
    </div>
    <p className="text-sm text-[#d1fae5] mt-1">Mode: {unoMultiSettings.visibility} · Bet: {unoMultiSettings.betAmount} · Turn timer: {unoMultiSettings.turnTimeSeconds}s</p>
    <div className="relative w-full h-[520px] mt-4 rounded-full border-8 border-yellow-900/80 bg-green-800/80">
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-center">
        <p className="text-yellow-300 font-semibold mb-2">UNO Draw / Discard</p>
        <div className="flex gap-3 justify-center">
          <UnoBack />
          {topCard ? <UnoCard color={topCard.color} value={topCard.value} onClick={() => {}} /> : <div className="w-16 h-24 rounded-lg bg-[#0f172a]/60 border border-white/25" />}
        </div>
      </div>
      {UNO_MULTI_SEAT_POSITIONS.map((pos, seatIndex) => {
        const player = unoMultiPlayers.find((p) => p.seatIndex === seatIndex);
        if (!player || seatIndex >= unoMultiSettings.maxPlayers) return null;
        return (
          <div key={`${player.id}-${seatIndex}`} className="absolute" style={{ left: pos.left, top: pos.top, transform: "translate(-50%, -50%)" }}>
            <div className={`w-32 rounded-xl border px-2 py-2 text-center ${player.id === unoMultiMyId ? "bg-yellow-300 text-black border-yellow-100" : "bg-[#08142f] border-[#00e5ff]/35 text-white"}`}>
              <p className="text-xs font-bold truncate">{player.type === "ai" ? "🤖" : "👤"} {player.name}</p>
              <p className="text-[11px] opacity-80">Seat {seatIndex + 1}</p>
            </div>
          </div>
        );
      })}
    </div>
  </div>
) : (
  <div className="w-full max-w-5xl min-h-[640px] md:aspect-[2/1] bg-green-700/90 rounded-[2.5rem] flex flex-col justify-between items-center shadow-2xl border-8 border-green-950 p-6 pb-36 relative casino-surface overflow-hidden">
    {gameMode === "multi-online" && unoMultiSettings.visibility === "private" && unoMultiTableCode && (
      <div className="absolute top-3 left-1/2 -translate-x-1/2 bg-black/40 border border-yellow-300/60 rounded px-3 py-1 text-sm">
        Invite code: <span className="font-bold text-yellow-300">{unoMultiTableCode}</span>
      </div>
    )}
    {/* Opponent hand */}
    <div className={`px-4 py-1 rounded-full ${!isPlayerTurn ? "turn-active-glow" : ""}`}>{gameMode === "online" ? "Main adverse:" : gameMode === "multi-online" ? "Autres joueurs:" : "Main de l'IA:"}</div>
    <div className="flex justify-center gap-2 flex-wrap max-w-4xl">
      {gameMode === "multi-online" && unoMultiBackendMode === "table"
        ? unoMultiHandCounts
            .filter((entry) => entry.playerId !== game?.role)
            .sort((a, b) => a.seatIndex - b.seatIndex)
            .map((entry) => (
              <div key={entry.playerId} className={`rounded-xl px-2 py-2 border min-w-[120px] ${unoMultiTurnPlayerId === entry.playerId ? "border-yellow-300 bg-yellow-300/20" : "border-white/25 bg-black/20"}`}>
                <p className="text-xs font-semibold truncate">{entry.type === "ai" ? "🤖" : "👤"} {entry.name}</p>
                <div className="flex gap-1 mt-1 justify-center">{Array(Math.min(entry.count, 8)).fill(0).map((_, i) => <UnoBack key={`${entry.playerId}-${i}`} />)}</div>
                <p className="text-[10px] text-center mt-1">{entry.count} cartes</p>
              </div>
            ))
        : Array(aiHandCount)
            .fill(0)
            .map((_, i) => (
              <UnoBack key={i} />
            ))}
    </div>
    
{showColorPicker && (
  <div className="absolute inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50">
    <div className="bg-white p-8 rounded-2xl shadow-xl text-black flex flex-col items-center gap-6">
      <h2 className="text-xl font-bold mb-2">Choisis une couleur 🎨</h2>
      <div className="grid grid-cols-2 gap-4">
        {[
          { color: "red", label: "Rouge" },
          { color: "blue", label: "Bleu" },
          { color: "green", label: "Vert" },
          { color: "yellow", label: "Jaune" },
        ].map(({ color, label }) => (
          <button
            key={color}
            onClick={() => {
              setShowColorPicker(false);
              sendPlayCard(pendingCard, color); // ✅ send chosen color
            }}
            className="flex flex-col items-center justify-center w-24 h-24 rounded-xl font-bold text-white shadow-lg hover:scale-105 transition-transform"
            style={{ backgroundColor: color }}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  </div>
)}

    {/* Center with arrows + current/past card */}
<div className="flex items-center justify-center gap-6 mb-4">
  {/* Left arrow */}
 <button
  onClick={() =>
    setHistoryIndex((prev) => {
      if (turnHistory.length <= 1) return null;
      if (prev === null) return turnHistory.length - 2; // jump to last turn before live
      return Math.max(prev - 1, 0); // go back but not before first card
    })
  }
  disabled={turnHistory.length <= 1 || historyIndex === 0}
  className="text-3xl font-bold text-yellow-300 hover:scale-110 transition disabled:opacity-30"
  title="Tour précédent"
>
  ⬅️
</button>


  {/* Card in center */}
  <div className="flex flex-col items-center" ref={centerCardRef}>
    Carte actuelle :
    {displayedCard ? (
      <UnoCard
        color={displayedCard.color}
        value={displayedCard.value}
        onClick={() => {}}
      />
    ) : (
      <span className="font-bold ml-2">?</span>
    )}
    {historyIndex !== null && (
      <p className="text-sm text-gray-300 mt-2">
        Historique ({historyIndex + 1}/{turnHistory.length})
      </p>
    )}
  </div>

  {/* Right arrow */}
 <button
  onClick={() =>
    setHistoryIndex((prev) => {
      if (prev === null) return null; // already live
      if (prev >= turnHistory.length - 2) return null; // next step would be live
      return prev + 1;
    })
  }
  disabled={historyIndex === null}
  className="text-3xl font-bold text-yellow-300 hover:scale-110 transition disabled:opacity-30"
  title="Tour suivant"
>
  ➡️
</button>

</div>


    {/* Player hand */}
    <div className={`flex flex-wrap gap-2 justify-center px-3 py-2 rounded-2xl ${isPlayerTurn ? "turn-active-glow" : ""}`}>
      {playerHand.map((card, i) => (
        <UnoCard
          key={i}
          color={card.color}
          value={card.value}
          onClick={(event) => playCard(card, event)}
        />
      ))}
    </div>
{historyIndex === null ? (
  <p className="text-sm text-green-300 mt-2">En direct</p>
) : (
  <p className="text-sm text-gray-300 mt-2">
    Historique ({historyIndex + 1}/{turnHistory.length})
  </p>
)}

    {drawnCardAnimation && (
      <div className="absolute bottom-32 left-1/2 -translate-x-1/2 pointer-events-none z-40 uno-draw-pop">
        <UnoCard color={drawnCardAnimation.color} value={drawnCardAnimation.value} onClick={() => {}} />
      </div>
    )}

    {playedCardAnimation && (
      <div
        className="absolute pointer-events-none z-40 uno-play-slide"
        style={{
          left: "50%",
          bottom: "5.5rem",
          transform: `translate(-50%, 0) translate(${playedCardAnimation.dx}px, ${playedCardAnimation.dy}px)`,
          ["--slide-x"]: `${-playedCardAnimation.dx}px`,
          ["--slide-y"]: `${-playedCardAnimation.dy}px`,
        }}
      >
        <UnoCard color={playedCardAnimation.card.color} value={playedCardAnimation.card.value} onClick={() => {}} />
      </div>
    )}

    {(message.includes("gagné") || message.includes("won")) && (
      <div className="confetti-overlay">
        {Array.from({ length: 26 }).map((_, index) => (
          <span
            key={`uno-confetti-${index}`}
            className="confetti-piece"
            style={{
              left: `${(index * 13) % 100}%`,
              backgroundColor: CONFETTI_COLORS[index % CONFETTI_COLORS.length],
              animationDelay: `${(index % 7) * 0.05}s`,
            }}
          />
        ))}
      </div>
    )}

    {/* Draw & replay buttons */}
    <div className="absolute bottom-6 left-1/2 -translate-x-1/2 flex flex-col items-center relative z-50">
      <button
        onClick={drawCard}
        className="mb-2 px-5 py-2 rounded-full font-bold
bg-[#f5ff3b] hover:bg-[#edf734]
text-[#031026]
shadow-[0_0_16px_rgba(245,255,59,0.5)]
hover:scale-105 transition-all"
      >
        Piocher une carte
      </button>
{game && !message.includes("gagné") && (
  <button
    onClick={resignGame}
    disabled={isResigning}
    className="mt-3 px-6 py-2 rounded-full font-bold text-white
bg-red-600 hover:bg-red-500
shadow-[0_0_18px_rgba(239,68,68,0.7),0_0_40px_rgba(239,68,68,0.3)]
relative z-50
transition-all duration-300"
  >
    {isResigning ? "Abandon..." : "❌ Abandonner"}
  </button>
)}
      {isGameFinished && (
  <div className="flex gap-3 mt-2">
        <button
  onClick={async () => {
    if (gameMode === "ai") {
      setMessage("");
      await initializeGame();
    } else {
      returnToLobby();
    }
  }}
  disabled={loading}
  className="bg-green-600 hover:bg-green-700 text-white px-6 py-2 rounded"
>
  {loading ? "Chargement..." : "Rejouer"}
</button>

<button
  onClick={returnToLobby}
  className="bg-[#f5ff3b] hover:bg-[#f5ff3b] text-white px-6 py-2 rounded"
>
  Lobby
</button>
        </div>
      )}
    </div>
  </div>
)}
{/* RULES - LOBBY */}
<div className="mt-4 w-full max-w-md">
  <button
    onClick={() => setShowRules(!showRules)}
    className="w-full px-6 py-3 rounded-xl font-bold text-left flex justify-between
bg-[#001933] hover:bg-[#002b55]
border border-[#00e5ff]/30
shadow-[0_0_12px_rgba(0,229,255,0.25)]
transition"
  >
    Règles du jeu (UNO)
    <span>{showRules ? "▲" : "▼"}</span>
  </button>

  {showRules && (
    <div className="mt-2 p-6 rounded-2xl text-sm text-left
bg-gradient-to-br from-[#000814] via-[#001933] to-[#000814]
border border-[#00e5ff]/40
shadow-[0_0_20px_rgba(0,229,255,0.25)]
backdrop-blur-sm">
      <h3 className="font-bold mb-2">🎯 Objectif</h3>
      <p className="mb-3">
        Le but est d’être le premier joueur à se débarrasser de toutes ses cartes. 
        Lorsque tu n’as plus de cartes, tu gagnes la partie.
      </p>

      <h3 className="font-bold mb-2">🃏 Règles de base</h3>
      <ul className="list-disc ml-5 space-y-1 mb-3">
        <li>Joue une carte de la même couleur ou du même numéro que la carte au centre</li>
        <li>Si tu ne peux pas jouer, tu dois piocher une carte</li>
        <li>Si la carte piochée est jouable, tu peux la jouer immédiatement</li>
        <li>Les cartes spéciales peuvent changer le sens ou le rythme du jeu</li>
      </ul>

      <h3 className="font-bold mb-2">🔁 Cartes spéciales</h3>
      <ul className="list-disc ml-5 space-y-1 mb-3">
        <li><strong>+2</strong> : Le joueur suivant pioche 2 cartes et passe son tour</li>
        <li><strong>+4</strong> : Le joueur suivant pioche 4 cartes et passe son tour (choix de couleur)</li>
        <li><strong>Skip (Passer)</strong> : Le joueur suivant perd son tour</li>
        <li><strong>Reverse</strong> : Change le sens du jeu</li>
        <li><strong>Wild (Joker)</strong> : Permet de choisir une nouvelle couleur</li>
      </ul>

      <h3 className="font-bold mb-2">⚠️ Règles importantes</h3>
      <ul className="list-disc ml-5 space-y-1">
        <li>Annonce “UNO” quand il te reste une seule carte</li>
        <li>Si tu oublies et qu’un autre joueur le remarque, tu peux être pénalisé</li>
        <li>Le jeu continue jusqu’à ce qu’un joueur n’ait plus de cartes</li>
      </ul>
    </div>
  )}
</div>
  </div>
);
}
