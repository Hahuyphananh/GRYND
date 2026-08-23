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
import Footer from "../../../../components/Footer";
import ReportModal from "../../../../components/ReportModal";
import { RulesModal, useFirstVisitRules } from "../../../../components/lobby/PvpLobby";
import confetti from "canvas-confetti";
import {
  IconCoins,
  IconLock,
  IconGlobe,
  IconEgg,
  IconScale,
  IconFlame,
  IconCards,
  IconKey,
  IconBook,
  IconDeviceGamepad2,
  IconDeviceMobileRotated,
  IconVolume,
  IconVolumeOff,
  IconFlag,
  IconBolt,
  IconRefresh,
  IconCrown,
  IconRobot,
  IconArrowUp,
  IconX,
  IconCheck,
  IconPhone,
} from "@tabler/icons-react";

type Player = {
  id: string;
  name: string;
  stack: number;
  hand: Card[];
  isAI?: boolean;
  difficulty?: "easy" | "medium" | "hard";
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
  const arr = [...deck];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function nextActive(start: number, players: Player[]): number {
  let i = start % players.length;
  let safety = 0;

  console.log("nextActive called", {
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
  const raiseAmountRef = useRef(50);
  const [showRaiseInput, setShowRaiseInput] = useState(false);
  const [raiseInputValue, setRaiseInputValue] = useState(50);
  const [tokenBalance, setTokenBalance] = useState<number>(0);
  const [tableStack, setTableStack] = useState<number>(0);
  const [inviteCode, setInviteCode] = useState("");
  const [joiningGame, setJoiningGame] = useState(false);
  const [isPrivate, setIsPrivate] = useState(true);
  const [leaveAfterHand, setLeaveAfterHand] = useState(false);
  const [showRules, setShowRules] = useState(false);
  const firstVisitRules = useFirstVisitRules("poker");
  useEffect(() => {
    if (firstVisitRules) setShowRules(true);
  }, [firstVisitRules]);
  const [isProcessingTurn, setIsProcessingTurn] = useState(false);
  const [turnTimer, setTurnTimer] = useState(60);
  const [isMyTurn, setIsMyTurn] = useState(false);
  const [publicGameCode, setPublicGameCode] = useState<string | null>(null);
  const [showJoinForm, setShowJoinForm] = useState(false);
  const [aiThinking, setAiThinking] = useState(false);
  const [aiDifficulty, setAiDifficulty] = useState<"easy" | "medium" | "hard">("medium");
  const [aiDifficultyInput, setAiDifficultyInput] = useState<"easy" | "medium" | "hard">("medium");
  const [aiInfoOpen, setAiInfoOpen] = useState(false);
  const [selectedAi, setSelectedAi] = useState<Player | null>(null);
  const [turnTimeLimit, setTurnTimeLimit] = useState(60);
  const [allInFlash, setAllInFlash] = useState(false);
  const [allInParticles, setAllInParticles] = useState<{ id: string; seatIdx: number; delay: number }[]>([]);
  const [showReportModal, setShowReportModal] = useState(false);
  const audio = usePokerAudio();
  const audioRef = useRef(audio);
  audioRef.current = audio;
  const performActionRef = useRef(performAction);
  performActionRef.current = performAction;
  const gameRef = useRef(game);
  gameRef.current = game;
  const myIdRef = useRef(myId);
  myIdRef.current = myId;
  const pendingActionRef = useRef(false);
  const pendingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
  const [showBuyInPopup, setShowBuyInPopup] = useState(false);
  const [buyInAmount, setBuyInAmount] = useState(100);

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
    if (pendingActionRef.current) return;
    try {
      const res = await fetch(
        `/api/poker/game-state?code=${encodeURIComponent(code)}`,
      );
      if (!res.ok) return;
      const data = await res.json();
      if (pendingActionRef.current) return;
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

          // The server intentionally strips `deck` (anti-cheat), so fall
          // back to the local deck to avoid wiping the in-progress deal.
          const remoteDeck = Array.isArray(data.game.deck)
            ? data.game.deck
            : undefined;

          return {
            ...data.game,
            players: mergedPlayers,
            deck: remoteDeck ?? prev.deck,
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
      if (data?.game) {
        setGame((prev) => {
          if (!prev) return data.game;
          // The server intentionally strips `deck` (anti-cheat), so fall
          // back to the local deck to avoid wiping the in-progress deal.
          const remoteDeck = Array.isArray(data.game.deck)
            ? data.game.deck
            : undefined;
          return {
            ...data.game,
            deck: remoteDeck ?? prev.deck,
          };
        });
      }
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
        setTokenBalance(parseFloat(data.data.balance));
        setName(data.data.name || "");
      } else {
        console.error("Failed to fetch tokens:", data.error);
      }
    } catch (err) {
      console.error("Error fetching tokens:", err);
    }
  };

  const leaveCurrentGame = async (cashOutStack?: number) => {
    if (!game?.inviteCode) return;
    try {
      await fetch("/api/poker/leave-game", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gameCode: game.inviteCode, stack: cashOutStack ?? 0 }),
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

    // Defensive: `game.deck` may be undefined/empty if the polled game-state
    // stripped it (the server never exposes the deck). Always rebuild a
    // deck if we don't have one with cards left.
    const existingDeck = Array.isArray(game.deck) ? game.deck : [];
    const newDeck =
      existingDeck.length > 0 ? [...existingDeck] : shuffle(createDeck());

    const players = game.players.map((p) => ({
      ...p,
      hand: [newDeck.pop()!, newDeck.pop()!],
      hasFolded: false,
      lastAction: "",
      currentBet: 0,
      hasActed: false,
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

    // Sync tableStack with blind deductions
    if (players[sbIndex].id === myId) setTableStack((prev) => prev - game.smallBlind);
    if (players[bbIndex].id === myId) setTableStack((prev) => prev - game.bigBlind);

    const firstActorIndex = findFirstActorIndex(
      players,
      game.dealerIndex,
      "pre-flop",
    );

    console.log("GAME START TURN CHECK", {
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
          stack: Number(p.stack),
          hand: [],
          isAI: !!p.isAI,
          difficulty: p.difficulty,
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

      // set balance for THIS user only
      const me = players.find((p) => p.id === clerkId);
      if (me) setTableStack(me.stack);
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

  // ======== AI Helpers: Win Probability & Pot Odds ========
  function computeWinProbability(handStrength: string): number {
    if (!handStrength) return 0.12;
    if (handStrength.includes("Royal Flush")) return 0.99;
    if (handStrength.includes("Straight Flush")) return 0.97;
    if (handStrength.includes("Four of a Kind")) return 0.93;
    if (handStrength.includes("Full House")) return 0.88;
    if (handStrength.includes("Flush")) return 0.78;
    if (handStrength.includes("Straight")) return 0.68;
    if (handStrength.includes("Three of a Kind")) return 0.55;
    if (handStrength.includes("Two Pair")) return 0.45;
    if (handStrength.includes("Pair")) return 0.28;
    return 0.12; // High Card
  }

  function shouldAICall(
    handStrength: string,
    toCall: number,
    pot: number,
    difficulty: "easy" | "medium" | "hard",
  ): boolean {
    const winProb = computeWinProbability(handStrength);
    // Pot odds: amount to call / (pot after call)
    const potAfterCall = pot + toCall;
    const potOdds = potAfterCall > 0 ? toCall / potAfterCall : 0;

    // Difficulty modifiers for calling threshold
    const loosener: Record<string, number> = { easy: 0.15, medium: 0.05, hard: 0 };
    const adjustedOdds = potOdds - loosener[difficulty];

    return winProb >= adjustedOdds;
  }

  function computeAiRaiseAmount(
    handStrength: string,
    pot: number,
    highestBet: number,
    stack: number,
    currentBet: number,
    difficulty: "easy" | "medium" | "hard" = "medium",
  ): number {
    // Hand strength tiers → pot multiplier range
    let minMult: number, maxMult: number, bluffChance: number;

    if (handStrength.includes("Royal Flush") || handStrength.includes("Straight Flush")) {
      return stack + currentBet;
    } else if (handStrength.includes("Four of a Kind") || handStrength.includes("Full House")) {
      minMult = 2.0; maxMult = 3.0; bluffChance = 0;
    } else if (handStrength.includes("Flush") || handStrength.includes("Straight")) {
      minMult = 1.5; maxMult = 2.5; bluffChance = 0.05;
    } else if (handStrength.includes("Three of a Kind") || handStrength.includes("Two Pair")) {
      minMult = 1.0; maxMult = 1.5; bluffChance = 0.15;
    } else if (handStrength.includes("Pair")) {
      minMult = 0.5; maxMult = 1.0; bluffChance = 0.35;
    } else {
      minMult = 0.25; maxMult = 0.5; bluffChance = 0.5;
    }

    // Difficulty adjustments
    if (difficulty === "easy") {
      minMult *= 0.7;
      maxMult *= 0.7;
      bluffChance *= 0.5;
    } else if (difficulty === "hard") {
      minMult *= 1.3;
      maxMult *= 1.3;
      bluffChance = Math.min(bluffChance * 1.5, 0.6);
    }

    if (Math.random() < bluffChance) {
      minMult = Math.max(minMult, 1.0);
      maxMult = Math.max(maxMult, 2.0);
    }

    const multiplier = minMult + Math.random() * (maxMult - minMult);
    const potBased = Math.floor(pot * multiplier);
    const minRaise = Math.max(20, highestBet * 2);
    const maxRaise = stack + currentBet;
    const amount = Math.max(minRaise, Math.min(potBased, maxRaise));

    return amount;
  }

  // ======== AI Turn Logic ========
  useEffect(() => {
    if (!game) return;
    if (game.stage === "showdown" || game.waiting) return;

    const current = game.players[game.currentTurn];
    if (!current || current.hasFolded || !current.isAI) return;          const diff = current.difficulty || aiDifficulty;
          const timer = setTimeout(
      () => {
        try {
          const hs = evaluateHand(current.hand, game.community);
          const highest = Math.max(...game.players.map((p) => p.currentBet));
          const pot = game.pot;
          const toCall = Math.max(0, highest - (current.currentBet || 0));

          let action: "check" | "call" | "raise" | "fold" | "bet20";

          // ── Strong hands always raise ──
          const strongHands = ["Flush", "Straight", "Three", "Full", "Four"];
          const isStrong = strongHands.some((s) => hs.includes(s));

          if (isStrong) {
            action = "raise";
          } else if (toCall > 0) {
            // ── Facing a bet: use pot odds to decide ──
            const shouldCall = shouldAICall(hs, toCall, pot, diff);

            if (shouldCall) {
              // Occasionally raise instead of call (semi-bluff)
              const semiBluffChance = diff === "easy" ? 0.05 : diff === "hard" ? 0.25 : 0.12;
              if (hs.includes("Pair") && Math.random() < semiBluffChance) {
                action = "raise";
              } else {
                action = "call";
              }
            } else {
              action = "fold";
            }
          } else {
            // ── No bet to call: check or bet ──
            const betFreq = diff === "easy" ? 0.15 : diff === "hard" ? 0.55 : 0.35;
            if (Math.random() < betFreq) {
              action = "bet20";
            } else {
              action = "check";
            }

            // Medium+ hands can raise (value bet) instead of bet20
            if ((hs.includes("Pair") || hs.includes("Two Pair")) && Math.random() < 0.3) {
              action = "raise";
            }
          }

          // Compute smart raise amount before performing action
          if (action === "raise") {
            const smartRaise = computeAiRaiseAmount(
              hs,
              pot,
              highest,
              current.stack,
              current.currentBet || 0,
              diff,
            );
            raiseAmountRef.current = smartRaise;
            setRaiseAmount(smartRaise);
          }

          performAction(action as any);
        } finally {
          setAiThinking(false);
        }
      },
      800 + Math.random() * 600,
    );

    setAiThinking(true);

    return () => clearTimeout(timer);
  }, [game?.currentTurn, game?.stage, aiDifficulty]);

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
        setTableStack((prev) => prev + pot);
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
  ) {
    if (!game) return;
    if (pendingTimeoutRef.current) clearTimeout(pendingTimeoutRef.current);
    pendingActionRef.current = true;
    pendingTimeoutRef.current = setTimeout(() => {
      pendingActionRef.current = false;
      pendingTimeoutRef.current = null;
    }, 1500);

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
          setTableStack((prev) => Math.max(prev - actual, 0));
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
        setTableStack((prev) => Math.max(prev - actual, 0));
        fetchUserTokens();
      }
    } else if (action === "raise") {
      audioRef.current.playRaise();
      audioRef.current.playChipPot();
      const effectiveRaise = raiseAmountRef.current;
      const targetBet = Math.max(effectiveRaise, highest);
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
        setTableStack((prev) => Math.max(prev - actual, 0));
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
          setTableStack((prev) => Math.max(prev - actual, 0));
          fetchUserTokens();
        }
      }
    }

    const activePlayers = players.filter((p) => !p.hasFolded);
    const highestBet = Math.max(...players.map((p) => p.currentBet));
    const actionSummary = `${current.name}: ${current.lastAction || action}`;

    // If only one player remains → instant win
    if (activePlayers.length === 1) {
      checkForWinner(players, potNew);
      return;
    }

    // If everyone has matched the bet → end betting round
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

    // Otherwise → advance to next ACTIVE player
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

  function confirmRaise() {
    if (!game || !me) return;
    const amount = Math.min(raiseInputValue, me.stack + (me.currentBet || 0));
    const finalAmount = Math.max(amount, 20);
    raiseAmountRef.current = finalAmount;
    setRaiseAmount(finalAmount);
    setShowRaiseInput(false);
    performAction("raise");
  }

  function cancelRaise() {
    setShowRaiseInput(false);
  }

  function setRaiseFraction(fraction: "half" | "threeQuarter" | "allIn") {
    if (!game || !me) return;
    const highestBetInRound = Math.max(
      ...game.players.map((p) => p.currentBet || 0),
    );
    let amount = 0;
    if (fraction === "half") {
      amount = Math.floor(game.pot / 2);
    } else if (fraction === "threeQuarter") {
      amount = Math.floor((game.pot * 3) / 4);
    } else if (fraction === "allIn") {
      amount = me.stack + (me.currentBet || 0);
    }
    const minRaise = Math.max(20, highestBetInRound * 2);
    setRaiseInputValue(Math.max(amount, minRaise));
  }

  async function advanceStage() {
    if (!game) return;
    const deck = [...game.deck];
    const comm = [...game.community];
    const playersReset = game.players.map((p) => ({
      ...p,
      currentBet: 0,
      hasActed: false,
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

    console.log("STAGE ADVANCE TURN CHECK", {
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
      setTableStack((prev) => prev + game.pot);
      fetchUserTokens();
      confetti({ particleCount: 120, spread: 80, origin: { y: 0.5 }, colors: ["#ffd700", "#ff00cc", "#00e5ff"] });
      setTimeout(() => confetti({ particleCount: 60, spread: 120, origin: { y: 0.4 }, colors: ["#ffd700", "#ffffff"] }), 300);
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
        leaveCurrentGame(updated.find((p) => p.id === myId)?.stack).finally(() => {
          window.location.href = "/casino/poker/multi";
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

  function openBuyInPopup() {
    if (selectedSeat === null || !game || !clerkId) return;

    if (game.players.some((p) => p.id === clerkId)) {
      alert("You are already seated.");
      return;
    }

    // Reset buy-in amount to a sensible default
    const defaultBuyIn = Math.min(100, tokenBalance || 100);
    setBuyInAmount(defaultBuyIn);
    setShowBuyInPopup(true);
  }

  async function confirmBuyIn() {
    if (selectedSeat === null || !game || !clerkId) return;
    if (buyInAmount < 10) return alert("Buy-in must be at least 10 tokens");
    if (buyInAmount > tokenBalance) return alert("Insufficient balance for this buy-in");

    const res = await fetch("/api/poker/sit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        gameCode: game.inviteCode,
        seatIndex: selectedSeat,
        playerName: name,
        buyIn: buyInAmount,
      }),
    });

    const data = await res.json();
    if (!res.ok) return alert(data.error || "Failed to sit");

    // Set table stack from buy-in amount, fetch latest from DB
    setTableStack(buyInAmount);
    await fetchGameState(game.inviteCode!);
    await fetchUserTokens();
    setShowBuyInPopup(false);
    setSeatModalOpen(false);
    setSelectedSeat(null);
  }

  function cancelBuyIn() {
    setShowBuyInPopup(false);
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
        difficulty: aiDifficultyInput,
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
      <div className="min-h-screen flex flex-col items-center justify-start bg-gradient-to-b from-[#0a0118] to-[#061b3d] text-white">
        <div className="absolute top-4 left-4">
          <button
            onClick={() => setShowJoinForm(false)}
            className="bg-amber-400 hover:bg-amber-300 text-black px-4 py-2 rounded font-bold transition shadow-[0_0_14px_rgba(251,191,36,0.45)]"
          >
            ← Back
          </button>
        </div>

        <div className="p-6 bg-black/40 border border-amber-700/60 rounded shadow-[0_0_24px_rgba(251,191,36,0.15)] w-96 text-center">
          <h1 className="text-2xl mb-4">Join a Private Game</h1>

          <input
            placeholder="Enter Invite Code"
            value={inviteCode}
            onChange={(e) => setInviteCode(e.target.value)}
            className="w-full rounded-lg border border-amber-600/50 bg-[#020617] px-3 py-2 text-white placeholder:text-white/30 focus:outline-none focus:border-amber-400 focus:shadow-[0_0_10px_rgba(251,191,36,0.3)] transition mb-2"
          />

          <button
            onClick={() => joinGame()}
            className="mb-2 w-full rounded-lg border border-cyan-500/70 bg-cyan-500/20 px-4 py-2 text-sm font-medium text-cyan-100 hover:bg-cyan-500/55 active:scale-95 transition shadow-[0_0_12px_rgba(34,211,238,0.3)]"
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
        <div className="min-h-screen flex items-center justify-center bg-gradient-to-b from-[#0a0118] to-[#061b3d] text-white">
          Loading poker match...
        </div>
      );
    }

    return (
      <div className="min-h-screen bg-gradient-to-b from-[#0a0118] to-[#061b3d] text-white p-6">
        <h1 className="text-3xl font-bold mb-2">Poker Spectate</h1>
        <p className="text-sm text-slate-300 mb-4">Live POV overlay</p>
        <div className="mb-4 rounded border border-yellow-500/30 bg-black/30 px-4 py-2">
          <span className="inline-flex items-center gap-1.5"><IconCoins size={16} className="text-yellow-400" /> POT: {game.pot}</span>
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
      <div className="relative min-h-screen overflow-x-clip bg-gradient-to-b from-[#0a0118] to-[#061b3d] px-3 pb-24 pt-20 text-white sm:px-6 md:pb-8">
        {/* ── Subtle scanlines backdrop ── */}
        <div
          className="fixed inset-0 pointer-events-none z-0 opacity-[0.03]"
          style={{
            backgroundImage:
              "repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(255,215,0,0.15) 2px, rgba(255,215,0,0.15) 4px)",
          }}
        />

        <NavigationBar currentPath="/casino" />

        <div className="relative z-10 mx-auto max-w-5xl">
          <motion.div
            initial={{ opacity: 0, y: -12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4 }}
            className="text-center"
          >
            <a
              href="/casino"
              className="mb-4 inline-flex items-center gap-1 text-xs font-semibold uppercase tracking-wider text-cyan-200/70 transition-colors hover:text-amber-300"
            >
              ← Back to Games
            </a>
            <h1 className="text-3xl font-black uppercase tracking-widest text-transparent bg-clip-text bg-gradient-to-r from-[#ffd700] via-amber-400 to-[#ffd700] drop-shadow-[0_0_18px_rgba(255,215,0,0.55)] sm:text-5xl">
              ♠ Poker Royale ♠
            </h1>
            <p className="mx-auto mt-3 max-w-xl text-sm text-white/60 sm:text-base">
              Create a Texas Hold'em table, invite friends with a code, or jump
              into a public match against up to 5 other players.
            </p>

            {/* How to Play — rules modal at the top of the lobby */}
            <div className="mt-5 text-center">
              <button
                onClick={() => setShowRules(true)}
                className="inline-flex items-center gap-1.5 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm font-bold text-amber-300 transition-all duration-300 hover:bg-amber-500/20 hover:scale-105 shadow-[0_0_14px_rgba(251,191,36,0.15)]"
              >
                <IconBook size={15} /> How to Play
              </button>
            </div>
            {showRules && (
              <RulesModal
                title="How to Play"
                sections={[
                  {
                    heading: "Texas Hold'em",
                    body: (
                      <>
                        Each player gets two hole cards and shares five
                        community cards dealt across the flop, turn, and
                        river. Make the best 5-card hand to win the pot.
                      </>
                    ),
                  },
                  {
                    heading: "Blinds & betting",
                    body: (
                      <>
                        Small and big blinds rotate around the table each
                        hand. Check, call, raise, or fold on your turn.
                      </>
                    ),
                  },
                  {
                    heading: "Tables",
                    body: (
                      <>
                        Create a private table and share your invite code,
                        or join a public game from the queue, up to 6
                        players per table.
                      </>
                    ),
                  },
                ]}
                onClose={() => setShowRules(false)}
              />
            )}
          </motion.div>

          {/* ── Create table panel ── */}
          <motion.div
            initial={{ opacity: 0, y: 15 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45, delay: 0.05 }}
            className="mt-8 rounded-2xl border border-amber-700/60 bg-black/40 p-6 shadow-[0_0_40px_rgba(251,191,36,0.12)] backdrop-blur-xl sm:p-8"
          >
            <div className="mb-6 flex flex-col items-center justify-between gap-3 sm:flex-row">
              <div>
                <h2 className="text-xl font-bold text-amber-300 sm:text-2xl">
                  Create a Table
                </h2>
                <p className="mt-1 max-w-md text-sm text-white/70">
                  Pick your name, table visibility and AI difficulty, then sit
                  down at a seat to buy in.
                </p>
              </div>
              <div className="rounded-lg border border-amber-700/50 bg-[#020617]/80 px-4 py-2 text-center">
                <p className="text-[10px] uppercase tracking-wider text-white/50">
                  Balance
                </p>
                <p className="text-base font-bold text-transparent bg-clip-text bg-gradient-to-r from-yellow-300 to-yellow-500">
                  <span className="inline-flex items-center gap-1.5"><IconCoins size={18} className="text-yellow-300" /> {tokenBalance.toLocaleString()}</span>
                </p>
              </div>
            </div>

            <div className="mb-6">
              <label
                htmlFor="poker-name"
                className="mb-2 block text-[11px] uppercase tracking-wider text-white/60"
              >
                Display name
              </label>
              <input
                id="poker-name"
                placeholder="Your display name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full rounded-lg border border-amber-600/50 bg-[#020617] p-2.5 text-sm text-white outline-none transition focus:border-amber-400 focus:shadow-[0_0_10px_rgba(251,191,36,0.25)]"
              />
            </div>

            <div className="mb-6">
              <p className="mb-2 block text-[11px] uppercase tracking-wider text-white/60">
                Table visibility
              </p>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <button
                  onClick={() => setIsPrivate(true)}
                  className={`flex items-center gap-3 rounded-xl border-2 px-4 py-3 text-left transition-all ${
                    isPrivate
                      ? "border-amber-400 bg-amber-500/15 shadow-[0_0_14px_rgba(251,191,36,0.3)]"
                      : "border-cyan-700/40 bg-slate-900/80 hover:border-cyan-500/50"
                  }`}
                >
                  <IconLock size={22} className="text-cyan-300" aria-hidden />
                  <span>
                    <span className="block text-sm font-bold text-white">
                      Private
                    </span>
                    <span className="block text-xs text-white/50">
                      Invite friends with a code
                    </span>
                  </span>
                </button>
                <button
                  onClick={() => setIsPrivate(false)}
                  className={`flex items-center gap-3 rounded-xl border-2 px-4 py-3 text-left transition-all ${
                    !isPrivate
                      ? "border-amber-400 bg-amber-500/15 shadow-[0_0_14px_rgba(251,191,36,0.3)]"
                      : "border-cyan-700/40 bg-slate-900/80 hover:border-cyan-500/50"
                  }`}
                >
                  <IconGlobe size={22} className="text-cyan-300" aria-hidden />
                  <span>
                    <span className="block text-sm font-bold text-white">
                      Public
                    </span>
                    <span className="block text-xs text-white/50">
                      Anyone can join your table
                    </span>
                  </span>
                </button>
              </div>
            </div>

            <div className="mb-6">
              <p className="mb-2 block text-[11px] uppercase tracking-wider text-white/60">
                AI difficulty
              </p>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                {(
                  [
                    { key: "easy", icon: <IconEgg size={18} className="text-green-400" />, label: "Easy", desc: "Beginner bots" },
                    { key: "medium", icon: <IconScale size={18} className="text-amber-300" />, label: "Medium", desc: "Balanced play" },
                    { key: "hard", icon: <IconFlame size={18} className="text-red-400" />, label: "Hard", desc: "Tough opponents" },
                  ] as const
                ).map((d) => (
                  <button
                    key={d.key}
                    onClick={() => setAiDifficulty(d.key)}
                    className={`rounded-xl border-2 px-4 py-3 text-left transition-all ${
                      aiDifficulty === d.key
                        ? "border-amber-400 bg-amber-500/15 shadow-[0_0_14px_rgba(251,191,36,0.3)]"
                        : "border-cyan-700/40 bg-slate-900/80 hover:border-cyan-500/50"
                    }`}
                  >
                    <span className="block text-sm font-bold text-white">
                      {d.icon} {d.label}
                    </span>
                    <span className="block text-xs text-white/50">{d.desc}</span>
                  </button>
                ))}
              </div>
            </div>

            <button
              onClick={() => createGame()}
              className="w-full rounded-xl bg-amber-500 border-b-4 border-amber-700 p-3 text-base font-black text-black shadow-[0_0_18px_rgba(251,191,36,0.4)] transition-all duration-150 hover:brightness-110 hover:scale-[1.01] active:scale-95"
            >
              <span className="inline-flex items-center gap-2"><IconCards size={18} /> Create Game</span>
            </button>

            <div className="relative my-5 flex items-center gap-3">
              <div className="h-px flex-1 bg-gradient-to-r from-transparent via-amber-500/30 to-transparent" />
              <span className="text-[10px] uppercase tracking-[0.3em] text-white/40">
                or
              </span>
              <div className="h-px flex-1 bg-gradient-to-r from-transparent via-amber-500/30 to-transparent" />
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <button
                onClick={() => setShowJoinForm(true)}
                className="flex items-center justify-center gap-2 rounded-xl border border-cyan-500/40 bg-cyan-500/10 p-3 text-sm font-bold text-cyan-100 transition-all hover:bg-cyan-500/25 active:scale-95"
              >
                <span className="inline-flex items-center gap-2"><IconKey size={16} /> Join with Invite Code</span>
              </button>
              <button
                onClick={
                  availablePublicGames > 0 ? () => joinPublicGame() : undefined
                }
                disabled={availablePublicGames === 0}
                className={`flex items-center justify-center gap-2 rounded-xl border-2 p-3 text-sm font-bold transition-all active:scale-95 ${
                  availablePublicGames > 0
                    ? "border-cyan-500/50 bg-cyan-500/15 text-cyan-100 hover:bg-cyan-500/30 shadow-[0_0_14px_rgba(34,211,238,0.25)]"
                    : "cursor-not-allowed border-gray-600 bg-gray-700 text-gray-400"
                }`}
              >
                <span className="inline-flex items-center gap-2">
                  <IconGlobe size={16} />
                  {availablePublicGames > 0
                    ? `Join a Public Game (${availablePublicGames})`
                    : "No Public Games Open"}
                </span>
              </button>
            </div>
          </motion.div>

          {/* ── Available public tables ── */}
          <motion.div
            initial={{ opacity: 0, y: 15 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45, delay: 0.1 }}
            className="mt-6 rounded-2xl border border-amber-700/60 bg-black/40 p-5 shadow-[0_0_22px_rgba(251,191,36,0.1)] sm:p-6"
          >
            <div className="mb-4 flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-lg font-bold uppercase tracking-wider text-cyan-300">
                <IconDeviceGamepad2 size={20} className="text-cyan-300" aria-hidden />
                <span>Available Public Tables</span>
              </h2>
              <button
                onClick={fetchPublicGamesCount}
                className="rounded-lg bg-cyan-500 px-3 py-1.5 text-xs font-semibold text-black shadow-[0_0_10px_rgba(34,211,238,0.35)] transition-colors hover:bg-cyan-400"
              >
                Refresh
              </button>
            </div>

            {publicGameList.length === 0 ? (
              <div className="py-8 text-center">
                <IconCards size={48} className="opacity-30" />
                <p className="mt-2 text-sm text-white/60">
                  No open tables right now. Create one from the options above.
                </p>
              </div>
            ) : (
              <div className="space-y-2.5">
                {publicGameList.map((g) => (
                  <div
                    key={g.gameCode}
                    className="flex items-center justify-between rounded-xl border border-cyan-700/30 bg-slate-900/80 p-3 transition-colors hover:border-cyan-500/50"
                  >
                    <div>
                      <p className="text-sm font-semibold">
                        {g.hostName || "Player"} ·{" "}
                        <span className="font-mono text-cyan-300">
                          {g.gameCode}
                        </span>
                      </p>
                      <p className="text-xs text-white/60">
                        {g.occupiedSeats}/{g.maxPlayers} players ·{" "}
                        {g.openSeats > 0 ? (
                          <span className="text-emerald-300">
                            {g.openSeats} open seat
                            {g.openSeats > 1 ? "s" : ""}
                          </span>
                        ) : (
                          <span className="text-amber-300">Table full</span>
                        )}
                      </p>
                    </div>
                    <button
                      onClick={() => joinPublicGame(g.gameCode)}
                      disabled={joiningGame}
                      className="rounded-lg bg-cyan-500 px-4 py-1.5 text-sm font-bold text-black transition-colors hover:bg-cyan-400 disabled:bg-cyan-500/30 disabled:text-white/60"
                    >
                      {joiningGame ? "Joining..." : "Join"}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </motion.div>
        </div>
        <Footer />
      </div>
    );
  }


  // main UI when game exists
  return (
    <div className="min-h-screen pb-36 lg:pb-0 flex flex-col items-center justify-center bg-gradient-to-b from-[#0a0118] to-[#061b3d] text-white overflow-hidden relative">
      {/* ── Portrait-mode overlay (mobile only) ── */}
      {isPortrait && (
        <div className="fixed inset-0 z-[200] flex flex-col items-center justify-center bg-black/90 backdrop-blur-md">
          <div className="mb-6 animate-spin" style={{ animationDuration: "4s" }}><IconDeviceMobileRotated size={60} /></div>
          <p className="text-2xl font-bold text-[#00e5ff] drop-shadow-[0_0_12px_#00e5ff] mb-2">
            Tournez votre téléphone
          </p>
          <p className="text-sm text-[#b0b0ff]/70">Mode paysage requis pour le Texas Hold'em</p>
        </div>
      )}

      {/* ── Ambient scanlines overlay ── */}
      <div className="fixed inset-0 pointer-events-none z-0 opacity-[0.03]"
        style={{
          backgroundImage: "repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,229,255,0.15) 2px, rgba(0,229,255,0.15) 4px)",
        }}
      />

      {/* ── Top bar: Return | Title | Sound ── */}
      <div className="pointer-events-none absolute top-0 left-0 right-0 z-30 flex items-center justify-between gap-3 px-3 pt-3 sm:px-5 sm:pt-4">
        <button
          onClick={async () => {
            if (game?.stage === "showdown" || game?.waiting) {
              const meStack = game?.players.find((p) => p.id === myId)?.stack ?? 0;
              await leaveCurrentGame(meStack);
              await fetchUserTokens();
              setGame(null);
            } else {
              alert("You can only return to the form after the hand ends!");
            }
          }}
          className={`pointer-events-auto px-4 py-2 rounded-lg font-bold transition text-sm ${
            game?.stage === "showdown" || game?.waiting
              ? "bg-gradient-to-r from-[#ff00cc]/70 to-[#00e5ff]/70 text-black hover:from-[#ff00cc] hover:to-[#00e5ff] shadow-[0_0_15px_rgba(255,0,204,0.4)]"
              : "bg-[#0a0a1a]/80 text-[#b0b0ff]/40 border border-[#b0b0ff]/10 cursor-not-allowed"
          }`}
        >
          ← Return
        </button>

        <h1 className="text-center text-xl font-black uppercase leading-none tracking-widest text-transparent bg-clip-text bg-gradient-to-r from-[#ff00cc] via-[#00e5ff] to-[#ff00cc] drop-shadow-[0_0_20px_rgba(255,0,204,0.8)] sm:text-3xl">
          TEXAS HOLD'EM
        </h1>

        <button
          onClick={() => audio.setEnabled(!audio.enabled)}
          className="pointer-events-auto flex h-10 w-10 items-center justify-center rounded-full border border-[#00e5ff]/30 bg-[#0a0a1a]/80 text-lg shadow-[0_0_10px_rgba(0,229,255,0.2)] transition hover:bg-[#00e5ff]/20"
          title={audio.enabled ? "Mute sounds" : "Enable sounds"}
        >
          {audio.enabled ? <IconVolume size={20} /> : <IconVolumeOff size={20} />}
        </button>
      </div>

      {/* ── Table controls: report / timer / invite / actions ── */}
      <div className="relative z-10 mt-20 mb-4 flex flex-wrap items-center justify-center gap-2 sm:mt-24">
        {game && game.players.some((p) => !p.isAI && p.id !== myId) && (
          <button
            onClick={() => setShowReportModal(true)}
            className="px-3 py-1.5 rounded-lg bg-red-500/20 border border-red-500/40 text-xs font-bold text-red-300 hover:bg-red-500/30 transition"
          >
            <span className="inline-flex items-center gap-1.5"><IconFlag size={14} /> Report Player</span>
          </button>
        )}

        <div className="flex items-center gap-2 rounded-lg border border-[#ff00cc]/25 bg-[#0a0a1a]/85 px-3 py-1.5 text-xs text-[#b0b0ff]/70 backdrop-blur-sm">
          <span className="text-[10px] uppercase tracking-wider">Turn timer</span>
          <select
            value={turnTimeLimit}
            onChange={(e) => setTurnTimeLimit(Number(e.target.value) || 60)}
            className="rounded border border-[#ff00cc]/30 bg-transparent px-1.5 py-0.5 text-[#ff00cc] focus:outline-none focus:border-[#ff00cc]"
          >
            <option value={15}>15s</option>
            <option value={30}>30s</option>
            <option value={60}>60s</option>
          </select>
        </div>

        {game?.inviteCode && (
          <div className="flex items-center gap-2 rounded-lg border border-[#00e5ff]/25 bg-[#0a0a1a]/85 px-3 py-1.5 backdrop-blur-sm">
            <span className="text-[10px] uppercase tracking-wider text-[#b0b0ff]/70">Code</span>
            <span className="font-mono text-sm font-bold tracking-wider text-[#00e5ff]">
              {game.inviteCode}
            </span>
            <button
              onClick={() => {
                navigator.clipboard.writeText(game.inviteCode || "");
                alert("Invite code copied!");
              }}
              className="rounded border border-[#ff00cc]/40 bg-[#ff00cc]/20 px-2 py-0.5 text-[10px] font-bold text-[#ff00cc] transition hover:bg-[#ff00cc]/35"
            >
              Copy
            </button>
          </div>
        )}

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
            className={`bg-gradient-to-r from-[#ff00cc]/80 to-[#00e5ff]/80 px-5 py-2 rounded-lg font-bold text-black transition hover:from-[#ff00cc] hover:to-[#00e5ff] shadow-[0_0_20px_rgba(255,0,204,0.5)] ${
              game.players.length < 2 ? "opacity-40 cursor-not-allowed" : ""
            }`}
            disabled={game.players.length < 2}
          >
            <span className="inline-flex items-center gap-1.5"><IconBolt size={16} /> Start Game</span>
          </button>
        )}

        {game?.replayVisible && (
          <button
            onClick={replayHand}
            className="bg-gradient-to-r from-[#ff00cc]/60 to-[#ff00cc]/60 border border-[#ff00cc]/50 text-white px-5 py-2 rounded-lg font-bold transition hover:from-[#ff00cc] hover:to-[#ff00cc] shadow-[0_0_15px_rgba(255,0,204,0.4)]"
          >
            <span className="inline-flex items-center gap-1.5"><IconRefresh size={16} /> Replay Hand</span>
          </button>
        )}

        {(game?.stage === "showdown" || game?.waiting) && me && me.stack > 0 && (
          <button
            onClick={async () => {
              const cs = me.stack;
              await leaveCurrentGame(cs);
              await fetchUserTokens();
              setGame(null);
            }}
            className="bg-gradient-to-r from-[#FFD700]/70 to-[#FFA500]/70 border border-[#FFD700]/50 text-black px-5 py-2 rounded-lg font-bold transition hover:from-[#FFD700] hover:to-[#FFA500] shadow-[0_0_15px_rgba(255,215,0,0.4)]"
          >
            <span className="inline-flex items-center gap-1.5"><IconCoins size={16} /> Retirer {me.stack} jetons</span>
          </button>
        )}

        {game?.stage !== "showdown" && !game?.waiting && (
          <label className="flex cursor-pointer select-none items-center gap-2 rounded-lg border border-[#ff00cc]/20 bg-[#0a0a1a]/85 px-3 py-1.5 backdrop-blur-sm">
            <input
              type="checkbox"
              checked={leaveAfterHand}
              onChange={(e) => setLeaveAfterHand(e.target.checked)}
              className="h-4 w-4 cursor-pointer rounded border-[#ff00cc]/40 bg-[#0a0a1a] accent-[#ff00cc] focus:ring-[#ff00cc]"
            />
            <span className="text-xs text-[#b0b0ff]/70">Quitter après cette main</span>
          </label>
        )}
      </div>

      {(game.actionLog?.length ?? 0) > 0 && (
        <div className="mb-3 w-full max-w-xl rounded-lg bg-[#0a0a1a]/90 border border-[#ff00cc]/20 p-2 text-xs z-10 backdrop-blur-sm">
          <div className="font-bold text-[#ff00cc] mb-1 drop-shadow-[0_0_6px_#ff00cc]">Recent actions</div>
          <div className="space-y-1">
            {game.actionLog!.map((entry, idx) => (
              <div
                key={`${entry.at}-${idx}`}
                className="truncate text-[#b0b0ff]/80"
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
          <div className="absolute w-[180px] h-[60px] rounded-[50%] border border-[#00e5ff]/15 shadow-[0_0_40px_rgba(0,229,255,0.15)]" />

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
                <span className="inline-flex items-center gap-2"><IconCrown size={40} /> WINNER!</span>
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
      bg-white
      ${c?.suit === "♥" || c?.suit === "♦"
                    ? "text-red-600 border-red-300"
                    : "text-black border-slate-400"
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
                    <span className="truncate text-[#ffffff]/90">{occupant.name}{occupant.isAI && <> <span title={`AI Difficulty: ${(occupant.difficulty || aiDifficulty).charAt(0).toUpperCase() + (occupant.difficulty || aiDifficulty).slice(1)}`}>{(occupant.difficulty || aiDifficulty) === "easy" ? <span className="inline-block h-2 w-2 rounded-full bg-green-400" /> : (occupant.difficulty || aiDifficulty) === "medium" ? <span className="inline-block h-2 w-2 rounded-full bg-yellow-400" /> : <span className="inline-block h-2 w-2 rounded-full bg-red-500" />}</span></>}</span>
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
                      <span className="px-2 py-[2px] rounded bg-purple-900/80 text-purple-300 border border-purple-500/30">
                        All-in
                      </span>
                    ) : game?.players?.[game.currentTurn]?.id ===
                      occupant.id ? (
                      <span className="px-2 py-[2px] rounded bg-[#ff00cc]/80 text-black font-bold shadow-[0_0_15px_rgba(255,0,204,0.9)]">
                        <span className="inline-flex items-center gap-1"><IconBolt size={12} /> THINKING</span>
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
                        <span className="inline-flex items-center gap-1"><IconBolt size={12} /> Your Turn ({turnTimer}s)</span>
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
        })}          {/* Chips / CHECK displayed relative to table */}
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
              {showChips ? p.currentBet : <IconCheck size={12} className="inline" />}
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

          <div className="relative border border-amber-700/60 bg-[#12042a] p-6 rounded-xl w-[340px] z-[100] pointer-events-auto">
            <h2 className="text-xl font-bold mb-2">Seat {selectedSeat}</h2>

            <p className="text-sm text-gray-300 mb-4">
              Who should sit in this seat?
            </p>

            {/* HUMAN OPTION */}
            <button
              onClick={openBuyInPopup}
              className="w-full bg-amber-400 text-black px-4 py-2 rounded font-bold mb-3 hover:bg-amber-300"
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

                <label className="block text-sm mb-1">AI Difficulty</label>
                <select
                  value={aiDifficultyInput}
                  onChange={(e) => setAiDifficultyInput(e.target.value as "easy" | "medium" | "hard")}
                  className="w-full p-2 rounded text-black mb-2"
                >
                  <option value="easy">Easy</option>
                  <option value="medium">Medium</option>
                  <option value="hard">Hard</option>
                </select>

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
      {/* ── Buy-in Popup ── */}
      {showBuyInPopup && selectedSeat !== null && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center pointer-events-auto">
          <div
            className="absolute inset-0 bg-black/60 z-[105]"
            onClick={cancelBuyIn}
          />

          <motion.div
            initial={{ scale: 0.9, opacity: 0, y: 20 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.9, opacity: 0, y: 20 }}
            transition={{ type: "spring", stiffness: 300, damping: 25 }}
            className="relative z-[110] pointer-events-auto w-[360px] bg-[#12042a]/95 backdrop-blur-xl border-2 border-amber-700/60 rounded-2xl p-5 shadow-[0_0_40px_rgba(251,191,36,0.2)]"
          >
            <h2 className="text-lg font-black text-transparent bg-clip-text bg-gradient-to-r from-amber-300 to-yellow-500 mb-1 text-center">
              <span className="inline-flex items-center gap-1.5"><IconCoins size={18} /> Achat de jetons</span>
            </h2>
            <p className="text-[10px] text-white/50 text-center mb-4 uppercase tracking-widest">
              Seat {selectedSeat}. Définissez votre mise initiale
            </p>

            {/* Balance display */}
            <div className="mb-3 flex items-center justify-between bg-black/40 px-4 py-2 rounded-xl border border-amber-700/40">
              <span className="text-white/60 text-sm">Solde disponible</span>
              <span className="text-amber-300 font-black text-lg">{tokenBalance.toLocaleString()} jetons</span>
            </div>

            {/* Buy-in input */}
            <div className="mb-3">
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-amber-300 font-bold text-lg">$</span>
                <input
                  type="number"
                  value={buyInAmount}
                  onChange={(e) => setBuyInAmount(parseInt(e.target.value) || 0)}
                  onBlur={() => { if (!buyInAmount || buyInAmount < 10) setBuyInAmount(10); }}
                  onKeyDown={(e) => { if (e.key === "Enter") confirmBuyIn(); if (e.key === "Escape") cancelBuyIn(); }}
                  min={0}
                  max={tokenBalance}
                  autoFocus
                  className="w-full pl-8 pr-4 py-3 rounded-xl bg-black/50 border-2 border-amber-600/50 text-amber-300 text-2xl font-black text-center placeholder:text-amber-300/30 focus:outline-none focus:border-amber-400 focus:shadow-[0_0_20px_rgba(251,191,36,0.3)] transition-all"
                  placeholder="Mise"
                />
              </div>
              <div className="text-[10px] text-white/40 text-center mt-1">
                Minimum 10 jetons
              </div>
            </div>

            {/* Quick presets */}
            <div className="grid grid-cols-4 gap-2 mb-4">
              {[10, 25, 50, 100, 250, 500, 1000].map((v) => (
                v <= tokenBalance ? (
                  <button
                    key={v}
                    onClick={() => setBuyInAmount(v)}
                    className={`px-2 py-1.5 rounded-xl text-xs font-bold border transition-all active:scale-95 ${
                      buyInAmount === v
                        ? "bg-amber-500/30 border-amber-400 text-amber-300 shadow-[0_0_10px_rgba(251,191,36,0.3)]"
                        : "bg-black/40 border-amber-700/30 text-white/60 hover:border-amber-500/50 hover:text-amber-300"
                    }`}
                  >{v}</button>
                ) : null
              ))}
            </div>

            {/* ½ Balance / All-in */}
            <div className="grid grid-cols-2 gap-2 mb-4">
              <button
                onClick={() => setBuyInAmount(Math.max(10, Math.floor(tokenBalance / 2)))}
                className="px-3 py-2 rounded-xl text-xs font-bold border border-cyan-500/40 bg-cyan-500/10 text-cyan-300 hover:bg-cyan-500/25 hover:border-cyan-500/60 active:scale-95 transition-all"
              >
                ½ Solde
              </button>
              <button
                onClick={() => setBuyInAmount(tokenBalance)}
                className="px-3 py-2 rounded-xl text-xs font-bold border border-amber-400/40 bg-amber-400/10 text-amber-300 hover:bg-amber-400/25 hover:border-amber-400/60 active:scale-95 transition-all shadow-[0_0_10px_rgba(251,191,36,0.15)]"
              >
                <span className="inline-flex items-center gap-1.5"><IconFlame size={14} /> Tout miser</span>
              </button>
            </div>

            {/* Confirm / Cancel */}
            <div className="flex gap-3">
              <button
                onClick={cancelBuyIn}
                className="flex-1 px-4 py-3 rounded-xl font-bold text-sm border border-red-500/40 bg-red-900/20 text-red-300 hover:bg-red-900/40 hover:border-red-500/60 active:scale-95 transition-all"
              >
                Annuler
              </button>
              <button
                onClick={confirmBuyIn}
                disabled={buyInAmount < 10 || buyInAmount > tokenBalance}
                className={`flex-1 px-4 py-3 rounded-xl font-bold text-sm transition-all active:scale-95 ${
                  buyInAmount >= 10 && buyInAmount <= tokenBalance
                    ? "bg-amber-500 border-b-4 border-amber-700 text-black hover:brightness-110 shadow-[0_0_20px_rgba(251,191,36,0.4)]"
                    : "bg-gray-700 text-gray-400 cursor-not-allowed"
                }`}
              >
                Confirmer {buyInAmount >= 10 ? `${buyInAmount} jetons` : ""}
              </button>
            </div>
          </motion.div>
        </div>
      )}

      {aiInfoOpen && selectedAi && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center">
          <div className="bg-black/70 backdrop-blur-md border border-yellow-500/60 shadow-[0_0_15px_rgba(255,215,0,0.3)] p-6 rounded-xl w-80 shadow-xl">
            <h2 className="text-xl font-bold mb-4 text-center text-yellow-400">
              <span className="inline-flex items-center gap-1.5"><IconRobot size={20} /> AI Player Info</span>
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

      {/* ── Raise Input Modal ── */}
      {showRaiseInput && (
        <div className="fixed inset-0 z-[150] flex items-center justify-center pointer-events-auto">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/70 z-[140]"
            onClick={cancelRaise}
          />

          <motion.div
            initial={{ scale: 0.9, opacity: 0, y: 20 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.9, opacity: 0, y: 20 }}
            transition={{ type: "spring", stiffness: 300, damping: 25 }}
            className="relative z-[150] pointer-events-auto w-[340px] bg-[#0a0a1a]/95 backdrop-blur-xl border-2 border-[#ff00cc]/40 rounded-2xl p-5 shadow-[0_0_40px_rgba(255,0,204,0.3)]"
          >
            <h2 className="text-lg font-black text-transparent bg-clip-text bg-gradient-to-r from-[#ff00cc] to-[#00e5ff] mb-1 text-center">
              <span className="inline-flex items-center gap-1.5"><IconArrowUp size={18} /> Raise Amount</span>
            </h2>
            <p className="text-[10px] text-[#b0b0ff]/50 text-center mb-4 uppercase tracking-widest">
              Set your raise. Min {(() => { const h = Math.max(...(game?.players ?? []).map(p => p.currentBet || 0)); return Math.max(20, h * 2); })()}
            </p>

            {/* Number input */}
            <div className="mb-4">
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[#ff00cc] font-bold text-lg">$</span>
                <input
                  type="number"
                  value={raiseInputValue}
                  onChange={(e) => setRaiseInputValue(Math.max(0, Number(e.target.value) || 0))}
                  onKeyDown={(e) => { if (e.key === "Enter") confirmRaise(); if (e.key === "Escape") cancelRaise(); }}
                  min={0}
                  autoFocus
                  className="w-full pl-8 pr-4 py-3 rounded-xl bg-[#0d0020]/80 border-2 border-[#ff00cc]/50 text-[#00e5ff] text-2xl font-black text-center placeholder:text-[#ff00cc]/30 focus:outline-none focus:border-[#ff00cc] focus:shadow-[0_0_20px_rgba(255,0,204,0.4)] transition-all"
                  placeholder="Enter amount"
                />
              </div>
              <div className="text-[10px] text-[#b0b0ff]/40 text-center mt-1">
                Stack: ${me?.stack ?? 0} &nbsp;|&nbsp; Current bet: ${me?.currentBet ?? 0}
              </div>
            </div>

            {/* Quick amount presets */}
            <div className="grid grid-cols-4 gap-2 mb-4">
              <button
                onClick={() => setRaiseFraction("half")}
                className="px-3 py-2 rounded-xl text-xs font-bold border border-[#00e5ff]/30 bg-[#00e5ff]/10 text-[#00e5ff] hover:bg-[#00e5ff]/25 hover:border-[#00e5ff]/60 active:scale-95 transition-all"
              >
                ½ Pot
              </button>
              <button
                onClick={() => setRaiseFraction("threeQuarter")}
                className="px-3 py-2 rounded-xl text-xs font-bold border border-[#ff00cc]/30 bg-[#ff00cc]/10 text-[#ff00cc] hover:bg-[#ff00cc]/25 hover:border-[#ff00cc]/60 active:scale-95 transition-all"
              >
                ¾ Pot
              </button>
              <button
                onClick={() => { if (me) { const half = Math.floor((me.stack + (me.currentBet || 0)) / 2); const h = Math.max(...(game?.players ?? []).map(p => p.currentBet || 0)); setRaiseInputValue(Math.max(half, Math.max(20, h * 2))); } }}
                className="px-3 py-2 rounded-xl text-xs font-bold border border-[#ff00cc]/30 bg-[#ff00cc]/10 text-[#ff00cc] hover:bg-[#ff00cc]/25 hover:border-[#ff00cc]/60 active:scale-95 transition-all"
              >
                ½ Stack
              </button>
              <button
                onClick={() => setRaiseFraction("allIn")}
                className="px-3 py-2 rounded-xl text-xs font-bold border border-yellow-400/40 bg-yellow-400/10 text-yellow-300 hover:bg-yellow-400/25 hover:border-yellow-400/60 active:scale-95 transition-all shadow-[0_0_10px_rgba(255,215,0,0.15)]"
              >
                <span className="inline-flex items-center gap-1.5"><IconFlame size={14} /> Tapis</span>
              </button>
            </div>

            {/* Confirm / Cancel */}
            <div className="flex gap-3">
              <button
                onClick={cancelRaise}
                className="flex-1 px-4 py-3 rounded-xl font-bold text-sm border border-red-500/40 bg-red-900/20 text-red-300 hover:bg-red-900/40 hover:border-red-500/60 active:scale-95 transition-all"
              >
                Cancel
              </button>
              <button
                onClick={confirmRaise}
                disabled={raiseInputValue <= 0}
                className={`flex-1 px-4 py-3 rounded-xl font-bold text-sm transition-all active:scale-95 ${
                  raiseInputValue > 0
                    ? "bg-gradient-to-r from-[#ff00cc] to-[#00e5ff] text-black hover:from-[#ff00cc]/90 hover:to-[#00e5ff]/90 shadow-[0_0_20px_rgba(255,0,204,0.5)]"
                    : "bg-gray-700 text-gray-400 cursor-not-allowed"
                }`}
              >
                Raise ${raiseInputValue > 0 ? raiseInputValue : ""}
              </button>
            </div>
          </motion.div>
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
      {/* DESKTOP BOTTOM-CENTER DOCK */}
      {/* ───────────────────────────── */}
      <div className="hidden lg:flex fixed left-1/2 -translate-x-1/2 bottom-8 z-50">
        <div className="flex items-center justify-center gap-2.5 rounded-2xl border border-[#ff00cc]/25 bg-[#050510]/90 px-3 py-2.5 shadow-[0_10px_40px_rgba(0,0,0,0.6),0_0_25px_rgba(255,0,204,0.2)] backdrop-blur-xl">

          {/* Fold — smaller, quieter (destructive but secondary) */}
          <button
            onClick={() => performAction("fold")}
            aria-label="Fold"
            data-action="fold"
            className="px-4 py-2.5 rounded-xl font-bold text-xs
            bg-red-900/60 border border-red-500/40
            text-red-200/90
            hover:bg-red-900/80 hover:border-red-400/60
            hover:shadow-[0_0_18px_rgba(255,0,0,0.35)]
            transition-colors active:scale-95
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300/60"
          >
            <span className="inline-flex items-center gap-1.5"><IconX size={14} /> Fold</span>
          </button>

          {/* Check / Call — mid-tier */}
          {canCheck ? (
            <button
              onClick={() => performAction("check")}
              aria-label="Check"
              data-action="check"
              className="px-5 py-3 rounded-xl font-bold text-sm
              bg-gradient-to-r from-[#00e5ff]/30 to-cyan-400/20
              border border-[#00e5ff]/50
              text-[#00e5ff]
              hover:shadow-[0_0_25px_rgba(0,229,255,0.45)]
              transition-colors active:scale-95
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60"
            >
              <span className="inline-flex items-center gap-1.5"><IconCheck size={14} /> Check</span>
            </button>
          ) : (
            <button
              onClick={() => performAction("call")}
              aria-label={`Call ${toCall}`}
              data-action="call"
              className="px-5 py-3 rounded-xl font-bold text-sm
              bg-gradient-to-r from-[#00e5ff]/30 to-cyan-400/20
              border border-[#00e5ff]/50
              text-[#00e5ff]
              hover:shadow-[0_0_25px_rgba(0,229,255,0.45)]
              transition-colors active:scale-95
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60"
            >
              <span className="inline-flex items-center gap-1.5"><IconPhone size={14} /> Call {toCall}</span>
            </button>
          )}

          {/* Quick Bet — when no bet to call, post-flop */}
          {canUseBetShortcut && (
            <button
              onClick={() => performAction("bet20")}
              aria-label="Bet 20 tokens"
              data-action="bet20"
              className="px-5 py-3 rounded-xl font-bold text-sm
              bg-gradient-to-r from-yellow-500/30 to-amber-400/15
              border border-yellow-400/55
              text-yellow-200
              hover:shadow-[0_0_25px_rgba(255,215,0,0.5)]
              transition-colors active:scale-95
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow-300/60"
            >
              <span className="inline-flex items-center gap-1.5"><IconCoins size={14} /> Bet $20</span>
            </button>
          )}

          {/* Raise — PRIMARY action, brightest, rightmost */}
          <button
            onClick={() => {
              const minRaise = Math.max(20, highestBetInRound * 2);
              setRaiseInputValue(Math.max(raiseAmount, minRaise));
              setShowRaiseInput(true);
            }}
            aria-label="Raise"
            data-action="raise"
            className="px-6 py-3.5 rounded-xl font-black text-base
            bg-gradient-to-r from-[#ff00cc] via-fuchsia-500 to-pink-500
            border-2 border-[#ff00cc]/70
            text-black
            shadow-[0_0_28px_rgba(255,0,204,0.55),inset_0_0_8px_rgba(255,255,255,0.2)]
            hover:shadow-[0_0_38px_rgba(255,0,204,0.75)]
            transition-colors active:scale-95
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pink-300/70"
          >
            <span className="inline-flex items-center gap-1.5"><IconArrowUp size={16} /> Raise</span>
          </button>
        </div>
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
                active:scale-95 transition-colors
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
                  active:scale-95 transition-colors
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
                  active:scale-95 transition-colors
                "
              >
                Call
              </button>
            )}

            <button
              onClick={() => {
                const minRaise = Math.max(20, highestBetInRound * 2);
                setRaiseInputValue(Math.max(raiseAmount, minRaise));
                setShowRaiseInput(true);
              }}
              className="
                h-14 rounded-2xl
                bg-[#ff00cc]/20
                border border-[#ff00cc]/40
                text-[#ff00cc]
                font-bold text-sm
                active:scale-95 transition-colors
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
                  active:scale-95 transition-colors
                "
              >
                <span className="inline-flex items-center gap-1.5"><IconCoins size={14} /> Quick Bet $20</span>
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
        <div className="fixed bottom-56 left-3 right-3 z-50 pointer-events-auto lg:bottom-6 lg:left-6 lg:right-auto">
          <div className="w-full lg:w-64 bg-black/60 backdrop-blur-md border border-amber-700/40 rounded-lg shadow-[0_0_20px_rgba(251,191,36,0.12)] p-3">
            <div className="flex items-center justify-between mb-2">
              <div className="text-sm font-bold text-amber-300">Public Queue</div>
              <div className="text-xs text-white/60">
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
                    className="flex items-center justify-between bg-black/40 px-2 py-1 rounded border border-amber-700/20"
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
                className={`flex-1 text-sm px-3 py-2 rounded font-bold transition ${joiningGame ? "bg-gray-600 cursor-not-allowed" : "bg-amber-500 border-b-4 border-amber-700 text-black hover:brightness-110 shadow-[0_0_15px_rgba(251,191,36,0.35)]"}`}
              >
                Join Public
              </button>
              <button
                onClick={() => fetchWaitingPlayers()}
                className="px-3 py-2 rounded text-sm bg-black/40 border border-cyan-500/30 text-cyan-200/80 hover:bg-cyan-500/10"
              >
                Refresh
              </button>
            </div>
          </div>
        </div>
      )}
      <ReportModal
        isOpen={showReportModal && game != null && game.players.some((p: Player) => !p.isAI && p.id !== myId)}
        onClose={() => setShowReportModal(false)}
        onSubmit={async (reason, details) => {
          const humanOpp = game?.players.find((p: Player) => !p.isAI && p.id !== myId);
          const res = await fetch("/api/reports/submit", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              reportedClerkId: humanOpp?.id,
              gameType: "poker",
              gameId: game?.id ? String(game.id) : null,
              reason,
              details: details || undefined,
            }),
          });
          const data = await res.json();
          if (!data.success) throw new Error(data.error || "Failed to submit report");
        }}
        reportedPlayerName={game?.players.find((p: Player) => !p.isAI && p.id !== myId)?.name || "Opponent"}
        gameType="Poker"
      />
      <Footer />
    </div>
  );
}
