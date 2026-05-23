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
  /** Whether this tile was captured via territory spread (hex.io fill) */
  isTerritorySpread?: boolean;
}

const HEX_CLIP = "polygon(25% 0%, 75% 0%, 100% 50%, 75% 100%, 25% 100%, 0% 50%)";

const cellBorders: Record<TileOwner, { inner: string; outer: string; glow: string; bg: string }> = {
  player1: {
    inner: "rgba(34,211,238,0.7)",
    outer: "rgba(34,211,238,0.15)",
    glow: "0 0 12px rgba(34,211,238,0.25)",
    bg: "linear-gradient(135deg, rgba(34,211,238,0.25) 0%, rgba(6,182,212,0.12) 50%, rgba(14,165,233,0.08) 100%)",
  },
  player2: {
    inner: "rgba(239,68,68,0.7)",
    outer: "rgba(239,68,68,0.15)",
    glow: "0 0 12px rgba(239,68,68,0.25)",
    bg: "linear-gradient(135deg, rgba(239,68,68,0.25) 0%, rgba(220,38,38,0.12) 50%, rgba(225,29,72,0.08) 100%)",
  },
  neutral: {
    inner: "rgba(100,116,139,0.25)",
    outer: "rgba(100,116,139,0.06)",
    glow: "none",
    bg: "transparent",
  },
};

const unitColors: Record<"player1" | "player2", { ring: string; fill: string; glow: string }> = {
  player1: { ring: "#22d3ee", fill: "#06b6d4", glow: "rgba(34,211,238,0.8)" },
  player2: { ring: "#ef4444", fill: "#dc2626", glow: "rgba(239,68,68,0.8)" },
};

export default function HexTile({
  tile, isSelected, onClick, unitOwner, isValidMove, isPushTarget,
  recentlyCaptured, pushedHere, isPowerNode, isTerritorySpread
}: HexTileProps) {
  const { owner, troops, shield, capital } = tile;
  const border = cellBorders[owner];
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

  const unitTheme = unitOwner ? unitColors[unitOwner] : null;

  return (
    <button
      onClick={handleClick}
      className={`
        group relative
        flex items-center justify-center
        transition-all duration-200 ease-out
        hover:z-20
        active:scale-95
        ${isSelected ? "scale-105 z-10" : "hover:scale-105"}
        cursor-pointer outline-none
      `}
      style={{
        clipPath: HEX_CLIP,
        width: "var(--tile-w, 65px)",
        height: "var(--tile-h, 75px)",
        transition: "transform 0.2s ease, filter 0.3s ease",
      }}
    >
      {/* ── HONEYCOMB CELL WALLS (Hex.io beehive aesthetic) ────────── */}

      {/* Dark cell background */}
      <div
        className="absolute inset-0"
        style={{
          clipPath: HEX_CLIP,
          background: border.bg,
          transition: "background 0.4s ease",
        }}
      />

      {/* Outer hexagon border (cell wall) */}
      <div
        className="absolute inset-[2px]"
        style={{
          clipPath: HEX_CLIP,
          border: `1.5px solid ${border.inner}`,
          boxShadow: `inset 0 0 8px ${border.inner}22, ${border.glow}`,
          transition: "border-color 0.4s ease, box-shadow 0.4s ease",
        }}
      />

      {/* Secondary inner border for honeycomb depth */}
      <div
        className="absolute inset-[6px]"
        style={{
          clipPath: HEX_CLIP,
          border: `0.5px solid ${border.outer}`,
          transition: "border-color 0.4s ease",
        }}
      />

      {/* Valid move glow (yellow hex.io hover effect) */}
      {isValidMove && (
        <div
          className="absolute inset-[2px] animate-pulse"
          style={{
            clipPath: HEX_CLIP,
            border: "2px solid rgba(250,204,21,0.6)",
            boxShadow: "inset 0 0 20px rgba(250,204,21,0.15), 0 0 15px rgba(250,204,21,0.2)",
            background: "rgba(250,204,21,0.06)",
          }}
        />
      )}

      {/* Push target (orange) */}
      {isPushTarget && (
        <div
          className="absolute inset-[2px] animate-pulse"
          style={{
            clipPath: HEX_CLIP,
            border: "2px solid rgba(249,115,22,0.5)",
            boxShadow: "inset 0 0 20px rgba(249,115,22,0.15)",
            background: "rgba(249,115,22,0.08)",
          }}
        />
      )}

      {/* Power node pulsing aura (purple) */}
      {isPowerNode && !unitOwner && (
        <div
          className="absolute inset-[2px]"
          style={{
            clipPath: HEX_CLIP,
            border: "1.5px solid rgba(168,85,247,0.6)",
            boxShadow: "inset 0 0 25px rgba(168,85,247,0.2), 0 0 20px rgba(168,85,247,0.15)",
            background: "rgba(168,85,247,0.06)",
            animation: "hexAuraPulse 2.5s ease-in-out infinite",
          }}
        />
      )}

      {/* Selected unit highlight ring */}
      {isSelected && (
        <div
          className="absolute inset-[2px]"
          style={{
            clipPath: HEX_CLIP,
            border: `2px solid ${owner === "player1" ? "rgba(34,211,238,0.9)" : "rgba(239,68,68,0.9)"}`,
            boxShadow: `inset 0 0 25px ${owner === "player1" ? "rgba(34,211,238,0.2)" : "rgba(239,68,68,0.2)"}`,
          }}
        />
      )}

      {/* Territory capture spark animation */}
      {recentlyCaptured && owner !== "neutral" && (
        <div
          className="absolute inset-0 z-20 pointer-events-none"
          style={{
            clipPath: HEX_CLIP,
            animation: "hexCapture 0.7s ease-out forwards",
            background: `radial-gradient(circle at center, ${cellBorders[owner].inner}55 0%, transparent 70%)`,
          }}
        />
      )}

      {/* Territory spread fill animation */}
      {isTerritorySpread && (
        <div
          className="absolute inset-0 z-20 pointer-events-none"
          style={{
            clipPath: HEX_CLIP,
            animation: "hexCapture 0.5s ease-out forwards",
            background: `radial-gradient(circle at center, rgba(250,204,21,0.15) 0%, transparent 60%)`,
          }}
        />
      )}

      {/* Push arrival bounce */}
      {pushedHere && unitTheme && (
        <div
          className="absolute inset-0 z-20 pointer-events-none"
          style={{
            clipPath: HEX_CLIP,
            animation: "hexPushArrive 0.4s ease-out",
            background: `radial-gradient(circle at center, ${unitTheme.glow}33 0%, transparent 60%)`,
          }}
        />
      )}

      {/* Click ripple */}
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
            background: `radial-gradient(circle, ${owner === "neutral" ? "rgba(148,163,184,0.4)" : cellBorders[owner].inner}66, transparent)`,
          }}
        />
      )}

      {/* ── Unit icon (orb with glow, hex.io style) ──────────────────── */}
      {unitTheme && (
        <div
          className="absolute z-20 transition-all duration-300 ease-out"
          style={{
            width: "48%",
            height: "48%",
            filter: `drop-shadow(0 0 10px ${unitTheme.glow}) drop-shadow(0 0 4px ${unitTheme.glow})`,
            animation: isSelected ? "hexAuraPulse 1.5s ease-in-out infinite" : "none",
          }}
        >
          {/* Outer ring */}
          <div
            className="absolute inset-0 rounded-full"
            style={{
              border: `2.5px solid ${unitTheme.ring}`,
              boxShadow: `0 0 16px ${unitTheme.glow}, inset 0 0 10px ${unitTheme.glow}`,
            }}
          />
          {/* Inner fill */}
          <div
            className="absolute inset-[22%] rounded-full"
            style={{
              background: `radial-gradient(circle at 40% 35%, ${unitTheme.ring}aa, ${unitTheme.fill})`,
              boxShadow: `0 0 12px ${unitTheme.glow}`,
            }}
          />
          {/* Center dot */}
          <div
            className="absolute inset-[38%] rounded-full bg-white/80"
            style={{ boxShadow: "0 0 4px white" }}
          />
        </div>
      )}

      {/* ── Power Node icon ──────────────────────────────────────────── */}
      {isPowerNode && !unitOwner && (
        <div
          className="absolute z-20 pointer-events-none flex items-center justify-center"
          style={{
            width: "100%",
            height: "100%",
            filter: "drop-shadow(0 0 8px rgba(168,85,247,0.8)) drop-shadow(0 0 3px rgba(168,85,247,0.5))",
          }}
        >
          <span className="animate-pulse" style={{ fontSize: "clamp(12px, 2.2vw, 24px)" }}>⚡</span>
        </div>
      )}

      {/* ── Stat content (hidden when a unit is present) ──────────────── */}
      {!unitOwner && (
        <span className="relative z-10 flex flex-col items-center justify-center gap-0">
          {capital && (
            <span className="font-black tracking-[0.12em] text-yellow-400 leading-none mb-0.5"
              style={{ fontSize: "clamp(5px, 1vw, 9px)" }}>
              ★ CAP
            </span>
          )}
          <span
            className="font-black leading-none"
            style={{
              fontSize: "clamp(12px, 2.2vw, 24px)",
              color: owner !== "neutral" ? (owner === "player1" ? "#22d3ee" : "#ef4444") : "rgba(148,163,184,0.5)",
              textShadow: owner !== "neutral" ? `0 0 8px ${owner === "player1" ? "rgba(34,211,238,0.5)" : "rgba(239,68,68,0.5)"}` : "none",
            }}
          >
            {troops}
          </span>
          <span
            className={`font-bold leading-none mt-0.5 rounded-sm px-1 py-0.5
              ${shield > 0 ? "bg-black/30 text-white/80" : "text-white/15"}`}
            style={{ fontSize: "clamp(5px, 0.9vw, 9px)" }}
          >
            {shield > 0 ? `🛡${shield}` : "—"}
          </span>
        </span>
      )}
    </button>
  );
}
