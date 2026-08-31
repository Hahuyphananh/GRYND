"use client";

// ── RPS PvP best-of-7 match page ───────────────────────────────────────
// Server-authoritative wagered match. Polls /api/rps/pvp/status, renders
// the best-of-7 round tracker (blue = rounds you won, red = rounds the
// opponent won), and shows the rounds history in the left sidebar —
// each resolved round lists the exact throw each player made.

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { playVictory, playDefeat, playTick, playGoodReveal, playBuzz } from "../../../../../lib/gameAudio";
import { useUser } from "@clerk/nextjs";
import { motion, AnimatePresence } from "framer-motion";
import NavigationBar from "../../../../../components/navigation-bar";
// Shared Creator Mode foundation (admin-only): mounts the viewport
// recorder + overlay and auto-starts when the actual RPS game begins
// (matched/active), auto-stops when it finishes or the user quits.
// NavBar / Footer stay OUTSIDE so nothing is recorded until gameplay.
import CreatorModeHost from "../../../../../components/creator-mode/CreatorModeHost";
import { CreatorResponsiveLayout } from "../../../../../components/creator-mode/CreatorModeLayout";
import Footer from "../../../../../components/Footer";
import RoundMarkers from "../../../../../components/casino/RoundMarkers";
import ReportModal from "../../../../../components/ReportModal";
import EmotePicker, { EmoteBubble } from "../../../../../components/game/EmotePicker";
import useGameEmotes from "../../../../../hooks/useGameEmotes";
import { useSocket } from "../../../../../context/SocketProvider";
import { RockFistIcon } from "../../../../../components/icons/CustomIcons";
import {
  IconHandStop,
  IconScissors,
  IconQuestionMark,
  IconTrophy,
  IconSkull,
  IconFlag,
  IconHistory,
} from "@tabler/icons-react";

const PVP_CHOICES = ["rock", "paper", "scissors"] as const;
// This match page has no socket fast-path, so polling is the only sync
// channel. 1500ms -> 2000ms is a safe cut: players have a 10s pick window
// and the server enforces the pick deadline, so a 2s poll never drops a
// legitimate submission (it only defers the opp move/status render by ~0.5s).
const POLL_MS = 2000;
const CHOICE_SECONDS = 10;

type Choice = (typeof PVP_CHOICES)[number];
type RoundHistoryEntry = {
  round: number;
  player1Choice: Choice;
  player2Choice: Choice;
  winner: "player1" | "player2" | "tie";
};

export default function RPSPvpGamePage() {
  const params = useParams<{ gameId: string }>();
  const gameId = Number(params?.gameId);
  const router = useRouter();
  const { user } = useUser();
  const { socket } = useSocket();
  const { incomingEmote, myEmote, sendEmote } = useGameEmotes({
    socket,
    roomId: Number.isFinite(gameId) ? `rps:emote:${gameId}` : null,
    eventName: "rps:emote",
    selfId: user?.id,
  });

  const [status, setStatus] = useState<string | null>(null);
  const [myName, setMyName] = useState("You");
  const [opponentName, setOpponentName] = useState("Opponent");
  const [player1Id, setPlayer1Id] = useState<string | null>(null);
  const [player2Id, setPlayer2Id] = useState<string | null>(null);
  const [myChoice, setMyChoice] = useState<Choice | null>(null);
  const [opponentChoice, setOpponentChoice] = useState<Choice | null>(null);
  const [roundsWon1, setRoundsWon1] = useState(0);
  const [roundsWon2, setRoundsWon2] = useState(0);
  const [currentRound, setCurrentRound] = useState(1);
  const [history, setHistory] = useState<RoundHistoryEntry[]>([]);
  const [winner, setWinner] = useState<"you" | "opponent" | "tie" | null>(null);
  const [winnerPayout, setWinnerPayout] = useState<number | null>(null);
  const [winnerProfit, setWinnerProfit] = useState<number | null>(null);
  const [houseFee, setHouseFee] = useState<number | null>(null);
  const [betAmount, setBetAmount] = useState<number>(0);
  const [tokens, setTokens] = useState<number | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [message, setMessage] = useState("");
  const [actionLoading, setActionLoading] = useState(false);
  const [forfeiting, setForfeiting] = useState(false);
  const [showReportModal, setShowReportModal] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const viewerIsPlayer1 =
    player1Id !== null && player1Id === user?.id;
  const myWins = viewerIsPlayer1 ? roundsWon1 : roundsWon2;
  const oppWins = viewerIsPlayer1 ? roundsWon2 : roundsWon1;

  // ── Audio ──────────────────────────────────────────────────────────
  // Round reveal — a new history entry means a round just resolved:
  // chime on a round win, buzz on a round loss, tick on a tie.
  const lastHistoryLenRef = useRef(0);
  useEffect(() => {
    if (history.length === lastHistoryLenRef.current) return;
    const grew = history.length > lastHistoryLenRef.current;
    lastHistoryLenRef.current = history.length;
    if (!grew || history.length === 0) return;
    const lastRound = history[history.length - 1];
    if (lastRound.winner === "tie") {
      playTick();
    } else if (viewerIsPlayer1 ? lastRound.winner === "player1" : lastRound.winner === "player2") {
      playGoodReveal();
    } else {
      playBuzz();
    }
  }, [history, viewerIsPlayer1]);

  // Match-end — plays once when the poll first observes `finished`.
  const matchEndSoundRef = useRef(false);
  useEffect(() => {
    if (status !== "finished") {
      matchEndSoundRef.current = false;
      return;
    }
    if (matchEndSoundRef.current) return;
    matchEndSoundRef.current = true;
    if (winner === "you") playVictory();
    else if (winner === "opponent") playDefeat();
    else if (winner === "tie") playTick();
  }, [status, winner]);

  useEffect(() => {
    if (!gameId || !Number.isFinite(gameId)) {
      setFailed("Invalid game");
      return;
    }

    const poll = async () => {
      try {
        const res = await fetch(`/api/rps/pvp/status?gameId=${gameId}`);
        const data = await res.json();
        if (!data.success) {
          setFailed(data.error || "Game unavailable");
          return;
        }

        const game = data.data;
        setStatus(game.status);
        setPlayer1Id(game.player1Id || null);
        setPlayer2Id(game.player2Id || null);
        setMyName(game.myName || "You");
        setOpponentName(game.opponentName || "Opponent");
        setMyChoice(game.myChoice || null);
        setOpponentChoice(game.opponentChoice || null);
        setRoundsWon1(game.roundsWon1 || 0);
        setRoundsWon2(game.roundsWon2 || 0);
        setCurrentRound(game.currentRound || 1);
        setHistory(game.roundHistory || []);
        setBetAmount(game.betAmount || 0);
        setWinner(game.winner || null);
        setWinnerPayout(typeof game.winnerPayout === "number" ? game.winnerPayout : null);
        setWinnerProfit(typeof game.winnerProfit === "number" ? game.winnerProfit : null);
        setHouseFee(typeof game.houseFee === "number" ? game.houseFee : null);
        if (typeof game.newBalance === "number") setTokens(game.newBalance);

        if (game.status === "active") {
          setMessage("Waiting for opponent…");
        } else if (game.status === "matched" && !game.myChoice) {
          setMessage("Opponent joined. Pick rock, paper, or scissors.");
        } else if (game.status === "matched" && game.myChoice && !game.opponentChoice) {
          setMessage("Choice locked. Waiting for opponent choice…");
        } else if (game.status === "matched") {
          setMessage(`Round ${game.currentRound || 1}. Pick your throw.`);
        } else if (game.status === "finished") {
          setMessage(
            game.winner === "you"
              ? "You won the best-of-7 match!"
              : game.winner === "opponent"
                ? "You lost the best-of-7 match."
                : "It's a tie.",
          );
        } else if (game.status === "cancelled") {
          setMessage("Game cancelled.");
        }
      } catch (err) {
        console.error("Failed to poll RPS PvP status:", err);
      }
    };

    poll();
    const interval = setInterval(poll, POLL_MS);
    return () => clearInterval(interval);
  }, [gameId, user?.id]);

  // Presence room — lets the realtime server track this participant so
  // a disconnect past the grace window forfeits the match to the
  // opponent (see /api/rps/pvp/disconnect-forfeit).
  useEffect(() => {
    if (!socket || !Number.isFinite(gameId)) return;
    const roomId = `rps-pvp:match:${gameId}`;
    socket.emit("join_room", { roomId });
    return () => {
      socket.emit("leave_room", { roomId });
    };
  }, [socket, gameId]);

  // 10-second pick countdown while it's our turn.
  useEffect(() => {
    if (status !== "matched" || myChoice) {
      setCountdown(null);
      return;
    }
    setCountdown(CHOICE_SECONDS);
    const id = setInterval(() => {
      setCountdown((prev) => {
        if (prev === null || prev <= 1) {
          clearInterval(id);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [status, myChoice, currentRound]);

  const handleForfeit = async () => {
    if (!gameId || forfeiting) return;
    if (
      !window.confirm(
        "Forfeit this match? Your stake is forfeited and your opponent wins.",
      )
    )
      return;
    setForfeiting(true);
    try {
      const res = await fetch("/api/rps/pvp/forfeit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gameId }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setMessage(data?.error || "Forfeit failed");
        return;
      }
      setMessage("You forfeited the match.");
    } catch {
      setMessage("Network error while forfeiting");
    } finally {
      setForfeiting(false);
    }
  };

  const chooseMove = async (choice: Choice) => {
    if (!gameId || status !== "matched" || myChoice) return;
    setActionLoading(true);
    try {
      const res = await fetch("/api/rps/pvp/choose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gameId, choice }),
      });
      const data = await res.json();
      if (!data.success) {
        setMessage(data.error || "Failed to save choice");
      } else {
        setMyChoice(choice);
        setMessage("Choice locked. Waiting for opponent…");
      }
    } catch (err) {
      console.error("Failed to choose RPS PvP move:", err);
      setMessage("Failed to submit choice");
    }
    setActionLoading(false);
  };

  const cancelGame = async () => {
    if (!gameId || status !== "active") return;
    setActionLoading(true);
    try {
      const res = await fetch("/api/rps/pvp/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gameId }),
      });
      const data = await res.json();
      if (data.success && typeof data.data.newBalance === "number") {
        setTokens(data.data.newBalance);
      }
      router.push("/casino/rps");
    } catch (err) {
      console.error("Failed to cancel RPS PvP game:", err);
    }
    setActionLoading(false);
  };

  if (failed) {
    return (
      <div className="flex min-h-screen flex-col bg-gradient-to-b from-[#0a0118] to-[#061b3d] text-white">
        <NavigationBar currentPath="/casino" />
        <div className="flex flex-1 items-center justify-center px-4">
          <div className="max-w-md rounded-2xl border border-red-500/30 bg-red-950/20 p-6 text-center">
            <h2 className="mb-2 text-lg font-bold">Match unavailable</h2>
            <p className="mb-4 text-sm text-white/70">{failed}</p>
            <button
              onClick={() => router.push("/casino/rps")}
              className="rounded-xl bg-amber-500 px-4 py-2 text-sm font-bold text-black hover:bg-amber-400"
            >
              Back to Lobby
            </button>
          </div>
        </div>
        <Footer />
      </div>
    );
  }

  return (
    <div className="min-h-screen overflow-x-hidden bg-gradient-to-b from-[#0a0118] to-[#061b3d] pb-28 pt-16 text-white md:pb-8">
      <NavigationBar currentPath="/casino" />

      {/* Only the actual game content is recorded — NavBar / Footer stay
          outside the shared CreatorModeHost recording viewport. Recording
          auto-starts when the game is matched/active and stops when it
          finishes or the user quits. */}
      <CreatorModeHost
        autoStart={status === "matched" || status === "active"}
        autoStop={status === "finished" || status === "cancelled"}
        gameLabel="rock-paper-scissors"
      >
      <CreatorResponsiveLayout>
      <div className="flex flex-col md:flex-row">
      {/* ── Left sidebar: rounds history (replaces the old lobby/bet panel) ── */}
      <aside className="w-[95%] sm:w-full max-w-[420px] md:max-w-[340px] mx-auto md:mx-0 mb-6 md:mb-0 md:ml-4 md:self-start md:sticky md:top-20">
        <div className="rounded-2xl border border-amber-700/60 bg-black/40 p-4 backdrop-blur-xl shadow-[0_0_25px_rgba(251,191,36,0.12)]">
          <h2 className="mb-3 flex items-center gap-2 text-lg font-extrabold tracking-wide text-transparent bg-clip-text bg-gradient-to-r from-amber-300 via-amber-400 to-yellow-500">
            <IconHistory size={18} /> Rounds History
          </h2>

          {/* Match summary */}
          <div className="mb-4 flex items-center justify-between gap-2 rounded-xl border border-cyan-700/30 bg-[#020617]/60 px-3 py-2 text-xs">
            <span className="text-white/70">
              Wager{" "}
              <span className="font-bold text-yellow-300">
                {betAmount.toLocaleString()}
              </span>
            </span>
            <span className="text-white/70">
              Round <span className="font-bold text-cyan-300">{currentRound}</span>
              <span className="text-white/40"> /7</span>
            </span>
          </div>

          {history.length === 0 ? (
            <p className="text-sm text-white/50">
              No rounds played yet. The history of every throw will show
              up here.
            </p>
          ) : (
            <ul className="space-y-2 max-h-[420px] overflow-auto pr-1">
              {[...history].reverse().map((entry, idx) => {
                const myThrow = viewerIsPlayer1 ? entry.player1Choice : entry.player2Choice;
                const oppThrow = viewerIsPlayer1 ? entry.player2Choice : entry.player1Choice;
                const won =
                  entry.winner === "tie"
                    ? null
                    : entry.winner === (viewerIsPlayer1 ? "player1" : "player2");
                return (
                  <li
                    key={`${entry.round}-${idx}`}
                    className={`flex items-center justify-between gap-2 rounded-xl border px-3 py-2 text-sm ${
                      won === null
                        ? "border-gray-600/40 bg-gray-800/30"
                        : won
                          ? "border-blue-500/40 bg-blue-500/10"
                          : "border-red-500/40 bg-red-500/10"
                    }`}
                  >
                    <span className="text-[10px] font-bold uppercase tracking-widest text-white/50">
                      R{entry.round}
                    </span>
                    <span className="flex items-center gap-1.5">
                      {getChoiceIcon(myThrow, 20)}
                      <span className="text-[10px] text-white/40">vs</span>
                      {getChoiceIcon(oppThrow, 20)}
                    </span>
                    <span
                      className={`text-[10px] font-black uppercase tracking-wider ${
                        won === null
                          ? "text-gray-400"
                          : won
                            ? "text-blue-300"
                            : "text-red-300"
                      }`}
                    >
                      {won === null ? "Tie" : won ? "Win" : "Loss"}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </aside>

      {/* ── Main board ── */}
      <motion.main
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: "easeOut" }}
        className="flex-1 flex flex-col items-center justify-start md:justify-center gap-6 md:gap-8 ml-0 md:ml-6 w-full px-3 sm:px-4 pb-10"
      >
        <h1 className="text-2xl sm:text-3xl font-extrabold tracking-wide text-transparent bg-clip-text bg-gradient-to-r from-amber-300 via-amber-400 to-yellow-500 drop-shadow-[0_0_18px_rgba(251,191,36,0.5)] text-center">
          Rock Paper Scissors
        </h1>

        {/* Round tracker — blue won / red lost, brawl-stars style */}
        <div className="w-full max-w-md rounded-2xl border border-cyan-700/30 bg-black/30 px-4 py-3 backdrop-blur-xl">
          <RoundMarkers total={7} myWins={myWins} oppWins={oppWins} myLabel={myName} oppLabel={opponentName} />
        </div>

        <div className="w-full max-w-2xl flex flex-col items-center gap-4">
          <div className="w-full flex items-center justify-between sm:justify-center gap-4 sm:gap-10 text-xs sm:text-sm text-[#a8f4ff] font-semibold px-2">
            <span className="relative">{myName}<EmoteBubble emote={myEmote} side="mine" /></span>
            <span className="relative">{opponentName}<EmoteBubble emote={incomingEmote} /></span>
          </div>

          <div className="flex items-center justify-center gap-4 sm:gap-8 flex-wrap">
            <motion.div
              initial={{ scale: 0.5, opacity: 0, rotate: -15 }}
              animate={{ scale: 1, opacity: 1, rotate: 0 }}
              transition={{ type: "spring", stiffness: 300, damping: 12 }}
              className="bg-[#0b224f] border border-[#00e5ff] w-24 h-28 sm:w-28 sm:h-36 flex items-center justify-center rounded-xl text-4xl sm:text-5xl"
            >
              {getChoiceIcon(myChoice, 44)}
            </motion.div>
            <div className="text-2xl sm:text-3xl font-bold text-[#7cefff]">VS</div>
            <motion.div
              initial={{ scale: 0.5, opacity: 0, rotate: 15 }}
              animate={{ scale: 1, opacity: 1, rotate: 0 }}
              transition={{ type: "spring", stiffness: 300, damping: 12, delay: 0.15 }}
              className="bg-[#0b224f] border border-[#00e5ff] w-24 h-28 sm:w-28 sm:h-36 flex items-center justify-center rounded-xl text-4xl sm:text-5xl"
            >
              {status === "finished" || (status === "matched" && myChoice && opponentChoice)
                ? getChoiceIcon(opponentChoice, 44)
                : <IconQuestionMark size={36} className="text-[#7cefff]" />}
            </motion.div>
          </div>

          {message && <p className="text-sm text-yellow-200 text-center">{message}</p>}

          {status === "active" && (
            <button
              onClick={cancelGame}
              disabled={actionLoading}
              className="bg-red-600 hover:bg-red-700 px-6 py-3 rounded font-bold disabled:opacity-50"
            >
              Cancel Waiting Game
            </button>
          )}

          {status === "matched" && !myChoice && (
            <>
              <button
                onClick={handleForfeit}
                disabled={forfeiting}
                className="mt-1 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-2 text-xs font-bold text-red-300 hover:bg-red-500/25 disabled:opacity-50"
              >
                {forfeiting ? "Forfeiting…" : "Forfeit match"}
              </button>
              <p className="text-sm text-yellow-300 font-semibold">
                Choose your move within: {countdown ?? CHOICE_SECONDS}s
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 w-full max-w-[420px]">
                {PVP_CHOICES.map((choice) => (
                  <button
                    key={choice}
                    onClick={() => chooseMove(choice)}
                    disabled={actionLoading}
                    className="px-5 py-2 rounded-lg font-bold bg-[#f5ff3b] hover:bg-[#d9e332] disabled:opacity-50 flex items-center justify-center gap-2"
                  >
                    {getChoiceIcon(choice, 20)}
                    {choice}
                  </button>
                ))}
              </div>

              {/* Emotes */}
              <div className="flex justify-center pt-1">
                <EmotePicker
                  compact
                  hideBubbles
                  incomingEmote={incomingEmote}
                  myEmote={myEmote}
                  onSend={(emote) => sendEmote(emote)}
                />
              </div>
            </>
          )}

          {status === "finished" && (
            <div className="text-center">
              <AnimatePresence>
                <motion.p
                  initial={{ scale: 0, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  transition={{ type: "spring", stiffness: 400, damping: 15 }}
                  className={`text-xl font-bold ${
                    winner === "you" ? "text-[#00ffa6]" : winner === "opponent" ? "text-red-400" : "text-gray-400"
                  }`}
                >
                  {winner === "you" && <IconTrophy size={24} className="inline" />}{" "}
                  {winner === "you"
                    ? "You win the match!"
                    : winner === "opponent"
                      ? "You lose the match."
                      : "It's a tie."}
                  {winner === "opponent" && <IconSkull size={20} className="inline" />}
                </motion.p>
              </AnimatePresence>
              <p className="text-lg mt-2">
                Score: <span className="text-blue-400 font-bold">{myWins}</span> –{" "}
                <span className="text-red-400 font-bold">{oppWins}</span>
              </p>
              {winner === "you" && (
                <p className="text-green-300">
                  You won {winnerPayout ?? 0} tokens total
                  {typeof winnerProfit === "number" ? ` (+${winnerProfit} profit)` : ""}.
                </p>
              )}
              {winner === "opponent" && <p className="text-red-300">You won 0 tokens this match.</p>}
              {typeof houseFee === "number" && winner !== "tie" && (
                <p className="text-xs text-gray-300">House fee (10%): {houseFee} tokens.</p>
              )}
              {typeof tokens === "number" && (
                <p className="text-sm text-yellow-200">Your balance: {tokens.toLocaleString()}</p>
              )}
              <div className="mt-3 flex items-center justify-center gap-3">
                <button
                  onClick={() => router.push("/casino/rps")}
                  className="bg-[#f5ff3b] hover:bg-[#d9e332] px-4 py-2 rounded font-semibold"
                >
                  Back to Lobby
                </button>
              </div>
            </div>
          )}

          {player2Id && (
            <button
              onClick={() => setShowReportModal(true)}
              className="mt-2 text-xs text-slate-500 hover:text-red-400 transition underline underline-offset-4"
            >
              <span className="inline-flex items-center gap-1">
                <IconFlag size={12} /> Report Player
              </span>
            </button>
          )}
        </div>
      </motion.main>

      <ReportModal
        isOpen={showReportModal}
        onClose={() => setShowReportModal(false)}
        onSubmit={async (reason, details) => {
          const opponentId =
            player1Id && player2Id
              ? player1Id === user?.id
                ? player2Id
                : player1Id
              : "";
          const res = await fetch("/api/reports/submit", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              reportedClerkId: opponentId,
              gameType: "rps",
              gameId: String(gameId),
              reason,
              details: details || undefined,
            }),
          });
          const data = await res.json();
          if (!data.success) throw new Error(data.error || "Failed to submit report");
        }}
        reportedPlayerName={opponentName || "Opponent"}
        gameType="Rock Paper Scissors"
      />
      </div>
      </CreatorResponsiveLayout>
      </CreatorModeHost>
      <Footer />
    </div>
  );
}

function getChoiceIcon(choice: Choice | null, size = 44) {
  switch (choice) {
    case "rock":
      return <RockFistIcon size={size} className="text-[#a855f7]" />;
    case "paper":
      return <IconHandStop size={size} className="text-[#00e5ff]" />;
    case "scissors":
      return <IconScissors size={size} className="text-[#ff4fd8]" />;
    default:
      return <IconQuestionMark size={size} className="text-[#7cefff]" />;
  }
}
