"use client";

// ── Precision: the live round ────────────────────────────────────────────
//
// The whole of a round in flight: scoreboard, the two-lane vertical rocket
// race with the STOP control mounted INSIDE its centre slot (directly under the
// elapsed clock the player is timing against), and a slim strip underneath for
// the round's read-only context — the target, the live rank preview, the last
// round's snapshot — plus the secondary controls (resign, emote picker).
//
// Purely presentational with respect to GAMEPLAY: it never measures time and
// never decides anything. `timerMs` is the parent's display clock, `boardStops`
// is server-stamped telemetry, and the STOP button only reports the click — the
// server stamps the stop instant and grades the round.

import { motion } from "framer-motion";
import { IconTarget } from "@tabler/icons-react";

import EmotePicker from "../game/EmotePicker";
import { useTranslation } from "../../hooks/useTranslation";
import { fadeUp } from "../../lib/animations";
import type { RoundStopsSummary } from "../../lib/precision/matchView";
import type {
  PlayerSeat,
  PrecisionPlayer,
  PrecisionScore,
  PrecisionState,
} from "../../lib/precision/types";
import type { PrecisionRank } from "../../lib/precision/utils";
import { PrecisionRankIcon } from "./PrecisionRankIcon";
import PrecisionRocketRace, { type RocketLane } from "./PrecisionRocketRace";
import PrecisionScoreboard from "./PrecisionScoreboard";

/** Opaque emote payloads, as produced by `useGameEmotes` / `EmotePicker`. */
export type PrecisionEmote = { id?: string; key?: string; kind?: string } | null;

export interface PrecisionActiveRoundPanelProps {
  state: PrecisionState;
  players: PrecisionPlayer[];
  score: PrecisionScore;
  currentRound: number;
  lastRoundWinnerSeat: PlayerSeat | null;
  localSeat: PlayerSeat;
  /** Server-stamped telemetry of the previous decided round, if any. */
  boardStops: RoundStopsSummary | null;
  /** Self has stopped; the round is waiting on the opponent. */
  awaitingOpponentStop: boolean;
  /** Live display clock (ms). */
  timerMs: number;
  /** The round's target, or null when the payload omitted it. */
  liveTargetMs: number | null;
  /** Rank preview derived from the live clock, or null when unavailable. */
  previewRank: PrecisionRank | null;
  raceLanes: (recap: boolean) => [RocketLane, RocketLane];
  selfStopPending: boolean;
  stopSubmitting: boolean;
  onStopClick: () => void;
  onResign: () => void;
  incomingEmote: PrecisionEmote;
  myEmote: PrecisionEmote;
  sendEmote: (emote: PrecisionEmote) => void;
}

export default function PrecisionActiveRoundPanel({
  state,
  players,
  score,
  currentRound,
  lastRoundWinnerSeat,
  localSeat,
  boardStops,
  awaitingOpponentStop,
  timerMs,
  liveTargetMs,
  previewRank,
  raceLanes,
  selfStopPending,
  stopSubmitting,
  onStopClick,
  onResign,
  incomingEmote,
  myEmote,
  sendEmote,
}: PrecisionActiveRoundPanelProps) {
  const { t } = useTranslation();
  return (
    <motion.div key="phase-active" {...fadeUp}>
      <div className="mt-6 space-y-5">
        <PrecisionScoreboard
          score={score}
          players={players}
          currentRound={currentRound}
          lastRoundWinnerSeat={lastRoundWinnerSeat}
          viewerSeat={localSeat}
          awaitingOpponentStop={awaitingOpponentStop}
          lastRoundStops={boardStops}
        />

        {/* Two-lane vertical rocket race — you | opponent. Your rocket
            and the centre timer freeze the instant you hit STOP; the
            bot's rocket freezes the moment its published stop lands. The
            STOP control is mounted INSIDE the board, under that clock. */}
        <PrecisionRocketRace
          phase="active"
          roundKey={state.roundSequence}
          targetMs={state.targetMs}
          liveElapsedMs={timerMs}
          lanes={raceLanes(false)}
          action={
            <button
              type="button"
              onClick={onStopClick}
              disabled={selfStopPending || stopSubmitting || awaitingOpponentStop}
              data-testid="precision-stop-button"
              aria-label={
                selfStopPending
                  ? t("games.precision.stop_sent")
                  : stopSubmitting
                    ? t("games.precision.submitting")
                    : t("games.precision.stop_button")
              }
              className={
                // Sized to the centre column (`w-full`): the slot must never
                // widen into a lane. Labels wrap rather than overflow.
                selfStopPending
                  ? "w-full cursor-default rounded-lg border-2 border-emerald-300/50 bg-emerald-400/20 px-1 py-3 text-[11px] font-black leading-tight tracking-widest text-emerald-100"
                  : stopSubmitting
                    ? "w-full cursor-wait rounded-lg border-2 border-yellow-300/50 bg-yellow-400/20 px-1 py-3 text-[11px] font-black leading-tight tracking-widest text-yellow-100"
                    : "w-full rounded-lg border-2 border-red-400/70 bg-gradient-to-b from-red-500 to-red-600 px-1 py-3 text-[11px] font-black leading-tight tracking-widest text-white shadow-[0_0_18px_rgba(239,68,68,0.6)] transition active:scale-95 hover:from-red-400 hover:to-red-500 animate-pulse"
              }
            >
              {selfStopPending
                ? t("games.precision.stop_sent")
                : stopSubmitting
                  ? t("games.precision.submitting")
                  : t("games.precision.stop_button")}
            </button>
          }
        />

        {/* Slim round strip — read-only context + the secondary controls.
            Everything the player ACTS on lives on the board above. */}
        <div className="rounded-2xl border border-fuchsia-400/40 bg-[#0a0420]/80 px-4 py-3">
          <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5">
            <h2 className="inline-flex items-center gap-1.5 text-sm font-black text-fuchsia-300">
              <IconTarget size={16} aria-hidden="true" />
              {t("games.precision.round_label", { round: currentRound })}
            </h2>
            <span className="text-[10px] uppercase tracking-[0.3em] text-cyan-300/80">
              {t("games.precision.target")}
            </span>
            <span
              data-testid="precision-round-target"
              className="text-2xl font-black leading-none text-yellow-300"
            >
              {liveTargetMs !== null
                ? `${liveTargetMs.toLocaleString()} ${t("games.precision.ms_suffix")}`
                : "-"}
            </span>
            {previewRank && (
              <span className={`inline-flex items-center gap-1 text-sm font-bold ${previewRank.color}`}>
                <PrecisionRankIcon label={previewRank.label} size={14} />
                {previewRank.label}
                <span className="text-xs font-normal text-cyan-100/70">
                  (
                  {t("games.precision.ms_off_format", {
                    ms: Math.abs(Math.round(timerMs - (liveTargetMs ?? 0))).toLocaleString(),
                  })}
                  )
                </span>
              </span>
            )}
          </div>

          {boardStops && (
            <p
              data-testid="precision-last-round-stops"
              className="mt-2 text-center font-mono text-[11px] text-cyan-100/90"
            >
              <span className="text-[10px] uppercase tracking-[0.3em] text-cyan-200/70">
                {t("games.precision.previous_round_snapshot")}{" "}
              </span>
              {t("games.precision.you_label_short")}{" "}
              <span className="font-bold text-yellow-300">
                {(localSeat === 1 ? boardStops.seat1 : boardStops.seat2).elapsedMs}{" "}
                {t("games.precision.ms_suffix")}
              </span>{" "}
              · {t("games.precision.opponent_label_short")}{" "}
              <span className="font-bold text-fuchsia-300">
                {(localSeat === 1 ? boardStops.seat2 : boardStops.seat1).elapsedMs}{" "}
                {t("games.precision.ms_suffix")}
              </span>
            </p>
          )}

          <div className="mt-3 flex flex-wrap items-center justify-center gap-3">
            <button
              type="button"
              onClick={onResign}
              className="rounded-lg bg-red-600/90 px-4 py-1.5 text-xs font-bold text-white transition hover:bg-red-500"
            >
              {t("games.precision.resign")}
            </button>
            <EmotePicker
              compact
              incomingEmote={incomingEmote}
              myEmote={myEmote}
              onSend={(emote) => sendEmote(emote)}
            />
          </div>
        </div>
      </div>
    </motion.div>
  );
}
