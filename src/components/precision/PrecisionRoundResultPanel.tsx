"use client";

// ── Per-round results overlay for the Precision match page ───────────────
//
// After both players stop for a round, the server broadcasts a fresh
// `precision:roundResult` carrying the per-seat timing telemetry and the
// round winner (or null on a tie). The match page snapshots those values
// into a `roundResultReveal` state and renders THIS overlay on top of
// the page for a brief reveal window.
//
// Behaviour:
//   1. Staggered entrance — backdrop fades, the panel scales in, then
//      each row hits at its own delay so the user reads the values from
//      top (target) → bottom (winner) without feeling overloaded.
//   2. Local-player perspective — the local seat's row is outlined and
//      its time / diff are foregrounded.
//   3. Tie handling — when the server emits `roundWinnerSeat === null`
//      but both seats have stopped (a true tied difference), the
//      winner row shows "TIE — ROUND REPLAYING" instead.
//   4. Auto-dismiss — after 3 seconds the panel fades out. The parent
//      page then sees the canonical phase (`arming` for replay, or
//      `active` for the next round) and renders normally underneath.
//
// NOTE: All numerical inputs are SERVER-AUTHORITATIVE telemetry. The
// client receives them from the `precision:roundResult` broadcast,
// never measures time itself, never trusts any user-supplied ms.

import React from "react";
import { AnimatePresence, motion } from "framer-motion";

import { gameOverModal } from "../../lib/animations";
import { diffToRank } from "../../lib/precision/utils";
import type { PlayerSeat } from "../../lib/precision/types";
import { useTranslation } from "../../hooks/useTranslation";

/** Auto-dismiss delay (ms) before the panel returns control to the
 *  underlying page. 3 seconds — matches the spec: results are visible
 *  for three seconds, then the next round starts. */
export const ROUND_RESULT_REVEAL_MS = 3_000;

export interface PrecisionRoundResultPanelProps {
  /** The round's revealed target time in ms. Server-stamped: the panel
   *  renders this number verbatim without computing anything locally. */
  targetMs: number;
  seat1Name: string;
  /** Server-stamped elapsed time for seat 1 (stopInstant - roundGoInstant). */
  seat1ElapsedMs: number;
  /** Server-stamped |elapsedMs - targetMs| for seat 1. Computed once
   *  server-side in `recordRoundStop` so the client never recomputes. */
  seat1DiffMs: number;
  seat2Name: string;
  /** Server-stamped elapsed time for seat 2. */
  seat2ElapsedMs: number;
  /** Server-stamped diff for seat 2. */
  seat2DiffMs: number;
  /** 1 (seat 1 wins), 2 (seat 2 wins), or null on a true tie. */
  roundWinnerSeat: PlayerSeat | null;
  /** The viewing user's local seat for perspective highlighting. */
  localSeat: PlayerSeat;
  /** Fires when the panel auto-dismisses or the parent unmounts it. */
  onDismiss?: () => void;
}

interface RowProps {
  seat: PlayerSeat;
  name: string;
  elapsedMs: number;
  diffMs: number;
  isWinner: boolean;
  isLocal: boolean;
  isTiedRounding: boolean;
  delay: number;
}

// Hook called at module scope so PlayerRow (defined above as a sibling
// component) shares the same `t` reference instead of needing its own.
const { t } = useTranslation();

const PlayerRow = React.memo(function PlayerRow({
  seat,
  name,
  elapsedMs,
  diffMs,
  isWinner,
  isLocal,
  isTiedRounding,
  delay,
}: RowProps) {
  // Per-seat palette — seat 1 is fuchsia-magenta, seat 2 is cyan-blue,
  // matches the existing PrecisionScoreboard's colour coding so the
  // user's eye can track "my seat" between panels quickly.
  const palette =
    seat === 1
      ? {
          ring: isWinner ? "ring-2 ring-fuchsia-300/80" : "ring-1 ring-fuchsia-700/40",
          label: "text-fuchsia-200",
          bg: isWinner
            ? "bg-gradient-to-b from-fuchsia-500/25 to-fuchsia-700/15"
            : "bg-fuchsia-950/30",
          time: "text-fuchsia-100",
        }
      : {
          ring: isWinner ? "ring-2 ring-cyan-300/80" : "ring-1 ring-cyan-700/40",
          label: "text-cyan-200",
          bg: isWinner
            ? "bg-gradient-to-b from-cyan-500/25 to-cyan-700/15"
            : "bg-cyan-950/30",
          time: "text-cyan-100",
        };
  return (
    <motion.div
      initial={{ x: seat === 1 ? -40 : 40, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: seat === 1 ? -40 : 40, opacity: 0 }}
      transition={{ delay, type: "spring", stiffness: 280, damping: 22 }}
      data-testid={`precision-round-result-row-${seat}`}
      className={`relative flex items-center justify-between gap-3 rounded-2xl px-4 py-3 ${palette.bg} ${palette.ring} ${
        isLocal ? "shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]" : ""
      }`}
    >
      <div className="flex min-w-0 flex-col">
        <span className={`text-[10px] font-bold uppercase tracking-[0.3em] ${palette.label}`}>
          {seat === 1 ? t("games.precision.seat_alpha") : t("games.precision.seat_bravo")}{" "}
          {isLocal ? (
            <span data-testid="precision-round-result-local-tag" className="ml-1 rounded bg-white/10 px-1.5 py-0.5 text-[9px] tracking-wide text-white">
              {t("games.precision.you_tag")}
            </span>
          ) : null}
          {isWinner ? (
            <span data-testid="precision-round-result-winner-tag" className="ml-1 rounded bg-yellow-300/90 px-1.5 py-0.5 text-[9px] font-black tracking-wide text-black">
              {t("games.precision.winner_tag")}
            </span>
          ) : null}
        </span>
        <span className="truncate text-sm font-semibold text-slate-100">{name}</span>
      </div>
      <div className="flex flex-col items-end">
        <span className={`text-3xl font-black tabular-nums ${palette.time}`}>
          {elapsedMs.toLocaleString()}
          <span className="ml-1 text-base font-bold text-slate-300">{t("games.precision.ms_suffix")}</span>
        </span>
        <span className="text-[11px] font-bold uppercase tracking-widest text-slate-300">
          Δ{" "}
          <span className={isTiedRounding ? "text-yellow-300" : "text-yellow-200/80"}>
            {diffMs >= 0 ? `+${diffMs}` : diffMs}
          </span>{" "}
          ms
        </span>
        {/* ── Rank badge ── */}
        {(() => {
          const rank = diffToRank(diffMs);
          return (
            <span
              data-testid={`precision-round-result-rank-${seat}`}
              className={`mt-1 inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[9px] font-black uppercase ${rank.bg} ${rank.border}`}
            >
              <span>{rank.emoji}</span>
              <span className={rank.color}>{rank.label}</span>
            </span>
          );
        })()}
      </div>
    </motion.div>
  );
});

function PrecisionRoundResultPanelImpl({
  targetMs,
  seat1Name,
  seat1ElapsedMs,
  seat1DiffMs,
  seat2Name,
  seat2ElapsedMs,
  seat2DiffMs,
  roundWinnerSeat,
  localSeat,
  onDismiss,
}: PrecisionRoundResultPanelProps) {
  const { t } = useTranslation();
  // OPTIMIZATION — render-shield: gate the auto-dismiss setTimeout on
  // a STABLE inner wrapper that calls `onDismissRef.current?.()` rather
  // than the `onDismiss` prop directly. The parent (match page)
  // recreates `onDismiss` as a fresh arrow function on every poll tick
  // (every ~1.5s) and the page polls continuously — without this ref
  // indirection the panel's useEffect dep `[onDismiss]` would tear
  // down + re-spin a 3-second setTimeout on every parent render,
  // effectively making the timer RESET on every poll and never fire.
  // The wrapper still calls the latest onDismiss from the ref without
  // needing it in the dep list. The parent is expected to keep
  // `onDismiss` stable via useCallback for full memo benefit (the
  // outer React.memo wrapper below also helps avoid full subtree
  // re-renders when an unrelated polling tick changes state).
  //
  // Bug-fix note: the auto-dismiss effect was previously `useEffect(..., [])`
  // (mounted once). That meant a NEW round's reveal arriving within the
  // 3s window reused the original timer, which fired at mount+3s — that
  // would prematurely dismiss Round N+1 (only ~0.5s in if Round N mounted
  // 2.5s ago). The dep list below includes the per-round signature data
  // (targetMs, per-seat elapsedMs/diffMs, roundWinnerSeat). When ANY of
  // these change (new round decision received via socket or polling),
  // the cleanup clears the OLD timer and a NEW 3s window starts. This
  // mirrors the prior `[onDismiss]` behavior — except the dep is now
  // semantically meaningful (data changes), not a parent-render side
  // effect. localSeat is intentionally excluded (stable per match).
  const onDismissRef = React.useRef(onDismiss);
  React.useEffect(() => {
    onDismissRef.current = onDismiss;
  }, [onDismiss]);
  React.useEffect(() => {
    const id = setTimeout(() => {
      onDismissRef.current?.();
    }, ROUND_RESULT_REVEAL_MS);
    return () => clearTimeout(id);
  }, [
    targetMs,
    seat1ElapsedMs,
    seat1DiffMs,
    seat2ElapsedMs,
    seat2DiffMs,
    roundWinnerSeat,
  ]);

  const isTie = roundWinnerSeat === null;
  // Diffs are server-stamped in recordRoundStop (`bucket[userId].diffMs`)
  // and surfaced via PrecisionState.lastRoundStops.{seat1,seat2}.diffMs.
  // The panel NEVER recomputes |elapsedMs - targetMs| locally so a
  // tampered client cannot present a different delta than the server.
  const seat1Diff = seat1DiffMs;
  const seat2Diff = seat2DiffMs;

  // Rounding-aware tie helper: when both seats' server-stamped elapseds
  // are byte-identical AND their diffs are equal, surface that as a
  // "Δ 0" alert so the user understands WHY the round counts as a tie
  // even though their interpolated values feel different.
  const perfectlyEqual =
    seat1ElapsedMs === seat2ElapsedMs && seat1Diff === seat2Diff;

  // Banner palette decided per outcome — winner gold, tie cyan-yellow.
  const bannerPalette = isTie
    ? {
        glow: "shadow-[0_0_45px_rgba(250,204,21,0.45)]",
        ring: "border-yellow-300/70",
        bg: "bg-gradient-to-b from-[#0a2a1a] to-[#031a0a]",
        heading: "text-yellow-200",
        word: t("games.precision.tie_replaying"),
        icon: "🤝",
        subtitle: t("games.precision.tie_explainer"),
      }
    : roundWinnerSeat === localSeat
      ? {
          glow: "shadow-[0_0_45px_rgba(250,204,21,0.55)]",
          ring: "border-yellow-300/80",
          bg: "bg-gradient-to-b from-[#0a2a1a] to-[#031a0a]",
          heading: "text-yellow-200",
          word: t("games.precision.you_win_round"),
          icon: "🏆",
          subtitle: t("games.precision.seat_closer", { seat: roundWinnerSeat }),
        }
      : {
          glow: "shadow-[0_0_45px_rgba(217,70,239,0.45)]",
          ring: "border-fuchsia-300/70",
          bg: "bg-gradient-to-b from-[#2a0a1f] to-[#160322]",
          heading: "text-fuchsia-200",
          word: t("games.precision.round_won_by_player", { name: roundWinnerSeat === 1 ? seat1Name : seat2Name }),
          icon: "🥈",
          subtitle: t("games.precision.seat_closer", { seat: roundWinnerSeat }),
        };

  return (
    <AnimatePresence>
      <motion.div
        {...gameOverModal.backdrop}
        key="precision-round-result-backdrop"
        data-testid="precision-round-result-panel"
        className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 px-4 backdrop-blur-sm"
      >
        <motion.div
          {...gameOverModal.panel}
          className={`relative w-full max-w-lg overflow-hidden rounded-3xl border ${bannerPalette.ring} ${bannerPalette.bg} p-5 text-center shadow-2xl ${bannerPalette.glow} sm:p-7`}
        >
          {/* Top accent strip — casino-style gradient bar */}
          <motion.div
            initial={{ scaleX: 0 }}
            animate={{ scaleX: 1 }}
            transition={{ delay: 0.05, duration: 0.4 }}
            className="absolute inset-x-0 top-0 h-1 origin-left bg-gradient-to-r from-fuchsia-400 via-yellow-300 to-cyan-300"
          />

          <motion.p
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1, duration: 0.3 }}
            className="text-[10px] font-black uppercase tracking-[0.45em] text-cyan-200"
          >
            {t("games.precision.round_result_title")}
          </motion.p>

          {/* Target value */}
          <motion.div
            initial={{ y: 18, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ delay: 0.2, type: "spring", stiffness: 240, damping: 18 }}
            className="mt-2"
            data-testid="precision-round-result-target"
          >
            <p className="text-[10px] font-bold uppercase tracking-[0.35em] text-yellow-200/80">{t("games.precision.target_label")}</p>
            <p className="text-5xl font-black tabular-nums text-yellow-200 sm:text-6xl">
              {targetMs.toLocaleString()}
              <span className="ml-1 text-2xl text-yellow-200/70">{t("games.precision.ms_suffix")}</span>
            </p>
          </motion.div>

          {/* Player rows (staggered) */}
          <div className="mt-5 flex flex-col gap-3">
            <PlayerRow
              seat={1}
              name={seat1Name}
              elapsedMs={seat1ElapsedMs}
              diffMs={seat1Diff}
              isWinner={roundWinnerSeat === 1}
              isLocal={localSeat === 1}
              isTiedRounding={isTie && perfectlyEqual}
              delay={0.35}
            />
            <PlayerRow
              seat={2}
              name={seat2Name}
              elapsedMs={seat2ElapsedMs}
              diffMs={seat2Diff}
              isWinner={roundWinnerSeat === 2}
              isLocal={localSeat === 2}
              isTiedRounding={isTie && perfectlyEqual}
              delay={0.5}
            />
          </div>

          {/* Winner / tie banner */}
          <motion.div
            initial={{ y: 18, opacity: 0, scale: 0.9 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            transition={{ delay: 0.7, type: "spring", stiffness: 220, damping: 16 }}
            data-testid="precision-round-result-banner"
            className={`mt-5 rounded-2xl border ${bannerPalette.ring} bg-black/30 px-4 py-4`}
          >
            <motion.p
              initial={{ scale: 0, rotate: -25 }}
              animate={{ scale: 1, rotate: 0 }}
              transition={{ delay: 0.85, type: "spring", stiffness: 220, damping: 12 }}
              className="text-5xl leading-none"
            >
              {bannerPalette.icon}
            </motion.p>
            <h2
              className={`mt-2 text-2xl font-black uppercase ${bannerPalette.heading} sm:text-3xl`}
            >
              {bannerPalette.word}
            </h2>
            <p className="mt-1 text-xs text-slate-200 sm:text-sm">
              {bannerPalette.subtitle}
            </p>
          </motion.div>

          {/* Auto-dismiss countdown hint */}
          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.9, duration: 0.4 }}
            className="mt-4 text-[11px] font-bold uppercase tracking-widest text-cyan-100/80"
            data-testid="precision-round-result-countdown"
          >
            {t("games.precision.next_round_in")}
          </motion.p>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}

// OPTIMIZATION — wrap the panel in React.memo so the page's polling
// tick (every 1.5s) doesn't force the entire 3-second overlay subtree
// (animating backdrop, 2 PlayerRow motion containers, accent strip,
// banners) to re-render unless one of the visible inputs /
// onDismissRef wrapper actually changes. Combined with the
// onDismiss-deferral above, the panel now stays idle between rAF
// ticks while the result reveal is visible.
export default React.memo(PrecisionRoundResultPanelImpl);
