"use client";

import { useRef, useState, useCallback } from "react";

export type TileOwner = "neutral" | "player1" | "player2";

export interface HexTileData {
  x: number;
  y: number;
  owner: TileOwner;
  troops: number;
  shield: number;
  capital?: boolean;
}

interface HexTileProps {
  tile: HexTileData;
  isSelected: boolean;
  onClick: () => void;
  /** Which player's unit occupies this tile (for HEX DUEL mode) */
  unitOwner?: "player1" | "player2";
  /** Whether this tile is a valid move target */
  isValidMove?: boolean;
  /** Whether this tile is a push target (enemy hex that can be pushed) */
  isPushTarget?: boolean;
  /** Whether this tile was just captured (triggers glow pulse animation) */
  recentlyCaptured?: boolean;
  /** Whether a unit just arrived here via push (triggers bounce animation) */
  pushedHere?: boolean;
  /** Whether this tile is a power node (purple glow + ⚡ icon) */
  isPowerNode?: boolean;
}

const HEX_CLIP = "polygon(25% 0%, 75% 0%, 100% 50%, 75% 100%, 25% 100%, 0% 50%)";

const ownerThemes: Record<
  TileOwner,
  {
    border: string;
    bg: string;
    text: string;
    glow: string;
    selectedGlow: string;
    troopsShadow: string;
  }
> = {
  player1: {
    border: "#22d3ee",
    bg: "bg-gradient-to-b from-cyan-500/40 via-cyan-600/30 to-blue-700/40",
    text: "text-cyan-100",
    glow: "drop-shadow(0 0 6px rgba(34,211,238,0.35))",
    selectedGlow: "drop-shadow(0 0 18px rgba(34,211,238,0.8)) drop-shadow(0 0 6px rgba(34,211,238,0.5))",
    troopsShadow: "0 0 6px rgba(34,211,238,0.5)",
  },
  player2: {
    border: "#ef4444",
    bg: "bg-gradient-to-b from-red-500/40 via-red-600/30 to-rose-700/40",
    text: "text-red-100",
    glow: "drop-shadow(0 0 6px rgba(239,68,68,0.35))",
    selectedGlow: "drop-shadow(0 0 18px rgba(239,68,68,0.8)) drop-shadow(0 0 6px rgba(239,68,68,0.5))",
    troopsShadow: "0 0 6px rgba(239,68,68,0.5)",
  },
  neutral: {
    border: "#475569",
    bg: "bg-gradient-to-b from-slate-700/40 via-slate-800/30 to-slate-900/40",
    text: "text-slate-300",
    glow: "drop-shadow(0 0 2px rgba(100,116,139,0.2))",
    selectedGlow: "drop-shadow(0 0 10px rgba(148,163,184,0.6))",
    troopsShadow: "0 0 2px rgba(0,0,0,0.4)",
  },
};

const unitColors: Record<"player1" | "player2", { ring: string; fill: string; glow: string }> = {
  player1: { ring: "#22d3ee", fill: "#06b6d4", glow: "rgba(34,211,238,0.7)" },
  player2: { ring: "#ef4444", fill: "#dc2626", glow: "rgba(239,68,68,0.7)" },
};

export default function HexTile({ tile, isSelected, onClick, unitOwner, isValidMove, isPushTarget, recentlyCaptured, pushedHere, isPowerNode }: HexTileProps) {
  const { owner, troops, shield, capital } = tile;
  const theme = ownerThemes[owner];

  const filterStyle = isSelected ? theme.selectedGlow : theme.glow;

  const unitTheme = unitOwner ? unitColors[unitOwner] : null;

  // ── Click ripple state ───────────────────────────────────────────
  const [ripple, setRipple] = useState<{ x: number; y: number; id: number } | null>(null);
  const rippleId = useRef(0);

  const handleClick = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    const id = ++rippleId.current;
    setRipple({ x, y, id });
    setTimeout(() => setRipple((prev) => (prev?.id === id ? null : prev)), 500);
    onClick();
  }, [onClick]);



  return (
    <button
      onClick={handleClick}
      className={`
        group relative
        w-[72px] h-[83px]
        sm:w-[82px] sm:h-[95px]
        md:w-[90px] md:h-[104px]
        flex items-center justify-center
        transition-transform duration-200 ease-out
        hover:scale-110 hover:z-20
        active:scale-95
        ${isSelected ? "scale-105 z-10" : "z-0"}
        cursor-pointer outline-none
      `}
      style={{
        clipPath: HEX_CLIP,
        filter: filterStyle,
        transition: "filter 0.3s ease, transform 0.2s ease",
      }}
    >
      {/* Outer border glow ring (via inset box-shadow) */}
      <div
        className="absolute inset-0"
        style={{
          clipPath: HEX_CLIP,
          boxShadow: isPowerNode
            ? `inset 0 0 0 3px #a855f7, inset 0 0 22px rgba(168,85,247,0.55)`
            : isPushTarget
            ? `inset 0 0 0 3px #f97316, inset 0 0 18px rgba(249,115,22,0.5)`
            : isValidMove
            ? `inset 0 0 0 3px #facc15, inset 0 0 18px rgba(250,204,21,0.5)`
            : `inset 0 0 0 2px ${theme.border}, inset 0 0 12px ${theme.border}40`,
        }}
      />

      {/* Valid move pulsing ring */}
      {isValidMove && (
        <div
          className="absolute inset-0 animate-pulse"
          style={{
            clipPath: HEX_CLIP,
            background: "rgba(250,204,21,0.12)",
          }}
        />
      )}

      {/* Push target pulsing ring (orange) */}
      {isPushTarget && (
        <div
          className="absolute inset-0 animate-pulse"
          style={{
            clipPath: HEX_CLIP,
            background: "rgba(249,115,22,0.15)",
          }}
        />
      )}

      {/* Power node pulsing ring (purple) */}
      {isPowerNode && (
        <div
          className="absolute inset-0 animate-pulse"
          style={{
            clipPath: HEX_CLIP,
            background: "rgba(168,85,247,0.18)",
            animationDuration: "2s",
          }}
        />
      )}

      {/* Background fill */}
      <div className={`absolute inset-0 ${theme.bg}`} />

      {/* Hover shimmer */}
      <div className="absolute inset-0 bg-white/0 opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-hover:bg-white/[0.07]" />

      {/* Click ripple effect */}
      {ripple && (
        <div
          className="absolute z-30 pointer-events-none rounded-full"
          style={{
            left: `${ripple.x}%`,
            top: `${ripple.y}%`,
            width: "4px",
            height: "4px",
            transform: "translate(-50%, -50%)",
            animation: "hexRipple 0.5s ease-out forwards",
            background: `radial-gradient(circle, ${theme.border}66, transparent)`,
          }}
        />
      )}

      {/* Selected pulse overlay */}
      {isSelected && !isValidMove && (
        <div className="absolute inset-0 animate-pulse bg-yellow-400/10" />
      )}

      {/* Territory capture animation */}
      {recentlyCaptured && owner !== "neutral" && (
        <div
          className="absolute inset-0 z-20 pointer-events-none"
          style={{
            clipPath: HEX_CLIP,
            animation: "hexCapture 0.7s ease-out forwards",
            background: `radial-gradient(circle at center, ${theme.border}44 0%, transparent 70%)`,
          }}
        />
      )}

      {/* Corner accent lines for player-owned tiles */}
      {owner !== "neutral" && (
        <>
          <div
            className="absolute top-[18%] left-[22%] h-[2px] w-[14%] rounded-full opacity-60"
            style={{ backgroundColor: theme.border }}
          />
          <div
            className="absolute top-[18%] right-[22%] h-[2px] w-[14%] rounded-full opacity-60"
            style={{ backgroundColor: theme.border }}
          />
          <div
            className="absolute bottom-[18%] left-[22%] h-[2px] w-[14%] rounded-full opacity-60"
            style={{ backgroundColor: theme.border }}
          />
          <div
            className="absolute bottom-[18%] right-[22%] h-[2px] w-[14%] rounded-full opacity-60"
            style={{ backgroundColor: theme.border }}
          />
        </>
      )}

      {/* ── Power Node icon ──────────────────────────────────────────── */}
      {isPowerNode && !unitOwner && (
        <div
          className="absolute z-20 pointer-events-none flex items-center justify-center"
          style={{
            width: "100%",
            height: "100%",
            filter: "drop-shadow(0 0 6px rgba(168,85,247,0.8)) drop-shadow(0 0 3px rgba(168,85,247,0.5))",
          }}
        >
          <span className="text-lg sm:text-xl md:text-2xl animate-pulse">⚡</span>
        </div>
      )}

      {/* ── Unit icon (HEX DUEL) ────────────────────────────────────── */}
      {unitTheme && (
        <div
          className={`absolute z-20 transition-all duration-300 ease-out ${pushedHere ? "animate-[hexPushArrive_0.5s_ease-out]" : ""}`}
          style={{
            width: "50%",
            height: "50%",
            filter: `drop-shadow(0 0 8px ${unitTheme.glow}) drop-shadow(0 0 3px ${unitTheme.glow})`,
            transition: "filter 0.4s ease, transform 0.3s ease",
          }}
        >
          {/* Outer ring */}
          <div
            className="absolute inset-0 rounded-full"
            style={{
              border: `2.5px solid ${unitTheme.ring}`,
              boxShadow: `0 0 14px ${unitTheme.glow}, inset 0 0 8px ${unitTheme.glow}`,
              transition: "box-shadow 0.4s ease, border-color 0.4s ease",
            }}
          />
          {/* Inner fill */}
          <div
            className="absolute inset-[22%] rounded-full"
            style={{
              background: `radial-gradient(circle at 40% 35%, ${unitTheme.ring}88, ${unitTheme.fill})`,
              boxShadow: `0 0 10px ${unitTheme.glow}`,
              transition: "box-shadow 0.4s ease, background 0.4s ease",
            }}
          />
          {/* Center highlight dot */}
          <div
            className="absolute inset-[38%] rounded-full bg-white/80"
            style={{
              boxShadow: `0 0 4px white`,
              transition: "box-shadow 0.4s ease",
            }}
          />
        </div>
      )}

      {/* ── Stat content (hidden when a unit is present) ────────────────── */}
      {!unitOwner && (
        <span
          className={`relative z-10 flex flex-col items-center justify-center gap-[1px] sm:gap-0.5 ${theme.text}`}
        >
          {capital && (
            <span className="text-[7px] sm:text-[8px] md:text-[10px] font-black tracking-[0.12em] text-yellow-400 leading-none mb-0.5">
              ★ CAP
            </span>
          )}
          <span
            className="text-lg sm:text-xl md:text-2xl font-black leading-none"
            style={{ textShadow: theme.troopsShadow }}
          >
            {troops}
          </span>
          <span
            className={`text-[8px] sm:text-[9px] md:text-[10px] font-bold leading-none mt-0.5 rounded-sm px-1.5 py-0.5
              ${shield > 0 ? "bg-black/30 text-white/90" : "text-white/20"}`}
          >
            {shield > 0 ? `🛡${shield}` : "—"}
          </span>
        </span>
      )}
    </button>
  );
}
