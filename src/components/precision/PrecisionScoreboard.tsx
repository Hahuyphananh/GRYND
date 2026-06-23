"use client";

// ── Best-of-5 scoreboard (read-only) ──────────────────────────────────────
//
// Pure presentational component. The client NEVER mutates the score; it
// only renders what the server returned in `PrecisionState.score`. The
// visual language: three dots per seat, filled = round won, empty = not
// yet won. Mirrors the precision-score vibe of the rest of the page.
//
// The component also surfaces the "last round winner" so each side sees
// who just took the round, and the current round number so the user
// knows where they are in the match.

import React from "react";
import { motion } from "framer-motion";
import { TARGET_WINS, MAX_ROUNDS } from "../../lib/precision/constants";
import { scorePop } from "../../lib/animations";
import type { PlayerSeat, PrecisionPlayer, PrecisionScore } from "../../lib/precision/types";

interface PrecisionScoreboardProps {
  score: PrecisionScore;
  players: PrecisionPlayer[];
  currentRound: number;
  lastRoundWinnerSeat: PlayerSeat | null;
  /** When true, the opponent's stop is still pending — hint at it visually. */
  awaitingOpponentStop?: boolean;
}

const RING_LAST_WINNER = "ring-2 ring-emerald-300/60";

interface SeatDotsProps {
  seat: PlayerSeat;
  wins: number;
  filledColor: string;
  emptyColor: string;
}

function SeatDots({ seat, wins, filledColor, emptyColor }: SeatDotsProps) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] font-bold uppercase tracking-widest text-slate-300">
        Seat {seat}
      </span>
      {Array.from({ length: TARGET_WINS }).map((_, i) => {
        // Key includes `wins` so when a new win lands (e.g., wins: 1→2),
        // the freshly-filled dot MOUNTS and runs `scorePop` (spring
        // scale 0 → 1). Already-filled dots (i < prev-wins) keep their
        // original mount and skip the animation — only the NEWLY lit
        // dot pops. Animations re-key per-wins, NOT per-poll, so this
        // does not regress the rAF/React.memo optimizations.
        const filled = i < wins;
        return (
          <motion.span
            key={`${seat}-${i}-${wins}-${filled ? "filled" : "empty"}`}
            aria-label={
              filled
                ? `Seat ${seat} round win ${i + 1}`
                : `Seat ${seat} round ${i + 1} pending`
            }
            className={`inline-block h-3 w-3 rounded-full border transition-shadow ${
              filled ? filledColor : emptyColor
            }`}
            {...(filled && i === wins - 1 ? scorePop : {})}
          />
        );
      })}
    </div>
  );
}

function PrecisionScoreboardImpl({
  score,
  players,
  currentRound,
  lastRoundWinnerSeat,
  awaitingOpponentStop = false,
}: PrecisionScoreboardProps) {
  const seat1Player = players.find((p) => p.seat === 1);
  const seat2Player = players.find((p) => p.seat === 2);

  // Highlight the most recent round winner so both sides see who took it.
  const seat1Ring = lastRoundWinnerSeat === 1 ? RING_LAST_WINNER : "";
  const seat2Ring = lastRoundWinnerSeat === 2 ? RING_LAST_WINNER : "";

  let bannerText: string;
  if (awaitingOpponentStop) {
    bannerText = "Stop recorded. Waiting for opponent to stop…";
  } else if (lastRoundWinnerSeat === 1) {
    bannerText = `Round ${currentRound - 1} won by ${seat1Player?.name ?? "Seat 1"}.`;
  } else if (lastRoundWinnerSeat === 2) {
    bannerText = `Round ${currentRound - 1} won by ${seat2Player?.name ?? "Seat 2"}.`;
  } else {
    bannerText = `First to ${TARGET_WINS} round wins takes the match.`;
  }

  return (
    <div className="w-full rounded-2xl border border-cyan-400/30 bg-black/30 p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-bold uppercase tracking-[0.35em] text-cyan-200/90">
          Best of {MAX_ROUNDS}
        </p>
        <p className="text-xs font-bold uppercase tracking-[0.35em] text-yellow-200">
          Round {currentRound}
        </p>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        {/* Seat cards — outer `motion.div` is keyed on `${seat}-${wins}` so
            a fresh win re-mounts the card and runs `winnerPulse` (a brief
            scale + glow). The glow uses transform: scale + box-shadow
            (compositor-friendly) and lasts ~600ms so it does not replay
            per poll. When neither seat just won (lastRoundWinnerSeat is
            null OR points at the other seat), the key suffix is "idle"
            and the card renders without re-mounting on every poll. */}
        <motion.div
          key={`seat-1-${score.seat1}-${
            lastRoundWinnerSeat === 1 ? "winner" : "idle"
          }`}
          className={`rounded-xl border border-fuchsia-500/30 bg-[#0b0220]/60 p-3 ${seat1Ring}`}
          initial={
            lastRoundWinnerSeat === 1
              ? { scale: 0.96, boxShadow: "0 0 0 rgba(217,70,239,0)" }
              : false
          }
          animate={
            lastRoundWinnerSeat === 1
              ? {
                  scale: 1,
                  boxShadow: [
                    "0 0 0 rgba(217,70,239,0)",
                    "0 0 28px rgba(217,70,239,0.55)",
                    "0 0 0 rgba(217,70,239,0)",
                  ],
                }
              : { scale: 1, boxShadow: "0 0 0 rgba(217,70,239,0)" }
          }
          transition={{ duration: 0.6, ease: "easeOut" }}
        >
          <p className="text-xs text-slate-300">{seat1Player?.name ?? "Seat 1"}</p>
          <div className="mt-2">
            <SeatDots
              seat={1}
              wins={score.seat1}
              filledColor="bg-fuchsia-400 border-fuchsia-200"
              emptyColor="border-fuchsia-700/60 bg-fuchsia-950/30"
            />
          </div>
        </motion.div>
        <motion.div
          key={`seat-2-${score.seat2}-${
            lastRoundWinnerSeat === 2 ? "winner" : "idle"
          }`}
          className={`rounded-xl border border-cyan-400/30 bg-[#021622]/60 p-3 ${seat2Ring}`}
          initial={
            lastRoundWinnerSeat === 2
              ? { scale: 0.96, boxShadow: "0 0 0 rgba(34,211,238,0)" }
              : false
          }
          animate={
            lastRoundWinnerSeat === 2
              ? {
                  scale: 1,
                  boxShadow: [
                    "0 0 0 rgba(34,211,238,0)",
                    "0 0 28px rgba(34,211,238,0.55)",
                    "0 0 0 rgba(34,211,238,0)",
                  ],
                }
              : { scale: 1, boxShadow: "0 0 0 rgba(34,211,238,0)" }
          }
          transition={{ duration: 0.6, ease: "easeOut" }}
        >
          <p className="text-xs text-slate-300">{seat2Player?.name ?? "Seat 2"}</p>
          <div className="mt-2">
            <SeatDots
              seat={2}
              wins={score.seat2}
              filledColor="bg-cyan-300 border-cyan-100"
              emptyColor="border-cyan-700/60 bg-cyan-950/30"
            />
          </div>
        </motion.div>
      </div>

      <p className="mt-3 text-[11px] text-cyan-100/70">{bannerText}</p>
    </div>
  );
}

// OPTIMIZATION — React.memo wrapper so the page's polling tick (every
// 1.5s) doesn't force a scoreboard subtree render (two SeatDots
// iterations, three rendered arcs per seat) when props haven't
// changed. Combined with the page memoising `players` via useMemo and
// the server-stamped `score`/`currentRound`/`lastRoundWinnerSeat`
// arriving as fresh references each poll, memo's benefit comes from
// avoiding renders during unrelated parent re-renders (e.g. socket
// listener re-binds that don't change match state).
export default React.memo(PrecisionScoreboardImpl);
