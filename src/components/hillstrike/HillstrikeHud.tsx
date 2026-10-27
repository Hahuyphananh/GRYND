"use client";

// src/components/hillstrike/HillstrikeHud.tsx
//
// The Hillstrike control bar. It is mounted INSIDE the game screen, pinned to the
// bottom: both tanks' HP, whose turn it is, the match clock, the aim readout and
// the action controls (Fire / Drive up / Drive back / Clear), plus Restart.
//
// It reads the engine's state and nothing else — `hp`, `turn`,
// `actionsRemaining`, `status` and the caller's clock are the authoritative
// values, so the HUD cannot disagree with the board. It never decides anything:
// every button hands the intent back to the page, which applies it through the
// engine.
//
// There is deliberately NO build control: placing cover is not an action any
// more, and the only structures on the board are the base roofs and the middle
// tower.

import {
  IconArrowLeft,
  IconArrowRight,
  IconBolt,
  IconClock,
  IconRefresh,
  IconTarget,
} from "@tabler/icons-react";

import type { AiDifficulty } from "../../lib/aiDifficulty";
import {
  MATCH_DURATION_OPTIONS_MS,
  MAX_HP,
} from "../../lib/hillstrike/constants";
import { buffsOf, hpOf } from "../../lib/hillstrike/rules";
import { clockLabel } from "../../lib/hillstrike/ui";
import type {
  HillstrikeState,
  MoveDirection,
  Seat,
  ShotInput,
} from "../../lib/hillstrike/types";

export type HillstrikeHudProps = {
  state: HillstrikeState;
  viewerSeat: Seat;
  aiSeat: Seat;
  difficulty: AiDifficulty;
  aim: ShotInput | null;
  /** True when the viewer may act right now. */
  canPlay: boolean;
  resolving: boolean;
  aiThinking: boolean;
  notice: string | null;
  session: { wins: number; losses: number };
  /** Milliseconds left on the match clock. */
  clockMs: number;
  /** The clock this match was dealt with. */
  durationMs: number;
  onDuration: (durationMs: number) => void;
  onFire: () => void;
  onClearAim: () => void;
  onMove: (direction: MoveDirection) => void;
  onRestart: () => void;
};

/** A compact HP rail plus its number. */
function hpBar(hp: number, testId: string) {
  const ratio = Math.max(0, Math.min(1, hp / MAX_HP));
  const tone = ratio > 0.5 ? "bg-emerald-400" : ratio > 0.25 ? "bg-amber-400" : "bg-red-400";
  return (
    <div
      className="h-1.5 w-full overflow-hidden rounded-full border border-white/15 bg-black/60"
      data-testid={testId}
      role="meter"
      aria-valuemin={0}
      aria-valuemax={MAX_HP}
      aria-valuenow={Math.max(0, Math.round(hp))}
      aria-label={`${Math.max(0, Math.round(hp))} of ${MAX_HP} HP`}
    >
      <div
        className={`h-full rounded-full transition-[width] duration-300 ${tone}`}
        style={{ width: `${(ratio * 100).toFixed(1)}%` }}
      />
    </div>
  );
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
  clockMs,
  durationMs,
  onDuration,
  onFire,
  onClearAim,
  onMove,
  onRestart,
}: HillstrikeHudProps) {
  const finished = state.status === "finished";
  const yourTurn = state.turn === viewerSeat && !finished;
  const actionsLeft = Math.max(0, Number(state.actionsRemaining) || 0);
  const buffs = buffsOf(state, viewerSeat);
  const yourHp = hpOf(state, viewerSeat);
  const aiHp = hpOf(state, aiSeat);

  const statusText = finished
    ? state.winner === viewerSeat
      ? "You won the match."
      : state.winner === null
        ? "Time — the match is a draw."
        : "The bot won this one — run it back."
    : resolving
      ? "Resolving your action…"
      : yourTurn
        ? `Your turn — ${actionsLeft} action${actionsLeft === 1 ? "" : "s"} left.`
        : aiThinking
          ? "The bot is picking a line…"
          : "The bot is taking its turn…";

  const seatChip = (name: string, hp: number, active: boolean, testId: string) => (
    <div
      data-testid={testId}
      data-hp={Math.max(0, Math.round(hp))}
      className={`flex min-w-0 flex-1 flex-col gap-1 rounded-lg border px-2 py-1.5 ${
        active
          ? "border-[#f5ff3b]/60 bg-[#f5ff3b]/10"
          : "border-white/10 bg-black/30"
      }`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-[10px] font-bold uppercase tracking-wider text-white/75">
          {name}
        </span>
        <span className="font-mono text-xs font-bold text-white">
          {Math.max(0, Math.round(hp))}
          <span className="text-[9px] font-semibold text-white/45">/{MAX_HP}</span>
        </span>
      </div>
      {hpBar(hp, `${testId}-hp-bar`)}
    </div>
  );

  return (
    <div className="shrink-0 border-t border-cyan-400/20 bg-[#020b16]/95 px-2 py-2 backdrop-blur sm:px-3">
      {/* ── Status + clock ─────────────────────────────────────────────── */}
      <div className="flex items-center gap-2">
        <p
          role="status"
          aria-live="polite"
          data-testid="hillstrike-status"
          className="min-w-0 flex-1 truncate text-[11px] font-semibold text-[#d8fbff] sm:text-xs"
        >
          {statusText}
        </p>
        <span
          data-testid="hillstrike-clock"
          className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[11px] font-bold ${
            clockMs <= 30_000 && !finished
              ? "border-red-400/60 bg-red-500/15 text-red-200"
              : "border-cyan-400/40 bg-cyan-500/10 text-cyan-100"
          }`}
          aria-label={`Match clock ${clockLabel(clockMs)}`}
        >
          <IconClock size={12} aria-hidden="true" />
          {finished ? "0:00" : clockLabel(clockMs)}
        </span>
      </div>

      {/* ── Both tanks ─────────────────────────────────────────────────── */}
      <div className="mt-1.5 flex items-stretch gap-2">
        {seatChip("You", yourHp, state.turn === viewerSeat && !finished, "hillstrike-seat-you")}
        {seatChip(`Bot · ${difficulty}`, aiHp, state.turn === aiSeat && !finished, "hillstrike-seat-ai")}
      </div>

      {/* ── Aim + the actions ──────────────────────────────────────────── */}
      <div className="mt-2 flex items-stretch gap-2">
        <div className="flex min-w-0 flex-1 flex-col justify-center rounded-lg border border-white/10 bg-black/30 px-2 py-1">
          <div className="flex items-center justify-between gap-2 text-[10px]">
            <span className="inline-flex items-center gap-1 font-bold uppercase tracking-wider text-cyan-300">
              <IconTarget size={12} aria-hidden="true" />
              Aim
            </span>
            <span
              className="font-mono text-xs font-bold text-white"
              data-testid="hillstrike-aim-readout"
            >
              {aim ? `${Math.round(aim.angleDeg)}° · ${aim.power}%` : "—"}
            </span>
          </div>
          <p className="truncate text-[10px] leading-tight text-white/50">
            {canPlay
              ? "Drag on the board to aim, then Fire."
              : finished
                ? "Match over."
                : "Wait for your turn."}
          </p>
          {(buffs.doubleDamage || buffs.doubleBlast) && (
            <div className="mt-1 flex flex-wrap gap-1" data-testid="hillstrike-buffs">
              {buffs.doubleDamage && (
                <span className="rounded-full border border-red-400/50 bg-red-500/15 px-1.5 text-[9px] font-bold uppercase tracking-wider text-red-200">
                  ×2 damage
                </span>
              )}
              {buffs.doubleBlast && (
                <span className="rounded-full border border-amber-400/50 bg-amber-500/15 px-1.5 text-[9px] font-bold uppercase tracking-wider text-amber-200">
                  ×2 blast
                </span>
              )}
            </div>
          )}
        </div>

        <button
          type="button"
          data-testid="hillstrike-fire"
          onClick={onFire}
          disabled={!aim || !canPlay}
          className="inline-flex w-28 shrink-0 items-center justify-center gap-1.5 rounded-lg border-b-4 border-[#0087a8] bg-[#00e5ff] px-3 py-2 text-sm font-extrabold text-[#001a2e] transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <IconBolt size={16} aria-hidden="true" />
          Fire
        </button>
      </div>

      <div className="mt-1.5 grid grid-cols-3 gap-1.5">
        <button
          type="button"
          data-testid="hillstrike-move-back"
          onClick={() => onMove("back")}
          disabled={!canPlay}
          title="Drive away from the enemy: less damage, harder to reach"
          className="inline-flex items-center justify-center gap-1 rounded-lg border border-white/15 bg-white/5 px-1.5 py-1.5 text-[10px] font-bold text-white/80 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <IconArrowLeft size={12} aria-hidden="true" />
          Drive back
        </button>
        <button
          type="button"
          data-testid="hillstrike-clear"
          onClick={onClearAim}
          disabled={!aim}
          className="rounded-lg border border-white/15 bg-white/5 px-1.5 py-1.5 text-[10px] font-semibold text-white/70 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Clear aim
        </button>
        <button
          type="button"
          data-testid="hillstrike-move-forward"
          onClick={() => onMove("forward")}
          disabled={!canPlay}
          title="Drive toward the enemy: a shorter shot hits harder"
          className="inline-flex items-center justify-center gap-1 rounded-lg border border-white/15 bg-white/5 px-1.5 py-1.5 text-[10px] font-bold text-white/80 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Drive up
          <IconArrowRight size={12} aria-hidden="true" />
        </button>
      </div>

      <div className="mt-1.5 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1" data-testid="hillstrike-durations">
          <span className="text-[9px] font-bold uppercase tracking-wider text-white/40">
            Clock
          </span>
          {MATCH_DURATION_OPTIONS_MS.map((option) => (
            <button
              key={option}
              type="button"
              data-testid={`hillstrike-duration-${option}`}
              data-selected={option === durationMs ? "1" : "0"}
              onClick={() => onDuration(option)}
              className={`rounded-full border px-2 py-0.5 text-[10px] font-bold transition ${
                option === durationMs
                  ? "border-cyan-300 bg-cyan-400/20 text-cyan-100"
                  : "border-white/15 text-white/50 hover:bg-white/10"
              }`}
            >
              {option / 60_000}m
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <p
            role="status"
            aria-live="polite"
            data-testid="hillstrike-notice"
            className={`max-w-[14rem] truncate text-[10px] ${
              notice ? "text-amber-300" : "text-transparent"
            }`}
          >
            {notice ?? "."}
          </p>
          <button
            type="button"
            data-testid="hillstrike-restart"
            onClick={onRestart}
            className="inline-flex items-center gap-1 rounded-lg border border-[#00e5ff]/40 bg-[#00e5ff]/10 px-2 py-1 text-[10px] font-bold text-[#67f9ff] transition hover:bg-[#00e5ff]/20"
          >
            <IconRefresh size={12} aria-hidden="true" />
            New layout
          </button>
          <span className="text-[10px] text-white/45" data-testid="hillstrike-session">
            {session.wins}W · {session.losses}L
          </span>
        </div>
      </div>
    </div>
  );
}
