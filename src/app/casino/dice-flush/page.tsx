"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
// @ts-ignore: no types for canvas-confetti in this project
import confetti from "canvas-confetti";
import { useUser } from "@clerk/nextjs";
import { usePostHog } from "posthog-js/react";
import { useSocket } from "../../../context/SocketProvider";
import NavigationBar from "../../../components/navigation-bar";
import Footer from "../../../components/Footer";
import ReportModal from "../../../components/ReportModal";
import { RulesModal, useFirstVisitRules } from "../../../components/lobby/PvpLobby";
import {
  IconNotebook,
  IconDice,
  IconPin,
  IconClipboardList,
  IconFlag,
  IconUsers,
  IconRobot,
  IconDeviceGamepad2,
  IconBolt,
  IconCheck,
  IconHourglass,
  IconSparkles,
  IconTrophy,
  IconSkull,
  IconBook,
} from "@tabler/icons-react";


type LobbyRoom = { id: string; wager: number; status: string };
type Player = { userId: string; name: string; isAI?: boolean };
type GameState = {
  id: string;
  players: Player[];
  currentTurn: string;
  rollsThisTurn: number;
  dice: number[];
  heldDice: boolean[];
  scorecards: Record<string, Record<string, number>>;
  state: string;
  turnNumber?: number;
};

const categories = [
  ["ones", "Ones"], ["twos", "Twos"], ["threes", "Threes"], ["fours", "Fours"], ["fives", "Fives"], ["sixes", "Sixes"],
  ["threeOfKind", "3-Kind"], ["fourOfKind", "4-Kind"], ["fullHouse", "Full Hse"], ["smallStraight", "Sm Str"], ["largeStraight", "Lg Str"], ["fiveKind", "5-Kind"], ["chance", "Chance"],
] as const;

const sum = (d: number[]) => d.reduce((a, b) => a + b, 0);
const scoreFor = (dice: number[], category: string) => {
  const c = new Map<number, number>(); dice.forEach((v) => c.set(v, (c.get(v) ?? 0) + 1));
  const f = [...c.values()].sort((a, b) => b - a); const u = [...new Set(dice)].sort((a, b) => a - b);
  if (category === "chance") return sum(dice);
  if (["ones", "twos", "threes", "fours", "fives", "sixes"].includes(category)) { const n = ["ones", "twos", "threes", "fours", "fives", "sixes"].indexOf(category) + 1; return dice.filter((d) => d === n).length * n; }
  if (category === "threeOfKind") return f[0] >= 3 ? sum(dice) : 0;
  if (category === "fourOfKind") return f[0] >= 4 ? sum(dice) : 0;
  if (category === "fullHouse") return f[0] === 3 && f[1] === 2 ? 25 : 0;
  if (category === "smallStraight") return ([1,2,3,4].every((n) => u.includes(n)) || [2,3,4,5].every((n) => u.includes(n)) || [3,4,5,6].every((n) => u.includes(n))) ? 30 : 0;
  if (category === "largeStraight") return (JSON.stringify(u) === "[1,2,3,4,5]" || JSON.stringify(u) === "[2,3,4,5,6]") ? 40 : 0;
  if (category === "fiveKind") return f[0] === 5 ? 50 : 0;
  return 0;
};

const DiceFace = ({
  value,
  held,
  rolling,
  index = 0,
  unknown = false,
}: {
  value: number;
  held?: boolean;
  rolling?: boolean;
  index?: number;
  unknown?: boolean;
}) => {
  const dots: Record<number, string[]> = {
    1: ["50% 50%"],
    2: ["30% 30%", "70% 70%"],
    3: ["30% 30%", "50% 50%", "70% 70%"],
    4: ["30% 30%", "70% 30%", "30% 70%", "70% 70%"],
    5: ["30% 30%", "70% 30%", "50% 50%", "30% 70%", "70% 70%"],
    6: ["30% 25%", "70% 25%", "30% 50%", "70% 50%", "30% 75%", "70% 75%"],
  };

  const rollVariants: Record<string, any> = {
    rolling: {
      rotate: [0, 15 * (index % 2 === 0 ? 1 : -1), -15 * (index % 2 === 0 ? 1 : -1), 8 * (index % 2 === 0 ? 1 : -1), -5, 0],
      x: [0, 3 * (index % 2 === 0 ? 1 : -1), -3 * (index % 2 === 0 ? 1 : -1), 2, -1, 0],
      y: [0, -4, -2, -6, -1, 0],
      scale: [1, 1.05, 0.95, 1.03, 0.98, 1],
    },
    idle: {
      rotate: 0,
      x: 0,
      y: 0,
      scale: 1,
    },
  };

  if (unknown) {
    return (
      <motion.div
        animate={{ opacity: [0.3, 0.6, 0.3] }}
        transition={{ duration: 1.5, repeat: Infinity }}
        className="relative h-16 w-16 rounded-2xl border-[3px] cursor-not-allowed
          bg-gradient-to-br from-[#0a1628] to-[#030817]
          border-[#00e5ff]/30 shadow-[0_6px_0_rgba(0,0,0,0.5)]
          select-none flex items-center justify-center"
      >
        <motion.span
          animate={{ scale: [1, 1.15, 1] }}
          transition={{ duration: 1, repeat: Infinity }}
          className="text-3xl font-black text-[#00e5ff]/40"
        >
          ?
        </motion.span>
      </motion.div>
    );
  }

  return (
    <motion.div
      variants={rollVariants}
      animate={rolling ? "rolling" : "idle"}
      whileTap={held ? { scale: 0.92 } : { scale: 0.95 }}
      transition={{
        duration: 0.25,
        repeat: rolling ? Infinity : 0,
        ease: "easeInOut",
      }}
      className={`
        relative h-16 w-16 rounded-2xl border-[3px] cursor-pointer
        bg-gradient-to-br from-[#1a2940] to-[#0d1a2e]
        shadow-[0_6px_0_rgba(0,0,0,0.5)]
        select-none
        ${
          held
            ? "border-[#f5ff3b] ring-4 ring-[#f5ff3b]/30 shadow-[0_0_20px_rgba(245,255,59,0.35)]"
            : "border-[#00e5ff]/40 hover:border-[#00e5ff]"
        }
        ${rolling ? "shadow-[0_0_25px_rgba(0,229,255,0.5)]" : ""}
      `}
    >
      {dots[value]?.map((pos, i) => {
        const [left, top] = pos.split(" ");

        return (
          <motion.span
            key={i}
            className="absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full"
            style={{ left, top }}
            animate={{
              backgroundColor: held ? ["#f5ff3b", "#fbbf24", "#f5ff3b"] : "#f5ff3b",
              scale: rolling ? [1, 1.3, 1] : 1,
            }}
            transition={{
              duration: 0.5,
              repeat: rolling ? Infinity : 0,
              delay: i * 0.08,
            }}
          />
        );
      })}

      {/* Glow overlay on held */}
      {held && (
        <motion.div
          className="absolute inset-0 rounded-2xl bg-[#f5ff3b]/10"
          animate={{ opacity: [0.3, 0.6, 0.3] }}
          transition={{ duration: 1.5, repeat: Infinity }}
        />
      )}
    </motion.div>
  );
};

function MoveHistoryPanel({ history, you, opponent }: { history: any[]; you: any; opponent: any }) {
  const [open, setOpen] = useState(false);
  const isSelf = (userId: string) => userId === you?.userId;
  const label = (userId: string) => isSelf(userId) ? "You" : (opponent?.name || "Opponent");

  const grouped = useMemo(() => {
    const groups: { turn: number; userId: string; name: string; actions: any[] }[] = [];
    let turn = 0;
    for (let i = 0; i < history.length; i++) {
      const a = history[i];
      if (a.action === "roll") {
        turn++;
        groups.push({ turn, userId: a.userId, name: label(a.userId), actions: [a] });
      } else if (a.action === "hold_dice") {
        if (groups.length > 0) groups[groups.length - 1].actions.push(a);
      } else if (a.action === "choose_category") {
        if (groups.length > 0) groups[groups.length - 1].actions.push(a);
        else groups.push({ turn: ++turn, userId: a.userId, name: label(a.userId), actions: [a] });
      } else {
        groups.push({ turn: ++turn, userId: a.userId, name: label(a.userId), actions: [a] });
      }
    }
    return groups;
  }, [history]);

  const latestCount = grouped.length;

  return (
    <div className="mb-5 overflow-hidden rounded-xl border border-[#00e5ff]/30 bg-black/30">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between px-4 py-2.5 text-sm font-bold text-[#00e5ff] transition-colors hover:bg-white/5"
      >
        <span className="flex items-center gap-2">
          <IconNotebook size={18} className="text-[#00e5ff]" />
          <span>Move History</span>
          <span className="rounded-full bg-[#00e5ff]/10 px-2 py-0.5 text-xs text-[#00e5ff]">{latestCount}</span>
        </span>
        <motion.svg
          animate={{ rotate: open ? 180 : 0 }}
          transition={{ duration: 0.25 }}
          className="h-4 w-4"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </motion.svg>
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="history-panel"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: "easeInOut" }}
            className="overflow-hidden border-t border-[#00e5ff]/20"
          >
            <div className="max-h-80 space-y-1 overflow-y-auto p-2">
              {grouped.length === 0 && (
                <p className="px-3 py-4 text-center text-xs text-gray-500">No moves yet</p>
              )}
              {grouped.map((g, gi) => (
                <motion.div
                  key={`${g.turn}-${gi}`}
                  initial={{ x: -10, opacity: 0 }}
                  animate={{ x: 0, opacity: 1 }}
                  transition={{ delay: gi * 0.03, duration: 0.25 }}
                  className={`rounded-lg border px-3 py-2 text-xs ${
                    g.userId === you?.userId
                      ? "border-[#34d399]/30 bg-[#34d399]/10"
                      : "border-[#f87171]/30 bg-[#f87171]/10"
                  }`}
                >
                  <div className="mb-1 flex items-center justify-between">
                    <span className="flex items-center gap-1.5">
                      <span className={`inline-block h-2 w-2 rounded-full ${
                        g.userId === you?.userId ? "bg-[#34d399]" : "bg-[#f87171]"
                      }`} />
                      <span className="font-bold text-white">{g.name}</span>
                      <span className="text-gray-400">Turn {g.turn}</span>
                    </span>
                  </div>

                  {g.actions.map((a, ai) => (
                    <div key={ai} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 pl-4 text-[11px] text-gray-300">
                      {/* Action type badge */}
                      <span className={`rounded px-1.5 py-0.5 font-semibold ${
                        a.action === "roll" ? "bg-[#fbbf24]/20 text-[#fbbf24]" :
                        a.action === "hold_dice" ? "bg-[#f5ff3b]/20 text-[#f5ff3b]" :
                        a.action === "choose_category" ? "bg-[#00e5ff]/20 text-[#00e5ff]" :
                        "bg-gray-800 text-gray-400"
                      }`}>
                        {a.action === "roll" ? <span className="inline-flex items-center gap-1"><IconDice size={12} /> Roll</span> :
                         a.action === "hold_dice" ? <span className="inline-flex items-center gap-1"><IconPin size={12} /> Hold</span> :
                         a.action === "choose_category" ? <span className="inline-flex items-center gap-1"><IconClipboardList size={12} /> Score</span> :
                         a.action === "game_start" ? <span className="inline-flex items-center gap-1"><IconFlag size={12} /> Start</span> :
                         a.action === "resign" ? <span className="inline-flex items-center gap-1"><IconFlag size={12} /> Resign</span> :
                         a.action || a.action}
                      </span>

                      {/* Dice values */}
                      {a.dice && Array.isArray(a.dice) && (
                        <span className="flex items-center gap-0.5 font-mono">
                          {a.dice.map((d: number, di: number) => (
                            <span key={di} className={`inline-flex h-4 w-4 items-center justify-center rounded-sm text-[9px] font-bold ${
                              a.heldDice?.[di] ? "bg-[#f5ff3b]/20 text-[#f5ff3b]" : "bg-white/10 text-white"
                            }`}>{d}</span>
                          ))}
                        </span>
                      )}

                      {/* Held dice indicator */}
                      {a.heldDice && Array.isArray(a.heldDice) && a.heldDice.some(Boolean) && (
                        <span className="text-[#f5ff3b]">
                          Held: {a.heldDice.map((h: boolean, hi: number) => h ? hi + 1 : null).filter((x: number|null) => x !== null).join(",")}
                        </span>
                      )}

                      {/* Category & score */}
                      {a.payload?.category && (
                        <span className="text-[#00e5ff]">
                          → {a.payload.category} {a.payload.score !== undefined ? `(+${a.payload.score})` : ""}
                        </span>
                      )}
                      {a.category && !a.payload?.category && (
                        <span className="text-[#00e5ff]">
                          → {a.category} {a.score !== undefined ? `(+${a.score})` : ""}
                        </span>
                      )}
                    </div>
                  ))}
                </motion.div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default function DiceFlushPage() {
  const { isSignedIn, user } = useUser();
  const [wager, setWager] = useState(100); const [balance, setBalance] = useState(0); const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<"pvp" | "ai">("pvp");
  const [joiningId, setJoiningId] = useState<string | null>(null); const [availableGames, setAvailableGames] = useState<LobbyRoom[]>([]);
  const [showRules, setShowRules] = useState(false);
  const firstVisitRules = useFirstVisitRules("dice-flush");
  useEffect(() => {
    if (firstVisitRules) setShowRules(true);
  }, [firstVisitRules]);
  const [roomId, setRoomId] = useState<string | null>(null); const [game, setGame] = useState<GameState | null>(null);
  const posthog = usePostHog();
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null); const [rolling, setRolling] = useState(false);
  const [aiCategoryHighlight, setAiCategoryHighlight] = useState<string | null>(null);
  const [moveHistory, setMoveHistory] = useState<any[]>([]);
  const [turnBanner, setTurnBanner] = useState<string | null>(null);
  const [exploding, setExploding] = useState(false);
  const [showReportModal, setShowReportModal] = useState(false);

  const [gameOverType, setGameOverType] = useState<"win" | "lose" | null>(null);
  const [gameOverScores, setGameOverScores] = useState<{ mine: number; theirs: number } | null>(null);
  const { socket } = useSocket();
  const [aiAnimating, setAiAnimating] = useState(false);
  const [aiRollSteps, setAiRollSteps] = useState<{ dice: number[]; heldDice: boolean[]; rollNum: number }[]>([]);
  const aiTurnScheduledRef = useRef(false);
  const aiUnmountedRef = useRef(false);

  // Cleanup on unmount
  useEffect(() => {
    aiUnmountedRef.current = false;
    return () => { aiUnmountedRef.current = true; };
  }, []);

  const prevTurnRef = useRef<string | null>(null);
  const prevGameStateRef = useRef<string | null>(null);
  const endedRef = useRef(false);

  const fetchBalance = async () => { if (!user) return; const r = await fetch("/api/get-user-tokens", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include" }); const d = await r.json(); if (d.success) setBalance(Number(d.data.balance || 0)); };
  const fetchGames = async () => { const res = await fetch("/api/dice-flush/state", { cache: "no-store" }); const data = await res.json(); if (data.success) setAvailableGames(data.rooms || []); };
  // Normalize old "yahtzee" scorecard keys → "fiveKind" for backward compat with pre-rebrand games
  const normalizeState = (gs: GameState | null): GameState | null => {
    if (!gs?.scorecards) return gs;
    for (const uid of Object.keys(gs.scorecards)) {
      const card = gs.scorecards[uid];
      if (card && "yahtzee" in card && !("fiveKind" in card)) {
        (card as any).fiveKind = (card as any).yahtzee;
        delete (card as any).yahtzee;
      }
    }
    return gs;
  };
  const fetchRoom = async (id: string) => { const res = await fetch(`/api/dice-flush/state?roomId=${encodeURIComponent(id)}`, { cache: "no-store" }); const data = await res.json(); if (data.success && data.room?.gameState) { setGame(normalizeState(data.room.gameState as GameState)); } };
  const fetchHistory = async (id: string) => { try { const res = await fetch(`/api/dice-flush/history?roomId=${encodeURIComponent(id)}`, { cache: "no-store" }); const data = await res.json(); if (data.success) setMoveHistory(data.actions || []); } catch {} };

  useEffect(() => { if (isSignedIn && user) fetchBalance(); fetchGames(); }, [isSignedIn, user]);

  // Socket room join — receive live updates from other players
  useEffect(() => {
    if (!socket || !roomId) return;

    const refresh = () => fetchRoom(roomId);
    socket.emit("join_room", { roomId });
    socket.on("game_state_update", refresh);

    return () => {
      socket.emit("leave_room", { roomId });
      socket.off("game_state_update", refresh);
    };
  }, [socket, roomId]);

  // Backup polling — slower fallback if a socket event is missed
  useEffect(() => {
    if (!roomId) return;
    const poll = async () => { await fetchRoom(roomId); await fetchHistory(roomId); };
    poll();
    const p = setInterval(poll, 5000);
    return () => clearInterval(p);
  }, [roomId]);

  const you = useMemo(() => game?.players?.find((p) => p.userId === user?.id) || null, [game, user?.id]);
  const opponent = useMemo(() => game?.players?.find((p) => p.userId !== user?.id) || null, [game, user?.id]);

  // Detect game finished and trigger celebration/defeat
  useEffect(() => {
    if (!game) return;
    if (endedRef.current) return;
    if (game.state !== "finished") {
      prevGameStateRef.current = game.state;
      return;
    }
    if (prevGameStateRef.current === "finished") return;
    prevGameStateRef.current = "finished";
    endedRef.current = true;

    if (!you || !opponent) return;
    const myTotal = sectionTotals(you.userId).total;
    const opTotal = sectionTotals(opponent.userId).total;
    setGameOverScores({ mine: myTotal, theirs: opTotal });

    if (myTotal >= opTotal) {
      setGameOverType("win");
      posthog?.capture("dice_flush_game_ended", { result: "win", bet_amount: game?.players?.[0]?.isAI ? (game as any)?.wager || wager : (game as any)?.wager || wager, mode: opponent?.isAI ? "ai" : "pvp", my_score: myTotal, opponent_score: opTotal });
      // Fire confetti cannon multiple times
      const fire = () => {
        confetti({
          particleCount: 80,
          spread: 100,
          origin: { x: Math.random(), y: 0.3 + Math.random() * 0.3 },
          colors: ["#f5ff3b","#00e5ff","#a855f7","#34d399","#fbbf24"],
        });
      };
      fire();
      const intervals = [200, 500, 900, 1400];
      intervals.forEach((delay) => setTimeout(fire, delay));

      // Big final burst
      setTimeout(() => {
        confetti({
          particleCount: 150,
          spread: 160,
          origin: { x: 0.5, y: 0.3 },
          colors: ["#f5ff3b","#00e5ff","#a855f7","#34d399","#fbbf24"],
        });
      }, 1800);
    } else {
      setGameOverType("lose");
    }
  }, [game, you, opponent]);

  // Turn change banner
  useEffect(() => {
    if (!game) return;
    const turn = game.currentTurn;
    if (prevTurnRef.current && prevTurnRef.current !== turn) {
      const isMe = turn === user?.id;
      setTurnBanner(isMe ? "YOUR TURN" : `${opponent?.name || "Opponent"}'s TURN`);
      setTimeout(() => setTurnBanner(null), 1800);
    }
    prevTurnRef.current = turn;
  }, [game?.currentTurn, game, user?.id, opponent?.name]);
  const isYourTurn = Boolean(game && you && game.currentTurn === you.userId);
  const waitingForOpponent = Boolean(game && game.players.length < 2 && game.state === "waiting");

  const sectionTotals = (pid?: string) => { const c = game?.scorecards?.[pid || ""] || {}; const upper = ["ones","twos","threes","fours","fives","sixes"].reduce((t, k) => t + (c[k] ?? 0), 0); const bonus = upper >= 63 ? 35 : 0; const total = Object.values(c).reduce((a, b) => a + (b || 0), 0) + bonus; return { upper, bonus, total }; };

  // Category progress (out of 13)
  const progress = (pid?: string) => {
    const c = game?.scorecards?.[pid || ""] || {};
    return Object.keys(c).filter(k => c[k] !== undefined).length;
  };

  // Extract last player and AI moves from history
  const lastMoves = useMemo(() => {
    const playerMoves = moveHistory.filter((a: any) => a.action === "choose_category" && a.userId === user?.id);
    const aiMoves = moveHistory.filter((a: any) => a.action === "choose_category" && a.userId !== user?.id);
    return {
      player: playerMoves.length > 0 ? playerMoves[playerMoves.length - 1] : null,
      ai: aiMoves.length > 0 ? aiMoves[aiMoves.length - 1] : null,
    };
  }, [moveHistory, user?.id]);
  const preview = (key: string) => (!game || !isYourTurn || game.rollsThisTurn < 1 || !you || game.scorecards?.[you.userId]?.[key] !== undefined ? null : scoreFor(game.dice, key));

  // ── AI turn animation ───────────────────────────────────────────
  const runAiTurnAnimation = async (rId: string) => {
    if (aiUnmountedRef.current) return;
    setAiAnimating(true);
    setAiRollSteps([]);
    
    // Wait a moment before AI starts
    await new Promise(r => setTimeout(r, 800));
    if (aiUnmountedRef.current) return;
    
    try {
      const res = await fetch("/api/dice-flush/ai-turn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roomId: rId }),
      });
      const d = await res.json();
      if (!d.success || aiUnmountedRef.current) {
        setAiAnimating(false);
        return;
      }
      
      // Animate through each AI roll
      if (d.rollSteps) {
        for (let i = 0; i < d.rollSteps.length; i++) {
          if (aiUnmountedRef.current) return;
          setAiRollSteps(prev => [...prev, d.rollSteps[i]]);
          await new Promise(r => setTimeout(r, 700));
        }
      }
      
      if (aiUnmountedRef.current) return;
      
      // Highlight AI's category choice
      if (d.aiCategory) {
        setAiCategoryHighlight(d.aiCategory);
        await new Promise(r => setTimeout(r, 900));
        if (aiUnmountedRef.current) return;
        setAiCategoryHighlight(null);
      }
      
      // Update game state and clear animation
      setGame(normalizeState(d.state));
      setAiRollSteps([]);
      setAiAnimating(false);
      aiTurnScheduledRef.current = false;
      emitRoomEvent();
      if (rId) fetchHistory(rId);
    } catch {
      setAiAnimating(false);
      setAiRollSteps([]);
      aiTurnScheduledRef.current = false;
    }
  };

  // Detect AI turn on game load (for polling/socket catch-up)
  useEffect(() => {
    if (!game || !roomId || aiAnimating || aiTurnScheduledRef.current) return;
    if (game.state !== "playing") return;
    const aiPlayer = game.players.find(p => p.isAI && p.userId === game.currentTurn);
    if (aiPlayer && !you?.isAI) {
      aiTurnScheduledRef.current = true;
      runAiTurnAnimation(roomId);
    }
  }, [game?.currentTurn, game?.turnNumber]);

  const createGame = async () => { if (wager <= 0 || wager > balance) return alert("Invalid wager amount"); setLoading(true); try { const res = await fetch("/api/dice-flush/create", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ wager }) }); const d = await res.json(); if (!res.ok || !d.success) return alert(d.error || "Unable to create room"); setRoomId(d.roomId); setGame(d.state); if (socket) socket.emit("join_room", { roomId: d.roomId });} finally { setLoading(false); } };
  const playAI = async () => { setLoading(true); try { const res = await fetch("/api/dice-flush/start-ai", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ wager, difficulty: "medium" }) }); const d = await res.json(); if (!res.ok || !d.success) return alert(d.error || "Unable"); setRoomId(d.roomId); setGame(d.state); posthog?.capture("dice_flush_game_started", { mode: "ai", wager: 0 }); if (socket) socket.emit("join_room", { roomId: d.roomId });} finally { setLoading(false); } };
  const joinGame = async (id: string) => { setLoading(true); setJoiningId(id); try { const res = await fetch("/api/dice-flush/join", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ roomId: id }) }); const d = await res.json(); if (!res.ok || !d.success) return alert(d.error || "Unable to join"); setRoomId(id); setGame(d.state); posthog?.capture("dice_flush_game_started", { mode: "pvp", wager: (d.state as any)?.wager || 0, game_id: id }); if (socket) { socket.emit("join_room", { roomId: id }); socket.emit("room_event", { roomId: id, event: "game_state_update" }); }} finally { setLoading(false); setJoiningId(null);} };
  const emitRoomEvent = () => {
    if (!socket || !roomId) return;
    socket.emit("room_event", { roomId, event: "game_state_update" });
  };
  const playAction = async (url: string, payload: Record<string, unknown>) => { if (!roomId || !isYourTurn) return; const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ roomId, ...payload }) }); const d = await res.json(); if (!res.ok || !d.success) return alert(d.error || "Action failed");
    setGame(normalizeState((d.state || d.finalState) as GameState));
    emitRoomEvent();
    fetchHistory(roomId);
  };
  const confirmPlay = async () => {
    if (!selectedCategory || !isYourTurn || !roomId) return;
    const cat = selectedCategory;
    setSelectedCategory(null);
    try {
      const res = await fetch("/api/dice-flush/choose-category", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roomId, category: cat }),
      });
      const d = await res.json();
      if (!res.ok || !d.success) {
        alert(d.error || "Failed");
        return;
      }
      setGame(normalizeState(d.state));
      emitRoomEvent();
      fetchHistory(roomId);
      setTimeout(() => setExploding(true), 300);
      setTimeout(() => setExploding(false), 1100);
      // If AI is next, trigger AI animation sequence
      if (d.aiNext) {
        aiTurnScheduledRef.current = true;
        runAiTurnAnimation(roomId);
      }
    } catch (e) {
      alert("Something went wrong");
    }
  };
  const resign = async () => { if (!roomId) return; const res = await fetch("/api/dice-flush/resign", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ roomId }) }); const d = await res.json(); if (!res.ok || !d.success) return alert(d.error || "Failed"); if (you && opponent) { const myTotal = sectionTotals(you.userId).total; const opTotal = sectionTotals(opponent.userId).total; endedRef.current = true; setGameOverScores({ mine: myTotal, theirs: opTotal }); setGameOverType("lose"); } else { resetToLobby(); } };
  const resetToLobby = () => {
    setRoomId(null);
    setGame(null);
    setGameOverType(null);
    setGameOverScores(null);
    setSelectedCategory(null);
    setRolling(false);
    endedRef.current = false;
    prevGameStateRef.current = null;
    fetchBalance();
    fetchGames();
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-[#030817] via-[#081a3d] to-[#003b8e] px-3 pb-24 pt-20 text-white"><NavigationBar currentPath="/casino" />
    <div className="mx-auto mt-4 max-w-5xl">
      {/* ────── TITLE ────── */}
      <motion.div
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        className="mb-2 text-center"
      >
        <motion.h1
          className="text-5xl font-black tracking-wider"
          animate={{ textShadow: ["0 0 20px rgba(245,255,59,0.4)", "0 0 40px rgba(245,255,59,0.6)", "0 0 20px rgba(245,255,59,0.4)"] }}
          transition={{ duration: 2, repeat: Infinity }}
        >
          <span className="text-[#f5ff3b]">DICE</span>{" "}
          <span className="text-[#00e5ff]">FLUSH</span>
        </motion.h1>
        <p className="mt-1 text-sm text-[#00e5ff]/60">Roll. Hold. Score. Dominate.</p>
      </motion.div>

      {/* How to Play — rules modal at the top of the lobby */}
      <div className="mb-5 text-center">
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
              heading: "Roll & hold",
              body: (
                <>
                  Roll 5 dice with up to 3 rolls per turn — hold the dice
                  you want to keep between rolls.
                </>
              ),
            },
            {
              heading: "Fill your scorecard",
              body: (
                <>
                  Each turn must be scored into an unused category:
                  three/four-of-a-kind, full house, straights, flush,
                  chance, and more.
                </>
              ),
            },
            {
              heading: "Win the match",
              body: (
                <>
                  After both players fill their scorecards, the higher
                  total wins the pot (minus the house fee). Play vs AI
                  free to practice.
                </>
              ),
            },
          ]}
          onClose={() => setShowRules(false)}
        />
      )}

      {!roomId && <div className="rounded-2xl border border-[#00e5ff]/30 bg-[#040d24]/80 p-4 backdrop-blur">
        <div className="mb-3 font-bold text-[#f5ff3b]">Balance: {balance.toFixed(2)} tokens</div>
        <div className="mb-3 grid grid-cols-2 gap-2">
          <button
            onClick={() => setMode("pvp")}
            className={`rounded-lg px-4 py-2 font-bold transition ${mode === "pvp" ? "bg-[#00e5ff] text-black shadow-[0_0_12px_rgba(0,229,255,0.35)]" : "bg-[#00e5ff]/10 border border-[#00e5ff]/30 text-[#00e5ff]"}`}
          >
            <span className="inline-flex items-center gap-1.5"><IconUsers size={16} /> PvP</span>
          </button>
          <button
            onClick={() => setMode("ai")}
            className={`rounded-lg px-4 py-2 font-bold transition ${mode === "ai" ? "bg-[#f5ff3b] text-black shadow-[0_0_12px_rgba(245,255,59,0.4)]" : "bg-[#f5ff3b]/10 border border-[#f5ff3b]/30 text-[#f5ff3b]"}`}
          >
            <span className="inline-flex items-center gap-1.5"><IconRobot size={16} /> vs AI</span>
          </button>
        </div>
        {mode === "pvp" ? (
          <div className="flex flex-wrap gap-2">
            <label htmlFor="dice-flush-wager" className="sr-only">Wager amount</label>
            <input id="dice-flush-wager" type="number" value={wager} onChange={(e) => setWager(Number(e.target.value || 0))} className="rounded-lg bg-[#08142f] border border-[#00e5ff]/30 px-3 py-2 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-[#00e5ff]" placeholder="Wager" />
            <button onClick={createGame} className="rounded-lg bg-[#00e5ff] px-4 py-2 font-bold text-black hover:bg-[#00e5ff]/80 transition">Create PvP</button>
            <button onClick={fetchGames} className="rounded-lg bg-[#a855f7] px-4 py-2 font-bold text-white hover:bg-[#a855f7]/80 transition">Refresh</button>
          </div>
        ) : (
          <>
            <div className="rounded-lg border border-[#f5ff3b]/40 bg-[#f5ff3b]/10 p-3 text-center">
              <p className="flex items-center justify-center gap-1.5 text-xs font-bold uppercase tracking-widest text-[#f5ff3b]"><IconDeviceGamepad2 size={14} /> Free Play</p>
              <p className="text-[10px] text-[#f5ff3b]/70 mt-1">No tokens are wagered. Playing vs AI is free.</p>
            </div>
            <button onClick={playAI} className="mt-3 w-full rounded-lg bg-[#f5ff3b] px-4 py-2 font-bold text-black hover:bg-[#f5ff3b]/80 transition">Play vs AI</button>
          </>
        )}
      <div className="mt-4 space-y-2">{availableGames.length === 0 ? <p className="text-gray-400 text-sm">No open games. Create one or play vs AI!</p> : availableGames.map((l) => <div key={l.id} className="flex items-center justify-between rounded-lg bg-[#08142f]/80 border border-[#00e5ff]/20 p-2"><span className="text-sm text-gray-300">{l.id} · {l.wager} tokens</span><button onClick={() => joinGame(l.id)} className="rounded-lg bg-[#00e5ff] px-3 py-1 text-sm font-bold text-black hover:bg-[#00e5ff]/80">{joiningId === l.id ? "Joining" : "Join"}</button></div>)}</div></div>}

      {game && (<div className="mt-6 rounded-2xl border border-[#00e5ff]/25 bg-[#040d24]/70 p-4 backdrop-blur">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold ${isYourTurn ? "bg-[#34d399]/20 text-[#34d399]" : "bg-[#fbbf24]/20 text-[#fbbf24]"}`}>
              <span className={`h-2 w-2 rounded-full ${isYourTurn ? "bg-[#34d399]" : "bg-[#fbbf24]"}`} />
              {isYourTurn ? "Your turn" : `${opponent?.name || "Opponent"}'s turn`}
            </span>
            <span className="text-xs text-gray-400">Rolls {game.rollsThisTurn}/3</span>
          </div>
          <div className="flex items-center gap-2">
            {opponent && !opponent.isAI && (<button onClick={() => setShowReportModal(true)} className="rounded-lg bg-red-500/10 border border-red-500/30 px-3 py-1 text-xs font-bold text-red-400 hover:bg-red-500/20 transition"><span className="inline-flex items-center gap-1"><IconFlag size={12} /> Report</span></button>)}
            <button onClick={resign} className="rounded-lg bg-red-600/80 px-3 py-1 text-xs font-bold text-white hover:bg-red-600 transition">Resign</button>
          </div>
        </div>
        {waitingForOpponent && <div className="mb-4 flex items-center gap-1.5 rounded-lg border border-[#f5ff3b]/30 bg-[#f5ff3b]/5 p-2 text-sm text-[#f5ff3b]"><IconHourglass size={14} /> Waiting for opponent to join. You cannot roll yet.</div>}

        {/* ═══════ DICE FLUSH SCORECARD ═══════ */}
<div className="mb-5 overflow-hidden rounded-[24px] border-2 border-[#00e5ff]/20 bg-gradient-to-b from-[#030817] to-[#0a1628] shadow-[0_0_40px_rgba(0,229,255,0.15)]">

  {/* ─── TOP: OPPONENT SECTION ─── */}
  <div className="border-b border-[#00e5ff]/10 bg-[#020812] px-4 py-3">
    <div className="mb-2 flex items-center justify-between">
      <div className="flex items-center gap-2">
        <div className="rounded-full bg-[#f87171]/20 border border-[#f87171]/30 px-3 py-1 text-sm font-black text-[#f87171]">
          {opponent?.name || "OPPONENT"}
        </div>
        <motion.div
          key={sectionTotals(opponent?.userId).total}
          animate={{ scale: [1, 1.15, 1] }}
          transition={{ duration: 0.4 }}
          className="rounded-full bg-white/5 px-3 py-1 text-xs font-bold text-white/80"
        >
          Total: {sectionTotals(opponent?.userId).total}
        </motion.div>
        {/* Opponent progress bar */}
        <div className="flex items-center gap-1.5 rounded-full bg-white/5 px-2.5 py-1">
          <div className="h-1.5 w-16 overflow-hidden rounded-full bg-white/10">
            <motion.div
              layout
              animate={{ width: `${(progress(opponent?.userId) / 13) * 100}%` }}
              transition={{ duration: 0.5, ease: "easeOut" }}
              className="h-full rounded-full bg-[#f87171]"
            />
          </div>
          <span className="text-[10px] font-bold text-white/60">{progress(opponent?.userId)}/13</span>
        </div>
      </div>
      <div className="rounded-xl bg-white/5 px-3 py-1 text-xs font-bold text-white/70">
        Rolls: {aiAnimating && aiRollSteps.length > 0 ? aiRollSteps[aiRollSteps.length - 1].rollNum : game.rollsThisTurn}/3
      </div>
    </div>
    <div className="flex justify-center gap-3">
      {(aiAnimating && aiRollSteps.length > 0
        ? aiRollSteps[aiRollSteps.length - 1].dice
        : game.dice
      ).map((d, i) => (
        <motion.div
          key={`op-${i}-${d}-${aiRollSteps.length}`}
          className="scale-90 opacity-80"
          initial={{ opacity: 0, y: -10 }}
          animate={{
            opacity: 0.8,
            y: 0,
            rotate: aiAnimating ? [0, 15 * ((i % 2 === 0) ? 1 : -1), -10, 5, 0] : 0,
          }}
          transition={{
            delay: i * 0.05,
            duration: aiAnimating ? 0.3 : 0.3,
            rotate: aiAnimating ? { duration: 0.25, repeat: Infinity } : {},
          }}
        >
          <DiceFace value={d} rolling={aiAnimating} index={i} />
        </motion.div>
      ))}
    </div>
  </div>

  {/* ─── LAST MOVE SUMMARY ─── */}
  {(lastMoves.player || lastMoves.ai) && (
    <div className="border-b border-[#00e5ff]/10 bg-[#020812]/50 px-4 py-2">        <div className="mb-1 flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-white/50">
        <IconBolt size={12} /> Last Move
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        {lastMoves.player && (
          <div className="flex items-center gap-2 rounded-lg bg-[#34d399]/10 border border-[#34d399]/20 px-2.5 py-1">
            <span className="font-bold text-[#34d399]">You</span>
            <span className="text-white/80">→ {lastMoves.player.payload?.category}</span>
            <span className="font-bold text-[#34d399]">+{lastMoves.player.payload?.score ?? "?"} pts</span>
          </div>
        )}
        {lastMoves.ai && (
          <div className="flex items-center gap-2 rounded-lg bg-[#f87171]/10 border border-[#f87171]/20 px-2.5 py-1">
            <span className="font-bold text-[#f87171]">{opponent?.name || "AI"}</span>
            <span className="text-white/80">→ {lastMoves.ai.payload?.category}</span>
            <span className="font-bold text-[#f87171]">+{lastMoves.ai.payload?.score ?? "?"} pts</span>
          </div>
        )}
        {!lastMoves.player && lastMoves.ai && (
          <div className="text-white/40">You haven't scored yet</div>
        )}
        {lastMoves.player && !lastMoves.ai && (
          <div className="text-white/40">AI hasn't scored yet</div>
        )}
      </div>
    </div>
  )}

  {/* ─── CENTER: SCORECARD ─── */}
  <div className="px-3 py-4">
    <div className="overflow-hidden rounded-xl border border-[#00e5ff]/15 bg-[#040d24]/60">
      {/* Header */}
      <div className="grid grid-cols-3 bg-[#00e5ff]/5 p-2 text-xs font-bold text-[#00e5ff]">
        <div>Category</div>
        <div className="text-[#f5ff3b]">{you?.name || "You"}</div>
        <div className="text-[#f87171]">{opponent?.name || "Opponent"}</div>
      </div>

      {/* Upper section — 1–6 */}
      {categories.slice(0, 6).map(([k, label]) => {
        const myVal = you ? game.scorecards?.[you.userId]?.[k] : undefined;
        const opVal = opponent ? game.scorecards?.[opponent.userId]?.[k] : undefined;
        const canPick = isYourTurn && myVal === undefined && game.rollsThisTurn > 0;
        const isAiPick = aiCategoryHighlight === k;
        return (
          <motion.button
            key={k}
            whileHover={canPick ? { scale: 1.02, backgroundColor: "rgba(245,255,59,0.08)" } : {}}
            onClick={() => canPick && setSelectedCategory(k)}
            animate={isAiPick ? { backgroundColor: ["rgba(245,255,59,0)", "rgba(245,255,59,0.2)", "rgba(245,255,59,0)"], scale: [1, 1.06, 1] } : {}}
            transition={isAiPick ? { duration: 0.8, ease: "easeInOut" } : {}}
            className={`grid w-full grid-cols-3 border-t border-[#00e5ff]/8 p-2 text-left text-xs transition-colors ${
              selectedCategory === k
                ? "bg-[#f5ff3b]/10 ring-1 ring-[#f5ff3b]/30 shadow-[inset_0_0_15px_rgba(245,255,59,0.15)]"
                : "hover:bg-white/3"
            } ${isAiPick ? "z-10 ring-2 ring-[#f5ff3b]/50" : ""}`}
          >
            <div className="text-white/80">{label}</div>
            <div className={myVal === undefined && preview(k) !== null ? "text-[#f5ff3b]/60 italic" : "text-[#f5ff3b]"}>
              {myVal !== undefined ? myVal : (preview(k) ?? "—")}
            </div>
            <div className="text-[#f87171]/80">
              {opVal ?? "—"}
            </div>
          </motion.button>
        );
      })}

      {/* Bonus row — 63-pt threshold */}
      <div className="grid grid-cols-3 border-t-2 border-[#f5ff3b]/30 bg-[#f5ff3b]/5 p-2 text-xs font-bold">
        <div className="text-[#f5ff3b]">Bonus (63+)</div>
        <motion.div
          key={`you-bonus-${sectionTotals(you?.userId).upper}`}
          animate={{ scale: [1, 1.1, 1] }}
          transition={{ duration: 0.4 }}
          className="text-[#f5ff3b]"
        >
          {sectionTotals(you?.userId).upper >= 63
            ? <span className="inline-flex items-center gap-1">+{sectionTotals(you?.userId).bonus} <IconCheck size={14} /></span>
            : `${sectionTotals(you?.userId).upper} / 63`}
        </motion.div>
        <motion.div
          key={`op-bonus-${sectionTotals(opponent?.userId).upper}`}
          animate={{ scale: [1, 1.1, 1] }}
          transition={{ duration: 0.4 }}
          className="text-[#f87171]/80"
        >
          {sectionTotals(opponent?.userId).upper >= 63
            ? <span className="inline-flex items-center gap-1">+{sectionTotals(opponent?.userId).bonus} <IconCheck size={14} /></span>
            : `${sectionTotals(opponent?.userId).upper} / 63`}
        </motion.div>
      </div>

      {/* Lower section — 3-Kind, 4-Kind, Full Hse, Sm Str, Lg Str, 5-Kind, Chance */}
      {categories.slice(6).map(([k, label]) => {
        const myVal = you ? game.scorecards?.[you.userId]?.[k] : undefined;
        const opVal = opponent ? game.scorecards?.[opponent.userId]?.[k] : undefined;
        const canPick = isYourTurn && myVal === undefined && game.rollsThisTurn > 0;
        const isAiPick = aiCategoryHighlight === k;
        return (
          <motion.button
            key={k}
            whileHover={canPick ? { scale: 1.02, backgroundColor: "rgba(245,255,59,0.08)" } : {}}
            onClick={() => canPick && setSelectedCategory(k)}
            animate={isAiPick ? { backgroundColor: ["rgba(245,255,59,0)", "rgba(245,255,59,0.2)", "rgba(245,255,59,0)"], scale: [1, 1.06, 1] } : {}}
            transition={isAiPick ? { duration: 0.8, ease: "easeInOut" } : {}}
            className={`grid w-full grid-cols-3 border-t border-[#00e5ff]/8 p-2 text-left text-xs transition-colors ${
              selectedCategory === k
                ? "bg-[#f5ff3b]/10 ring-1 ring-[#f5ff3b]/30 shadow-[inset_0_0_15px_rgba(245,255,59,0.15)]"
                : "hover:bg-white/3"
            } ${isAiPick ? "z-10 ring-2 ring-[#f5ff3b]/50" : ""}`}
          >
            <div className="text-white/80">{label}</div>
            <div className={myVal === undefined && preview(k) !== null ? "text-[#f5ff3b]/60 italic" : "text-[#f5ff3b]"}>
              {myVal !== undefined ? myVal : (preview(k) ?? "—")}
            </div>
            <div className="text-[#f87171]/80">
              {opVal ?? "—"}
            </div>
          </motion.button>
        );
      })}

      {/* Grand total row */}
      <div className="grid grid-cols-3 border-t-2 border-[#00e5ff]/30 bg-[#00e5ff]/5 p-2 text-sm font-black">
        <div className="text-[#00e5ff]">Total</div>
        <motion.div
          key={`you-total-${sectionTotals(you?.userId).total}`}
          animate={{ scale: [1, 1.15, 1] }}
          transition={{ duration: 0.4 }}
          className="text-[#f5ff3b]"
        >
          {sectionTotals(you?.userId).total}
        </motion.div>
        <motion.div
          key={`op-total-${sectionTotals(opponent?.userId).total}`}
          animate={{ scale: [1, 1.15, 1] }}
          transition={{ duration: 0.4 }}
          className="text-[#f87171]"
        >
          {sectionTotals(opponent?.userId).total}
        </motion.div>
      </div>
    </div>

    {/* ─── BUTTONS ─── */}
    <div className="mt-3 flex items-center justify-center gap-3">
      <button
        disabled={!isYourTurn || waitingForOpponent || aiAnimating}
        onClick={async () => {
          setRolling(true);
          await playAction("/api/dice-flush/roll", {});
          setTimeout(() => setRolling(false), 350);
        }}
        className="rounded-xl border-b-[3px] border-[#00e5ff]/40 bg-[#00e5ff] px-8 py-3 text-lg font-black text-black shadow-[0_0_20px_rgba(0,229,255,0.3)] transition active:translate-y-[1px] disabled:opacity-30 disabled:cursor-not-allowed hover:shadow-[0_0_30px_rgba(0,229,255,0.5)]"
      >
        ROLL
      </button>
      <motion.button
        disabled={!selectedCategory || !isYourTurn || aiAnimating}
        whileHover={selectedCategory && isYourTurn ? { scale: 1.05 } : {}}
        whileTap={{ scale: 0.95 }}
        onClick={confirmPlay}
        className="rounded-xl bg-gradient-to-r from-[#f5ff3b] to-[#fbbf24] px-6 py-3 font-black text-black shadow-[0_0_20px_rgba(245,255,59,0.3)] transition-all disabled:opacity-30 disabled:cursor-not-allowed hover:shadow-[0_0_30px_rgba(245,255,59,0.5)]"
      >
        {aiCategoryHighlight ? (
          <span className="flex items-center gap-2">
            <motion.span animate={{ rotate: 360 }} transition={{ duration: 1, repeat: Infinity, ease: "linear" }}><IconClipboardList size={16} /></motion.span>
            Scoring...
          </span>
        ) : (
          "Confirm Play"
        )}
      </motion.button>
    </div>

    {/* ─── Turn indicator ─── */}
    <div className="mt-3 text-center text-xs font-bold">
      {aiAnimating ? (
        <span className="flex items-center justify-center gap-2 text-[#fbbf24]">
          <motion.span animate={{ rotate: 360 }} transition={{ duration: 1, repeat: Infinity, ease: "linear" }}><IconRobot size={16} /></motion.span>
          AI thinking...
        </span>
      ) : isYourTurn ? (
        <span className="text-[#34d399]">YOUR TURN</span>
      ) : (
        <span className="text-[#fbbf24]">{opponent?.name || "Opponent"} TURN</span>
      )}
    </div>
  </div>

  {/* ─── BOTTOM: PLAYER SECTION ─── */}
  <div className="border-t border-[#00e5ff]/10 bg-[#020812] px-4 py-3">
    <div className="mb-2 flex items-center justify-between">
      <div className="flex items-center gap-2">
        <div className="rounded-full bg-[#34d399]/20 border border-[#34d399]/30 px-3 py-1 text-sm font-black text-[#34d399]">
          YOU
        </div>
        <motion.div
          key={sectionTotals(you?.userId).total}
          animate={{ scale: [1, 1.15, 1] }}
          transition={{ duration: 0.4 }}
          className="rounded-full bg-white/5 px-3 py-1 text-xs font-bold text-white/80"
        >
          Total: {sectionTotals(you?.userId).total}
        </motion.div>
        {/* Player progress bar */}
        <div className="flex items-center gap-1.5 rounded-full bg-white/5 px-2.5 py-1">
          <div className="h-1.5 w-16 overflow-hidden rounded-full bg-white/10">
            <motion.div
              layout
              animate={{ width: `${(progress(you?.userId) / 13) * 100}%` }}
              transition={{ duration: 0.5, ease: "easeOut" }}
              className="h-full rounded-full bg-[#34d399]"
            />
          </div>
          <span className="text-[10px] font-bold text-white/60">{progress(you?.userId)}/13</span>
        </div>
      </div>
      <div className="rounded-xl bg-white/5 px-3 py-1 text-xs font-bold text-white/60">
        Tap dice to hold
      </div>
    </div>

    {/* Player Dice */}
    <div className="flex flex-wrap justify-center gap-3">
      {game.dice.map((d, i) => {
          const diceUnknown = isYourTurn && game.rollsThisTurn === 0;
          return (
          <motion.button
          key={i}
          disabled={!isYourTurn || waitingForOpponent || aiAnimating || diceUnknown}
          whileHover={{ scale: 1.08 }}
          whileTap={{ scale: 0.95 }}
          onClick={() =>
            playAction("/api/dice-flush/hold", {
              heldDice: game.heldDice.map((v, idx) =>
                idx === i ? !v : v
              ),
            })
          }
        >
          <DiceFace
            value={d}
            held={game.heldDice[i]}
            rolling={rolling}
            index={i}
            unknown={diceUnknown}
          />
        </motion.button>
      )})}
    </div>
  </div>
</div>

        {/* ═══ MOVE HISTORY PANEL ═══ */}
        {moveHistory.length > 0 && <MoveHistoryPanel history={moveHistory} you={you} opponent={opponent} />}

        {/* Turn Banner Overlay */}
        <AnimatePresence>
          {turnBanner && (
            <motion.div
              key="turn-banner"
              initial={{ opacity: 0, y: -50, scale: 0.8 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -50, scale: 0.8 }}
              transition={{ type: "spring", stiffness: 300, damping: 20 }}
              className="fixed left-1/2 top-1/3 z-50 -translate-x-1/2 -translate-y-1/2 rounded-2xl border-2 border-[#f5ff3b]/40 bg-gradient-to-r from-[#030817] to-[#081a3d] px-10 py-6 shadow-[0_0_60px_rgba(245,255,59,0.3)] backdrop-blur"
            >
              <motion.div
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ delay: 0.15, type: "spring", stiffness: 400 }}
                className="text-center text-3xl font-black tracking-widest text-[#f5ff3b] drop-shadow-lg"
              >
                {turnBanner}
              </motion.div>
              <div className="mt-2 flex justify-center gap-1">
                {[0,1,2].map((i) => (
                  <motion.div
                    key={i}
                    className="h-2 w-2 rounded-full bg-[#f5ff3b]"
                    animate={{ scale: [1, 1.8, 1], opacity: [0.5, 1, 0.5] }}
                    transition={{ duration: 0.8, repeat: Infinity, delay: i * 0.2 }}
                  />
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Score Explosion Effect */}
        <AnimatePresence>
          {exploding && (
            <motion.div
              key="explosion"
              initial={{ opacity: 1, scale: 0.5 }}
              animate={{ opacity: 0, scale: 2.5 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.8, ease: "easeOut" }}
              className="pointer-events-none fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 text-6xl"
            >
              <span className="inline-flex items-center gap-2"><IconSparkles size={40} /><IconDice size={48} /><IconSparkles size={40} /></span>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ═══ GAME OVER OVERLAY ═══ */}
        <AnimatePresence>
          {gameOverType && gameOverScores && (
            <motion.div
              key="game-over"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.4 }}
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
            >
              <motion.div
                initial={{ scale: 0.6, opacity: 0, y: 40 }}
                animate={{ scale: 1, opacity: 1, y: 0 }}
                exit={{ scale: 0.6, opacity: 0, y: 40 }}
                transition={{ type: "spring", stiffness: 250, damping: 18, delay: 0.15 }}
                className={`relative mx-4 w-full max-w-md overflow-hidden rounded-[32px] border-2 p-6 text-center shadow-2xl ${
                  gameOverType === "win"
                    ? "border-[#f5ff3b]/40 bg-gradient-to-b from-[#081a3d] to-[#030817] shadow-[0_0_60px_rgba(245,255,59,0.2)]"
                    : "border-[#f87171]/30 bg-gradient-to-b from-[#1a0a0a] to-[#0d0505] shadow-[0_0_60px_rgba(248,113,113,0.15)]"
                }`}
              >
                {/* Winner trophy / Loser icon */}
                <motion.div
                  initial={{ scale: 0, rotate: -30 }}
                  animate={{ scale: 1, rotate: 0 }}
                  transition={{ type: "spring", stiffness: 300, damping: 12, delay: 0.3 }}
                  className="mb-2 text-7xl"
                >
                  {gameOverType === "win" ? <IconTrophy size={64} className="text-amber-400" /> : <IconSkull size={64} className="text-red-400" />}
                </motion.div>

                {/* Result text */}
                <motion.div
                  initial={{ y: 20, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  transition={{ delay: 0.5, duration: 0.4 }}
                >
                  <h2 className={`text-4xl font-black tracking-wider ${
                    gameOverType === "win" ? "text-[#f5ff3b]" : "text-[#f87171]"
                  }`}>
                    {gameOverType === "win" ? "YOU WIN!" : "YOU LOSE"}
                  </h2>
                </motion.div>

                {/* Final score comparison */}
                <motion.div
                  initial={{ y: 20, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  transition={{ delay: 0.7, duration: 0.4 }}
                  className="mt-4 flex items-center justify-center gap-6"
                >
                  {/* Your score */}
                  <div className="text-center">
                    <div className="text-xs font-bold uppercase text-gray-400">{you?.name || "You"}</div>
                    <motion.div
                      initial={{ scale: 0 }}
                      animate={{ scale: 1 }}
                      transition={{ delay: 0.9, type: "spring", stiffness: 300 }}
                      className={`mt-1 text-4xl font-black ${
                        gameOverScores.mine >= gameOverScores.theirs ? "text-[#f5ff3b]" : "text-gray-400"
                      }`}
                    >
                      {gameOverScores.mine}
                    </motion.div>
                  </div>

                  {/* VS divider */}
                  <div className="text-3xl font-black text-gray-500">VS</div>

                  {/* Opponent score */}
                  <div className="text-center">
                    <div className="text-xs font-bold uppercase text-gray-400">{opponent?.name || "Opponent"}</div>
                    <motion.div
                      initial={{ scale: 0 }}
                      animate={{ scale: 1 }}
                      transition={{ delay: 1.0, type: "spring", stiffness: 300 }}
                      className={`mt-1 text-4xl font-black ${
                        gameOverScores.theirs >= gameOverScores.mine ? "text-[#f5ff3b]" : "text-gray-400"
                      }`}
                    >
                      {gameOverScores.theirs}
                    </motion.div>
                  </div>
                </motion.div>

                {/* Winner sparkle lines / Loser fade message */}
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 1.2 }}
                  className="mt-4"
                >
                  {gameOverType === "win" ? (
                    <div className="flex justify-center gap-1">
                      {[0, 1, 2, 3, 4].map((i) => (
                        <motion.span
                          key={i}
                          animate={{ y: [0, -6, 0], opacity: [0.4, 1, 0.4] }}
                          transition={{ duration: 0.8, repeat: Infinity, delay: i * 0.12 }}
                        >
                          <IconSparkles size={20} className="text-amber-300" />
                        </motion.span>
                      ))}
                    </div>
                  ) : (
                    <motion.p
                      className="text-sm text-gray-400"
                      animate={{ opacity: [0.5, 1, 0.5] }}
                      transition={{ duration: 2, repeat: Infinity }}
                    >
                      Better luck next time!
                    </motion.p>
                  )}
                </motion.div>

                {/* Play Again button */}
                <motion.button
                  initial={{ y: 20, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  transition={{ delay: 1.4, duration: 0.4 }}
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                  onClick={resetToLobby}
                  className={`mt-6 rounded-2xl border-b-[3px] px-8 py-3 text-lg font-black transition active:translate-y-[2px] ${
                    gameOverType === "win"
                      ? "border-[#f5ff3b]/50 bg-[#f5ff3b] text-black shadow-[0_0_25px_rgba(245,255,59,0.4)]"
                      : "border-[#f87171]/50 bg-[#f87171] text-white shadow-[0_0_25px_rgba(248,113,113,0.3)]"
                  }`}
                >
                  Return to lobby
                </motion.button>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>)}
    </div>
      <ReportModal
        isOpen={showReportModal && !!opponent && !opponent.isAI}
        onClose={() => setShowReportModal(false)}
        onSubmit={async (reason, details) => {
          const res = await fetch("/api/reports/submit", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              reportedClerkId: opponent?.userId,
              gameType: "yahtzee",
              gameId: roomId,
              reason,
              details: details || undefined,
            }),
          });
          const data = await res.json();
          if (!data.success) throw new Error(data.error || "Failed to submit report");
        }}
        reportedPlayerName={opponent?.name || "Opponent"}
        gameType="Dice Flush"
      />
      <Footer />
    </div>
  );
}
