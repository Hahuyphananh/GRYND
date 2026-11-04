"use client";

import React from "react";
import { IconStar } from "@tabler/icons-react";
import HexTile, { type HexTileData } from "./HexTile";
import HexParticles from "./HexParticles";
import { arrowGeometry, type ArrowGeometry } from "../lib/hexBoardGeometry";
import HexMoveAnimation from "./HexMoveAnimation";
import type { TroopMoveEvent } from "../lib/hexTroopAnimation";

/** A pending attack/displacement, drawn as a source→destination arrow. */
export interface ActionArrow {
  fromKey: string;
  toKey: string;
  color: string;
  troopCount: number;
  mode: "attack" | "displace";
}

/**
 * Centre of `el` in `host`'s layout pixels. Uses offsetLeft/offsetTop rather
 * than getBoundingClientRect so the result is immune to the board's CSS scale,
 * page scrolling and the horizontal scroller — exactly what an overlay child of
 * the same frame needs.
 */
function centerIn(host: HTMLElement, el: HTMLElement): { x: number; y: number } {
  let x = el.offsetLeft + el.offsetWidth / 2;
  let y = el.offsetTop + el.offsetHeight / 2;
  let node = el.offsetParent as HTMLElement | null;
  while (node && node !== host) {
    x += node.offsetLeft;
    y += node.offsetTop;
    node = node.offsetParent as HTMLElement | null;
  }
  return { x, y };
}

/**
 * The payment split for a pending upgrade, shown on the board before it is
 * confirmed: which neighbours pay, how much each gives up, and how much the
 * upgraded territory itself covers.
 */
export interface UpgradeFunding {
  /** "x,y" of the territory being upgraded. */
  targetKey: string;
  /** Troops the territory itself pays. */
  self: number;
  /** Total troop cost of the upgrade. */
  cost: number;
  /** Troops each adjacent neighbour pays, keyed by "x,y". */
  donors: Record<string, number>;
}

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
   * "x,y" of the CHOSEN displace target — painted in its own yellow ring so
   * it stands apart from the green source tiles and the orange candidate
   * tiles around it.
   */
  displaceTargetKey?: string;
  /**
   * The CHOSEN destination of the pending action (attack, displace or
   * upgrade) — painted with the same ring as a displace target so the end of
   * the arrow is always visible as the destination.
   */
  actionTargetKey?: string;
  /** Source→destination arrow, shown while a troop count is being chosen. */
  actionArrow?: ActionArrow | null;
  /**
   * The last applied attack/displacement, published by the engine. Purely
   * presentational: the board animates the troops that already moved, using
   * the authoritative survivors/owners in the event.
   */
  troopAnimation?: TroopMoveEvent | null;
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
  /** Payment split for a pending upgrade (null when none is being planned). */
  upgradeFunding?: UpgradeFunding | null;
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
  displaceTargetKey,
  actionTargetKey,
  actionArrow,
  troopAnimation,
  upgradeFunding,
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

  // How much of a pending upgrade the neighbours cover in total. The donor map
  // already excludes the upgraded tile, so the sum is the borrowed amount.
  const fundingFromNeighbours = React.useMemo(
    () =>
      Object.values(upgradeFunding?.donors ?? {}).reduce(
        (sum, troops) => sum + troops,
        0,
      ),
    [upgradeFunding],
  );

  // ── Action arrow geometry ───────────────────────────────────────────
  // The overlay is a child of the board frame, so tile centres are measured in
  // the frame's own layout pixels. That keeps the arrow aligned under the
  // board's responsive scale, while the page scrolls and while the horizontal
  // scroller moves — and it never adds layout (absolute inset-0).
  const frameRef = React.useRef<HTMLDivElement>(null);
  const [arrow, setArrow] = React.useState<ArrowGeometry | null>(null);

  React.useEffect(() => {
    if (!actionArrow) {
      setArrow(null);
      return;
    }
    const frame = frameRef.current;
    if (!frame) return;
    let raf = 0;

    const measure = () => {
      const fromEl = frame.querySelector<HTMLElement>(
        `[data-tile-key="${actionArrow.fromKey}"]`,
      );
      const toEl = frame.querySelector<HTMLElement>(
        `[data-tile-key="${actionArrow.toKey}"]`,
      );
      if (!fromEl || !toEl) {
        setArrow(null);
        return;
      }
      setArrow(
        arrowGeometry(centerIn(frame, fromEl), centerIn(frame, toEl), {
          startInset: fromEl.offsetWidth * 0.42,
          endInset: toEl.offsetWidth * 0.5,
          headLength: Math.max(9, toEl.offsetWidth * 0.16),
          headWidth: Math.max(6, toEl.offsetWidth * 0.12),
        }),
      );
    };

    measure();
    raf = requestAnimationFrame(measure);
    window.addEventListener("resize", measure);
    const observer =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    observer?.observe(frame);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", measure);
      observer?.disconnect();
    };
  }, [actionArrow?.fromKey, actionArrow?.toKey, actionArrow?.mode, actionArrow?.color, width]);

  // ── Troop movement animation ────────────────────────────────────────
  // Completely separate from the arrow: that one previews a pending action,
  // this one replays an action the engine already resolved. Dots of the two
  // participating tiles are muted while it runs, so the formation revealed at
  // the end is the real authoritative one.
  const [reducedMotion, setReducedMotion] = React.useState(false);
  const [moveEffect, setMoveEffect] = React.useState<{
    event: TroopMoveEvent;
    from: { x: number; y: number };
    to: { x: number; y: number };
    radius: number;
  } | null>(null);

  React.useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReducedMotion(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  React.useEffect(() => {
    if (!troopAnimation) {
      setMoveEffect(null);
      return;
    }
    const frame = frameRef.current;
    if (!frame) return;
    const fromEl = frame.querySelector<HTMLElement>(
      `[data-tile-key="${troopAnimation.fromKey}"]`,
    );
    const toEl = frame.querySelector<HTMLElement>(
      `[data-tile-key="${troopAnimation.toKey}"]`,
    );
    if (!fromEl || !toEl) return;
    setMoveEffect({
      event: troopAnimation,
      from: centerIn(frame, fromEl),
      to: centerIn(frame, toEl),
      radius: Math.max(fromEl.offsetWidth, toEl.offsetWidth) / 2,
    });
  }, [troopAnimation?.id, width]);

  const handleMoveDone = React.useCallback(() => setMoveEffect(null), []);

  return (
    <div
      ref={boardRef}
      data-hex-board=""
      className={`flex flex-col items-center justify-center select-none transition-all duration-500 ${disabled ? "opacity-40 pointer-events-none" : ""}`}
      style={{
        transform: `scale(${scaleFactor})`,
        transformOrigin: "center center",
        transition: "transform 0.4s ease, opacity 0.4s ease",
        willChange: "transform",
      }}
    >
      {/* ── GRID BOARD ─────────────────────────────────────────────────── */}
      {upgradeFunding && fundingFromNeighbours > 0 && (
        <div
          data-hex-upgrade-funding=""
          className="mb-2 rounded-lg border px-2.5 py-1 text-[10px] font-bold tabular-nums backdrop-blur-sm"
          style={{
            borderColor: "rgba(192,132,252,0.45)",
            color: "#e9d5ff",
            background: "rgba(88,28,135,0.35)",
          }}
        >
          Upgrade cost {upgradeFunding.cost}: {upgradeFunding.self} here +{" "}
          {fundingFromNeighbours} from neighbours
        </div>
      )}
      <div
        ref={frameRef}
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
                  anchorKey={`${tile.x},${tile.y}`}
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
                  isDisplaceTarget={
                    displaceTargetKey !== undefined &&
                    displaceTargetKey === `${tile.x},${tile.y}`
                  }
                  isChosenTarget={
                    actionTargetKey !== undefined &&
                    actionTargetKey === `${tile.x},${tile.y}`
                  }
                  dotsMuted={
                    !reducedMotion &&
                    moveEffect !== null &&
                    (moveEffect.event.fromKey === `${tile.x},${tile.y}` ||
                      moveEffect.event.toKey === `${tile.x},${tile.y}`)
                  }
                  fundingTake={upgradeFunding?.donors[`${tile.x},${tile.y}`]}
                  fundingReceives={
                    upgradeFunding?.targetKey === `${tile.x},${tile.y}`
                      ? fundingFromNeighbours
                      : undefined
                  }
                />
              ))}
            </div>
          ))}
        </div>

        {/* Directional arrow overlay — purely visual. It is absolutely
            positioned inside the board frame (no layout shift), drawn in the
            acting player's colour, dashed for a displacement, and
            pointer-events-none so it can never intercept a tile click. */}
        {actionArrow && arrow && (
          <div
            data-hex-action-overlay=""
            className="pointer-events-none absolute inset-0 z-20"
          >
            <svg
              data-hex-action-arrow={actionArrow.mode}
              className="pointer-events-none h-full w-full"
              role="img"
              aria-label={`${actionArrow.troopCount} troops ${
                actionArrow.mode === "attack" ? "attacking" : "displacing"
              }`}
            >
              <line
                x1={arrow.start.x}
                y1={arrow.start.y}
                x2={arrow.end.x}
                y2={arrow.end.y}
                stroke="#020617"
                strokeWidth={7}
                strokeLinecap="round"
                opacity={0.6}
              />
              <line
                x1={arrow.start.x}
                y1={arrow.start.y}
                x2={arrow.end.x}
                y2={arrow.end.y}
                stroke={actionArrow.color}
                strokeWidth={3}
                strokeLinecap="round"
                strokeDasharray={actionArrow.mode === "displace" ? "7 5" : undefined}
              />
              <polygon
                points={arrow.head}
                fill={actionArrow.color}
                stroke="#020617"
                strokeWidth={1.5}
                strokeLinejoin="round"
              />
            </svg>
            <span
              data-hex-arrow-label=""
              className="pointer-events-none absolute rounded-md border px-1.5 py-0.5 text-[10px] font-black tabular-nums backdrop-blur-sm"
              style={{
                left: arrow.label.x,
                top: arrow.label.y,
                transform: "translate(-50%, -50%)",
                color: actionArrow.color,
                borderColor: `${actionArrow.color}66`,
                background: "rgba(2,6,23,0.85)",
                boxShadow: `0 0 10px ${actionArrow.color}33`,
              }}
            >
              {actionArrow.troopCount}
            </span>
          </div>
        )}

        {/* Troop-movement / battle overlay — visual only, never blocks a
            click and never changes layout. */}
        {moveEffect && !reducedMotion && (
          <HexMoveAnimation
            key={moveEffect.event.id}
            event={moveEffect.event}
            from={moveEffect.from}
            to={moveEffect.to}
            radius={moveEffect.radius}
            onDone={handleMoveDone}
          />
        )}

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
