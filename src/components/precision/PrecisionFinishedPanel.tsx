"use client";

// ── Precision: the finished phase ────────────────────────────────────────
//
// What sits UNDERNEATH the end-of-match popup once the server declares a
// winner: the final scoreboard and a short status line. The popup itself
// (replay / return to lobby) is owned by the page.

import { motion } from "framer-motion";

import { useTranslation } from "../../hooks/useTranslation";
import { fadeUp } from "../../lib/animations";
import type {
  PlayerSeat,
  PrecisionPlayer,
  PrecisionScore,
  PrecisionState,
} from "../../lib/precision/types";
import PrecisionScoreboard from "./PrecisionScoreboard";

export interface PrecisionFinishedPanelProps {
  state: PrecisionState;
  players: PrecisionPlayer[];
  score: PrecisionScore | null | undefined;
  currentRound: number;
  lastRoundWinnerSeat: PlayerSeat | null;
}

export default function PrecisionFinishedPanel({
  state,
  players,
  score,
  currentRound,
  lastRoundWinnerSeat,
}: PrecisionFinishedPanelProps) {
  const { t } = useTranslation();
  return (
    <motion.div key="phase-finished" {...fadeUp}>
      <div className="mt-8 flex flex-col items-center gap-3">
        {score && (
          <PrecisionScoreboard
            score={score}
            players={players}
            currentRound={Math.max(currentRound, 1)}
            lastRoundWinnerSeat={lastRoundWinnerSeat}
          />
        )}
        <p className="rounded border border-cyan-400/40 bg-cyan-400/10 px-4 py-2 text-sm font-bold text-cyan-100">
          {t("games.precision.match_finished_short")}
        </p>
      </div>
    </motion.div>
  );
}
