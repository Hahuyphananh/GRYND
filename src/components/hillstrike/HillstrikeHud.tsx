"use client";

// src/components/hillstrike/HillstrikeHud.tsx
//
// The Hillstrike HUD: both seats' LIVES, whose turn it is, how many shots the
// active seat still has in this volley, and the Fire / Restart controls.
//
// It reads the engine's state and nothing else — `lives`, `turn`,
// `shotsRemaining` and `status` are the authoritative values, so the HUD cannot
// disagree with the board. It never decides anything: Fire hands the current
// aim back to the page, which applies it through the engine.

import {
  IconBolt,
  IconRefresh,
  IconTarget,
} from "@tabler/icons-react";

import type { AiDifficulty } from "../../lib/aiDifficulty";
import { LIVES_PER_PLAYER } from "../../lib/hillstrike/constants";
import type { HillstrikeState, Seat, ShotInput } from "../../lib/hillstrike/types";

export type HillstrikeHudProps = {
  state: HillstrikeState;
  viewerSeat: Seat;
  aiSeat: Seat;
  difficulty: AiDifficulty;
  aim: ShotInput | null;
  /** True when the viewer may aim and fire right now. */
  canPlay: boolean;
  resolving: boolean;
  aiThinking: boolean;
  notice: string | null;
  session: { wins: number; losses: number };
  onFire: () => void;
  onClearAim: () => void;
  onRestart: () => void;
};

const LIFE_TOTAL = LIVES_PER_PLAYER;

function livesPips(lives: number) {
  return Array.from({ length: LIFE_TOTAL }, (_, index) => (
    <span
      key={index}
      aria-hidden="true"
      className={`h-2.5 w-2.5 rounded-full border ${
        index < lives
          ? "border-[#f5ff3b] bg-[#f5ff3b] shadow-[0_0_6px_rgba(245,255,59,0.7)]"
          : "border-white/25 bg-transparent"
      }`}
    />
  ));
}

export default function HillstrikeHud({
  state,
  viewerSeat,
  aiSeat,
  difficulty,
  aim,
  canPlay,
  resolving,
  aiThinking,
  notice,
  session,
  onFire,
  onClearAim,
  onRestart,
}: HillstrikeHudProps) {
  const finished = state.status === "finished";
  const yourTurn = state.turn === viewerSeat && !finished;
  const activeShots = state.shotsRemaining;

  const statusText = finished
    ? state.winner === viewerSeat
      ? "You won the match."
      : "The bot won this one — run it back."
    : resolving
      ? "Shot in flight…"
      : yourTurn
        ? `Your turn — ${activeShots} shot${activeShots === 1 ? "" : "s"} left in this volley.`
        : aiThinking
          ? "The bot is picking a line…"
          : "The bot is aiming…";

  const seatCard = (seat: Seat, name: string, testId: string) => {
    const active = state.turn === seat && !finished;
    const shots = active ? Math.max(0, activeShots) : 0;
    return (
      <div
        data-testid={testId}
        className={`rounded-xl border p-2.5 transition-colors ${
          active
            ? "border-[#f5ff3b]/60 bg-[#f5ff3b]/10 shadow-[0_0_16px_rgba(245,255,59,0.18)]"
            : "border-white/10 bg-black/30"
        }`}
      >
        <div className="flex items-center justify-between gap-2">
          <p className="truncate text-xs font-bold uppercase tracking-wider text-white/80">
            {name}
          </p>
          <div
            className="flex items-center gap-1"
            data-testid={`${testId}-lives`}
            aria-label={`${state.lives[seat]} lives`}
          >
            {livesPips(state.lives[seat])}
          </div>
        </div>
        <p className="mt-0.5 text-[11px] text-white/55">
          {active
            ? `${activeShots} shot${activeShots === 1 ? "" : "s"} left this volley`
            : `${state.lives[seat]} ${state.lives[seat] === 1 ? "life" : "lives"} left`}
        </p>
        <div className="mt-1 flex h-1.5 items-center gap-1">
          {Array.from({ length: shots }, (_, index) => (
            <span
              key={index}
              aria-hidden="true"
              className="h-1.5 w-4 rounded-full bg-[#00e5ff]"
            />
          ))}
        </div>
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-3">
      <p
        role="status"
        aria-live="polite"
        data-testid="hillstrike-status"
        className="rounded-xl border border-cyan-400/25 bg-black/35 px-3 py-2 text-center text-sm font-semibold text-[#d8fbff]"
      >
        {statusText}
      </p>

      <div className="grid grid-cols-2 gap-2">
        {seatCard(viewerSeat, "You", "hillstrike-seat-you")}
        {seatCard(aiSeat, `Bot · ${difficulty}`, "hillstrike-seat-ai")}
      </div>

      <div className="rounded-xl border border-white/10 bg-black/30 p-3">
        <div className="flex items-center justify-between text-xs">
          <span className="inline-flex items-center gap-1.5 font-bold uppercase tracking-wider text-cyan-300">
            <IconTarget size={14} aria-hidden="true" />
            Aim
          </span>
          <span
            className="font-mono text-sm font-bold text-white"
            data-testid="hillstrike-aim-readout"
          >
            {aim ? `${Math.round(aim.angleDeg)}° · ${aim.power}%` : "—"}
          </span>
        </div>

        <p className="mt-1 text-[11px] leading-relaxed text-white/55">
          {canPlay
            ? "Drag away from your target on the battlefield to set angle and power, then Fire."
            : finished
              ? "Match over."
              : "Wait for your turn."}
        </p>

        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <button
            type="button"
            data-testid="hillstrike-fire"
            onClick={onFire}
            disabled={!aim || !canPlay}
            className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg border-b-4 border-[#0087a8] bg-[#00e5ff] px-4 py-2.5 text-sm font-extrabold text-[#001a2e] transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <IconBolt size={16} aria-hidden="true" />
            Fire
          </button>
          <button
            type="button"
            data-testid="hillstrike-clear"
            onClick={onClearAim}
            disabled={!aim}
            className="rounded-lg border border-white/15 bg-white/5 px-4 py-2.5 text-sm font-semibold text-white/80 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Clear
          </button>
        </div>
      </div>

      <p
        role="status"
        aria-live="polite"
        data-testid="hillstrike-notice"
        className={`min-h-[1rem] text-center text-xs ${
          notice ? "text-amber-300" : "text-transparent"
        }`}
      >
        {notice ?? "."}
      </p>

      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          data-testid="hillstrike-restart"
          onClick={onRestart}
          className="inline-flex items-center gap-1.5 rounded-lg border border-[#00e5ff]/40 bg-[#00e5ff]/10 px-3 py-2 text-xs font-bold text-[#67f9ff] transition hover:bg-[#00e5ff]/20"
        >
          <IconRefresh size={14} aria-hidden="true" />
          Restart · new layout
        </button>
        <span
          className="text-[11px] text-white/50"
          data-testid="hillstrike-session"
        >
          Session: {session.wins}W · {session.losses}L
        </span>
      </div>
    </div>
  );
}
