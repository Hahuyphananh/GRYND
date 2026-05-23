"use client";

import React from "react";
import HexTile, { type HexTileData } from "./HexTile";
import HexParticles from "./HexParticles";

export interface UnitPosition {
  x: number;
  y: number;
  owner: "player1" | "player2";
}

interface HexBoardProps {
  grid: HexTileData[][];
  selectedTile: { x: number; y: number } | null;
  onTileClick: (x: number, y: number) => void;
  disabled?: boolean;
  unitPositions?: UnitPosition[];
  validMoves?: { x: number; y: number }[];
  recentlyCaptured?: string[];
  pushTargetKeys?: string[];
  pushedHere?: string[];
  powerNodeKeys?: string[];
  /** Set of "x,y" keys of tiles captured via territory spread */
  territorySpread?: string[];
}

export default function HexBoard({
  grid,
  selectedTile,
  onTileClick,
  disabled,
  unitPositions,
  validMoves,
  recentlyCaptured,
  pushTargetKeys,
  pushedHere,
  powerNodeKeys,
  territorySpread,
}: HexBoardProps) {
  const [dims, setDims] = React.useState({ width: 90, height: 104 });
  const boardRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    function computeDims() {
      const w = window.innerWidth;
      if (w >= 1920) return { width: 105, height: 121 };
      if (w >= 1440) return { width: 92, height: 106 };
      if (w >= 1024) return { width: 80, height: 92 };
      if (w >= 768) return { width: 74, height: 85 };
      if (w >= 640) return { width: 70, height: 81 };
      if (w >= 400) return { width: 62, height: 72 };
      if (w >= 360) return { width: 52, height: 60 };
      return { width: 44, height: 51 };
    }
    setDims(computeDims());
    const handleResize = () => setDims(computeDims());
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const { width, height } = dims;
  const horizontalOffset = width * 0.5;
  const verticalSpacing = height * 0.75;

  // Compute a viewport-based scale factor for very large or very small screens
  const scaleFactor = React.useMemo(() => {
    if (typeof window === "undefined") return 1;
    const w = window.innerWidth;
    // On very large screens (>1600px), scale up slightly
    if (w >= 1800) return 1.12;
    if (w >= 1600) return 1.06;
    // On very small screens (<420px), scale down
    if (w >= 380) return 0.92;
    if (w >= 340) return 0.82;
    if (w < 340) return 0.72;
    return 1;
  }, [dims]);

  const validMoveSet = React.useMemo(
    () => new Set(validMoves?.map((m) => `${m.x},${m.y}`) ?? []),
    [validMoves]
  );

  const capturedSet = React.useMemo(
    () => new Set(recentlyCaptured ?? []),
    [recentlyCaptured]
  );

  const pushTargetSet = React.useMemo(
    () => new Set(pushTargetKeys ?? []),
    [pushTargetKeys]
  );

  const pushedHereSet = React.useMemo(
    () => new Set(pushedHere ?? []),
    [pushedHere]
  );

  const powerNodeSet = React.useMemo(
    () => new Set(powerNodeKeys ?? []),
    [powerNodeKeys]
  );

  const territorySpreadSet = React.useMemo(
    () => new Set(territorySpread ?? []),
    [territorySpread]
  );

  return (
    <div
      ref={boardRef}
      className={`flex flex-col items-center justify-center select-none transition-all duration-500 ${disabled ? "opacity-40 pointer-events-none" : ""}`}
      style={{
        transform: `scale(${scaleFactor})`,
        transformOrigin: "center center",
        transition: "transform 0.4s ease, opacity 0.4s ease",
        willChange: "transform",
      }}
    >
      {/* ── BEEHIVE BOARD ──────────────────────────────────────────────── */}
      <div
        className="relative inline-block rounded-3xl p-2 sm:p-3
          border border-white/[0.06]
          bg-[#050a18]
          shadow-[0_0_80px_rgba(34,211,238,0.04),inset_0_0_60px_rgba(34,211,238,0.02)]
          transition-all duration-500
        "
        style={{ boxShadow: "0 0 0 1px rgba(255,255,255,0.03), 0 0 60px rgba(34,211,238,0.04)" }}
      >
        {/* Honeycomb grid background pattern */}
        <svg
          className="absolute inset-0 w-full h-full pointer-events-none z-0 opacity-[0.03]"
          viewBox="0 0 200 200"
          preserveAspectRatio="none"
        >
          <defs>
            <pattern id="honeycomb" patternUnits="userSpaceOnUse" width="40" height="69.28">
              <path
                d="M40 17.32L30 0L10 0L0 17.32L10 34.64L30 34.64Z"
                fill="none"
                stroke="rgba(34,211,238,0.5)"
                strokeWidth="0.5"
              />
              <path
                d="M40 51.96L30 34.64L10 34.64L0 51.96L10 69.28L30 69.28Z"
                fill="none"
                stroke="rgba(34,211,238,0.5)"
                strokeWidth="0.5"
              />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#honeycomb)" />
        </svg>

        {/* Floating energy particles */}
        <HexParticles />

        {/* Hexagonal grid scanline overlay */}
        <div
          className="pointer-events-none absolute inset-0 rounded-3xl opacity-[0.03]"
          style={{
            backgroundImage:
              "repeating-linear-gradient(0deg, transparent, transparent 1px, rgba(34,211,238,0.3) 1px, rgba(34,211,238,0.3) 2px)",
          }}
        />

        {/* Grid container — sets CSS vars for tile sizing */}
        <div
          className="relative inline-flex flex-col items-start w-fit z-10"
          style={{
            ["--tile-w" as string]: `${width}px`,
            ["--tile-h" as string]: `${height}px`,
          }}
        >
          {grid.map((row, rowIndex) => (
            <div
              key={rowIndex}
              className="flex"
              style={{
                marginLeft: rowIndex % 2 === 1 ? `${horizontalOffset}px` : "0px",
                marginTop: rowIndex === 0 ? "0px" : `-${height - verticalSpacing}px`,
              }}
            >
              {row.map((tile) => {
                const unitOnTile = unitPositions?.find(
                  (u) => u.x === tile.x && u.y === tile.y
                );

                return (
                  <HexTile
                    key={`${tile.x}-${tile.y}`}
                    tile={tile}
                    isSelected={
                      selectedTile?.x === tile.x && selectedTile?.y === tile.y
                    }
                    onClick={() => !disabled && onTileClick(tile.x, tile.y)}
                    unitOwner={unitOnTile?.owner}
                    isValidMove={validMoveSet.has(`${tile.x},${tile.y}`)}
                    isPushTarget={pushTargetSet.has(`${tile.x},${tile.y}`)}
                    recentlyCaptured={capturedSet.has(`${tile.x},${tile.y}`)}
                    pushedHere={pushedHereSet.has(`${tile.x},${tile.y}`)}
                    isPowerNode={powerNodeSet.has(`${tile.x},${tile.y}`)}
                    isTerritorySpread={territorySpreadSet.has(`${tile.x},${tile.y}`)}
                  />
                );
              })}
            </div>
          ))}
        </div>

        {/* Corner decorative elements */}
        <div className="absolute top-0 left-0 w-5 h-5 sm:w-7 sm:h-7 border-t border-l border-cyan-400/20 rounded-tl-xl" />
        <div className="absolute top-0 right-0 w-5 h-5 sm:w-7 sm:h-7 border-t border-r border-cyan-400/20 rounded-tr-xl" />
        <div className="absolute bottom-0 left-0 w-5 h-5 sm:w-7 sm:h-7 border-b border-l border-cyan-400/20 rounded-bl-xl" />
        <div className="absolute bottom-0 right-0 w-5 h-5 sm:w-7 sm:h-7 border-b border-r border-cyan-400/20 rounded-br-xl" />
      </div>

      {/* Legend */}
      <div className="mt-4 flex items-center gap-4 text-[10px] sm:text-[11px] text-slate-500 flex-wrap justify-center">
        <span className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-sm bg-cyan-400/60 shadow-[0_0_6px_rgba(34,211,238,0.3)]" />
          P1
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-sm bg-red-400/60 shadow-[0_0_6px_rgba(239,68,68,0.3)]" />
          P2
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-sm bg-slate-700/40 border border-slate-600/30" />
          Empty
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-sm bg-purple-500/60 shadow-[0_0_8px_rgba(168,85,247,0.4)]" />
          ⚡ Node
        </span>
      </div>
    </div>
  );
}
