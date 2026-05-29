"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
// @ts-ignore: no types for canvas-confetti in this project
import confetti from "canvas-confetti";
import { useUser } from "@clerk/nextjs";
import { useSocket } from "../../../context/SocketProvider";
import NavigationBar from "../../../components/navigation-bar";
import Footer from "../../../components/Footer";
import {
  calculateScore,
  isFarkle,
  getScoringIndices,
} from "../../../../game-engine/farkleEngine";

/* ─── Types ─── */
type LobbyRoom = { id: string; wager: number; pot: number; status: string; createdAt: string };
type Player = { userId: string; name: string; isAI?: boolean; difficulty?: "easy" | "medium" | "hard" };
type FarkleGameState = {
  id: string;
  game: string;
  players: Player[];
  ai: boolean;
  wager: number;
  pot: number;
  state: "waiting" | "playing" | "finished";
  currentTurn: string;
  turnNumber: number;
  dice: number[];
  turnScore: number;
  hasMetThreshold: boolean;
  rollsThisTurn: number;
  scores: Record<string, number>;
  hasHotDice: boolean;
  difficulty?: "easy" | "medium" | "hard";
  finalRound: boolean;
  finalRoundStartedBy: string | null;
};

/* ─── Constants ─── */
const WINNING_SCORE = 10_000;
const MIN_BANK_THRESHOLD = 500;
const DICE_DOTS: Record<number, string[]> = {
  1: ["50% 50%"],
  2: ["30% 30%", "70% 70%"],
  3: ["30% 30%", "50% 50%", "70% 70%"],
  4: ["30% 30%", "70% 30%", "30% 70%", "70% 70%"],
  5: ["30% 30%", "70% 30%", "50% 50%", "30% 70%", "70% 70%"],
  6: ["30% 25%", "70% 25%", "30% 50%", "70% 50%", "30% 75%", "70% 75%"],
};


/* ─── DiceFace Component ─── */
const DiceFace = ({
  value,
  selected,
  rolling,
  index = 0,
}: {
  value: number;
  selected?: boolean;
  rolling?: boolean;
  index?: number;
}) => {
  return (
    <motion.div
      animate={
        rolling
          ? {
              rotate: [0, 15 * (index % 2 === 0 ? 1 : -1), -15, 8, -5, 0],
              x: [0, 3 * (index % 2 === 0 ? 1 : -1), -3, 2, -1, 0],
              y: [0, -4, -2, -6, -1, 0],
              scale: [1, 1.05, 0.95, 1.03, 0.98, 1],
            }
          : { rotate: 0, x: 0, y: 0, scale: 1 }
      }
      transition={{ duration: 0.25, repeat: rolling ? Infinity : 0, ease: "easeInOut" }}
      className={`relative h-16 w-16 rounded-2xl border-[3px] cursor-pointer select-none
        bg-gradient-to-br from-white to-gray-100 shadow-[0_6px_0_rgba(0,0,0,0.25)]
        ${selected ? "border-amber-400 ring-4 ring-amber-300/70 shadow-[0_0_20px_rgba(251,191,36,0.5)]" : "border-white hover:border-cyan-200"}
        ${rolling ? "shadow-[0_0_25px_rgba(34,211,238,0.6)]" : ""}
      `}
    >
      {DICE_DOTS[value]?.map((pos, i) => {
        const [left, top] = pos.split(" ");
        return (
          <motion.span
            key={i}
            className="absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full"
            style={{ left, top }}
            animate={{
              backgroundColor: selected ? ["#000", "#b45309", "#000"] : "#000",
              scale: rolling ? [1, 1.3, 1] : 1,
            }}
            transition={{ duration: 0.5, repeat: rolling ? Infinity : 0, delay: i * 0.08 }}
          />
        );
      })}
      {selected && (
        <motion.div
          className="absolute inset-0 rounded-2xl bg-amber-500/10"
          animate={{ opacity: [0.3, 0.6, 0.3] }}
          transition={{ duration: 1.5, repeat: Infinity }}
        />
      )}
    </motion.div>
  );
};

/* ─── Score Sheet Panel ─── */
const SCORE_SHEET = [
  { combo: "Each 1", points: 100, desc: "Per die showing 1" },
  { combo: "Each 5", points: 50, desc: "Per die showing 5" },
  { combo: "Three 1's", points: 300, desc: "Three dice showing 1" },
  { combo: "Three 2's", points: 200, desc: "Three dice showing 2" },
  { combo: "Three 3's", points: 300, desc: "Three dice showing 3" },
  { combo: "Three 4's", points: 400, desc: "Three dice showing 4" },
  { combo: "Three 5's", points: 500, desc: "Three dice showing 5" },
  { combo: "Three 6's", points: 600, desc: "Three dice showing 6" },
];

function ScoreSheetPanel() {
  const [open, setOpen] = useState(false);

  return (
    <div className="mb-5 overflow-hidden rounded-xl border border-amber-700/60 bg-black/30">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between px-4 py-2.5 text-sm font-bold text-amber-300 transition-colors hover:bg-white/5"
      >
        <span className="flex items-center gap-2">
          <span>📊</span>
          <span>Farkle Score Sheet</span>
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
            key="scoresheet"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3 }}
            className="overflow-hidden border-t border-amber-800/40"
          >
            <div className="max-h-72 overflow-y-auto p-3">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-amber-700/30 text-left text-amber-400">
                    <th className="pb-1.5 pr-2 font-bold">Combination</th>
                    <th className="pb-1.5 pr-2 text-right font-bold">Points</th>
                    <th className="hidden pb-1.5 sm:table-cell">Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {SCORE_SHEET.map((row, i) => (
                    <motion.tr
                      key={row.combo}
                      initial={{ x: -10, opacity: 0 }}
                      animate={{ x: 0, opacity: 1 }}
                      transition={{ delay: i * 0.03, duration: 0.2 }}
                      className="border-b border-amber-800/20 text-gray-300 hover:bg-amber-900/20"
                    >
                      <td className="py-1.5 pr-2 font-medium text-amber-200/80">{row.combo}</td>
                      <td className="py-1.5 pr-2 text-right font-bold text-amber-400">{row.points.toLocaleString()}</td>
                      <td className="hidden py-1.5 text-gray-500 sm:table-cell">{row.desc}</td>
                    </motion.tr>
                  ))}
                </tbody>
              </table>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ─── Game Log Panel ─── */
function GameLogPanel({
  history,
  you,
  opponent,
}: {
  history: any[];
  you: any;
  opponent: any;
}) {
  const [open, setOpen] = useState(false);
  const label = (userId: string) =>
    userId === you?.userId ? "You" : opponent?.name || "Opponent";

  return (
    <div className="mb-5 overflow-hidden rounded-xl border border-amber-700/60 bg-black/30">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between px-4 py-2.5 text-sm font-bold text-amber-300 transition-colors hover:bg-white/5"
      >
        <span className="flex items-center gap-2">
          <span>📜</span>
          <span>Game Log</span>
          <span className="rounded-full bg-amber-900/60 px-2 py-0.5 text-xs text-amber-400">
            {history.length}
          </span>
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
            key="log"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3 }}
            className="overflow-hidden border-t border-amber-800/40"
          >
            <div className="max-h-64 space-y-1 overflow-y-auto p-2">
              {history.length === 0 && (
                <p className="px-3 py-4 text-center text-xs text-gray-500">No actions yet</p>
              )}
              {history.map((a, i) => (
                <motion.div
                  key={i}
                  initial={{ x: -10, opacity: 0 }}
                  animate={{ x: 0, opacity: 1 }}
                  transition={{ delay: i * 0.02, duration: 0.2 }}
                  className={`rounded-lg border px-3 py-1.5 text-xs ${
                    a.userId === you?.userId
                      ? "border-green-700/40 bg-green-950/30"
                      : "border-red-700/40 bg-red-950/30"
                  }`}
                >
                  <span className="font-bold">{label(a.userId)}</span>{" "}
                  <span className="text-gray-300">
                    {a.actionType === "roll_dice" && "🎲 Rolled"}
                    {a.actionType === "select_scoring_dice" && `📌 Scored +${a.payload?.comboScore ?? "?"}`}
                    {a.actionType === "bank_score" && `🏦 Banked +${a.payload?.banked ?? "?"} → ${a.payload?.totalScore ?? "?"}`}
                    {a.actionType?.startsWith("ai_") && (
                      <>
                        {a.actionType === "ai_select" && `📌 Scored +${a.payload?.comboScore ?? "?"}`}
                        {a.actionType === "ai_roll" && "🎲 Rolled"}
                        {a.actionType === "ai_bank" && `🏦 Banked +${a.payload?.turnScore ?? "?"}`}
                        {a.actionType === "ai_farkle" && "💥 Farkle!"}
                        {a.actionType === "ai_hot_dice" && "🔥 Hot Dice!"}
                      </>
                    )}
                    {a.actionType === "resign" && "🚩 Resigned"}
                  </span>
                </motion.div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ─── Main Page ─── */
export default function FarklePage() {
  const { isSignedIn, user } = useUser();
  const { socket } = useSocket();
  const [wager, setWager] = useState(100);
  const [balance, setBalance] = useState(0);
  const [difficulty, setDifficulty] = useState<"easy" | "medium" | "hard">("medium");
  const [loading, setLoading] = useState(false);
  const [joiningId, setJoiningId] = useState<string | null>(null);
  const [availableGames, setAvailableGames] = useState<LobbyRoom[]>([]);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [game, setGame] = useState<FarkleGameState | null>(null);
  const [selectedIndices, setSelectedIndices] = useState<number[]>([]);
  const [rolling, setRolling] = useState(false);
  const [aiAnimating, setAiAnimating] = useState(false);
  const [aiSteps, setAiSteps] = useState<any[]>([]);
  const [currentAiStep, setCurrentAiStep] = useState(0);
  const [turnBanner, setTurnBanner] = useState<string | null>(null);
  const [gameOverType, setGameOverType] = useState<"win" | "lose" | null>(null);
  const [gameOverScores, setGameOverScores] = useState<{ mine: number; theirs: number } | null>(null);
  const [payout, setPayout] = useState(0);
  const [moveHistory, setMoveHistory] = useState<any[]>([]);
  const [exploding, setExploding] = useState(false);
  const [aiDifficultyLabel, setAiDifficultyLabel] = useState("medium");

  const prevTurnRef = useRef<string | null>(null);
  const endedRef = useRef(false);
  const aiTurnScheduledRef = useRef(false);
  const aiUnmountedRef = useRef(false);

  useEffect(() => {
    aiUnmountedRef.current = false;
    return () => {
      aiUnmountedRef.current = true;
    };
  }, []);

  /* ─── API Helpers ─── */
  const fetchBalance = async () => {
    if (!user) return;
    const r = await fetch("/api/get-user-tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
    });
    const d = await r.json();
    if (d.success) setBalance(Number(d.data.balance || 0));
  };

  const fetchGames = async () => {
    const res = await fetch("/api/farkle/state", { cache: "no-store" });
    const data = await res.json();
    if (data.success) setAvailableGames(data.rooms || []);
  };

  const fetchRoom = async (id: string) => {
    const res = await fetch(`/api/farkle/state?roomId=${encodeURIComponent(id)}`, {
      cache: "no-store",
    });
    const data = await res.json();
    if (data.success && data.room?.gameState) setGame(data.room.gameState as FarkleGameState);
  };

  const fetchHistory = async (id: string) => {
    try {
      const res = await fetch(`/api/farkle/history?roomId=${encodeURIComponent(id)}`, {
        cache: "no-store",
      });
      const data = await res.json();
      if (data.success) setMoveHistory(data.actions || []);
    } catch {}
  };

  useEffect(() => {
    if (isSignedIn && user) {
      fetchBalance();
      fetchGames();
    }
  }, [isSignedIn, user]);

  // Socket room join — receive live updates
  useEffect(() => {
    if (!socket || !roomId) return;

    socket.emit("join_room", { roomId });
    socket.on("game_state_update", () => fetchRoom(roomId));

    return () => {
      socket.emit("leave_room", { roomId });
      socket.off("game_state_update");
    };
  }, [socket, roomId]);

  // Backup polling for state
  useEffect(() => {
    if (!roomId) return;
    const poll = async () => {
      await fetchRoom(roomId);
      await fetchHistory(roomId);
    };
    poll();
    const p = setInterval(poll, 5000);
    return () => clearInterval(p);
  }, [roomId]);

  const emitRoomEvent = () => {
    if (!socket || !roomId) return;
    socket.emit("room_event", { roomId, event: "game_state_update" });
  };

  /* ─── Derived State ─── */
  const you = useMemo(() => game?.players?.find((p) => p.userId === user?.id) || null, [game, user?.id]);
  const opponent = useMemo(() => game?.players?.find((p) => p.userId !== user?.id) || null, [game, user?.id]);
  const isYourTurn = Boolean(game && you && game.currentTurn === you.userId);
  const waitingForOpponent = Boolean(game && game.players.length < 2 && game.state === "waiting");
  const isPvp = Boolean(game && !game.ai && game.players.length >= 2);
  const yourScore = game?.scores?.[you?.userId ?? ""] ?? 0;
  const opponentScore = game?.scores?.[opponent?.userId ?? ""] ?? 0;
  const scoreProgress = (score: number) => Math.min((score / WINNING_SCORE) * 100, 100);

  /* ─── Game Over Detection ─── */
  useEffect(() => {
    if (!game) return;
    if (endedRef.current) return;
    if (game.state !== "finished") return;
    endedRef.current = true;

    if (!you || !opponent) return;
    const mine = game.scores[you.userId] ?? 0;
    const theirs = game.scores[opponent.userId] ?? 0;
    setGameOverScores({ mine, theirs });

    if (mine >= theirs) {
      setGameOverType("win");
      const fire = () => {
        confetti({
          particleCount: 80,
          spread: 100,
          origin: { x: Math.random(), y: 0.3 + Math.random() * 0.3 },
          colors: ["#fbbf24", "#a855f7", "#22d3ee", "#f472b6", "#34d399"],
        });
      };
      fire();
      [200, 500, 900, 1400].forEach((d) => setTimeout(fire, d));
      setTimeout(() => {
        confetti({
          particleCount: 150,
          spread: 160,
          origin: { x: 0.5, y: 0.3 },
          colors: ["#fbbf24", "#a855f7", "#22d3ee", "#f472b6", "#34d399"],
        });
      }, 1800);
    } else {
      setGameOverType("lose");
    }
  }, [game?.state]);

  /* ─── Turn Banner ─── */
  useEffect(() => {
    if (!game) return;
    const turn = game.currentTurn;
    if (prevTurnRef.current && prevTurnRef.current !== turn) {
      const isMe = turn === user?.id;
      setTurnBanner(isMe ? "YOUR TURN" : `${opponent?.name || "Opponent"}'s TURN`);
      setTimeout(() => setTurnBanner(null), 1800);
    }
    prevTurnRef.current = turn;
  }, [game?.currentTurn, game?.turnNumber]);

  /* ─── Actions ─── */
  const createGame = async () => {
    if (wager <= 0 || wager > balance) return alert("Invalid wager amount");
    setLoading(true);
    try {
      const res = await fetch("/api/farkle/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wager }),
      });
      const d = await res.json();
      if (!res.ok || !d.success) return alert(d.error || "Unable to create room");
      setRoomId(d.roomId);
      setGame(d.state);
      if (socket) socket.emit("join_room", { roomId: d.roomId });
    } finally {
      setLoading(false);
    }
  };

  const playAI = async () => {
    setAiDifficultyLabel(difficulty);
    setLoading(true);
    try {
      const res = await fetch("/api/farkle/start-ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wager, difficulty }),
      });
      const d = await res.json();
      if (!res.ok || !d.success) return alert(d.error || "Unable to start");
      setRoomId(d.roomId);
      setGame(d.state);
      if (socket) socket.emit("join_room", { roomId: d.roomId });
    } finally {
      setLoading(false);
    }
  };

  const joinGame = async (id: string) => {
    setLoading(true);
    setJoiningId(id);
    try {
      const res = await fetch("/api/farkle/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roomId: id }),
      });
      const d = await res.json();
      if (!res.ok || !d.success) return alert(d.error || "Unable to join");
      setRoomId(id);
      setGame(d.state);
      if (socket) {
        socket.emit("join_room", { roomId: id });
        socket.emit("room_event", { roomId: id, event: "game_state_update" });
      }
    } finally {
      setLoading(false);
      setJoiningId(null);
    }
  };

  const rollDice = async () => {
    if (!roomId || !isYourTurn) return;
    setRolling(true);
    const indices = [...selectedIndices];
    // Keep selectedIndices visible during the roll — don't clear them yet
    try {
      const res = await fetch("/api/farkle/roll-dice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roomId, ...(indices.length > 0 ? { indices } : {}) }),
      });
      const d = await res.json();
      if (!res.ok || !d.success) {
        alert(d.error || "Roll failed");
        setRolling(false);
        return;
      }
      setTimeout(() => {
        setSelectedIndices([]);
        setGame(d.state);
        setRolling(false);
        emitRoomEvent();
        fetchHistory(roomId);
        if (indices.length > 0) {
          setExploding(true);
          setTimeout(() => setExploding(false), 800);
        }
      }, 400);
    } catch {
      setRolling(false);
      setSelectedIndices([]);
    }
  };

  const bankScore = async () => {
    if (!roomId || !isYourTurn) return;
    // Auto-select all scoring dice if the user hasn't manually selected any
    let indices = [...selectedIndices];
    if (indices.length === 0 && scoringIndices.length > 0) {
      indices = [...scoringIndices];
    }
    try {
      const res = await fetch("/api/farkle/bank-score", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roomId, ...(indices.length > 0 ? { indices } : {}) }),
      });
      const d = await res.json();
      if (!res.ok || !d.success) {
        alert(d.error || "Bank failed");
        return;
      }
      setSelectedIndices([]);
      setGame(d.state);
      emitRoomEvent();
      fetchHistory(roomId);
      // If AI is next, schedule AI turn
      if (d.aiNext && !d.ended) {
        aiTurnScheduledRef.current = true;
        triggerAiTurn(roomId);
      }
    } catch (e) {
      alert("Bank failed");
    }
  };

  const resign = async () => {
    if (!roomId) return;
    const res = await fetch("/api/farkle/resign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roomId }),
    });
    const d = await res.json();
    if (!res.ok || !d.success) return alert(d.error || "Failed");
    emitRoomEvent();
    setGame(d.state);
  };

  const resetToLobby = () => {
    if (socket && roomId) socket.emit("leave_room", { roomId });
    setRoomId(null);
    setGame(null);
    setGameOverType(null);
    setGameOverScores(null);
    setSelectedIndices([]);
    setRolling(false);
    setAiSteps([]);
    setCurrentAiStep(0);
    setAiAnimating(false);
    endedRef.current = false;
    aiTurnScheduledRef.current = false;
    fetchBalance();
    fetchGames();
  };

  /* ─── AI Turn ─── */
  const triggerAiTurn = async (rId: string) => {
    if (aiUnmountedRef.current) return;
    setAiAnimating(true);
    setAiSteps([]);
    setCurrentAiStep(0);

    await new Promise((r) => setTimeout(r, 800));
    if (aiUnmountedRef.current) return;

    try {
      const res = await fetch("/api/farkle/ai-turn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roomId: rId }),
      });
      const d = await res.json();
      if (!d.success || aiUnmountedRef.current) {
        setAiAnimating(false);
        return;
      }

      // Animate AI steps
      if (d.steps) {
        setAiSteps(d.steps);
        for (let i = 0; i < d.steps.length; i++) {
          if (aiUnmountedRef.current) return;
          setCurrentAiStep(i);
          await new Promise((r) => setTimeout(r, 600));
        }
      }

      if (aiUnmountedRef.current) return;

      // Update game
      setGame(d.state);
      emitRoomEvent();
      fetchHistory(rId);
      setAiAnimating(false);
      setAiSteps([]);
      setCurrentAiStep(0);
      aiTurnScheduledRef.current = false;
    } catch {
      setAiAnimating(false);
      aiTurnScheduledRef.current = false;
    }
  };

  // Detect AI turn from polling
  useEffect(() => {
    if (!game || !roomId || aiAnimating || aiTurnScheduledRef.current) return;
    if (game.state !== "playing") return;
    const aiPlayer = game.players.find((p) => p.isAI && p.userId === game.currentTurn);
    if (aiPlayer && !you?.isAI) {
      aiTurnScheduledRef.current = true;
      triggerAiTurn(roomId);
    }
  }, [game?.currentTurn, game?.turnNumber]);

  /* ─── Dice Selection ─── */
  const scoringIndices = useMemo(() => {
    if (!game || rolling) return [];
    return getScoringIndices(game.dice);
  }, [game?.dice, rolling]);

  const toggleDie = (index: number) => {
    if (!isYourTurn || rolling || aiAnimating) return;
    // Only allow selecting scoring dice, but allow unselecting any selected die
    if (!selectedIndices.includes(index) && !scoringIndices.includes(index)) return;
    setSelectedIndices((prev) =>
      prev.includes(index) ? prev.filter((i) => i !== index) : [...prev, index].sort((a, b) => a - b),
    );
  };

  const selectedScore = useMemo(() => {
    if (!game) return 0;
    const d = selectedIndices.map((i) => game.dice[i]);
    return calculateScore(d);
  }, [game?.dice, selectedIndices]);

  // Score of ALL scoring dice (used for auto-bank when no dice manually selected)
  const autoScore = useMemo(() => {
    if (!game) return 0;
    return calculateScore(game.dice);
  }, [game?.dice]);

  const clearSelection = () => setSelectedIndices([]);

  const isAllScoringSelected = useMemo(() => {
    if (!game) return false;
    return (
      selectedIndices.length > 0 &&
      selectedIndices.length === game.dice.length &&
      scoringIndices.length === game.dice.length
    );
  }, [selectedIndices, game?.dice, scoringIndices]);

  const canRoll =
    isYourTurn &&
    !rolling &&
    !aiAnimating &&
    game &&
    game.dice.length > 0 &&
    !waitingForOpponent &&
    (selectedIndices.length > 0 || scoringIndices.length === 0);

  // Effective score that would be banked: manual selection or auto-select all scoring dice
  const effectiveScore = selectedIndices.length > 0 ? selectedScore : autoScore;

  const canBank =
    isYourTurn &&
    !rolling &&
    !aiAnimating &&
    game &&
    (game.turnScore > 0 || effectiveScore > 0) &&
    (game.hasMetThreshold ||
      game.turnScore + effectiveScore >= MIN_BANK_THRESHOLD) &&
    !waitingForOpponent;

  const diffColor = (d: string) =>
    d === "easy" ? "text-green-400" : d === "medium" ? "text-yellow-400" : "text-red-400";

  return (
    <div className="min-h-screen bg-gradient-to-b from-[#0a0118] to-[#061b3d] px-3 pb-24 pt-20 text-white">
      <NavigationBar currentPath="/casino" />
      <div className="mx-auto mt-4 max-w-4xl">
        <motion.h1
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-2 text-center text-4xl font-black text-amber-400 drop-shadow-[0_0_15px_rgba(251,191,36,0.5)]"
        >
          🎲 FARKLE ARENA
        </motion.h1>

        {/* ═══ LOBBY ═══ */}
        {!roomId && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="rounded-2xl border border-amber-700/60 bg-black/40 p-6"
          >
            <div className="mb-4 text-center text-lg font-bold text-yellow-300">
              💰 Balance: {balance.toFixed(2)} tokens
            </div>

            {/* Wager Input */}
            <div className="mb-4">
              <label className="mb-1 block text-sm font-semibold text-amber-200">Wager Amount</label>
              <input
                type="number"
                value={wager}
                onChange={(e) => setWager(Number(e.target.value || 0))}
                className="w-full rounded-xl border border-amber-600/50 bg-slate-900 px-4 py-3 text-lg text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-amber-500"
                min={1}
              />
            </div>

            {/* AI Difficulty Selector */}
            <div className="mb-4">
              <label className="mb-2 block text-sm font-semibold text-amber-200">
                AI Difficulty
              </label>
              <div className="flex gap-2">
                {(["easy", "medium", "hard"] as const).map((d) => (
                  <button
                    key={d}
                    onClick={() => setDifficulty(d)}
                    className={`flex-1 rounded-xl border-2 px-4 py-2.5 text-sm font-bold transition-all duration-200 ${
                      difficulty === d
                        ? "border-amber-400 bg-amber-500/20 text-amber-300 shadow-[0_0_15px_rgba(251,191,36,0.3)]"
                        : "border-gray-600 bg-gray-800/50 text-gray-400 hover:border-amber-600/50"
                    }`}
                  >
                    {d === "easy" ? "🟢 Easy" : d === "medium" ? "🟡 Medium" : "🔴 Hard"}
                  </button>
                ))}
              </div>
              <p className="mt-1 text-xs text-gray-400">
                {difficulty === "easy" && "Conservative — banks early, plays it safe"}
                {difficulty === "medium" && "Balanced — pushes when ahead, banks when risky"}
                {difficulty === "hard" && "Aggressive — pushes luck, only banks when close to winning"}
              </p>
            </div>

            {/* Action Buttons */}
            <div className="mb-6 flex gap-3">
              <button
                onClick={createGame}
                disabled={loading}
                className="flex-1 rounded-2xl border-b-4 border-cyan-700 bg-cyan-500 px-6 py-3.5 text-lg font-black text-black shadow-[0_0_25px_rgba(34,211,238,0.4)] transition active:translate-y-[2px] disabled:opacity-50"
              >
                {loading ? "Starting..." : "Create PvP 🎲"}
              </button>
              <button
                onClick={playAI}
                disabled={loading}
                className="flex-1 rounded-2xl border-b-4 border-amber-700 bg-amber-500 px-6 py-3.5 text-lg font-black text-black shadow-[0_0_25px_rgba(251,191,36,0.4)] transition active:translate-y-[2px] disabled:opacity-50"
              >
                {loading ? "Starting..." : "Play vs AI 🤖"}
              </button>
              <button
                onClick={fetchGames}
                className="rounded-2xl border-b-4 border-gray-600 bg-gray-700 px-4 py-3.5 text-lg font-black text-white shadow-[0_0_15px_rgba(255,255,255,0.1)] transition active:translate-y-[2px]"
              >
                🔄
              </button>
            </div>

            {/* Rules Summary */}
            <div className="mb-5 rounded-lg border border-amber-800/30 bg-amber-950/20 p-3 text-xs text-amber-200/80">
              <p className="font-bold text-amber-300 mb-1">📋 Rules:</p>
              <ul className="list-inside list-disc space-y-0.5">
                <li>Roll 6 dice, select scoring dice each roll</li>
                <li>1s = 100 pts, 5s = 50 pts, Three 1s = 300, Three-of-a-kind = face × 100</li>
                <li>Score 500+ to bank. Farkle (no score) = lose turn points</li>
                <li>Hot dice (all 6 score) = re-roll all 6. First to {WINNING_SCORE.toLocaleString()} triggers final round!</li>
                <li>When a player reaches {WINNING_SCORE.toLocaleString()}, opponents get one last turn to beat it</li>
              </ul>
            </div>

            {/* Available Games */}
            <div>
              <h3 className="mb-3 text-lg font-bold text-cyan-300">🎮 Available Games</h3>
              {availableGames.length === 0 ? (
                <p className="text-center text-sm text-gray-500 py-8">No open games right now. Create one!</p>
              ) : (
                <div className="space-y-2">
                  {availableGames.map((l) => (
                    <div
                      key={l.id}
                      className="flex items-center justify-between rounded-xl bg-slate-900/80 p-3 border border-cyan-700/30"
                    >
                      <div>
                        <span className="text-sm text-gray-400 font-mono">
                          {l.id.slice(-12)}
                        </span>
                        <span className="ml-3 text-sm font-bold text-amber-300">
                          {l.wager} tokens
                        </span>
                      </div>
                      <button
                        onClick={() => joinGame(l.id)}
                        disabled={loading}
                        className="rounded-lg bg-cyan-500 px-4 py-2 text-sm font-bold text-black hover:bg-cyan-400 disabled:opacity-50"
                      >
                        {joiningId === l.id ? "Joining..." : "Join"}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </motion.div>
        )}

        {/* ═══ GAME BOARD ═══ */}
        {game && (
          <div className="mt-4 rounded-2xl border-2 border-amber-700/60 bg-black/45 p-4">
            {/* Top Bar */}
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span
                  className={`rounded-full px-3 py-1 text-sm font-bold ${
                    isYourTurn
                      ? "bg-green-600 text-white"
                      : "bg-gray-700 text-gray-300"
                  }`}
                >
                  {waitingForOpponent
                    ? "WAITING FOR OPPONENT..."
                    : isYourTurn
                      ? "YOUR TURN"
                      : `${opponent?.name || "AI"}'s TURN`}
                </span>
                {aiAnimating && (
                  <span className="flex items-center gap-1 rounded-full bg-yellow-800/50 px-2 py-1 text-xs text-yellow-300">
                    <motion.span
                      animate={{ rotate: 360 }}
                      transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
                    >
                      🤖
                    </motion.span>
                    AI thinking...
                  </span>
                )}
                {isPvp && (
                  <span className="rounded-full bg-purple-800/50 px-2 py-1 text-xs text-purple-300">
                    ⚔️ PvP
                  </span>
                )}
              </div>
              <button
                onClick={resign}
                className="rounded-lg bg-red-600/80 px-3 py-1 text-xs font-bold text-white hover:bg-red-600"
              >
                Resign
              </button>
            </div>

            {/* Final Round Alert */}
            {game.finalRound && game.state === "playing" && (
              <motion.div
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                className="mb-4 rounded-xl border border-purple-500/50 bg-purple-950/40 p-3 text-center"
              >
                <div className="text-sm font-bold text-purple-300">
                  🏁 FINAL ROUND — {" "}
                  {game.finalRoundStartedBy === you?.userId
                    ? "You reached " + WINNING_SCORE.toLocaleString() + "! Opponent gets one last turn."
                    : opponent?.name + " reached " + WINNING_SCORE.toLocaleString() + "! This is your last chance!"}
                </div>
              </motion.div>
            )}

            {/* Waiting for opponent alert */}
            {waitingForOpponent && (
              <div className="mb-4 rounded-xl border border-fuchsia-500/50 bg-fuchsia-950/40 p-4 text-center">
                <motion.div
                  animate={{ opacity: [0.5, 1, 0.5] }}
                  transition={{ duration: 1.5, repeat: Infinity }}
                  className="text-lg font-bold text-fuchsia-300"
                >
                  ⏳ Waiting for an opponent to join...
                </motion.div>
                <p className="mt-1 text-xs text-fuchsia-400/70">
                  Share this room or wait for another player to join from the lobby.
                </p>
                <p className="mt-2 text-xs font-mono text-gray-500">{game.id}</p>
              </div>
            )}

            {/* ═══ SCOREBOARD ═══ */}
            <div className="mb-4 overflow-hidden rounded-2xl border-4 border-amber-500 bg-gradient-to-b from-[#1a1a2e] to-[#16213e] shadow-[0_0_30px_rgba(251,191,36,0.3)]">
              {/* Title Bar */}
              <div className="bg-amber-900/60 px-4 py-2 text-center text-sm font-black text-amber-300">
                🏆 Race to {WINNING_SCORE.toLocaleString()} Points
              </div>

              {/* Player Scores */}
              <div className="grid grid-cols-2 divide-x divide-amber-700/50">
                {/* You */}
                <div className="p-4 text-center">
                  <div className="mb-1 text-xs font-bold uppercase text-green-400">
                    {you?.name || "You"}
                  </div>
                  <motion.div
                    key={yourScore}
                    animate={{ scale: [1, 1.2, 1] }}
                    transition={{ duration: 0.4 }}
                    className="text-3xl font-black text-green-300"
                  >
                    {yourScore.toLocaleString()}
                  </motion.div>
                  <div className="mt-2 h-2 overflow-hidden rounded-full bg-white/10">
                    <motion.div
                      animate={{ width: `${scoreProgress(yourScore)}%` }}
                      transition={{ duration: 0.5, ease: "easeOut" }}
                      className="h-full rounded-full bg-gradient-to-r from-green-500 to-emerald-400"
                    />
                  </div>
                  <div className="mt-0.5 text-[10px] text-gray-400">
                    {scoreProgress(yourScore).toFixed(0)}% to goal
                  </div>
                </div>

                {/* Opponent */}
                <div className="p-4 text-center">
                  <div className="mb-1 text-xs font-bold uppercase text-red-400">
                    {opponent?.name || "Opponent"}
                  </div>
                  {opponent?.isAI && (
                    <div className={`mb-1 text-[10px] font-semibold ${diffColor(aiDifficultyLabel)}`}>
                      {aiDifficultyLabel.toUpperCase()}
                    </div>
                  )}
                  <motion.div
                    key={opponentScore}
                    animate={{ scale: [1, 1.2, 1] }}
                    transition={{ duration: 0.4 }}
                    className="text-3xl font-black text-red-300"
                  >
                    {opponentScore.toLocaleString()}
                  </motion.div>
                  <div className="mt-2 h-2 overflow-hidden rounded-full bg-white/10">
                    <motion.div
                      animate={{ width: `${scoreProgress(opponentScore)}%` }}
                      transition={{ duration: 0.5, ease: "easeOut" }}
                      className="h-full rounded-full bg-gradient-to-r from-red-500 to-rose-400"
                    />
                  </div>
                  <div className="mt-0.5 text-[10px] text-gray-400">
                    {scoreProgress(opponentScore).toFixed(0)}% to goal
                  </div>
                </div>
              </div>

              {/* Turn Score / Status Bar */}
              <div className="border-t border-amber-700/50 bg-black/20 px-4 py-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-amber-200/80">
                    Turn Score:{" "}
                    <motion.span
                      key={game.turnScore}
                      animate={{ scale: [1, 1.3, 1] }}
                      className="font-black text-amber-400"
                    >
                      {game.turnScore}
                    </motion.span>
                    {game.hasHotDice && (
                      <span className="ml-2 rounded-full bg-orange-600/60 px-2 py-0.5 text-xs font-bold text-orange-200">
                        🔥 HOT DICE
                      </span>
                    )}
                    {game.finalRound && (
                      <span className="ml-2 rounded-full bg-purple-700/60 px-2 py-0.5 text-xs font-bold text-purple-200">
                        🏁 FINAL TURN
                      </span>
                    )}
                    {!game.hasMetThreshold && game.turnScore > 0 && (
                      <span className="ml-2 text-xs text-gray-400">
                        (need {MIN_BANK_THRESHOLD}+ to bank)
                      </span>
                    )}
                  </span>
                  <span className="text-xs text-gray-400">
                    Dice: {game.dice.length} | Turn #{game.turnNumber}
                  </span>
                </div>
              </div>
            </div>

            {/* ═══ AI/Opponent DISPLAY ═══ */}
            {!isYourTurn && game.state === "playing" && !waitingForOpponent && (
              <div className="mb-4 rounded-xl border border-gray-700/50 bg-black/20 p-3">
                <div className="mb-2 text-center text-xs font-bold text-gray-400 uppercase">
                  {opponent?.name || "AI"}'s Dice
                </div>
                <div className="flex flex-wrap justify-center gap-2">
                  {aiAnimating && aiSteps.length > 0 && currentAiStep < aiSteps.length
                    ? // Show AI step dice
                      (() => {
                        const step = aiSteps[currentAiStep];
                        const diceToShow = step.dice || step.selectedDice || game.dice;
                        return diceToShow.map((d: number, i: number) => (
                          <motion.div
                            key={`ai-${i}-${d}-${currentAiStep}`}
                            initial={{ opacity: 0, y: -10 }}
                            animate={{ opacity: 0.7, y: 0 }}
                            className="scale-90 opacity-70"
                          >
                            <DiceFace value={d} rolling={step.type === "roll"} index={i} />
                          </motion.div>
                        ));
                      })()
                    : game.dice.map((d, i) => (
                        <motion.div key={`ai-die-${i}`} className="scale-90 opacity-60">
                          <DiceFace value={d} index={i} />
                        </motion.div>
                      ))}
                </div>
                {aiAnimating && aiSteps.length > 0 && currentAiStep < aiSteps.length && (
                  <div className="mt-2 text-center text-xs text-yellow-300">
                    {aiSteps[currentAiStep]?.type === "select" && `Selected for +${aiSteps[currentAiStep].comboScore} pts`}
                    {aiSteps[currentAiStep]?.type === "roll" && `Rolling ${aiSteps[currentAiStep].remainingDice} dice...`}
                    {aiSteps[currentAiStep]?.type === "bank" && `Banking +${aiSteps[currentAiStep].turnScore} pts!`}
                    {aiSteps[currentAiStep]?.type === "farkle" && "FARKLE! Lost turn score!"}
                    {aiSteps[currentAiStep]?.type === "hot_dice" && "HOT DICE! All 6 score again!"}
                  </div>
                )}
              </div>
            )}

            {/* ═══ PLAYER DICE ═══ */}
            {isYourTurn && game.state === "playing" && !waitingForOpponent && (
              <div className="mb-4 flex flex-col gap-3 lg:flex-row">
                {/* ─── Side Box: Selected Dice ─── */}
                <div className="flex-shrink-0 lg:w-48">
                  <div className="rounded-2xl border-2 border-green-500/60 bg-green-950/30 p-3 shadow-[0_0_15px_rgba(34,197,94,0.2)]">
                    <div className="mb-2 flex items-center justify-between">
                      <span className="text-xs font-bold uppercase text-green-300">
                        📌 Selected Dice
                      </span>
                      {selectedIndices.length > 0 && (
                        <button
                          onClick={clearSelection}
                          className="rounded-md bg-red-500/20 px-2 py-0.5 text-[10px] font-bold text-red-300 hover:bg-red-500/40 transition-colors"
                        >
                          Clear
                        </button>
                      )}
                    </div>
                    {selectedIndices.length === 0 ? (
                      <div className="flex min-h-[80px] items-center justify-center text-xs text-gray-500">
                        Click scoring dice to add them here
                      </div>
                    ) : (
                      <div className="flex flex-wrap justify-center gap-2">
                        {selectedIndices.map((idx) => (
                          <motion.button
                            key={`side-${idx}`}
                            initial={{ scale: 0, opacity: 0 }}
                            animate={{ scale: 1, opacity: 1 }}
                            exit={{ scale: 0, opacity: 0 }}
                            whileHover={{ scale: 1.1 }}
                            whileTap={{ scale: 0.9 }}
                            onClick={() => toggleDie(idx)}
                            className="relative"
                          >
                            <DiceFace
                              value={game.dice[idx]}
                              selected={true}
                              index={idx}
                            />
                            <div className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-red-500 text-[10px] font-bold text-white shadow">
                              ✕
                            </div>
                          </motion.button>
                        ))}
                      </div>
                    )}
                    {/* Selected Score Preview */}
                    <div className="mt-2 rounded-lg bg-black/30 px-2 py-1 text-center">
                      <span className="text-xs text-green-400">
                        +{selectedScore > 0 ? selectedScore : 0} pts
                      </span>
                    </div>
                  </div>
                </div>                {/* ─── Main Dice Area ─── */}
                <div className="flex-1">
                  <div className="mb-2 text-center text-xs font-bold text-gray-400 uppercase">
                    Your Dice — Tap Scoring Dice to Select
                  </div>
                  <div className="flex flex-wrap justify-center gap-2">
                    {game.dice.map((d, i) => {
                      const isSelected = selectedIndices.includes(i);
                      const isScoring = scoringIndices.includes(i);
                      // Don't render selected dice in the main row — they live in the side box
                      if (isSelected) return null;
                      return (
                        <motion.button
                          key={`player-${i}-${d}`}
                          disabled={!isYourTurn || rolling || aiAnimating || !isScoring}
                          whileHover={isScoring ? { scale: 1.08 } : {}}
                          whileTap={isScoring ? { scale: 0.92 } : {}}
                          onClick={() => toggleDie(i)}
                          className={`relative rounded-2xl transition-all duration-200 ${
                            isScoring
                              ? "ring-2 ring-amber-400/80 shadow-[0_0_18px_rgba(251,191,36,0.5)]"
                              : "opacity-40 cursor-not-allowed"
                          }`}
                        >
                          <DiceFace
                            value={d}
                            selected={false}
                            rolling={rolling}
                            index={i}
                          />
                          {isScoring && (
                            <motion.div
                              className="absolute inset-0 rounded-2xl bg-amber-400/10"
                              animate={{ opacity: [0.2, 0.5, 0.2] }}
                              transition={{ duration: 1.5, repeat: Infinity }}
                            />
                          )}
                        </motion.button>
                      );
                    })}
                    {/* Show message when all dice have been selected */}
                    {game.dice.length > 0 && game.dice.every((_, i) => selectedIndices.includes(i)) && (
                      <p className="w-full text-center text-xs text-green-400 mt-2">
                        ✅ All dice selected — roll or bank!
                      </p>
                    )}
                  </div>

                  {/* No scoring dice left warning */}
                  {game.dice.length > 0 && scoringIndices.length === 0 && !rolling && (
                    <motion.div
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="mt-3 rounded-lg border border-red-600/50 bg-red-900/20 p-3 text-center"
                    >
                      <p className="text-sm font-bold text-red-400">
                        ⚠️ No scoring dice available — you must roll or bank!
                      </p>
                    </motion.div>
                  )}

                  {/* Initial Farkle Warning — only when no dice selected yet */}
                  {game.dice.length > 0 &&
                    isFarkle(game.dice) &&
                    !rolling &&
                    selectedIndices.length === 0 &&
                    game.turnScore > 0 && (
                      <motion.div
                        initial={{ opacity: 0, scale: 0.8 }}
                        animate={{ opacity: 1, scale: 1 }}
                        className="mt-2 text-center font-bold text-red-400"
                      >
                        💥 FARKLE! No scoring dice — you lose your turn score!
                      </motion.div>
                    )}
                </div>
              </div>
            )}

            {/* ═══ ACTION BUTTONS ═══ */}
            {isYourTurn && game.state === "playing" && !waitingForOpponent && (
              <div className="flex flex-wrap justify-center gap-3">
                {/* Roll Dice */}
                <motion.button
                  disabled={!canRoll || rolling}
                  whileHover={canRoll ? { scale: 1.05 } : {}}
                  whileTap={{ scale: 0.95 }}
                  onClick={rollDice}
                  className="rounded-xl border-b-4 border-cyan-700 bg-cyan-500 px-6 py-3 font-black text-black shadow-[0_0_15px_rgba(34,211,238,0.4)] transition disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  🎲 {isAllScoringSelected ? "🔥 Hot Dice! Roll All 6" : game.hasHotDice ? "Roll All 6" : `Roll ${game.dice.length} Dice`}
                  {selectedIndices.length > 0 && (
                    <span className="ml-1 text-xs opacity-80">
                      (score +{selectedScore})
                    </span>
                  )}
                </motion.button>

                {/* Bank Score */}
                <motion.button
                  disabled={!canBank}
                  whileHover={canBank ? { scale: 1.05 } : {}}
                  whileTap={{ scale: 0.95 }}
                  onClick={bankScore}
                  className="rounded-xl border-b-4 border-green-700 bg-green-500 px-6 py-3 font-black text-white shadow-[0_0_15px_rgba(34,197,94,0.4)] transition disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  🏦 Bank +{game.turnScore + effectiveScore}
                </motion.button>
              </div>
            )}

            {/* ═══ SCORE SHEET ═══ */}
            <div className="mt-4">
              <ScoreSheetPanel />
            </div>

            {/* ═══ GAME LOG ═══ */}
            {moveHistory.length > 0 && (
              <div className="mt-4">
                <GameLogPanel history={moveHistory} you={you} opponent={opponent} />
              </div>
            )}

            {/* ═══ TURN BANNER ═══ */}
            <AnimatePresence>
              {turnBanner && (
                <motion.div
                  key="turn-banner"
                  initial={{ opacity: 0, y: -50, scale: 0.8 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -50, scale: 0.8 }}
                  transition={{ type: "spring", stiffness: 300, damping: 20 }}
                  className="fixed left-1/2 top-1/3 z-50 -translate-x-1/2 -translate-y-1/2 rounded-2xl border-4 border-amber-400 bg-gradient-to-r from-amber-700 to-orange-700 px-10 py-6 shadow-[0_0_60px_rgba(251,191,36,0.5)]"
                >
                  <motion.div
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    transition={{ delay: 0.15, type: "spring", stiffness: 400 }}
                    className="text-center text-3xl font-black tracking-widest text-white drop-shadow-lg"
                  >
                    {turnBanner}
                  </motion.div>
                  <div className="mt-2 flex justify-center gap-1">
                    {[0, 1, 2].map((i) => (
                      <motion.div
                        key={i}
                        className="h-2 w-2 rounded-full bg-amber-300"
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
                  ✨🎲✨
                </motion.div>
              )}
            </AnimatePresence>

            {/* ═══ GAME OVER MODAL ═══ */}
            <AnimatePresence>
              {gameOverType && gameOverScores && (
                <motion.div
                  key="game-over"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
                >
                  <motion.div
                    initial={{ scale: 0.6, opacity: 0, y: 40 }}
                    animate={{ scale: 1, opacity: 1, y: 0 }}
                    exit={{ scale: 0.6, opacity: 0, y: 40 }}
                    transition={{ type: "spring", stiffness: 250, damping: 18, delay: 0.15 }}
                    className={`relative mx-4 w-full max-w-md overflow-hidden rounded-[32px] border-4 p-6 text-center shadow-2xl ${
                      gameOverType === "win"
                        ? "border-amber-400 bg-gradient-to-b from-[#1a3a1a] to-[#0d2b0d] shadow-[0_0_60px_rgba(251,191,36,0.4)]"
                        : "border-red-500 bg-gradient-to-b from-[#3a1a1a] to-[#2b0d0d] shadow-[0_0_60px_rgba(239,68,68,0.3)]"
                    }`}
                  >
                    <motion.div
                      initial={{ scale: 0, rotate: -30 }}
                      animate={{ scale: 1, rotate: 0 }}
                      transition={{ type: "spring", stiffness: 300, damping: 12, delay: 0.3 }}
                      className="mb-2 text-7xl"
                    >
                      {gameOverType === "win" ? "🏆" : "💀"}
                    </motion.div>

                    <motion.div
                      initial={{ y: 20, opacity: 0 }}
                      animate={{ y: 0, opacity: 1 }}
                      transition={{ delay: 0.5, duration: 0.4 }}
                    >
                      <h2
                        className={`text-4xl font-black tracking-wider ${
                          gameOverType === "win" ? "text-amber-300" : "text-red-400"
                        }`}
                      >
                        {gameOverType === "win" ? "YOU WIN!" : "YOU LOSE"}
                      </h2>
                    </motion.div>

                    {/* Score Comparison */}
                    <motion.div
                      initial={{ y: 20, opacity: 0 }}
                      animate={{ y: 0, opacity: 1 }}
                      transition={{ delay: 0.7, duration: 0.4 }}
                      className="mt-4 flex items-center justify-center gap-6"
                    >
                      <div className="text-center">
                        <div className="text-xs font-bold uppercase text-gray-400">
                          {you?.name || "You"}
                        </div>
                        <motion.div
                          initial={{ scale: 0 }}
                          animate={{ scale: 1 }}
                          transition={{ delay: 0.9, type: "spring", stiffness: 300 }}
                          className={`mt-1 text-4xl font-black ${
                            gameOverScores.mine >= gameOverScores.theirs ? "text-amber-300" : "text-gray-400"
                          }`}
                        >
                          {gameOverScores.mine.toLocaleString()}
                        </motion.div>
                      </div>
                      <div className="text-3xl font-black text-gray-500">VS</div>
                      <div className="text-center">
                        <div className="text-xs font-bold uppercase text-gray-400">
                          {opponent?.name || "AI"}
                        </div>
                        <motion.div
                          initial={{ scale: 0 }}
                          animate={{ scale: 1 }}
                          transition={{ delay: 1.0, type: "spring", stiffness: 300 }}
                          className={`mt-1 text-4xl font-black ${
                            gameOverScores.theirs >= gameOverScores.mine ? "text-amber-300" : "text-gray-400"
                          }`}
                        >
                          {gameOverScores.theirs.toLocaleString()}
                        </motion.div>
                      </div>
                    </motion.div>

                    <motion.div
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ delay: 1.2 }}
                      className="mt-4"
                    >
                      {gameOverType === "win" ? (
                        <div className="flex justify-center gap-1">
                          {["✨", "🌟", "✨", "🌟", "✨"].map((s, i) => (
                            <motion.span
                              key={i}
                              className="text-xl"
                              animate={{ y: [0, -6, 0], opacity: [0.4, 1, 0.4] }}
                              transition={{ duration: 0.8, repeat: Infinity, delay: i * 0.12 }}
                            >
                              {s}
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

                    <motion.button
                      initial={{ y: 20, opacity: 0 }}
                      animate={{ y: 0, opacity: 1 }}
                      transition={{ delay: 1.4, duration: 0.4 }}
                      whileHover={{ scale: 1.05 }}
                      whileTap={{ scale: 0.95 }}
                      onClick={resetToLobby}
                      className={`mt-6 rounded-2xl border-b-4 px-8 py-3 text-lg font-black transition active:translate-y-[2px] ${
                        gameOverType === "win"
                          ? "border-amber-700 bg-amber-400 text-black shadow-[0_0_25px_rgba(251,191,36,0.5)]"
                          : "border-red-700 bg-red-500 text-white shadow-[0_0_25px_rgba(239,68,68,0.4)]"
                      }`}
                    >
                      Return to lobby
                    </motion.button>
                  </motion.div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}
      </div>
      <Footer />
    </div>
  );
}
