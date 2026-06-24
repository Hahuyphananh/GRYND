"use client";

// ── Solo test page for the Precision reaction-time game ─────────────────
//
// Mirrors the visual treatment of the PvP active phase but is fully
// client-side:
//   * No REST, no sockets, no wager, no opponent, no payout.
//   * All timing is local — we roll our own arming delay and use
//     `performance.now()` for the GO→STOP elapsed measurement.
//   * The user gets a 5-round stats run with avg / best / worst
//     reaction time and a zone distribution grading their reactions
//     against canonical reaction-time thresholds (Elite / Sharp /
//     Solid / Casual / Off).
//
// The per-round `targetMs` field is still rolled (random 2.5–10s) so
// the active phase mirrors the PvP arming/reveal beat, but it is NOT
// used as a scoring input — the user can't meaningfully hit a 2.5–
// 10s target with a 100–500ms reaction, so grading on
// |reaction − target| would always classify as "Off". We display the
// target for visual parity with the real match but the metric surface
// grades on reaction time alone.
//
// We deliberately do NOT reuse `PrecisionScoreboard` /
// `PrecisionRoundResultPanel` here — those are designed for the 2-seat
// PvP shape. The solo UX has no opponent, so embedding fake "you /
// ghost" players would just be prop-shim noise. The visual language
// (fuchsia-cyan-yellow accents, dark teal backdrop, pulsing arming
// indicator, oversized STOP button) intentionally mirrors the match
// page so the demo feels like a real round.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { usePostHog } from "posthog-js/react";
import { AnimatePresence, motion } from "framer-motion";

import NavigationBar from "../../../../components/navigation-bar";
import { useTranslation } from "../../../../hooks/useTranslation";
import Footer from "../../../../components/Footer";
import {
  MAX_DELAY_MS,
  MAX_ROUNDS,
  MAX_TARGET_MS,
  MIN_DELAY_MS,
  MIN_TARGET_MS,
} from "../../../../lib/precision/constants";
import { fadeUp } from "../../../../lib/animations";
import {
  diffToRank,
  PRECISION_RANK_ENTRIES,
  RANK_LABELS,
  type PrecisionRank,
} from "../../../../lib/precision/utils";
import { playRankSound } from "../../../../lib/precisionAudio";

// ── Per-round telemetry. ──────────────────────────────────────────
// `diffMs = |elapsedMs - targetMs|` is the PRIMARY scoring input.
// The player tries to STOP exactly when the running timer matches
// the target; closer = better rank. `reactionMs` is kept for the
// per-round log (raw elapsed time) but grading uses `diffMs` only.
interface RoundStat {
  round: number;
  targetMs: number;
  elapsedMs: number;
  diffMs: number;
}

type TestPhase =
  | "idle"        // Initial landing — "Start Test" button.
  | "arming"      // Server-style random delay before the round opens.
  | "active"      // Target revealed; user react-clicks STOP.
  | "round-done" // Post-round overlay shown for ~1.6s before the next.
  | "finished";   // All 5 rounds played; show summary stats.

// Rank is based on |elapsedMs - targetMs| — how close the player
// landed to the server-style rolled target. Reuses the shared
// `diffToRank` from lib/precision/utils so the solo test and
// PvP round-result panel use identical thresholds.

// ── Personal-best persistence (localStorage) ──────────────────────
const PB_KEY = "precision:solo:personalBest";

interface PersonalBest {
  label: string;
  emoji: string;
  color: string;
  bestDiffMs: number;
}

function loadPersonalBest(): PersonalBest | null {
  try {
    const raw = localStorage.getItem(PB_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.label === "string") return parsed as PersonalBest;
    return null;
  } catch {
    return null;
  }
}

function savePersonalBest(pb: PersonalBest): void {
  try {
    localStorage.setItem(PB_KEY, JSON.stringify(pb));
  } catch {
    // Silently ignore — storage may be full or unavailable.
  }
}

/** Compare two rank labels: returns true if `a` is a better (lower-index)
 *  tier than `b`. Uses the canonical `PRECISION_RANK_ENTRIES` ordering. */
function isBetterRank(a: string, b: string): boolean {
  const idxA = PRECISION_RANK_ENTRIES.findIndex((e) => e.rank.label === a);
  const idxB = PRECISION_RANK_ENTRIES.findIndex((e) => e.rank.label === b);
  // Lower index = better. Unknown labels fall back conservatively.
  if (idxA === -1) return false;
  if (idxB === -1) return true;
  return idxA < idxB;
}

function rollArmingDelayMs(): number {
  // Random integer in [MIN_DELAY_MS, MAX_DELAY_MS] (inclusive).
  return Math.floor(MIN_DELAY_MS + Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS + 1));
}

function rollTargetMs(): number {
  // Random integer in [MIN_TARGET_MS, MAX_TARGET_MS] (inclusive).
  // This constant is "for show" only — the user already sees the GO
  // instant by way of the target appearing, so their elapsed time
  // won't be anywhere near `targetMs`. We're keeping the value for
  // parity with the PvP round UI.
  return Math.floor(MIN_TARGET_MS + Math.random() * (MAX_TARGET_MS - MIN_TARGET_MS + 1));
}

export default function PrecisionTestPage() {
  const router = useRouter();
  const posthog = usePostHog();
  const { t } = useTranslation();

  const [phase, setPhase] = useState<TestPhase>("idle");
  const [currentRound, setCurrentRound] = useState(1);
  const [targetMs, setTargetMs] = useState<number | null>(null);
  const [currentElapsedMs, setCurrentElapsedMs] = useState<number | null>(null);
  const [currentDiffMs, setCurrentDiffMs] = useState<number | null>(null);
  // Running-timer display — updated every ~16ms via rAF during the
  // active phase so the player sees a live counter of elapsed time.
  const [timerMs, setTimerMs] = useState(0);
  const timerRafRef = useRef<number | null>(null);
  const [history, setHistory] = useState<RoundStat[]>([]);
  // Personal best — loaded from localStorage on mount, updated when a
  // finished test produces a better best-rank than the stored value.
  const [personalBest, setPersonalBest] = useState<PersonalBest | null>(() => loadPersonalBest());

  // Tracks the GO instant for the ACTIVE phase — the wall-clock time at
  // which the arming timer flipped the round into "active" and the
  // target became visible. `performance.now()` is monotonic and
  // millisecond-resolution, which is exactly what we want for a
  // client-side reaction-time measurement.
  const goInstantRef = useRef<number | null>(null);
  // Race-proof single-click lock for STOP. Synchronously flipped on
  // click so a second tap in the same React batch hits the guard and
  // is rejected. Reset at the start of each round's "active" phase.
  const stopLockedRef = useRef<boolean>(false);
  // Cancel the arming timer if the component unmounts mid-arm so a
  // stale setTimeout can't fire `setState` on a torn-down tree.
  const armingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Cancel the round-done overlay auto-advance timer for the same
  // reason.
  const roundDoneTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Tracks which session we're on, so a fast double-tap on "Start"
  // doesn't open two arming timers racing each other.
  const sessionIdRef = useRef(0);

  // Cleanup: cancel all pending timers on unmount.
  useEffect(() => {
    return () => {
      if (armingTimerRef.current !== null) {
        clearTimeout(armingTimerRef.current);
        armingTimerRef.current = null;
      }
      if (roundDoneTimerRef.current !== null) {
        clearTimeout(roundDoneTimerRef.current);
        roundDoneTimerRef.current = null;
      }
      if (timerRafRef.current !== null) {
        cancelAnimationFrame(timerRafRef.current);
        timerRafRef.current = null;
      }
    };
  }, []);

  // ── Running timer (rAF loop) ───────────────────────────────────
  // Starts when the round flips to "active" and stops on STOP click
  // or phase change. Uses requestAnimationFrame so the display stays
  // smooth (compositor-thread) and doesn't spam React re-renders.
  const startTimer = useCallback(() => {
    if (goInstantRef.current === null) return;
    const tick = () => {
      if (goInstantRef.current === null) return;
      setTimerMs(performance.now() - goInstantRef.current);
      timerRafRef.current = requestAnimationFrame(tick);
    };
    timerRafRef.current = requestAnimationFrame(tick);
  }, []);
  const stopTimer = useCallback(() => {
    if (timerRafRef.current !== null) {
      cancelAnimationFrame(timerRafRef.current);
      timerRafRef.current = null;
    }
  }, []);

  const beginRound = useCallback((roundIndex: number) => {
    const session = sessionIdRef.current;
    stopTimer();
    setPhase("arming");
    setCurrentRound(roundIndex);
    setTargetMs(null);
    setCurrentElapsedMs(null);
    setCurrentDiffMs(null);
    setTimerMs(0);
    stopLockedRef.current = false;
    goInstantRef.current = null;

    if (armingTimerRef.current !== null) {
      clearTimeout(armingTimerRef.current);
    }
    armingTimerRef.current = setTimeout(() => {
      // Guard: if the user reset / abandoned / navigated away during
      // the arming delay, our `session` ref will no longer match the
      // active one and we should bail without flipping the state.
      if (sessionIdRef.current !== session) return;
      goInstantRef.current = performance.now();
      setTargetMs(rollTargetMs());
      setPhase("active");
      startTimer();
    }, rollArmingDelayMs());
  }, [startTimer, stopTimer]);

  const handleStart = useCallback(() => {
    posthog?.capture("precision_test_started");
    setHistory([]);
    sessionIdRef.current += 1;
    beginRound(1);
  }, [beginRound, posthog]);

  const handleRestart = useCallback(() => {
    posthog?.capture("precision_test_restarted");
    sessionIdRef.current += 1;
    if (roundDoneTimerRef.current !== null) {
      clearTimeout(roundDoneTimerRef.current);
      roundDoneTimerRef.current = null;
    }
    if (armingTimerRef.current !== null) {
      clearTimeout(armingTimerRef.current);
      armingTimerRef.current = null;
    }
    setHistory([]);
    beginRound(1);
  }, [beginRound, posthog]);

  const handleLeave = useCallback(() => {
    posthog?.capture("precision_test_abandoned", {
      roundsCompleted: history.length,
    });
    router.push("/casino/precision");
  }, [router, posthog, history.length]);

  const handleStop = useCallback(() => {
    if (phase !== "active") return;
    if (stopLockedRef.current) return;
    if (goInstantRef.current === null) return;
    stopLockedRef.current = true;
    stopTimer();
    const elapsedMs = performance.now() - goInstantRef.current;
    const target = targetMs ?? 0;
    const diffMs = Math.abs(elapsedMs - target);
    // Play the rank-appropriate sound effect
    playRankSound(diffMs);
    setCurrentElapsedMs(elapsedMs);
    setCurrentDiffMs(diffMs);
    const stat: RoundStat = {
      round: currentRound,
      targetMs: target,
      elapsedMs,
      diffMs,
    };
    setHistory((h) => [...h, stat]);
    posthog?.capture("precision_test_round_completed", {
      round: currentRound,
      elapsedMs,
      diffMs,
    });
    setPhase("round-done");
    if (currentRound >= MAX_ROUNDS) {
      // Last round — schedule the summary screen and emit the
      // match-completed analytics.
      roundDoneTimerRef.current = setTimeout(() => {
        setPhase("finished");
        posthog?.capture("precision_test_match_completed", {
          rounds: MAX_ROUNDS,
        });
      }, 1600);
    } else {
      roundDoneTimerRef.current = setTimeout(() => {
        beginRound(currentRound + 1);
      }, 1600);
    }
  }, [phase, currentRound, targetMs, beginRound, posthog, stopTimer]);

// === Derived summary stats ──────────────────────────────────
// All values grade on `diffMs` (|elapsedMs - targetMs|) — how
// close the player landed to the target. Lower diff = better.
// Per-tier counts are EXCLUSIVE so the zone-distribution bars
// stack into non-overlapping segments.
const summary = useMemo(() => {
  if (history.length === 0) return null;
  const diffs = history.map((r) => r.diffMs);
  const avgDiff = diffs.reduce((a, b) => a + b, 0) / diffs.length;
  const bestDiff = Math.min(...diffs);
  const worstDiff = Math.max(...diffs);
  // Count rounds in each rank tier using the shared thresholds.
  const rankCounts: Record<string, number> = {};
  for (const label of RANK_LABELS) rankCounts[label] = 0;
  for (const r of history) {
    const rank = diffToRank(r.diffMs);
    rankCounts[rank.label] = (rankCounts[rank.label] || 0) + 1;
  }
  return {
    avgDiff,
    bestDiff,
    worstDiff,
    rankCounts,
    rounds: history.length,
    bestRank: diffToRank(bestDiff),
  };
}, [history]);

// ── Persist personal best when a test finishes ──────────────────
// Compares the session's best rank against the stored personal best.
// If the session's best is strictly better (lower index in the rank
// table), update both state and localStorage so it survives refreshes.
// Reads directly from localStorage (not `personalBest` state) to avoid
// a needless re-render cycle from including personalBest in deps.
useEffect(() => {
  if (phase !== "finished" || !summary) return;
  const sessionLabel = summary.bestRank.label;
  const stored = loadPersonalBest();
  const currentLabel = stored?.label ?? "MISS";
  if (isBetterRank(sessionLabel, currentLabel)) {
    const newPb: PersonalBest = {
      label: summary.bestRank.label,
      emoji: summary.bestRank.emoji,
      color: summary.bestRank.color,
      bestDiffMs: summary.bestDiff,
    };
    setPersonalBest(newPb);
    savePersonalBest(newPb);
  }
}, [phase, summary]);
  return (
    <div
      data-testid="precision-test-page"
      className="min-h-screen overflow-x-clip bg-gradient-to-b from-[#06120f] to-[#050816] px-3 pb-24 pt-20 text-white sm:px-6 md:pb-8"
    >
      <NavigationBar currentPath="/casino" />

      <div className="mx-auto mt-4 max-w-6xl rounded-2xl border border-fuchsia-500/40 bg-black/30 p-4 sm:mt-8 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.35em] text-fuchsia-300/80">
              {t("games.precision.test_solo_label")}
            </p>
            <h1 className="mt-1 text-2xl font-black text-fuchsia-300 sm:text-3xl">
              {phase === "idle"
                ? t("games.precision.practice_mode_title")
                : phase === "finished"
                  ? t("games.precision.test_complete_title")
                  : t("games.precision.test_round_label_of", { current: currentRound, total: MAX_ROUNDS })}
            </h1>
            <p className="mt-1 text-sm text-cyan-100/90">
              {phase === "idle"
                ? t("games.precision.test_idle_intro")
                : t("games.precision.test_active_intro")}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              data-testid="precision-test-back-to-lobby"
              onClick={handleLeave}
              className="rounded bg-[#f5ff3b] px-4 py-2 font-bold text-black"
            >
              {t("games.precision.lobby_button")}
            </button>
            {phase !== "idle" && phase !== "finished" && (
              <button
                onClick={handleRestart}
                className="rounded bg-cyan-400 px-4 py-2 font-bold text-black"
              >
                {t("games.precision.restart")}
              </button>
            )}
          </div>
        </div>

        <AnimatePresence mode="wait" initial={false}>
          {phase === "idle" && (
            <motion.div key="phase-idle" {...fadeUp}>
              <IdleStartScreen onStart={handleStart} personalBest={personalBest} t={t} />
            </motion.div>
          )}

          {phase === "arming" && (
            <motion.div key="phase-arming" {...fadeUp}>
              <ArmingPanel currentRound={currentRound} t={t} />
            </motion.div>
          )}

          {phase === "active" && targetMs !== null && (
            <motion.div key="phase-active" {...fadeUp}>
              <ActivePanel
                currentRound={currentRound}
                targetMs={targetMs}
                timerMs={timerMs}
                onStop={handleStop}
                t={t}
              />
            </motion.div>
          )}

          {phase === "round-done" &&
            currentElapsedMs !== null &&
            currentDiffMs !== null &&
            targetMs !== null && (
              <motion.div key="phase-round-done" {...fadeUp}>
                <RoundDonePanel
                  round={currentRound}
                  targetMs={targetMs}
                  elapsedMs={currentElapsedMs}
                  diffMs={currentDiffMs}
                  isLastRound={currentRound >= MAX_ROUNDS}
                  t={t}
                />
              </motion.div>
            )}

          {phase === "finished" && history.length === MAX_ROUNDS && summary && (
            <motion.div key="phase-finished" {...fadeUp}>
              <FinishedSummaryPanel
                history={history}
                summary={summary}
                personalBest={personalBest}
                onRestart={handleRestart}
                onLeave={handleLeave}
                t={t}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <Footer />
    </div>
  );
}

// ── Sub-components (kept inline so the test page is a single,
// drop-in module that doesn't pollute `/components/precision/` with
// solo-mode-only files.) ────────────────────────────────────────────

function IdleStartScreen({ onStart, personalBest, t }: { onStart: () => void; personalBest: PersonalBest | null; t: (key: string, params?: Record<string, string | number>) => string }) {
  return (
    <div className="mt-6 grid gap-5 lg:grid-cols-3">
      <div className="lg:col-span-2 rounded-2xl border border-fuchsia-400/40 bg-[#0a0420]/80 p-6 sm:p-10">
        <p className="text-5xl">🎯</p>
        <h2 className="mt-3 text-2xl font-black text-fuchsia-300 sm:text-3xl">
          {t("games.precision.sharpen_title")}
        </h2>
        <p className="mt-3 max-w-xl text-sm text-cyan-100/90 sm:text-base">
          {t("games.precision.sharpen_description_lead")}{" "}
          <span className="font-bold text-yellow-300">{t("games.precision.stop_button")}</span>{" "}
          {t("games.precision.sharpen_description_mid")}{" "}
          <span className="font-bold text-cyan-300">{t("games.precision.sharpen_description_close")}</span>{" "}
          {t("games.precision.sharpen_description_tail")}
        </p>
        <ul className="mt-5 space-y-2 text-sm text-cyan-100/90">
          <li>
            <span className="mr-2 inline-block w-2 h-2 rounded-full bg-yellow-400" />
            <span className="font-bold text-yellow-300">🌟 PERFECT</span> · 0&nbsp;ms
          </li>
          <li>
            <span className="mr-2 inline-block w-2 h-2 rounded-full bg-purple-400" />
            <span className="font-bold text-purple-300">💎 LEGENDARY</span> · 1–3&nbsp;ms
          </li>
          <li>
            <span className="mr-2 inline-block w-2 h-2 rounded-full bg-red-400" />
            <span className="font-bold text-red-300">🔥 MASTERFUL</span> · 4–8&nbsp;ms
          </li>
          <li>
            <span className="mr-2 inline-block w-2 h-2 rounded-full bg-yellow-500" />
            <span className="font-bold text-yellow-400">⭐ EXCELLENT</span> · 9–15&nbsp;ms
          </li>
          <li>
            <span className="mr-2 inline-block w-2 h-2 rounded-full bg-green-400" />
            <span className="font-bold text-green-300">✅ GREAT</span> · 16–25&nbsp;ms
          </li>
          <li>
            <span className="mr-2 inline-block w-2 h-2 rounded-full bg-blue-400" />
            <span className="font-bold text-blue-300">👍 GOOD</span> · 26–40&nbsp;ms
          </li>
          <li>
            <span className="mr-2 inline-block w-2 h-2 rounded-full bg-cyan-400" />
            <span className="font-bold text-cyan-300">🎯 FAIR</span> · 41–60&nbsp;ms
          </li>
          <li>
            <span className="mr-2 inline-block w-2 h-2 rounded-full bg-orange-400" />
            <span className="font-bold text-orange-300">⚠️ CLOSE</span> · 61–100&nbsp;ms
          </li>
          <li>
            <span className="mr-2 inline-block w-2 h-2 rounded-full bg-gray-400" />
            <span className="font-bold text-gray-400">❌ MISS</span> · &gt;100&nbsp;ms
          </li>
        </ul>
        <button
          data-testid="precision-test-start-button"
          onClick={onStart}
          className="mt-7 w-full rounded-2xl bg-gradient-to-b from-cyan-400 to-cyan-500 px-6 py-5 text-2xl font-black tracking-widest text-black shadow-[0_0_30px_rgba(34,211,238,0.5)] transition active:scale-95 hover:from-cyan-300 hover:to-cyan-400"
        >
          {t("games.precision.start_test_button")}
        </button>
      </div>
      <div className="rounded-2xl border border-amber-300/30 bg-amber-300/5 p-5 text-sm text-amber-100/90">
        <p className="text-[10px] uppercase tracking-[0.35em] text-amber-300/80">
          {t("games.precision.no_wager_label")}
        </p>
        <p className="mt-3">
          {t("games.precision.off_books_description", { style: t("games.precision.off_the_books") })}
        </p>
        <p className="mt-3">
          {t("games.precision.ready_to_play_for_stakes")}
        </p>
        {personalBest && (
          <div className="mt-4 rounded-xl border border-yellow-400/30 bg-yellow-400/5 px-3 py-3">
            <p className="text-[10px] uppercase tracking-[0.3em] text-yellow-300/80">
              {t("games.precision.personal_best_title")}
            </p>
            <p className={`mt-1 text-lg font-black ${personalBest.color}`}>
              {personalBest.emoji} {personalBest.label}
            </p>
            <p className="mt-0.5 text-xs text-cyan-100/80">
              {t("games.precision.ms_off_format", { ms: Math.round(personalBest.bestDiffMs).toLocaleString() })}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function ArmingPanel({ currentRound, t }: { currentRound: number; t: (key: string, params?: Record<string, string | number>) => string }) {
  // The pulsing arming indicator intentionally mirrors the match
  // page's pre-round phase so the transitions feel consistent — the
  // user sees the same "hold steady" beat before the green light.
  return (
    <motion.div
      animate={{ scale: [1, 1.02, 1], opacity: [0.92, 1, 0.92] }}
      transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
      className="mt-6 flex flex-col items-center justify-center rounded-2xl border border-yellow-400/40 bg-[#1a120a]/80 p-8 text-center sm:p-12"
    >
      <p className="animate-pulse text-6xl">⏱</p>
      <h2 className="mt-4 text-2xl font-black text-yellow-300 sm:text-3xl">
        {t("games.precision.round_get_ready", { round: currentRound })}
      </h2>
      <p className="mt-3 max-w-md text-sm text-cyan-100/90 sm:text-base">
        {t("games.precision.test_arming_description", {
          defaultValue: "The round is arming. The target will appear at a random moment — hold steady and wait for it. Click STOP the instant it shows up.",
        })}
      </p>
    </motion.div>
  );
}

function ActivePanel({
  currentRound,
  targetMs,
  timerMs,
  onStop,
  t,
}: {
  currentRound: number;
  targetMs: number;
  timerMs: number;
  onStop: () => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  // Live rank preview — shows the rank the player WOULD earn if they
  // stopped right now. Updates continuously as the timer advances.
  const previewDiff = Math.abs(timerMs - targetMs);
  const previewRank = diffToRank(previewDiff);
  return (
    <div className="mt-6 rounded-2xl border border-fuchsia-400/40 bg-[#0a0420]/80 p-5 text-center sm:p-10">
      <p className="text-5xl">🎯</p>
      <h2 className="mt-4 text-2xl font-black text-fuchsia-300 sm:text-3xl">
        {t("games.precision.round_label", { round: currentRound })}
      </h2>

      {/* ── Running timer ──────────────────────────────────── */}
      <p className="mt-3 text-xs uppercase tracking-[0.35em] text-cyan-300/80">
        {t("games.precision.elapsed_label")}
      </p>
      <p
        data-testid="precision-test-timer"
        className="mt-1 font-mono text-6xl font-black tabular-nums text-cyan-200 sm:text-7xl"
      >
        {Math.round(timerMs).toLocaleString()}
        <span className="ml-1 text-3xl text-cyan-300/60">{t("games.precision.ms_suffix")}</span>
      </p>

      {/* ── Target ─────────────────────────────────────────── */}
      <p className="mt-4 text-xs uppercase tracking-[0.35em] text-yellow-300/80">
        {t("games.precision.target_label")}
      </p>
      <p
        data-testid="precision-test-target"
        className="mt-1 text-4xl font-black text-yellow-300 sm:text-5xl"
      >
        {targetMs.toLocaleString()} {t("games.precision.ms_suffix")}
      </p>

      {/* ── Live rank preview ─────────────────────────────── */}
      <p className={`mt-3 text-lg font-bold ${previewRank.color}`}>
        {previewRank.emoji} {previewRank.label}{" "}
        <span className="text-sm font-normal text-cyan-100/70">
          ({t("games.precision.ms_off_format", { ms: previewDiff.toLocaleString() })})
        </span>
      </p>

      <p className="mt-4 text-sm text-cyan-100/90 sm:text-base">
        {t("games.precision.test_click_stop_hint", { stop: "STOP" })}
      </p>
      <div className="mx-auto mt-5 flex max-w-md flex-col gap-3">
        <button
          type="button"
          data-testid="precision-test-stop-button"
          onClick={onStop}
          className="w-full rounded-2xl border-2 border-red-400/60 bg-gradient-to-b from-red-500 to-red-600 px-6 py-7 text-3xl font-black tracking-widest text-white shadow-[0_0_30px_rgba(239,68,68,0.65)] transition active:scale-95 hover:from-red-400 hover:to-red-500 animate-pulse"
        >
          STOP
        </button>
      </div>
    </div>
  );
}

function RoundDonePanel({
  round,
  targetMs,
  elapsedMs,
  diffMs,
  isLastRound,
  t,
}: {
  round: number;
  targetMs: number;
  elapsedMs: number;
  diffMs: number;
  isLastRound: boolean;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  const rank = diffToRank(diffMs);
  return (
    <div className="mt-6 rounded-2xl border border-cyan-400/40 bg-cyan-400/5 p-5 sm:p-10">
      <p className="text-xs uppercase tracking-[0.35em] text-cyan-300/80">
        {t("games.precision.test_round_result_title", { round })}
      </p>
      <p className={`mt-2 text-3xl font-black ${rank.color} sm:text-4xl`}>
        {rank.emoji} {rank.label}
      </p>
      <div className="mt-5 grid gap-3 sm:grid-cols-4 sm:gap-5">
        <Stat label={t("games.precision.target_label")} value={`${targetMs.toLocaleString()} ${t("games.precision.ms_suffix")}`} accent="text-yellow-300" />
        <Stat label={t("games.precision.test_your_stop")} value={`${Math.round(elapsedMs).toLocaleString()} ${t("games.precision.ms_suffix")}`} accent="text-cyan-300" />
        <Stat label={t("games.precision.test_difference")} value={`${Math.round(diffMs).toLocaleString()} ${t("games.precision.ms_suffix")}`} accent={rank.color} />
        <Stat label={t("games.precision.test_rank")} value={`${rank.emoji} ${rank.label}`} accent={rank.color} />
      </div>
      <p className="mt-5 text-sm text-cyan-100/90">
        {isLastRound
          ? t("games.precision.round_summary_last_round")
          : t("games.precision.round_summary_next")}
      </p>
    </div>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent: string;
}) {
  return (
    <div className="rounded-2xl border border-slate-700/80 bg-black/40 p-4 text-center">
      <p className="text-[10px] uppercase tracking-[0.35em] text-cyan-300/80">
        {label}
      </p>
      <p className={`mt-2 font-mono text-2xl font-black ${accent}`}>{value}</p>
    </div>
  );
}

function FinishedSummaryPanel({
  history,
  summary,
  personalBest,
  onRestart,
  onLeave,
  t,
}: {
  history: RoundStat[];
  summary: TestSummary;
  personalBest: PersonalBest | null;
  onRestart: () => void;
  onLeave: () => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  // Headline based on the best rank achieved across all 5 rounds.
  const { bestRank } = summary;
  const perfectCount = summary.rankCounts["PERFECT"] ?? 0;
  const legendaryCount = summary.rankCounts["LEGENDARY"] ?? 0;
  const masterfulCount = summary.rankCounts["MASTERFUL"] ?? 0;
  const headline =
    perfectCount > 0
      ? t("games.precision.headline_perfection")
      : legendaryCount > 0
        ? t("games.precision.headline_legendary")
        : masterfulCount > 0
          ? t("games.precision.headline_masterful")
          : bestRank.label === "EXCELLENT"
            ? t("games.precision.headline_excellent")
            : bestRank.label === "GREAT"
              ? t("games.precision.headline_great")
              : t("games.precision.headline_keep_practicing");
  return (
    <div className="mt-6 space-y-5">
      <div className="rounded-2xl border border-fuchsia-500/40 bg-[#0a0420]/80 p-5 sm:p-8">
        <p className="text-xs uppercase tracking-[0.35em] text-fuchsia-300/80">
          {t("games.precision.final_summary_title", { total: MAX_ROUNDS })}
        </p>
        <h2 className="mt-2 text-3xl font-black text-fuchsia-300">
          {headline}
          <span className={`ml-3 text-base font-bold ${bestRank.color}`}>
            {t("games.precision.best_rank_prefix", { emoji: bestRank.emoji, label: bestRank.label })}
          </span>
        </h2>

        <div className="mt-6 grid gap-3 sm:grid-cols-4">
          <Stat label={t("games.precision.stat_avg_difference")} value={`${Math.round(summary.avgDiff)} ${t("games.precision.ms_suffix")}`} accent="text-cyan-300" />
          <Stat label={t("games.precision.stat_best_difference")} value={`${Math.round(summary.bestDiff)} ${t("games.precision.ms_suffix")}`} accent={bestRank.color} />
          <Stat label={t("games.precision.stat_worst_difference")} value={`${Math.round(summary.worstDiff)} ${t("games.precision.ms_suffix")}`} accent="text-red-300" />
          <Stat label={t("games.precision.stat_best_rank")} value={`${bestRank.emoji} ${bestRank.label}`} accent={bestRank.color} />
        </div>

        {personalBest && (
          <div className="mt-4 rounded-xl border border-yellow-400/30 bg-yellow-400/5 px-4 py-3">
            <span className="text-[10px] uppercase tracking-[0.3em] text-yellow-300/80">
              {t("games.precision.all_time_best")}
            </span>
            <span className={`ml-3 text-sm font-black ${personalBest.color}`}>
              {personalBest.emoji} {personalBest.label}
            </span>
            <span className="ml-2 text-xs text-cyan-100/70">
              ({t("games.precision.ms_off_format", { ms: Math.round(personalBest.bestDiffMs).toLocaleString() })})
            </span>
          </div>
        )}

        <div className="mt-6">
          <p className="text-[10px] uppercase tracking-[0.35em] text-cyan-300/80">
            {t("games.precision.rank_distribution")}
          </p>
          <RankBars rankCounts={summary.rankCounts} />
        </div>
      </div>

      <div className="rounded-2xl border border-cyan-500/30 bg-black/30 p-4 sm:p-5">
        <p className="text-xs uppercase tracking-[0.35em] text-cyan-300/80">
          {t("games.precision.per_round_log")}
        </p>
        <div className="mt-3 grid gap-2 sm:grid-cols-5">
          {history.map((s) => {
            const rank = diffToRank(s.diffMs);
            return (
              <div
                key={s.round}
                className="rounded-xl border border-slate-700/80 bg-black/40 p-3 text-center"
              >
                <p className="text-[10px] uppercase tracking-[0.3em] text-cyan-300/80">
                  {t("games.precision.round_label", { round: s.round })}
                </p>
                <p className={`mt-1 font-mono text-lg font-black ${rank.color}`}>
                  {Math.round(s.diffMs)}&nbsp;{t("games.precision.ms_suffix")}
                </p>
                <p className="mt-1 font-mono text-[11px] text-cyan-100/80">
                  {t("games.precision.target_inline", { target: s.targetMs.toLocaleString() })}
                </p>
                <p className="mt-1 font-mono text-[10px] text-cyan-100/70">
                  {t("games.precision.stop_inline", { stop: Math.round(s.elapsedMs).toLocaleString() })}
                </p>
                <p className={`mt-1 text-[10px] font-bold ${rank.color}`}>
                  {rank.emoji} {rank.label}
                </p>
              </div>
            );
          })}
        </div>
      </div>

      <div className="flex flex-wrap gap-3">
        <button
          data-testid="precision-test-play-again"
          onClick={onRestart}
          className="flex-1 rounded-2xl bg-gradient-to-b from-cyan-400 to-cyan-500 px-6 py-4 text-xl font-black tracking-widest text-black shadow-[0_0_30px_rgba(34,211,238,0.5)] transition active:scale-95 hover:from-cyan-300 hover:to-cyan-400"
        >
          {t("games.precision.play_again_button")}
        </button>
        <button
          onClick={onLeave}
          className="rounded-2xl bg-[#f5ff3b] px-6 py-4 text-xl font-black tracking-widest text-black"
        >
          {t("games.precision.back_to_lobby_button")}
        </button>
      </div>
    </div>
  );
}

// Helper used to type the summary prop on FinishedSummaryPanel without
// re-deriving the useMemo shape inline. Returns the same shape produced
// by the page-level `useMemo` block above — kept tiny so TypeScript
// can keep the panel's contract explicit. Per-tier counts are
// EXCLUSIVE (not cumulative) so the zone-distribution bars are
// non-overlapping and sum to `rounds`.
interface TestSummary {
  avgDiff: number;
  bestDiff: number;
  worstDiff: number;
  rankCounts: Record<string, number>;
  rounds: number;
  bestRank: PrecisionRank;
}

function RankBars({
  rankCounts,
}: {
  rankCounts: Record<string, number>;
}) {
  // Use the exported PRECISION_RANK_ENTRIES from the shared utility so
  // the bar colours stay locked to `diffToRank` thresholds. Each entry
  // carries its own `rank.bg` and `rank.color` — no manual mapping needed.
  const segments = PRECISION_RANK_ENTRIES.map((entry) => ({
    v: rankCounts[entry.rank.label] ?? 0,
    label: entry.rank.label,
    emoji: entry.rank.emoji,
    bg: entry.rank.bg,
    textColor: entry.rank.color,
  }));
  const stack = segments.filter((s) => s.v > 0);
  const total = stack.reduce((a, b) => a + b.v, 0) || 1;
  return (
    <div className="mt-2">
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-black/40">
        {stack.map((s) => (
          <div
            key={s.label}
            className={`${s.bg} transition-all`}
            style={{ width: `${(s.v / total) * 100}%` }}
            data-testid={`precision-test-rank-${s.label.toLowerCase()}`}
          />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-3 text-[11px] text-cyan-100/90">
        {stack.map((s) => (
          <span key={s.label} className="flex items-center gap-1">
            <span className={`inline-block h-2.5 w-2.5 rounded-sm ${s.bg}`} />
            <span className={`font-bold ${s.textColor}`}>{s.emoji} {s.label}</span>{" "}
            <span className="text-cyan-300/80">× {s.v}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
