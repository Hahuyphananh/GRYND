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
  /** Positions of player units to render on the board */
  unitPositions?: UnitPosition[];
  /** Set of coordinates that are valid move targets */
  validMoves?: { x: number; y: number }[];
  /** Set of "x,y" keys for tiles captured this turn (triggers animation) */
  recentlyCaptured?: string[];
  /** Set of "x,y" keys of push target enemy hexes (orange highlight) */
  pushTargetKeys?: string[];
  /** Set of "x,y" keys where a unit just arrived via push (bounce animation) */
  pushedHere?: string[];
  /** Set of "x,y" keys of power node tiles (purple glow) */
  powerNodeKeys?: string[];
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
}: HexBoardProps) {
  const [dims, setDims] = React.useState({ width: 90, height: 104 });

  React.useEffect(() => {
    function computeDims() {
      const w = window.innerWidth;
      if (w >= 1024) return { width: 82, height: 94 };
      if (w >= 768) return { width: 76, height: 88 };
      if (w >= 640) return { width: 78, height: 90 };
      if (w >= 400) return { width: 70, height: 81 };
      return { width: 60, height: 70 };
    }
    setDims(computeDims());
    const handleResize = () => setDims(computeDims());
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const { width, height } = dims;
  // Proper hex geometry
const horizontalOffset = width * 0.5;
const verticalSpacing = height * 0.75;

  // Build a lookup set for valid moves
  const validMoveSet = React.useMemo(
    () => new Set(validMoves?.map((m) => `${m.x},${m.y}`) ?? []),
    [validMoves]
  );

  // Build a lookup set for recently captured tiles
  const capturedSet = React.useMemo(
    () => new Set(recentlyCaptured ?? []),
    [recentlyCaptured]
  );

  // Build lookup sets for push mechanics
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

  return (
    <div
      className={`flex flex-col items-center justify-center select-none transition-all duration-500 ${disabled ? "opacity-50 pointer-events-none" : ""}`}
      style={{
  transform: `
    scale(
      clamp(
        0.72,
        ${grid.length > 7 ? "0.82" : "1"},
        1
      )
    )
  `,
  transition: "transform 0.4s ease",
}}
    >
      {/* Board background glow */}
      <div
        className="relative inline-block rounded-2xl p-1 sm:p-1.5 md:p-2
        border border-cyan-400/20
        bg-gradient-to-b from-[#05102a]/80 via-[#061538]/80 to-[#030b1f]/80
        shadow-[0_0_60px_rgba(34,211,238,0.08),inset_0_0_30px_rgba(34,211,238,0.04)]
        transition-all duration-500
      "
      >
        {/* Floating energy particles */}
        <HexParticles />

        {/* Scanline overlay */}
        <div
          className="pointer-events-none absolute inset-0 rounded-2xl opacity-[0.04]"
          style={{
            backgroundImage:
              "repeating-linear-gradient(0deg, transparent, transparent 1px, rgba(34,211,238,0.5) 1px, rgba(34,211,238,0.5) 2px)",
          }}
        />

        {/* Grid container */}
        <div className="relative inline-flex flex-col items-start w-fit">
          {grid.map((row, rowIndex) => (
           <div
  key={rowIndex}
  className="flex"
  style={{
    marginLeft:
      rowIndex % 2 === 1
        ? `${horizontalOffset}px`
        : "0px",

    marginTop:
      rowIndex === 0
        ? "0px"
        : `-${height - verticalSpacing}px`,
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
                  />
                );
              })}
            </div>
          ))}
        </div>

        {/* Corner decorative elements - animated */}
        <div className="absolute top-0 left-0 w-4 h-4 sm:w-6 sm:h-6 border-t border-l border-cyan-400/40 rounded-tl-lg animate-[cornerPulse_3s_ease-in-out_infinite]" />
        <div className="absolute top-0 right-0 w-4 h-4 sm:w-6 sm:h-6 border-t border-r border-cyan-400/40 rounded-tr-lg animate-[cornerPulse_3s_ease-in-out_0.75s_infinite]" />
        <div className="absolute bottom-0 left-0 w-4 h-4 sm:w-6 sm:h-6 border-b border-l border-cyan-400/40 rounded-bl-lg animate-[cornerPulse_3s_ease-in-out_1.5s_infinite]" />
        <div className="absolute bottom-0 right-0 w-4 h-4 sm:w-6 sm:h-6 border-b border-r border-cyan-400/40 rounded-br-lg animate-[cornerPulse_3s_ease-in-out_2.25s_infinite]" />
      </div>

      {/* Legend */}
      <div className="mt-4 flex items-center gap-5 text-[11px] sm:text-xs text-slate-400">
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded-sm bg-cyan-500/50 shadow-[0_0_6px_rgba(34,211,238,0.5)]" />
          Player 1
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded-sm bg-red-500/50 shadow-[0_0_6px_rgba(239,68,68,0.5)]" />
          Player 2
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded-sm bg-slate-700/50" />
          Neutral
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded-sm bg-purple-500/60 shadow-[0_0_8px_rgba(168,85,247,0.6)]" />
          Node
        </span>
      </div>
    </div>
  );
}
