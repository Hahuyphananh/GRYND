"use client";

import { useRef, useState, useCallback } from "react";
import { IconStar } from "@tabler/icons-react";
import HexTroopCount from "./HexTroopCount";

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
  /** Whether this tile is a valid move target */
  isValidMove?: boolean;
  /** Whether this tile is a push target (enemy hex that can be pushed) */
  isPushTarget?: boolean;
  /** Whether this tile was just captured (triggers glow pulse animation) */
  recentlyCaptured?: boolean;
  /** Whether this tile was captured via territory spread */
  isTerritorySpread?: boolean;
  /** Whether this tile is a valid reinforce target (friendly tile) */
  isReinforceTarget?: boolean;
  /** Whether this tile is an enemy tile that can be attacked (attackable target highlight) */
  isAttackTarget?: boolean;
  /** Whether this tile is a friendly source tile for attack/displace */
  isSourceTile?: boolean;
  /** Whether this tile is the CHOSEN displace target (the tile receiving troops) */
  isDisplaceTarget?: boolean;
  /**
   * Stable "x,y" identity for this tile, surfaced as `data-tile-key`. Action
   * popups (HexTroopPopup) locate this element to anchor themselves to the
   * tile the player is acting on.
   */
  anchorKey?: string;
}

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

export default function HexTile({
  tile, isSelected, onClick, isValidMove, isPushTarget,
  recentlyCaptured, isTerritorySpread, isReinforceTarget,
  isAttackTarget, isSourceTile, isDisplaceTarget, anchorKey
}: HexTileProps) {
  const { owner, troops, capital } = tile;
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

  const isOwned = owner === "player1" || owner === "player2";
  const troopColor = owner === "player1" ? "#22d3ee" : owner === "player2" ? "#ef4444" : "rgba(148,163,184,0.5)";
  const troopShadow = isOwned ? `0 0 8px ${owner === "player1" ? "rgba(34,211,238,0.5)" : "rgba(239,68,68,0.5)"}` : "none";

  return (
    <button
      onClick={handleClick}
      data-tile-key={anchorKey}
      className={`
        group relative
        flex items-center justify-center
        hover:z-20
        active:scale-[0.93]
        ${isSelected ? "scale-105 z-10" : ""}
        cursor-pointer outline-none
        rounded-lg
        select-none
      `}
      style={{
        width: "var(--tile-w, 65px)",
        height: "var(--tile-h, 75px)",
        transition: "transform 0.25s cubic-bezier(0.34, 1.56, 0.64, 1), filter 0.35s ease",
      }}
    >
      {/* ── CELL BACKGROUND ───────────────────────────────────────── */}

      {/* Dark cell background */}
      <div
        className="absolute inset-0 rounded-lg transition-all duration-500 ease-out group-hover:brightness-125 group-hover:scale-[1.04]"
        style={{
          background: border.bg,
        }}
      />

      {/* Outer border */}
      <div
        className="absolute inset-[2px] rounded-lg transition-all duration-500 ease-out group-hover:border-[2.5px]"
        style={{
          border: `1.5px solid ${border.inner}`,
          boxShadow: `inset 0 0 8px ${border.inner}22, ${border.glow}`,
          transition: "border-color 0.4s ease, box-shadow 0.4s ease, border-width 0.3s ease",
        }}
      />

      {/* Hover glow overlay */}
      <div
        className="absolute inset-0 rounded-lg opacity-0 group-hover:opacity-100 transition-all duration-500 ease-out pointer-events-none"
        style={{
          background: `radial-gradient(circle at 50% 50%, ${owner === "neutral" ? "rgba(148,163,184,0.06)" : border.inner}22 0%, transparent 70%)`,
        }}
      />

      {/* Secondary inner border for depth */}
      <div
        className="absolute inset-[6px] rounded-md"
        style={{
          border: `0.5px solid ${border.outer}`,
          transition: "border-color 0.4s ease, opacity 0.4s ease",
        }}
      />

      {/* Valid move glow (yellow) */}
      {isValidMove && (
        <div
          className="absolute inset-[2px] rounded-lg group-hover:animate-[validPulse_1.2s_ease-in-out_infinite]"
          style={{
            border: "2px solid rgba(250,204,21,0.6)",
            boxShadow: "inset 0 0 20px rgba(250,204,21,0.15), 0 0 15px rgba(250,204,21,0.2)",
            background: "rgba(250,204,21,0.06)",
            animation: "validPulse 1.8s ease-in-out infinite",
          }}
        />
      )}

      {/* Push target (orange) — also used for attack targets */}
      {(isPushTarget || isAttackTarget) && (
        <div
          className="absolute inset-[2px] rounded-lg"
          style={{
            border: "2px solid rgba(249,115,22,0.5)",
            boxShadow: "inset 0 0 20px rgba(249,115,22,0.15), 0 0 12px rgba(249,115,22,0.15)",
            background: "rgba(249,115,22,0.08)",
            animation: "pushPulse 1.2s ease-in-out infinite",
          }}
        />
      )}

      {/* Reinforce target highlight (green) — also used for source tiles */}
      {(isReinforceTarget || isSourceTile) && (
        <div
          className="absolute inset-[2px] rounded-lg"
          style={{
            border: "2px solid rgba(74,222,128,0.5)",
            boxShadow: "inset 0 0 20px rgba(74,222,128,0.15), 0 0 12px rgba(74,222,128,0.15)",
            background: "rgba(74,222,128,0.08)",
            animation: "validPulse 1.8s ease-in-out infinite",
          }}
        />
      )}

      {/* Chosen displace target (yellow) — the friendly tile receiving
          troops. Rendered after the green source ring so it wins when both
          apply, and after the orange candidate ring on Displace. */}
      {isDisplaceTarget && (
        <div
          className="absolute inset-[2px] rounded-lg"
          style={{
            border: "2px solid rgba(250,204,21,0.8)",
            boxShadow: "inset 0 0 24px rgba(250,204,21,0.2), 0 0 18px rgba(250,204,21,0.35)",
            background: "rgba(250,204,21,0.1)",
            animation: "validPulse 1.2s ease-in-out infinite",
          }}
        />
      )}

      {/* Selected tile highlight ring */}
      {isSelected && (
        <div
          className="absolute inset-[2px] rounded-lg"
          style={{
            border: `2px solid ${owner === "player1" ? "rgba(34,211,238,0.9)" : "rgba(239,68,68,0.9)"}`,
            boxShadow: `inset 0 0 25px ${owner === "player1" ? "rgba(34,211,238,0.2)" : "rgba(239,68,68,0.2)"}`,
          }}
        />
      )}

      {/* Territory capture spark animation */}
      {recentlyCaptured && owner !== "neutral" && (
        <div
          className="absolute inset-0 z-20 pointer-events-none rounded-lg"
          style={{
            animation: "hexCapture 0.7s ease-out forwards",
            background: `radial-gradient(circle at center, ${cellBorders[owner].inner}55 0%, transparent 70%)`,
          }}
        />
      )}

      {/* Territory spread fill animation */}
      {isTerritorySpread && (
        <div
          className="absolute inset-0 z-20 pointer-events-none rounded-lg"
          style={{
            animation: "hexCapture 0.5s ease-out forwards",
            background: `radial-gradient(circle at center, rgba(250,204,21,0.15) 0%, transparent 60%)`,
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

      {/* ── Tile content: troop count + capital indicator ────────── */}
      <span className="relative z-10 flex flex-col items-center justify-center gap-0">
        {capital && (
          <span
            className="font-black tracking-[0.12em] text-yellow-400 leading-none mb-0.5"
            style={{ fontSize: "clamp(5px, 1vw, 9px)" }}
          >
            <IconStar size={10} className="inline text-yellow-400" /> CAP
          </span>
        )}
        {/* Rolls UP when troops arrive on this tile and DOWN when they are
            spent or lost (see HexTroopCount) — the count is the move's
            result, so it should read as a change, not as a static digit. */}
        <HexTroopCount
          value={troops}
          color={troopColor}
          glow={troopShadow}
          className="font-black leading-none"
          style={{
            fontSize: "clamp(16px, 3vw, 32px)",
            color: troopColor,
          }}
        />
        {isOwned && !capital && (
          <span
            className="font-bold leading-none mt-0.5 rounded-sm px-0.5"
            style={{
              fontSize: "clamp(5px, 0.9vw, 9px)",
              color: owner === "player1" ? "rgba(34,211,238,0.5)" : "rgba(239,68,68,0.5)",
            }}
          >
            ●
          </span>
        )}
      </span>
    </button>
  );
}
