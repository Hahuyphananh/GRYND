"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { IconStar } from "@tabler/icons-react";
import HexTroopCount from "./HexTroopCount";
import { TROOP_DOT_COLUMNS, troopDotCount } from "../lib/hexBoardGeometry";

export type TileOwner = "neutral" | "player1" | "player2";

export interface HexTileData {
  x: number;
  y: number;
  owner: TileOwner;
  troops: number;
  shield: number;
  capital?: boolean;
  /** Permanent territory level (owned tiles only). */
  level?: number;
  /** Troop ceiling for that level. */
  maxTroops?: number;
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
  /** Whether this tile is the CHOSEN destination of the pending action */
  isChosenTarget?: boolean;
  /** Hide the dot layer while a movement animation owns this tile. */
  dotsMuted?: boolean;
  /**
   * Stable "x,y" identity for this tile, surfaced as `data-tile-key`. Action
   * popups (HexTroopPopup) locate this element to anchor themselves to the
   * tile the player is acting on.
   */
  anchorKey?: string;
  /** Troops this territory pays toward a pending upgrade (neighbour donor). */
  fundingTake?: number;
  /** Troops a pending upgrade borrows for this territory from its neighbours. */
  fundingReceives?: number;
}

/**
 * How each upgrade level is DRAWN, so two tiles of the same owner at different
 * levels are never mistaken for each other:
 *
 *   L1 — no walls (the base tile, unchanged)
 *   L2 — one thin violet wall line
 *   L3 — a thicker indigo wall with merlons and corner towers
 *   L4 — a heavy gold wall with merlons and towers
 *
 * Colour, weight and shape all change with the level (not colour alone), the
 * level badge still prints L2/L3/L4, and everything here is decorative and
 * aria-hidden — the tile's own text already states the level and ceiling.
 */
const LEVEL_WALLS: Record<
  number,
  { color: string; inset: number; thickness: number; merlons: boolean; towers: boolean }
> = {
  // Whole-pixel weights: browsers snap fractional borders, so 1.5/2/2.5 drew
  // levels 3 and 4 identically heavy on a 1× display. 1/2/3 stay distinct at
  // every device pixel ratio.
  2: { color: "#a78bfa", inset: 8, thickness: 1, merlons: false, towers: false },
  3: { color: "#818cf8", inset: 7, thickness: 2, merlons: true, towers: true },
  4: { color: "#facc15", inset: 6, thickness: 3, merlons: true, towers: true },
};

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
  isAttackTarget, isSourceTile, isDisplaceTarget, isChosenTarget, dotsMuted, anchorKey,
  fundingTake, fundingReceives,
}: HexTileProps) {
  const { owner, troops, capital, level, maxTroops } = tile;
  const border = cellBorders[owner];
  const [ripple, setRipple] = useState<{ x: number; y: number; id: number } | null>(null);
  const rippleId = useRef(0);

  // The fortification is ERECTED when a territory is upgraded (level goes up),
  // not when a tile is first drawn: loading a board that already has level 3
  // tiles, or a capture that resets a tile to level 1, must not play the build.
  // Short, decorative, and collapses to its end state under reduced motion.
  const [wallJustBuilt, setWallJustBuilt] = useState(false);
  const previousLevel = useRef<number | null>(null);

  useEffect(() => {
    const current = typeof level === "number" ? level : null;
    const before = previousLevel.current;
    previousLevel.current = current;
    if (before === null || current === null || current <= before) return;
    setWallJustBuilt(true);
    const timer = window.setTimeout(() => setWallJustBuilt(false), 700);
    return () => window.clearTimeout(timer);
  }, [level]);

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
  // Level 1 draws nothing: an un-upgraded tile stays exactly as it was.
  const wall =
    isOwned && typeof level === "number" ? LEVEL_WALLS[level] ?? null : null;
  // One dot per troop (up to 100). Neutral territories never show an army.
  const troopDots = isOwned ? troopDotCount(troops) : 0;
  const dotColor = owner === "player2" ? "#ef4444" : "#22d3ee";
  const DOT_SIZE = "clamp(2px, 0.5vw, 3.5px)";
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
        cursor-pointer outline-hidden
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

      {/* ── Fortification walls — one visual step per upgrade ───────────
          Drawn above the tile's own borders and below the troop dots and
          counter (z-[4]), so it never hides the number. Purely decorative:
          aria-hidden, pointer-events-none, and it changes no layout. */}
      {wall && (
        <span
          aria-hidden="true"
          data-hex-level-walls={level}
          data-hex-wall-built={wallJustBuilt ? level : undefined}
          className={`pointer-events-none absolute inset-0 z-[4] rounded-lg ${
            wallJustBuilt ? "hex-wall-build" : ""
          }`}
        >
          {/* The wall line itself — its thickness and colour are the level. */}
          <span
            className="absolute rounded-md"
            style={{
              inset: wall.inset,
              border: `${wall.thickness}px solid ${wall.color}`,
              opacity: 0.8,
              boxShadow: `inset 0 0 10px ${wall.color}55, 0 0 6px ${wall.color}33`,
            }}
          />
          {/* Merlons (crenellations) along the top wall. */}
          {wall.merlons && (
            <span
              className="absolute flex justify-between"
              style={{
                left: wall.inset + 3,
                right: wall.inset + 3,
                top: wall.inset - 2.5,
              }}
            >
              {[0, 1, 2].map((merlon) => (
                <span
                  key={merlon}
                  style={{
                    width: 4,
                    height: 4,
                    borderRadius: 1,
                    background: wall.color,
                    opacity: 0.9,
                  }}
                />
              ))}
            </span>
          )}
          {/* Corner towers on the top two levels. */}
          {wall.towers && (
            <>
              {[
                { left: wall.inset - 2, top: wall.inset - 2 },
                { right: wall.inset - 2, top: wall.inset - 2 },
                { left: wall.inset - 2, bottom: wall.inset - 2 },
                { right: wall.inset - 2, bottom: wall.inset - 2 },
              ].map((corner, index) => (
                <span
                  key={index}
                  className="absolute"
                  style={{
                    ...corner,
                    width: 5,
                    height: 5,
                    borderRadius: 1,
                    background: wall.color,
                    boxShadow: `0 0 4px ${wall.color}`,
                  }}
                />
              ))}
            </>
          )}
          {/* One expanding ring, so the new wall reads as an event and not a
              repaint. Gone after 700ms with the build class. */}
          {wallJustBuilt && (
            <span
              aria-hidden="true"
              className="hex-wall-flash absolute inset-0 rounded-md"
              style={{
                border: `1px solid ${wall.color}`,
                boxShadow: `inset 0 0 18px ${wall.color}88, 0 0 14px ${wall.color}66`,
              }}
            />
          )}
        </span>
      )}

      {/* A level shade over the whole tile, so the upgrade reads at a glance
          even where the wall itself is thin. */}
      {wall && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 rounded-lg"
          style={{
            background: `radial-gradient(circle at 50% 45%, ${wall.color}14, transparent 72%)`,
          }}
        />
      )}

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
      {(isDisplaceTarget || isChosenTarget) && (
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

      {/* Troop dots — a compact 10-column formation, one dot per troop,
          drawn behind the numbers so the counter and the level badge stay
          readable. Absolutely positioned, so it never changes tile layout. */}
      {troopDots > 0 && !dotsMuted && (
        <span
          data-hex-troop-dots={troopDots}
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-1 inset-y-1 z-[5] grid content-end justify-center gap-px"
          style={{
            gridTemplateColumns: `repeat(${TROOP_DOT_COLUMNS}, ${DOT_SIZE})`,
            opacity: 0.75,
          }}
        >
          {Array.from({ length: troopDots }, (_, i) => (
            <span
              key={i}
              style={{
                width: DOT_SIZE,
                height: DOT_SIZE,
                borderRadius: "9999px",
                background: dotColor,
                boxShadow: `0 0 2px ${dotColor}`,
              }}
            />
          ))}
        </span>
      )}

      {/* ── Pending upgrade funding ─────────────────────────────────────
          Shown BEFORE confirming: a neighbour that will pay is ringed and
          labelled with what it gives up, and the territory being upgraded
          shows how much it borrows. Painted and pointer-events-none, so it
          can never change a tap target. */}
      {(fundingTake ?? 0) > 0 && (
        <>
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-[3px] z-[6] rounded-md"
            style={{
              border: "1.5px dashed rgba(192,132,252,0.8)",
              boxShadow: "inset 0 0 12px rgba(168,85,247,0.2)",
            }}
          />
          <span
            aria-hidden="true"
            data-hex-upgrade-donor={fundingTake}
            className="pointer-events-none absolute bottom-0.5 left-0.5 z-20 rounded-sm px-1 font-mono font-black leading-tight tabular-nums"
            style={{
              fontSize: "clamp(6px, 0.9vw, 9px)",
              background: "rgba(88,28,135,0.85)",
              color: "#e9d5ff",
              border: "1px solid rgba(192,132,252,0.6)",
            }}
          >
            −{fundingTake}
          </span>
        </>
      )}
      {(fundingReceives ?? 0) > 0 && (
        <span
          aria-hidden="true"
          data-hex-upgrade-receives={fundingReceives}
          className="pointer-events-none absolute bottom-0.5 right-0.5 z-20 rounded-sm px-1 font-mono font-black leading-tight tabular-nums"
          style={{
            fontSize: "clamp(6px, 0.9vw, 9px)",
            background: "rgba(88,28,135,0.85)",
            color: "#e9d5ff",
            border: "1px solid rgba(192,132,252,0.6)",
          }}
        >
          +{fundingReceives}
        </span>
      )}

      {/* Territory level badge — level 1 is the unmarked default so the
          board does not gain noise on tiles that were never upgraded. */}
      {isOwned && typeof level === "number" && level > 1 && (
        <span
          className="absolute right-1 top-1 z-10 rounded-sm px-1 font-black leading-tight"
          style={{
            fontSize: "clamp(6px, 0.9vw, 9px)",
            // Shades with the walls, so the badge and the fortification agree.
            background: `${wall?.color ?? "#a855f7"}33`,
            color: wall?.color ?? "#d8b4fe",
            border: `1px solid ${wall?.color ?? "#a855f7"}77`,
          }}
        >
          L{level}
        </span>
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
            // Keeps the counter legible over the dot formation.
            textShadow: "0 0 6px #020617, 0 0 2px #020617",
          }}
        />
        {isOwned && typeof maxTroops === "number" && (
          <span
            className="font-mono leading-none mt-0.5"
            style={{ fontSize: "clamp(5px, 0.85vw, 8px)", color: "rgba(148,163,184,0.65)" }}
          >
            /{maxTroops}
          </span>
        )}
        {isOwned && !capital && (
          <span
            className="font-bold leading-none mt-0.5 rounded-xs px-0.5"
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
