"use client";

import { useMemo, useRef, useEffect } from "react";
import type { ActionLogEntry } from "../lib/hexDuelEngine";

// ══════════════════════════════════════════════════════════════════════════
//  Icons per action type
// ══════════════════════════════════════════════════════════════════════════

const TYPE_META: Record<
  ActionLogEntry["type"],
  { icon: string; label: string; color: string }
> = {
  move:       { icon: "⬡",  label: "Move",       color: "#22d3ee" },
  push:       { icon: "⇶",  label: "Push",       color: "#f472b6" },
  reinforce:  { icon: "🛡", label: "Reinforce",  color: "#34d399" },
  endTurn:    { icon: "⟳",  label: "End Turn",   color: "#facc15" },
  attack:     { icon: "⚔",  label: "Attack",     color: "#f97316" },
  displace:   { icon: "⇄",  label: "Displace",   color: "#22c55e" },
  troopGrowth:{ icon: "↑",  label: "Troop Growth", color: "#a855f7" },
};

// ══════════════════════════════════════════════════════════════════════════
//  Single log entry row
// ══════════════════════════════════════════════════════════════════════════

function LogEntryRow({ entry }: { entry: ActionLogEntry }) {
  const meta = TYPE_META[entry.type];
  const playerColor = entry.player === "player1" ? "#22d3ee" : "#ef4444";
  const playerLabel = entry.player === "player1" ? "P1" : "P2";

  return (
    <div className="flex items-start gap-2 py-1.5 border-b border-white/[0.04] last:border-b-0">
      {/* Player dot */}
      <span
        className="mt-0.5 inline-block w-2 h-2 shrink-0 rounded-full"
        style={{ backgroundColor: playerColor, boxShadow: `0 0 6px ${playerColor}66` }}
      />

      {/* Action icon + label */}
      <span className="text-[11px] text-slate-400 shrink-0" title={meta.label}>
        {meta.icon}
      </span>

      {/* Action description */}
      <span className="text-[11px] text-slate-300 leading-tight flex-1 min-w-0">
        {entry.label}
      </span>

      {/* AP cost */}
      {entry.apCost > 0 && (
        <span
          className="text-[10px] font-bold tabular-nums shrink-0"
          style={{ color: meta.color }}
        >
          -{entry.apCost} AP
        </span>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
//  Turn separator
// ══════════════════════════════════════════════════════════════════════════

function TurnSeparator({ num }: { num: number }) {
  return (
    <div className="flex items-center gap-2 py-1.5">
      <div className="flex-1 h-px bg-white/[0.06]" />
      <span className="text-[9px] text-slate-600 uppercase tracking-widest font-bold">
        Turn {num}
      </span>
      <div className="flex-1 h-px bg-white/[0.06]" />
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
//  Main component
// ══════════════════════════════════════════════════════════════════════════

export default function HexActionLog({
  log,
  compact = false,
}: {
  log: ActionLogEntry[];
  compact?: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to latest entry
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [log.length]);

  // Group entries by endTurn boundaries to create "turns"
  const { entries, turnCount } = useMemo(() => {
    if (log.length === 0) return { entries: [] as (ActionLogEntry | { type: "turnSep"; turnNum: number })[], turnCount: 0 };

    const grouped: (ActionLogEntry | { type: "turnSep"; turnNum: number })[] = [];
    let turnNum = 0;

    // First entry always starts with a turn separator
    // We detect turns by endTurn entries followed by any entry from the other player
    grouped.push({ type: "turnSep", turnNum: 1 });

    for (let i = 0; i < log.length; i++) {
      const entry = log[i];
      grouped.push(entry);

      // If this is an endTurn, the next action (if any) starts a new turn
      if (entry.type === "endTurn" && i + 1 < log.length) {
        turnNum++;
        grouped.push({ type: "turnSep", turnNum: turnNum + 1 });
      }
    }

    turnNum++; // count the last turn
    return { entries: grouped, turnCount: turnNum };
  }, [log]);

  if (log.length === 0) {
    return null;
  }

  return (
    <div
      className="rounded-xl border border-white/10 bg-white/[0.03] backdrop-blur-sm overflow-hidden"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/10">
        <span className="text-[10px] text-slate-500 uppercase tracking-widest font-bold">
          ⏱ Action Log
        </span>
        <span className="text-[10px] text-slate-600 tabular-nums">
          {log.length} action{log.length !== 1 ? "s" : ""} · {turnCount} turn{turnCount !== 1 ? "s" : ""}
        </span>
      </div>

      {/* Scrollable list */}
      <div
        ref={scrollRef}
        className="overflow-y-auto"
        style={{ maxHeight: compact ? 180 : 320 }}
      >
        <div className="px-3 py-1">
          {entries.map((item, idx) => {
            if ("type" in item && item.type === "turnSep") {
              return <TurnSeparator key={`turn-${idx}`} num={item.turnNum} />;
            }
            const entry = item as ActionLogEntry;
            return <LogEntryRow key={entry.id} entry={entry} />;
          })}
        </div>
      </div>

      {/* AP spent summary footer */}
      <LogSummaryFooter log={log} />
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
//  Footer summary — total AP spent per player
// ══════════════════════════════════════════════════════════════════════════

function LogSummaryFooter({ log }: { log: ActionLogEntry[] }) {
  const summary = useMemo(() => {
    let p1AP = 0;
    let p2AP = 0;
    for (const entry of log) {
      if (entry.player === "player1") p1AP += entry.apCost;
      else p2AP += entry.apCost;
    }
    return { p1AP, p2AP };
  }, [log]);

  return (
    <div className="flex items-center justify-between border-t border-white/10 px-3 py-2 bg-white/[0.02]">
      <div className="flex items-center gap-3">
        <span className="flex items-center gap-1">
          <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ backgroundColor: "#22d3ee" }} />
          <span className="text-[10px] text-slate-400">P1</span>
          <span className="text-[10px] font-bold text-white tabular-nums">{summary.p1AP}</span>
        </span>
        <span className="text-[9px] text-slate-600">AP</span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ backgroundColor: "#ef4444" }} />
          <span className="text-[10px] text-slate-400">P2</span>
          <span className="text-[10px] font-bold text-white tabular-nums">{summary.p2AP}</span>
        </span>
      </div>
      <span className="text-[10px] text-slate-600 tabular-nums">
        Total: {summary.p1AP + summary.p2AP} AP
      </span>
    </div>
  );
}
