"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
// @ts-ignore: no types for canvas-confetti in this project
import confetti from "canvas-confetti";
import { useUser } from "@clerk/nextjs";
import { usePostHog } from "posthog-js/react";
import { useSocket } from "../../../context/SocketProvider";
import { useTranslation } from "../../../hooks/useTranslation";
import NavigationBar from "../../../components/navigation-bar";
import Footer from "../../../components/Footer";
import ReportModal from "../../../components/ReportModal";
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
  rollsThisTurn: number;
  scores: Record<string, number>;
  hasHotDice: boolean;
  difficulty?: "easy" | "medium" | "hard";
  winnerId?: string;
};

/* ─── Constants ─── */
const WINNING_SCORE = 10_000;
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
  unknown = false,
}: {
  value: number;
  selected?: boolean;
  rolling?: boolean;
  index?: number;
  unknown?: boolean;
}) => {
  if (unknown) {
    return (
      <motion.div
        animate={{ opacity: [0.4, 0.7, 0.4] }}
        transition={{ duration: 1.5, repeat: Infinity }}
        className="relative h-16 w-16 rounded-2xl border-[3px] cursor-not-allowed
          bg-gradient-to-br from-gray-700 to-gray-800
          border-gray-500 shadow-[0_6px_0_rgba(0,0,0,0.25)]
          select-none flex items-center justify-center"
      >
        <motion.span
          animate={{ scale: [1, 1.15, 1] }}
          transition={{ duration: 1, repeat: Infinity }}
          className="text-3xl font-black text-gray-400"
        >
          ?
        </motion.span>
      </motion.div>
    );
  }

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
  { combo: "Three 1's", points: 1000, desc: "Three dice showing 1" },
  { combo: "Three 2's", points: 200, desc: "Three dice showing 2" },
  { combo: "Three 3's", points: 300, desc: "Three dice showing 3" },
  { combo: "Three 4's", points: 400, desc: "Three dice showing 4" },
  { combo: "Three 5's", points: 500, desc: "Three dice showing 5" },
  { combo: "Three 6's", points: 600, desc: "Three dice showing 6" },
  { combo: "Four of a Kind", points: 1000, desc: "Four dice of the same value" },
  { combo: "Five of a Kind", points: 2000, desc: "Five dice of the same value" },
  { combo: "Six of a Kind", points: 3000, desc: "Six dice of the same value" },
  { combo: "Three Pairs", points: 1500, desc: "Three pairs (incl. 4-of-a-kind + pair)" },
  { combo: "Straight (1-6)", points: 2500, desc: "One of each die (1,2,3,4,5,6)" },
];

function ScoreSheetPanel() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  return (
    <div className="mb-5 overflow-hidden rounded-xl border border-amber-700/60 bg-black/30">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between px-4 py-2.5 text-sm font-bold text-amber-300 transition-colors hover:bg-white/5"
      >
        <span className="flex items-center gap-2">
          <span>📊</span>
          <span>{t("games.farkle.score_sheet")}</span>
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
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const label = (userId: string) =>
    userId === you?.userId ? t("games.farkle.you_label") : opponent?.name || t("games.farkle.opponent_label");

  return (
    <div className="mb-5 overflow-hidden rounded-xl border border-amber-700/60 bg-black/30">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between px-4 py-2.5 text-sm font-bold text-amber-300 transition-colors hover:bg-white/5"
      >
        <span className="flex items-center gap-2">
          <span>📜</span>
          <span>{t("games.farkle.game_log")}</span>
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
                <p className="px-3 py-4 text-center text-xs text-gray-500">{t("games.farkle.no_actions")}</p>
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
                    {a.actionType === "roll_dice" && t("games.farkle.log_rolled")}
                    {a.actionType === "select_scoring_dice" && `${t("games.farkle.log_scored")}${a.payload?.comboScore ?? "?"}`}
                    {a.actionType === "bank_score" && `${t("games.farkle.log_banked")}${a.payload?.banked ?? "?"} → ${a.payload?.totalScore ?? "?"}`}
                    {a.actionType?.startsWith("ai_") && (
                      <>
                        {a.actionType === "ai_select" && `${t("games.farkle.log_scored")}${a.payload?.comboScore ?? "?"}`}
                        {a.actionType === "ai_roll" && t("games.farkle.log_rolled")}
                        {a.actionType === "ai_bank" && `${t("games.farkle.log_banked")}${a.payload?.turnScore ?? "?"}`}
                        {a.actionType === "ai_farkle" && t("games.farkle.log_farkle")}
                        {a.actionType === "ai_hot_dice" && t("games.farkle.log_hot_dice")}
                      </>
                    )}
                    {a.actionType === "resign" && t("games.farkle.log_resigned")}
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
  const { t } = useTranslation();
  const [wager, setWager] = useState(100);
  const [balance, setBalance] = useState(0);
  const [difficulty, setDifficulty] = useState<"easy" | "medium" | "hard">("medium");
  const [loading, setLoading] = useState(false);
  const [banking, setBanking] = useState(false);
  const [resigning, setResigning] = useState(false);
  const [joiningId, setJoiningId] = useState<string | null>(null);
  const [availableGames, setAvailableGames] = useState<LobbyRoom[]>([]);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [game, setGame] = useState<FarkleGameState | null>(null);
  const posthog = usePostHog();
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
  // Track dice that were scored in each roll this turn (for visual display)
  const [scoredDiceHistory, setScoredDiceHistory] = useState<number[][]>([]);
  // Smooth counting animation for turnScore
  const [displayedTurnScore, setDisplayedTurnScore] = useState(0);
  // Flash/glow effects
  const [bankFlash, setBankFlash] = useState(false);
  const [rollFlash, setRollFlash] = useState(false);
  const [bankCelebrating, setBankCelebrating] = useState(false);
  const [hotDiceFlash, setHotDiceFlash] = useState(false);
  const [showReportModal, setShowReportModal] = useState(false);

  const prevTurnRef = useRef<string | null>(null);
  const prevCanBankRef = useRef(false);
  const prevCanRollRef = useRef(false);
  const prevHasHotDiceRef = useRef(false);
  const endedRef = useRef(false);
  const aiTurnScheduledRef = useRef(false);
  const aiUnmountedRef = useRef(false);
  const gameStateRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    aiUnmountedRef.current = false;
    return () => {
      aiUnmountedRef.current = true;
    };
  }, []);

  // Smooth count-up/down animation for turnScore
  useEffect(() => {
    const target = game?.turnScore ?? 0;
    const start = displayedTurnScore;
    if (start === target) return;

    const duration = 400; // ms
    const startTime = performance.now();
    let raf: number;

    const animate = (now: number) => {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      // Ease out cubic
      const eased = 1 - Math.pow(1 - progress, 3);
      const current = Math.round(start + (target - start) * eased);
      setDisplayedTurnScore(current);

      if (progress < 1) {
        raf = requestAnimationFrame(animate);
      }
    };

    raf = requestAnimationFrame(animate);

    return () => {
      if (raf) cancelAnimationFrame(raf);
    };
  }, [game?.turnScore]);

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
  }, [socket, roomId]);    // Sync gameStateRef for polling guard
  useEffect(() => {
    gameStateRef.current = game?.state;
  }, [game?.state]);

  useEffect(() => {
    if (!roomId) return;
    const poll = async () => {
      // Skip polling if game has ended
      if (gameStateRef.current === "finished") return;
      await fetchRoom(roomId);
      await fetchHistory(roomId);
    };
    poll();
    // Faster polling for better sync — reduced from 5000ms to 1500ms
    const p = setInterval(poll, 1500);
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

  const showGameOver = useCallback(
    (finishedGame: FarkleGameState, forcedType?: "win" | "lose") => {
      if (!you || !opponent) return;

      const mine = finishedGame.scores[you.userId] ?? 0;
      const theirs = finishedGame.scores[opponent.userId] ?? 0;
      setGameOverScores({ mine, theirs });

      // Use winnerId if present (set by resign and normal game end),
      // otherwise fall back to score comparison.
      const didWin = forcedType
        ? forcedType === "win"
        : finishedGame.winnerId
          ? finishedGame.winnerId === you.userId
          : mine >= theirs;

      if (didWin) {
        setGameOverType("win");
        posthog?.capture("farkle_game_ended", { result: "win", bet_amount: finishedGame.wager || 0, mode: finishedGame.ai ? "ai" : "pvp", my_score: mine, opponent_score: theirs });
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
    },
    [opponent, you],
  );

  /* ─── Game Over Detection ─── */
  useEffect(() => {
    if (!game) return;
    if (endedRef.current) return;
    if (game.state !== "finished") return;
    if (!you || !opponent) return;

    endedRef.current = true;
    showGameOver(game);
  }, [game, opponent, showGameOver, you]);

  /* ─── Turn Banner ─── */
  useEffect(() => {
    if (!game) return;
    const turn = game.currentTurn;
    if (prevTurnRef.current && prevTurnRef.current !== turn) {
      const isMe = turn === user?.id;
      // Clear scored dice history when turn changes (new turn for whoever)
      setScoredDiceHistory([]);
      setSelectedIndices([]);
      setBankFlash(false);
      setRollFlash(false);
      setTurnBanner(isMe ? t("games.farkle.your_turn") : t("games.farkle.opponents_turn").replace("{name}", opponent?.name || "Opponent"));
      setTimeout(() => setTurnBanner(null), 1800);
    }
    prevTurnRef.current = turn;
  }, [game?.currentTurn, game?.turnNumber]);

  /* ─── Bank Flash Detection ─── */
  // Note: this effect must be placed AFTER canBank and diceUnknown are declared (see below)
  // It's moved down to avoid "used before declaration" errors.

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
      posthog?.capture("farkle_game_started", { mode: "pvp_create", wager, game_id: d.roomId });
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
      posthog?.capture("farkle_game_started", { mode: "ai", wager, difficulty });
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
      posthog?.capture("farkle_game_started", { mode: "pvp_join", wager: (d.state as any)?.wager || 0, game_id: id });
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
    setBankFlash(false); // Reset flash so re-roll triggers a fresh pulse
    setRollFlash(false);
    const indices = [...selectedIndices];
    // Capture scored dice values before state is updated
    const scoredValues = indices.map((i) => game?.dice?.[i]).filter((v): v is number => v !== undefined);
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
        setSelectedIndices([]);
        return;
      }
      // Add scored dice to history so they stay visible in the side box
      if (scoredValues.length > 0) {
        setScoredDiceHistory((prev) => [...prev, [...scoredValues]]);
      }
      setSelectedIndices([]);
      setGame(d.state);
      setRolling(false);
      emitRoomEvent();
      fetchHistory(roomId);
      if (indices.length > 0) {
        setExploding(true);
        setTimeout(() => setExploding(false), 800);
      }
    } catch {
      setRolling(false);
      setSelectedIndices([]);
    }
  };

  const bankScore = async () => {
    if (!roomId || !isYourTurn || banking) return;

    // Prefer a valid manual selection. If the selection is empty or invalid,
    // let the route auto-bank every currently scoring die.
    const manualSelectionScores = selectedIndices.length > 0 && selectedScore > 0;
    const indices = manualSelectionScores ? [...selectedIndices] : [...scoringIndices];

    setBanking(true);
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
      setScoredDiceHistory([]);
      setGame(d.state);
      // Bank celebration — confetti burst + coin shower
      setBankCelebrating(true);
      setHotDiceFlash(false); // Clear hot dice flash if still showing
      confetti({
        particleCount: 60,
        spread: 70,
        origin: { x: 0.5, y: 0.5 },
        colors: ["#fbbf24", "#22c55e", "#facc15", "#34d399", "#eab308"],
      });
      setTimeout(() => {
        confetti({
          particleCount: 30,
          spread: 50,
          origin: { x: 0.4, y: 0.5 },
          colors: ["#fbbf24", "#22c55e"],
        });
      }, 200);
      setTimeout(() => setBankCelebrating(false), 2200);
      emitRoomEvent();
      fetchHistory(roomId);
      // If AI is next, schedule AI turn
      if (d.aiNext && !d.ended) {
        aiTurnScheduledRef.current = true;
        triggerAiTurn(roomId);
      }
    } catch (e) {
      alert("Bank failed");
    } finally {
      setBanking(false);
      setRolling(false);
    }
  };

  const resign = async () => {
    if (!roomId || resigning) return;
    setResigning(true);
    try {
      const res = await fetch("/api/farkle/resign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roomId }),
      });
      const d = await res.json();
      if (!res.ok || !d.success) return alert(d.error || "Failed to resign");

      emitRoomEvent();
      setGame(d.state);
      setSelectedIndices([]);
      setScoredDiceHistory([]);
      setRolling(false);
      setAiAnimating(false);

      if (d.state?.state === "finished") {
        showGameOver(d.state, d.winnerId === user?.id ? "win" : "lose");
        posthog?.capture("farkle_game_ended", { result: "loss", reason: "resigned", bet_amount: d.state?.wager || 0, mode: d.state?.ai ? "ai" : "pvp" });
      }
    } catch {
      alert("Failed to resign");
    } finally {
      setResigning(false);
    }
  };

  const resetToLobby = () => {
    if (socket && roomId) socket.emit("leave_room", { roomId });
    setRoomId(null);
    setGame(null);
    setGameOverType(null);
    setGameOverScores(null);
    setSelectedIndices([]);
    setScoredDiceHistory([]);
    setBankFlash(false);
    setRollFlash(false);
    setBankCelebrating(false);
    setHotDiceFlash(false);
    setDisplayedTurnScore(0);
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
    if (!isYourTurn || rolling || aiAnimating || diceUnknown) return;
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

  // Whether dice are unknown (not yet rolled this turn) — like Yahtzee's ? markers
  const diceUnknown = isYourTurn && (game?.rollsThisTurn ?? 0) === 0;

  const isAllScoringSelected = useMemo(() => {
    if (!game) return false;
    return (
      selectedIndices.length > 0 &&
      selectedIndices.length === game.dice.length &&
      scoringIndices.length === game.dice.length
    );
  }, [selectedIndices, game?.dice, scoringIndices]);

  // Must select at least one scoring die before rolling (unless hot dice or first roll)
  const canRoll =
    isYourTurn &&
    !rolling &&
    !aiAnimating &&
    game &&
    game.dice.length > 0 &&
    !waitingForOpponent &&
    (selectedIndices.length > 0 || game.hasHotDice || diceUnknown);

  // Effective score that would be banked: manual selection or auto-select all scoring dice
  const effectiveScore = selectedIndices.length > 0 ? selectedScore : autoScore;

  const hasBankableTurnScore = (game?.turnScore ?? 0) > 0;
  const canAttemptBank = Boolean(
    isYourTurn &&
      !rolling &&
      !aiAnimating &&
      !banking &&
      game &&
      !waitingForOpponent &&
      (hasBankableTurnScore || !diceUnknown),
  );

  // Can bank anytime there are points to bank (no minimum threshold), but not before first roll.
  // The click target stays enabled after the roll so the API can be reached even if
  // client-side score detection misses an edge case; the server remains authoritative.
  const canBank = Boolean(canAttemptBank && (hasBankableTurnScore || effectiveScore > 0));

  const diffColor = (d: string) =>
    d === "easy" ? "text-green-400" : d === "medium" ? "text-yellow-400" : "text-red-400";

  /* ─── Button Flash Detections ─── */
  // Bank button glow
  useEffect(() => {
    if (canBank && !prevCanBankRef.current) {
      setBankFlash(true);
      const timer = setTimeout(() => setBankFlash(false), 1600);
      prevCanBankRef.current = canBank;
      return () => clearTimeout(timer);
    }
    prevCanBankRef.current = canBank;
  }, [canBank]);

  // Roll button glow — only when player has selected dice (not the initial roll)
  // canRoll already incorporates diceUnknown, so no need to depend on it separately
  useEffect(() => {
    if (canRoll && !prevCanRollRef.current && !diceUnknown) {
      setRollFlash(true);
      const timer = setTimeout(() => setRollFlash(false), 1600);
      prevCanRollRef.current = canRoll;
      return () => clearTimeout(timer);
    }
    prevCanRollRef.current = canRoll;
  }, [canRoll]);

  // Hot dice celebration
  useEffect(() => {
    if (game?.hasHotDice && !prevHasHotDiceRef.current && isYourTurn) {
      setHotDiceFlash(true);
      confetti({
        particleCount: 50,
        spread: 120,
        origin: { x: 0.5, y: 0.4 },
        colors: ["#f97316", "#ef4444", "#fbbf24", "#facc15", "#ff4500"],
      });
      setTimeout(() => {
        confetti({
          particleCount: 30,
          spread: 80,
          origin: { x: 0.3, y: 0.4 },
          colors: ["#f97316", "#fbbf24"],
        });
      }, 300);
      const timer = setTimeout(() => setHotDiceFlash(false), 2000);
      prevHasHotDiceRef.current = true;
      return () => clearTimeout(timer);
    }
    prevHasHotDiceRef.current = game?.hasHotDice ?? false;
  }, [game?.hasHotDice, isYourTurn]);

  return (
    <div className="min-h-screen bg-gradient-to-b from-[#0a0118] to-[#061b3d] px-3 pb-24 pt-20 text-white">
      <NavigationBar currentPath="/casino" />
      <div className="mx-auto mt-4 max-w-4xl">
        <motion.h1
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-2 text-center text-4xl font-black text-amber-400 drop-shadow-[0_0_15px_rgba(251,191,36,0.5)]"
        >
          🎲 {t("games.farkle.title")}
        </motion.h1>

        {/* ═══ LOBBY ═══ */}
        {!roomId && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="rounded-2xl border border-amber-700/60 bg-black/40 p-6"
          >
            <div className="mb-4 text-center text-lg font-bold text-yellow-300">
              💰 {t("games.balance")}: {balance.toFixed(2)} tokens
            </div>

            {/* Wager Input */}
            <div className="mb-4">
              <label className="mb-1 block text-sm font-semibold text-amber-200">{t("games.farkle.wager")}</label>
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
                {t("games.farkle.ai_difficulty")}
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
                    {d === "easy" ? `🟢 ${t("games.farkle.difficulty_easy")}` : d === "medium" ? `🟡 ${t("games.farkle.difficulty_medium")}` : `🔴 ${t("games.farkle.difficulty_hard")}`}
                  </button>
                ))}
              </div>
              <p className="mt-1 text-xs text-gray-400">
                {difficulty === "easy" && t("games.farkle.ai_desc_easy")}
                {difficulty === "medium" && t("games.farkle.ai_desc_medium")}
                {difficulty === "hard" && t("games.farkle.ai_desc_hard")}
              </p>
            </div>

            {/* Action Buttons */}
            <div className="mb-6 flex gap-3">
              <button
                onClick={createGame}
                disabled={loading}
                className="flex-1 rounded-2xl border-b-4 border-cyan-700 bg-cyan-500 px-6 py-3.5 text-lg font-black text-black shadow-[0_0_25px_rgba(34,211,238,0.4)] transition active:translate-y-[2px] disabled:opacity-50"
              >
                {loading ? t("games.farkle.starting") : `${t("games.farkle.create_pvp")} 🎲`}
              </button>
              <button
                onClick={playAI}
                disabled={loading}
                className="flex-1 rounded-2xl border-b-4 border-amber-700 bg-amber-500 px-6 py-3.5 text-lg font-black text-black shadow-[0_0_25px_rgba(251,191,36,0.4)] transition active:translate-y-[2px] disabled:opacity-50"
              >
                {loading ? t("games.farkle.starting") : `${t("games.farkle.play_vs_ai")} 🤖`}
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
              <p className="font-bold text-amber-300 mb-1">📋 {t("games.farkle.rules_title")}</p>
              <ul className="list-inside list-disc space-y-0.5">
                <li>{t("games.farkle.rules_line1")}</li>
                <li>{t("games.farkle.rules_line2")}</li>
                <li>{t("games.farkle.rules_line3")}</li>
                <li>{t("games.farkle.rules_line4")}</li>
                <li>{t("games.farkle.rules_line5").replace("{score}", WINNING_SCORE.toLocaleString())}</li>
              </ul>
            </div>

            {/* Available Games */}
            <div>
              <h3 className="mb-3 text-lg font-bold text-cyan-300">🎮 {t("games.available_games")}</h3>
              {availableGames.length === 0 ? (
                <p className="text-center text-sm text-gray-500 py-8">{t("games.no_open_games")} {t("games.farkle.create_one")}</p>
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
                        {joiningId === l.id ? t("games.farkle.joining") : t("games.join")}
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
                    ? t("games.farkle.waiting_opponent")
                    : isYourTurn
                      ? t("games.farkle.your_turn")
                      : t("games.farkle.opponents_turn").replace("{name}", opponent?.name || "AI")}
                </span>
                {aiAnimating && (
                  <span className="flex items-center gap-1 rounded-full bg-yellow-800/50 px-2 py-1 text-xs text-yellow-300">
                    <motion.span
                      animate={{ rotate: 360 }}
                      transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
                    >
                      🤖
                    </motion.span>
                    {t("games.farkle.ai_thinking")}
                  </span>
                )}
                {isPvp && (
                  <span className="rounded-full bg-purple-800/50 px-2 py-1 text-xs text-purple-300">
                    ⚔️ {t("games.farkle.pvp_label")}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
              {isPvp && opponent && (
                <button
                  type="button"
                  onClick={() => setShowReportModal(true)}
                  className="relative z-20 rounded-lg bg-red-500/20 border border-red-500/40 px-3 py-1 text-xs font-bold text-red-300 hover:bg-red-500/30 transition"
                >
                  🚩 Report
                </button>
              )}
              <button
                type="button"
                disabled={resigning || !roomId || game.state === "finished"}
                onClick={(e) => {
                  e.preventDefault();
                  resign();
                }}
                className="relative z-20 rounded-lg bg-red-600/80 px-3 py-1 text-xs font-bold text-white hover:bg-red-600 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {resigning ? "..." : t("games.farkle.resign")}
              </button>
              </div>
            </div>

            {/* Waiting for opponent alert */}
            {waitingForOpponent && (
              <div className="mb-4 rounded-xl border border-fuchsia-500/50 bg-fuchsia-950/40 p-4 text-center">
                <motion.div
                  animate={{ opacity: [0.5, 1, 0.5] }}
                  transition={{ duration: 1.5, repeat: Infinity }}
                  className="text-lg font-bold text-fuchsia-300"
                >
                  ⏳ {t("games.farkle.waiting_opponent")}
                </motion.div>
                <p className="mt-1 text-xs text-fuchsia-400/70">
                  {t("games.farkle.share_waiting")}
                </p>
                <p className="mt-2 text-xs font-mono text-gray-500">{game.id}</p>
              </div>
            )}

            {/* ═══ SCOREBOARD ═══ */}
            <div className="mb-4 overflow-hidden rounded-2xl border-4 border-amber-500 bg-gradient-to-b from-[#1a1a2e] to-[#16213e] shadow-[0_0_30px_rgba(251,191,36,0.3)]">
              {/* Title Bar */}
              <div className="bg-amber-900/60 px-4 py-2 text-center text-sm font-black text-amber-300">
                🏆 {t("games.farkle.race_to").replace("{score}", WINNING_SCORE.toLocaleString())}
              </div>

              {/* Player Scores */}
              <div className="grid grid-cols-2 divide-x divide-amber-700/50">
                {/* You */}
                <div className="p-4 text-center">
                  <div className="mb-1 text-xs font-bold uppercase text-green-400">
                    {you?.name || t("games.farkle.you_label")}
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
                    {scoreProgress(yourScore).toFixed(0)}{t("games.farkle.percent_goal")}
                  </div>
                </div>

                {/* Opponent */}
                <div className="p-4 text-center">
                  <div className="mb-1 text-xs font-bold uppercase text-red-400">
                    {opponent?.name || t("games.farkle.opponent_label")}
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
                    {scoreProgress(opponentScore).toFixed(0)}{t("games.farkle.percent_goal")}
                  </div>
                </div>
              </div>

              {/* Turn Score / Status Bar */}
              <div className="border-t border-amber-700/50 bg-black/20 px-4 py-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-amber-200/80">
                    {t("games.farkle.turn_score")}:{" "}
                    <motion.span
                      key={displayedTurnScore}
                      animate={{ scale: [1, 1.3, 1] }}
                      transition={{ duration: 0.35 }}
                      className="font-black text-amber-400"
                    >
                      {displayedTurnScore}
                    </motion.span>
                    {game.hasHotDice && (
                      <span className="ml-2 rounded-full bg-orange-600/60 px-2 py-0.5 text-xs font-bold text-orange-200">
                        🔥 {t("games.farkle.hot_dice")}
                      </span>
                    )}
                  </span>
                  <span className="text-xs text-gray-400">
                    Dice: {game.dice.length} | {t("games.farkle.rolls_status")}: {game.rollsThisTurn} | {t("games.farkle.turn_status")}{game.turnNumber}
                  </span>
                </div>
              </div>
            </div>

            {/* ═══ AI/Opponent DISPLAY ═══ */}
            {!isYourTurn && game.state === "playing" && !waitingForOpponent && (
              <div className="mb-4 rounded-xl border border-gray-700/50 bg-black/20 p-3">
                <div className="mb-2 text-center text-xs font-bold text-gray-400 uppercase">                    {t("games.farkle.opponents_dice").replace("{name}", opponent?.name || t("games.farkle.ai_label"))}
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
                    {aiSteps[currentAiStep]?.type === "select" && `${t("games.farkle.ai_selected_for")}${aiSteps[currentAiStep].comboScore} ${t("games.farkle.pts_label")}`}
                    {aiSteps[currentAiStep]?.type === "roll" && `${t("games.farkle.ai_rolling_dice")} ${aiSteps[currentAiStep].remainingDice} ${t("games.farkle.ai_dice_suffix")}`}
                    {aiSteps[currentAiStep]?.type === "bank" && `${t("games.farkle.ai_banking_pts")}${aiSteps[currentAiStep].turnScore} ${t("games.farkle.ai_pts_suffix")}`}
                    {aiSteps[currentAiStep]?.type === "farkle" && t("games.farkle.ai_farkle_msg")}
                    {aiSteps[currentAiStep]?.type === "hot_dice" && t("games.farkle.ai_hot_dice_msg")}
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
                        📌 {t("games.farkle.selected_dice")}
                      </span>
                      {selectedIndices.length > 0 && (
                        <button
                          onClick={clearSelection}
                          className="rounded-md bg-red-500/20 px-2 py-0.5 text-[10px] font-bold text-red-300 hover:bg-red-500/40 transition-colors"
                        >
                          {t("games.farkle.clear")}
                        </button>
                      )}
                    </div>
                    {/* Show previously scored dice (guarded) */}
                    {scoredDiceHistory.length > 0 && (
                      <div className="mb-3 border-b border-green-700/30 pb-2">
                        <div className="mb-1.5 text-[10px] font-semibold uppercase text-amber-400/80">
                          🔒 {t("games.farkle.scored_label")}
                        </div>
                        <div className="flex flex-wrap justify-center gap-1.5">
                          {scoredDiceHistory.flat().map((val, i) => (
                            <div
                              key={`scored-${i}`}
                              className="flex h-9 w-9 items-center justify-center rounded-lg border border-amber-500/40 bg-amber-900/30 text-xs font-bold text-amber-300 opacity-80"
                            >
                              {val}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    {selectedIndices.length === 0 && scoredDiceHistory.length === 0 ? (
                      <div className="flex min-h-[60px] items-center justify-center text-xs text-gray-500">
                        {t("games.farkle.click_scoring_hint")}
                      </div>
                    ) : selectedIndices.length === 0 ? (
                      <div className="flex min-h-[30px] items-center justify-center text-[10px] text-gray-500">
                        {t("games.farkle.select_more_hint")}
                      </div>
                    ) : null}
                    {selectedIndices.length > 0 && scoredDiceHistory.length > 0 && (
                      <div className="mb-2 border-t border-amber-700/30 pt-2">
                        <div className="mb-1.5 text-[10px] font-semibold uppercase text-green-400/80">
                          📋 {t("games.farkle.current_label")}
                        </div>
                      </div>
                    )}
                    {selectedIndices.length > 0 && (
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
                        +{selectedScore > 0 ? selectedScore : 0} {t("games.farkle.pts_label")}
                      </span>
                    </div>
                  </div>
                </div>                {/* ─── Main Dice Area ─── */}
                <div className="flex-1">
                  <div className="mb-2 text-center text-xs font-bold text-gray-400 uppercase">
                    {t("games.farkle.your_dice_prompt")}
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
                          disabled={!isYourTurn || rolling || aiAnimating || diceUnknown || !isScoring}
                          whileHover={isScoring && !diceUnknown ? { scale: 1.08 } : {}}
                          whileTap={isScoring && !diceUnknown ? { scale: 0.92 } : {}}
                          onClick={() => toggleDie(i)}
                          className={`relative rounded-2xl transition-all duration-200 ${
                            diceUnknown
                              ? "opacity-60 cursor-not-allowed"
                              : isScoring
                                ? "ring-2 ring-amber-400/80 shadow-[0_0_18px_rgba(251,191,36,0.5)]"
                                : "opacity-40 cursor-not-allowed"
                          }`}
                        >
                          <DiceFace
                            value={d}
                            selected={false}
                            rolling={rolling}
                            index={i}
                            unknown={diceUnknown}
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
                        ✅ {t("games.farkle.all_selected")}
                      </p>
                    )}
                  </div>

                  {/* Prompt to roll first */}
                  {diceUnknown && (
                    <motion.div
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="mt-3 rounded-lg border border-cyan-600/50 bg-cyan-900/20 p-3 text-center"
                    >
                      <p className="text-sm font-bold text-cyan-400">
                        🎲 {t("games.farkle.roll_start")}
                      </p>
                    </motion.div>
                  )}

                  {/* No scoring dice left warning */}
                  {game.dice.length > 0 && scoringIndices.length === 0 && !rolling && !diceUnknown && (
                    <motion.div
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="mt-3 rounded-lg border border-red-600/50 bg-red-900/20 p-3 text-center"
                    >
                      <p className="text-sm font-bold text-red-400">
                        ⚠️ {t("games.farkle.no_scoring")}
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
                        💥 {t("games.farkle.farkle_warning")}
                      </motion.div>
                    )}
                </div>
              </div>
            )}

            {/* ═══ ACTION BUTTONS ═══ */}
            {isYourTurn && game.state === "playing" && !waitingForOpponent && (
              <div className="flex flex-wrap justify-center gap-3">
                {/* Roll Dice */}
                <div className="relative">
                  {/* Glow ring behind the roll button */}
                  <AnimatePresence>
                    {rollFlash && canRoll && (
                      <motion.div
                        key="roll-glow"
                        initial={{ opacity: 0, scale: 0.8 }}
                        animate={{ opacity: [0, 0.6, 0.3, 0.6, 0], scale: [0.9, 1.15, 1.08, 1.15, 0.95] }}
                        exit={{ opacity: 0, scale: 0.8 }}
                        transition={{ duration: 1.5, ease: "easeOut" }}
                        className="pointer-events-none absolute inset-0 -inset-x-3 -inset-y-3 rounded-2xl bg-gradient-to-r from-cyan-400 via-blue-300 to-cyan-400 blur-xl"
                      />
                    )}
                  </AnimatePresence>
                  <motion.button
                    disabled={!canRoll || rolling}
                    whileHover={canRoll ? { scale: 1.05 } : {}}
                    whileTap={{ scale: 0.95 }}
                    animate={
                      rollFlash && canRoll
                        ? {
                            boxShadow: [
                              "0 0 15px rgba(34,211,238,0.4)",
                              "0 0 40px rgba(34,211,238,0.9), 0 0 80px rgba(6,182,212,0.5)",
                              "0 0 25px rgba(34,211,238,0.6)",
                              "0 0 50px rgba(34,211,238,0.8), 0 0 100px rgba(6,182,212,0.4)",
                              "0 0 15px rgba(34,211,238,0.4)",
                            ],
                            scale: [1, 1.06, 0.98, 1.03, 1],
                          }
                        : {}
                    }
                    onClick={rollDice}
                    className="relative z-10 rounded-xl border-b-4 border-cyan-700 bg-cyan-500 px-6 py-3 font-black text-black shadow-[0_0_15px_rgba(34,211,238,0.4)] transition disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    🎲 {diceUnknown ? t("games.farkle.roll_dice") : isAllScoringSelected ? t("games.farkle.hot_dice_roll_all") : game.hasHotDice ? t("games.farkle.roll_all_dice") : `${t("games.farkle.reroll_dice")} ${game.dice.length} Dice`}
                    {selectedIndices.length > 0 && (
                      <span className="ml-1 text-xs opacity-80">
                        {t("games.farkle.score_preview").replace("{pts}", String(selectedScore))}
                      </span>
                    )}
                  </motion.button>
                </div>

                {/* Bank Score */}
                <div className="relative">
                  {/* Glow ring behind the button */}
                  <AnimatePresence>
                    {bankFlash && canBank && (
                      <motion.div
                        key="bank-glow"
                        initial={{ opacity: 0, scale: 0.8 }}
                        animate={{ opacity: [0, 0.7, 0.4, 0.7, 0], scale: [0.9, 1.15, 1.08, 1.15, 0.95] }}
                        exit={{ opacity: 0, scale: 0.8 }}
                        transition={{ duration: 1.5, ease: "easeOut" }}
                        className="pointer-events-none absolute inset-0 -inset-x-3 -inset-y-3 rounded-2xl bg-gradient-to-r from-green-400 via-emerald-300 to-green-400 blur-xl"
                      />
                    )}
                  </AnimatePresence>
                  <motion.button
                    disabled={!canAttemptBank}
                    whileHover={canAttemptBank ? { scale: 1.05 } : {}}
                    whileTap={{ scale: 0.95 }}
                    animate={
                      bankFlash && canBank
                        ? {
                            boxShadow: [
                              "0 0 15px rgba(34,197,94,0.4)",
                              "0 0 40px rgba(34,197,94,0.9), 0 0 80px rgba(52,211,153,0.5)",
                              "0 0 25px rgba(34,197,94,0.6)",
                              "0 0 50px rgba(34,197,94,0.8), 0 0 100px rgba(52,211,153,0.4)",
                              "0 0 15px rgba(34,197,94,0.4)",
                            ],
                            scale: [1, 1.06, 0.98, 1.03, 1],
                          }
                        : {}
                    }
                    type="button"
                    onClick={(e) => {
                      e.preventDefault();
                      bankScore();
                    }}
                    className={`relative z-10 rounded-xl border-b-4 px-6 py-3 font-black text-white transition disabled:cursor-not-allowed disabled:opacity-30 ${
                      canBank
                        ? "border-green-700 bg-green-500 shadow-[0_0_15px_rgba(34,197,94,0.4)]"
                        : "border-gray-700 bg-gray-600 shadow-none"
                    }`}
                  >
                    🏦 {banking ? "..." : `${t("games.farkle.bank_score")} +${game.turnScore + effectiveScore}`}
                  </motion.button>
                </div>
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

            {/* Bank Celebration — floating coins */}
            <AnimatePresence>
              {bankCelebrating && (
                <motion.div
                  key="bank-celebration"
                  className="pointer-events-none fixed inset-0 z-50 overflow-hidden"
                  initial={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.5 }}
                >
                  {/* Screen flash */}
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: [0, 0.3, 0] }}
                    transition={{ duration: 0.6 }}
                    className="absolute inset-0 bg-green-400"
                  />
                  {/* Floating coins */}
                  {Array.from({ length: 20 }).map((_, i) => (
                    <motion.div
                      key={`coin-${i}`}
                      className="absolute text-3xl"
                      initial={{
                        x: `${40 + (i % 5) * 5 + Math.random() * 10}%`,
                        y: "60%",
                        opacity: 0,
                        scale: 0,
                      }}
                      animate={{
                        y: `${-20 - Math.random() * 40}%`,
                        x: `${35 + Math.random() * 30}%`,
                        opacity: [0, 1, 1, 0],
                        scale: [0, 1.3, 1, 0.8],
                        rotate: [0, 180 + Math.random() * 180],
                      }}
                      exit={{ opacity: 0 }}
                      transition={{
                        duration: 1.5 + Math.random() * 1,
                        delay: i * 0.04,
                        ease: "easeOut",
                      }}
                    >
                      {["🪙", "💰", "✨", "💎", "⭐", "🪙", "💰", "✨"][i % 8]}
                    </motion.div>
                  ))}
                </motion.div>
              )}
            </AnimatePresence>

            {/* Hot Dice Screen Flash */}
            <AnimatePresence>
              {hotDiceFlash && (
                <motion.div
                  key="hot-dice-celebration"
                  className="pointer-events-none fixed inset-0 z-50 overflow-hidden"
                  initial={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.4 }}
                >
                  {/* Amber/orange screen flash */}
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: [0, 0.35, 0.15, 0.25, 0] }}
                    transition={{ duration: 1.2 }}
                    className="absolute inset-0 bg-gradient-to-b from-orange-500 via-amber-500 to-red-500"
                  />
                  {/* Fire emojis floating up */}
                  {Array.from({ length: 16 }).map((_, i) => (
                    <motion.div
                      key={`fire-${i}`}
                      className="absolute text-4xl"
                      initial={{
                        x: `${10 + (i % 8) * 10 + Math.random() * 5}%`,
                        y: "80%",
                        opacity: 0,
                        scale: 0,
                      }}
                      animate={{
                        y: `${-10 - Math.random() * 50}%`,
                        x: `${5 + Math.random() * 90}%`,
                        opacity: [0, 1, 1, 0.6, 0],
                        scale: [0, 1.5, 1.2, 0.8, 0.3],
                      }}
                      transition={{
                        duration: 1.6 + Math.random() * 1,
                        delay: i * 0.05,
                        ease: "easeOut",
                      }}
                    >
                      {["🔥", "🎲", "🔥", "✨", "🔥", "💥", "🔥", "⚡"][i % 8]}
                    </motion.div>
                  ))}
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
                        {gameOverType === "win" ? t("games.farkle.you_win") : t("games.farkle.you_lose")}
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
                          {you?.name || t("games.farkle.you_label")}
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
                      <div className="text-3xl font-black text-gray-500">{t("games.farkle.vs")}</div>
                      <div className="text-center">
                        <div className="text-xs font-bold uppercase text-gray-400">
                          {opponent?.name || t("games.farkle.ai_label")}
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
                          {t("games.farkle.better_luck")}
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
                      {t("games.farkle.return_lobby")}
                    </motion.button>
                  </motion.div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}
      </div>
      <ReportModal
        isOpen={showReportModal && isPvp && !!opponent}
        onClose={() => setShowReportModal(false)}
        onSubmit={async (reason, details) => {
          const res = await fetch("/api/reports/submit", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              reportedClerkId: opponent?.userId,
              gameType: "farkle",
              gameId: roomId,
              reason,
              details: details || undefined,
            }),
          });
          const data = await res.json();
          if (!data.success) throw new Error(data.error || "Failed to submit report");
        }}
        reportedPlayerName={opponent?.name || "Opponent"}
        gameType="Farkle"
      />
      <Footer />
    </div>
  );
}
