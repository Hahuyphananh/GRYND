"use client";

// ── Vertical rocket race for the Precision active phase ──────────────────
//
// Two lanes side by side (you | opponent). Each rocket climbs from the bottom
// of the track; the track's vertical axis is TIME IN SECONDS (crash-game
// style), and a dashed threshold line marks the round's target.
//
// Timing model
//   * The parent owns the clock. `liveElapsedMs` is the shared local elapsed
//     (wired to the server's GO instant via `roundClock.ts`), so both lanes
//     climb at the same rate.
//   * A lane whose `frozenElapsedMs` is set has STOPPED: its rocket parks at
//     that position and stops advancing. This is what makes a stop visible —
//     the human's the instant they click, the bot's the moment its
//     server-measured stop is published on `state.aiStop`.
//
// During the `arming` phase the same board is reused as the previous round's
// recap: both lanes are frozen at their recorded stops while the centre slot
// hosts the countdown, so the player can see exactly where the AI stopped
// before the next round begins.
//
// Purely presentational. It never measures, scores, or mutates anything.

import React, { useMemo, type ReactNode } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { IconRocket } from "@tabler/icons-react";

import { useTranslation } from "../../hooks/useTranslation";
import {
  axisPercent,
  computeAxisMaxMs,
  computeTicks,
  formatSecondsLabel,
} from "../../lib/precision/rocketAxis";
import type { PlayerSeat } from "../../lib/precision/types";

export interface RocketLane {
  seat: PlayerSeat;
  name: string;
  isSelf: boolean;
  /** Elapsed ms this lane is FROZEN at, or null while it is still flying. */
  frozenElapsedMs: number | null;
}

export interface PrecisionRocketRaceProps {
  phase: "active" | "arming";
  /** The round's target in ms (the PREVIOUS round's during the recap). */
  targetMs: number | null;
  /** Shared local elapsed clock in ms — advances every unfrozen lane. */
  liveElapsedMs: number;
  /** Lane 1 and lane 2, in seat order. */
  lanes: [RocketLane, RocketLane];
  /** Countdown remaining (ms) shown in the centre during `arming`. */
  countdownMs?: number | null;
  /** Compact variant for embedding (the round-result panel): a shorter board
   *  with the exact same lanes, no centre column. Intended for a frozen
   *  recap, not a live round. */
  compact?: boolean;
  /** Changing this replays the one-shot LIFTOFF entrance (rocket rising off
   *  the pad). The live match passes the round envelope, so every new round
   *  visibly launches instead of snapping from the recap position to the pad.
   *  Omit it in static hosts (result panel / popup) — they run their own
   *  entrance and there is no flight to launch. */
  roundKey?: string | number;
  /** The round's primary control (the STOP button), rendered INSIDE the board
   *  directly under the centre elapsed readout. The live round mounts it here
   *  so the control the player has to hit sits with the clock they are timing
   *  against, instead of in a panel below the board.
   *
   *  The slot is INSIDE the centre column, so whatever is passed must fit that
   *  column's width (`w-24 sm:w-32`) — it is deliberately not allowed to widen
   *  into either lane. Omitted by every static host (arming recap, round-result
   *  panel, end-of-match popup): they have no round to stop. */
  action?: ReactNode;
}

const LANE_PALETTE: Record<
  PlayerSeat,
  { text: string; ring: string; dot: string; trail: string; marker: string; rocket: string }
> = {
  1: {
    text: "text-fuchsia-200",
    ring: "border-fuchsia-400/50 bg-fuchsia-500/10",
    dot: "bg-fuchsia-400",
    trail: "from-fuchsia-500/0 via-fuchsia-500/40 to-fuchsia-400/90",
    marker: "border-fuchsia-300/70",
    rocket: "#e879f9",
  },
  2: {
    text: "text-cyan-200",
    ring: "border-cyan-400/50 bg-cyan-500/10",
    dot: "bg-cyan-300",
    trail: "from-cyan-500/0 via-cyan-500/40 to-cyan-300/90",
    marker: "border-cyan-300/70",
    rocket: "#67e8f9",
  },
};

function LaneView({
  lane,
  elapsedMs,
  maxMs,
  isArming,
  launchKey,
}: {
  lane: RocketLane;
  elapsedMs: number;
  maxMs: number;
  isArming: boolean;
  /** Non-null in the live match: replays the liftoff entrance when it changes. */
  launchKey: string | null;
}) {
  const { t } = useTranslation();
  const shouldReduceMotion = useReducedMotion();
  const palette = LANE_PALETTE[lane.seat];
  // Parked = this lane's rocket has a known stop, whether we are mid-round
  // (the player / bot just stopped) or showing the arming recap of the round
  // that just ended. The marker + readout belong in both cases.
  const stopped = lane.frozenElapsedMs != null;
  const pct = axisPercent(elapsedMs, maxMs);
  const seconds = (elapsedMs / 1000).toFixed(2);

  return (
    <div
      className="relative h-full min-w-0 flex-1"
      data-testid={`precision-race-lane-${lane.seat}`}
    >
      {/* Vertical guide for the lane itself. */}
      <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-cyan-500/10" />

      {/* Exhaust trail — grows with the rocket. */}
      <div
        className={`absolute left-1/2 w-1 -translate-x-1/2 rounded-full bg-gradient-to-t ${palette.trail} transition-none`}
        style={{ height: `${pct}%` }}
      />

      {/* Stop marker — makes a parked rocket obviously "stopped". */}
      {stopped && (
        <div
          className={`absolute inset-x-3 border-t border-dashed ${palette.marker} opacity-80`}
          style={{ bottom: `${pct}%` }}
        />
      )}

      {/* Rocket. The OUTER div owns the position (`translate(-50%, 50%)`
          centres it on the line); the INNER motion element owns the liftoff
          transform, so the two can never fight over `transform`. */}
      <div
        className="absolute z-10"
        style={{ left: "50%", bottom: `${pct}%`, transform: "translate(-50%, 50%)" }}
      >
        {launchKey && !shouldReduceMotion ? (
          <motion.div
            key={launchKey}
            initial={{ opacity: 0, y: 18, scale: 0.82 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ type: "spring", stiffness: 300, damping: 20, mass: 0.6 }}
          >
            <IconRocket
              size={30}
              stroke={1.75}
              style={{ color: palette.rocket, filter: `drop-shadow(0 0 8px ${palette.rocket})` }}
              className={stopped ? "opacity-80" : "drop-shadow-[0_0_10px_rgba(103,232,249,0.35)]"}
            />
          </motion.div>
        ) : (
          <IconRocket
            size={30}
            stroke={1.75}
            style={{ color: palette.rocket, filter: `drop-shadow(0 0 8px ${palette.rocket})` }}
            className={stopped ? "opacity-80" : "drop-shadow-[0_0_10px_rgba(103,232,249,0.35)]"}
          />
        )}
      </div>

      {/* Parked elapsed readout, pinned just below the rocket. */}
      {stopped && (
        <div
          className={`absolute z-20 -translate-x-1/2 whitespace-nowrap rounded-full border px-1.5 py-0.5 font-mono text-[9px] font-black tabular-nums sm:px-2 sm:text-[10px] ${palette.ring} ${palette.text}`}
          style={{ left: "50%", bottom: `calc(${pct}% - 26px)` }}
          data-testid={`precision-race-stop-${lane.seat}`}
        >
          {seconds}s
        </div>
      )}

      {/* Screen-reader-only running state. */}
      <span className="sr-only">
        {lane.name}: {stopped ? t("games.precision.race_status_stopped") : t("games.precision.race_status_flying")} {seconds}s
      </span>
    </div>
  );
}

export default function PrecisionRocketRace({
  phase,
  targetMs,
  liveElapsedMs,
  lanes,
  countdownMs = null,
  compact = false,
  roundKey,
  action,
}: PrecisionRocketRaceProps) {
  const { t } = useTranslation();
  const maxMs = useMemo(() => computeAxisMaxMs(targetMs), [targetMs]);
  const ticks = useMemo(() => computeTicks(maxMs), [maxMs]);
  const isArming = phase === "arming";
  const targetPct =
    typeof targetMs === "number" && targetMs > 0 ? axisPercent(targetMs, maxMs) : null;

  // The centre read-out mirrors crash's multiplier slot: the live elapsed time
  // while flying, the pre-round countdown while arming.
  const selfLane = lanes.find((l) => l.isSelf);
  const centreMs =
    selfLane && selfLane.frozenElapsedMs != null ? selfLane.frozenElapsedMs : liveElapsedMs;
  const countdownSecs =
    countdownMs === null ? null : Math.max(0, Math.ceil(countdownMs / 1000));

  // Heights adapt to the viewport on phones (`min(…vh, …px)`) so a short
  // screen cannot push the STOP controls off the fold, while desktop gets a
  // taller board. `vh` is the safe baseline (no `dvh` dependency).
  const boardHeightClass = compact
    ? "h-[150px] sm:h-[200px]"
    : "h-[min(58vh,360px)] sm:h-[430px]";
  const plotInsetClass = compact
    ? "inset-x-0 bottom-2 top-8"
    : "inset-x-0 bottom-3 top-10 sm:top-11";
  // Compact (embedded) layout: shorter board with NO centre column, so the two
  // lanes get the full width — the host (round-result panel / result popup)
  // already prints the target and the per-seat times around it.
  // Shared with the label row's spacer so both lane labels stay centred over
  // their own lane at every breakpoint.
  const centreWidthClass = compact ? "w-0" : "w-24 sm:w-32";
  const centreLabel = isArming
    ? t("games.precision.race_starting_label")
    : t("games.precision.race_elapsed_label");
  const centreValue = isArming
    ? countdownSecs === null
      ? "…"
      : String(countdownSecs)
    : `${(centreMs / 1000).toFixed(2)}s`;
  const centreGradient = isArming
    ? "linear-gradient(to right, #facc15, #fde68a)"
    : "linear-gradient(to right, #22d3ee, #4ade80, #fde047)";
  // Live-match liftoff: keyed on the round envelope AND the phase, so the
  // rockets visibly rise off the pad each time a round opens (and the recap
  // pops back in when one arms) — while a settled lane never re-animates on
  // the per-frame clock updates. Static hosts pass no `roundKey` and get the
  // plain rocket.
  const launchKey = roundKey === undefined ? null : `launch-${roundKey}-${phase}`;

  return (
    <div
      className={`relative w-full overflow-hidden rounded-2xl border border-cyan-500/30 bg-[#020617] ${boardHeightClass}`}
      data-testid="precision-rocket-race"
    >
      <div className="flex h-full">
        {/* ── Plot column (labels + grid + lanes) ── */}
        <div className="relative min-w-0 flex-1">
          {/* Player name / status row — mirrors the lane flex so each label
              sits above its own lane. */}
          <div className="absolute inset-x-0 top-1 z-20 flex items-center px-2 sm:px-3">
            {lanes.map((lane, index) => (
              <React.Fragment key={lane.seat}>
                {index === 1 && <div className={`${centreWidthClass} shrink-0`} />}
                <div className="min-w-0 flex-1 text-center">
                  {/* Name + YOU chip share a centred flex row: on a narrow lane
                      the NAME ellipsises (`min-w-0` + `truncate`) and the YOU
                      chip is `shrink-0`, so "whose lane is this" is never the
                      thing that gets cut off. */}
                  <p
                    className={`flex min-w-0 items-center justify-center gap-1 text-[10px] font-black uppercase tracking-wider sm:text-[11px] sm:tracking-widest ${LANE_PALETTE[lane.seat].text}`}
                  >
                    <span
                      className="truncate"
                      data-testid={`precision-race-name-${lane.seat}`}
                    >
                      {lane.name}
                    </span>
                    {lane.isSelf && (
                      <span
                        data-testid={`precision-race-you-${lane.seat}`}
                        className="shrink-0 rounded bg-white/15 px-1 py-px text-[9px] tracking-wide text-white"
                      >
                        {t("games.precision.you_tag")}
                      </span>
                    )}
                  </p>
                  <p className="mt-0.5 flex items-center justify-center gap-1 text-[8px] font-bold uppercase tracking-wide text-slate-400 sm:text-[9px] sm:tracking-wider">
                    <span
                      className={`inline-block h-1.5 w-1.5 rounded-full ${
                        !isArming && lane.frozenElapsedMs == null
                          ? `${LANE_PALETTE[lane.seat].dot} animate-pulse`
                          : "bg-slate-600"
                      }`}
                    />
                    {lane.frozenElapsedMs != null
                      ? t("games.precision.race_status_stopped")
                      : isArming
                        ? ""
                        : t("games.precision.race_status_flying")}
                  </p>
                </div>
              </React.Fragment>
            ))}
          </div>

          {/* Plot area — everything below shares ONE vertical scale. */}
          <div className={`absolute ${plotInsetClass}`}>
            {/* Grid lines at each axis tick. */}
            {ticks.map((tick) => (
              <div
                key={`grid-${tick}`}
                className="absolute inset-x-0 border-t border-cyan-500/10"
                style={{ bottom: `${axisPercent(tick, maxMs)}%` }}
              />
            ))}

            {/* Threshold line — the target the player must stop on. */}
            {targetPct !== null && (
              <div
                className="absolute inset-x-0 z-[5]"
                style={{ bottom: `${targetPct}%` }}
                data-testid="precision-race-threshold"
              >
                <div className="border-t-2 border-dashed border-yellow-300/80" />
                <span className="absolute -top-2.5 left-1.5 rounded bg-yellow-300 px-1.5 py-0.5 text-[9px] font-black uppercase tracking-wide text-black">
                  {t("games.precision.target_label")} {((targetMs as number) / 1000).toFixed(2)}s
                </span>
              </div>
            )}

            {/* Lanes + centre read-out. */}
            <div className="relative flex h-full px-2 sm:px-3">
              <LaneView
                lane={lanes[0]}
                elapsedMs={lanes[0].frozenElapsedMs ?? (isArming ? 0 : liveElapsedMs)}
                maxMs={maxMs}
                isArming={isArming}
                launchKey={launchKey}
              />

              {/* Centre — big timer (or countdown), crash-multiplier style.
                  Omitted in the compact recap so the lanes widen. */}
              {!compact && (
              <div
                className={`relative flex shrink-0 flex-col items-center justify-center ${centreWidthClass}`}
              >
                <p className="text-[9px] font-bold uppercase tracking-[0.25em] text-cyan-300/70">
                  {centreLabel}
                </p>
                <p
                  className="mt-0.5 font-mono text-2xl font-black leading-none tabular-nums text-transparent sm:text-4xl"
                  style={{
                    backgroundImage: centreGradient,
                    WebkitBackgroundClip: "text",
                    backgroundClip: "text",
                    filter: "drop-shadow(0 0 14px rgba(34,211,238,0.55))",
                  }}
                  data-testid="precision-race-center"
                >
                  {centreValue}
                </p>
                {!isArming && (
                  <p className="mt-1 font-mono text-[10px] tabular-nums text-cyan-200/60">
                    {Math.round(centreMs).toLocaleString()}
                    {t("games.precision.ms_suffix")}
                  </p>
                )}
                {/* Primary round control (STOP) — under the clock it is timed
                    against, on the board itself. Kept to the column width by
                    `w-full` so it can never reach into a lane. */}
                {!isArming && action && (
                  <div
                    className="mt-2 w-full px-0.5"
                    data-testid="precision-race-action"
                  >
                    {action}
                  </div>
                )}
              </div>
              )}

              <LaneView
                lane={lanes[1]}
                elapsedMs={lanes[1].frozenElapsedMs ?? (isArming ? 0 : liveElapsedMs)}
                maxMs={maxMs}
                isArming={isArming}
                launchKey={launchKey}
              />
            </div>
          </div>
        </div>

        {/* ── Time axis (seconds), crash-style, on the right ── */}
        <div className="relative w-9 shrink-0 border-l border-cyan-500/20 bg-black/20 sm:w-11">
          <div className={`absolute ${plotInsetClass}`}>
            {ticks.map((tick) => (
              <span
                key={`tick-${tick}`}
                className="absolute right-1 -translate-y-1/2 font-mono text-[10px] tabular-nums text-cyan-200/70"
                style={{ bottom: `${axisPercent(tick, maxMs)}%` }}
              >
                {formatSecondsLabel(tick)}
              </span>
            ))}
          </div>
          <span className="absolute bottom-1 right-1 text-[8px] font-bold uppercase tracking-wider text-cyan-300/50">
            {t("games.precision.race_axis_caption")}
          </span>
        </div>
      </div>
    </div>
  );
}
