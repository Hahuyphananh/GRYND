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
//
// ?onboarding=1 (from the /welcome first-match step) reuses this exact game
// as the first-game tutorial: a one-line hint before the first throw, then
// at the terminal state the shared PvpResultScreen shows the one-time
// first-match XP bonus + Battle Pass progress with a "View Battle Pass"
// next step. Completion is claimed server-side exactly once
// (/api/onboarding/first-game-complete) so refresh/double-taps can never
// double-grant XP. Everyone else — including replays after onboarding —
// gets plain free practice, unchanged.

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { playVictory, playDefeat, playTick, playGoodReveal, playBuzz } from "../../../../lib/gameAudio";
import { motion, AnimatePresence } from "framer-motion";
// Page-level session host: records "recently played" and beats
// active-player presence, driven by the game's REAL lifecycle
// (autoStart/autoStop) — never by page load.
import GameSessionHost from "../../../../components/GameSessionHost";


import NavigationBar from "../../../../components/navigation-bar";
import PvpResultScreen from "../../../../components/result/PvpResultScreen";
import Footer from "../../../../components/Footer";
import RoundMarkers from "../../../../components/casino/RoundMarkers";
import FrameAvatar from "../../../../components/FrameAvatar";
import { cosmeticEffectClass } from "../../../../lib/profileCosmetics";
import useMySeatIdentity from "../../../../hooks/useMySeatIdentity";
import { RockFistIcon } from "../../../../components/icons/CustomIcons";
import {
  coerceAiDifficulty,
  readStoredAiDifficulty,
  type AiDifficulty,
} from "../../../../lib/aiDifficulty";
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

// ── Round-advance control ─────────────────────────────────
function RoundAdvance({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="border-b-4 border-amber-700 bg-amber-500 text-black px-6 py-2.5 rounded-xl font-bold shadow-[0_0_20px_rgba(251,191,36,0.4)] hover:brightness-110 transition"
    >
      {label}
    </button>
  );
}

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

/**
 * Pattern-reading AI — counters your most common throw. How often it reads
 * your pattern is the difficulty: an easy bot throws purely at random, the
 * `normal` tier keeps the 50% read it shipped with, and a hard bot mostly
 * counters what it has seen.
 */
function getAIChoice(
  playerHistory: { playerChoice: Choice }[],
  difficulty: AiDifficulty = "normal",
): Choice {
  const tier = coerceAiDifficulty(difficulty);
  const readChance = tier === "easy" ? 0 : tier === "hard" ? 0.85 : 0.5;
  if (playerHistory.length > 0 && Math.random() < readChance) {
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

type FirstMatchBonus = {
  alreadyCompleted: boolean;
  xpGranted: number;
  fromLevel: number;
  fromXp: number;
  toLevel: number;
  toXp: number;
  leveledUp: boolean;
};

// Tutorial framing states. "checking" verifies the server flag on mount;
// "active" means the first-match bonus is still owed; "complete" means the
// terminal state was reached (bonus = server response, or null when the
// claim POST failed and the match result must degrade gracefully).
type TutorialState =
  | { mode: "off" }
  | { mode: "checking" }
  | { mode: "active" }
  | { mode: "complete"; bonus: FirstMatchBonus | null };

export default function RPSPlayAiPage({ onboarding = false }: { onboarding?: boolean }) {
  const router = useRouter();
  // Real username / official Grynd icon / equipped name color for the
  // human seat (client-side game — no server match payload).
  const myIdentity = useMySeatIdentity();
  const myDisplayName = myIdentity.name || "You";

  // The tier chosen in the lobby (remembered per game by the shared picker).
  const [aiDifficulty] = useState<AiDifficulty>(() =>
    readStoredAiDifficulty("rps"),
  );
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

  // Tutorial (first-match) framing, only when launched from the welcome flow.
  const [tutorial, setTutorial] = useState<TutorialState>(() =>
    onboarding ? { mode: "checking" } : { mode: "off" },
  );
  const bonusPostedRef = useRef(false);
  const tutorialActive = tutorial.mode === "active";

  const play = async (choice: Choice) => {
    if (phase !== "picking" || aiThinking) return;

    setPlayerChoice(choice);
    setPhase("revealing");
    setAiThinking(true);
    setAiChoice(null);
    setLastResult(null);

    // Small "thinking" delay so the reveal feels like a real opponent.
    await new Promise((r) => setTimeout(r, 550 + Math.random() * 350));

    const ai = getAIChoice(history, aiDifficulty);
    const result = getResult(choice, ai);
    setAiChoice(ai);
    setLastResult(result);

    // Round audio — fires with the reveal.
    if (result === "win") playGoodReveal();
    else if (result === "lose") playBuzz();
    else playTick();

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
      // Match-over audio — fanfare on a win, defeat otherwise.
      if (myWins >= ROUNDS_TO_WIN) playVictory();
      else playDefeat();
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

  // After the first-match bonus was granted (or its claim failed), further
  // matches are plain free practice — the tutorial must never stick around.
  const restartAfterFirstMatch = () => {
    if (tutorial.mode === "complete" && !tutorial.bonus) {
      // The claim POST failed earlier — retry it on the next finished match.
      bonusPostedRef.current = false;
      setTutorial({ mode: "active" });
    } else {
      setTutorial({ mode: "off" });
    }
    restart();
  };

  // Mount: verify whether the first-match bonus is still owed. A fresh
  // account (firstGameCompleted === false) keeps the tutorial framing;
  // everyone else plays plain free practice. Fail-open on network errors so
  // the game is never blocked by the onboarding API.
  useEffect(() => {
    if (tutorial.mode !== "checking") return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/onboarding/status", {
          credentials: "include",
        });
        const data = await res.json();
        if (cancelled) return;
        if (res.ok && data?.success === true && data.firstGameCompleted === false) {
          setTutorial({ mode: "active" });
        } else {
          setTutorial({ mode: "off" });
        }
      } catch {
        if (!cancelled) setTutorial({ mode: "off" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tutorial]);

  // Real terminal state only (matchOver, not merely opening the game): claim
  // the one-time completion + XP bonus. The server-side claim is atomic and
  // idempotent, so refresh / double-taps / extra tabs can never double-grant.
  useEffect(() => {
    if (tutorial.mode !== "active" || !matchOver) return;
    if (bonusPostedRef.current) return;
    bonusPostedRef.current = true;
    let cancelled = false;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    (async () => {
      try {
        const res = await fetch("/api/onboarding/first-game-complete", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
        });
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok || data?.success !== true) throw new Error("first-game-complete failed");
        if (data.alreadyCompleted === true) {
          // Another tab/session already claimed the bonus — plain free play.
          setTutorial({ mode: "off" });
          return;
        }
        setTutorial({ mode: "complete", bonus: data });
      } catch {
        // Graceful degradation: show the normal result (no XP rows); the
        // bonus claim retries on the next finished match via Play Again.
        if (!cancelled) setTutorial({ mode: "complete", bonus: null });
      } finally {
        clearTimeout(timeout);
      }
    })();
    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [tutorial, matchOver]);

  return (
    <div className="min-h-screen overflow-x-hidden bg-gradient-to-b from-[#0a0118] to-[#061b3d] pb-28 pt-16 text-white md:pb-8">
      <NavigationBar currentPath="/casino" />

      <GameSessionHost
        autoStart={phase !== "picking"}
        autoStop={matchOver}
        gameLabel="rock-paper-scissors-ai"
      >
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
          <div className="mb-2 flex items-center justify-center gap-5 text-xs font-semibold text-[#a8f4ff]">
            <span className="inline-flex items-center gap-1.5">
              <FrameAvatar frame={myIdentity.profileFrame} iconKey={myIdentity.iconKey} name={myDisplayName} size="h-4 w-4" />
              <span
                className={cosmeticEffectClass(myIdentity.profileFrame?.usernameEffect?.visual) || undefined}
                style={myIdentity.nameColor ? { color: myIdentity.nameColor } : undefined}
              >
                {myDisplayName}
              </span>
            </span>
            <span className="inline-flex items-center gap-1.5">
              <IconRobot size={14} className="text-cyan-300" />
              AI
            </span>
          </div>
          <RoundMarkers total={TOTAL_ROUNDS} myWins={myWins} oppWins={aiWins} myLabel={myDisplayName} oppLabel="AI" />
        </div>

        {/* Onboarding tutorial — one contextual hint before the first throw,
            then it disappears and the real game teaches the rest. */}
        {tutorialActive && phase === "picking" && history.length === 0 && (
          <div className="w-full max-w-md rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-2.5 text-center text-xs leading-relaxed text-amber-100/90 backdrop-blur-sm">
            <span className="font-black uppercase tracking-wider text-amber-300">Free Play vs AI</span>
            <span className="mx-1.5 text-amber-200/40">·</span>No tokens at risk
            <span className="mx-1.5 text-amber-200/40">·</span>First to 4 wins
            <br />
            <span className="text-amber-100/70">
              The AI learns your most common throw — mix it up to beat it.
            </span>
          </div>
        )}

        {matchOver ? (
          tutorial.mode === "active" ? (
            // Claim in flight — brief spinner so the result screen mounts once
            // (avoids a flash + double confetti from the vanilla result).
            <div className="flex w-full max-w-md items-center justify-center rounded-2xl border border-cyan-700/30 bg-black/40 px-8 py-10 backdrop-blur-xl">
              <div className="flex flex-col items-center gap-4">
                <div className="h-10 w-10 animate-spin rounded-full border-4 border-[#00e5ff]/20 border-t-[#00e5ff]" />
                <p className="text-sm font-semibold text-[#9dd8ff]">Finishing your first match…</p>
              </div>
            </div>
          ) : tutorial.mode === "complete" && tutorial.bonus && !tutorial.bonus.alreadyCompleted ? (
            // First-match progression moment: real server numbers for the XP
            // and Battle Pass rows, then a clear next step.
            <PvpResultScreen
              open
              outcome={wonMatch ? "win" : "loss"}
              headline={
                wonMatch
                  ? "You win your first free match!"
                  : "First match done — the AI got you this time."
              }
              subline="Free practice — no tokens at risk. Finishing your first match earned a one-time XP bonus for your Battle Pass."
              gameName="RPS vs AI"
              opponent={{ name: "AI", iconKey: null, isAi: true }}
              xp={tutorial.bonus.xpGranted > 0 ? tutorial.bonus.xpGranted : null}
              progress={
                tutorial.bonus.leveledUp
                  ? [
                      {
                        label: "Battle Pass",
                        from: String(tutorial.bonus.fromLevel),
                        to: String(tutorial.bonus.toLevel),
                        percent: 100,
                      },
                    ]
                  : []
              }
              summary={[
                { label: "Final Score", value: `${myWins} – ${aiWins}` },
                { label: "Rounds", value: `${history.length} of ${TOTAL_ROUNDS}` },
              ]}
              playAgain={{
                label: "View Battle Pass",
                onClick: () => router.push("/battlepass"),
              }}
              rematch={{ label: "RUN IT BACK", onClick: restartAfterFirstMatch }}
              onReturnToLobby={() => router.push("/casino/rps")}
            />
          ) : (
            // Default result — plain free practice. In tutorial mode this
            // also covers the "bonus claim pending/failed" fallback, so Play
            // Again stays retry-aware (restartAfterFirstMatch resets the
            // claim gate; for plain players it is identical to restart).
            <PvpResultScreen
              open
              outcome={wonMatch ? "win" : "loss"}
              headline={wonMatch ? "You win the best of 7!" : "The AI wins the best of 7."}
              subline="Free practice match — no tokens were staked."
              gameName="RPS vs AI"
              opponent={{ name: "AI", iconKey: null, isAi: true }}
              summary={[
                { label: "Final Score", value: `${myWins} – ${aiWins}` },
                { label: "Rounds", value: `${history.length} of ${TOTAL_ROUNDS}` },
              ]}
              playAgain={{ onClick: restartAfterFirstMatch }}
              onReturnToLobby={() => router.push("/casino/rps")}
            />
          )
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
                <RoundAdvance
                  label={
                    myWins >= ROUNDS_TO_WIN || aiWins >= ROUNDS_TO_WIN
                      ? "See Result"
                      : "Next Round"
                  }
                  onClick={nextRound}
                />
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
      </GameSessionHost>
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
