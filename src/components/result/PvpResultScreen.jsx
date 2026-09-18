"use client";

/**
 * PvpResultScreen — the single end-of-match experience across Grynd (UX
 * plan P3-3 / "reward moment").
 *
 * Every PvP game replaces its bespoke WIN/LOSS/DRAW popup with this shared
 * full-screen result overlay. It never computes or invents rewards — games
 * pass the REAL values already returned by their existing match APIs, and
 * any section (XP, Battle Pass, Prestige, duration, opponent, details…) is
 * simply hidden when its data is absent.
 *
 * Two live progression values are read from the platform's OWN endpoints
 * when the game doesn't pass them explicitly: the player's current win
 * streak (/api/user/stats) and their true weekly leaderboard rank
 * (/api/leaderboard/weekly). Both are real server numbers, fire-and-forget
 * (a failure or unranked state simply hides the chip — the result screen is
 * never blocked), and games can override either via the `streak` / `rank`
 * props to skip the fetch.
 *
 * Adapter pattern per game:
 *   1. Detect the finished state exactly as today (status === "finished",
 *      a result phase, etc.) and keep rendering the game page underneath.
 *   2. Map the existing winner/result to `outcome` ("win" | "loss" | "draw").
 *   3. Map existing payout fields to `tokenDelta`; XP / Battle Pass /
 *      Prestige go in `xp` / `progress` only if the match payload carries
 *      them — otherwise omit (sections auto-hide, no fake numbers).
 *   4. Compute `durationSeconds` from existing startedAt/endedAt when both
 *      exist, else omit.
 *   5. Keep game-specific info (payout breakdowns, pick audits, per-round
 *      scores…) either as `summary`/`details` rows or as `detailsContent`
 *      JSX inside the expandable Match Details panel.
 *   6. Actions: `playAgain`/`rematch` reuse the game's existing
 *      create-match/matchmaking flow; omit `rematch` when a direct rematch
 *      with the same opponent doesn't exist in the architecture.
 */

import React, { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  IconChevronDown,
  IconCoins,
  IconHeartHandshake,
  IconRobot,
  IconStar,
  IconTrophy,
  IconX,
} from "@tabler/icons-react";
import { fireConfetti, withReducedMotion } from "../../lib/animations";
import IconAvatar from "../IconAvatar";

const CONFETTI_COLORS = ["#00e5ff", "#f5ff3b", "#ff4fd8", "#a855f7", "#34d399"];

function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.round(Number(totalSeconds) || 0));
  const m = Math.floor(s / 60);
  const sec = String(s % 60).padStart(2, "0");
  return `${m}:${sec}`;
}

function formatTokens(n) {
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function formatNumber(n) {
  return Number(n || 0).toLocaleString();
}

/**
 * Counts a number up from 0 to `value` once, so a payout/token change reads
 * as a gain or loss instead of a static figure. Reduced motion shows the final
 * value immediately. This runs once per mount — the result screen mounts once
 * per settled match — so it never replays when status is refreshed.
 */
function AnimatedNumber({ value, reduce, duration = 450 }) {
  const target = Number(value) || 0;
  const [display, setDisplay] = useState(reduce ? target : 0);

  useEffect(() => {
    if (reduce) {
      setDisplay(target);
      return undefined;
    }
    let raf = 0;
    const start = performance.now();
    const tick = (now) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(target * eased);
      if (t < 1) raf = requestAnimationFrame(tick);
      else setDisplay(target);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, reduce, duration]);

  return <>{formatTokens(display)}</>;
}

const OUTCOME_STYLES = {
  win: {
    label: "WIN",
    tagline: "You took the match",
    icon: IconTrophy,
    accentText: "text-emerald-300",
    gradient:
      "from-[#0d2b1a] via-[#072014] to-[#04170e] border-emerald-400/50 shadow-[0_0_70px_rgba(52,211,153,0.35)]",
    glow: "text-emerald-300 drop-shadow-[0_0_18px_rgba(52,211,153,0.7)]",
    borderTop: "bg-emerald-400/60",
  },
  loss: {
    label: "LOSS",
    tagline: "The match got away — run it back",
    icon: IconX,
    accentText: "text-red-300",
    gradient:
      "from-[#2a0f14] via-[#1d0a0e] to-[#140608] border-red-500/40 shadow-[0_0_60px_rgba(239,68,68,0.28)]",
    glow: "text-red-300 drop-shadow-[0_0_16px_rgba(248,113,113,0.55)]",
    borderTop: "bg-red-400/60",
  },
  draw: {
    label: "DRAW",
    tagline: "Evenly matched — both walk away",
    icon: IconHeartHandshake,
    accentText: "text-cyan-300",
    gradient:
      "from-[#0a1a33] via-[#08142a] to-[#050d1c] border-cyan-400/50 shadow-[0_0_60px_rgba(34,211,238,0.3)]",
    glow: "text-cyan-300 drop-shadow-[0_0_16px_rgba(34,211,238,0.6)]",
    borderTop: "bg-cyan-400/60",
  },
};

const panelMotion = {
  initial: { opacity: 0, scale: 0.85, y: 40 },
  animate: { opacity: 1, scale: 1, y: 0 },
  exit: { opacity: 0, scale: 0.9, y: 24 },
  transition: { type: "spring", stiffness: 260, damping: 22 },
};

/**
 * @typedef {Object} ResultRow
 * @property {string} label
 * @property {import("react").ReactNode} value
 */

/**
 * @typedef {Object} ResultProgress
 * @property {string} label   e.g. "Battle Pass"
 * @property {string} from    e.g. "72"
 * @property {string} to      e.g. "73"
 * @property {number} percent 0–100 fill for the bar
 */

export default function PvpResultScreen({
  open,
  outcome,
  headline,
  subline,
  opponent = null,
  gameName,
  tokenDelta = null,
  xp = null,
  progress = [],
  summary = [],
  details = [],
  detailsContent = null,
  durationSeconds = null,
  playAgain = null,
  rematch = null,
  onReturnToLobby = null,
  onDismiss = null,
  dismissLabel = "View Match Results",
  // Compact creator-frame mode (UX: the shared result screen mounted
  // INSIDE the Creator Mode recording viewport). The recording frame is
  // a 390px-wide phone viewport zoomed to fill the output, so the panel
  // and its type scale down to fit the narrow frame instead of rendering
  // at desktop size.
  compact = false,
  // Real progression values (optional). When a game passes these, the
  // screen renders them verbatim and skips the matching live fetch.
  streak = null,
  rank = null,
  rankDelta = null,
  // Optional final score comparison, e.g.
  //   [{ name: "You", score: 240, highlight: true }, { name: "Rival", score: 180 }]
  // The highlighted side is emphasised; the other stays visible but muted.
  // Games that don't pass it render exactly as before.
  sides = null,
}) {
  const shouldReduce = useReducedMotion();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [navigating, setNavigating] = useState(false);

  const style = OUTCOME_STYLES[outcome] || OUTCOME_STYLES.draw;
  const OutcomeIcon = style.icon;

  // Celebrate a win once when the screen appears (respects reduced motion —
  // no animation at all then; confetti is skipped too).
  useEffect(() => {
    if (!open || outcome !== "win") return;
    if (shouldReduce) return;
    fireConfetti({ particleCount: 90, spread: 100, origin: { x: 0.5, y: 0.35 }, colors: CONFETTI_COLORS });
    const t1 = setTimeout(
      () =>
        fireConfetti({ particleCount: 60, spread: 120, origin: { x: 0.3, y: 0.4 }, colors: CONFETTI_COLORS }),
      350,
    );
    const t2 = setTimeout(
      () =>
        fireConfetti({ particleCount: 60, spread: 120, origin: { x: 0.7, y: 0.4 }, colors: CONFETTI_COLORS }),
      650,
    );
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [open, outcome, shouldReduce]);

  // One action per screen: once Play Again / Rematch / Lobby is picked,
  // disable the buttons so a double-tap can't create two matches.
  const guard = (fn) => () => {
    if (navigating || typeof fn !== "function") return;
    setNavigating(true);
    fn();
  };

  // Live progression — real numbers from the platform's own endpoints,
  // fetched only when the game didn't pass its own values. Fire-and-forget:
  // any failure leaves the chips hidden and never blocks the result screen.
  const [liveStreak, setLiveStreak] = useState(null);
  const [liveRank, setLiveRank] = useState(null);
  const [liveRankDelta, setLiveRankDelta] = useState(null);
  const [liveXp, setLiveXp] = useState(null);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    // Fresh screen per match — never carry values from a previous result.
    setLiveStreak(null);
    setLiveRank(null);
    setLiveRankDelta(null);
    setLiveXp(null);

    // Current win streak + XP granted by the most recent settled match,
    // both from the platform's own stats endpoint. Streak is only
    // meaningful on a win (a settled loss resets it to 0 server-side); XP
    // is granted on every settled wager and gated by a freshness window so
    // a stale grant (old match / Monday weekly reset) is never shown as
    // this match's XP.
    const fetchStats = () =>
      fetch("/api/user/stats", {
        credentials: "include",
        signal: controller.signal,
      })
        .then((res) => res.json().catch(() => null))
        .then((data) => {
          const stats = data?.userStats ?? {};
          if (streak === null && outcome === "win") {
            const s = Number(stats.currentStreak ?? 0);
            if (Number.isFinite(s) && s > 0) setLiveStreak(s);
          }
          if (xp === null) {
            const earned = Number(stats.lastXpEarned ?? 0);
            const at = stats.lastXpEarnedAt
              ? new Date(stats.lastXpEarnedAt).getTime()
              : null;
            if (
              Number.isFinite(earned) &&
              earned > 0 &&
              at !== null &&
              Date.now() - at < 3 * 60 * 1000
            ) {
              setLiveXp(earned);
            }
          }
        })
        .catch(() => {});

    fetchStats();
    // One retry: some settle paths apply the counters fire-and-forget, so
    // the result can reach the client a moment before the XP write lands.
    const retry = setTimeout(() => {
      if (xp === null) fetchStats();
    }, 1200);

    // True weekly rank + the movement caused by the most recent settled
    // match (server-authoritative deltas written at settlement time, read
    // via /api/leaderboard/my-rank). Wins only — a loss screen leads with
    // the run-it-back path, never salt. A rank beyond the top 100 stays
    // hidden.
    if (rank === null && outcome === "win") {
      fetch("/api/leaderboard/my-rank", {
        credentials: "include",
        signal: controller.signal,
      })
        .then((res) => res.json().catch(() => null))
        .then((data) => {
          const r = Number(data?.rank);
          const d = Number(data?.delta);
          if (Number.isFinite(r) && r > 0 && r <= 100) {
            setLiveRank(r);
            if (Number.isFinite(d)) setLiveRankDelta(d);
          }
        })
        .catch(() => {});
    }

    return () => {
      clearTimeout(retry);
      controller.abort();
    };
  }, [open, outcome, streak, rank, xp]);

  const displayStreak = streak ?? (outcome === "win" ? liveStreak : null);
  const displayRank = rank ?? liveRank;
  const displayRankDelta = rankDelta ?? liveRankDelta;
  const displayXp = xp ?? liveXp;
  // A 1-win streak is not a streak worth celebrating — start at 2.
  const showStreak = displayStreak !== null && Number(displayStreak) >= 2;
  const showRank =
    outcome === "win" && displayRank !== null && Number(displayRank) > 0;

  const hasRewards =
    tokenDelta !== null ||
    displayXp !== null ||
    (Array.isArray(progress) && progress.length > 0);

  const rows = [
    ...summary,
    ...(durationSeconds !== null && durationSeconds !== undefined
      ? [{ label: "Duration", value: formatDuration(durationSeconds) }]
      : []),
  ];

  const allDetails = [
    ...(gameName ? [{ label: "Game", value: gameName }] : []),
    ...details,
    ...(durationSeconds !== null && durationSeconds !== undefined
      ? [{ label: "Duration", value: formatDuration(durationSeconds) }]
      : []),
  ];
  const hasDetails = allDetails.length > 0 || detailsContent !== null;

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          {...withReducedMotion(shouldReduce, {
            // Short backdrop fade so the final board (with the scoring bucket
            // still highlighted) is briefly visible as the gameplay state hands
            // over to the result state — then the panel lands on top.
            initial: { opacity: 0 },
            animate: { opacity: 1 },
            exit: { opacity: 0 },
            transition: { duration: 0.18, ease: "easeOut" },
          })}
          role="dialog"
          aria-modal="true"
          aria-label={`Match result — ${style.label}`}
          className={`fixed inset-0 z-[95] flex items-center justify-center overflow-y-auto bg-black/80 px-3 py-6 backdrop-blur-sm sm:px-4 ${
            compact ? "!px-2 !py-3" : ""
          }`}
        >
          <motion.div
            {...withReducedMotion(shouldReduce, {
              ...panelMotion,
              // A win settles with its small overshoot; a loss lands firmer and
              // flatter (no bounce), so the hand reads as a hit rather than a
              // flourish. Deliberately the ONLY difference — no shake, no red
              // wash, no extra negative effect.
              transition:
                outcome === "loss"
                  ? { type: "spring", stiffness: 340, damping: 30 }
                  : panelMotion.transition,
            })}
            className={`relative w-full rounded-2xl border-2 bg-gradient-to-b text-center ${style.gradient} ${
              compact
                ? "max-w-[22rem] p-3.5"
                : "max-w-md p-5 sm:p-6"
            }`}
          >
            {/* Outcome header */}
            <div className="relative">
              <motion.div
                initial={shouldReduce ? false : { scale: 0, rotate: -20 }}
                animate={{ scale: 1, rotate: 0 }}
                transition={{ type: "spring", stiffness: 280, damping: 14, delay: 0.08 }}
                className="mx-auto mb-2 flex h-16 w-16 items-center justify-center rounded-2xl border border-white/10 bg-black/30"
              >
                <OutcomeIcon size={compact ? 30 : 44} className={style.glow} aria-hidden="true" />
              </motion.div>
              {/* Outcome chip — a compact eyebrow, never the hero. The
                  achievement line below carries the emotional weight. */}
              <span
                className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-black uppercase tracking-[0.2em] ${
                  outcome === "win"
                    ? "border-emerald-300/50 bg-emerald-400/15 text-emerald-300"
                    : outcome === "loss"
                      ? "border-red-300/50 bg-red-400/15 text-red-300"
                      : "border-cyan-300/50 bg-cyan-400/15 text-cyan-300"
                }`}
              >
                <OutcomeIcon size={14} aria-hidden="true" />
                {outcome === "win" ? "YOU WON" : outcome === "loss" ? "DEFEAT" : "DRAW"}
              </span>
              <div className="mx-auto mt-2 h-0.5 w-16 rounded-full opacity-60">
                <div className={`h-full w-full rounded-full ${style.borderTop}`} />
              </div>
              {/* Hero — "YOU BEAT @PLAYER" (win) / "DEFEATED BY @PLAYER"
                  (loss). Only when the opponent is a real player with a
                  name (never for AI, never fabricated); otherwise the
                  outcome itself is the hero. The game's own headline
                  (scores, rounds…) drops below as the supporting line. */}
              {outcome === "win" &&
                opponent &&
                !opponent.isAi &&
                opponent.name &&
                opponent.name !== "Opponent" &&
                opponent.name !== "GRYND AI" ? (
                <>
                  <p
                    className={`font-black uppercase tracking-[0.15em] text-emerald-300 drop-shadow-[0_0_12px_rgba(52,211,153,0.6)] ${
                      compact ? "mt-2 text-sm" : "mt-2 text-lg sm:text-xl"
                    }`}
                  >
                    You beat
                  </p>
                  <p
                    className={`truncate font-black text-[#f5ff3b] drop-shadow-[0_0_16px_rgba(255,215,0,0.55)] ${
                      compact ? "text-2xl" : "text-4xl sm:text-5xl"
                    }`}
                  >
                    @{opponent.name}
                  </p>
                  {/* Game-specific line (rounds, score, pot…) stays visible
                      under the beat line — it's real match data. */}
                  {headline && headline !== style.tagline && (
                    <p className={`mt-1.5 text-white/75 ${compact ? "text-[11px]" : "text-sm"}`}>
                      {headline}
                    </p>
                  )}
                </>
              ) : outcome === "loss" &&
                opponent &&
                !opponent.isAi &&
                opponent.name &&
                opponent.name !== "Opponent" &&
                opponent.name !== "GRYND AI" ? (
                <>
                  <p
                    className={`font-black uppercase tracking-[0.15em] text-red-300 drop-shadow-[0_0_12px_rgba(248,113,113,0.55)] ${
                      compact ? "mt-2 text-sm" : "mt-2 text-lg sm:text-xl"
                    }`}
                  >
                    Defeated by
                  </p>
                  <p
                    className={`truncate font-black text-white/95 ${
                      compact ? "text-2xl" : "text-4xl sm:text-5xl"
                    }`}
                  >
                    @{opponent.name}
                  </p>
                  {headline && headline !== style.tagline && (
                    <p className={`mt-1.5 text-white/75 ${compact ? "text-[11px]" : "text-sm"}`}>
                      {headline}
                    </p>
                  )}
                </>
              ) : outcome === "win" ? (
                <>
                  <h2
                    className={`font-black uppercase tracking-wide text-emerald-300 drop-shadow-[0_0_16px_rgba(52,211,153,0.6)] ${
                      compact ? "mt-2 text-2xl" : "mt-2 text-4xl sm:text-5xl"
                    }`}
                  >
                    You won the match
                  </h2>
                  {headline && headline !== style.tagline && (
                    <p className={`mt-1.5 text-white/75 ${compact ? "text-[11px]" : "text-sm"}`}>
                      {headline}
                    </p>
                  )}
                </>
              ) : outcome === "loss" ? (
                <>
                  <h2
                    className={`font-black uppercase tracking-wide text-red-300 drop-shadow-[0_0_14px_rgba(248,113,113,0.5)] ${
                      compact ? "mt-2 text-2xl" : "mt-2 text-4xl sm:text-5xl"
                    }`}
                  >
                    Match lost
                  </h2>
                  {headline && headline !== style.tagline && (
                    <p className={`mt-1.5 text-white/75 ${compact ? "text-[11px]" : "text-sm"}`}>
                      {headline}
                    </p>
                  )}
                </>
              ) : (
                <>
                  <h2
                    className={`font-black uppercase tracking-wide text-cyan-300 drop-shadow-[0_0_14px_rgba(34,211,238,0.6)] ${
                      compact ? "mt-2 text-2xl" : "mt-2 text-4xl sm:text-5xl"
                    }`}
                  >
                    Draw
                  </h2>
                  {headline && headline !== style.tagline && (
                    <p className={`mt-1.5 text-white/75 ${compact ? "text-[11px]" : "text-sm"}`}>
                      {headline}
                    </p>
                  )}
                </>
              )}
              {subline && (
                <p className={`mx-auto mt-2 max-w-sm text-white/60 ${compact ? "text-[10px]" : "text-xs"}`}>
                  {subline}
                </p>
              )}
            </div>

            {/* Final score — hierarchy step 1.5: after the outcome hero, the
                winner's score is emphasised and the loser's is muted but still
                fully readable. Draw passes no highlight, so both read evenly.
                Sequenced (delay) between the hero and the payout. */}
            {Array.isArray(sides) && sides.length > 0 && (
              <motion.div
                {...withReducedMotion(shouldReduce, {
                  initial: { opacity: 0, y: 8 },
                  animate: { opacity: 1, y: 0 },
                  transition: { duration: 0.2, ease: "easeOut", delay: 0.14 },
                })}
                className="mx-auto mt-4 grid w-full max-w-xs grid-cols-2 gap-2"
              >
                {sides.map((side, i) => (
                  <div
                    key={`${side.name || "side"}-${i}`}
                    className={`rounded-xl border p-2.5 text-center ${
                      side.highlight
                        ? "border-[#f5ff3b]/60 bg-[#f5ff3b]/10 shadow-[0_0_18px_rgba(245,255,59,0.25)]"
                        : "border-white/10 bg-black/25 opacity-70"
                    }`}
                  >
                    <p
                      className={`truncate text-[10px] uppercase tracking-wider ${
                        side.highlight ? "text-[#f5ff3b]/80" : "text-white/45"
                      }`}
                    >
                      {side.name}
                    </p>
                    <p
                      className={`mt-0.5 font-black tabular-nums ${
                        side.highlight ? "text-2xl text-[#f5ff3b]" : "text-xl text-white/70"
                      }`}
                    >
                      {side.score}
                    </p>
                    {side.highlight && (
                      <p className="mt-0.5 text-[9px] font-bold uppercase tracking-widest text-[#f5ff3b]/70">
                        Winner
                      </p>
                    )}
                  </div>
                ))}
              </motion.div>
            )}

            {/* Rewards — only rows whose data actually exists.
                Sequenced AFTER the outcome, never with it: the win/loss hero
                lands first, then the payout (token delta, XP, progression)
                registers one short beat later, so the order the player reads
                is result → money → details. A rise + fade with a hair of
                scale, 0.22s, gated through the shared helper — with reduced
                motion it appears in place with no movement and no delay. The
                XP bar inside keeps its own width animation: different
                property, no conflict with this container. */}
            {hasRewards && (
              <motion.div
                {...withReducedMotion(shouldReduce, {
                  initial: { opacity: 0, y: 8, scale: 0.97 },
                  animate: { opacity: 1, y: 0, scale: 1 },
                  transition: { duration: 0.22, ease: "easeOut", delay: 0.24 },
                })}
                className="mx-auto mt-5 w-full max-w-xs space-y-2"
              >
                {tokenDelta !== null && (
                  <div className={`flex items-center justify-between rounded-xl border border-white/10 bg-black/25 ${compact ? "px-3 py-2" : "px-4 py-2.5"}`}>
                    <span className="text-xs font-semibold uppercase tracking-wider text-white/50">
                      Tokens
                    </span>
                    <motion.span
                      initial={shouldReduce ? false : { scale: 1.12 }}
                      animate={{ scale: 1 }}
                      transition={{ duration: 0.25, ease: "easeOut", delay: 0.24 }}
                      className={`inline-flex items-center gap-1.5 font-black ${compact ? "text-base" : "text-lg"} ${
                        tokenDelta > 0
                          ? "text-emerald-300"
                          : tokenDelta < 0
                            ? "text-red-300"
                            : "text-white/80"
                      }`}
                    >
                      {tokenDelta > 0 ? "+" : ""}
                      <AnimatedNumber value={tokenDelta} reduce={shouldReduce === true} />
                      <IconCoins size={18} className="text-[#f5ff3b]" aria-hidden="true" />
                    </motion.span>
                  </div>
                )}
                {displayXp !== null && (
                  <div className="flex items-center justify-between rounded-xl border border-white/10 bg-black/25 px-4 py-2.5">
                    <span className="text-xs font-semibold uppercase tracking-wider text-white/50">
                      XP
                    </span>
                    <span className="inline-flex items-center gap-1.5 text-lg font-black text-cyan-300">
                      +{formatTokens(displayXp)}
                      <IconStar size={18} className="text-[#00e5ff]" aria-hidden="true" />
                    </span>
                  </div>
                )}
                {progress.map((p) => (
                  <div key={p.label} className="rounded-xl border border-white/10 bg-black/25 px-4 py-2.5">
                    <div className="flex items-center justify-between text-sm">
                      <span className="font-bold text-white/85">{p.label}</span>
                      <span className="font-black text-white">
                        {p.from} <span className="text-white/40">→</span>{" "}
                        <span className={style.accentText}>{p.to}</span>
                      </span>
                    </div>
                    <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-white/10">
                      <motion.div
                        initial={shouldReduce ? false : { width: 0 }}
                        animate={{ width: `${Math.max(0, Math.min(100, p.percent))}%` }}
                        transition={{ duration: 0.8, ease: "easeOut", delay: 0.25 }}
                        className={`h-full rounded-full ${style.borderTop}`}
                      />
                    </div>
                  </div>
                ))}
              </motion.div>
            )}

            {/* Progression chips — real streak + weekly rank, hidden when
                absent or when the game passed nothing. */}
            {(showStreak || showRank) && (
              <div className="mx-auto mt-4 flex w-full max-w-xs flex-wrap items-center justify-center gap-2">
                {showStreak && (
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-300/50 bg-amber-400/15 px-3 py-1 text-xs font-black uppercase tracking-wider text-amber-300">
                    <span aria-hidden="true">🔥</span>
                    {formatNumber(showStreak)} win streak
                  </span>
                )}
                {showRank && (
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-[#00e5ff]/50 bg-[#00e5ff]/10 px-3 py-1 text-xs font-black uppercase tracking-wider text-[#00e5ff]">
                    <IconTrophy size={14} aria-hidden="true" />
                    {displayRankDelta !== null && Number(displayRankDelta) > 0
                      ? `RANK \u2191 ${formatNumber(displayRankDelta)} \u00b7 #${formatNumber(displayRank)}`
                      : `WEEKLY RANK #${formatNumber(displayRank)}`}
                  </span>
                )}
              </div>
            )}

            {/* Opponent */}
            {opponent && (
              <div className="mx-auto mt-5 flex w-full max-w-xs items-center justify-center gap-3 rounded-xl border border-white/10 bg-black/25 px-4 py-3">
                {opponent.iconKey ? (
                  <IconAvatar
                    iconKey={opponent.iconKey}
                    name={opponent.name}
                    size="h-11 w-11"
                    showFrame={false}
                    rounded="rounded-full"
                  />
                ) : (
                  <div className="flex h-11 w-11 items-center justify-center rounded-full border border-white/15 bg-white/10 text-lg font-black text-[#d8fbff]">
                    {(opponent.name || "?").charAt(0).toUpperCase()}
                  </div>
                )}
                <div className="min-w-0 text-left">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-white/45">
                    Opponent
                  </p>
                  <p className="truncate text-sm font-bold text-[#f5ff3b]">
                    {opponent.isAi ? (
                      <span className="inline-flex items-center gap-1">
                        <IconRobot size={15} className="text-cyan-300" aria-hidden="true" />
                        {opponent.name || "GRYND AI"}
                      </span>
                    ) : (
                      opponent.name || "Opponent"
                    )}
                  </p>
                </div>
              </div>
            )}

            {/* Compact match summary */}
            {rows.length > 0 && (
              <div className="mx-auto mt-5 w-full max-w-xs space-y-1.5 rounded-xl border border-white/10 bg-black/25 px-4 py-3 text-sm">
                {rows.map((row) => (
                  <p key={row.label} className="flex items-center justify-between gap-4">
                    <span className="shrink-0 text-white/50">{row.label}</span>
                    <span className="truncate text-right font-semibold text-white/90">
                      {row.value}
                    </span>
                  </p>
                ))}
              </div>
            )}

            {/* Actions */}
            {(playAgain || rematch || onReturnToLobby || onDismiss) && (
              <div className="mx-auto mt-6 flex w-full max-w-xs flex-col gap-2.5">
                {playAgain && (
                  <button
                    type="button"
                    onClick={guard(playAgain.onClick)}
                    disabled={navigating}
                    className="w-full rounded-xl border-b-4 border-[#0087a8] bg-[#00e5ff] px-5 py-3 text-sm font-extrabold text-[#001a2e] transition hover:brightness-110 disabled:opacity-60"
                  >
                    {playAgain.label || "RUN IT BACK"}
                  </button>
                )}
                {rematch && (
                  <button
                    type="button"
                    onClick={guard(rematch.onClick)}
                    disabled={navigating}
                    className="w-full rounded-xl border border-[#00e5ff]/50 bg-[#00e5ff]/10 px-5 py-3 text-sm font-bold text-[#67f9ff] transition hover:bg-[#00e5ff]/20 disabled:opacity-60"
                  >
                    {rematch.label || "Rematch"}
                  </button>
                )}
                {onReturnToLobby && (
                  <button
                    type="button"
                    onClick={guard(onReturnToLobby)}
                    disabled={navigating}
                    className="w-full rounded-xl border border-white/15 bg-white/5 px-5 py-3 text-sm font-semibold text-white/80 transition hover:bg-white/10 disabled:opacity-60"
                  >
                    Return to Lobby
                  </button>
                )}
                {onDismiss && (
                  <button
                    type="button"
                    onClick={onDismiss}
                    className="w-full rounded-xl border border-white/10 px-5 py-2.5 text-xs font-semibold text-white/50 transition hover:bg-white/5 hover:text-white/80"
                  >
                    {dismissLabel}
                  </button>
                )}
              </div>
            )}

            {/* Expandable match details */}
            {hasDetails && (
              <div className="mx-auto mt-5 w-full max-w-xs overflow-hidden rounded-xl border border-white/10">
                <button
                  type="button"
                  onClick={() => setDetailsOpen((v) => !v)}
                  aria-expanded={detailsOpen}
                  className="flex w-full items-center justify-between bg-black/25 px-4 py-2.5 text-left text-xs font-bold uppercase tracking-wider text-white/60 transition hover:bg-black/35"
                >
                  Match Details
                  <IconChevronDown
                    size={16}
                    className={`transition-transform duration-200 ${detailsOpen ? "rotate-180" : ""}`}
                    aria-hidden="true"
                  />
                </button>
                <AnimatePresence initial={false}>
                  {detailsOpen && (
                    <motion.div
                      initial={shouldReduce ? false : { height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={shouldReduce ? undefined : { height: 0, opacity: 0 }}
                      transition={{ duration: 0.22, ease: "easeOut" }}
                      className="bg-black/15"
                    >
                      <div className="space-y-1.5 px-4 py-3 text-xs">
                        {allDetails.map((row) => (
                          <p key={row.label} className="flex items-center justify-between gap-4">
                            <span className="text-white/45">{row.label}</span>
                            <span className="truncate text-right font-semibold text-white/85">
                              {row.value}
                            </span>
                          </p>
                        ))}
                        {detailsContent}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}