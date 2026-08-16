"use client";

import React from "react";
import { IconStar } from "@tabler/icons-react";
import HexTile, { type HexTileData } from "./HexTile";
import HexParticles from "./HexParticles";

interface HexBoardProps {
  grid: HexTileData[][];
  selectedTile: { x: number; y: number } | null;
  onTileClick: (x: number, y: number) => void;
  disabled?: boolean;
  validMoves?: { x: number; y: number }[];
  recentlyCaptured?: string[];
  pushTargetKeys?: string[];
  /** Set of "x,y" keys of tiles captured via territory spread */
  territorySpread?: string[];
  /** Set of "x,y" keys of tiles that can be reinforced (friendly tiles) */
  reinforceTargetKeys?: string[];
  /** Set of "x,y" keys of enemy tiles that can be attacked */
  attackHighlightKeys?: string[];
  /** Set of "x,y" keys of friendly source tiles for attack/displace */
  sourceHighlightKeys?: string[];
  /**
   * Optional perspective-aware legend props.
   * When passed, the legend shows perspective-relative labels + colors so the
   * "your side" cell reads as "You" (local color) and the opponent cell as
   * "Opponent" (opponent color) regardless of which engine player the local
   * viewer is. Falls back to absolute P1/P2 labels with cyan/red if omitted.
   */
  localColor?: string;
  opponentColor?: string;
  localLabel?: string;
  opponentLabel?: string;
}

export default function HexBoard({
  grid,
  selectedTile,
  onTileClick,
  disabled,
  validMoves,
  recentlyCaptured,
  pushTargetKeys,
  territorySpread,
  reinforceTargetKeys,
  attackHighlightKeys,
  sourceHighlightKeys,
  localColor,
  opponentColor,
  localLabel,
  opponentLabel,
}: HexBoardProps) {
  const [dims, setDims] = React.useState({ width: 90, height: 90 });
  const boardRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    function computeDims() {
      const w = window.innerWidth;
      if (w >= 1920) return { width: 105, height: 105 };
      if (w >= 1440) return { width: 92, height: 92 };
      if (w >= 1024) return { width: 80, height: 80 };
      if (w >= 768) return { width: 74, height: 74 };
      if (w >= 640) return { width: 70, height: 70 };
      if (w >= 400) return { width: 62, height: 62 };
      if (w >= 360) return { width: 52, height: 52 };
      return { width: 44, height: 44 };
    }
    setDims(computeDims());
    const handleResize = () => setDims(computeDims());
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const { width } = dims;

  // Compute a viewport-based scale factor for very large or very small screens
  const scaleFactor = React.useMemo(() => {
    if (typeof window === "undefined") return 1;
    const w = window.innerWidth;
    if (w >= 1800) return 1.12;
    if (w >= 1600) return 1.06;
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

  const territorySpreadSet = React.useMemo(
    () => new Set(territorySpread ?? []),
    [territorySpread]
  );

  const reinforceTargetSet = React.useMemo(
    () => new Set(reinforceTargetKeys ?? []),
    [reinforceTargetKeys]
  );

  const attackHighlightSet = React.useMemo(
    () => new Set(attackHighlightKeys ?? []),
    [attackHighlightKeys]
  );

  const sourceHighlightSet = React.useMemo(
    () => new Set(sourceHighlightKeys ?? []),
    [sourceHighlightKeys]
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
      {/* ── GRID BOARD ─────────────────────────────────────────────────── */}
      <div
        className="relative inline-block rounded-3xl p-2 sm:p-3
          border border-white/10
          bg-[#050a18]
          shadow-[0_0_80px_rgba(34,211,238,0.04),inset_0_0_60px_rgba(34,211,238,0.02)]
          transition-all duration-700
          hover:shadow-[0_0_100px_rgba(34,211,238,0.07),inset_0_0_60px_rgba(34,211,238,0.02)]
          hover:border-white/15
        "
        style={{ boxShadow: "0 0 0 1px rgba(255,255,255,0.03), 0 0 60px rgba(34,211,238,0.04)" }}
      >
        {/* Subtle grid dot pattern background */}
        <svg
          className="absolute inset-0 w-full h-full pointer-events-none z-0 opacity-[0.04]"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
        >
          <defs>
            <pattern id="grid-dots" patternUnits="userSpaceOnUse" width="20" height="20">
              <circle cx="10" cy="10" r="0.8" fill="rgba(34,211,238,0.6)" />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#grid-dots)" />
        </svg>

        {/* Diagonal crosshatch accent lines */}
        <svg
          className="absolute inset-0 w-full h-full pointer-events-none z-0 opacity-[0.015]"
          viewBox="0 0 200 200"
          preserveAspectRatio="none"
        >
          <defs>
            <pattern id="grid-cross" patternUnits="userSpaceOnUse" width="40" height="40" patternTransform="rotate(45)">
              <line x1="0" y1="0" x2="0" y2="40" stroke="rgba(34,211,238,0.3)" strokeWidth="0.3" />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#grid-cross)" />
        </svg>

        {/* Floating energy particles */}
        <HexParticles />

        {/* Grid container — sets CSS vars for tile sizing */}
        <div
          className="relative inline-flex flex-col items-start w-fit z-10 gap-px"
          style={{
            ["--tile-w" as string]: `${width}px`,
            ["--tile-h" as string]: `${width}px`,
          }}
        >
          {grid.map((row, rowIndex) => (
            <div
              key={rowIndex}
              className="flex gap-px"
            >
              {row.map((tile) => (
                <HexTile
                  key={`${tile.x}-${tile.y}`}
                  tile={tile}
                  isSelected={
                    selectedTile?.x === tile.x && selectedTile?.y === tile.y
                  }
                  onClick={() => !disabled && onTileClick(tile.x, tile.y)}
                  isValidMove={validMoveSet.has(`${tile.x},${tile.y}`)}
                  isPushTarget={pushTargetSet.has(`${tile.x},${tile.y}`)}
                  recentlyCaptured={capturedSet.has(`${tile.x},${tile.y}`)}
                  isTerritorySpread={territorySpreadSet.has(`${tile.x},${tile.y}`)}
                  isReinforceTarget={reinforceTargetSet.has(`${tile.x},${tile.y}`)}
                  isAttackTarget={attackHighlightSet.has(`${tile.x},${tile.y}`)}
                  isSourceTile={sourceHighlightSet.has(`${tile.x},${tile.y}`)}
                />
              ))}
            </div>
          ))}
        </div>

        {/* Corner decorative elements */}
        <div className="absolute top-0 left-0 w-5 h-5 sm:w-7 sm:h-7 border-t border-l border-cyan-400/20 rounded-tl-xl" />
        <div className="absolute top-0 right-0 w-5 h-5 sm:w-7 sm:h-7 border-t border-r border-cyan-400/20 rounded-tr-xl" />
        <div className="absolute bottom-0 left-0 w-5 h-5 sm:w-7 sm:h-7 border-b border-l border-cyan-400/20 rounded-bl-xl" />
        <div className="absolute bottom-0 right-0 w-5 h-5 sm:w-7 sm:h-7 border-b border-r border-cyan-400/20 rounded-br-xl" />
      </div>

      {/* Legend — perspective-aware when localColor/opponentColor are supplied */}
      <div className="mt-4 flex items-center gap-4 text-[10px] sm:text-[11px] text-slate-500 flex-wrap justify-center">
        {localColor && opponentColor ? (
          <>
            <span className="flex items-center gap-1.5">
              <span
                className="w-2.5 h-2.5 rounded-sm"
                style={{
                  backgroundColor: `${localColor}99`,
                  boxShadow: `0 0 6px ${localColor}55`,
                }}
              />
              {localLabel || "You"}
            </span>
            <span className="flex items-center gap-1.5">
              <span
                className="w-2.5 h-2.5 rounded-sm"
                style={{
                  backgroundColor: `${opponentColor}99`,
                  boxShadow: `0 0 6px ${opponentColor}55`,
                }}
              />
              {opponentLabel || "Opponent"}
            </span>
          </>
        ) : (
          <>
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-sm bg-cyan-400/60 shadow-[0_0_6px_rgba(34,211,238,0.3)]" />
              P1
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-sm bg-red-400/60 shadow-[0_0_6px_rgba(239,68,68,0.3)]" />
              P2
            </span>
          </>
        )}
        <span className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-sm bg-slate-700/40 border border-slate-600/30" />
          Empty
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-sm bg-yellow-500/60 shadow-[0_0_6px_rgba(250,204,21,0.3)]" />
          <IconStar size={12} className="text-yellow-500" /> Capital
        </span>
      </div>
    </div>
  );
}
