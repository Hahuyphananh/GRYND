"use client";

import { useState, useEffect, useRef, type ReactNode } from "react";
import { Card, evaluateHand } from "../../../lib/handEval";
import { computePayouts } from "../../../lib/pokerPots";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
// Shared animation presets. `dealFromShoe` slides a card in from a single
// origin (the table's card shoe) instead of popping into its own slot, and
// `withReducedMotion` swaps a variant for `staticMotion` when the viewer
// prefers reduced motion — no bespoke reduced-motion system here.
import { dealFromShoe, withReducedMotion } from "../../../../lib/animations";
import { useRouter, useSearchParams } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import EmotePicker, { EmoteBubble } from "../../../../components/game/EmotePicker";
import IconAvatar from "../../../../components/IconAvatar";
import useGameEmotes from "../../../../hooks/useGameEmotes";
import { useSocket } from "../../../../context/SocketProvider";
import useGamePresence from "../../../../hooks/useGamePresence";
import { usePokerAudio } from "../../../lib/pokerAudio";
import NavigationBar from "../../../../components/navigation-bar";
import CreatorModeLobby from "../../../../components/creator-mode/CreatorModeLobby";
import Footer from "../../../../components/Footer";
// Shared Creator Mode foundation (admin-only): mounts the viewport
// recorder + overlay and auto-starts when the real hand actually begins
// (host clicked Start Game → `game.waiting` flips false), auto-stops
// when the hand reaches its result (showdown + winner) or the user
// quits. The build/join lobby render (the `!game` branch below) and the
// report modal / footer stay OUTSIDE so nothing is recorded until
// real gameplay starts.
import CreatorModeHost from "../../../../components/creator-mode/CreatorModeHost";
import {
  CreatorView,
  CreatorModeShell,
  ShellHeader,
  ShellMain,
  ShellAside,
  useCreatorModeLayout,
} from "../../../../components/creator-mode/CreatorModeLayout";
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
  // Total chips contributed to the current pot this hand (cumulative
  // across betting rounds). Reset each hand; drives side-pot splits.
  committed: number;
  // Seat identity — resolved server-side (game-state GET).
  iconKey?: string | null;
  nameColor?: string | null;
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
  // Final awards for the just-finished hand: main-pot winner first,
  // then any side-pot winners (see computePayouts in pokerPots.ts).
  payouts?: { playerId: string; amount: number }[];
  // True when the hand ended because everyone else folded (the pot
  // winner's cards are kept hidden in the popup — they may have
  // bluffed).
  wonByFold?: boolean;
  replayVisible: boolean;
  dealerIndex: number;
  inviteCode?: string;
  waiting?: boolean;
  lastAggressorIndex?: number;
  hostClerkId?: string;
  actionLog?: { text: string; at: number }[];
  // Private games are virtual chips (play money) — no real tokens move.
  isPrivate?: boolean;
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

// Creator-mode table stage: poker's table + seats are laid out in a
// 900×600-style wrapper (seats %-positioned, ellipse centered inside).
// In creator frames we size that wrapper from the frame dimensions so the
// felt fills the recording; seats stay glued to the ellipse in any ratio
// (9:16 / 16:9 / 1:1). Reads the shell's layout context, so it must be
// rendered inside <CreatorModeShell />.
function PokerCreatorTableStage({ children }: { children: ReactNode }) {
  const { width, height, isPortrait } = useCreatorModeLayout();
  // Reserve room for the compact header (and bottom strip in portrait).
  const availW = width - (isPortrait ? 24 : 72);
  const availH = height - (isPortrait ? 170 : 120);
  const stageW = Math.min(availW, availH * 1.5);
  const stageH = stageW / 1.5;
  return (
    <div
      className="relative flex items-center justify-center overflow-visible"
      style={{ width: Math.max(280, stageW), height: Math.max(190, stageH) }}
    >
      {children}
    </div>
  );
}

export default function PokerPage() {
  const { user } = useUser();
  const { socket } = useSocket();
  const clerkId = user?.id;
  const myId = clerkId;
  const router = useRouter();
  const searchParams = useSearchParams();
  const isSpectator = searchParams.get("spectator") === "1";
  // prefers-reduced-motion: hole cards then appear in place with no travel.
  const shouldReduce = useReducedMotion();

  const spectatorGameId = searchParams.get("gameId");
  const [name, setName] = useState("");
  const [game, setGame] = useState<Game | null>(null);
  // Emotes — dedicated per-table room; the bubble lands on the sender's seat.
  const { incomingEmote, incomingSenderId, myEmote, sendEmote } = useGameEmotes({
    socket,
    roomId: game?.id ? `poker:emote:${game.id}` : null,
    eventName: "poker:emote",
    selfId: myId,
  });
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
  const [allInParticles, setAllInParticles] = useState<
    { id: string; seatIdx: number; delay: number; hue: number }[]
  >([]);
  const [showReportModal, setShowReportModal] = useState(false);
  // Replay / cash-out controls stay out of the way until the reveal has had
  // its beat. Armed only while the hand is in showdown — polling the same
  // showdown state never restarts the timer — and cleared as soon as the
  // stage moves on (replay → pre-flop). Reduced motion skips the wait: there
  // is no reveal animation left to sequence the controls against.
  const [resultReady, setResultReady] = useState(false);
  useEffect(() => {
    if (game?.stage !== "showdown") {
      setResultReady(false);
      return;
    }
    const t = setTimeout(() => setResultReady(true), shouldReduce ? 0 : 750);
    return () => clearTimeout(t);
  }, [game?.stage, shouldReduce]);
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

  // How much the 900x680 table area (felt + seat ring) has to shrink to fit
  // this window with its padding. The felt itself is sized in CSS (85vmin),
  // so this factor is only meaningful where a fixed pixel size would ignore
  // the viewport — the seat ring, which is a fixed 120px box.
  const TABLE_W = 900;
  const TABLE_H = 680;
  const paddingX = 32;
  const paddingY = 140;
  const scaleX = (windowSize.w - paddingX) / TABLE_W;
  const scaleY = (windowSize.h - paddingY) / TABLE_H;
  const tableScale = Math.min(scaleX, scaleY, 1.0);

  // ── Seat scale ───────────────────────────────────────────────────
  // The ring spaces neighbouring seats 30% of the felt apart (positions
  // 20/50/80%) while every seat box is a fixed 120px wide, so once the felt
  // drops below ~440px the boxes start stacking on each other — which is a
  // phone in landscape, the only shape where the table is shown on mobile.
  // `tableScale` is exactly "this window is smaller than the ring needs": it
  // sits at 1.0 on every desktop window, so scaling the ring by it is a
  // no-op there and only shrinks seats where they would otherwise collide.
  // The whole seat scales as one unit (box, name, stack and hole cards
  // together) so the ring keeps its proportions instead of the cards
  // bursting out of a smaller box. Floored so the seat text stays legible.
  const SEAT_CLEAR_RATIO = TABLE_W / 440;
  const SEAT_MIN_SCALE = 0.72;
  const seatScale = Math.min(
    1,
    Math.max(SEAT_MIN_SCALE, tableScale * SEAT_CLEAR_RATIO),
  );

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

    // Vs-AI tables are untimed: no countdown, no urgent beeps, and no
    // auto-fold when the clock runs out. The player can think as long as
    // they like (the AI acts on demand after their action).
    const tableHasAi = game.players.some((p) => p.isAI);
    if (tableHasAi) return;

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

  // ── Hole-card deal ─────────────────────────────────────────────────
  // Every hole card is dealt in from ONE shared shoe position on the felt,
  // so the table reads as a single deal instead of six independent
  // pop-ins. The offset is a direction cue (unit vector × a fixed distance)
  // rather than a literal path, so it needs no measurement of the table
  // box — which also keeps it correct in creator-mode frames.
  const CARD_SHOE = { left: 40, top: 24 };
  const DEAL_DISTANCE = 88; // px a hole card travels
  // A percentage step in `left` is a bigger pixel step than the same step
  // in `top` on a table roughly twice as wide as it is tall; squashing the
  // `top` delta keeps the direction pointing at the shoe, not past it.
  const DEAL_ASPECT_SQUASH = 0.5;

  function shoeOffsetFor(seatLeft: number, seatTop: number) {
    const dx = seatLeft - CARD_SHOE.left;
    const dy = (seatTop - CARD_SHOE.top) * DEAL_ASPECT_SQUASH;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    return {
      // Start displaced *towards* the shoe; the variant animates it to 0.
      x: -ux * DEAL_DISTANCE,
      y: -uy * DEAL_DISTANCE,
      rotate: -ux * 6, // a few degrees of entry tilt, never 3D
    };
  }

  // Seats that actually hold hole cards — i.e. a hand is in progress. Used
  // for the deal order only; gameplay dealing is untouched.
  const dealtSeatOrder = seatPositions
    .map((_, seatIdx) => seatIdx)
    .filter((seatIdx) =>
      (game?.players ?? []).some(
        (p) =>
          p.seatIndex === seatIdx &&
          (p.hand || []).some((c) => c && c.suit && c.value),
      ),
    );
  const dealtCardTotal = dealtSeatOrder.length * 2;
  // Real dealing order: one card to each occupied seat in turn, then the
  // second round. Empty seats are skipped, so a two-handed table deals
  // 0·1 then 2·3 instead of leaving gaps in the stagger.
  const dealDelayIndex = (seatIdx: number, cardIdx: number) => {
    const order = dealtSeatOrder.indexOf(seatIdx);
    return order < 0 ? 0 : order + cardIdx * dealtSeatOrder.length;
  };

  // ── Community-card reveal ──────────────────────────────────────────
  // Positions 0–2 are the flop (one coordinated three-card reveal), 3 is
  // the turn and 4 the river (each a single newly introduced card). The
  // reveal delay is scoped to the STREET, not the absolute index: the old
  // `i * 0.12` made the turn wait 360ms and the river 480ms before their
  // single card even started moving, which read as the table stalling
  // between streets. The whole event stays quick — flop 0/120/240ms, the
  // turn and river an immediate ~300ms reveal.
  // Used for the card key too, so each card's identity is its street plus
  // its suit/value — the flop's keys never change across a state poll, so
  // only genuinely new cards animate in.
  const communityStreetOf = (i: number) =>
    i < 3 ? "flop" : i === 3 ? "turn" : "river";
  const communityRevealDelay = (i: number) => (i < 3 ? i * 0.12 : 0);

  // Showdown reveal order — one seat after another in ring order, so four
  // opponents flip in sequence instead of all at once. Seats with no cards
  // are not in `dealtSeatOrder`, so the stagger never waits on an empty seat.
  const revealDelayFor = (seatIdx: number) =>
    Math.max(0, dealtSeatOrder.indexOf(seatIdx)) * 0.06;

  // ── Dealer / blinds markers ────────────────────────────────────────
  // Resolved through the SAME indices the engine posts blinds from (the
  // `players` array order), never re-derived from seat numbers, so the
  // markers can never disagree with the chips that were actually posted.
  const tablePlayerCount = game?.players?.length ?? 0;
  const seatIndexAtPlayerIndex = (i: number) => {
    if (tablePlayerCount === 0) return null;
    const idx = ((i % tablePlayerCount) + tablePlayerCount) % tablePlayerCount;
    return game?.players[idx]?.seatIndex ?? null;
  };
  const dealerSeatIdx = seatIndexAtPlayerIndex(game?.dealerIndex ?? 0);
  const smallBlindSeatIdx = seatIndexAtPlayerIndex(
    (game?.dealerIndex ?? 0) + 1,
  );
  const bigBlindSeatIdx = seatIndexAtPlayerIndex((game?.dealerIndex ?? 0) + 2);
  // The button sits still for the whole hand; the blind tags only mean
  // something while a hand is live, so they appear with the deal.
  const showBlindMarkers = Boolean(game) && !game?.waiting;

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
        isPrivate,
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
      committed: 0,
    }));

    // Setup blinds
    const sbIndex = (game.dealerIndex + 1) % players.length;
    const bbIndex = (game.dealerIndex + 2) % players.length;
    players[sbIndex].stack -= game.smallBlind;
    players[sbIndex].currentBet = game.smallBlind;
    players[sbIndex].committed = game.smallBlind;
    players[sbIndex].lastAction = "Small Blind";

    players[bbIndex].stack -= game.bigBlind;
    players[bbIndex].currentBet = game.bigBlind;
    players[bbIndex].committed = game.bigBlind;
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

    // Play sounds for new hand. The card flicks now land *with* the visual
    // deal: the hole cards animate in from the shoe in the same commit as
    // the `setGame` below, so one flick covers the first round and one
    // covers the second, instead of both arriving after the deal is done.
    audioRef.current.playNewHand();
    audioRef.current.playShuffle();
    setTimeout(() => audioRef.current.playCardDeal(), 80);
    setTimeout(() => audioRef.current.playCardDeal(), 260);

    const nextGame = {
      ...game,
      players,
      deck: newDeck,
      pot: game.smallBlind + game.bigBlind,
      currentTurn: firstActorIndex,
      roundStarter: firstActorIndex,
      waiting: false,
      lastAggressorIndex: firstActorIndex,
      payouts: [],
      wonByFold: false,
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
        isPrivate: Boolean(serverGame?.isPrivate),
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
    // Five chip particles flying from the seat to the pot (was eight, which
    // read as confetti rather than a bet). The hue is picked ONCE here — it
    // used to be `Math.random()` inside the particle's style, so every
    // re-render (1.5s poll, 1s timer) repainted the chips mid-flight.
    const chips = Array.from({ length: 5 }, (_, i) => ({
      id: `allin-${seatIdx}-${Date.now()}-${i}`,
      seatIdx,
      delay: i * 28,
      hue: Math.round(Math.random() * 360),
    }));
    setAllInParticles(chips);
    // Matches the longest particle (28×4 + 500ms) so nothing is cut short
    // and the effect never outlives its ≤700ms budget.
    setTimeout(() => {
      setAllInFlash(false);
      setAllInParticles([]);
    }, 650);
  }

  function checkForWinner(players: Player[], pot: number) {
    const activePlayers = players.filter((p) => !p.hasFolded);
    if (activePlayers.length === 1) {
      const winner = activePlayers[0];
      // Last player standing takes the whole pot (standard rule).
      const payouts = computePayouts(players, game?.community ?? []);
      const winAmount = payouts[0]?.amount ?? pot;
      const updatedPlayers = players.map((p) =>
        p.id === winner.id ? { ...p, stack: p.stack + winAmount } : p,
      );

      if (winner.id === myId) {
        audioRef.current.playWin();
        setTableStack((prev) => prev + winAmount);
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
            payouts,
            wonByFold: true,
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
        current.committed += actual;
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
      current.committed += actual;
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
      current.committed += actual;
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
        current.committed += actual;
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
      // One flick per flop card, landing with its reveal — the same
      // 0/120/240ms stagger the cards themselves use
      // (`communityRevealDelay`).
      audioRef.current.playCardDeal();
      setTimeout(() => audioRef.current.playCardDeal(), 120);
      setTimeout(() => audioRef.current.playCardDeal(), 240);
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
    // Main pot + side pots, split from each player's committed chips.
    // payouts[0] is the main-pot winner (best hand overall); the rest
    // are side-pot winners. The sum of all awards always equals the
    // full pot.
    const payouts = computePayouts(game.players, game.community);
    const mainWinnerId = payouts[0]?.playerId ?? null;
    const mainWinner = game.players.find((p) => p.id === mainWinnerId);
    const updated = game.players.map((p) => {
      const win = payouts.find((w) => w.playerId === p.id);
      return win ? { ...p, stack: p.stack + win.amount } : p;
    });

    // My total winnings across the main pot + any side pots I took.
    const myWinnings = payouts
      .filter((w) => w.playerId === myId)
      .reduce((s, w) => s + w.amount, 0);

    if (myWinnings > 0) {
      audioRef.current.playWin();
      setTableStack((prev) => prev + myWinnings);
      fetchUserTokens();
      // Level-4 celebration — and only when motion is welcome: confetti is a
      // screen-wide effect, so `prefers-reduced-motion` drops it entirely.
      // The banner, the seat beat and the win stinger still report the win.
      if (!shouldReduce) {
        confetti({ particleCount: 120, spread: 80, origin: { y: 0.5 }, colors: ["#ffd700", "#ff00cc", "#00e5ff"] });
        setTimeout(() => confetti({ particleCount: 60, spread: 120, origin: { y: 0.4 }, colors: ["#ffd700", "#ffffff"] }), 300);
      }
    } else {
      audioRef.current.playLose();
    }

    const nextGame: Game = appendActionLog(
      {
        ...game,
        players: updated,
        winnerId: mainWinnerId ?? undefined,
        payouts,
        wonByFold: false,
        pot: 0,
        stage: "showdown",
        replayVisible: true,
      },
      mainWinner ? `${mainWinner.name} wins at showdown` : "Showdown complete",
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
      committed: 0,
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
      payouts: [],
      wonByFold: false,
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

    // Reset buy-in amount to a sensible default (private games are virtual
    // so they don't depend on the wallet balance)
    const defaultBuyIn = isPrivateGame ? 100 : Math.min(100, tokenBalance || 100);
    setBuyInAmount(defaultBuyIn);
    setShowBuyInPopup(true);
  }

  async function confirmBuyIn() {
    if (selectedSeat === null || !game || !clerkId) return;
    if (buyInAmount < 10) return alert("Buy-in must be at least 10 tokens");
    // Public games spend real tokens — the wallet caps the buy-in.
    if (!isPrivateGame && buyInAmount > tokenBalance) {
      return alert("Insufficient balance for this buy-in");
    }

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
  // Private games are virtual chips — the buy-in is play money the player
  // chooses freely, so the wallet balance never caps or checks it.
  const isPrivateGame = !!game?.isPrivate;

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
              {...withReducedMotion(shouldReduce, {
                // Same street-scoped timing as the felt board (flop staggered,
                // turn/river immediate) and the same 0.3s game-action budget,
                // so this POV overlay cannot drift from the table it mirrors.
                initial: { rotateY: 90, opacity: 0, y: -20 },
                animate: { rotateY: 0, opacity: 1, y: 0 },
                transition: {
                  duration: 0.3,
                  delay: communityRevealDelay(i),
                  ease: "easeOut" as const,
                },
              })}
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
              <p className="flex items-center gap-1.5 font-semibold">
                {p.isAI ? null : (
                  <IconAvatar iconKey={p.iconKey} name={p.name} size="h-4 w-4" />
                )}
                <span style={p.nameColor ? { color: p.nameColor } : undefined}>
                  {p.name}
                </span>
              </p>
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
        {/* Creator Mode toggle (admin-only — renders nothing for other users). */}
        <div className="mt-3 flex justify-center">
          <CreatorModeLobby />
        </div>

        <div className="relative z-10 mx-auto max-w-5xl">
          <motion.div
            {...withReducedMotion(shouldReduce, {
              // Lobby panel entrances go through the same shared helper as the
              // table: with reduced motion the panel (and everything inside
              // it) is simply present, with no slide.
              initial: { opacity: 0, y: -12 },
              animate: { opacity: 1, y: 0 },
              transition: { duration: 0.4 },
            })}
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
            {...withReducedMotion(shouldReduce, {
              initial: { opacity: 0, y: 15 },
              animate: { opacity: 1, y: 0 },
              transition: { duration: 0.45, delay: 0.05 },
            })}
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
            {...withReducedMotion(shouldReduce, {
              initial: { opacity: 0, y: 15 },
              animate: { opacity: 1, y: 0 },
              transition: { duration: 0.45, delay: 0.1 },
            })}
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


  // ── Creator-mode node extraction (poker) ──────────────────────────
  // Real mobile portrait browsers only — never inside a creator frame
  // (the creator chose the frame's aspect ratio, so the table shows).
  const rotateOverlayNode = (
    <>
      {isPortrait && (
        <div className="fixed inset-0 z-[200] flex flex-col items-center justify-center bg-black/90 backdrop-blur-md">
          <div className="mb-6 animate-spin" style={{ animationDuration: "4s" }}><IconDeviceMobileRotated size={60} /></div>
          <p className="text-2xl font-bold text-[#00e5ff] drop-shadow-[0_0_12px_#00e5ff] mb-2">
            Tournez votre téléphone
          </p>
          <p className="text-sm text-[#b0b0ff]/70">Mode paysage requis pour le Texas Hold'em</p>
        </div>
      )}
    </>
  );

  const scanlinesNode = (
    <div className="fixed inset-0 pointer-events-none z-0 opacity-[0.03]"
      style={{
        backgroundImage: "repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,229,255,0.15) 2px, rgba(0,229,255,0.15) 4px)",
      }}
    />
  );

  // The three top-bar items (Return / title / sound) — wrapped differently
  // per view: absolute overlay on the normal page, compact header row in
  // creator frames.
  const topBarInnerNode = (
    <>
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
    </>
  );

  // The table-controls row (report / timer / invite / start / replay / retire).
  const controlsInnerNode = (
    <>
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

      {game?.replayVisible && resultReady && (
        <button
          onClick={replayHand}
          className="bg-gradient-to-r from-[#ff00cc]/60 to-[#ff00cc]/60 border border-[#ff00cc]/50 text-white px-5 py-2 rounded-lg font-bold transition hover:from-[#ff00cc] hover:to-[#ff00cc] shadow-[0_0_15px_rgba(255,0,204,0.4)]"
        >
          <span className="inline-flex items-center gap-1.5"><IconRefresh size={16} /> Replay Hand</span>
        </button>
      )}

      {((game?.stage === "showdown" && resultReady) || game?.waiting) &&
        me &&
        me.stack > 0 && (
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
    </>
  );

  const actionLogNode = (
    <>
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
    </>
  );

  // The full scalable table (felt + overlays + seats + chips + modals).
  // `fill` adapts the wrapper/felt to the creator frame (the felt fills the
  // stage sized by PokerCreatorTableStage) instead of the window-based
  // 75vh / 85vmin sizing used on the normal page.
  const tableBlockNode = (fill: boolean) => (
    <>
   {/* ── Scalable table wrapper ── */}
<div className={`relative flex items-center justify-center overflow-visible ${fill ? "w-full h-full" : "w-full h-[75vh]"}`}>
        {/* The cyberpunk poker table */}
       <div
  className={`relative rounded-full flex items-center justify-center
bg-gradient-to-br from-[#0a0015] via-[#0d0020] to-[#05000d]
border-[6px] border-[#ff00cc]/60
shadow-[0_0_80px_rgba(255,0,204,0.4),0_0_120px_rgba(0,229,255,0.2),inset_0_0_60px_rgba(255,0,204,0.1)] ${
    fill ? "w-full h-full max-w-none max-h-none" : "w-[85vmin] h-[55vmin] max-w-[1000px] max-h-[650px]"
  }`}
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
            {/* Re-keyed on the amount, so every time chips land the number
                gives one short, non-looping bump — the pot end of the
                "chips are moving in" story. Polling the same value never
                replays it. */}
            <motion.div
              key={`pot-${game.pot}`}
              {...withReducedMotion(shouldReduce, {
                initial: { scale: 1.14, opacity: 0.75 },
                animate: { scale: 1, opacity: 1 },
                transition: { duration: 0.2, ease: "easeOut" as const },
              })}
              className="text-3xl font-black text-transparent bg-clip-text bg-gradient-to-r from-[#ff00cc] to-[#00e5ff] drop-shadow-[0_0_12px_rgba(255,0,204,0.7)]"
            >
              ${game.pot}
            </motion.div>
          </div>
        </div>

        {/* ── All-in flash overlay — skipped entirely under reduced motion
            (the seat's All-in badge, the chip jump and the audio still
            report the action). Trimmed to 450ms / lower peak so it accents
            the table instead of washing it out. ── */}
        <AnimatePresence>
          {allInFlash && !shouldReduce && (
            <motion.div
              key="allin-flash"
              initial={{ opacity: 0 }}
              animate={{ opacity: [0, 0.45, 0.22, 0] }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.45, times: [0, 0.15, 0.4, 0.8] }}
              className="absolute inset-0 z-[60] pointer-events-none"
              style={{
                background: "radial-gradient(circle at 50% 50%, rgba(255,215,0,0.5), rgba(255,100,0,0.3) 40%, transparent 70%)",
              }}
            />
          )}
        </AnimatePresence>

        {/* ── Flying all-in chip particles (no particles under reduced
            motion) ── */}
        <AnimatePresence>
          {(shouldReduce ? [] : allInParticles).map((particle) => {
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
  scale: [0.5, 1.1, 0.3],
  opacity: [1, 1, 0],
  rotate: [0, 360],
}}
                exit={{ opacity: 0, scale: 0 }}
                transition={{
                  duration: 0.5,
                  delay: particle.delay / 1000,
                  ease: "easeIn",
                }}
                className="absolute z-[65] w-4 h-4 rounded-full pointer-events-none"
                style={{
                  transform: "translate(-50%, -50%)",
                  background: `linear-gradient(135deg, hsl(${particle.hue}, 100%, 50%), #ffd700)`,
                  boxShadow: "0 0 8px rgba(255,215,0,0.6)",
                }}
              />
            );
          })}
        </AnimatePresence>

        {/* ── Winner popup: who won, the pot they won, any side-pot
            winners, and the pot winner's cards (hidden when the pot
            was won by everyone folding — they may have bluffed). ── */}
        <AnimatePresence>
          {game?.winnerId && game?.stage === "showdown" && (() => {
            const winner = game.players.find((p) => p.id === game.winnerId);
            const payouts = Array.isArray(game.payouts)
              ? game.payouts
              : [];
            const wonByFold = Boolean(game.wonByFold);
            const winnerTotal = payouts
              .filter((w) => w.playerId === game.winnerId)
              .reduce((s, w) => s + w.amount, 0);
            // Other players who took chips (side pots) besides the
            // main-pot winner.
            const others = payouts.filter(
              (w) => w.playerId !== game.winnerId && w.amount > 0,
            );
            const winnerCards = (winner?.hand ?? []).filter(
              (c): c is Card => !!c && !!c.suit && !!c.value,
            );
            const handLabel =
              !wonByFold && winner && winnerCards.length > 0
                ? evaluateHand(winnerCards, game.community)
                : "";
            return (
              <motion.div
                // The result waits ~300ms so the seat chips are seen
                // travelling into the pot first: the hand resolves in two
                // readable beats (chips collected → result) instead of the
                // popup covering the table the instant the pot empties.
                // Exit stays immediate so replay never feels laggy. Under
                // reduced motion the whole thing is static (no wait, no
                // scale) since there is no chip travel to sequence against.
                {...withReducedMotion(shouldReduce, {
                  // `x`/`y` repeat the centring the Tailwind classes do, so
                  // the panel sits in exactly the same place whether Motion
                  // is writing its transform (spring) or not (reduced motion).
                  initial: { scale: 0, opacity: 0, x: "-50%", y: "-50%" },
                  animate: {
                    scale: 1,
                    opacity: 1,
                    x: "-50%",
                    y: "-50%",
                    transition: {
                      delay: 0.3,
                      type: "spring",
                      stiffness: 220,
                      damping: 18,
                    },
                  },
                  exit: {
                    scale: 0,
                    opacity: 0,
                    x: "-50%",
                    y: "-50%",
                    transition: { duration: 0.2 },
                  },
                })}
                className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-[60] w-[300px] sm:w-[340px]"
              >
                <div className="rounded-2xl border-2 border-yellow-400/60 bg-[#0a0a1a]/95 p-4 text-center shadow-[0_0_40px_rgba(255,215,0,0.35)] backdrop-blur-xl">
                  <div className="flex items-center justify-center gap-2 text-yellow-300 drop-shadow-[0_0_12px_rgba(255,215,0,0.7)]">
                    <IconCrown size={18} />
                    <span className="text-xs font-black uppercase tracking-[0.3em]">Winner</span>
                  </div>
                  <div className="mt-1.5 flex items-center justify-center gap-2">
                    {!winner?.isAI && (
                      <IconAvatar
                        iconKey={winner?.iconKey}
                        name={winner?.name || "?"}
                        size="h-6 w-6"
                      />
                    )}
                    <span
                      className="max-w-[220px] truncate text-lg font-black text-white"
                      style={
                        winner?.nameColor
                          ? { color: winner.nameColor }
                          : undefined
                      }
                    >
                      {winner?.name || "Unknown"}
                    </span>
                  </div>
                  {payouts.length > 0 && (
                    // Second beat of the banner: the payout counts in just
                    // after the panel lands (~0.42s from the showdown).
                    <motion.div
                      {...withReducedMotion(shouldReduce, {
                        initial: { opacity: 0, y: 6, scale: 0.9 },
                        animate: {
                          opacity: 1,
                          y: 0,
                          scale: 1,
                          transition: {
                            delay: 0.42,
                            duration: 0.24,
                            ease: "easeOut" as const,
                          },
                        },
                      })}
                      className="mt-1 text-sm font-bold text-yellow-200"
                    >
                      +{winnerTotal.toLocaleString()}{" "}
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-yellow-200/70">
                        won
                      </span>
                    </motion.div>
                  )}

                  {/* Side pots — other players who won chips */}
                  {others.length > 0 && (
                    <div className="mt-3 rounded-lg border border-white/10 bg-white/5 p-2">
                      <div className="text-[10px] font-black uppercase tracking-[0.25em] text-white/40">
                        Side pots
                      </div>
                      <div className="mt-1 space-y-1">
                        {others.map((w) => {
                          const op = game.players.find(
                            (p) => p.id === w.playerId,
                          );
                          return (
                            <div
                              key={w.playerId}
                              className="flex items-center justify-between gap-2 text-xs"
                            >
                              <span className="flex min-w-0 items-center gap-1.5 truncate text-white/85">
                                {!op?.isAI && (
                                  <IconAvatar
                                    iconKey={op?.iconKey}
                                    name={op?.name || "?"}
                                    size="h-4 w-4"
                                  />
                                )}
                                <span
                                  className="truncate"
                                  style={
                                    op?.nameColor
                                      ? { color: op.nameColor }
                                      : undefined
                                  }
                                >
                                  {op?.name || "Player"}
                                </span>
                              </span>
                              <span className="shrink-0 font-bold text-emerald-300">
                                +{w.amount.toLocaleString()}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Winner's cards — hidden when won by fold. Third beat: the
                      winning hand (cards + the evaluateHand label) fades up
                      after the payout, so the sequence reads
                      reveal → result → winning hand. */}
                  <motion.div
                    {...withReducedMotion(shouldReduce, {
                      initial: { opacity: 0, y: 6 },
                      animate: {
                        opacity: 1,
                        y: 0,
                        transition: {
                          delay: 0.54,
                          duration: 0.24,
                          ease: "easeOut" as const,
                        },
                      },
                    })}
                    className="mt-3 flex flex-col items-center gap-2"
                  >
                    {wonByFold ? (
                      <div className="text-xs font-bold text-white/50">
                        Won by fold — cards kept hidden
                      </div>
                    ) : winnerCards.length > 0 ? (
                      <>
                        <div className="flex justify-center gap-1.5">
                          {winnerCards.map((card, i) => (
                            <div
                              key={i}
                              className={`w-9 h-14 sm:w-12 sm:h-16 rounded bg-white flex items-center justify-center text-base sm:text-lg font-bold shadow ${
                                card.suit === "♥" || card.suit === "♦"
                                  ? "text-red-600"
                                  : "text-black"
                              }`}
                            >
                              {card.value}
                              <span className="text-[10px]">{card.suit}</span>
                            </div>
                          ))}
                        </div>
                        {handLabel && (
                          <div className="text-[10px] font-bold uppercase tracking-widest text-yellow-200/80">
                            {handLabel}
                          </div>
                        )}
                      </>
                    ) : null}
                  </motion.div>

                  {/* Controls land after the result beats so they never
                      compete with the winner moment. Kept mounted and faded
                      rather than removed, so the panel does not resize and
                      jump when they appear. */}
                  <button
                    onClick={replayHand}
                    tabIndex={resultReady ? 0 : -1}
                    aria-hidden={!resultReady}
                    className={`mt-3 w-full bg-gradient-to-r from-[#ff00cc]/80 to-[#00e5ff]/80 px-4 py-2 rounded-lg font-bold text-black transition hover:from-[#ff00cc] hover:to-[#00e5ff] shadow-[0_0_20px_rgba(255,0,204,0.5)] ${
                      resultReady
                        ? "opacity-100"
                        : "pointer-events-none opacity-0"
                    }`}
                  >
                    Replay Hand
                  </button>
                </div>
              </motion.div>
            );
          })()}
        </AnimatePresence>

        {/* ── Community cards on the table ── */}
        <AnimatePresence>
          {game?.community?.length > 0 && (
            <motion.div
              key="community-row"
              // One short fade for the whole board when a hand is reset,
              // instead of five cards snapping away the instant the state
              // clears. Motion keeps the previous element (cards and all)
              // mounted during the exit, so it is the old board that leaves.
              // `x` repeats the Tailwind centring so Motion's transform can
              // add the lift without dropping the -translate-x-1/2.
              initial={{ opacity: 1, x: "-50%" }}
              animate={{ opacity: 1, x: "-50%" }}
              exit={{
                opacity: 0,
                x: "-50%",
                y: shouldReduce ? 0 : -8,
                transition: { duration: 0.2, ease: "easeOut" },
              }}
              className="absolute left-1/2 top-[42%] -translate-x-1/2 flex gap-2 sm:gap-3 z-20"
            >
            {game.community.map((c: Card, i: number) => (
              <motion.div
                // Street-scoped identity: the flop's keys are identical on
                // every poll, so those cards never remount and never replay;
                // turn/river are new keys that reveal on their own.
                key={`${communityStreetOf(i)}-${c?.suit}-${c?.value}`}
                {...withReducedMotion(shouldReduce, {
                  // Shorter drop and a smaller scale-up than before, so the
                  // card reads as being placed onto the felt rather than
                  // materialising in place. The face-up flip is unchanged.
                  initial: { rotateY: 90, opacity: 0, y: -18, scale: 0.8 },
                  animate: { rotateY: 0, opacity: 1, y: 0, scale: 1 },
                  transition: {
                    duration: 0.3,
                    delay: communityRevealDelay(i),
                    ease: "easeOut" as const,
                  },
                })}
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
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── Seat positions ── */}
        <div className="absolute inset-0 pointer-events-none">
        {seatPositions.map((pos, seatIdx) => {
          const occupant = playerAtSeat(seatIdx);
          const isPlayer = occupant?.id === myId;
          // Hole cards for this seat — face-down for opponents until the
          // showdown. They render only once the hand actually holds cards,
          // so the backs deal in at the start of a hand rather than sitting
          // on the felt through the whole waiting room.
          const handCards = (occupant?.hand || []).filter(
            (card): card is Card => !!card && !!card.suit && !!card.value,
          );
          const atShowdown = game?.stage === "showdown";
          const isWinner =
            Boolean(game?.winnerId) && game?.winnerId === occupant?.id;
          // The showdown reveals the players who are actually contesting the
          // pot: folded hands stay face-down (they were mucked, so a folded
          // seat never becomes the loudest thing on the felt again) and a hand
          // won by everyone folding keeps the winner down too — the same call
          // the result banner makes ("cards kept hidden"), so the felt and
          // the banner agree. Your own cards are always visible to you.
          const contestingAtShowdown =
            atShowdown &&
            !occupant?.hasFolded &&
            !(Boolean(game?.wonByFold) && isWinner);
          const showFace = isPlayer || contestingAtShowdown;
          // Losers go slightly quieter at the showdown so the winner is the
          // strongest thing on the felt — one ring, no second glow.
          const dimAsLoser =
            atShowdown &&
            Boolean(game?.winnerId) &&
            !isWinner &&
            !occupant?.hasFolded;
          const dealVector = shoeOffsetFor(pos.left, pos.top);
          const seatMarker =
            seatIdx === dealerSeatIdx
              ? "D"
              : showBlindMarkers && seatIdx === smallBlindSeatIdx
                ? "SB"                  : showBlindMarkers && seatIdx === bigBlindSeatIdx
                    ? "BB"
                    : null;
          // The blind tag above already says SB/BB, so the matching
          // "Small Blind"/"Big Blind" action line would be a second indicator
          // for the same fact.
          const blindTextForMarker =
            seatMarker === "SB"
              ? "Small Blind"
              : seatMarker === "BB"
                ? "Big Blind"
                : null;

          return (
            <div
              key={seatIdx}
              className="absolute pointer-events-auto"
              style={{
  left: `${pos.left}%`,
  top: `${pos.top}%`,
  // Centring and the ring scale in a single transform. Scaling about the
  // box's own centre leaves every seat exactly on its ring position, so a
  // card can never drift off its seat. Creator frames size the felt from
  // the recording frame instead of the window, so they keep the unscaled
  // ring (see `seatScale` above).
  transform: `translate(-50%, -50%) scale(${fill ? 1 : seatScale})`,
  zIndex: 30,
}}
            >
              {occupant ? (
                <motion.div
                  onClick={() => {
                    // Only the HOST manages AIs (add / remove) — non-hosts
                    // clicking an AI seat get nothing.
                    if (occupant.isAI && game?.waiting && isHost) {
                      setSelectedAi(occupant);
                      setAiInfoOpen(true);
                    }
                  }}
                  // One-shot winner beat (~450ms): the seat swells once and
                  // settles. Keyframes on a target that only changes when the
                  // winner is decided, so a poll never replays it.
                  animate={{
                    scale: shouldReduce ? 1 : isWinner ? [1, 1.05, 1] : 1,
                  }}
                  transition={{
                    duration: 0.45,
                    ease: "easeOut",
                    times: [0, 0.45, 1],
                  }}
                  // `transition-[opacity,filter]` lets a fold drain the
                  // seat (and the cards inside it) over ~200ms instead of
                  // snapping to grey. Under reduced motion globals.css
                  // shortens it to ~0, so the state still changes visibly.
                  className={`flex flex-col items-center gap-1 w-[120px] p-1.5 rounded-xl text-[10px] font-semibold cursor-pointer backdrop-blur-sm transition-[opacity,filter] duration-200 ease-out
      ${isPlayer
                      ? "bg-gradient-to-b from-[#00e5ff]/30 to-[#00e5ff]/10 border-2 border-[#00e5ff]/70 text-[#00e5ff] shadow-[0_0_20px_rgba(0,229,255,0.4)]"
                      : "bg-gradient-to-b from-[#ff00cc]/25 to-[#ff00cc]/8 border-2 border-[#ff00cc]/50 text-[#ffb0ff] shadow-[0_0_18px_rgba(255,0,204,0.3)]"
                    }
      ${occupant.hasFolded ? "opacity-40 grayscale" : ""}
      ${dimAsLoser ? "opacity-60" : ""}
      ${
        isWinner
          ? "ring-2 ring-[#ff00cc] ring-offset-1 ring-offset-transparent shadow-[0_0_25px_rgba(255,0,204,0.7)]"
          : ""
      }
    `}
                >
                  <div className="flex justify-between w-full px-1 items-center gap-1">
                    <span className="relative flex items-center gap-1 truncate text-[#ffffff]/90">
                      {occupant.isAI ? null : (
                        <IconAvatar iconKey={occupant.iconKey} name={occupant.name} size="h-4 w-4" />
                      )}
                      <span className="truncate" style={occupant.nameColor ? { color: occupant.nameColor } : undefined}>
                        {occupant.name}
                      </span>
                      {occupant.isAI && <> <span title={`AI Difficulty: ${(occupant.difficulty || aiDifficulty).charAt(0).toUpperCase() + (occupant.difficulty || aiDifficulty).slice(1)}`}>{(occupant.difficulty || aiDifficulty) === "easy" ? <span className="inline-block h-2 w-2 rounded-full bg-green-400" /> : (occupant.difficulty || aiDifficulty) === "medium" ? <span className="inline-block h-2 w-2 rounded-full bg-yellow-400" /> : <span className="inline-block h-2 w-2 rounded-full bg-red-500" />}</span></>}
                      {isPlayer ? (
                        <EmoteBubble emote={myEmote} side="mine" />
                      ) : occupant.id === incomingSenderId ? (
                        <EmoteBubble emote={incomingEmote} />
                      ) : null}
                    </span>
                    {/* Stack pops once when this seat is paid out — the
                        payout number reads as the result of the showdown. */}
                    <motion.span
                      className="text-xs text-[#00e5ff] drop-shadow-[0_0_4px_#00e5ff]"
                      animate={{
                        scale: shouldReduce ? 1 : isWinner ? [1, 1.3, 1] : 1,
                      }}
                      transition={{
                        duration: 0.45,
                        ease: "easeOut",
                        times: [0, 0.4, 1],
                      }}
                    >
                      ${occupant.stack}
                    </motion.span>
                  </div>

                  {/* Cards display logic — each hole card is dealt in from
                      the shared shoe (`shoeOffsetFor`). The slot key is the
                      physical position at the seat, not the array index or
                      the card's value, so the deal animation runs when a
                      hand is dealt and never again — not on the 1.5s state
                      poll, and not when an opponent's backs flip face-up at
                      the showdown (that reuses the mounted card). */}
                  <div className="flex gap-1 justify-center">
                    {/* Card row clears cleanly on a reset: each card fades
                        (with a small lift) rather than blinking out of
                        existence. The exit is opacity-led, so it is kept even
                        under reduced motion — only the lift is dropped. */}
                    <AnimatePresence>
                    {handCards.map((card, cardIdx) => (
                      <motion.div
                        key={`hole-${seatIdx}-${cardIdx}`}
                        {...withReducedMotion(
                          shouldReduce,
                          dealFromShoe({
                            index: dealDelayIndex(seatIdx, cardIdx),
                            total: Math.max(dealtCardTotal, 1),
                            dx: dealVector.x,
                            dy: dealVector.y,
                            rotate: dealVector.rotate,
                          }),
                        )}
                        // Declared AFTER the spread on purpose: for reduced
                        // motion the spread carries an empty `exit`, which
                        // would otherwise win and make the cards blink out.
                        // The exit fades either way; only the lift is gated.
                        exit={{
                          opacity: 0,
                          y: shouldReduce ? 0 : -6,
                          transition: { duration: 0.18, ease: "easeOut" },
                        }}
                        // Outer box = the shoe deal (slide + fade); the inner
                        // box owns the showdown flip, so the two never fight.
                        // `perspective` is kept generous for a 24×32px card so
                        // the flip stays flat and un-exaggerated.
                        className="w-6 h-8 [transform-style:preserve-3d] [perspective:420px]"
                      >
                        {/* Card-flip reveal — the same two-layer pattern the
                            memory-grid board uses: the wrapper turns 0°→180°
                            and `backface-visibility` hides whichever face is
                            away, so an opponent's back is replaced by a real
                            flip rather than a content swap. `initial={false}`
                            means a card that is already face-up (your own, or
                            a joiner loading a live hand) never replays it,
                            and the transition is 0 under reduced motion, so
                            the face simply appears. */}
                        <motion.div
                          className="relative h-full w-full [transform-style:preserve-3d]"
                          initial={false}
                          animate={{ rotateY: showFace ? 180 : 0 }}
                          transition={
                            shouldReduce
                              ? { duration: 0 }
                              : {
                                  duration: 0.3,
                                  ease: "easeOut",
                                  delay: showFace ? revealDelayFor(seatIdx) : 0,
                                }
                          }
                        >
                          {/* Face-down back */}
                          <span className="absolute inset-0 rounded bg-gray-700 border border-gray-500 shadow [backface-visibility:hidden]" />
                          {/* Card face, pre-rotated so it lands with the flip */}
                          <span
                            className={`absolute inset-0 rounded flex items-center justify-center text-[10px] font-bold shadow [backface-visibility:hidden] [transform:rotateY(180deg)] bg-white ${
                              card.suit === "♥" || card.suit === "♦"
                                ? "text-red-600"
                                : "text-black"
                            }`}
                          >
                            {card.value}
                            {card.suit}
                          </span>
                        </motion.div>
                      </motion.div>
                    ))}
                    </AnimatePresence>
                  </div>

                  <div className="mb-1 flex items-center justify-center gap-1 text-[9px]">
                    {seatMarker && (
                      // Dealer / blind tag. Re-keyed per seat + tag, so the
                      // button landing on a new seat (or the blinds appearing
                      // when a deal starts) gets one short pop and nothing
                      // else — no rotating dealer button.
                      <motion.span
                        key={`marker-${seatIdx}-${seatMarker}`}
                        initial={{ scale: 0.6, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        transition={{
                          duration: shouldReduce ? 0 : 0.22,
                          ease: "easeOut",
                        }}
                        className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border text-[8px] font-black ${
                          seatMarker === "D"
                            ? "border-[#00e5ff]/70 bg-[#0a0a1a] text-[#00e5ff]"
                            : "border-amber-400/70 bg-[#0a0a1a] text-amber-300"
                        }`}
                      >
                        {seatMarker}
                      </motion.span>
                    )}
                    {occupant.hasFolded ? (
                      <span className="px-2 py-[2px] rounded bg-red-900/80 text-red-300 border border-red-500/30">
                        Folded
                      </span>
                    ) : occupant.stack <= 0 ? (
                      <span className="px-2 py-[2px] rounded bg-purple-900/80 text-purple-300 border border-purple-500/30">
                        All-in
                      </span>
                    ) : !game?.waiting &&
                      // Nobody is thinking once the hand is decided: showdown
                      // leaves `currentTurn` on the last player to act, so
                      // without this the magenta badge (and its glow) outlived
                      // the hand and competed with the winner emphasis.
                      game?.stage !== "showdown" &&
                      game?.players?.[game.currentTurn]?.id ===
                      occupant.id ? (
                      // This badge only mounts when the turn arrives here, so
                      // it IS the turn-change cue: a short one-shot pop on
                      // the existing indicator, no second indicator added.
                      <motion.span
                        {...withReducedMotion(shouldReduce, {
                          initial: { scale: 0.75, opacity: 0 },
                          animate: { scale: 1, opacity: 1 },
                          transition: { duration: 0.16, ease: "easeOut" as const },
                        })}
                        className="inline-block px-2 py-[2px] rounded bg-[#ff00cc]/80 text-black font-bold shadow-[0_0_15px_rgba(255,0,204,0.9)]"
                      >
                        <span className="inline-flex items-center gap-1"><IconBolt size={12} /> THINKING</span>
                      </motion.span>
                    ) : (
                      <span className="px-2 py-[2px] rounded bg-[#0a0a1a]/80 text-[#b0b0ff]/70 border border-[#00e5ff]/20">
                        Active
                      </span>
                    )}
                  </div>

                  {/* Last action line — re-keyed on the action text, so each
                      fold / check / call / raise gets one short, non-looping
                      label beat and repeated polls never replay it. */}
                  {occupant.lastAction &&
                    occupant.lastAction !== blindTextForMarker && (
                    <motion.div
                      key={`act-${occupant.id}-${occupant.lastAction}`}
                      {...withReducedMotion(shouldReduce, {
                        initial: { opacity: 0, y: 2 },
                        animate: { opacity: 1, y: 0 },
                        transition: { duration: 0.16, ease: "easeOut" as const },
                      })}
                      className="text-[9px] text-[#b0b0ff]/70 italic truncate max-w-[100px]"
                    >
                      {occupant.lastAction}
                    </motion.div>
                  )}

                  {/* Progress bar under the player div — hidden on
                      vs-AI tables, which run untimed. */}
                  {/* Same guard as the THINKING badge: at showdown the hand is
                      over, so the turn header + timer bar must not sit under
                      the winner beat. */}
                  {isPlayer &&
                    isMyTurn &&
                    game.stage !== "showdown" &&
                    !game.players.some((p) => p.isAI) && (
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
                </motion.div>
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

        {/* Chips / CHECK displayed relative to table. Wrapped in
            AnimatePresence so a collected bet travels into the middle pot
            (its `exit`) instead of blinking out, and the amount inside is
            re-keyed per action so every check / call / raise lands with a
            quick beat on the chip itself. */}
        <AnimatePresence>
          {game?.players.map((p) => {
            if (!p || p.seatIndex == null) return null;

            // No seat chips once the hand is decided: by then every bet is
            // already in the pot, so leaving the amounts sat on the felt
            // read as stale chips next to a $0 pot. Gating here also lets
            // them make their exit *into* the pot at showdown.
            const showChips =
              p.currentBet > 0 && game?.stage !== "showdown";
            const showCheck =
              p.currentBet === 0 &&
              p.lastAction === "Check" &&
              game?.stage !== "showdown";

            if (!showChips && !showCheck) return null;

            const pos = seatPositions[p.seatIndex];
            if (!pos) return null;

            // Offset *towards* the centre so a bet reads as being pushed
            // from its seat into the pot. Both components used to be added
            // to the seat position, which pushed every chip outwards — the
            // bottom seat's own bet landed below the table, over the action
            // dock, while the top seat's sat above it. The comment said
            // "toward the center"; the signs now agree with it.
            const angleStep = (2 * Math.PI) / seatPositions.length;
            const angle = p.seatIndex * angleStep - Math.PI / 2;

            // radius in % of table size
            const radiusX = 18;
            const radiusY = 14;

            const offset = {
              x: -Math.cos(angle) * radiusX,
              y: -Math.sin(angle) * radiusY,
            };

            // Betting and raising get a stronger beat than calling or
            // checking: a bigger pop plus a one-shot gold rim. Keyframes
            // only (no pulse, no infinite glow, no screen shake).
            const aggressive = /^(Raised|Bet)/.test(p.lastAction ?? "");

            return (
              <motion.div
                key={`chip-${p.id}-${p.seatIndex}`}
                {...withReducedMotion(shouldReduce, {
                  // Three stages, one element: it appears at the seat, pushes
                  // forward along the seat's radial line onto its bet spot
                  // (~180ms), and when the betting round resolves — or the
                  // hand ends — the same chip travels the rest of the way
                  // into the middle pot (~320ms) instead of vanishing. A
                  // raised bet only re-keys the amount inside, never this
                  // chip, so an increased bet never remounts it.
                  //
                  // `left`/`top` are plain percentages (the seat's own space)
                  // so no container measurement is needed, and `x`/`y` centre
                  // the chip through Motion's own transform so the centring
                  // composes with the animated scale.
                  initial: {
                    left: `${pos.left}%`,
                    top: `${pos.top}%`,
                    x: "-50%",
                    y: "-50%",
                    scale: 0.7,
                    opacity: 0,
                    transition: { duration: 0.18, ease: "easeOut" as const },
                  },
                  animate: {
                    left: `${pos.left + offset.x}%`,
                    top: `${pos.top + offset.y}%`,
                    x: "-50%",
                    y: "-50%",
                    scale: 1,
                    opacity: 1,
                    transition: { duration: 0.18, ease: "easeOut" as const },
                  },
                  // Only real bets are collected into the pot. The lightweight
                  // CHECK pill has no chips behind it, so it just fades where
                  // it sits rather than travelling to the middle.
                  exit: showChips
                    ? {
                        left: "50%",
                        top: "50%",
                        x: "-50%",
                        y: "-50%",
                        scale: 0.55,
                        opacity: 0,
                        // easeIn: the chip is swept *into* the pot, not
                        // eased out into it.
                        transition: {
                          duration: 0.32,
                          ease: "easeIn" as const,
                        },
                      }
                    : {
                        scale: 0.6,
                        opacity: 0,
                        transition: { duration: 0.15 },
                      },
                })}
                className="absolute z-40 w-8 h-8 rounded-full flex items-center justify-center font-bold text-xs shadow-lg"
                style={{
                  // Static resting spot — also the reduced-motion position,
                  // where the chip simply appears here with no travel.
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
                <motion.div
                  key={`bet-${p.currentBet}-${p.lastAction ?? ""}`}
                  {...withReducedMotion(
                    shouldReduce,
                    aggressive
                      ? {
                          initial: { scale: 0.6, opacity: 0.4 },
                          animate: {
                            scale: [0.6, 1.14, 1],
                            opacity: 1,
                            boxShadow: [
                              "0 0 0px rgba(255,215,0,0)",
                              "0 0 16px rgba(255,215,0,0.9)",
                              "0 0 0px rgba(255,215,0,0)",
                            ],
                          },
                          transition: {
                            duration: 0.28,
                            ease: "easeOut" as const,
                          },
                        }
                      : {
                          // Level 1 — a tiny state change (the amount ticked
                          // up), so it stays inside the 80–150ms micro budget.
                          initial: { scale: 0.75, opacity: 0.5 },
                          animate: { scale: [0.75, 1.06, 1], opacity: 1 },
                          transition: {
                            duration: 0.15,
                            ease: "easeOut" as const,
                          },
                        },
                  )}
                  className="flex items-center justify-center"
                >
                  {showChips ? p.currentBet : <IconCheck size={12} className="inline" />}
                </motion.div>
              </motion.div>
            );
          })}
        </AnimatePresence>
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
            {isPrivateGame && isHost && (
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
                  aria-label="AI stack"
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
            {...withReducedMotion(shouldReduce, {
              // Gameplay-surface modal (buy-in / raise): with reduced motion it
              // appears in place instead of scaling and sliding in.
              initial: { scale: 0.9, opacity: 0, y: 20 },
              animate: { scale: 1, opacity: 1, y: 0 },
              exit: { scale: 0.9, opacity: 0, y: 20 },
              transition: { type: "spring", stiffness: 300, damping: 25 },
            })}
            className="relative z-[110] pointer-events-auto w-[360px] bg-[#12042a]/95 backdrop-blur-xl border-2 border-amber-700/60 rounded-2xl p-5 shadow-[0_0_40px_rgba(251,191,36,0.2)]"
          >
            <h2 className="text-lg font-black text-transparent bg-clip-text bg-gradient-to-r from-amber-300 to-yellow-500 mb-1 text-center">
              <span className="inline-flex items-center gap-1.5"><IconCoins size={18} /> Achat de jetons</span>
            </h2>
            <p className="text-[10px] text-white/50 text-center mb-4 uppercase tracking-widest">
              Seat {selectedSeat}. Définissez votre mise initiale
            </p>

            {/* Balance display — public games spend real tokens; private
                games are virtual chips (play money), so the wallet is not
                involved at all. */}
            <div className="mb-3 flex items-center justify-between bg-black/40 px-4 py-2 rounded-xl border border-amber-700/40">
              <span className="text-white/60 text-sm">
                {isPrivateGame ? "Virtual chips (play money)" : "Solde disponible"}
              </span>
              <span className="text-amber-300 font-black text-lg">
                {isPrivateGame ? "∞" : `${tokenBalance.toLocaleString()} jetons`}
              </span>
            </div>

            {/* Buy-in input */}
            <div className="mb-3">
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-amber-300 font-bold text-lg">$</span>
                <input
                  type="number"
                  value={buyInAmount}
                  aria-label="Buy-in amount"
                  onChange={(e) => setBuyInAmount(parseInt(e.target.value) || 0)}
                  onBlur={() => { if (!buyInAmount || buyInAmount < 10) setBuyInAmount(10); }}
                  onKeyDown={(e) => { if (e.key === "Enter") confirmBuyIn(); if (e.key === "Escape") cancelBuyIn(); }}
                  min={0}
                  max={isPrivateGame ? undefined : tokenBalance}
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
                isPrivateGame || v <= tokenBalance ? (
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

            {/* ½ Balance / All-in — balance-based shortcuts only make sense
                when real tokens are involved (public games); private games
                are virtual, so the player just types an amount. */}
            {!isPrivateGame && (
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
            )}

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
                disabled={buyInAmount < 10 || (!isPrivateGame && buyInAmount > tokenBalance)}
                className={`flex-1 px-4 py-3 rounded-xl font-bold text-sm transition-all active:scale-95 ${
                  buyInAmount >= 10 && (isPrivateGame || buyInAmount <= tokenBalance)
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
                onClick={async () => {
                  if (!game || !selectedAi) return;

                  // Persist the removal server-side (host + private only —
                  // the route re-validates), then reconcile from the DB so
                  // the seat is actually freed for everyone.
                  try {
                    const res = await fetch("/api/poker/remove-ai", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        gameCode: game.inviteCode,
                        aiId: selectedAi.id,
                      }),
                    });
                    const data = await res.json();
                    if (!res.ok || !data.success) {
                      alert(data?.error || "Failed to remove AI");
                    } else {
                      await fetchGameState(game.inviteCode!);
                    }
                  } catch (err) {
                    console.error("Remove AI error", err);
                    alert("Failed to remove AI");
                  } finally {
                    setAiInfoOpen(false);
                    setSelectedAi(null);
                  }
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
            {...withReducedMotion(shouldReduce, {
              // Gameplay-surface modal (buy-in / raise): with reduced motion it
              // appears in place instead of scaling and sliding in.
              initial: { scale: 0.9, opacity: 0, y: 20 },
              animate: { scale: 1, opacity: 1, y: 0 },
              exit: { scale: 0.9, opacity: 0, y: 20 },
              transition: { type: "spring", stiffness: 300, damping: 25 },
            })}
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
                  aria-label="Raise amount"
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
    </>
  );

  // The desktop + mobile action docks (Fold / Check-Call / Bet / Raise).
  // They are `fixed`, so inside a creator frame they pin to the FRAME
  // (the recording root is a transformed containing block), keeping the
  // game controls reachable in every orientation.
  // Creator-mode poker action dock: the same actions, but in creator mode
  // the buttons should feel punchy/large and sit closer to the table.
  // We keep the same action behavior and only change presentation/sizing in
  // the creator frame so existing mobile/desktop docking behavior stays intact.
  const isCreatorMode = false; // set by creator shell context if/when needed
  const creatorCloser = 8;    // smaller cliff gap when in creator mode
  const creatorScale = 1.0;   // optional extra scale in creator mode
  const dockGap = isCreatorMode ? 0.25 : 0.5;   // em
  const dockMargin = isCreatorMode ? 10 : 20;   // px from frame bottom
  const buttonH = isCreatorMode ? 44 : 42;       // px touch target
  const buttonTextBase = isCreatorMode ? "text-base" : "text-sm";
  const raiseH = isCreatorMode ? 48 : 44;        // primary action slightly taller
  const raiseTextBase = isCreatorMode ? "text-lg" : "text-base";
  const iconSize = isCreatorMode ? 16 : 14;
  const actionDockNode = (() => {
    return (
      <>
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
      <div className={`hidden lg:flex fixed left-1/2 -translate-x-1/2 bottom-[${dockMargin}px] z-50`}>
        <div className="flex items-center justify-center gap-2.5 rounded-2xl border border-[#ff00cc]/25 bg-[#050510]/90 px-3 py-2.5 shadow-[0_10px_40px_rgba(0,0,0,0.6),0_0_25px_rgba(255,0,204,0.2)] backdrop-blur-xl">

          {/* Fold — bigger and more visible in creator mode */}
          <button
            onClick={() => performAction("fold")}
            aria-label="Fold"
            data-action="fold"
            className={`px-4 py-2.5 rounded-xl font-bold text-xs
            bg-red-900/60 border border-red-500/40
            text-red-200/90
            hover:bg-red-900/80 hover:border-red-400/60
            hover:shadow-[0_0_18px_rgba(255,0,0,0.35)]
            transition duration-100 active:scale-95
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300/60
            ${isCreatorMode ? `h-[${buttonH}px] text-base` : ``}`}
          >
            <span className="inline-flex items-center gap-1.5"><IconX size={iconSize} /> Fold</span>
          </button>

          {/* Check / Call — mid-tier */}
          {canCheck ? (
            <button
              onClick={() => performAction("check")}
              aria-label="Check"
              data-action="check"
              className={`px-5 py-3 rounded-xl font-bold text-sm
              bg-gradient-to-r from-[#00e5ff]/30 to-cyan-400/20
              border border-[#00e5ff]/50
              text-[#00e5ff]
              hover:shadow-[0_0_25px_rgba(0,229,255,0.45)]
              transition duration-100 active:scale-95
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60
              ${isCreatorMode ? `h-[${buttonH}px] ${buttonTextBase}` : ``}`}
            >
              <span className="inline-flex items-center gap-1.5"><IconCheck size={iconSize} /> Check</span>
            </button>
          ) : (
            <button
              onClick={() => performAction("call")}
              aria-label={`Call ${toCall}`}
              data-action="call"
              className={`px-5 py-3 rounded-xl font-bold text-sm
              bg-gradient-to-r from-[#00e5ff]/30 to-cyan-400/20
              border border-[#00e5ff]/50
              text-[#00e5ff]
              hover:shadow-[0_0_25px_rgba(0,229,255,0.45)]
              transition duration-100 active:scale-95
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60
              ${isCreatorMode ? `h-[${buttonH}px] ${buttonTextBase}` : ``}`}
            >
              <span className="inline-flex items-center gap-1.5"><IconPhone size={iconSize} /> Call {toCall}</span>
            </button>
          )}

          {/* Quick Bet — when no bet to call, post-flop */}
          {canUseBetShortcut && (
            <button
              onClick={() => performAction("bet20")}
              aria-label="Bet 20 tokens"
              data-action="bet20"
              className={`px-5 py-3 rounded-xl font-bold text-sm
              bg-gradient-to-r from-yellow-500/30 to-amber-400/15
              border border-yellow-400/55
              text-yellow-200
              hover:shadow-[0_0_25px_rgba(255,215,0,0.5)]
              transition duration-100 active:scale-95
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow-300/60
              ${isCreatorMode ? `h-[${buttonH}px] ${buttonTextBase}` : ``}`}
            >
              <span className="inline-flex items-center gap-1.5"><IconCoins size={iconSize} /> Bet 20</span>
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
            className={`px-6 py-3.5 rounded-xl font-black text-base
            bg-gradient-to-r from-[#ff00cc] via-fuchsia-500 to-pink-500
            border-2 border-[#ff00cc]/70
            text-black
            shadow-[0_0_28px_rgba(255,0,204,0.55),inset_0_0_8px_rgba(255,255,255,0.2)]
            hover:shadow-[0_0_38px_rgba(255,0,204,0.75)]
            transition duration-100 active:scale-95
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pink-300/70
            ${isCreatorMode ? `h-[${raiseH}px] ${raiseTextBase}` : ``}`}
          >
            <span className="inline-flex items-center gap-1.5"><IconArrowUp size={iconSize} /> Raise</span>
          </button>
        </div>
      </div>


      {/* ───────────────────────────── */}
      {/* MOBILE ACTION DOCK */}
      {/* ───────────────────────────── */}
      <div className={`lg:hidden fixed bottom-0 left-0 right-0 z-[80] px-2 pb-[max(env(safe-area-inset-bottom),${isCreatorMode ? 6 : 8}px)]`}>
        
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
            <div className={`uppercase tracking-widest text-[#b0b0ff]/60 ${isCreatorMode ? `text-sm` : ``}`}>
              Your Turn
            </div>

            <div className={`font-bold text-[#00e5ff] ${isCreatorMode ? `text-base` : `text-sm`}`}>
              {canCheck ? "Check Available" : `Call $${toCall}`}
            </div>
          </div>

          {/* Main Actions */}
          <div className="grid grid-cols-3 gap-2">
            <button
              onClick={() => performAction("fold")}
              className={`
                rounded-2xl
                bg-red-900/60
                border border-red-500/40
                text-red-200
                font-bold text-sm
                active:scale-95 transition duration-100
                ${isCreatorMode ? `h-[${buttonH}px]` : `h-14`}
              `}
            >
              Fold
            </button>

            {canCheck ? (
              <button
                onClick={() => performAction("check")}
                className={`
                  rounded-2xl
                  bg-[#00e5ff]/20
                  border border-[#00e5ff]/40
                  text-[#00e5ff]
                  font-bold text-sm
                  active:scale-95 transition duration-100
                  ${isCreatorMode ? `h-[${buttonH}px]` : `h-14`}
                `}
              >
                Check
              </button>
            ) : (
              <button
                onClick={() => performAction("call")}
                className={`
                  rounded-2xl
                  bg-[#00e5ff]/20
                  border border-[#00e5ff]/40
                  text-[#00e5ff]
                  font-bold text-sm
                  active:scale-95 transition duration-100
                  ${isCreatorMode ? `h-[${buttonH}px]` : `h-14`}
                `}
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
              className={`
                rounded-2xl
                bg-[#ff00cc]/20
                border border-[#ff00cc]/40
                text-[#ff00cc]
                font-bold text-sm
                active:scale-95 transition duration-100
                ${isCreatorMode ? `h-[${raiseH}px]` : `h-14`}
              `}
            >
              Raise
            </button>
          </div>

          {/* Quick Action Row */}
          {canUseBetShortcut && (
            <div className={`mt-2 ${isCreatorMode ? `mt-3` : ``}`}>
              <button
                onClick={() => performAction("bet20")}
                className={`
                  w-full rounded-xl
                  bg-yellow-500/15
                  border border-yellow-400/30
                  text-yellow-200
                  font-semibold text-sm
                  active:scale-95 transition duration-100
                  ${isCreatorMode ? `h-[${buttonH}px]` : `h-11`}
                `}
              >
                <span className="inline-flex items-center gap-1.5"><IconCoins size={iconSize} /> Quick Bet 20</span>
              </button>
            </div>
          )}

          {/* Emotes */}
          <div className="mt-3 flex justify-center">
            <EmotePicker
              compact
              hideBubbles
              incomingEmote={incomingEmote}
              myEmote={myEmote}
              onSend={(emote) => sendEmote(emote)}
            />
          </div>
        </div>
      </div>
    </>
  );
})()}
    </>
  );
})();

  // Public-game queue — pinned to the frame bottom-left (fixed → frame-relative
  // inside the creator recording root).
  const waitingPanelNode = (
    <>
      {!isPrivateGame && (
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
                    // A row appearing/leaving is a micro state change: 0.15s,
                    // and reduced motion keeps the fade but drops the slide.
                    initial={{ opacity: 0, y: shouldReduce ? 0 : 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: shouldReduce ? 0 : 6 }}
                    transition={{ duration: 0.15, ease: "easeOut" }}
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
    </>
  );

  // Normal (non-creator) page — identical stack as before.
  const normalView = (
    <>
      {rotateOverlayNode}
      {scanlinesNode}
      <div className="pointer-events-none absolute top-0 left-0 right-0 z-30 flex items-center justify-between gap-3 px-3 pt-3 sm:px-5 sm:pt-4">
        {topBarInnerNode}
      </div>
      <div className="relative z-10 mt-20 mb-4 flex flex-wrap items-center justify-center gap-2 sm:mt-24">
        {controlsInnerNode}
      </div>
      {actionLogNode}
      {tableBlockNode(false)}
      {actionDockNode}
      {waitingPanelNode}
    </>
  );

  // Portrait (9:16) — compact header, the felt filling the middle, and
  // controls + recent actions pinned at the bottom. No rotate overlay.
  const portraitContent = (
    <CreatorModeShell className="bg-gradient-to-br from-[#001933] to-[#000d1a]">
      <ShellHeader className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2">
          {topBarInnerNode}
        </div>
        <div className="flex flex-wrap items-center justify-center gap-2">
          {controlsInnerNode}
        </div>
      </ShellHeader>
      <ShellMain className="overflow-hidden">
        <PokerCreatorTableStage>{tableBlockNode(true)}</PokerCreatorTableStage>
      </ShellMain>
      <ShellAside className="space-y-2">
        {actionLogNode}
      </ShellAside>
      {actionDockNode}
      {waitingPanelNode}
      {scanlinesNode}
    </CreatorModeShell>
  );

  // Landscape (16:9) / square (1:1) — felt fills the height with
  // controls + recent actions in a right rail.
  const landscapeContent = (
    <CreatorModeShell className="bg-gradient-to-br from-[#001933] to-[#000d1a]">
      <ShellHeader className="flex items-center justify-between gap-2 px-1">
        {topBarInnerNode}
      </ShellHeader>
      <ShellMain className="overflow-hidden">
        <PokerCreatorTableStage>{tableBlockNode(true)}</PokerCreatorTableStage>
      </ShellMain>
      <ShellAside className="space-y-2">
        <div className="flex flex-wrap items-center justify-center gap-2">
          {controlsInnerNode}
        </div>
        {actionLogNode}
      </ShellAside>
      {actionDockNode}
      {waitingPanelNode}
      {scanlinesNode}
    </CreatorModeShell>
  );

  // main UI when game exists
  return (
    <div className="min-h-screen pb-36 lg:pb-0 flex flex-col items-center justify-center bg-gradient-to-b from-[#0a0118] to-[#061b3d] text-white overflow-hidden relative">
      {/* Only the actual hand table is recorded — the build/join lobby
          (the `!game` early-return above) and the report modal / footer
          below sit outside the shared CreatorModeHost recording viewport.
          Recording auto-starts when the host starts the real hand
          (`game.waiting` flips false = cards dealt) and auto-stops once
          the hand reaches its result (showdown + winner) so the winner
          animation is captured, then the grace period elapses. */}
      <CreatorModeHost
        autoStart={Boolean(game) && !game.waiting}
        autoStop={
          Boolean(game) &&
          game.stage === "showdown" &&
          Boolean(game.winnerId)
        }
        gameLabel="poker"
        // A spectator watching a shared table is on a live hand too, so
        // watching must never be counted as playing.
        presenceEnabled={!isSpectator}
        backToLobbyHref="/casino/poker"
      >      <CreatorView
        normal={normalView}
        portrait={portraitContent}
        landscape={landscapeContent}
      />
      </CreatorModeHost>
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
