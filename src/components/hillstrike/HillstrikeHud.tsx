"use client";

// src/components/hillstrike/HillstrikeHud.tsx
//
// The Hillstrike HUD: both tanks' HP, whose turn it is, how many actions the
// active seat still has, and the three action controls (Fire / Drive / Build)
// plus Restart.
//
// It reads the engine's state and nothing else — `hp`, `turn`,
// `actionsRemaining` and `status` are the authoritative values, so the HUD
// cannot disagree with the board. It never decides anything: every button hands
// the intent back to the page, which applies it through the engine.

import {
  IconArrowLeft,
  IconArrowRight,
  IconBolt,
  IconRefresh,
  IconShieldPlus,
  IconTarget,
} from "@tabler/icons-react";

import type { AiDifficulty } from "../../lib/aiDifficulty";
import { MAX_HP, MOVE_RANGE } from "../../lib/hillstrike/constants";
import { buffsOf, hpOf } from "../../lib/hillstrike/rules";
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
  /** True while the viewer is choosing the tile for a cover block. */
  placing: boolean;
  resolving: boolean;
  aiThinking: boolean;
  notice: string | null;
  session: { wins: number; losses: number };
  onFire: () => void;
  onClearAim: () => void;
  onMove: (direction: MoveDirection) => void;
  onBuild: () => void;
  onRestart: () => void;
};

/** The HP bar, one per tank: a thin rail plus the number. */
function hpBar(hp: number, testId: string) {
  const ratio = Math.max(0, Math.min(1, hp / MAX_HP));
  const tone = ratio > 0.5 ? "bg-emerald-400" : ratio > 0.25 ? "bg-amber-400" : "bg-red-400";
  return (
    <div className="mt-1.5">
      <div
        className="h-2 w-full overflow-hidden rounded-full border border-white/15 bg-black/60"
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
  placing,
  resolving,
  aiThinking,
  notice,
  session,
  onFire,
  onClearAim,
  onMove,
  onBuild,
  onRestart,
}: HillstrikeHudProps) {
  const finished = state.status === "finished";
  const yourTurn = state.turn === viewerSeat && !finished;
  const actionsLeft = Math.max(0, Number(state.actionsRemaining) || 0);
  const buffs = buffsOf(state, viewerSeat);

  const statusText = finished
    ? state.winner === viewerSeat
      ? "You won the match."
      : "The bot won this one — run it back."
    : resolving
      ? "Resolving your action…"
      : yourTurn
        ? `Your turn — ${actionsLeft} action${actionsLeft === 1 ? "" : "s"} left.`
        : aiThinking
          ? "The bot is picking a line…"
          : "The bot is taking its turn…";

  const seatCard = (seat: Seat, name: string, testId: string) => {
    const active = state.turn === seat && !finished;
    const hp = hpOf(state, seat);
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
          <span
            className="font-mono text-sm font-bold text-white"
            data-testid={`${testId}-hp`}
          >
            {Math.max(0, Math.round(hp))}
            <span className="text-[10px] font-semibold text-white/45">/{MAX_HP}</span>
          </span>
        </div>
        {hpBar(hp, `${testId}-hp-bar`)}
        <div className="mt-1 flex items-center gap-1">
          {Array.from({ length: Math.max(actionsLeft, 0) }, (_, index) => (
            <span
              key={index}
              aria-hidden="true"
              className={`h-1.5 w-4 rounded-full ${
                active ? "bg-[#00e5ff]" : "bg-white/15"
              }`}
            />
          ))}
          <span className="ml-auto text-[11px] text-white/45">
            {active ? `${actionsLeft} action${actionsLeft === 1 ? "" : "s"}` : "waiting"}
          </span>
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
          {placing
            ? "Placement mode: click any free tile on YOUR half of the map. The block must rest on the ground or on another block."
            : canPlay
              ? "Three actions: fire, drive (closer or farther) or place cover. Drag on the battlefield to aim, or press Build to choose a tile."
              : finished
                ? "Match over."
                : "Wait for your turn."}
        </p>

        {(buffs.doubleDamage || buffs.doubleBlast) && (
          <div className="mt-2 flex flex-wrap gap-1.5" data-testid="hillstrike-buffs">
            {buffs.doubleDamage && (
              <span className="rounded-full border border-red-400/50 bg-red-500/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-red-200">
                Double damage · next shot
              </span>
            )}
            {buffs.doubleBlast && (
              <span className="rounded-full border border-amber-400/50 bg-amber-500/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-200">
                Double blast · next shot
              </span>
            )}
          </div>
        )}

        <div className="mt-3 flex flex-col gap-2">
          <button
            type="button"
            data-testid="hillstrike-fire"
            onClick={onFire}
            disabled={!aim || !canPlay}
            className="inline-flex items-center justify-center gap-1.5 rounded-lg border-b-4 border-[#0087a8] bg-[#00e5ff] px-4 py-2.5 text-sm font-extrabold text-[#001a2e] transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <IconBolt size={16} aria-hidden="true" />
            Fire
          </button>

          <div className="grid grid-cols-3 gap-2">
            <button
              type="button"
              data-testid="hillstrike-move-back"
              onClick={() => onMove("back")}
              disabled={!canPlay}
              title="Drive away from the enemy: less damage, harder to reach"
              className="inline-flex items-center justify-center gap-1 rounded-lg border border-white/15 bg-white/5 px-2 py-2 text-[11px] font-bold text-white/80 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <IconArrowLeft size={14} aria-hidden="true" />
              Drive back
            </button>
            <button
              type="button"
              data-testid="hillstrike-build"
              data-placing={placing ? "1" : "0"}
              onClick={onBuild}
              disabled={!canPlay}
              title={
                placing
                  ? "Cancel placement, back to aiming"
                  : "Place a cover block anywhere on your own half of the map"
              }
              className={`inline-flex items-center justify-center gap-1 rounded-lg border px-2 py-2 text-[11px] font-bold transition disabled:cursor-not-allowed disabled:opacity-40 ${
                placing
                  ? "border-emerald-300 bg-emerald-400/25 text-emerald-100"
                  : "border-emerald-400/40 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/20"
              }`}
            >
              <IconShieldPlus size={14} aria-hidden="true" />
              {placing ? "Cancel" : "Build"}
            </button>
            <button
              type="button"
              data-testid="hillstrike-move-forward"
              onClick={() => onMove("forward")}
              disabled={!canPlay}
              title="Drive toward the enemy: a shorter shot hits harder"
              className="inline-flex items-center justify-center gap-1 rounded-lg border border-white/15 bg-white/5 px-2 py-2 text-[11px] font-bold text-white/80 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Drive up
              <IconArrowRight size={14} aria-hidden="true" />
            </button>
          </div>

          <p className="text-center text-[10px] leading-relaxed text-white/40">
            Drives move you up to {MOVE_RANGE} units from your spawn — far enough
            to climb out and reach the middle's power-ups. Your base roof is
            indestructible but fixed: staying under it wins nothing.
          </p>

          <button
            type="button"
            data-testid="hillstrike-clear"
            onClick={onClearAim}
            disabled={!aim}
            className="rounded-lg border border-white/15 bg-white/5 px-4 py-2 text-xs font-semibold text-white/70 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Clear aim
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
        <span className="text-[11px] text-white/50" data-testid="hillstrike-session">
          Session: {session.wins}W · {session.losses}L
        </span>
      </div>
    </div>
  );
}
