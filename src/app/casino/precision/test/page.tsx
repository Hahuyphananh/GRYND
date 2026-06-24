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
import Footer from "../../../../components/Footer";
import {
  MAX_DELAY_MS,
  MAX_ROUNDS,
  MAX_TARGET_MS,
  MIN_DELAY_MS,
  MIN_TARGET_MS,
} from "../../../../lib/precision/constants";
import { fadeUp } from "../../../../lib/animations";

// ── Per-round telemetry. ──────────────────────────────────────────
// `reactionMs` is the primary scoring input (display + bands).
// `targetMs` is captured for display parity with the PvP round UI
// but is NOT used for grading — see the file header for the
// rationale. No `diffMs` field: scoring on `|reaction − target|`
// would always read as ≈targetMs (reactionMs is two orders of
// magnitude smaller) and would always classify as "Off", so we
// grade on reactionMs alone.
interface RoundStat {
  round: number;
  targetMs: number;
  reactionMs: number;
}

type TestPhase =
  | "idle"        // Initial landing — "Start Test" button.
  | "arming"      // Server-style random delay before the round opens.
  | "active"      // Target revealed; user react-clicks STOP.
  | "round-done" // Post-round overlay shown for ~1.6s before the next.
  | "finished";   // All 5 rounds played; show summary stats.

// Lower-is-better reaction-time bands so users get a concrete
// takeaway. Calibrated against the standard reaction-time literature:
//   * Elite:     ≤ 150ms
//   * Sharp:     ≤ 250ms
//   * Solid:     ≤ 400ms
//   * Casual:    ≤ 700ms
//   * Off:        > 700ms
// These thresholds grade on the user's reaction time directly —
// NOT on `|reaction − target|`. Grading on the delta would be
// meaningless because target is 2.5–10 s and human reaction is
// 100–500 ms, so the delta would always land in the "Off" bucket.
function reactionBand(
  reactionMs: number,
): { label: string; color: string } {
  if (reactionMs <= 150) return { label: "Elite", color: "text-emerald-300" };
  if (reactionMs <= 250) return { label: "Sharp", color: "text-cyan-300" };
  if (reactionMs <= 400) return { label: "Solid", color: "text-yellow-300" };
  if (reactionMs <= 700) return { label: "Casual", color: "text-orange-300" };
  return { label: "Off", color: "text-red-300" };
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

  const [phase, setPhase] = useState<TestPhase>("idle");
  const [currentRound, setCurrentRound] = useState(1);
  const [targetMs, setTargetMs] = useState<number | null>(null);
  const [currentReactionMs, setCurrentReactionMs] = useState<number | null>(null);
  const [history, setHistory] = useState<RoundStat[]>([]);

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

  // Cleanup: cancel both pending timers on unmount.
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
    };
  }, []);

  const beginRound = useCallback((roundIndex: number) => {
    const session = sessionIdRef.current;
    setPhase("arming");
    setCurrentRound(roundIndex);
    setTargetMs(null);
    setCurrentReactionMs(null);
    stopLockedRef.current = false;

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
    }, rollArmingDelayMs());
  }, []);

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
    const reactionMs = performance.now() - goInstantRef.current;
    const target = targetMs ?? 0;
    setCurrentReactionMs(reactionMs);
    const stat: RoundStat = {
      round: currentRound,
      targetMs: target,
      reactionMs,
    };
    setHistory((h) => [...h, stat]);
    posthog?.capture("precision_test_round_completed", {
      round: currentRound,
      reactionMs,
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
  }, [phase, currentRound, targetMs, beginRound, posthog]);

// === Derived summary stats ──────────────────────────────────
// All values grade on `reactionMs` directly, NOT on a delta vs
// the rolled target (see the file header for the rationale).
// Per-tier counts are EXCLUSIVE so the zone-distribution bars
// stack into non-overlapping segments. Thresholds must stay in
// sync with `reactionBand()` above.
const summary = useMemo(() => {
  if (history.length === 0) return null;
  const reactions = history.map((r) => r.reactionMs);
  const avgReaction =
    reactions.reduce((a, b) => a + b, 0) / reactions.length;
  const bestReaction = Math.min(...reactions);
  const worstReaction = Math.max(...reactions);
  const elite = reactions.filter((r) => r <= 150).length;
  const sharp = reactions.filter((r) => r > 150 && r <= 250).length;
  const solid = reactions.filter((r) => r > 250 && r <= 400).length;
  const casual = reactions.filter((r) => r > 400 && r <= 700).length;
  const off = reactions.filter((r) => r > 700).length;
  return {
    avgReaction,
    bestReaction,
    worstReaction,
    elite,
    sharp,
    solid,
    casual,
    off,
    rounds: history.length,
  };
}, [history]);
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
              Precision · Solo Test
            </p>
            <h1 className="mt-1 text-2xl font-black text-fuchsia-300 sm:text-3xl">
              {phase === "idle"
                ? "Practice Mode"
                : phase === "finished"
                  ? "Test Complete"
                  : `Round ${currentRound} of ${MAX_ROUNDS}`}
            </h1>
            <p className="mt-1 text-sm text-cyan-100/90">
              {phase === "idle"
                ? "Sharpen your reaction time solo — no wager, no opponent."
                : "Click STOP the instant the target appears. We measure the delay locally."}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              data-testid="precision-test-back-to-lobby"
              onClick={handleLeave}
              className="rounded bg-[#f5ff3b] px-4 py-2 font-bold text-black"
            >
              Lobby
            </button>
            {phase !== "idle" && phase !== "finished" && (
              <button
                onClick={handleRestart}
                className="rounded bg-cyan-400 px-4 py-2 font-bold text-black"
              >
                Restart
              </button>
            )}
          </div>
        </div>

        <AnimatePresence mode="wait" initial={false}>
          {phase === "idle" && (
            <motion.div key="phase-idle" {...fadeUp}>
              <IdleStartScreen onStart={handleStart} />
            </motion.div>
          )}

          {phase === "arming" && (
            <motion.div key="phase-arming" {...fadeUp}>
              <ArmingPanel currentRound={currentRound} />
            </motion.div>
          )}

          {phase === "active" && targetMs !== null && (
            <motion.div key="phase-active" {...fadeUp}>
              <ActivePanel
                currentRound={currentRound}
                targetMs={targetMs}
                onStop={handleStop}
              />
            </motion.div>
          )}

          {phase === "round-done" &&
            currentReactionMs !== null &&
            targetMs !== null && (
              <motion.div key="phase-round-done" {...fadeUp}>
                <RoundDonePanel
                  round={currentRound}
                  targetMs={targetMs}
                  reactionMs={currentReactionMs}
                  isLastRound={currentRound >= MAX_ROUNDS}
                />
              </motion.div>
            )}

          {phase === "finished" && history.length === MAX_ROUNDS && summary && (
            <motion.div key="phase-finished" {...fadeUp}>
              <FinishedSummaryPanel
                history={history}
                summary={summary}
                onRestart={handleRestart}
                onLeave={handleLeave}
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

function IdleStartScreen({ onStart }: { onStart: () => void }) {
  return (
    <div className="mt-6 grid gap-5 lg:grid-cols-3">
      <div className="lg:col-span-2 rounded-2xl border border-fuchsia-400/40 bg-[#0a0420]/80 p-6 sm:p-10">
        <p className="text-5xl">🎯</p>
        <h2 className="mt-3 text-2xl font-black text-fuchsia-300 sm:text-3xl">
          Sharpen your reaction time
        </h2>
        <p className="mt-3 max-w-xl text-sm text-cyan-100/90 sm:text-base">
          You&apos;ll play 5 solo rounds. Each round the screen arms for a
          randomised 2.5–7.5&nbsp;second delay, then the target appears —
          click <span className="font-bold text-yellow-300">STOP</span> the
          instant you see it. We grade on <span className="font-bold text-cyan-300">reaction
          time</span>, not on the delta between your click and the target
          instant.
        </p>
        <ul className="mt-5 space-y-2 text-sm text-cyan-100/90">
          <li>
            <span className="mr-2 inline-block w-2 h-2 rounded-full bg-emerald-400" />
            <span className="font-bold text-emerald-300">Elite</span> ·
            ≤ 150&nbsp;ms reaction
          </li>
          <li>
            <span className="mr-2 inline-block w-2 h-2 rounded-full bg-cyan-400" />
            <span className="font-bold text-cyan-300">Sharp</span> ·
            ≤ 250&nbsp;ms
          </li>
          <li>
            <span className="mr-2 inline-block w-2 h-2 rounded-full bg-yellow-400" />
            <span className="font-bold text-yellow-300">Solid</span> ·
            ≤ 400&nbsp;ms
          </li>
          <li>
            <span className="mr-2 inline-block w-2 h-2 rounded-full bg-orange-400" />
            <span className="font-bold text-orange-300">Casual</span> ·
            ≤ 700&nbsp;ms
          </li>
          <li>
            <span className="mr-2 inline-block w-2 h-2 rounded-full bg-red-400" />
            <span className="font-bold text-red-300">Off</span> ·
            &gt; 700&nbsp;ms
          </li>
        </ul>
        <button
          data-testid="precision-test-start-button"
          onClick={onStart}
          className="mt-7 w-full rounded-2xl bg-gradient-to-b from-cyan-400 to-cyan-500 px-6 py-5 text-2xl font-black tracking-widest text-black shadow-[0_0_30px_rgba(34,211,238,0.5)] transition active:scale-95 hover:from-cyan-300 hover:to-cyan-400"
        >
          START TEST
        </button>
      </div>
      <div className="rounded-2xl border border-amber-300/30 bg-amber-300/5 p-5 text-sm text-amber-100/90">
        <p className="text-[10px] uppercase tracking-[0.35em] text-amber-300/80">
          No wager · Local only
        </p>
        <p className="mt-3">
          Practice mode is <span className="font-bold">off the books</span>:
          no tokens are deducted and no leaderboard stats are updated.
        </p>
        <p className="mt-3">
          When you&apos;re ready to play for stakes, head back to the
          lobby and pick a wager on a PvP match.
        </p>
      </div>
    </div>
  );
}

function ArmingPanel({ currentRound }: { currentRound: number }) {
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
        Round {currentRound} — Get ready…
      </h2>
      <p className="mt-3 max-w-md text-sm text-cyan-100/90 sm:text-base">
        The round is arming. The target will appear at a random moment —
        hold steady and wait for it. Click <span className="font-bold text-yellow-300">STOP</span> the
        instant it shows up.
      </p>
    </motion.div>
  );
}

function ActivePanel({
  currentRound,
  targetMs,
  onStop,
}: {
  currentRound: number;
  targetMs: number;
  onStop: () => void;
}) {
  return (
    <div className="mt-6 rounded-2xl border border-fuchsia-400/40 bg-[#0a0420]/80 p-5 text-center sm:p-10">
      <p className="text-5xl">🎯</p>
      <h2 className="mt-4 text-2xl font-black text-fuchsia-300 sm:text-3xl">
        Round {currentRound}
      </h2>
      <p className="mt-3 text-xs uppercase tracking-[0.35em] text-cyan-300/80">
        Target
      </p>
      <p
        data-testid="precision-test-target"
        className="mt-1 text-4xl font-black text-yellow-300 sm:text-5xl"
      >
        {targetMs.toLocaleString()} ms
      </p>
      <p className="mt-4 text-sm text-cyan-100/90 sm:text-base">
        Click <span className="font-bold text-yellow-300">STOP</span> now.
        We measure how fast you reacted the instant the target appeared.
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
  reactionMs,
  isLastRound,
}: {
  round: number;
  targetMs: number;
  reactionMs: number;
  isLastRound: boolean;
}) {
  // Grade on `reactionMs` directly — see the file header. Using the
  // shared `reactionBand` keeps the per-round overlay and the
  // finished-summary panel in lock-step so the colour thresholds
  // never drift out of sync.
  const band = reactionBand(reactionMs);
  return (
    <div className="mt-6 rounded-2xl border border-cyan-400/40 bg-cyan-400/5 p-5 sm:p-10">
      <p className="text-xs uppercase tracking-[0.35em] text-cyan-300/80">
        Round {round} result
      </p>
      <p className={`mt-2 text-3xl font-black ${band.color} sm:text-4xl`}>
        {band.label}
      </p>
      <div className="mt-5 grid gap-3 sm:grid-cols-3 sm:gap-5">
        <Stat label="Target" value={`${targetMs.toLocaleString()} ms`} accent="text-yellow-300" />
        <Stat label="Your reaction" value={`${Math.round(reactionMs).toLocaleString()} ms`} accent="text-cyan-300" />
        <Stat label="Band" value={band.label} accent={band.color} />
      </div>
      <p className="mt-5 text-sm text-cyan-100/90">
        {isLastRound
          ? "That was the last round — your summary is coming up…"
          : "Next round arming in a moment…"}
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
  onRestart,
  onLeave,
}: {
  history: RoundStat[];
  summary: TestSummary;
  onRestart: () => void;
  onLeave: () => void;
}) {
  // Headline cascade: any Elite → "⚡ Elite finish"; else 3+ Sharp →
  // "🎉 Sharp across the board"; else 1+ Solid → "💪 Solid run";
  // else "🤔 Keep practicing". The best-reaction pill on the right
  // always colours to the actual tier so the user can see how their
  // fastest run scored even on an otherwise weak overall session.
  const bestBand = reactionBand(summary.bestReaction);
  const headline =
    summary.elite > 0
      ? "⚡ Elite finish"
      : summary.sharp >= 3
        ? "🎉 Sharp across the board"
        : summary.solid > 0
          ? "💪 Solid run"
          : "🤔 Keep practicing";
  return (
    <div className="mt-6 space-y-5">
      <div className="rounded-2xl border border-fuchsia-500/40 bg-[#0a0420]/80 p-5 sm:p-8">
        <p className="text-xs uppercase tracking-[0.35em] text-fuchsia-300/80">
          Test summary · 5 rounds
        </p>
        <h2 className="mt-2 text-3xl font-black text-fuchsia-300">
          {headline}
          <span className={`ml-3 text-base font-bold ${bestBand.color}`}>
            best {Math.round(summary.bestReaction)}&nbsp;ms
          </span>
        </h2>

        <div className="mt-6 grid gap-3 sm:grid-cols-4">
          <Stat label="Avg reaction" value={`${Math.round(summary.avgReaction)} ms`} accent="text-cyan-300" />
          <Stat label="Best reaction" value={`${Math.round(summary.bestReaction)} ms`} accent="text-emerald-300" />
          <Stat label="Worst reaction" value={`${Math.round(summary.worstReaction)} ms`} accent="text-red-300" />
          <Stat label="Elite rounds" value={`${summary.elite} / ${summary.rounds}`} accent="text-emerald-300" />
        </div>

        <div className="mt-6">
          <p className="text-[10px] uppercase tracking-[0.35em] text-cyan-300/80">
            Zone distribution
          </p>
          <ZoneBars
            elite={summary.elite}
            sharp={summary.sharp}
            solid={summary.solid}
            casual={summary.casual}
            off={summary.off}
          />
        </div>
      </div>

      <div className="rounded-2xl border border-cyan-500/30 bg-black/30 p-4 sm:p-5">
        <p className="text-xs uppercase tracking-[0.35em] text-cyan-300/80">
          Per-round log
        </p>
        <div className="mt-3 grid gap-2 sm:grid-cols-5">
          {history.map((s) => {
            const band = reactionBand(s.reactionMs);
            return (
              <div
                key={s.round}
                className="rounded-xl border border-slate-700/80 bg-black/40 p-3 text-center"
              >
                <p className="text-[10px] uppercase tracking-[0.3em] text-cyan-300/80">
                  Round {s.round}
                </p>
                <p className={`mt-1 font-mono text-lg font-black ${band.color}`}>
                  {Math.round(s.reactionMs)}&nbsp;ms
                </p>
                <p className="mt-1 font-mono text-[11px] text-cyan-100/80">
                  target {s.targetMs.toLocaleString()} ms
                </p>
                <p className={`mt-1 text-[10px] font-bold ${band.color}`}>
                  {band.label}
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
          PLAY AGAIN
        </button>
        <button
          onClick={onLeave}
          className="rounded-2xl bg-[#f5ff3b] px-6 py-4 text-xl font-black tracking-widest text-black"
        >
          BACK TO LOBBY
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
  avgReaction: number;
  bestReaction: number;
  worstReaction: number;
  elite: number;
  sharp: number;
  solid: number;
  casual: number;
  off: number;
  rounds: number;
}

function ZoneBars({
  elite,
  sharp,
  solid,
  casual,
  off,
}: {
  elite: number;
  sharp: number;
  solid: number;
  casual: number;
  off: number;
}) {
  const segments = [
    { v: elite, label: "Elite", color: "bg-emerald-400" },
    { v: sharp, label: "Sharp", color: "bg-cyan-400" },
    { v: solid, label: "Solid", color: "bg-yellow-400" },
    { v: casual, label: "Casual", color: "bg-orange-400" },
    { v: off, label: "Off", color: "bg-red-400" },
  ];
  const stack = segments.filter((s) => s.v > 0);
  const total = stack.reduce((a, b) => a + b.v, 0) || 1;
  return (
    <div className="mt-2">
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-black/40">
        {stack.map((s, i) => (
          <div
            key={s.label}
            className={`${s.color} transition-all`}
            style={{ width: `${(s.v / total) * 100}%` }}
            data-testid={`precision-test-zone-${s.label.toLowerCase()}`}
          />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-3 text-[11px] text-cyan-100/90">
        {stack.map((s) => (
          <span key={s.label} className="flex items-center gap-1">
            <span className={`inline-block h-2.5 w-2.5 rounded-sm ${s.color}`} />
            {s.label} <span className="text-cyan-300/80">× {s.v}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
