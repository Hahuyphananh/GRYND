"use client";

import { useState, useEffect } from "react";
import { Card, evaluateHand } from "../../../lib/handEval";
import { motion, AnimatePresence } from "framer-motion";
import { useRouter } from "next/navigation";
import { useUser } from "@clerk/nextjs";

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
};

const SUITS = ["♠", "♥", "♦", "♣"];
const VALUES = ["2","3","4","5","6","7","8","9","10","J","Q","K","A"];

function createDeck(): Card[] {
  return SUITS.flatMap(suit => VALUES.map(value => ({ suit, value })));
}
function shuffle(deck: Card[]): Card[] {
  return deck.sort(()=>Math.random()-0.5);
}

function nextActive(start: number, players: Player[]): number {
  let i = start % players.length;
  let safety = 0;

  console.log("➡️ nextActive called", {
  start,
  resolvedIndex: i,
  resolvedPlayer: players[i]?.name
});

  while (
    (players[i]?.hasFolded || !players[i]) &&
    safety < players.length
  ) {
    i = (i + 1) % players.length;
    safety++;
  }

  return i;

}

function getActiveIndices(players: Player[]): number[] {
  return players
    .map((p, i) => (!p.hasFolded ? i : -1))
    .filter(i => i !== -1);
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
  const clerkId = user?.id; 
  const myId = clerkId;
  const router = useRouter();
  const [name,setName] = useState("");
  const [game,setGame] = useState<Game|null>(null);
  const [raiseAmount,setRaiseAmount] = useState(50);
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

  // UI modal / seat state
  const [seatModalOpen, setSeatModalOpen] = useState(false);
  const [selectedSeat, setSelectedSeat] = useState<number | null>(null);
  const [aiNameInput, setAiNameInput] = useState("");
  const [aiStackInput, setAiStackInput] = useState<number>(1000);


  const maxCurrentBet = (players: Player[]) => Math.max(...players.map(p => p.currentBet || 0));

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
      const res = await fetch(`/api/poker/game-state?code=${encodeURIComponent(code)}`);
      if (!res.ok) return;
      const data = await res.json();
      if (data?.game) setGame(data.game);
    } catch (err) {
      console.error("Failed to fetch game state", err);
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

function findFirstActorIndex(
  players: Player[],
  dealerIndex: number,
  stage: Game["stage"]
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

  const [waitingPlayers, setWaitingPlayers] = useState<{id:string,name:string,level?:number}[]>([]);

  const fetchWaitingPlayers = async () => {
    try {
      // try known endpoints, fall back gracefully
      const endpoints = ["/api/poker/waiting-players", "/api/poker/public-waiting", "/api/poker/public-queue"];
      let data:any = null;
      for (const ep of endpoints) {
        try {
          const res = await fetch(ep);
          if (!res.ok) continue;
          data = await res.json();
          if (Array.isArray(data)) break;
          if (data.players && Array.isArray(data.players)) { data = data.players; break; }
          if (data.waiting && Array.isArray(data.waiting)) { data = data.waiting; break; }
        } catch (e) { continue; }
      }
      if (!data) {
        // fallback: show a simple placeholder count based on availablePublicGames
        setWaitingPlayers(Array.from({length: availablePublicGames}, (_,i)=>({id:`fallback_${i}`, name:`Player ${i+1}`})));
        return;
      }
      // normalize to {id,name}
      const norm = data.map((p:any, idx:number) => ({ id: p.id || p.playerId || `p_${idx}`, name: p.name || p.displayName || p.player || myId, level: p.level }));
      setWaitingPlayers(norm);
    } catch (err) {
      console.error("Failed to fetch waiting players", err);
      setWaitingPlayers([]);
    }
  };

  useEffect(() => {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("gameCode");
  if (code) {
    setInviteCode(code);
    joinGame(code);
  }
}, []);

  const fetchPublicGamesCount = async () => {
    try {
      const res = await fetch("/api/poker/public-games");
      const data = await res.json();
      setAvailablePublicGames(data.count || 0);
    } catch (err) {
      console.error("Error fetching public games:", err);
      setAvailablePublicGames(0);
    }
  };

useEffect(() => {
  fetchUserTokens();
  fetchPublicGamesCount();
}, []);

// Multiplayer Waiting List Auto-Refresh
useEffect(() => {
  const interval = setInterval(() => {
    fetchPublicGamesCount();
  }, 3000);

  return () => clearInterval(interval);
}, []);

useEffect(() => {
  if (!game?.inviteCode) return;
  const interval = setInterval(() => {
    fetchGameState(game.inviteCode!);
  }, 1500);
  return () => clearInterval(interval);
}, [game?.inviteCode]);


// Turn timer effect — runs whenever the current turn changes
useEffect(() => {
  if (!game) return;

  const currentPlayer = game.players[game.currentTurn];
  const isPlayerTurn = currentPlayer && currentPlayer.id === myId;
  setIsMyTurn(isPlayerTurn);
  setTurnTimer(60); // reset every time the turn changes

  if (!isPlayerTurn || game.stage === "showdown" || game.waiting) return;

  // Start countdown only if it's your turn
  const interval = setInterval(() => {
    setTurnTimer((t) => {
      if (t <= 1) {
        clearInterval(interval);
        performAction("fold"); // auto fold when time runs out
        return 0;
      }
      return t - 1;
    });
  }, 1000);

  // cleanup
  return () => clearInterval(interval);
}, [game?.currentTurn]);

  // -----------------------------
  // Seat positions (aligned around the table)
  // Table: 700x400 centered in 900x600 container
  // Player stays at bottom-center (same as before)
  // -----------------------------
  const seatPositions = [
  { left: 450, top: 30 },   // 0: top-center
  { left: 700, top: 80 },  // 1: top-right (lowered & slightly left)
  { left: 700, top: 450 },  // 2: bottom-right
  { left: 450, top: 480 },  // 3: bottom-center (YOU)
  { left: 200, top: 450 },  // 4: bottom-left
  { left: 200, top: 80 },  // 5: top-left (lowered & slightly right)
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
  game.deck.length > 0
    ? [...game.deck]
    : shuffle(createDeck());

    const players = game.players.map(p => ({
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
  "pre-flop"
);

console.log("🟢 GAME START TURN CHECK", {
  stage: "pre-flop",
  dealerIndex: game.dealerIndex,
  firstActorIndex,
  firstActorName: players[firstActorIndex]?.name,
  seating: players.map(p => ({
    seat: p.seatIndex,
    name: p.name,
    folded: p.hasFolded
  }))
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
  players.map(p => ({ name: p.name, seat: p.seatIndex })),
  "firstTurn:",
  players[firstActorIndex]?.name
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
    const me = players.find(p => p.id === clerkId);
    if (me) setBalance(me.stack);

  } catch (err) {
    console.error("Join game error:", err);
    alert("Failed to join game");
  } finally {
    setJoiningGame(false);
  }
}


  async function joinPublicGame() {
    setJoiningGame(true);
    try {
      const res = await fetch("/api/poker/join-public", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ playerName: name }),
      });

      const data = await res.json();
      if (!res.ok) return alert(data.error || "No public games available");

      setInviteCode(data.gameCode);
      await joinGame(data.gameCode);
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

  const timer = setTimeout(() => {
    try {
      const hs = evaluateHand(current.hand, game.community);
      const highest = Math.max(...game.players.map(p => p.currentBet));

let action: "check" | "call" | "raise" | "fold"| "bet20";

if (current.currentBet < highest) {
  action = "call";
} else if (Math.random() < 0.35) {
  action = "bet20"; // force visible chips
} else {
  action = "check";
}


      if (hs.includes("Three") || hs.includes("Straight") || hs.includes("Flush")) {
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
  }, 800 + Math.random() * 600);

  setAiThinking(true);

  return () => clearTimeout(timer);
}, [game?.currentTurn, game?.stage]);


  function checkForWinner(players: Player[], pot: number) {
    const activePlayers = players.filter(p => !p.hasFolded);
    if (activePlayers.length === 1) {
      const winner = activePlayers[0];
      const updatedPlayers = players.map(p =>
        p.id === winner.id ? { ...p, stack: p.stack + pot } : p
      );

      if (winner.id === myId) {
        setBalance(prev => prev + pot);
        fetchUserTokens();
      }

      setGame(g => g ? ({
        ...g,
        players: updatedPlayers,
        winnerId: winner.id,
        pot: 0,
        stage: "showdown",
        replayVisible: true,
      }) : g);

      return true;
    }
    return false;
  }

  function performAction(action: "check" | "call" | "raise" | "fold" | "bet20", isAI = false) {
    if (!game) return;

    const players = game.players.map(p => ({ ...p }));
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
          setBalance(prev => Math.max(prev - actual, 0));
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
      const toCall = Math.max(0, highest - (current.currentBet || 0));
      const totalPut = toCall + raiseAmount;
      const actual = Math.min(totalPut, current.stack);
      current.stack -= actual;
      current.currentBet += actual;
      potNew += actual;
      current.lastAction = `Raised ${raiseAmount}`;
  game.lastAggressorIndex = currentIndex;

players.forEach((p, i) => {
  if (i !== currentIndex && !p.hasFolded) {
    p.hasActed = false;
  }
});
      if (current.id === myId) {
        setBalance(prev => Math.max(prev - actual, 0));
      }
    }else if (action === "check") {
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
      setBalance(prev => Math.max(prev - actual, 0));
      fetchUserTokens();
    }
  }
}

function getActiveIndices(players: Player[]): number[] {
  return players
    .map((p, i) => (!p.hasFolded ? i : -1))
    .filter(i => i !== -1);
}

const activePlayers = players.filter(p => !p.hasFolded);
const highestBet = Math.max(...players.map(p => p.currentBet));

// 🛑 If only one player remains → instant win
if (activePlayers.length === 1) {
  checkForWinner(players, potNew);
  return;
}

// 🛑 If everyone has matched the bet → end betting round
const bettingComplete = activePlayers.every(
  p => p.hasActed && p.currentBet === highestBet
);

if (bettingComplete) {
  setGame(g => {
    if (!g) return g;
    const nextState = { ...g, players, pot: potNew };
    saveGameState(nextState as Game);
    return nextState;
  });

  setTimeout(() => advanceStage(), 500);
  return;
}

// ▶️ Otherwise → advance to next ACTIVE player
const nextTurn = nextActiveFrom(currentIndex, players);

setGame(g => {
  if (!g) return g;
  const nextState = { ...g, players, pot: potNew, currentTurn: nextTurn };
  saveGameState(nextState as Game);
  return nextState;
});
}

  async function advanceStage() {
    if (!game) return;
    const deck = [...game.deck];
    const comm = [...game.community];
    const playersReset = game.players.map(p => ({
  ...p,
  currentBet: 0,
  hasActed: false, // ✅
}));

    let nextStage: Game["stage"] = game.stage;

if (game.stage === "pre-flop") {
  // Deal all 3 flop cards at once, small visual delay
  await new Promise(res => setTimeout(res, 400));
  comm.push(deck.pop()!, deck.pop()!, deck.pop()!);
  nextStage = "flop";
} else if (game.stage === "flop") {
  await new Promise(res => setTimeout(res, 400));
  comm.push(deck.pop()!);
  nextStage = "turn";
} else if (game.stage === "turn") {
  await new Promise(res => setTimeout(res, 400));
  comm.push(deck.pop()!);
  nextStage = "river";
} else if (game.stage === "river") {
  showdown();
  return;
}

const nextDealer = (game.dealerIndex + 1) % game.players.length;
const firstToAct = findFirstActorIndex(
  playersReset,
  nextDealer,
  nextStage
);

console.log("🟡 STAGE ADVANCE TURN CHECK", {
  stage: nextStage,
  dealerIndex: nextDealer,
  firstActorIndex: firstToAct,
  firstActorName: playersReset[firstToAct]?.name,
  seating: playersReset.map(p => ({
    seat: p.seatIndex,
    name: p.name,
    folded: p.hasFolded
  }))
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
    if(!game) return;
    const active=game.players.filter(p=>!p.hasFolded);
    let winner=active[0], best=-1;
    active.forEach(p=>{
      const label=evaluateHand(p.hand,game.community);
      let score=1;
      if(label.includes("Royal")) score=10;
      else if(label.includes("Straight Flush")) score=9;
      else if(label.includes("Four")) score=8;
      else if(label.includes("Full")) score=7;
      else if(label.includes("Flush")) score=6;
      else if(label.includes("Straight")) score=5;
      else if(label.includes("Three")) score=4;
      else if(label.includes("Two Pair")) score=3;
      else if(label.includes("Pair")) score=2;
      if(score>best){best=score;winner=p;}
    });

    const updated=game.players.map(p=>p.id===winner.id?{...p,stack:p.stack+game.pot}:p);

    if (winner.id === myId) {
      setBalance(prev => prev + game.pot);
      fetchUserTokens();
    }

    const nextGame: Game = {...game,players:updated,winnerId:winner.id,pot:0,stage:"showdown",replayVisible:true};
    setGame(nextGame);
    saveGameState(nextGame);
    if (leaveAfterHand) {
      setTimeout(() => {
        window.location.href = "/casino/poker";
      }, 2000);
    }
  }

  function replayHand() {
    if (!game) return;

    const nextDealer = (game.dealerIndex + 1) % game.players.length;
    const handsPlayed = (game as any).handsPlayed ?? 0;
    const newSmallBlind = handsPlayed > 0 && handsPlayed % 3 === 0 ? game.smallBlind * 2 : game.smallBlind;
    const newBigBlind = handsPlayed > 0 && handsPlayed % 3 === 0 ? game.bigBlind * 2 : game.bigBlind;

    const newDeck = shuffle(createDeck());
    const resetPlayers = game.players.map(p => ({
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
  const occupied = game.players.some(p => p.seatIndex === seatIndex);
  if (occupied) return false;

  // only allow humans before game starts
  if (!game.waiting) return false;

  return true;
}

  // ---- Seat click: open modal to add AI or invite (we only do AI add now) ----
function handleSeatClick(seatIndex: number) {
  if (!game) return alert("Create or join a game first.");

  if (!game.waiting)
    return alert("Seats are locked once the game starts.");

  const occupied = game.players.some(p => p.seatIndex === seatIndex);
  if (occupied) return alert("Seat already taken.");

  setSelectedSeat(seatIndex);
  setSeatModalOpen(true);
}

async function sitAsHuman() {
  if (selectedSeat === null || !game || !clerkId) return;

  // HARD GUARD — never allow duplicates
  if (game.players.some(p => p.id === clerkId)) {
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

    const existingAIs = game.players.filter(p => p.isAI).length;
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
    return game?.players.find(p => p.seatIndex === seatIndex) ?? null;
  }
const isHost = !!(game && clerkId && game.hostClerkId === clerkId);

// Determine if someone has bet after the flop
const hasBetThisRound =
  game &&
  game.stage !== "pre-flop" &&
  game.players.some(
    (p, idx) =>
      !p.hasFolded &&
      p.currentBet > 0 &&
      idx !== game.roundStarter // 🔑 ignore blind carry-over
  );

if (showJoinForm) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-slate-900 text-white">
      <div className="absolute top-4 left-4">
        <button
          onClick={() => setShowJoinForm(false)}
          className="bg-yellow-500 hover:bg-yellow-400 text-black px-4 py-2 rounded font-bold transition"
        >
          ← Back
        </button>
      </div>

      <div className="p-6 bg-slate-800 rounded shadow w-96 text-center">
        <h1 className="text-2xl mb-4">Join a Private Game</h1>

        <input
          placeholder="Enter Invite Code"
          value={inviteCode}
          onChange={(e) => setInviteCode(e.target.value)}
          className="w-full p-2 rounded mb-3 text-black"
        />

        <button
          onClick={() => joinGame()}
          className="bg-green-500 px-4 py-2 rounded w-full font-bold mb-2"
        >
          Join Game
        </button>

        <button
          onClick={() => setShowJoinForm(false)}
          className="bg-red-500 px-4 py-2 rounded w-full font-bold"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

  // ==== RENDER ====
  if (!game) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-slate-900 text-white">
        <div className="absolute top-4 left-4">
  <a href="/casino">
    <button className="bg-yellow-500 hover:bg-yellow-400 text-black px-4 py-2 rounded font-bold transition">
      ← Return to Casino
    </button>
  </a>
</div>

        <div className="p-6 bg-slate-800 rounded shadow w-96 text-center mb-4">
    <h1
  className="text-2xl mb-4 font-extrabold text-transparent bg-clip-text 
  bg-gradient-to-r from-yellow-300 via-amber-400 to-yellow-300 
  drop-shadow-[0_0_8px_rgba(255,223,0,0.6)] tracking-widest uppercase animate-shimmer-elegant"
>
  ♠ Poker Royale ♠
</h1>



{availablePublicGames > 0 ? (
  <p className="text-green-400 mb-2">
    {availablePublicGames} Public Game{availablePublicGames > 1 ? "s" : ""} Available
  </p>
) : (
  <p className="text-gray-400 mb-2">No public games available</p>
)}


          <input
            placeholder="Your display name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full p-2 rounded mb-3 text-black"
          />

          <label className="block mb-2">Private Game:</label>
          <select
            value={isPrivate ? "true" : "false"}
            onChange={(e) => setIsPrivate(e.target.value === "true")}
            className="border p-2 rounded mb-4 w-full text-black"
          >
            <option value="true">Private</option>
            <option value="false">Public</option>
          </select>

          <button
            onClick={() => createGame()}
            className="bg-yellow-500 px-4 py-2 rounded w-full font-bold mb-2"
          >
            Create Game
          </button>

          <button
  onClick={() => setShowJoinForm(true)}
  className="bg-green-500 px-4 py-2 rounded w-full font-bold mb-2"
>
  Join Game
</button>


   <button
  onClick={availablePublicGames > 0 ? joinPublicGame : undefined}
  disabled={availablePublicGames === 0}
  className={`px-4 py-2 rounded w-full font-bold mb-2 transition ${
    availablePublicGames > 0
      ? "bg-blue-500 hover:bg-blue-400"
      : "bg-gray-500 cursor-not-allowed text-gray-300"
  }`}
>
  {availablePublicGames > 0 ? "Join Public Game" : "No Public Game Available"}
</button>


          <a href="/casino/poker/">
            <button className="bg-red-500 px-4 py-2 rounded w-full font-bold mb-2">Retour</button>
          </a>
        </div>
      </div>
    );
  }

  // main UI when game exists
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-slate-900 text-white p-6">
     <div className="absolute top-4 left-4">
  <button
    onClick={() => {
      if (game?.stage === "showdown" || game?.waiting) {
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


      <h1 className="text-3xl mb-4">Texas Hold'em</h1>

     {game?.inviteCode && (
  <div className="mb-4 text-center flex items-center justify-center gap-4">
    <div>
      <span className="font-bold">Invite Code:</span>{" "}
      <span className="bg-yellow-300 text-black px-2 py-1 rounded">{game.inviteCode}</span>
      <button
        onClick={() => { navigator.clipboard.writeText(game.inviteCode || ""); alert("Invite code copied!"); }}
        className="ml-2 bg-blue-500 px-3 py-1 rounded text-sm"
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
            alert("You need at least 1 AI to start (player + 1 AI). Add an AI by clicking a seat.");
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


      <div className="mb-4 flex flex-col items-center">
        {/* Pot moved inside table for layout; but keep this here as well if you want */}
      </div>

      {/* The poker table itself */}
      <div className="relative w-[700px] h-[400px] bg-green-700 rounded-full border-8 border-yellow-800 flex items-center justify-center mb-6 mt-12 shadow-[0_0_40px_rgba(255,215,0,0.3)]">
        {/* community cards in center */}
       {/* Centered pot display */}
{game && (
  <div
    className="absolute text-yellow-300 text-sm font-bold bg-black/50 px-3 py-1.5 rounded-full border border-yellow-400 shadow-lg"
    style={{
      left: "50%",                 // perfectly centered horizontally
      top: "27%",                  // moved up so it won't overlap community cards
      transform: "translate(-50%, 0)", // keep centered but avoid vertical translate that overlaps cards
      zIndex: 15,                  // adjust stacking; lower than cards if you want cards on top
      padding: "6px 10px",         // slightly smaller/more compact
    }}
  >
    💰 Pot: ${game.pot}
  </div>
)}
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
          <div className="flex gap-2 relative">
            <AnimatePresence>
              {(game?.community || [])
  .filter((c): c is Card => !!c && !!c.suit && !!c.value)
  .map((c, i) => (
                <motion.div
                  key={`${c.suit}-${c.value}-${i}`}
                  initial={{ opacity: 0, y: -200, x: Math.random() * 200 - 100, rotate: Math.random() * 40 - 20, scale: 0.5 }}
                  animate={{ opacity: 1, y: 0, x: 0, rotate: 0, scale: 1, transition: { delay: i * 0.2, type: "spring", stiffness: 120 } }}
                  exit={{ opacity: 0, scale: 0.8, y: 50 }}
                  className={`w-16 h-24 bg-white flex items-center justify-center rounded shadow ${c.suit === "♥" || c.suit === "♦" ? "text-red-600" : "text-black"}`}
                >
                  {c.value}{c.suit}
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        </div>
     {/* Your Best Hand (always visible, centered below community cards) */}
{game && (
  <div
    className="absolute text-white text-sm font-semibold mt-6 bg-black/40 px-3 py-1 rounded-lg border border-yellow-400"
    style={{
      top: "58%", // slightly below community cards
      left: "50%",
      transform: "translateX(-50%)",
      zIndex: 30,
    }}
  >
    Your Best Hand:{" "}
    {evaluateHand(
      game.players.find((p) => p.id === myId)?.hand || [],
      game.community
    )}
  </div>
)}



{/* ACTION BUTTONS — moved outside the gameboard (2 per side) */}
{!game?.waiting && game?.stage !== "showdown" && (
  <>
    {/* LEFT SIDE BUTTONS */}
    <div className="absolute left-0 top-1/2 -translate-y-1/2 flex flex-col gap-3 ml-[-100px] z-40 pointer-events-auto">
      <button
        onClick={() => performAction("fold")}
        disabled={!isMyTurn}
        className={`px-4 py-2 rounded w-24 transition ${
          isMyTurn
            ? "bg-red-600 hover:bg-red-500"
            : "bg-red-800 text-gray-300 opacity-60 cursor-not-allowed"
        }`}
      >
        Fold
      </button>

      <button
        onClick={() => performAction("check")}
        disabled={!isMyTurn}
        className={`px-4 py-2 rounded text-black w-24 transition ${
          isMyTurn
            ? "bg-yellow-500 hover:bg-yellow-400"
            : "bg-yellow-900 text-gray-400 opacity-60 cursor-not-allowed"
        }`}
      >
        Check
      </button>
    </div>

    {/* RIGHT SIDE BUTTONS */}
    <div className="absolute right-0 top-1/2 -translate-y-1/2 flex flex-col gap-3 mr-[-100px] z-40 pointer-events-auto">
      <button
        onClick={() => {
          if (!isMyTurn) return;
          if (game?.stage !== "pre-flop") {
            if (hasBetThisRound) performAction("call");
            else performAction("bet20"); // new pseudo-action
          } else {
            performAction("call");
          }
        }}
        disabled={!isMyTurn}
        className={`px-4 py-2 rounded w-24 transition ${
          isMyTurn
            ? "bg-blue-600 hover:bg-blue-500"
            : "bg-blue-900 text-gray-300 opacity-60 cursor-not-allowed"
        }`}
      >
        {game?.stage !== "pre-flop" && !hasBetThisRound ? "Bet 20" : "Call"}
      </button>

      <div className="flex flex-col items-center">
        <input
          type="number"
          min={10}
          max={game?.players?.[0]?.stack ?? 1000}
          value={raiseAmount}
          onChange={(e) => setRaiseAmount(Number(e.target.value))}
          disabled={!isMyTurn}
          className={`w-20 text-black px-2 py-1 rounded mb-1 ${
            !isMyTurn ? "opacity-50 cursor-not-allowed" : ""
          }`}
        />
        <button
          onClick={() => isMyTurn && performAction("raise")}
          disabled={!isMyTurn}
          className={`px-4 py-2 rounded w-24 transition ${
            isMyTurn
              ? "bg-green-600 hover:bg-green-500"
              : "bg-green-900 text-gray-300 opacity-60 cursor-not-allowed"
          }`}
        >
          Raise
        </button>
      </div>
    </div>
  </>
)}


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
      ${isPlayer ? "bg-yellow-400 text-black" : "bg-slate-800 text-white"}
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
            {isPlayer
              ? (occupant.hand || [])
  .filter((card): card is Card => !!card && !!card.suit && !!card.value)
  .map((card, i) => (
    <div
      key={i}
      className={`w-6 h-8 rounded bg-white flex items-center justify-center
        text-[10px] font-bold shadow 
        ${
          card.suit === "♥" || card.suit === "♦"
            ? "text-red-600"
            : "text-black"
        }
      `}
    >
      {card.value}
      {card.suit}
    </div>
  ))

              : game?.stage !== "showdown"
              ? (
                  <>
                    {/* Face-down cards for opponents */}
                    <div className="w-6 h-8 bg-gray-700 rounded border border-gray-500 shadow"></div>
                    <div className="w-6 h-8 bg-gray-700 rounded border border-gray-500 shadow"></div>
                  </>
                )
              : (
               (occupant.hand || [])
  .filter((card): card is Card => !!card && !!card.suit && !!card.value)
  .map((card, i) => (
    <div
      key={i}
      className={`w-6 h-8 rounded bg-white flex items-center justify-center
        text-[10px] font-bold shadow 
        ${
          card.suit === "♥" || card.suit === "♦"
            ? "text-red-600"
            : "text-black"
        }
      `}
    >
      {card.value}
      {card.suit}
    </div>
  ))

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
                  style={{ width: `${(turnTimer / 60) * 100}%` }}
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
    case 0: offset = { x: -17, y: 50 }; break;        // top-center 
    case 1: offset = { x: -85, y: 40 }; break;        // top-right 
    case 2: offset = { x: -90, y: -70 }; break;       // bottom-right
    case 3: offset = { x: -15, y: -75 }; break;       // bottom-center → PLAYER
    case 4: offset = { x: 50, y: -70 }; break;        // bottom-left
    case 5: offset = { x: 50, y: 40 }; break;         // top-left
    default: offset = { x: 0, y: 0 };
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
      <h2 className="text-xl font-bold mb-2">
        Seat {selectedSeat}
      </h2>

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
    <div className="bg-slate-800 text-white p-6 rounded-xl w-80 shadow-xl border border-yellow-500">
      <h2 className="text-xl font-bold mb-4 text-center text-yellow-400">
        🤖 AI Player Info
      </h2>

      <div className="space-y-2 text-sm">
        <p><span className="font-semibold">Name:</span> {selectedAi.name}</p>
        <p><span className="font-semibold">Stack:</span> ${selectedAi.stack}</p>
        <p><span className="font-semibold">Seat:</span> {selectedAi.seatIndex}</p>
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

            setGame(g =>
              g
                ? {
                    ...g,
                    players: g.players.filter(p => p.id !== selectedAi.id),
                  }
                : g
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
              <div className="text-xs text-gray-300">{waitingPlayers.length} waiting</div>
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
                    <div className="truncate text-sm">{p.name || "Anonymous"}</div>
                    <div className="text-xs text-gray-300">{p.level ? `Lv ${p.level}` : ""}</div>
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>

            <div className="mt-3 flex gap-2">
              <button
                onClick={() => joinPublicGame()}
                disabled={joiningGame}
                className={`flex-1 text-sm px-3 py-2 rounded font-bold transition ${joiningGame ? "bg-gray-600 cursor-not-allowed" : "bg-blue-600 hover:bg-blue-500"}`}
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
