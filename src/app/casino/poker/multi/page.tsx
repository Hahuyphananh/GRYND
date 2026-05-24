"use client";

import { useState, useEffect, useRef } from "react";
import { Card, evaluateHand } from "../../../lib/handEval";
import { motion, AnimatePresence } from "framer-motion";
import { useRouter, useSearchParams } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import { useSocket } from "../../../../context/SocketProvider";
import useGamePresence from "../../../../hooks/useGamePresence";
import { usePokerAudio } from "../../../lib/pokerAudio";
import NavigationBar from "../../../../components/navigation-bar";

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
  const [allInFlash, setAllInFlash] = useState(false);
  const [allInParticles, setAllInParticles] = useState<{ id: string; seatIdx: number; delay: number }[]>([]);
  const audio = usePokerAudio();
  const audioRef = useRef(audio);
  audioRef.current = audio;
  const performActionRef = useRef(performAction);
  performActionRef.current = performAction;
  const gameRef = useRef(game);
  gameRef.current = game;
  const myIdRef = useRef(myId);
  myIdRef.current = myId;

  const [windowSize, setWindowSize] = useState({ w: 1200, h: 800 });
  const [isPortrait, setIsPortrait] = useState(false);

  // Responsive scaling & landscape enforcement
  useEffect(() => {
    const update = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      setWindowSize({ w, h });
      setIsPortrait(w < 768 && h > w);
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
    };
  }, []);

  // Compute scale factor so the 900x600 table+seats area fits the viewport
  const TABLE_W = 900;
  const TABLE_H = 680;
  const paddingX = 32;
  const paddingY = 140;
  const scaleX = (windowSize.w - paddingX) / TABLE_W;
  const scaleY = (windowSize.h - paddingY) / TABLE_H;
  const tableScale = Math.min(scaleX, scaleY, 1.0);

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

  // ── Ref-based turn timer — auto-fold on expiry with audio ──
  const timerIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (!game) return;

    const currentPlayer = game.players[game.currentTurn];
    const isPlayerTurn = currentPlayer && currentPlayer.id === myId;
    setIsMyTurn(isPlayerTurn);
    setTurnTimer(turnTimeLimit);

    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    }

    if (!isPlayerTurn || game.stage === "showdown" || game.waiting) return;

    timerIntervalRef.current = setInterval(() => {
      setTurnTimer((t) => {
        // Urgent beep at ≤5s
        if (t <= 5 && t > 1) {
          audioRef.current.playTimerUrgent();
        }
        if (t <= 1) {
          if (timerIntervalRef.current) {
            clearInterval(timerIntervalRef.current);
            timerIntervalRef.current = null;
          }
          const freshGame = gameRef.current;
          const freshMyId = myIdRef.current;
          if (!freshGame) return 0;
          const timeoutPlayer = freshGame.players[freshGame.currentTurn];
          if (!timeoutPlayer || timeoutPlayer.id !== freshMyId) return 0;
          audioRef.current.playFold();
          performActionRef.current("fold");
          return 0;
        }
        return t - 1;
      });
    }, 1000);

    return () => {
      if (timerIntervalRef.current) {
        clearInterval(timerIntervalRef.current);
        timerIntervalRef.current = null;
      }
    };
  }, [game?.currentTurn, game?.stage, myId, turnTimeLimit]);

  // -----------------------------
  // Seat positions (aligned around the table)
  // Table: 700x400 centered in 900x600 container
  // Player stays at bottom-center (same as before)
  // -----------------------------
 const seatPositions = [
  { left: 50, top: 8 },   // top center
  { left: 80, top: 20 },  // top right
  { left: 80, top: 75 },  // bottom right
  { left: 50, top: 92 },  // bottom center (player)
  { left: 20, top: 75 },  // bottom left
  { left: 20, top: 20 },  // top left
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

    // Play sounds for new hand
    audioRef.current.playNewHand();
    audioRef.current.playShuffle();
    setTimeout(() => {
      audioRef.current.playCardDeal();
      setTimeout(() => audioRef.current.playCardDeal(), 200);
    }, 600);

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

  function triggerAllInAnimation(seatIdx: number) {
    audioRef.current.playAllIn();
    setAllInFlash(true);
    // Create 8 chip particles flying from the seat to the pot
    const chips = Array.from({ length: 8 }, (_, i) => ({
      id: `allin-${seatIdx}-${Date.now()}-${i}`,
      seatIdx,
      delay: i * 40,
    }));
    setAllInParticles(chips);
    setTimeout(() => {
      setAllInFlash(false);
      setAllInParticles([]);
    }, 1200);
  }

  function checkForWinner(players: Player[], pot: number) {
    const activePlayers = players.filter((p) => !p.hasFolded);
    if (activePlayers.length === 1) {
      const winner = activePlayers[0];
      const updatedPlayers = players.map((p) =>
        p.id === winner.id ? { ...p, stack: p.stack + pot } : p,
      );

      if (winner.id === myId) {
        audioRef.current.playWin();
        setBalance((prev) => prev + pot);
        fetchUserTokens();
      } else {
        audioRef.current.playLose();
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
      audioRef.current.playFold();
      current.hasFolded = true;
      current.lastAction = "Folded";
      if (checkForWinner(players, potNew)) return;
    } else if (action === "call") {
      audioRef.current.playCall();
      const toCall = Math.max(0, highest - (current.currentBet || 0));
      if (toCall > 0) {
        const actual = Math.min(toCall, current.stack);
        current.stack -= actual;
        current.currentBet += actual;
        potNew += actual;
        current.lastAction = `Called ${actual}`;
        if (current.stack <= 0 && current.seatIndex != null) {
          triggerAllInAnimation(current.seatIndex);
        }
        if (checkForWinner(players, potNew)) return;

        if (current.id === myId) {
          setBalance((prev) => Math.max(prev - actual, 0));
          fetchUserTokens();
        }
      } else {
        audioRef.current.playCheck();
        current.lastAction = "Check";
      }
    } else if (action === "bet20") {
      audioRef.current.playChipStack();
      audioRef.current.playChipPot();
      const betSize = 20;
      const actual = Math.min(betSize, current.stack);
      current.stack -= actual;
      current.currentBet += actual;
      potNew += actual;
      current.lastAction = `Bet ${betSize}`;
      game.lastAggressorIndex = currentIndex;
      if (current.stack <= 0 && current.seatIndex != null) {
        triggerAllInAnimation(current.seatIndex);
      }

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
      audioRef.current.playRaise();
      audioRef.current.playChipPot();
      const targetBet = Math.max(raiseAmount, highest);
      const chipsNeeded = Math.max(0, targetBet - (current.currentBet || 0));
      const actual = Math.min(chipsNeeded, current.stack);
      current.stack -= actual;
      current.currentBet += actual;
      potNew += actual;
      current.lastAction =
        chipsNeeded > 0 ? `Raised to ${current.currentBet}` : "Call";
      game.lastAggressorIndex = currentIndex;
      if (current.stack <= 0 && current.seatIndex != null) {
        triggerAllInAnimation(current.seatIndex);
      }

      players.forEach((p, i) => {
        if (i !== currentIndex && !p.hasFolded) {
          p.hasActed = false;
        }
      });
      if (current.id === myId) {
        setBalance((prev) => Math.max(prev - actual, 0));
      }
    } else if (action === "check") {
      audioRef.current.playCheck();
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
        if (current.stack <= 0 && current.seatIndex != null) {
          triggerAllInAnimation(current.seatIndex);
        }

        if (current.id === myId) {
          setBalance((prev) => Math.max(prev - actual, 0));
          fetchUserTokens();
        }
      }
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
      audioRef.current.playCardDeal();
      setTimeout(() => audioRef.current.playCardDeal(), 150);
      setTimeout(() => audioRef.current.playCardDeal(), 300);
      comm.push(deck.pop()!, deck.pop()!, deck.pop()!);
      nextStage = "flop";
    } else if (game.stage === "flop") {
      await new Promise((res) => setTimeout(res, 400));
      audioRef.current.playCardDeal();
      comm.push(deck.pop()!);
      nextStage = "turn";
    } else if (game.stage === "turn") {
      await new Promise((res) => setTimeout(res, 400));
      audioRef.current.playCardDeal();
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
      audioRef.current.playWin();
      setBalance((prev) => prev + game.pot);
      fetchUserTokens();
    } else {
      audioRef.current.playLose();
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
      <div className="min-h-screen flex flex-col items-center justify-start bg-gradient-to-br from-[#001933] to-[#000d1a] text-white">
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
          <NavigationBar currentPath="/casino" />
            <button className="w-full rounded-lg border border-[#FFFF33]/70 bg-[#FFFF33]/20 px-4 py-2 text-sm font-medium text-[#d8fbff] hover:bg-[#FFFF33]/55 active:scale-95 transition mb-2">
              ← Return to Casino
            </button>

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
    <div className="min-h-screen pb-36 lg:pb-0 flex flex-col items-center justify-center bg-gradient-to-br from-[#020108] via-[#0a0a1a] to-[#050510] text-white overflow-hidden relative">
      {/* ── Portrait-mode overlay (mobile only) ── */}
      {isPortrait && (
        <div className="fixed inset-0 z-[200] flex flex-col items-center justify-center bg-black/90 backdrop-blur-md">
          <div className="text-6xl mb-6 animate-spin" style={{ animationDuration: "4s" }}>📱</div>
          <p className="text-2xl font-bold text-[#00e5ff] drop-shadow-[0_0_12px_#00e5ff] mb-2">
            Rotate Your Phone
          </p>
          <p className="text-sm text-[#b0b0ff]/70">Landscape mode required for Texas Hold'em</p>
        </div>
      )}

      {/* ── Ambient scanlines overlay ── */}
      <div className="fixed inset-0 pointer-events-none z-0 opacity-[0.03]"
        style={{
          backgroundImage: "repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,229,255,0.15) 2px, rgba(0,229,255,0.15) 4px)",
        }}
      />

      <div className="absolute top-4 left-4 z-20">
        <button
          onClick={async () => {
            if (game?.stage === "showdown" || game?.waiting) {
              await leaveCurrentGame();
              setGame(null);
            } else {
              alert("You can only return to the form after the hand ends!");
            }
          }}
          className={`px-4 py-2 rounded font-bold transition text-sm ${
            game?.stage === "showdown" || game?.waiting
              ? "bg-gradient-to-r from-[#ff00cc]/70 to-[#00e5ff]/70 text-black hover:from-[#ff00cc] hover:to-[#00e5ff] shadow-[0_0_15px_rgba(255,0,204,0.4)]"
              : "bg-[#0a0a1a]/80 text-[#b0b0ff]/40 border border-[#b0b0ff]/10 cursor-not-allowed"
          }`}
        >
          ← Return
        </button>
      </div>

      <h1 className="text-3xl sm:text-5xl mb-4 font-black tracking-widest uppercase text-transparent bg-clip-text bg-gradient-to-r from-[#ff00cc] via-[#00e5ff] to-[#ff00cc] drop-shadow-[0_0_20px_rgba(255,0,204,0.8)] animate-pulse">
        TEXAS HOLD'EM
      </h1>
      
      {/* ── Sound toggle ── */}
      <button
        onClick={() => audio.setEnabled(!audio.enabled)}
        className="absolute top-4 right-4 z-20 w-10 h-10 rounded-full flex items-center justify-center bg-[#0a0a1a]/80 border border-[#00e5ff]/30 text-lg hover:bg-[#00e5ff]/20 transition shadow-[0_0_10px_rgba(0,229,255,0.2)]"
        title={audio.enabled ? "Mute sounds" : "Enable sounds"}
      >
        {audio.enabled ? "🔊" : "🔇"}
      </button>
      <div className="mb-3 flex items-center gap-2 text-sm z-10">
        <span className="text-[#b0b0ff]/70">Turn timer:</span>
        <select
          value={turnTimeLimit}
          onChange={(e) => setTurnTimeLimit(Number(e.target.value) || 60)}
          className="bg-[#0a0a1a] border border-[#ff00cc]/30 rounded px-2 py-1 text-[#ff00cc] focus:outline-none focus:border-[#ff00cc]"
        >
          <option value={15}>15s</option>
          <option value={30}>30s</option>
          <option value={60}>60s</option>
        </select>
      </div>

      {game?.inviteCode && (
        <div className="mb-4 text-center flex flex-wrap items-center justify-center gap-3 z-10">
          <div className="flex items-center gap-2">
            <span className="font-bold text-[#b0b0ff]/70 text-sm">Invite Code:</span>{" "}
            <span className="bg-gradient-to-r from-[#ff00cc]/30 to-[#00e5ff]/30 border border-[#ff00cc]/40 text-[#00e5ff] px-3 py-1 rounded font-mono tracking-wider shadow-[0_0_12px_rgba(0,229,255,0.25)]">
              {game.inviteCode}
            </span>
            <button
              onClick={() => {
                navigator.clipboard.writeText(game.inviteCode || "");
                alert("Invite code copied!");
              }}
              className="ml-1 bg-[#ff00cc]/20 border border-[#ff00cc]/40 text-[#ff00cc] px-3 py-1 rounded text-sm hover:bg-[#ff00cc]/35 transition shadow-[0_0_10px_rgba(255,0,204,0.3)]"
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
              className={`bg-gradient-to-r from-[#ff00cc]/80 to-[#00e5ff]/80 px-5 py-2 rounded font-bold text-black hover:from-[#ff00cc] hover:to-[#00e5ff] transition shadow-[0_0_20px_rgba(255,0,204,0.5)] ${
                game.players.length < 2 ? "opacity-40 cursor-not-allowed" : ""
              }`}
              disabled={game.players.length < 2}
            >
              ⚡ Start Game
            </button>
          )}

          {/* REPLAY HAND button */}
          {game?.replayVisible && (
            <button
              onClick={replayHand}
              className="bg-gradient-to-r from-[#ff00cc]/60 to-[#ff00cc]/60 border border-[#ff00cc]/50 text-white px-5 py-2 rounded font-bold hover:from-[#ff00cc] hover:to-[#ff00cc] transition shadow-[0_0_15px_rgba(255,0,204,0.4)]"
            >
              🔄 Replay Hand
            </button>
          )}
        </div>
      )}

      {(game.actionLog?.length ?? 0) > 0 && (
        <div className="mb-3 w-full max-w-xl bg-[#0a0a1a]/90 border border-[#ff00cc]/20 rounded p-2 text-xs z-10 backdrop-blur-sm">
          <div className="font-bold text-[#ff00cc] mb-1 drop-shadow-[0_0_6px_#ff00cc]">Recent actions</div>
          <div className="space-y-1">
            {game.actionLog!.map((entry, idx) => (
              <div
                key={`${entry.at}-${idx}`}
                className="text-[#b0b0ff]/80 truncate"
              >
                ▸ {entry.text}
              </div>
            ))}
          </div>
        </div>
      )}

   {/* ── Scalable table wrapper ── */}
<div className="relative w-full h-[75vh] flex items-center justify-center overflow-visible">
        {/* The cyberpunk poker table */}
       <div
  className="relative w-[85vmin] h-[55vmin] max-w-[1000px] max-h-[650px] rounded-full flex items-center justify-center
bg-gradient-to-br from-[#0a0015] via-[#0d0020] to-[#05000d]
border-[6px] border-[#ff00cc]/60
shadow-[0_0_80px_rgba(255,0,204,0.4),0_0_120px_rgba(0,229,255,0.2),inset_0_0_60px_rgba(255,0,204,0.1)]"
 style={{ transform: "translateZ(0)" }}
        >
          {/* Hex grid pattern overlay */}
          <div className="absolute inset-0 rounded-full overflow-hidden opacity-20"
            style={{
              backgroundImage: `url("data:image/svg+xml,%3Csvg width='40' height='46' viewBox='0 0 40 46' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M20 0l20 11.5v23L20 46 0 34.5v-23L20 0zm0 4L4 13.5v19L20 42l16-9.5v-19L20 4z' fill='none' stroke='%2300e5ff' stroke-width='0.8'/%3E%3C/svg%3E")`,
              backgroundSize: "40px 46px",
            }}
          />

          {/* Scanlines on the table felt */}
          <div className="absolute inset-[6px] rounded-[50%] overflow-hidden opacity-[0.06]"
            style={{
              backgroundImage: "repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(255,0,204,0.3) 2px, rgba(255,0,204,0.3) 4px)",
            }}
          />

          {/* Outer neon ring */}
          <div className="absolute inset-3 rounded-[50%] border-2 border-[#00e5ff]/30 shadow-[0_0_30px_rgba(0,229,255,0.25)]" />

          {/* Inner neon ring */}
          <div className="absolute inset-6 rounded-[50%] border border-[#ff00cc]/25 shadow-[0_0_20px_rgba(255,0,204,0.2)]" />

          {/* Holographic center glow */}
          <div className="absolute w-[300px] h-[120px] rounded-[50%] bg-gradient-to-r from-[#ff00cc]/10 via-[#00e5ff]/10 to-[#ff00cc]/10 blur-3xl" />

          {/* Center data ring */}
          <div className="absolute w-[180px] h-[60px] rounded-[50%] border border-[#00e5ff]/15 shadow-[0_0_40px_rgba(0,229,255,0.15)] animate-pulse" />

          {/* ── Pot display in the center of the table ── */}
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-20 flex flex-col items-center">
            <div className="text-[10px] uppercase tracking-[0.3em] text-[#b0b0ff]/50 mb-1">Pot</div>
            <div className="text-3xl font-black text-transparent bg-clip-text bg-gradient-to-r from-[#ff00cc] to-[#00e5ff] drop-shadow-[0_0_12px_rgba(255,0,204,0.7)]">
              ${game.pot}
            </div>
          </div>
        </div>

        {/* ── All-in flash overlay ── */}
        <AnimatePresence>
          {allInFlash && (
            <motion.div
              key="allin-flash"
              initial={{ opacity: 0 }}
              animate={{ opacity: [0, 0.6, 0.3, 0] }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.8, times: [0, 0.15, 0.4, 0.8] }}
              className="absolute inset-0 z-[60] pointer-events-none"
              style={{
                background: "radial-gradient(circle at 50% 50%, rgba(255,215,0,0.5), rgba(255,100,0,0.3) 40%, transparent 70%)",
              }}
            />
          )}
        </AnimatePresence>

        {/* ── Flying all-in chip particles ── */}
        <AnimatePresence>
          {allInParticles.map((particle) => {
            const seatPos = seatPositions[particle.seatIdx];
            if (!seatPos) return null;
            return (
              <motion.div
                key={particle.id}
                initial={{
                  left: seatPos.left,
                  top: seatPos.top,
                  scale: 0.5,
                  opacity: 1,
                }}
                animate={{
  left: "50%",
  top: "50%",
  scale: [0.5, 1.2, 0.3],
  opacity: [1, 1, 0],
  rotate: [0, 720],
}}
                exit={{ opacity: 0, scale: 0 }}
                transition={{
                  duration: 0.7,
                  delay: particle.delay / 1000,
                  ease: "easeIn",
                }}
                className="absolute z-[65] w-4 h-4 rounded-full pointer-events-none"
                style={{
                  transform: "translate(-50%, -50%)",
                  background: `linear-gradient(135deg, hsl(${Math.random() * 360}, 100%, 50%), #ffd700)`,
                  boxShadow: "0 0 8px rgba(255,215,0,0.6)",
                }}
              />
            );
          })}
        </AnimatePresence>

        {/* ── Winner celebration overlay ── */}
        <AnimatePresence>
          {game?.winnerId && game?.stage === "showdown" && (
            <motion.div
              initial={{ scale: 0, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0, opacity: 0 }}
              transition={{ type: "spring", stiffness: 200, damping: 15 }}
              className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50 pointer-events-none"
            >
              <motion.div
                animate={{
                  scale: [1, 1.05, 1],
                  rotate: [0, 2, -2, 0],
                }}
                transition={{ duration: 1.5, repeat: Infinity, repeatType: "reverse" }}
                className="text-4xl sm:text-6xl font-black text-transparent bg-clip-text bg-gradient-to-r from-yellow-300 via-amber-400 to-yellow-300 drop-shadow-[0_0_30px_rgba(255,215,0,0.8)]"
              >
                👑 WINNER!
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── Community cards on the table ── */}
        {game?.community?.length > 0 && (
          <div className="absolute left-1/2 top-[42%] -translate-x-1/2 flex gap-2 sm:gap-3 z-20">
            {game.community.map((c: Card, i: number) => (
              <motion.div
                key={`${c?.suit}-${c?.value}-${i}`}
                initial={{ rotateY: 90, opacity: 0, y: -30, scale: 0.5 }}
                animate={{ rotateY: 0, opacity: 1, y: 0, scale: 1 }}
                transition={{ duration: 0.5, delay: i * 0.12, type: "spring", stiffness: 200 }}
                className={`w-10 h-14 sm:w-14 sm:h-20 rounded-lg flex items-center justify-center font-bold text-sm sm:text-xl shadow-xl border-2
      bg-gradient-to-b from-[#0a0a1a] to-[#020108]
      ${c?.suit === "♥" || c?.suit === "♦"
                    ? "border-[#ff00cc]/60 text-[#ff00cc] shadow-[0_0_15px_rgba(255,0,204,0.4)]"
                    : "border-[#00e5ff]/60 text-[#00e5ff] shadow-[0_0_15px_rgba(0,229,255,0.4)]"
                  }
    `}
              >
                {c?.value}{c?.suit}
              </motion.div>
            ))}
          </div>
        )}

        {/* ── Seat positions ── */}
        <div className="absolute inset-0 pointer-events-none">
        {seatPositions.map((pos, seatIdx) => {
          const occupant = playerAtSeat(seatIdx);
          const isPlayer = occupant?.id === myId;

          return (
            <div
              key={seatIdx}
              className="absolute pointer-events-auto"
              style={{
  left: `${pos.left}%`,
  top: `${pos.top}%`,
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
                  className={`flex flex-col items-center gap-1 w-[120px] p-1.5 rounded-xl text-[10px] font-semibold cursor-pointer backdrop-blur-sm
      ${isPlayer
                      ? "bg-gradient-to-b from-[#00e5ff]/30 to-[#00e5ff]/10 border-2 border-[#00e5ff]/70 text-[#00e5ff] shadow-[0_0_20px_rgba(0,229,255,0.4)]"
                      : "bg-gradient-to-b from-[#ff00cc]/25 to-[#ff00cc]/8 border-2 border-[#ff00cc]/50 text-[#ffb0ff] shadow-[0_0_18px_rgba(255,0,204,0.3)]"
                    }
      ${occupant.hasFolded ? "opacity-40 grayscale" : ""}
      ${
        game?.winnerId === occupant.id
          ? "ring-2 ring-[#ff00cc] ring-offset-1 ring-offset-transparent shadow-[0_0_25px_rgba(255,0,204,0.7)]"
          : ""
      }
    `}
                >
                  <div className="flex justify-between w-full px-1 items-center gap-1">
                    <span className="truncate text-[#ffffff]/90">{occupant.name}</span>
                    <span className="text-xs text-[#00e5ff] drop-shadow-[0_0_4px_#00e5ff]">${occupant.stack}</span>
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
                      <span className="px-2 py-[2px] rounded bg-red-900/80 text-red-300 border border-red-500/30">
                        Folded
                      </span>
                    ) : occupant.stack <= 0 ? (
                      <span className="px-2 py-[2px] rounded bg-purple-900/80 text-purple-300 border border-purple-500/30 animate-pulse">
                        All-in
                      </span>
                    ) : game?.players?.[game.currentTurn]?.id ===
                      occupant.id ? (
                      <span className="px-2 py-[2px] rounded bg-[#ff00cc]/80 text-black font-bold animate-pulse shadow-[0_0_15px_rgba(255,0,204,0.9)]">
                        ⚡ THINKING
                      </span>
                    ) : (
                      <span className="px-2 py-[2px] rounded bg-[#0a0a1a]/80 text-[#b0b0ff]/70 border border-[#00e5ff]/20">
                        Active
                      </span>
                    )}
                  </div>

                  {/* Last action line */}
                  {occupant.lastAction && (
                    <div className="text-[9px] text-[#b0b0ff]/70 italic truncate max-w-[100px]">
                      {occupant.lastAction}
                    </div>
                  )}

                  {/* Progress bar under the player div */}
                  {isPlayer && isMyTurn && (
                    <div className="mt-2 w-full text-center">
                      <div className="bg-gradient-to-r from-[#ff00cc] to-[#00e5ff] text-black px-3 py-1 rounded-t-lg font-bold shadow-lg text-[11px]">
                        ⚡ Your Turn ({turnTimer}s)
                      </div>
                      <div className="h-2 bg-[#0a0a1a] rounded-b-lg overflow-hidden border border-[#ff00cc]/20">
                        <div
                          className="h-full bg-gradient-to-r from-[#ff00cc] to-[#00e5ff] transition-all duration-1000 shadow-[0_0_8px_rgba(255,0,204,0.6)]"
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
                  className="w-[100px] h-[40px] bg-[#0a0a1a]/70 text-xs rounded-full border border-dashed border-[#ff00cc]/30 text-[#ff00cc]/60 hover:bg-[#ff00cc]/10 hover:border-[#ff00cc]/60 pointer-events-auto transition backdrop-blur-sm"
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
          const angleStep = (2 * Math.PI) / seatPositions.length;
          const angle = p.seatIndex * angleStep - Math.PI / 2;

          // radius in % of table size
          const radiusX = 18;
          const radiusY = 14;

          const offset = {
            x: Math.cos(angle) * radiusX,
            y: Math.sin(angle) * radiusY,
          };

          return (
            <motion.div
              key={`chip-${p.id}-${p.seatIndex}`}
              initial={{ scale: 0, opacity: 0, y: 10 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0, opacity: 0 }}
              className="absolute z-40 w-8 h-8 rounded-full flex items-center justify-center font-bold text-xs shadow-lg"
              style={{
                left: `calc(${pos.left}% + ${offset.x}%)`,
  top: `calc(${pos.top}% + ${offset.y}%)`,
  transform: "translate(-50%, -50%)",
                background: showChips
                  ? "linear-gradient(135deg, #ff00cc, #00e5ff)"
                  : "linear-gradient(135deg, #00e5ff, #00ff88)",
                border: "2px solid rgba(255,255,255,0.3)",
                color: showChips ? "#fff" : "#000",
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
          <div className="bg-black/70 backdrop-blur-md border border-yellow-500/60 shadow-[0_0_15px_rgba(255,215,0,0.3)] p-6 rounded-xl w-80 shadow-xl">
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

      {/* ── End of scalable wrapper ── */}
      </div>

     {/* ── ACTION CONTROLS ── */}
{game && !game.waiting && game.stage !== "showdown" && (() => {
  const me = game.players.find((p) => p.id === myId);
  const isMyTurnNow = game.players[game.currentTurn]?.id === myId;

  const highestBetInRound = Math.max(
    ...game.players.map((p) => p.currentBet || 0),
  );

  const myCurrentBet = me?.currentBet || 0;
  const toCall = Math.max(0, highestBetInRound - myCurrentBet);
  const canCheck = myCurrentBet >= highestBetInRound;

  if (!isMyTurnNow || !me || me.hasFolded) return null;

  return (
    <>
      {/* ───────────────────────────── */}
      {/* DESKTOP SIDE CONTROLS */}
      {/* ───────────────────────────── */}
      <div className="hidden lg:flex fixed right-6 top-1/2 -translate-y-1/2 z-50 flex-col gap-3">
        
        {/* Fold */}
        <button
          onClick={() => performAction("fold")}
          className="w-40 px-5 py-3 rounded-2xl font-bold text-sm
          bg-gradient-to-r from-red-900/80 to-red-700/70
          border border-red-500/50
          text-red-200
          hover:scale-105 hover:shadow-[0_0_25px_rgba(255,0,0,0.45)]
          transition-all duration-200"
        >
          ❌ Fold
        </button>

        {/* Check / Call */}
        {canCheck ? (
          <button
            onClick={() => performAction("check")}
            className="w-40 px-5 py-3 rounded-2xl font-bold text-sm
            bg-gradient-to-r from-[#00e5ff]/30 to-cyan-400/20
            border border-[#00e5ff]/50
            text-[#00e5ff]
            hover:scale-105 hover:shadow-[0_0_25px_rgba(0,229,255,0.45)]
            transition-all duration-200"
          >
            ✓ Check
          </button>
        ) : (
          <button
            onClick={() => performAction("call")}
            className="w-40 px-5 py-3 rounded-2xl font-bold text-sm
            bg-gradient-to-r from-[#00e5ff]/30 to-cyan-400/20
            border border-[#00e5ff]/50
            text-[#00e5ff]
            hover:scale-105 hover:shadow-[0_0_25px_rgba(0,229,255,0.45)]
            transition-all duration-200"
          >
            📞 Call ${toCall}
          </button>
        )}

        {/* Raise */}
        <button
          onClick={() => {
            const targetBet = Math.max(
              raiseAmount,
              highestBetInRound * 2,
            );

            setRaiseAmount(targetBet);
            performAction("raise");
          }}
          className="w-40 px-5 py-3 rounded-2xl font-bold text-sm
          bg-gradient-to-r from-[#ff00cc]/30 to-fuchsia-500/20
          border border-[#ff00cc]/50
          text-[#ff00cc]
          hover:scale-105 hover:shadow-[0_0_25px_rgba(255,0,204,0.45)]
          transition-all duration-200"
        >
          ⬆ Raise
        </button>

        {/* Quick Bet */}
        {canUseBetShortcut && (
          <button
            onClick={() => performAction("bet20")}
            className="w-40 px-5 py-3 rounded-2xl font-bold text-sm
            bg-gradient-to-r from-yellow-500/20 to-amber-400/10
            border border-yellow-400/40
            text-yellow-200
            hover:scale-105 hover:shadow-[0_0_25px_rgba(255,215,0,0.35)]
            transition-all duration-200"
          >
            💰 Bet $20
          </button>
        )}
      </div>

      {/* ───────────────────────────── */}
      {/* MOBILE ACTION DOCK */}
      {/* ───────────────────────────── */}
      <div className="lg:hidden fixed bottom-0 left-0 right-0 z-[80] px-2 pb-[max(env(safe-area-inset-bottom),8px)]">
        
        <div
          className="
            rounded-t-3xl
            border border-[#ff00cc]/20
            bg-[#050510]/95
            backdrop-blur-xl
            shadow-[0_-10px_40px_rgba(0,0,0,0.65)]
            p-3
          "
        >
          {/* Turn Header */}
          <div className="flex items-center justify-between mb-3 px-1">
            <div className="text-xs uppercase tracking-widest text-[#b0b0ff]/60">
              Your Turn
            </div>

            <div className="text-sm font-bold text-[#00e5ff]">
              {canCheck ? "Check Available" : `Call $${toCall}`}
            </div>
          </div>

          {/* Main Actions */}
          <div className="grid grid-cols-3 gap-2">
            <button
              onClick={() => performAction("fold")}
              className="
                h-14 rounded-2xl
                bg-red-900/60
                border border-red-500/40
                text-red-200
                font-bold text-sm
                active:scale-95 transition
              "
            >
              Fold
            </button>

            {canCheck ? (
              <button
                onClick={() => performAction("check")}
                className="
                  h-14 rounded-2xl
                  bg-[#00e5ff]/20
                  border border-[#00e5ff]/40
                  text-[#00e5ff]
                  font-bold text-sm
                  active:scale-95 transition
                "
              >
                Check
              </button>
            ) : (
              <button
                onClick={() => performAction("call")}
                className="
                  h-14 rounded-2xl
                  bg-[#00e5ff]/20
                  border border-[#00e5ff]/40
                  text-[#00e5ff]
                  font-bold text-sm
                  active:scale-95 transition
                "
              >
                Call
              </button>
            )}

            <button
              onClick={() => {
                const targetBet = Math.max(
                  raiseAmount,
                  highestBetInRound * 2,
                );

                setRaiseAmount(targetBet);
                performAction("raise");
              }}
              className="
                h-14 rounded-2xl
                bg-[#ff00cc]/20
                border border-[#ff00cc]/40
                text-[#ff00cc]
                font-bold text-sm
                active:scale-95 transition
              "
            >
              Raise
            </button>
          </div>

          {/* Quick Action Row */}
          {canUseBetShortcut && (
            <div className="mt-2">
              <button
                onClick={() => performAction("bet20")}
                className="
                  w-full h-11 rounded-xl
                  bg-yellow-500/15
                  border border-yellow-400/30
                  text-yellow-200
                  font-semibold text-sm
                  active:scale-95 transition
                "
              >
                💰 Quick Bet $20
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  );
})()}

      {/* Multiplayer Waiting Panel — bottom-left, public-only */}
      {!isPrivate && (
        <div className="fixed bottom-6 left-6 z-50 pointer-events-auto">
          <div className="w-64 bg-[#0a0a1a]/95 backdrop-blur-md border border-[#ff00cc]/20 rounded-lg shadow-[0_0_20px_rgba(255,0,204,0.15)] p-3">
            <div className="flex items-center justify-between mb-2">
              <div className="text-sm font-bold text-[#ff00cc]">Public Queue</div>
              <div className="text-xs text-[#b0b0ff]/60">
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
                    className="flex items-center justify-between bg-[#0d0020]/60 px-2 py-1 rounded border border-[#ff00cc]/10"
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
                className={`flex-1 text-sm px-3 py-2 rounded font-bold transition ${joiningGame ? "bg-gray-600 cursor-not-allowed" : "bg-gradient-to-r from-[#ff00cc] to-[#00e5ff] text-black hover:from-[#ff00cc]/80 hover:to-[#00e5ff]/80 shadow-[0_0_15px_rgba(255,0,204,0.4)]"}`}
              >
                Join Public
              </button>
              <button
                onClick={() => fetchWaitingPlayers()}
                className="px-3 py-2 rounded text-sm bg-[#0a0a1a] border border-[#00e5ff]/20 text-[#00e5ff]/70 hover:bg-[#00e5ff]/10"
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
