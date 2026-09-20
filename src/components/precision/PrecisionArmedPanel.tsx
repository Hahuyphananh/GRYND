"use client";

// ── Precision: the arming phase ──────────────────────────────────────────
//
// The pre-round window the server opens between rounds (and before the first
// one). The input form is hidden; the player sees the scoreboard, the SAME
// race board as the live round — reused as a frozen recap, both rockets parked
// at the previous round's server-stamped stops — and the countdown ticking in
// the centre slot. That is what makes "where did the AI stop?" visible before
// the next round opens, and why the recap reads `lastRoundStops` rather than
// the live clock.

import { motion } from "framer-motion";
import { IconClock } from "@tabler/icons-react";

import { useTranslation } from "../../hooks/useTranslation";
import { fadeUp } from "../../lib/animations";
import type {
  PlayerSeat,
  PrecisionPlayer,
  PrecisionScore,
  PrecisionState,
} from "../../lib/precision/types";
import PrecisionRocketRace, { type RocketLane } from "./PrecisionRocketRace";
import PrecisionScoreboard from "./PrecisionScoreboard";

export interface PrecisionArmedPanelProps {
  state: PrecisionState;
  players: PrecisionPlayer[];
  score: PrecisionScore;
  currentRound: number;
  lastRoundWinnerSeat: PlayerSeat | null;
  localSeat: PlayerSeat;
  /** Countdown remaining (ms) from the server-stamped `countdownEndsAt`. */
  countdownMs: number | null;
  raceLanes: (recap: boolean) => [RocketLane, RocketLane];
  onResign: () => void;
}

export default function PrecisionArmedPanel({
  state,
  players,
  score,
  currentRound,
  lastRoundWinnerSeat,
  localSeat,
  countdownMs,
  raceLanes,
  onResign,
}: PrecisionArmedPanelProps) {
  const { t } = useTranslation();
  return (
    <motion.div key="phase-arming" {...fadeUp}>
      <div className="mt-6 space-y-5">
        <PrecisionScoreboard
          score={score}
          players={players}
          currentRound={currentRound}
          lastRoundWinnerSeat={lastRoundWinnerSeat}
          viewerSeat={localSeat}
        />
        <div className="rounded-2xl border border-yellow-400/40 bg-[#1a120a]/80 p-4 text-center sm:p-6">
          <p className="inline-flex items-center justify-center gap-2 text-sm font-black uppercase tracking-widest text-yellow-300">
            <IconClock size={18} className="animate-pulse text-yellow-400" />
            {t("games.precision.round_get_ready", { round: currentRound })}
          </p>
          <div className="mt-3">
            {/* Same board as the live round: both rockets are parked at the
                previous round's server-stamped stops, so the player can see
                exactly where the AI (or opponent) stopped before the next
                round's countdown finishes. The centre slot hosts the
                countdown. */}
            <PrecisionRocketRace
              phase="arming"
              roundKey={state.roundSequence}
              targetMs={state.lastRoundTargetMs ?? null}
              liveElapsedMs={0}
              countdownMs={countdownMs}
              lanes={raceLanes(true)}
            />
          </div>
          <p className="mx-auto mt-3 max-w-md text-sm text-cyan-100/90 sm:text-base">
            {t("games.precision.arming_hint")}
          </p>
          <button
            onClick={onResign}
            className="mt-4 rounded bg-red-600 px-6 py-2 font-bold text-white hover:bg-red-500"
          >
            {t("games.precision.resign")}
          </button>
        </div>
      </div>
    </motion.div>
  );
}
