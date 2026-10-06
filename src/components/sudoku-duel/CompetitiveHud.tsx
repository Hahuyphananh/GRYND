"use client";

// src/components/sudoku-duel/CompetitiveHud.tsx
//
// The compact competitive HUD that sits above the board.
//
// This is the ONLY place the opponent appears. There is no opponent board, no
// opponent grid and no opponent answers — just the closed progress shape the
// server already publishes (a percentage and a correct-cell count) plus a name
// and an avatar. Every number here is read off the snapshot; none of it is
// computed on the client.
//
//   YOU       [████████░░]  72%   ·  12/55 cells · 2 mistakes
//   OPPONENT  [███████░░░]  64%   ·  11/55 cells
//   ⏱ 07:42
//
// The colours are the house duotone: amber for the viewer, cyan for the
// opponent — the same mapping Solitaire Duel uses.

import type { ReactNode } from "react";
import { IconClock, IconStopwatch } from "@tabler/icons-react";

import SeatAvatar from "../game/SeatAvatar";
import { clockLabel, mistakeLabel } from "../../lib/sudoku-duel/ui";

export type SeatIdentity = {
  name?: string | null;
  iconKey?: string | null;
  profilePicture?: string | null;
  profileFrame?: unknown;
  /** True for a signed-out free-play visitor (renders the "G" guest badge). */
  isGuest?: boolean;
} | null;

function Meter({
  label,
  percent,
  detail,
  tone,
  completed,
  identity,
  isAi = false,
  accent,
  testId,
}: {
  label: string;
  percent: number;
  detail: string;
  tone: "mine" | "theirs";
  completed?: boolean;
  identity?: SeatIdentity;
  /** Bot seat: the GRYND mark stands in for a pfp it cannot have. */
  isAi?: boolean;
  accent?: ReactNode;
  testId: string;
}) {
  const clamped = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
  // BOTH seats are identified the same way: a face and a name. A seat whose
  // identity has not resolved yet still gets its duotone dot, so the meter never
  // renders an empty gap while the snapshot is loading.
  // A guest has no catalog icon, but it still has a face — the "G" badge — so
  // it must not collapse to the duotone dot.
  const hasAvatar = isAi || Boolean(identity?.isGuest) || Boolean(identity?.iconKey);
  return (
    <div data-testid={testId} data-percent={clamped} data-completed={completed ? "true" : "false"}>
      <div className="flex items-center justify-between gap-3">
        <span className="flex min-w-0 items-center gap-2">
          {hasAvatar ? (
            <SeatAvatar
              iconKey={identity?.iconKey ?? null}
              profileFrame={identity?.profileFrame ?? null}
              name={label}
              isAi={isAi}
              isGuest={Boolean(identity?.isGuest)}
              size="h-6 w-6"
            />
          ) : (
            <span
              aria-hidden="true"
              className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${
                tone === "mine" ? "bg-amber-400" : "bg-[#00e5ff]"
              }`}
            />
          )}
          <span className="truncate text-[11px] font-bold uppercase tracking-[0.18em] text-white/75">
            {label}
          </span>
          {completed && (
            <span className="shrink-0 rounded-full border border-emerald-400/50 bg-emerald-400/15 px-2 py-0.5 text-[9px] font-black uppercase tracking-wider text-emerald-300">
              Solved
            </span>
          )}
          {accent}
        </span>
        <span className="shrink-0 font-mono text-xl font-black tabular-nums text-white">
          {clamped}%
        </span>
      </div>
      <div className="mt-1.5 h-3 overflow-hidden rounded-full bg-white/10">
        <div
          className={`h-full rounded-full transition-[width] duration-300 ${
            tone === "mine"
              ? "bg-gradient-to-r from-amber-500 to-amber-300"
              : "bg-gradient-to-r from-sky-500 to-[#00e5ff]"
          }`}
          style={{ width: `${clamped}%` }}
        />
      </div>
      <p className="mt-1 truncate text-[10px] text-white/45">{detail}</p>
    </div>
  );
}

export type CompetitiveHudProps = {
  myPercent: number;
  myDetail: string;
  myCompleted?: boolean;
  myMistakes?: number;
  opponentPercent: number;
  opponentDetail: string;
  opponentCompleted?: boolean;
  opponentName: string;
  opponentIdentity?: SeatIdentity;
  /** The viewer's own identity, so BOTH meters carry a face and a username. */
  myIdentity?: SeatIdentity;
  /** True for a free practice match against the built-in bot. */
  isAi?: boolean;
  /** Server-anchored remaining ms until the FORFEIT, or null when untimed. */
  remainingMs: number | null;
  /** Server-anchored elapsed ms since GO, for the stopwatch. */
  elapsedMs?: number | null;
  /** True in the last five minutes before the viewer's forfeit, so the clock counts down. */
  countdownActive?: boolean;
  expired?: boolean;
  phaseLabel: string;
  phaseTone: "live" | "waiting" | "muted";
};

export default function CompetitiveHud({
  myPercent,
  myDetail,
  myCompleted = false,
  myMistakes = 0,
  opponentPercent,
  opponentDetail,
  opponentCompleted = false,
  opponentName,
  opponentIdentity = null,
  myIdentity = null,
  isAi = false,
  remainingMs,
  elapsedMs = null,
  countdownActive = false,
  expired = false,
  phaseLabel,
  phaseTone,
}: CompetitiveHudProps) {
  const mistakes = Math.max(0, Math.trunc(Number(myMistakes) || 0));

  const timerTone = expired
    ? "text-red-300 border-red-400/50 bg-red-500/10"
    : countdownActive
      ? "text-amber-200 border-amber-400/50 bg-amber-500/10"
      : "text-white/85 border-white/15 bg-black/40";

  return (
    <div
      data-testid="sudoku-hud"
      className="rounded-2xl border border-amber-500/25 bg-white/[0.04] px-3 py-3 sm:px-4"
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <span
          data-testid="sudoku-phase"
          className={`rounded-full border px-3 py-1 text-[10px] font-black uppercase tracking-wider ${
            phaseTone === "live"
              ? "border-amber-400/50 bg-amber-500/10 text-amber-200"
              : phaseTone === "waiting"
                ? "border-[#00e5ff]/40 bg-[#00e5ff]/10 text-[#9beaff]"
                : "border-white/20 bg-white/5 text-white/60"
          }`}
        >
          {phaseLabel}
        </span>

        <span
          data-testid="sudoku-timer"
          data-mode={countdownActive ? "countdown" : "stopwatch"}
          data-remaining-ms={remainingMs ?? -1}
          title={
            countdownActive ? "Time until you forfeit for inactivity" : "Elapsed match time"
          }
          className={`inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 font-mono text-lg font-black tabular-nums ${timerTone}`}
        >
          {countdownActive ? (
            <IconClock size={16} aria-hidden="true" />
          ) : (
            <IconStopwatch size={16} aria-hidden="true" />
          )}
          {countdownActive
            ? clockLabel(remainingMs ?? 0)
            : elapsedMs == null
              ? "--:--"
              : clockLabel(elapsedMs)}
        </span>
      </div>

      <div className="space-y-3">
        <Meter
          testId="sudoku-meter-mine"
          label={myIdentity?.name || "You"}
          percent={myPercent}
          detail={myDetail}
          tone="mine"
          completed={myCompleted}
          identity={myIdentity}
          accent={
            mistakes > 0 ? (
              <span
                data-testid="sudoku-mistakes"
                data-mistakes={mistakes}
                className="shrink-0 rounded-full border border-red-400/30 bg-red-500/10 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-red-300/90"
              >
                {mistakeLabel(mistakes)}
              </span>
            ) : null
          }
        />
        <Meter
          testId="sudoku-meter-theirs"
          label={opponentName}
          percent={opponentPercent}
          detail={opponentDetail}
          tone="theirs"
          completed={opponentCompleted}
          identity={opponentIdentity}
          isAi={isAi}
        />
      </div>
    </div>
  );
}
