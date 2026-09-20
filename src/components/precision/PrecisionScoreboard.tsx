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
import RoundMarkers from "../casino/RoundMarkers";
import FrameAvatar from "../FrameAvatar";
import { TARGET_WINS, MAX_ROUNDS } from "../../lib/precision/constants";
import { diffToRank } from "../../lib/precision/utils";
import { PrecisionRankIcon } from "./PrecisionRankIcon";
import type { PlayerSeat, PrecisionPlayer, PrecisionScore } from "../../lib/precision/types";
import { useTranslation } from "../../hooks/useTranslation";

/** Per-seat stop telemetry for the most recently decided round.
 *  Subset of `PrecisionState.lastRoundStops` — we only need the
 *  server-stamped diff to compute the rank badge. */
export interface LastRoundStopSnapshot {
  seat1: { elapsedMs: number; diffMs: number };
  seat2: { elapsedMs: number; diffMs: number };
}

interface PrecisionScoreboardProps {
  score: PrecisionScore;
  players: PrecisionPlayer[];
  currentRound: number;
  lastRoundWinnerSeat: PlayerSeat | null;
  /** The viewer's own seat (1 or 2) — used to render the blue/red
   *  round markers from the viewer's perspective (blue = rounds I
   *  won, red = rounds the opponent won). Defaults to seat 1. */
  viewerSeat?: PlayerSeat;
  /** When true, the opponent's stop is still pending — hint at it visually. */
  awaitingOpponentStop?: boolean;
  /** Per-seat stop telemetry from the most recently decided round.
   *  When provided, rank badges appear below each seat card. */
  lastRoundStops?: LastRoundStopSnapshot | null;
}

const RING_LAST_WINNER = "ring-2 ring-emerald-300/60";

// ── Rank badge (inline sub-component) ──────────────────────────────
// Renders the rank emoji + label + elapsed + diff for a single seat.
// Used below each seat card when last-round stop data is available.
function RankBadge({
  elapsedMs,
  diffMs,
  seat,
}: {
  elapsedMs: number;
  diffMs: number;
  seat: 1 | 2;
}) {
  const rank = diffToRank(diffMs);
  return (
    <div
      className={`mt-2 flex items-center gap-1.5 rounded-lg border ${rank.bg} ${rank.border} px-2 py-1`}
      data-testid={`precision-scoreboard-rank-${seat}`}
    >
      <span className="text-sm">
        <PrecisionRankIcon label={rank.label} />
      </span>
      <span className={`text-[10px] font-black uppercase ${rank.color}`}>
        {rank.label}
      </span>
      <span className="ml-auto font-mono text-[10px] text-slate-400 tabular-nums">
        {elapsedMs.toLocaleString()}ms Δ{Math.round(diffMs)}
      </span>
    </div>
  );
}

function PrecisionScoreboardImpl({
  score,
  players,
  currentRound,
  lastRoundWinnerSeat,
  viewerSeat = 1,
  awaitingOpponentStop = false,
  lastRoundStops,
}: PrecisionScoreboardProps) {
  const { t } = useTranslation();
  const seat1Player = players.find((p) => p.seat === 1);
  const seat2Player = players.find((p) => p.seat === 2);

  // Unified round markers from the viewer's perspective: blue = rounds
  // the viewer won, red = rounds the opponent won (brawl-stars style,
  // shared with RPS / blackjack / memory grid).
  const myWins = viewerSeat === 2 ? score.seat2 : score.seat1;
  const oppWins = viewerSeat === 2 ? score.seat1 : score.seat2;
  const myName = (viewerSeat === 2 ? seat2Player : seat1Player)?.name;
  const oppName = (viewerSeat === 2 ? seat1Player : seat2Player)?.name;

  // Highlight the most recent round winner so both sides see who took it.
  const seat1Ring = lastRoundWinnerSeat === 1 ? RING_LAST_WINNER : "";
  const seat2Ring = lastRoundWinnerSeat === 2 ? RING_LAST_WINNER : "";

  let bannerText: string;
  if (awaitingOpponentStop) {
    bannerText = t("games.precision.waiting_opponent_stop");
  } else if (lastRoundWinnerSeat === 1) {
    bannerText = t("games.precision.round_won_by", {
      round: currentRound - 1,
      name: seat1Player?.name ?? t("games.precision.seat_alpha"),
    });
  } else if (lastRoundWinnerSeat === 2) {
    bannerText = t("games.precision.round_won_by", {
      round: currentRound - 1,
      name: seat2Player?.name ?? t("games.precision.seat_bravo"),
    });
  } else {
    bannerText = t("games.precision.first_to_target", { target: TARGET_WINS });
  }

  return (
    <div className="w-full rounded-2xl border border-cyan-400/30 bg-black/30 p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-bold uppercase tracking-[0.35em] text-cyan-200/90">
          {t("games.precision.best_of", { n: MAX_ROUNDS })}
        </p>
        <p className="text-xs font-bold uppercase tracking-[0.35em] text-yellow-200">
          {t("games.precision.round_n", { round: currentRound })}
        </p>
      </div>

      {/* Round tracker — blue = rounds you won, red = rounds the
          opponent won (shared best-of marker, brawl-stars style). */}
      <div className="mt-3 flex justify-center rounded-xl border border-cyan-400/20 bg-black/20 px-3 py-2">
        <RoundMarkers
          total={MAX_ROUNDS}
          myWins={myWins}
          oppWins={oppWins}
          myLabel={myName ?? t("games.precision.seat_alpha")}
          oppLabel={oppName ?? t("games.precision.seat_bravo")}
        />
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
        >          <p className="flex items-center gap-1.5 text-xs text-slate-300">
            <FrameAvatar frame={(seat1Player as any)?.profileFrame} iconKey={seat1Player?.iconKey} name={seat1Player?.name} size="h-4 w-4" />
            <span
              className="truncate"
              style={seat1Player?.nameColor ? { color: seat1Player.nameColor } : undefined}
            >
              {seat1Player?.name ?? t("games.precision.seat_alpha")}
            </span>
            {seat1Player?.prestigeBadge && (
              <span className="ml-1 inline-block rounded-full border border-violet-400/70 bg-violet-500/15 px-1.5 py-px align-middle text-[8px] font-semibold uppercase tracking-wide text-violet-300">
                {seat1Player.prestigeBadge}
              </span>
            )}
          </p>
          {lastRoundStops && (
            <RankBadge
              seat={1}
              elapsedMs={lastRoundStops.seat1.elapsedMs}
              diffMs={lastRoundStops.seat1.diffMs}
            />
          )}
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
        >          <p className="flex items-center gap-1.5 text-xs text-slate-300">
            <FrameAvatar frame={(seat2Player as any)?.profileFrame} iconKey={seat2Player?.iconKey} name={seat2Player?.name} size="h-4 w-4" />
            <span
              className="truncate"
              style={seat2Player?.nameColor ? { color: seat2Player.nameColor } : undefined}
            >
              {seat2Player?.name ?? t("games.precision.seat_bravo")}
            </span>
            {seat2Player?.prestigeBadge && (
              <span className="ml-1 inline-block rounded-full border border-violet-400/70 bg-violet-500/15 px-1.5 py-px align-middle text-[8px] font-semibold uppercase tracking-wide text-violet-300">
                {seat2Player.prestigeBadge}
              </span>
            )}
          </p>

          {lastRoundStops && (
            <RankBadge
              seat={2}
              elapsedMs={lastRoundStops.seat2.elapsedMs}
              diffMs={lastRoundStops.seat2.diffMs}
            />
          )}
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
