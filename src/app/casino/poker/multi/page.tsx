"use client";

import { useState, useEffect } from "react";
import { Card, evaluateHand } from "../../../lib/handEval";
import { motion, AnimatePresence } from "framer-motion";
import { useRouter, useSearchParams } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import { useSocket } from "../../../../context/SocketProvider";
import useGamePresence from "../../../../hooks/useGamePresence";

type Player = {
  id: string;
  name: string;
  stack: number;
  hand: Card[];
  isAI?: boolean;
  hasFolded?: boolean;
  lastAction?: string;
  currentBet: number;
  seatIndex?: number; // UI seat index (0..5)
  hasActed?: boolean;
};

type Game = {
  id?: string;
  players: Player[];
  community: Card[];
  deck: Card[];
  pot: number;
  currentTurn: number;
  roundStarter?: number;
  stage: "pre-flop" | "flop" | "turn" | "river" | "showdown";
  smallBlind: number;
  bigBlind: number;
  winnerId?: string;
  replayVisible: boolean;
  dealerIndex: number;
  inviteCode?: string;
  waiting?: boolean;
  lastAggressorIndex?: number;
  hostClerkId?: string;
  actionLog?: { text: string; at: number }[];
};

const SUITS = ["♠", "♥", "♦", "♣"];
const VALUES = [
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10",
  "J",
  "Q",
  "K",
  "A",
];

function createDeck(): Card[] {
  return SUITS.flatMap((suit) => VALUES.map((value) => ({ suit, value })));
}
function shuffle(deck: Card[]): Card[] {
  return deck.sort(() => Math.random() - 0.5);
}

function nextActive(start: number, players: Player[]): number {
  let i = start % players.length;
  let safety = 0;

  console.log("➡️ nextActive called", {
    start,
    resolvedIndex: i,
    resolvedPlayer: players[i]?.name,
  });

  while ((players[i]?.hasFolded || !players[i]) && safety < players.length) {
    i = (i + 1) % players.length;
    safety++;
  }

  return i;
}

function getActiveIndices(players: Player[]): number[] {
  return players.map((p, i) => (!p.hasFolded ? i : -1)).filter((i) => i !== -1);
}

function nextActiveFrom(currentIndex: number, players: Player[]): number {
  const active = getActiveIndices(players);
  if (active.length === 0) return currentIndex;

  const pos = active.indexOf(currentIndex);
  if (pos === -1) return active[0];

  return active[(pos + 1) % active.length];
}

export default function PokerPage() {
  const { user } = useUser();
  const { socket } = useSocket();
  const clerkId = user?.id;
  const myId = clerkId;
  const router = useRouter();
  const searchParams = useSearchParams();
  const isSpectator = searchParams.get("spectator") === "1";

  const spectatorGameId = searchParams.get("gameId");
  const [name, setName] = useState("");
  const [game, setGame] = useState<Game | null>(null);
  useGamePresence({
    gameKey: "poker",
    gameId: Number(game?.id),
    enabled: !isSpectator && Boolean(game?.id),
  });
  const [raiseAmount, setRaiseAmount] = useState(50);
  const [balance, setBalance] = useState<number>(0);
  const [inviteCode, setInviteCode] = useState("");
  const [joiningGame, setJoiningGame] = useState(false);
  const [isPrivate, setIsPrivate] = useState(true);
  const [leaveAfterHand, setLeaveAfterHand] = useState(false);
  const [isProcessingTurn, setIsProcessingTurn] = useState(false);
  const [turnTimer, setTurnTimer] = useState(60);
  const [isMyTurn, setIsMyTurn] = useState(false);
  const [publicGameCode, setPublicGameCode] = useState<string | null>(null);
  const [showJoinForm, setShowJoinForm] = useState(false);
  const [aiThinking, setAiThinking] = useState(false);
  const [aiInfoOpen, setAiInfoOpen] = useState(false);
  const [selectedAi, setSelectedAi] = useState<Player | null>(null);
  const [turnTimeLimit, setTurnTimeLimit] = useState(60);

  // UI modal / seat state
  const [seatModalOpen, setSeatModalOpen] = useState(false);
  const [selectedSeat, setSelectedSeat] = useState<number | null>(null);
  const [aiNameInput, setAiNameInput] = useState("");
  const [aiStackInput, setAiStackInput] = useState<number>(1000);

  const maxCurrentBet = (players: Player[]) =>
    Math.max(...players.map((p) => p.currentBet || 0));
  const appendActionLog = (state: Game, text: string): Game => ({
    ...state,
    actionLog: [{ text, at: Date.now() }, ...(state.actionLog ?? [])].slice(
      0,
      5,
    ),
  });

  const saveGameState = async (state: Game) => {
    if (!state?.inviteCode) return;
    try {
      await fetch("/api/poker/game-state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gameCode: state.inviteCode, state }),
      });
    } catch (err) {
      console.error("Failed to save game state", err);
    }
  };

  const fetchGameState = async (code: string) => {
    try {
      const res = await fetch(
        `/api/poker/game-state?code=${encodeURIComponent(code)}`,
      );
      if (!res.ok) return;
      const data = await res.json();
      if (data?.game) {
        setGame((prev) => {
          if (!prev) return data.game;
          if (
            !Array.isArray(prev.players) ||
            !Array.isArray(data.game.players)
          ) {
            return data.game;
          }

          const localPlayersById = new Map(prev.players.map((p) => [p.id, p]));
          const mergedPlayers = data.game.players.map(
            (remotePlayer: Player) => {
              const localPlayer = localPlayersById.get(remotePlayer.id);
              if (!localPlayer) return remotePlayer;

              // Preserve fold state if local action happened but remote poll has not caught up yet.
              if (localPlayer.hasFolded && !remotePlayer.hasFolded) {
                return {
                  ...remotePlayer,
                  hasFolded: true,
                  lastAction:
                    localPlayer.lastAction ||
                    remotePlayer.lastAction ||
                    "Folded",
                  hasActed: true,
                };
              }

              return remotePlayer;
            },
          );

          return {
            ...data.game,
            players: mergedPlayers,
          };
        });
      }
    } catch (err) {
      console.error("Failed to fetch game state", err);
    }
  };

  const fetchGameStateById = async (id: number) => {
    try {
      const res = await fetch(`/api/poker/game-state?gameId=${id}`);
      if (!res.ok) return;
      const data = await res.json();
      if (data?.game) setGame(data.game);
    } catch (err) {
      console.error("Failed to fetch game state by id", err);
    }
  };

  const fetchUserTokens = async () => {
    try {
      const res = await fetch("/api/get-user-tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
      });
      const data = await res.json();
      if (data.success) {
        setBalance(parseFloat(data.data.balance));
        setName(data.data.name || "");
      } else {
        console.error("Failed to fetch tokens:", data.error);
      }
    } catch (err) {
      console.error("Error fetching tokens:", err);
    }
  };

  const leaveCurrentGame = async () => {
    if (!game?.inviteCode) return;
    try {
      await fetch("/api/poker/leave-game", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gameCode: game.inviteCode }),
      });
      socket?.emit("room_event", {
        roomId: "lobby:poker",
        event: "lobby:updated",
      });
    } catch (err) {
      console.error("Failed to leave poker game", err);
    }
  };

  function findFirstActorIndex(
    players: Player[],
    dealerIndex: number,
    stage: Game["stage"],
  ): number {
    if (players.length === 0) return 0;

    // Pre-flop → first after BB
    if (stage === "pre-flop") {
      const bbIndex = (dealerIndex + 2) % players.length;
      return nextActive(bbIndex + 1, players);
    }

    // Flop / Turn / River → first after dealer
    return nextActive(dealerIndex + 1, players);
  }

  const [availablePublicGames, setAvailablePublicGames] = useState<number>(0);
  const [publicGameList, setPublicGameList] = useState<
    {
      gameCode: string;
      hostName: string;
      occupiedSeats: number;
      maxPlayers: number;
      openSeats: number;
    }[]
  >([]);

  const [waitingPlayers, setWaitingPlayers] = useState<
    { id: string; name: string; level?: number }[]
  >([]);

  const fetchWaitingPlayers = async () => {
    try {
      // try known endpoints, fall back gracefully
      const endpoints = [
        "/api/poker/waiting-players",
        "/api/poker/public-waiting",
        "/api/poker/public-queue",
      ];
      let data: any = null;
      for (const ep of endpoints) {
        try {
          const res = await fetch(ep);
          if (!res.ok) continue;
          data = await res.json();
          if (Array.isArray(data)) break;
          if (data.players && Array.isArray(data.players)) {
            data = data.players;
            break;
          }
          if (data.waiting && Array.isArray(data.waiting)) {
            data = data.waiting;
            break;
          }
        } catch (e) {
          continue;
        }
      }
      if (!data) {
        // fallback: show a simple placeholder count based on availablePublicGames
        setWaitingPlayers(
          Array.from({ length: availablePublicGames }, (_, i) => ({
            id: `fallback_${i}`,
            name: `Player ${i + 1}`,
          })),
        );
        return;
      }
      // normalize to {id,name}
      const norm = data.map((p: any, idx: number) => ({
        id: p.id || p.playerId || `p_${idx}`,
        name: p.name || p.displayName || p.player || myId,
        level: p.level,
      }));
      setWaitingPlayers(norm);
    } catch (err) {
      console.error("Failed to fetch waiting players", err);
      setWaitingPlayers([]);
    }
  };

  useEffect(() => {
    if (isSpectator) return;
    const params = new URLSearchParams(window.location.search);
    const code = params.get("gameCode");
    if (code) {
      setInviteCode(code);
      joinGame(code);
    }
  }, [isSpectator]);

  const fetchPublicGamesCount = async () => {
    try {
      const res = await fetch("/api/poker/public-games", { cache: "no-store" });
      const data = await res.json();
      const games = Array.isArray(data.games) ? data.games : [];
      setAvailablePublicGames(data.count || games.length || 0);
      setPublicGameList(games);
    } catch (err) {
      console.error("Error fetching public games:", err);
      setAvailablePublicGames(0);
      setPublicGameList([]);
    }
  };

  useEffect(() => {
    if (isSpectator) return;
    fetchUserTokens();
    fetchPublicGamesCount();
  }, [isSpectator]);

  useEffect(() => {
    if (isSpectator) return;
    if (!socket) return;
    const roomId = "lobby:poker";
    const handleLobbyUpdate = () => fetchPublicGamesCount();
    socket.emit("join_room", { roomId });
    socket.on("lobby:updated", handleLobbyUpdate);
    return () => {
      socket.emit("leave_room", { roomId });
      socket.off("lobby:updated", handleLobbyUpdate);
    };
  }, [socket, isSpectator]);

  // Multiplayer Waiting List Auto-Refresh
  useEffect(() => {
    if (isSpectator) return;
    const interval = setInterval(() => {
      fetchPublicGamesCount();
    }, 3000);

    return () => clearInterval(interval);
  }, [isSpectator]);

  useEffect(() => {
    if (!isSpectator || !spectatorGameId) return;
    const parsedId = Number(spectatorGameId);
    if (!Number.isFinite(parsedId)) return;
    fetchGameStateById(parsedId);
    const interval = setInterval(() => fetchGameStateById(parsedId), 1500);
    return () => clearInterval(interval);
  }, [isSpectator, spectatorGameId]);

  useEffect(() => {
    if (isSpectator || !game?.inviteCode) return;
    const interval = setInterval(() => {
      fetchGameState(game.inviteCode!);
    }, 1500);
    return () => clearInterval(interval);
  }, [game?.inviteCode, isSpectator]);

  // Turn timer effect — runs whenever the current turn changes
  useEffect(() => {
    if (!game) return;

    const currentPlayer = game.players[game.currentTurn];
    const isPlayerTurn = currentPlayer && currentPlayer.id === myId;
    setIsMyTurn(isPlayerTurn);
    setTurnTimer(turnTimeLimit); // reset every time the turn changes

    if (!isPlayerTurn || game.stage === "showdown" || game.waiting) return;

    // Start countdown only if it's your turn
    const interval = setInterval(() => {
      setTurnTimer((t) => {
        if (t <= 1) {
          clearInterval(interval);
          const freshGame = game;
          const timeoutPlayer = freshGame.players[freshGame.currentTurn];
          if (!timeoutPlayer || timeoutPlayer.id !== myId) return 0;
          const highestBet = Math.max(
            ...freshGame.players.map((p) => p.currentBet || 0),
          );
          const myCurrentBet = timeoutPlayer.currentBet || 0;
          performAction(myCurrentBet >= highestBet ? "check" : "call");
          return 0;
        }
        return t - 1;
      });
    }, 1000);

    // cleanup
    return () => clearInterval(interval);
  }, [game?.currentTurn, game, myId, turnTimeLimit]);

  // -----------------------------
  // Seat positions (aligned around the table)
  // Table: 700x400 centered in 900x600 container
  // Player stays at bottom-center (same as before)
  // -----------------------------
  const seatPositions = [
    { left: 450, top: 30 }, // 0: top-center
    { left: 700, top: 80 }, // 1: top-right (lowered & slightly left)
    { left: 700, top: 450 }, // 2: bottom-right
    { left: 450, top: 480 }, // 3: bottom-center (YOU)
    { left: 200, top: 450 }, // 4: bottom-left
    { left: 200, top: 80 }, // 5: top-left (lowered & slightly right)
  ];

  // ======== CREATE GAME =========
  // Now player creates the game alone (no dropdown). Player will be at seatIndex 3.
  async function createGame(dealerIndex = 0) {
    if (!name.trim()) return alert("Enter your name first");

    const deck = shuffle(createDeck());
    // only the human player initially; seatIndex = 3 (bottom-center)

    try {
      const res = await fetch("/api/poker/create-game", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxPlayers: 6, isPrivate, playerName: name }),
      });

      if (!res.ok) return alert("Failed to create game on server");
      const data = await res.json();

      const newGame: Game = {
        players: [],
        community: [],
        deck,
        pot: 0,
        currentTurn: 0,
        stage: "pre-flop",
        smallBlind: 10,
        bigBlind: 20,
        replayVisible: false,
        dealerIndex,
        inviteCode: data.gameCode,
        waiting: true,
        hostClerkId: data.hostClerkId || clerkId,
      };

      setGame(newGame);
      if (data.gameCode) {
        await saveGameState(newGame);
        socket?.emit("room_event", {
          roomId: "lobby:poker",
          event: "lobby:updated",
        });
        router.replace(`/casino/poker/multi?gameCode=${data.gameCode}`);
      }
    } catch (err) {
      console.error("Error creating game:", err);
      alert("Error creating game. Check console.");
    }
  }

  // startGame unchanged (deals from deck to players array as-is)
  function startGame() {
    if (!game) return;

    const newDeck =
      game.deck.length > 0 ? [...game.deck] : shuffle(createDeck());

    const players = game.players.map((p) => ({
      ...p,
      hand: [newDeck.pop()!, newDeck.pop()!],
      hasFolded: false,
      lastAction: "",
      currentBet: 0,
      hasActed: false, // ✅
    }));

    // Setup blinds
    const sbIndex = (game.dealerIndex + 1) % players.length;
    const bbIndex = (game.dealerIndex + 2) % players.length;
    players[sbIndex].stack -= game.smallBlind;
    players[sbIndex].currentBet = game.smallBlind;
    players[sbIndex].lastAction = "Small Blind";

    players[bbIndex].stack -= game.bigBlind;
    players[bbIndex].currentBet = game.bigBlind;
    players[bbIndex].lastAction = "Big Blind";

    const firstActorIndex = findFirstActorIndex(
      players,
      game.dealerIndex,
      "pre-flop",
    );

    console.log("🟢 GAME START TURN CHECK", {
      stage: "pre-flop",
      dealerIndex: game.dealerIndex,
      firstActorIndex,
      firstActorName: players[firstActorIndex]?.name,
      seating: players.map((p) => ({
        seat: p.seatIndex,
        name: p.name,
        folded: p.hasFolded,
      })),
    });

    const nextGame = {
      ...game,
      players,
      deck: newDeck,
      pot: game.smallBlind + game.bigBlind,
      currentTurn: firstActorIndex,
      roundStarter: firstActorIndex,
      waiting: false,
      lastAggressorIndex: firstActorIndex,
    };
    setGame(nextGame);
    saveGameState(nextGame);

    console.log(
      "TURN DEBUG:",
      players.map((p) => ({ name: p.name, seat: p.seatIndex })),
      "firstTurn:",
      players[firstActorIndex]?.name,
    );
  }

  //JOIN Game
  async function joinGame(codeOverride?: string) {
    const codeToUse = (codeOverride ?? inviteCode).trim().toUpperCase();
    if (!codeToUse) return alert("Enter invite code!");
    if (!clerkId) return alert("Not authenticated");

    setJoiningGame(true);

    try {
      const res = await fetch("/api/poker/join-game", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: codeToUse,
          playerName: name,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setJoiningGame(false);
        return alert(data?.error || "Failed to join game");
      }

      const serverGame = data.game;
      socket?.emit("room_event", {
        roomId: "lobby:poker",
        event: "lobby:updated",
      });

      const players: Player[] = (serverGame.players || [])
        .filter((p: any) => p.clerkId)
        .map((p: any) => ({
          id: p.clerkId,
          name: p.name || "Player",
          seatIndex: p.seat,
          stack: Number(p.stack ?? 1000),
          hand: [],
          isAI: !!p.isAI,
          hasFolded: false,
          lastAction: "",
          currentBet: 0,
        }));

      setGame({
        id: serverGame.id,
        inviteCode: serverGame.gameCode,
        players,
        community: [],
        deck: [],
        pot: 0,
        currentTurn: 0,
        stage: "pre-flop",
        smallBlind: 10,
        bigBlind: 20,
        replayVisible: false,
        dealerIndex: serverGame.dealerIndex ?? 0,
        waiting: true,
        hostClerkId: serverGame?.playerPositions?.hostClerkId,
      });
      setInviteCode(codeToUse);
      await fetchGameState(codeToUse);

      // ✅ set balance for THIS user only
      const me = players.find((p) => p.id === clerkId);
      if (me) setBalance(me.stack);
    } catch (err) {
      console.error("Join game error:", err);
      alert("Failed to join game");
    } finally {
      setJoiningGame(false);
    }
  }

  async function joinPublicGame(gameCode?: string) {
    setJoiningGame(true);
    try {
      const res = await fetch("/api/poker/join-public", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ playerName: name, gameCode }),
      });

      const data = await res.json();
      if (!res.ok) return alert(data.error || "No public games available");

      setInviteCode(data.gameCode);
      await joinGame(data.gameCode);
      socket?.emit("room_event", {
        roomId: "lobby:poker",
        event: "lobby:updated",
      });
    } catch (err) {
      console.error("Join public game error:", err);
      alert("Failed to join public game. See console.");
    } finally {
      setJoiningGame(false);
    }
  }

  // ======== AI Turn Logic, performAction, advanceStage, showdown, etc. (kept intact) ========
  useEffect(() => {
    if (!game) return;
    if (game.stage === "showdown" || game.waiting) return;

    const current = game.players[game.currentTurn];
    if (!current || current.hasFolded || !current.isAI) return;

    const timer = setTimeout(
      () => {
        try {
          const hs = evaluateHand(current.hand, game.community);
          const highest = Math.max(...game.players.map((p) => p.currentBet));

          let action: "check" | "call" | "raise" | "fold" | "bet20";

          if (current.currentBet < highest) {
            action = "call";
          } else if (Math.random() < 0.35) {
            action = "bet20"; // force visible chips
          } else {
            action = "check";
          }

          if (
            hs.includes("Three") ||
            hs.includes("Straight") ||
            hs.includes("Flush")
          ) {
            action = "raise";
          } else if (hs.includes("Pair") || hs.includes("Two Pair")) {
            action = "call";
          } else if (Math.random() < 0.2) {
            action = "fold";
          } else {
            action = "call";
          }

          performAction(action as any, true);
        } finally {
          setAiThinking(false); // 🔒 ALWAYS unlock
        }
      },
      800 + Math.random() * 600,
    );

    setAiThinking(true);

    return () => clearTimeout(timer);
  }, [game?.currentTurn, game?.stage]);

  function checkForWinner(players: Player[], pot: number) {
    const activePlayers = players.filter((p) => !p.hasFolded);
    if (activePlayers.length === 1) {
      const winner = activePlayers[0];
      const updatedPlayers = players.map((p) =>
        p.id === winner.id ? { ...p, stack: p.stack + pot } : p,
      );

      if (winner.id === myId) {
        setBalance((prev) => prev + pot);
        fetchUserTokens();
      }

      setGame((g) => {
        if (!g) return g;
        const nextState = appendActionLog(
          {
            ...g,
            players: updatedPlayers,
            winnerId: winner.id,
            pot: 0,
            stage: "showdown",
            replayVisible: true,
          },
          `${winner.name} wins by fold`,
        );
        saveGameState(nextState);
        return nextState;
      });

      return true;
    }
    return false;
  }

  function performAction(
    action: "check" | "call" | "raise" | "fold" | "bet20",
    isAI = false,
  ) {
    if (!game) return;

    const players = game.players.map((p) => ({ ...p }));
    const currentIndex = game.currentTurn;
    const current = players[currentIndex];
    if (!current || current.hasFolded) return;
    current.hasActed = true;
    const highest = maxCurrentBet(players);
    let potNew = game.pot;

    if (action === "fold") {
      current.hasFolded = true;
      current.lastAction = "Folded";
      if (checkForWinner(players, potNew)) return;
    } else if (action === "call") {
      const toCall = Math.max(0, highest - (current.currentBet || 0));
      if (toCall > 0) {
        const actual = Math.min(toCall, current.stack);
        current.stack -= actual;
        current.currentBet += actual;
        potNew += actual;
        current.lastAction = `Called ${actual}`;
        if (checkForWinner(players, potNew)) return;

        if (current.id === myId) {
          setBalance((prev) => Math.max(prev - actual, 0));
          fetchUserTokens();
        }
      } else {
        current.lastAction = "Check";
      }
    } else if (action === "bet20") {
      const betSize = 20;
      const actual = Math.min(betSize, current.stack);
      current.stack -= actual;
      current.currentBet += actual;
      potNew += actual;
      current.lastAction = `Bet ${betSize}`;
      game.lastAggressorIndex = currentIndex;

      players.forEach((p, i) => {
        if (i !== currentIndex && !p.hasFolded) {
          p.hasActed = false;
        }
      });
      if (current.id === myId) {
        setBalance((prev) => Math.max(prev - actual, 0));
        fetchUserTokens();
      }
    } else if (action === "raise") {
      const targetBet = Math.max(raiseAmount, highest);
      const chipsNeeded = Math.max(0, targetBet - (current.currentBet || 0));
      const actual = Math.min(chipsNeeded, current.stack);
      current.stack -= actual;
      current.currentBet += actual;
      potNew += actual;
      current.lastAction =
        chipsNeeded > 0 ? `Raised to ${current.currentBet}` : "Call";
      game.lastAggressorIndex = currentIndex;

      players.forEach((p, i) => {
        if (i !== currentIndex && !p.hasFolded) {
          p.hasActed = false;
        }
      });
      if (current.id === myId) {
        setBalance((prev) => Math.max(prev - actual, 0));
      }
    } else if (action === "check") {
      // You can only check if no bet to call
      if (current.currentBet === highest) {
        current.lastAction = "Check";
      } else {
        // safety fallback — treat illegal check as call
        const toCall = highest - current.currentBet;
        const actual = Math.min(toCall, current.stack);
        current.stack -= actual;
        current.currentBet += actual;
        potNew += actual;
        current.lastAction = `Called ${actual}`;

        if (current.id === myId) {
          setBalance((prev) => Math.max(prev - actual, 0));
          fetchUserTokens();
        }
      }
    }

    function getActiveIndices(players: Player[]): number[] {
      return players
        .map((p, i) => (!p.hasFolded ? i : -1))
        .filter((i) => i !== -1);
    }

    const activePlayers = players.filter((p) => !p.hasFolded);
    const highestBet = Math.max(...players.map((p) => p.currentBet));
    const actionSummary = `${current.name}: ${current.lastAction || action}`;

    // 🛑 If only one player remains → instant win
    if (activePlayers.length === 1) {
      checkForWinner(players, potNew);
      return;
    }

    // 🛑 If everyone has matched the bet → end betting round
    const bettingComplete = activePlayers.every(
      (p) => p.hasActed && p.currentBet === highestBet,
    );

    if (bettingComplete) {
      setGame((g) => {
        if (!g) return g;
        const nextState = appendActionLog(
          { ...g, players, pot: potNew } as Game,
          actionSummary,
        );
        saveGameState(nextState);
        return nextState;
      });

      setTimeout(() => advanceStage(), 500);
      return;
    }

    // ▶️ Otherwise → advance to next ACTIVE player
    const nextTurn = nextActiveFrom(currentIndex, players);

    setGame((g) => {
      if (!g) return g;
      const nextState = appendActionLog(
        { ...g, players, pot: potNew, currentTurn: nextTurn } as Game,
        actionSummary,
      );
      saveGameState(nextState);
      return nextState;
    });
  }

  async function advanceStage() {
    if (!game) return;
    const deck = [...game.deck];
    const comm = [...game.community];
    const playersReset = game.players.map((p) => ({
      ...p,
      currentBet: 0,
      hasActed: false, // ✅
    }));

    let nextStage: Game["stage"] = game.stage;

    if (game.stage === "pre-flop") {
      // Deal all 3 flop cards at once, small visual delay
      await new Promise((res) => setTimeout(res, 400));
      comm.push(deck.pop()!, deck.pop()!, deck.pop()!);
      nextStage = "flop";
    } else if (game.stage === "flop") {
      await new Promise((res) => setTimeout(res, 400));
      comm.push(deck.pop()!);
      nextStage = "turn";
    } else if (game.stage === "turn") {
      await new Promise((res) => setTimeout(res, 400));
      comm.push(deck.pop()!);
      nextStage = "river";
    } else if (game.stage === "river") {
      showdown();
      return;
    }

    const nextDealer = (game.dealerIndex + 1) % game.players.length;
    const firstToAct = findFirstActorIndex(playersReset, nextDealer, nextStage);

    console.log("🟡 STAGE ADVANCE TURN CHECK", {
      stage: nextStage,
      dealerIndex: nextDealer,
      firstActorIndex: firstToAct,
      firstActorName: playersReset[firstToAct]?.name,
      seating: playersReset.map((p) => ({
        seat: p.seatIndex,
        name: p.name,
        folded: p.hasFolded,
      })),
    });

    const nextGame = {
      ...game,
      deck,
      community: comm,
      stage: nextStage,
      players: playersReset,
      currentTurn: firstToAct,
      roundStarter: firstToAct,
      lastAggressorIndex: firstToAct,
    };
    setGame(nextGame);
    saveGameState(nextGame);
  }

  function showdown() {
    if (!game) return;
    const active = game.players.filter((p) => !p.hasFolded);
    let winner = active[0],
      best = -1;
    active.forEach((p) => {
      const label = evaluateHand(p.hand, game.community);
      let score = 1;
      if (label.includes("Royal")) score = 10;
      else if (label.includes("Straight Flush")) score = 9;
      else if (label.includes("Four")) score = 8;
      else if (label.includes("Full")) score = 7;
      else if (label.includes("Flush")) score = 6;
      else if (label.includes("Straight")) score = 5;
      else if (label.includes("Three")) score = 4;
      else if (label.includes("Two Pair")) score = 3;
      else if (label.includes("Pair")) score = 2;
      if (score > best) {
        best = score;
        winner = p;
      }
    });

    const updated = game.players.map((p) =>
      p.id === winner.id ? { ...p, stack: p.stack + game.pot } : p,
    );

    if (winner.id === myId) {
      setBalance((prev) => prev + game.pot);
      fetchUserTokens();
    }

    const nextGame: Game = appendActionLog(
      {
        ...game,
        players: updated,
        winnerId: winner.id,
        pot: 0,
        stage: "showdown",
        replayVisible: true,
      },
      `${winner.name} wins at showdown`,
    );
    setGame(nextGame);
    saveGameState(nextGame);
    if (leaveAfterHand) {
      setTimeout(() => {
        leaveCurrentGame().finally(() => {
          window.location.href = "/casino/poker";
        });
      }, 2000);
    }
  }

  function replayHand() {
    if (!game) return;

    const nextDealer = (game.dealerIndex + 1) % game.players.length;
    const handsPlayed = (game as any).handsPlayed ?? 0;
    const newSmallBlind =
      handsPlayed > 0 && handsPlayed % 3 === 0
        ? game.smallBlind * 2
        : game.smallBlind;
    const newBigBlind =
      handsPlayed > 0 && handsPlayed % 3 === 0
        ? game.bigBlind * 2
        : game.bigBlind;

    const newDeck = shuffle(createDeck());
    const resetPlayers = game.players.map((p) => ({
      ...p,
      hand: [],
      currentBet: 0,
      hasFolded: false,
      lastAction: "",
    }));

    const nextGame: Game = {
      ...game,
      dealerIndex: nextDealer,
      players: resetPlayers,
      deck: newDeck,
      community: [],
      pot: 0,
      currentTurn: 0,
      roundStarter: undefined,
      stage: "pre-flop",
      winnerId: undefined,
      replayVisible: false,
      smallBlind: newSmallBlind,
      bigBlind: newBigBlind,
      waiting: true,
    };
    setGame(nextGame);
    saveGameState(nextGame);
  }

  function isSeatAvailableForHuman(seatIndex: number) {
    if (!game) return false;

    // seat already taken?
    const occupied = game.players.some((p) => p.seatIndex === seatIndex);
    if (occupied) return false;

    // only allow humans before game starts
    if (!game.waiting) return false;

    return true;
  }

  // ---- Seat click: open modal to add AI or invite (we only do AI add now) ----
  function handleSeatClick(seatIndex: number) {
    if (!game) return alert("Create or join a game first.");

    if (!game.waiting) return alert("Seats are locked once the game starts.");

    const occupied = game.players.some((p) => p.seatIndex === seatIndex);
    if (occupied) return alert("Seat already taken.");

    setSelectedSeat(seatIndex);
    setSeatModalOpen(true);
  }

  async function sitAsHuman() {
    if (selectedSeat === null || !game || !clerkId) return;

    // HARD GUARD — never allow duplicates
    if (game.players.some((p) => p.id === clerkId)) {
      alert("You are already seated.");
      return;
    }

    const res = await fetch("/api/poker/sit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        gameCode: game.inviteCode,
        seatIndex: selectedSeat,
        playerName: name,
      }),
    });

    const data = await res.json();
    if (!res.ok) return alert(data.error || "Failed to sit");

    await fetchGameState(game.inviteCode!);
    setSeatModalOpen(false);
    setSelectedSeat(null);
  }

  async function addAiToSeat() {
    if (!game || selectedSeat === null) return;
    if (game.hostClerkId && game.hostClerkId !== clerkId) {
      alert("Only host can add AIs.");
      return;
    }

    const existingAIs = game.players.filter((p) => p.isAI).length;
    const autoName = `AI ${existingAIs + 1}`;
    const nameToUse = aiNameInput.trim() || autoName;

    const res = await fetch("/api/poker/sit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        gameCode: game.inviteCode,
        seatIndex: selectedSeat,
        isAI: true,
        playerName: nameToUse,
        aiStack: Number(aiStackInput) || 1000,
      }),
    });
    const data = await res.json();
    if (!res.ok) return alert(data.error || "Failed to add AI");

    await fetchGameState(game.inviteCode!);
    setSeatModalOpen(false);
    setSelectedSeat(null);
  }

  // helper to find player at a seat
  function playerAtSeat(seatIndex: number) {
    return game?.players.find((p) => p.seatIndex === seatIndex) ?? null;
  }
  const isHost = !!(game && clerkId && game.hostClerkId === clerkId);

  const me = game?.players.find((p) => p.id === myId);
  const highestBetInRound = game
    ? Math.max(...game.players.map((p) => p.currentBet || 0))
    : 0;
  const toCallAmount = Math.max(0, highestBetInRound - (me?.currentBet || 0));
  const canUseBetShortcut =
    game?.stage !== "pre-flop" && highestBetInRound === 0;

  if (showJoinForm) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-br from-[#001933] to-[#000d1a] text-white">
        <div className="absolute top-4 left-4">
          <button
            onClick={() => setShowJoinForm(false)}
            className="bg-[#FFD700] hover:bg-[#ffe14f] text-[#030817] px-4 py-2 rounded font-bold transition shadow-[0_0_14px_rgba(255,215,0,0.45)]"
          >
            ← Back
          </button>
        </div>

        <div className="p-6 bg-[#0b224f]/85 border border-[#00e5ff]/30 rounded shadow-[0_0_24px_rgba(0,229,255,0.2)] w-96 text-center">
          <h1 className="text-2xl mb-4">Join a Private Game</h1>

          <input
            placeholder="Enter Invite Code"
            value={inviteCode}
            onChange={(e) => setInviteCode(e.target.value)}
            className="w-full rounded-lg border border-[#00e5ff]/30 bg-[#001933]/60 px-3 py-2 text-[#d8fbff] placeholder:text-[#7dd3fc]/40 focus:outline-none focus:border-[#00e5ff] focus:shadow-[0_0_10px_rgba(0,229,255,0.4)] transition mb-2"
          />

          <button
            onClick={() => joinGame()}
            className="mb-2 w-full rounded-lg border border-[#00e5ff]/70 bg-[#00e5ff]/20 px-4 py-2 text-sm font-medium text-[#d8fbff] hover:bg-[#00e5ff]/55 active:scale-95 transition shadow-[0_0_12px_rgba(0,229,255,0.3)]"
          >
            Join Game
          </button>

          <button
            onClick={() => setShowJoinForm(false)}
            className="w-full rounded-lg border border-red-500/70 bg-red-500/20 px-4 py-2 text-sm font-medium text-red-200 hover:bg-red-500/55 active:scale-95 transition shadow-[0_0_14px_rgba(239,68,68,0.35)]"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (isSpectator) {
    if (!game) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-[#001933] to-[#000d1a] text-white">
          Loading poker match...
        </div>
      );
    }

    return (
      <div className="min-h-screen bg-gradient-to-br from-[#001933] to-[#000d1a] text-white p-6">
        <h1 className="text-3xl font-bold mb-2">Poker Spectate</h1>
        <p className="text-sm text-slate-300 mb-4">Live POV overlay</p>
        <div className="mb-4 rounded border border-yellow-500/30 bg-black/30 px-4 py-2">
          💰 POT: {game.pot}
        </div>
        <div className="mb-4 flex gap-2">
          {(game.community || []).map((c: Card, i: number) => (
            <motion.div
              key={`${c?.suit}-${c?.value}-${i}`}
              initial={{ rotateY: 90, opacity: 0, y: -20 }}
              animate={{ rotateY: 0, opacity: 1, y: 0 }}
              transition={{ duration: 0.45, delay: i * 0.12 }}
              className={`w-16 h-24 rounded-xl flex items-center justify-center font-bold text-xl shadow-xl border-2
      ${
        c?.suit === "♥" || c?.suit === "♦"
          ? "bg-white text-red-600 border-red-300"
          : "bg-white text-black border-slate-400"
      }
    `}
            >
              {c?.value}
              {c?.suit}
            </motion.div>
          ))}
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {(game.players || []).map((p: Player) => (
            <div
              key={p.id}
              className="rounded border border-cyan-400/30 bg-black/25 p-3"
            >
              <p className="font-semibold">{p.name}</p>
              <p className="text-xs text-slate-300">
                Stack: {p.stack} • Bet: {p.currentBet}
              </p>
              <p className="text-xs text-slate-300">
                {p.hasFolded ? "Folded" : p.lastAction || "Active"}
              </p>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // ==== RENDER ====
  if (!game) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-br from-[#001933] to-[#000d1a] text-white">
        <div className="absolute top-4 left-4">
          <a href="/casino">
            <button className="w-full rounded-lg border border-[#FFFF33]/70 bg-[#FFFF33]/20 px-4 py-2 text-sm font-medium text-[#d8fbff] hover:bg-[#FFFF33]/55 active:scale-95 transition mb-2">
              ← Return to Casino
            </button>
          </a>
        </div>

        <div className="p-6 bg-[#0b224f]/85 border border-[#00e5ff]/30 rounded shadow-[0_0_24px_rgba(0,229,255,0.2)] w-96 text-center mb-4">
          <h1
            className="text-2xl mb-4 font-extrabold text-transparent bg-clip-text 
  bg-gradient-to-r from-yellow-300 via-amber-400 to-yellow-300 
  drop-shadow-[0_0_8px_rgba(255,223,0,0.6)] tracking-widest uppercase animate-shimmer-elegant"
          >
            ♠ Poker Royale ♠
          </h1>

          {availablePublicGames > 0 ? (
            <p className="text-green-400 mb-2">
              {availablePublicGames} Public Game
              {availablePublicGames > 1 ? "s" : ""} Available
            </p>
          ) : (
            <p className="text-gray-400 mb-2">No public games available</p>
          )}

          {publicGameList.length > 0 && (
            <div className="mb-3 max-h-48 overflow-y-auto rounded border border-slate-600 p-2 text-left">
              <p className="text-xs text-slate-300 mb-2">
                Available Public Tables
              </p>
              <div className="space-y-2">
                {publicGameList.map((g) => (
                  <div
                    key={g.gameCode}
                    className="flex items-center justify-between bg-[#08142f] border border-[#00e5ff]/20 rounded px-2 py-1"
                  >
                    <div className="text-xs">
                      <p className="font-semibold">
                        {g.hostName} · {g.gameCode}
                      </p>
                      <p className="text-slate-300">
                        {g.occupiedSeats}/{g.maxPlayers} players
                      </p>
                    </div>
                    <button
                      onClick={() => joinPublicGame(g.gameCode)}
                      disabled={joiningGame}
                      className="rounded-lg border border-[#00e5ff]/40 bg-[#00e5ff]/20 px-3 py-1 text-xs font-medium text-[#d8fbff] hover:bg-[#00e5ff]/35 active:scale-95 transition shadow-[0_0_10px_rgba(0,229,255,0.25)]"
                    >
                      Join
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          <input
            placeholder="Your display name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mb-2 w-full rounded-lg border border-[#00e5ff]/30 bg-[#001933]/60 px-3 py-2 text-[#d8fbff] placeholder:text-[#7dd3fc]/40 focus:outline-none focus:border-[#00e5ff] focus:shadow-[0_0_10px_rgba(0,229,255,0.4)] transition"
          />

          <select
            value={isPrivate ? "true" : "false"}
            onChange={(e) => setIsPrivate(e.target.value === "true")}
            className="w-full mb-2 rounded-lg border border-[#00e5ff]/30 bg-[#001933]/60 px-3 py-2 text-[#d8fbff] focus:outline-none focus:border-[#00e5ff] focus:shadow-[0_0_10px_rgba(0,229,255,0.4)] transition"
          >
            <option value="true">Private</option>
            <option value="false">Public</option>
          </select>

          <button
            onClick={() => createGame()}
            className="w-full rounded-lg border border-[#FFFF33]/70 bg-[#FFFF33]/20 px-4 py-2 text-sm font-medium text-[#d8fbff] hover:bg-[#FFFF33]/55 active:scale-95 transition mb-2"
          >
            Create Game
          </button>

          <button
            onClick={() => setShowJoinForm(true)}
            className="w-full rounded-lg border border-[#00e5ff]/70 bg-[#00e5ff]/20 px-4 py-2 text-sm font-medium text-[#d8fbff] hover:bg-[#00e5ff]/55 active:scale-95 transition mb-2"
          >
            Join Game
          </button>

          <button
            onClick={
              availablePublicGames > 0 ? () => joinPublicGame() : undefined
            }
            disabled={availablePublicGames === 0}
            className={`w-full rounded-lg border px-4 py-2 text-sm font-medium transition active:scale-95 ${
              availablePublicGames > 0
                ? "border-[#ff00cc]/70 bg-[#ff00cc]/20 text-[#ffe0fa] hover:bg-[#ff00cc]/55 shadow-[0_0_14px_rgba(255,0,204,0.35)]"
                : "border-gray-500 bg-gray-700 text-gray-400 cursor-not-allowed"
            }`}
          >
            {availablePublicGames > 0
              ? "Join Public Game"
              : "No Public Game Available"}
          </button>

          <a href="/casino/poker/">
            <button className="mt-2 w-full rounded-lg border border-red-500/70 bg-red-500/30 px-4 py-2 text-sm font-medium text-red-200 hover:bg-red-500/55 active:scale-95 transition shadow-[0_0_14px_rgba(239,68,68,0.35)]">
              Retour
            </button>
          </a>
        </div>
      </div>
    );
  }

  // main UI when game exists
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-br from-[#05010f] via-[#0a1633] to-[#12001f] text-white p-6 overflow-hidden relative">
      <div className="absolute top-4 left-4">
        <button
          onClick={async () => {
            if (game?.stage === "showdown" || game?.waiting) {
              await leaveCurrentGame();
              setGame(null); // go back to form page
            } else {
              alert("You can only return to the form after the hand ends!");
            }
          }}
          className={`px-4 py-2 rounded font-bold transition ${
            game?.stage === "showdown" || game?.waiting
              ? "bg-yellow-500 text-black hover:bg-yellow-400"
              : "bg-gray-500 text-gray-300 cursor-not-allowed"
          }`}
        >
          ← Return
        </button>
      </div>

      <h1 className="text-5xl mb-6 font-black tracking-widest uppercase text-transparent bg-clip-text bg-gradient-to-r from-cyan-300 via-fuchsia-400 to-cyan-300 drop-shadow-[0_0_20px_rgba(0,255,255,0.7)] animate-pulse">
        TEXAS HOLD'EM
      </h1>
      <div className="mb-3 flex items-center gap-2 text-sm">
        <span className="text-gray-300">Turn timer:</span>
        <select
          value={turnTimeLimit}
          onChange={(e) => setTurnTimeLimit(Number(e.target.value) || 60)}
          className="bg-slate-700 border border-slate-500 rounded px-2 py-1"
        >
          <option value={15}>15s</option>
          <option value={30}>30s</option>
          <option value={60}>60s</option>
        </select>
      </div>

      {game?.inviteCode && (
        <div className="mb-4 text-center flex items-center justify-center gap-4">
          <div>
            <span className="font-bold">Invite Code:</span>{" "}
            <span className="bg-yellow-300 text-black px-2 py-1 rounded">
              {game.inviteCode}
            </span>
            <button
              onClick={() => {
                navigator.clipboard.writeText(game.inviteCode || "");
                alert("Invite code copied!");
              }}
              className="ml-2 bg-[#f5ff3b] px-3 py-1 rounded text-sm"
            >
              Copy
            </button>
          </div>

          {/* START GAME button */}
          {game?.waiting && isHost && (
            <button
              onClick={() => {
                if (!game) return;
                if (game.players.length < 2) {
                  alert(
                    "You need at least 1 AI to start (player + 1 AI). Add an AI by clicking a seat.",
                  );
                  return;
                }
                startGame();
              }}
              className={`bg-green-600 px-4 py-2 rounded font-bold ${
                game.players.length < 2 ? "opacity-60 cursor-not-allowed" : ""
              }`}
              disabled={game.players.length < 2}
            >
              Start Game
            </button>
          )}

          {/* REPLAY HAND button moved here */}
          {game?.replayVisible && (
            <button
              onClick={replayHand}
              className="bg-yellow-400 text-black px-4 py-2 rounded font-bold hover:bg-yellow-300 transition"
            >
              Replay Hand
            </button>
          )}
        </div>
      )}

      {(game.actionLog?.length ?? 0) > 0 && (
        <div className="mb-3 w-full max-w-xl bg-slate-800/70 border border-slate-700 rounded p-2 text-xs">
          <div className="font-bold text-yellow-300 mb-1">Recent actions</div>
          <div className="space-y-1">
            {game.actionLog!.map((entry, idx) => (
              <div
                key={`${entry.at}-${idx}`}
                className="text-slate-200 truncate"
              >
                • {entry.text}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="mb-4 flex flex-col items-center">
        {/* Pot moved inside table for layout; but keep this here as well if you want */}
      </div>

      {/* The poker table itself */}
      <div
        className="relative w-[760px] h-[430px] rounded-full flex items-center justify-center mb-6 mt-12
bg-gradient-to-br from-[#08111f] via-[#07192d] to-[#050816]
border-[6px] border-cyan-400/70
shadow-[0_0_60px_rgba(0,255,255,0.35),inset_0_0_40px_rgba(255,0,255,0.12)]"
      >
        {/* neon ring */}
        <div className="absolute inset-4 rounded-full border border-fuchsia-500/40 shadow-[0_0_30px_rgba(255,0,255,0.35)]"></div>

        {/* hologram center */}
        <div className="absolute w-[320px] h-[140px] rounded-full bg-cyan-400/5 blur-2xl"></div>
      </div>

      {/* Seat positions absolutely positioned around the board */}
      <div className="relative w-[900px] h-[600px] -mt-[480px] pointer-events-none">
        {seatPositions.map((pos, seatIdx) => {
          const occupant = playerAtSeat(seatIdx);
          const isPlayer = occupant?.id === myId;

          return (
            <div
              key={seatIdx}
              className="absolute pointer-events-auto"
              style={{
                left: pos.left,
                top: pos.top,
                transform: "translate(-50%, -50%)",
                zIndex: 30,
              }}
            >
              {occupant ? (
                <div
                  onClick={() => {
                    if (occupant.isAI && game?.waiting) {
                      setSelectedAi(occupant);
                      setAiInfoOpen(true);
                    }
                  }}
                  className={`flex flex-col items-center gap-1 w-[120px] p-1.5 rounded-xl text-[10px] font-semibold cursor-pointer
      ${isPlayer ? "bg-yellow-400 text-black" : "bg-yellow-400 text-black shadow-[0_0_18px_rgba(255,255,0,0.5)]"}
      ${occupant.hasFolded ? "opacity-50" : ""}
      ${
        game?.winnerId === occupant.id
          ? "border border-yellow-400 shadow-[0_0_10px_rgba(255,215,0,0.8)]"
          : "border border-slate-700"
      }
    `}
                >
                  <div className="flex justify-between w-full px-1">
                    <span className="truncate">{occupant.name}</span>
                    <span className="text-xs">${occupant.stack}</span>
                  </div>

                  {/* Cards display logic */}
                  <div className="flex gap-1 justify-center">
                    {isPlayer ? (
                      (occupant.hand || [])
                        .filter(
                          (card): card is Card =>
                            !!card && !!card.suit && !!card.value,
                        )
                        .map((card, i) => (
                          <div
                            key={i}
                            className={`w-6 h-8 rounded bg-white flex items-center justify-center
        text-[10px] font-bold shadow 
        ${
          card.suit === "♥" || card.suit === "♦" ? "text-red-600" : "text-black"
        }
      `}
                          >
                            {card.value}
                            {card.suit}
                          </div>
                        ))
                    ) : game?.stage !== "showdown" ? (
                      <>
                        {/* Face-down cards for opponents */}
                        <div className="w-6 h-8 bg-gray-700 rounded border border-gray-500 shadow"></div>
                        <div className="w-6 h-8 bg-gray-700 rounded border border-gray-500 shadow"></div>
                      </>
                    ) : (
                      (occupant.hand || [])
                        .filter(
                          (card): card is Card =>
                            !!card && !!card.suit && !!card.value,
                        )
                        .map((card, i) => (
                          <div
                            key={i}
                            className={`w-6 h-8 rounded bg-white flex items-center justify-center
        text-[10px] font-bold shadow 
        ${
          card.suit === "♥" || card.suit === "♦" ? "text-red-600" : "text-black"
        }
      `}
                          >
                            {card.value}
                            {card.suit}
                          </div>
                        ))
                    )}
                  </div>

                  <div className="text-[9px] mb-1">
                    {occupant.hasFolded ? (
                      <span className="px-1 py-[1px] rounded bg-red-700 text-white">
                        Folded
                      </span>
                    ) : occupant.stack <= 0 ? (
                      <span className="px-1 py-[1px] rounded bg-purple-700 text-white">
                        All-in
                      </span>
                    ) : game?.players?.[game.currentTurn]?.id ===
                      occupant.id ? (
                      <span className="px-2 py-[2px] rounded bg-pink-500 text-white animate-pulse shadow-[0_0_12px_rgba(255,0,255,0.8)]">
                        ⚡ THINKING
                      </span>
                    ) : (
                      <span className="px-1 py-[1px] rounded bg-slate-600 text-gray-100">
                        Active
                      </span>
                    )}
                  </div>

                  {/* Last action line */}
                  {occupant.lastAction && (
                    <div className="text-[9px] text-gray-300 italic truncate max-w-[100px]">
                      {occupant.lastAction}
                    </div>
                  )}

                  {/* ✅ Progress bar under the player div */}
                  {isPlayer && isMyTurn && (
                    <div className="mt-2 w-full text-center">
                      <div className="bg-yellow-400 text-black px-3 py-1 rounded-t-lg font-bold shadow-lg border-x-2 border-t-2 border-yellow-600 text-[11px]">
                        Your Turn ({turnTimer}s)
                      </div>
                      <div className="h-2 bg-yellow-800 rounded-b-lg overflow-hidden">
                        <div
                          className="h-full bg-yellow-300 transition-all duration-1000"
                          style={{
                            width: `${(turnTimer / Math.max(turnTimeLimit, 1)) * 100}%`,
                          }}
                        />
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <button
                  onClick={() => handleSeatClick(seatIdx)}
                  className="w-[100px] h-[40px] bg-slate-600/40 text-xs rounded-full border border-slate-400 hover:bg-slate-500/70 pointer-events-auto"
                >
                  + Seat
                </button>
              )}
            </div>
          );
        })}

        {/* 💰 Chips / CHECK displayed relative to table */}
        {game?.players.map((p) => {
          if (!p || p.seatIndex == null) return null;

          const showChips = p.currentBet > 0;
          const showCheck = p.currentBet === 0 && p.lastAction === "Check";

          if (!showChips && !showCheck) return null;

          const pos = seatPositions[p.seatIndex];
          if (!pos) return null;

          // Adjust chip offset so they face toward the center
          let offset = { x: 0, y: 0 };
          switch (p.seatIndex) {
            case 0:
              offset = { x: -17, y: 50 };
              break; // top-center
            case 1:
              offset = { x: -85, y: 40 };
              break; // top-right
            case 2:
              offset = { x: -90, y: -70 };
              break; // bottom-right
            case 3:
              offset = { x: -15, y: -75 };
              break; // bottom-center → PLAYER
            case 4:
              offset = { x: 50, y: -70 };
              break; // bottom-left
            case 5:
              offset = { x: 50, y: 40 };
              break; // top-left
            default:
              offset = { x: 0, y: 0 };
          }

          return (
            <motion.div
              key={`chip-${p.id}-${p.seatIndex}`}
              initial={{ scale: 0, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0, opacity: 0 }}
              className="absolute z-40 w-8 h-8 bg-red-600 rounded-full flex items-center justify-center text-white font-bold border-2 border-yellow-400 shadow-lg"
              style={{
                left: pos.left + offset.x,
                top: pos.top + offset.y,
                transform: "translate(-50%, -50%)",
              }}
            >
              {showChips ? p.currentBet : "✓"}
            </motion.div>
          );
        })}
      </div>

      {seatModalOpen && selectedSeat !== null && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center pointer-events-auto">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/60 z-[90]"
            onClick={() => setSeatModalOpen(false)}
          />

          <div className="relative bg-slate-800 p-6 rounded-xl w-[340px] z-[100] pointer-events-auto">
            <h2 className="text-xl font-bold mb-2">Seat {selectedSeat}</h2>

            <p className="text-sm text-gray-300 mb-4">
              Who should sit in this seat?
            </p>

            {/* HUMAN OPTION */}
            <button
              onClick={sitAsHuman}
              className="w-full bg-yellow-500 text-black px-4 py-2 rounded font-bold mb-3 hover:bg-yellow-400"
            >
              Sit as Human
            </button>

            {/* AI OPTION (host only, private only) */}
            {isPrivate && isHost && (
              <>
                <div className="border-t border-slate-600 my-3" />

                <label className="block text-sm mb-1">AI Name (optional)</label>
                <input
                  value={aiNameInput}
                  onChange={(e) => setAiNameInput(e.target.value)}
                  className="w-full p-2 rounded text-black mb-2"
                />

                <label className="block text-sm mb-1">AI Stack</label>
                <input
                  type="number"
                  value={aiStackInput}
                  onChange={(e) => setAiStackInput(Number(e.target.value))}
                  className="w-full p-2 rounded text-black mb-3"
                />

                <button
                  onClick={addAiToSeat}
                  className="w-full bg-green-600 px-4 py-2 rounded font-bold hover:bg-green-500"
                >
                  Add AI
                </button>
              </>
            )}

            <button
              onClick={() => setSeatModalOpen(false)}
              className="mt-4 w-full bg-gray-600 px-4 py-2 rounded"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {aiInfoOpen && selectedAi && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center">
          <div className="bg-black/70 backdrop-blur-md border border-cyan-400/40 shadow-[0_0_15px_rgba(0,255,255,0.25)] p-6 rounded-xl w-80 shadow-xl border border-yellow-500">
            <h2 className="text-xl font-bold mb-4 text-center text-yellow-400">
              🤖 AI Player Info
            </h2>

            <div className="space-y-2 text-sm">
              <p>
                <span className="font-semibold">Name:</span> {selectedAi.name}
              </p>
              <p>
                <span className="font-semibold">Stack:</span> $
                {selectedAi.stack}
              </p>
              <p>
                <span className="font-semibold">Seat:</span>{" "}
                {selectedAi.seatIndex}
              </p>
            </div>

            <div className="mt-6 flex justify-between gap-3">
              <button
                onClick={() => {
                  setAiInfoOpen(false);
                  setSelectedAi(null);
                }}
                className="flex-1 bg-gray-600 hover:bg-gray-500 px-4 py-2 rounded font-bold"
              >
                Close
              </button>

              <button
                onClick={() => {
                  if (!game) return;

                  setGame((g) =>
                    g
                      ? {
                          ...g,
                          players: g.players.filter(
                            (p) => p.id !== selectedAi.id,
                          ),
                        }
                      : g,
                  );

                  setAiInfoOpen(false);
                  setSelectedAi(null);
                }}
                className="flex-1 bg-red-600 hover:bg-red-500 px-4 py-2 rounded font-bold"
              >
                Delete AI
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Multiplayer Waiting Panel — bottom-left, public-only */}
      {!isPrivate && (
        <div className="fixed bottom-6 left-6 z-50 pointer-events-auto">
          <div className="w-64 bg-slate-800/90 backdrop-blur-sm border border-slate-700 rounded-lg shadow-lg p-3">
            <div className="flex items-center justify-between mb-2">
              <div className="text-sm font-bold">Public Queue</div>
              <div className="text-xs text-gray-300">
                {waitingPlayers.length} waiting
              </div>
            </div>

            <div className="max-h-40 overflow-y-auto space-y-2">
              <AnimatePresence initial={false}>
                {waitingPlayers.map((p) => (
                  <motion.div
                    key={p.id}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 6 }}
                    className="flex items-center justify-between bg-slate-700/60 px-2 py-1 rounded"
                  >
                    <div className="truncate text-sm">
                      {p.name || "Anonymous"}
                    </div>
                    <div className="text-xs text-gray-300">
                      {p.level ? `Lv ${p.level}` : ""}
                    </div>
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>

            <div className="mt-3 flex gap-2">
              <button
                onClick={() => joinPublicGame()}
                disabled={joiningGame}
                className={`flex-1 text-sm px-3 py-2 rounded font-bold transition ${joiningGame ? "bg-gray-600 cursor-not-allowed" : "bg-[#f5ff3b] hover:bg-[#f5ff3b]"}`}
              >
                Join Public
              </button>
              <button
                onClick={() => fetchWaitingPlayers()}
                className="px-3 py-2 rounded text-sm bg-slate-600 hover:bg-slate-500"
              >
                Refresh
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
