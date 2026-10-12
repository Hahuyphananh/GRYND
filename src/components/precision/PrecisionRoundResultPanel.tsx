"use client";

// ── Per-round outcome overlay for the Precision match page ───────────────
//
// After both players stop for a round, the server broadcasts a fresh
// `precision:roundResult` carrying the per-seat timing telemetry and the
// round winner (or null on a tie). The match page snapshots those values
// into a `roundResultReveal` state and renders THIS overlay on top of
// the page for a brief reveal window.
//
// The overlay answers ONE question — "did I take this round?" — in a single
// glance:
//
//   * GREEN → the local seat won the round,
//   * RED   → the other seat did,
//   * AMBER → a true tie (the same round is re-armed with a fresh target).
//
// It deliberately shows NO numbers. The per-seat times, deltas and rank badges
// the previous version printed are NOT readable in the few seconds this card is
// up, and the board underneath already recaps the round spatially (the arming
// phase parks both rockets at their server-stamped stops). The graded values
// remain on `state.lastRoundStops` — server-stamped telemetry the client never
// recomputes — for the scoreboard badges and the end-of-match recap.
//
// Behaviour:
//   1. Staggered entrance — backdrop fades, the card scales in, then the icon
//      and the verdict hit at their own delays.
//   2. Auto-dismiss — the card gives the screen back after the reveal window,
//      and the countdown line ticks the remainder down so the player can see
//      when the next round starts.
//
// NOTE: `roundWinnerSeat` is SERVER-AUTHORITATIVE. Green/red/amber is a lookup
// of that value against the local seat and nothing else.

import React from "react";
import { AnimatePresence, motion } from "framer-motion";

import { gameOverModal } from "../../lib/animations";
import { IconHeartHandshake, IconMoodSad, IconTrophy } from "@tabler/icons-react";
import { ROUND_RESULT_REVEAL_MS } from "../../lib/precision/constants";
import type { PlayerSeat } from "../../lib/precision/types";
import { useTranslation } from "../../hooks/useTranslation";

/** Auto-dismiss delay (ms) before the panel returns control to the
 *  underlying page — re-exported from the shared constants because the SERVER
 *  reads the same number: it holds the next round's countdown behind this
 *  window so the round can never open while the results are still on screen.
 *  See `ROUND_RESULT_REVEAL_MS` in `lib/precision/constants.ts`. */
export { ROUND_RESULT_REVEAL_MS } from "../../lib/precision/constants";

/** What the card is telling the player. */
export type PrecisionRoundOutcome = "win" | "loss" | "tie";

export interface PrecisionRoundResultPanelProps {
  /** 1 (seat 1 won the round), 2 (seat 2 won), or null on a true tie. */
  roundWinnerSeat: PlayerSeat | null;
  /** The viewing user's own seat. This is what turns `roundWinnerSeat` into
   *  green (we took it) or red (we didn't). */
  localSeat: PlayerSeat;
  /** Stable identity of the decision being revealed — `RoundResultReveal.signature`
   *  from `lib/precision/matchView`. It restarts this card's window for each new
   *  decision (two rounds with the same outcome are otherwise indistinguishable
   *  here) and is rendered as `data-decision`, so a check can tell one round's
   *  result from another's. */
  decision: string;
  /** How long this card stays up (ms). The match page passes the window it
   *  measured from the SERVER's decision stamp (see `revealWindowMsOf`), so the
   *  "next round in" line counts the real remainder instead of a fixed 3s. */
  windowMs?: number;
  /** Fires when the panel auto-dismisses or the parent unmounts it. */
  onDismiss?: () => void;
}

/** The card's palette + copy, per outcome. The local seat's verdict is the
 *  heading; the seat that was closer to the target is the one-line explainer
 *  underneath (a tie explains the replayed round instead). */
function outcomeCard(
  outcome: PrecisionRoundOutcome,
  winnerSeat: PlayerSeat | null,
  localSeat: PlayerSeat,
  t: (key: string, vars?: Record<string, unknown>) => string,
) {
  if (outcome === "win") {
    return {
      glow: "shadow-[0_0_60px_rgba(16,185,129,0.5)]",
      ring: "border-emerald-300/80",
      bg: "bg-gradient-to-b from-[#04251a] to-[#02150e]",
      accent: "bg-gradient-to-r from-emerald-500 via-emerald-300 to-teal-300",
      heading: "text-emerald-200",
      iconColor: "text-emerald-300",
      icon: <IconTrophy size={54} stroke={1.75} aria-hidden="true" />,
      word: t("games.precision.you_win_round"),
      subtitle: t("games.precision.closer_to_target", { seat: localSeat }),
    };
  }
  if (outcome === "loss") {
    return {
      glow: "shadow-[0_0_60px_rgba(239,68,68,0.45)]",
      ring: "border-red-400/80",
      bg: "bg-gradient-to-b from-[#2a0a0f] to-[#150305]",
      accent: "bg-gradient-to-r from-red-600 via-rose-400 to-orange-400",
      heading: "text-red-200",
      iconColor: "text-red-300",
      icon: <IconMoodSad size={54} stroke={1.75} aria-hidden="true" />,
      word: t("games.precision.you_lose_round"),
      subtitle: t("games.precision.closer_to_target", {
        seat: winnerSeat === null ? localSeat : winnerSeat,
      }),
    };
  }
  return {
    glow: "shadow-[0_0_60px_rgba(245,158,11,0.45)]",
    ring: "border-amber-300/80",
    bg: "bg-gradient-to-b from-[#2a1e05] to-[#161003]",
    accent: "bg-gradient-to-r from-amber-400 via-yellow-300 to-amber-500",
    heading: "text-amber-200",
    iconColor: "text-amber-300",
    icon: <IconHeartHandshake size={54} stroke={1.75} aria-hidden="true" />,
    word: t("games.precision.tie_replaying"),
    subtitle: t("games.precision.tie_explainer"),
  };
}

function PrecisionRoundResultPanelImpl({
  roundWinnerSeat,
  localSeat,
  decision,
  windowMs = ROUND_RESULT_REVEAL_MS,
  onDismiss,
}: PrecisionRoundResultPanelProps) {
  const { t } = useTranslation();
  // OPTIMIZATION — render-shield: gate the auto-dismiss timer on a STABLE inner
  // wrapper that calls `onDismissRef.current?.()` rather than the `onDismiss`
  // prop directly. The parent (match page) recreates `onDismiss` as a fresh
  // arrow function on every render and the page re-renders on every poll tick —
  // without this ref indirection the panel's effect dep `[onDismiss]` would
  // tear down + re-spin its window on every parent render, effectively making
  // the timer RESET and never fire.
  const onDismissRef = React.useRef(onDismiss);
  React.useEffect(() => {
    onDismissRef.current = onDismiss;
  }, [onDismiss]);

  // A nonsensical window (0 / NaN) would show the card for a single frame and
  // then dismiss it, which reads as "no result at all" — fall back to the
  // shared window instead.
  const visibleMs =
    Number.isFinite(windowMs) && windowMs > 0 ? Math.floor(windowMs) : ROUND_RESULT_REVEAL_MS;
  const [remainingMs, setRemainingMs] = React.useState(visibleMs);

  // The window is (re)started per DECISION — `decision` is the stable identity
  // of the result being shown, so a new one clears the old timer and starts a
  // fresh window instead of reusing (and prematurely firing) the previous
  // round's. The ticking remainder is display-only: the dismissal below is what
  // actually ends the card.
  React.useEffect(() => {
    setRemainingMs(visibleMs);
    const startedAt = Date.now();
    const tick = setInterval(() => {
      setRemainingMs(Math.max(0, visibleMs - (Date.now() - startedAt)));
    }, 250);
    const dismiss = setTimeout(() => {
      onDismissRef.current?.();
    }, visibleMs);
    return () => {
      clearInterval(tick);
      clearTimeout(dismiss);
    };
  }, [decision, visibleMs]);

  const outcome: PrecisionRoundOutcome =
    roundWinnerSeat === null ? "tie" : roundWinnerSeat === localSeat ? "win" : "loss";
  const card = outcomeCard(outcome, roundWinnerSeat, localSeat, t);
  const secondsLeft = Math.max(0, Math.ceil(remainingMs / 1000));

  return (
    <AnimatePresence>
      <motion.div
        {...gameOverModal.backdrop}
        key="precision-round-result-backdrop"
        data-testid="precision-round-result-panel"
        // The outcome is the whole message, so it is also the machine-readable
        // part of this overlay: `data-outcome` is what a check asserts instead
        // of grepping copy out of the card.
        data-outcome={outcome}
        data-winner-seat={roundWinnerSeat === null ? "" : String(roundWinnerSeat)}
        data-local-seat={String(localSeat)}
        data-decision={decision}
        className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 px-4 backdrop-blur-sm"
      >
        <motion.div
          {...gameOverModal.panel}
          className={`relative w-full max-w-md max-h-[92vh] overflow-y-auto rounded-3xl border ${card.ring} ${card.bg} p-6 text-center shadow-2xl ${card.glow} sm:p-8`}
        >
          {/* Top accent strip — the outcome's own colour, so the verdict is
              readable from the glow alone. */}
          <motion.div
            initial={{ scaleX: 0 }}
            animate={{ scaleX: 1 }}
            transition={{ delay: 0.05, duration: 0.4 }}
            className={`absolute inset-x-0 top-0 h-1.5 origin-left ${card.accent}`}
          />

          <motion.p
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1, duration: 0.3 }}
            className="text-[10px] font-black uppercase tracking-[0.45em] text-slate-300/80"
          >
            {t("games.precision.round_result_title")}
          </motion.p>

          <motion.div
            initial={{ scale: 0, rotate: -25 }}
            animate={{ scale: 1, rotate: 0 }}
            transition={{ delay: 0.18, type: "spring", stiffness: 220, damping: 12 }}
            data-testid="precision-round-result-icon"
            className={`mt-5 ${card.iconColor} drop-shadow-[0_0_18px_currentColor]`}
          >
            {card.icon}
          </motion.div>

          <motion.h2
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.26, type: "spring", stiffness: 240, damping: 18 }}
            data-testid="precision-round-result-outcome"
            className={`mt-4 text-3xl font-black uppercase leading-tight sm:text-4xl ${card.heading}`}
          >
            {card.word}
          </motion.h2>

          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.38, duration: 0.3 }}
            className="mx-auto mt-3 max-w-xs text-sm text-slate-200"
          >
            {card.subtitle}
          </motion.p>

          {/* The next round's countdown, ticking down the rest of the window
              the match page measured — the player can see exactly how long
              this card has left before the round opens. */}
          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.45, duration: 0.4 }}
            className="mt-6 text-[11px] font-bold uppercase tracking-widest text-slate-300/90"
            data-testid="precision-round-result-countdown"
          >
            {t("games.precision.next_round_in", { seconds: secondsLeft })}
          </motion.p>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}

// OPTIMIZATION — wrap the panel in React.memo so the page's render churn
// (poll ticks, the round clock's frames) doesn't force the whole overlay subtree
// (animating backdrop, icon, headings) to re-render unless one of the visible
// inputs actually changes. Combined with the onDismiss-deferral above, the panel
// stays idle between its own countdown ticks.
export default React.memo(PrecisionRoundResultPanelImpl);
