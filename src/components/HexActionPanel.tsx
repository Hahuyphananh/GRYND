"use client";

import { useMemo } from "react";
import { IconCheck, IconClock, IconRefresh, IconPlayerSkipForward, IconSwords, IconX } from "@tabler/icons-react";
import type { DuelPlayer } from "../lib/hexDuelEngine";

export type ActionType = "attack" | "displace" | "move" | "push" | "reinforce" | null;

interface ActionPanelProps {
  currentTurn: DuelPlayer;
  currentAP: number;
  maxAP: number;
  selectedUnit: DuelPlayer | null;
  validMoves: { x: number; y: number }[];
  selectedAction: ActionType;
  onSelectAction: (action: ActionType) => void;
  onSelectUnit: () => void;
  pendingDescription: string | null;
  hasPending: boolean;
  onConfirm: () => void;
  onEndTurn: () => void;
  onSkipRound: () => void;
  onClearAction: () => void;
  isGameOver: boolean;
  playerLabel: string;
  playerColor: string;
  isActive: boolean;
  isAITurn: boolean;
}

export default function HexActionPanel({
  currentTurn,
  currentAP,
  maxAP,
  selectedAction,
  onSelectAction,
  pendingDescription,
  hasPending,
  onConfirm,
  onEndTurn,
  onSkipRound,
  onClearAction,
  isGameOver,
  playerLabel,
  playerColor,
  isActive,
  isAITurn,
}: ActionPanelProps) {
  const canAttack = currentAP >= 1;
  const canDisplace = currentAP >= 1;

  const actions = useMemo(() => [
    {
      id: "attack" as const,
      label: "Attack",
      cost: 1,
      icon: <IconSwords size={18} />,
      description: "Send troops from an adjacent tile to conquer an enemy tile",
      enabled: canAttack,
      disabledReason: !canAttack ? "Not enough AP" : null,
    },
    {
      id: "displace" as const,
      label: "Displace",
      cost: 1,
      icon: "⇄",
      description: "Move troops between two adjacent friendly tiles",
      enabled: canDisplace,
      disabledReason: !canDisplace ? "Not enough AP" : null,
    },
  ], [canAttack, canDisplace]);

  if (isGameOver || !isActive || isAITurn) return null;

  return (
    <div className="mt-3 rounded-xl border border-white/10 bg-gradient-to-b from-[#071230]/80 to-[#0a1a3f]/60 p-3 backdrop-blur-sm transition-all duration-500">
      {/* Header */}
      <div className="mb-2.5 flex items-center justify-between">
        <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-slate-400">
          Actions
        </span>
        <span className="text-[10px] text-slate-500 font-mono">
          {currentAP}/{maxAP} AP
        </span>
      </div>

      {/* Action buttons */}
      <div className="space-y-1.5">
        {actions.map((action) => (
          <button
            key={action.id}
            onClick={() => {
              if (action.enabled) {
                onSelectAction(selectedAction === action.id ? null : action.id);
              }
            }}
            disabled={!action.enabled}
            className={`
              w-full flex items-center gap-2 rounded-lg px-3 py-2.5 text-left
              transition-all duration-200 border
              ${
                selectedAction === action.id
                  ? `border-[${playerColor}] bg-white/[0.08]`
                  : action.enabled
                  ? "border-white/10 bg-white/[0.02] hover:bg-white/[0.06] hover:border-white/20"
                  : "border-white/[0.04] bg-white/[0.01] opacity-40 cursor-not-allowed"
              }
            `}
            style={
              selectedAction === action.id
                ? {
                    borderColor: playerColor,
                    boxShadow: `0 0 12px ${playerColor}22`,
                  }
                : undefined
            }
          >
            <span
              className="flex items-center justify-center w-8 h-8 rounded-lg text-sm shrink-0"
              style={{
                backgroundColor: action.enabled
                  ? `${playerColor}22`
                  : "rgba(100,116,139,0.15)",
                color: action.enabled ? playerColor : "rgba(148,163,184,0.4)",
              }}
            >
              {action.icon}
            </span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <span
                  className={`text-xs font-bold ${
                    action.enabled ? "text-slate-200" : "text-slate-500"
                  }`}
                >
                  {action.label}
                </span>
                <span
                  className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${
                    action.enabled
                      ? "bg-white/10 text-slate-300"
                      : "bg-white/[0.04] text-slate-600"
                  }`}
                >
                  {action.cost} AP
                </span>
              </div>
              <p
                className={`text-[9px] leading-tight mt-0.5 ${
                  action.enabled ? "text-slate-400" : "text-slate-600"
                }`}
              >
                {action.disabledReason ?? action.description}
              </p>
            </div>
          </button>
        ))}
      </div>

      {/* Pending action indicator + Confirm */}
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

      {/* End Turn */}
      <div className="mt-3 pt-2.5 border-t border-white/5 space-y-1.5">
        <button
          onClick={onEndTurn}
          className="w-full rounded-lg py-2 text-[11px] font-bold uppercase tracking-[0.12em] transition-all duration-200 border
            border-yellow-400/30 text-yellow-300 bg-yellow-500/10
            hover:bg-yellow-500/20 hover:border-yellow-400/50
            hover:shadow-[0_0_12px_rgba(250,204,21,0.2)]
            active:scale-[0.97]"
        >
          <IconRefresh size={14} className="mb-0.5 mr-1 inline" /> End Turn
        </button>
        <button
          onClick={onSkipRound}
          className="w-full rounded-lg py-1.5 text-[10px] font-medium uppercase tracking-[0.12em] transition-all duration-200 border
            border-white/10 text-slate-500 bg-white/[0.02]
            hover:bg-white/[0.06] hover:border-white/20 hover:text-slate-300
            active:scale-[0.97]"
        >
          <span className="inline-flex items-center gap-1"><IconPlayerSkipForward size={14} /> Skip Round (+1 AP next turn)</span>
        </button>
      </div>
    </div>
  );
}
