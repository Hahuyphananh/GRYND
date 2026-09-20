"use client";

// ── Precision: the live round ────────────────────────────────────────────
//
// The whole of a round in flight: scoreboard, the two-lane vertical rocket
// race, the target to stop on, the live rank preview, the last-round snapshot
// strip, the STOP button and the emote picker.
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
            bot's rocket freezes the moment its published stop lands. */}
        <PrecisionRocketRace
          phase="active"
          roundKey={state.roundSequence}
          targetMs={state.targetMs}
          liveElapsedMs={timerMs}
          lanes={raceLanes(false)}
        />

        <div className="rounded-2xl border border-fuchsia-400/40 bg-[#0a0420]/80 p-5 text-center sm:p-8">
          <h2 className="text-xl font-black text-fuchsia-300">
            <IconTarget size={20} className="mr-1.5 inline align-text-bottom" />
            {t("games.precision.round_label", { round: currentRound })}
          </h2>

          <p className="mt-3 text-xs uppercase tracking-[0.35em] text-cyan-300/80">
            {t("games.precision.target")}
          </p>
          <p
            data-testid="precision-round-target"
            className="mt-1 text-4xl font-black text-yellow-300 sm:text-5xl"
          >
            {liveTargetMs !== null
              ? `${liveTargetMs.toLocaleString()} ${t("games.precision.ms_suffix")}`
              : "-"}
          </p>

          {previewRank && (
            <p className={`mt-3 text-lg font-bold ${previewRank.color}`}>
              <PrecisionRankIcon label={previewRank.label} size={16} className="mr-1 inline" />{" "}
              {previewRank.label}{" "}
              <span className="text-sm font-normal text-cyan-100/70">
                (
                {t("games.precision.ms_off_format", {
                  ms: Math.abs(Math.round(timerMs - (liveTargetMs ?? 0))).toLocaleString(),
                })}
                )
              </span>
            </p>
          )}
          {boardStops && (
            <div
              data-testid="precision-last-round-stops"
              className="mt-5 rounded-2xl border border-cyan-400/40 bg-black/30 px-4 py-2 text-xs text-cyan-100"
            >
              <p className="text-[10px] uppercase tracking-[0.35em] text-cyan-200/80">
                {t("games.precision.previous_round_snapshot")}
              </p>
              <p className="mt-1 font-mono">
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
              <p className="mt-1 text-[10px] text-cyan-100/70">
                {t("games.precision.snapshot_hint")}
              </p>
            </div>
          )}
          <p className="mt-4 text-sm text-cyan-100/90 sm:text-base">
            {t("games.precision.stop_hint")}
          </p>
          <div className="mx-auto mt-5 flex max-w-md flex-col gap-3">
            <button
              type="button"
              onClick={onStopClick}
              disabled={selfStopPending || stopSubmitting || awaitingOpponentStop}
              data-testid="precision-stop-button"
              className={
                selfStopPending
                  ? "w-full cursor-default rounded-2xl border-2 border-emerald-300/40 bg-emerald-400/20 px-6 py-6 text-3xl font-black tracking-widest text-emerald-100"
                  : stopSubmitting
                    ? "w-full cursor-wait rounded-2xl border-2 border-yellow-300/40 bg-yellow-400/20 px-6 py-6 text-3xl font-black tracking-widest text-yellow-100"
                    : "w-full rounded-2xl border-2 border-red-400/60 bg-gradient-to-b from-red-500 to-red-600 px-6 py-6 text-3xl font-black tracking-widest text-white shadow-[0_0_30px_rgba(239,68,68,0.65)] transition active:scale-95 hover:from-red-400 hover:to-red-500 animate-pulse"
              }
            >
              {selfStopPending
                ? t("games.precision.stop_sent")
                : stopSubmitting
                  ? t("games.precision.submitting")
                  : t("games.precision.stop_button")}
            </button>
          </div>
          <button
            onClick={onResign}
            className="mt-6 rounded bg-red-600 px-6 py-2 font-bold text-white hover:bg-red-500"
          >
            {t("games.precision.resign")}
          </button>

          <div className="mt-6 flex justify-center">
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
