"use client";

// ── RPS vs AI — free best-of-7 sandbox ─────────────────────────────────
// Fully client-side: no wager, no REST, no sockets. First to 4 round
// wins takes the match. Round tracker dots at the top (blue = rounds you
// won, red = rounds the AI won) and a rounds-history sidebar listing
// every throw from both sides.
//
// The AI reads your most common throw and counters it ~half the time,
// so a predictable player gets punished — beat it by mixing up your
// patterns. No tokens are ever wagered.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import NavigationBar from "../../../../components/navigation-bar";
import Footer from "../../../../components/Footer";
import RoundMarkers from "../../../../components/casino/RoundMarkers";
import { RockFistIcon } from "../../../../components/icons/CustomIcons";
import {
  IconHandStop,
  IconScissors,
  IconQuestionMark,
  IconTrophy,
  IconSkull,
  IconRobot,
  IconHistory,
} from "@tabler/icons-react";

const CHOICES = ["rock", "paper", "scissors"] as const;
const ROUNDS_TO_WIN = 4;
const TOTAL_ROUNDS = 7;

type Choice = (typeof CHOICES)[number];
type RoundResult = "win" | "lose" | "tie";
type HistoryEntry = {
  round: number;
  playerChoice: Choice;
  aiChoice: Choice;
  result: RoundResult;
};

const COUNTER: Record<Choice, Choice> = {
  rock: "paper",
  paper: "scissors",
  scissors: "rock",
};

function randomChoice(): Choice {
  return CHOICES[Math.floor(Math.random() * CHOICES.length)];
}

/** Light pattern-reading AI — counters your most common throw 50% of the time. */
function getAIChoice(playerHistory: { playerChoice: Choice }[]): Choice {
  if (playerHistory.length > 0 && Math.random() < 0.5) {
    const counts: Record<Choice, number> = { rock: 0, paper: 0, scissors: 0 };
    for (const h of playerHistory) counts[h.playerChoice] += 1;
    const most = (Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0] as Choice);
    return COUNTER[most];
  }
  return randomChoice();
}

function getResult(player: Choice, ai: Choice): RoundResult {
  if (player === ai) return "tie";
  if (COUNTER[ai] === player) return "win";
  return "lose";
}

export default function RPSPlayAiPage() {
  const router = useRouter();

  const [myWins, setMyWins] = useState(0);
  const [aiWins, setAiWins] = useState(0);
  const [roundNumber, setRoundNumber] = useState(1);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [playerChoice, setPlayerChoice] = useState<Choice | null>(null);
  const [aiChoice, setAiChoice] = useState<Choice | null>(null);
  const [lastResult, setLastResult] = useState<RoundResult | null>(null);
  const [phase, setPhase] = useState<"picking" | "revealing" | "matchOver">("picking");
  const [aiThinking, setAiThinking] = useState(false);

  const matchOver = phase === "matchOver";
  const wonMatch = myWins >= ROUNDS_TO_WIN;

  const play = async (choice: Choice) => {
    if (phase !== "picking" || aiThinking) return;

    setPlayerChoice(choice);
    setPhase("revealing");
    setAiThinking(true);
    setAiChoice(null);
    setLastResult(null);

    // Small "thinking" delay so the reveal feels like a real opponent.
    await new Promise((r) => setTimeout(r, 550 + Math.random() * 350));

    const ai = getAIChoice(history);
    const result = getResult(choice, ai);
    setAiChoice(ai);
    setLastResult(result);

    if (result === "win") setMyWins((w) => w + 1);
    else if (result === "lose") setAiWins((w) => w + 1);

    setHistory((h) => [
      ...h,
      { round: roundNumber, playerChoice: choice, aiChoice: ai, result },
    ]);

    setAiThinking(false);
  };

  const nextRound = () => {
    if (myWins >= ROUNDS_TO_WIN || aiWins >= ROUNDS_TO_WIN) {
      setPhase("matchOver");
      return;
    }
    setRoundNumber((r) => r + 1);
    setPlayerChoice(null);
    setAiChoice(null);
    setLastResult(null);
    setPhase("picking");
  };

  const restart = () => {
    setMyWins(0);
    setAiWins(0);
    setRoundNumber(1);
    setHistory([]);
    setPlayerChoice(null);
    setAiChoice(null);
    setLastResult(null);
    setPhase("picking");
  };

  return (
    <div className="min-h-screen overflow-x-hidden bg-gradient-to-b from-[#0a0118] to-[#061b3d] pb-28 pt-16 text-white md:pb-8">
      <NavigationBar currentPath="/casino" />

      <div className="flex flex-col md:flex-row">
      {/* ── Left sidebar: rounds history ── */}
      <aside className="w-[95%] sm:w-full max-w-[420px] md:max-w-[340px] mx-auto md:mx-0 mb-6 md:mb-0 md:ml-4 md:self-start md:sticky md:top-20">
        <div className="rounded-2xl border border-amber-700/60 bg-black/40 p-4 backdrop-blur-xl shadow-[0_0_25px_rgba(251,191,36,0.12)]">
          <h2 className="mb-3 flex items-center gap-2 text-lg font-extrabold tracking-wide text-transparent bg-clip-text bg-gradient-to-r from-amber-300 via-amber-400 to-yellow-500">
            <IconHistory size={18} /> Rounds History
          </h2>

          <div className="mb-4 flex items-center justify-between gap-2 rounded-xl border border-cyan-700/30 bg-[#020617]/60 px-3 py-2 text-xs">
            <span className="inline-flex items-center gap-1.5 text-white/70">
              <IconRobot size={13} className="text-cyan-300" />
              Free play
            </span>
            <span className="text-white/70">
              Round <span className="font-bold text-cyan-300">{roundNumber}</span>
              <span className="text-white/40"> /7</span>
            </span>
          </div>

          {history.length === 0 ? (
            <p className="text-sm text-white/50">
              No rounds played yet. Every throw from you and the AI will
              show up here.
            </p>
          ) : (
            <ul className="space-y-2 max-h-[420px] overflow-auto pr-1">
              {[...history].reverse().map((entry, idx) => (
                <li
                  key={`${entry.round}-${idx}`}
                  className={`flex items-center justify-between gap-2 rounded-xl border px-3 py-2 text-sm ${
                    entry.result === "tie"
                      ? "border-gray-600/40 bg-gray-800/30"
                      : entry.result === "win"
                        ? "border-blue-500/40 bg-blue-500/10"
                        : "border-red-500/40 bg-red-500/10"
                  }`}
                >
                  <span className="text-[10px] font-bold uppercase tracking-widest text-white/50">
                    R{entry.round}
                  </span>
                  <span className="flex items-center gap-1.5">
                    {getChoiceIcon(entry.playerChoice, 20)}
                    <span className="text-[10px] text-white/40">vs</span>
                    {getChoiceIcon(entry.aiChoice, 20)}
                  </span>
                  <span
                    className={`text-[10px] font-black uppercase tracking-wider ${
                      entry.result === "tie"
                        ? "text-gray-400"
                        : entry.result === "win"
                          ? "text-blue-300"
                          : "text-red-300"
                    }`}
                  >
                    {entry.result === "tie" ? "Tie" : entry.result === "win" ? "Win" : "Loss"}
                  </span>
                </li>
              ))}
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

        {/* Round tracker — blue won / red lost */}
        <div className="w-full max-w-md rounded-2xl border border-cyan-700/30 bg-black/30 px-4 py-3 backdrop-blur-xl">
          <RoundMarkers total={TOTAL_ROUNDS} myWins={myWins} oppWins={aiWins} myLabel="You" oppLabel="AI" />
        </div>

        {matchOver ? (
          <div className="text-center">
            <motion.p
              initial={{ scale: 0, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ type: "spring", stiffness: 400, damping: 15 }}
              className={`text-2xl font-bold ${
                wonMatch
                  ? "text-[#00ffa6] drop-shadow-[0_0_15px_rgba(0,255,166,1)]"
                  : "text-red-400"
              }`}
            >
              {wonMatch ? <IconTrophy size={26} className="inline" /> : <IconSkull size={22} className="inline" />}{" "}
              {wonMatch ? "You win the best of 7!" : "The AI wins the best of 7."}
            </motion.p>
            <p className="mt-2 text-lg">
              Final score: <span className="text-blue-400 font-bold">{myWins}</span> –{" "}
              <span className="text-red-400 font-bold">{aiWins}</span>
            </p>
            <div className="mt-4 flex items-center justify-center gap-3">
              <button
                onClick={restart}
                className="border-b-4 border-amber-700 bg-amber-500 text-black px-5 py-2.5 rounded-xl font-bold shadow-[0_0_20px_rgba(251,191,36,0.4)] hover:brightness-110 transition"
              >
                Play Again
              </button>
              <button
                onClick={() => router.push("/casino/rps")}
                className="border-b-4 border-cyan-700 bg-cyan-500 text-black px-5 py-2.5 rounded-xl font-bold shadow-[0_0_20px_rgba(34,211,238,0.4)] hover:brightness-110 transition"
              >
                Back to Lobby
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="flex flex-col sm:flex-row items-center justify-center gap-5 sm:gap-10 w-full">
              <motion.div
                initial={{ scale: 0.5, opacity: 0, rotate: -15 }}
                animate={{ scale: 1, opacity: 1, rotate: 0 }}
                transition={{ type: "spring", stiffness: 300, damping: 12 }}
                className="bg-[#020617]/80 backdrop-blur-xl border border-[#00e5ff]/40 shadow-[0_0_20px_rgba(0,229,255,0.2)] w-24 h-32 sm:w-32 sm:h-44 flex items-center justify-center rounded-xl text-5xl sm:text-6xl"
              >
                {getChoiceIcon(playerChoice, 48)}
              </motion.div>

              <motion.div
                animate={{ scale: [1, 1.1, 1] }}
                transition={{ duration: 1.5, repeat: Infinity }}
                className="text-2xl sm:text-3xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-[#a855f7] to-[#ff4fd8]"
              >
                VS
              </motion.div>

              <motion.div
                initial={{ scale: 0.5, opacity: 0, rotate: 15 }}
                animate={{ scale: 1, opacity: 1, rotate: 0 }}
                transition={{ type: "spring", stiffness: 300, damping: 12, delay: 0.2 }}
                className="bg-[#020617]/80 backdrop-blur-xl border border-[#00e5ff]/40 shadow-[0_0_20px_rgba(0,229,255,0.2)] w-24 h-32 sm:w-32 sm:h-44 flex items-center justify-center rounded-xl text-5xl sm:text-6xl"
              >
                {aiThinking ? (
                  <IconRobot size={40} className="text-[#7cefff] animate-pulse" />
                ) : (
                  getChoiceIcon(aiChoice, 48)
                )}
              </motion.div>
            </div>

            <AnimatePresence mode="wait">
              {lastResult && (
                <motion.div
                  key={lastResult}
                  initial={{ scale: 0, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  exit={{ scale: 0, opacity: 0 }}
                  transition={{ type: "spring", stiffness: 400, damping: 15 }}
                  className={`text-2xl font-bold ${
                    lastResult === "win"
                      ? "text-[#00ffa6] drop-shadow-[0_0_15px_rgba(0,255,166,1)]"
                      : lastResult === "lose"
                        ? "text-red-400"
                        : "text-gray-400"
                  }`}
                >
                  {lastResult === "win" && <IconTrophy size={24} className="inline" />}{" "}
                  {lastResult.toUpperCase()}
                  {lastResult === "lose" && <IconSkull size={20} className="inline" />}
                </motion.div>
              )}
            </AnimatePresence>

            {phase === "picking" ? (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 w-full max-w-[420px]">
                {CHOICES.map((choice) => (
                  <button
                    key={choice}
                    onClick={() => play(choice)}
                    disabled={aiThinking}
                    className={`w-full px-4 py-3 rounded-xl font-bold text-sm sm:text-base transition-all duration-300 flex items-center justify-center gap-2 ${
                      playerChoice === choice
                        ? "bg-gradient-to-r from-[#a855f7] to-[#ff4fd8] text-white shadow-[0_0_25px_#ff4fd8] scale-105"
                        : "bg-[#020617] border border-[#00e5ff]/30 text-white hover:border-[#00e5ff] hover:shadow-[0_0_15px_rgba(0,229,255,0.6)]"
                    }`}
                  >
                    {getChoiceIcon(choice, 22)}
                    {choice}
                  </button>
                ))}
              </div>
            ) : (
              !aiThinking && (
                <button
                  onClick={nextRound}
                  className="border-b-4 border-amber-700 bg-amber-500 text-black px-6 py-2.5 rounded-xl font-bold shadow-[0_0_20px_rgba(251,191,36,0.4)] hover:brightness-110 transition"
                >
                  {myWins >= ROUNDS_TO_WIN || aiWins >= ROUNDS_TO_WIN
                    ? "See Result"
                    : "Next Round"}
                </button>
              )
            )}

            <div className="text-center">
              <p className="text-xl">
                <span className="text-transparent bg-clip-text bg-gradient-to-r from-[#a855f7] to-[#ff4fd8] font-bold">
                  Score:
                </span>{" "}
                <span className="text-blue-400 font-bold">{myWins}</span> –{" "}
                <span className="text-red-400 font-bold">{aiWins}</span>
              </p>
            </div>
          </>
        )}
      </motion.main>
      </div>
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
