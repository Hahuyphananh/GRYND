"use client";

import { useMemo } from "react";
import {
  IconArrowUpRight,
  IconCheck,
  IconClock,
  IconPlayerSkipForward,
  IconSwords,
  IconX,
} from "@tabler/icons-react";
import type { DuelPlayer } from "../lib/hexDuelEngine";

export type ActionType =
  | "attack"
  | "displace"
  | "upgrade"
  | "move"
  | "push"
  | "reinforce"
  | null;

/** What the page computed for the territory the player tapped. */
export interface UpgradePreview {
  /** "x,y" of the territory. */
  key: string;
  currentLevel: number;
  nextLevel: number;
  /** Troops sacrificed from the territory. */
  cost: number;
  /** Troops before the upgrade. */
  troops: number;
  /** Troops left after paying the cost. */
  remainingTroops: number;
  /** Troop ceiling after the upgrade. */
  nextCapacity: number;
  canUpgrade: boolean;
  /** Why it cannot be upgraded (null when it can). */
  reason: string | null;
}

interface ActionPanelProps {
  currentTurn: DuelPlayer;
  selectedUnit: DuelPlayer | null;
  validMoves: { x: number; y: number }[];
  selectedAction: ActionType;
  onSelectAction: (action: ActionType) => void;
  onSelectUnit: () => void;
  pendingDescription: string | null;
  hasPending: boolean;
  onConfirm: () => void;
  onSkipRound: () => void;
  onClearAction: () => void;
  isGameOver: boolean;
  playerLabel: string;
  playerColor: string;
  isActive: boolean;
  isAITurn: boolean;
  /** Territory the player tapped in upgrade mode, with its level preview. */
  upgradePreview?: UpgradePreview | null;
}

/** Upgrades get their own accent so they never read as an attack or a move. */
const UPGRADE_COLOR = "#a855f7";

/**
 * The action board.
 *
 * ONE ACTION PER TURN. There is no action-point pool: the panel offers attack,
 * displace, upgrade and skip, and the turn is handed over automatically by
 * whatever action resolves. Upgrades are visually distinct (purple icon, own
 * preview card) because they change a territory's level and ceiling instead of
 * moving troops across the board.
 */
export default function HexActionPanel({
  currentTurn,
  selectedAction,
  onSelectAction,
  pendingDescription,
  hasPending,
  onConfirm,
  onSkipRound,
  onClearAction,
  isGameOver,
  playerLabel,
  playerColor,
  isActive,
  isAITurn,
  upgradePreview,
}: ActionPanelProps) {
  // Every action is offered to the player whose turn it is — the board refuses
  // an impossible move, and the turn ends either way. The upgrade row stays
  // selectable so a territory can be tapped; its Confirm is what checks the
  // level, the cost and the remaining troops.
  const actions = useMemo(
    () => [
      {
        id: "attack" as const,
        label: "Attack",
        icon: <IconSwords size={18} />,
        description: "Send troops to conquer an adjacent enemy or neutral tile",
        accent: playerColor,
      },
      {
        id: "displace" as const,
        label: "Displace",
        icon: "⇄",
        description: "Move troops between two adjacent friendly tiles",
        accent: playerColor,
      },
      {
        id: "upgrade" as const,
        label: "Upgrade",
        icon: <IconArrowUpRight size={18} />,
        description: "Spend troops to raise a territory's level and troop capacity",
        accent: UPGRADE_COLOR,
      },
    ],
    [playerColor],
  );

  if (isGameOver || !isActive || isAITurn) return null;

  return (
    <div className="mt-3 rounded-xl border border-white/10 bg-gradient-to-b from-[#071230]/80 to-[#0a1a3f]/60 p-3 backdrop-blur-sm transition-all duration-500">
      {/* Header — no AP counter: one action, then the turn passes. */}
      <div className="mb-2.5 flex items-center justify-between">
        <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-slate-400">
          Actions
        </span>
        <span className="text-[10px] font-medium uppercase tracking-wider text-slate-500">
          1 action this turn
        </span>
      </div>

      {/* Action buttons */}
      <div className="space-y-1.5">
        {actions.map((action) => {
          const selected = selectedAction === action.id;
          return (
            <button
              key={action.id}
              onClick={() => onSelectAction(selected ? null : action.id)}
              className={`
              w-full flex items-center gap-2 rounded-lg px-3 py-2.5 text-left
              transition-all duration-200 border
              ${
                selected
                  ? "bg-white/[0.08]"
                  : "border-white/10 bg-white/[0.02] hover:bg-white/[0.06] hover:border-white/20"
              }
            `}
              style={
                selected
                  ? {
                      borderColor: action.accent,
                      boxShadow: `0 0 12px ${action.accent}22`,
                    }
                  : undefined
              }
            >
              <span
                className="flex items-center justify-center w-8 h-8 rounded-lg text-sm shrink-0"
                style={{
                  backgroundColor: `${action.accent}22`,
                  color: action.accent,
                }}
              >
                {action.icon}
              </span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs font-bold text-slate-200">
                    {action.label}
                  </span>
                  <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-white/10 text-slate-300">
                    Ends your turn
                  </span>
                </div>
                <p className="text-[9px] leading-tight mt-0.5 text-slate-400">
                  {action.description}
                </p>
              </div>
            </button>
          );
        })}
      </div>

      {/* Upgrade preview — level, cost, new capacity and what is left, all
          read from the rulebook for the territory the player tapped. */}
      {selectedAction === "upgrade" && (
        <div className="mt-3 rounded-lg border border-purple-400/30 bg-purple-500/[0.06] p-2.5">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-purple-300">
              Upgrade territory
            </span>
            {upgradePreview && (
              <span className="font-mono text-[9px] text-slate-400">
                {upgradePreview.key}
              </span>
            )}
          </div>

          {!upgradePreview ? (
            <p className="text-[10px] leading-snug text-slate-400">
              Tap one of your territories to preview its upgrade
            </p>
          ) : (
            <>
              <dl className="grid grid-cols-2 gap-x-2 gap-y-1 text-[10px]">
                <dt className="text-slate-500">Level</dt>
                <dd className="text-right font-bold text-slate-200">
                  {upgradePreview.currentLevel} → {upgradePreview.nextLevel}
                </dd>
                <dt className="text-slate-500">Troops</dt>
                <dd className="text-right font-bold text-slate-200">
                  {upgradePreview.troops}
                </dd>
                <dt className="text-slate-500">Sacrifice</dt>
                <dd className="text-right font-bold text-purple-300">
                  -{upgradePreview.cost}
                </dd>
                <dt className="text-slate-500">New capacity</dt>
                <dd className="text-right font-bold text-slate-200">
                  {upgradePreview.nextCapacity}
                </dd>
                <dt className="text-slate-500">Remaining</dt>
                <dd className="text-right font-bold text-slate-200">
                  {upgradePreview.remainingTroops}
                </dd>
              </dl>

              {upgradePreview.canUpgrade ? (
                <button
                  onClick={onConfirm}
                  className="mt-2 w-full rounded-lg py-2 text-[11px] font-bold uppercase tracking-[0.12em] transition-all duration-200 hover:scale-[1.02] active:scale-[0.97]"
                  style={{
                    backgroundColor: UPGRADE_COLOR,
                    color: "#020617",
                    boxShadow: `0 0 14px ${UPGRADE_COLOR}44`,
                  }}
                >
                  <IconCheck size={14} className="mb-0.5 mr-1 inline" /> Confirm
                  upgrade
                </button>
              ) : (
                <p className="mt-2 text-[10px] leading-snug text-yellow-400/80">
                  {upgradePreview.reason}
                </p>
              )}

              <button
                onClick={onClearAction}
                className="mt-1.5 w-full rounded-lg py-1.5 text-[10px] text-slate-500 border border-white/10 hover:text-slate-300 hover:border-white/20 transition-all"
              >
                <IconX size={12} className="mb-0.5 mr-1 inline" /> Cancel
              </button>
            </>
          )}
        </div>
      )}

      {/* Pending action indicator + Confirm (attack / displace) */}
      {hasPending && pendingDescription && (
        <div
          className="mt-3 rounded-lg p-2.5 border"
          style={{
            borderColor: `${playerColor}44`,
            backgroundColor: `${playerColor}08`,
            animation: "floatUp 0.3s ease-out",
          }}
        >
          <div className="flex items-center gap-2 mb-2">
            <span className="text-[10px] text-slate-400 uppercase tracking-wider">
              <IconClock size={12} className="mb-0.5 mr-1 inline" /> Pending
            </span>
            <span className="text-[10px] font-mono text-slate-300 truncate">
              {pendingDescription}
            </span>
          </div>
          <div className="flex gap-1.5">
            <button
              onClick={onConfirm}
              className="flex-1 rounded-lg py-2 text-[11px] font-bold uppercase tracking-[0.12em] transition-all duration-200 hover:scale-[1.02] active:scale-[0.97]"
              style={{
                backgroundColor: playerColor,
                color: "#020617",
                boxShadow: `0 0 14px ${playerColor}44`,
              }}
            >
              <IconCheck size={14} className="mb-0.5 mr-1 inline" /> Confirm
            </button>
            <button
              onClick={onClearAction}
              className="rounded-lg px-3 py-2 text-[10px] text-slate-500 border border-white/10 hover:text-slate-300 hover:border-white/20 transition-all"
            >
              <IconX size={14} />
            </button>
          </div>
        </div>
      )}

      {/* Skip turn — the one way to pass without acting. */}
      <div className="mt-3 pt-2.5 border-t border-white/5">
        <button
          onClick={onSkipRound}
          className="w-full rounded-lg py-2 text-[11px] font-bold uppercase tracking-[0.12em] transition-all duration-200 border
            border-white/15 text-slate-300 bg-white/[0.03]
            hover:bg-white/[0.08] hover:border-white/30 hover:text-white
            active:scale-[0.97]"
        >
          <span className="inline-flex items-center gap-1">
            <IconPlayerSkipForward size={14} /> Skip Turn
          </span>
        </button>
      </div>
    </div>
  );
}
