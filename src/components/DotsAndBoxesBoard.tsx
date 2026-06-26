"use client";

import { memo, useEffect, useMemo, useRef } from "react";

// ─── Board constants ──────────────────────────────────────────────────
const DOTS = 7; // 7×7 dot grid
const CELL_SIZE = 100; // SVG units between dots
const MARGIN = 50; // padding around the grid
const DOT_RADIUS = 5;
const EDGE_HIT = 14; // thickness of the clickable/hoverable area
const VIEWBOX = MARGIN * 2 + (DOTS - 1) * CELL_SIZE; // 700

export const BOX_SIZE = CELL_SIZE - DOT_RADIUS * 2; // 90

interface DotsAndBoxesBoardProps {
  /** Currently drawn horizontal edges: Set of "row,col" keys (0-6 rows × 0-5 cols) */
  drawnH?: Set<string>;
  /** Currently drawn vertical edges: Set of "row,col" keys (0-5 rows × 0-6 cols) */
  drawnV?: Set<string>;
  /** Completed boxes: "row,col" (0-5) */
  boxes?: string[];
  /** Box ownership keys: row,col → "host" | "guest" */
  boxOwners?: Record<string, "host" | "guest">;
  /** Called when a horizontal edge is clicked (row, col) */
  onEdgeHClick?: (row: number, col: number) => void;
  /** Called when a vertical edge is clicked (row, col) */
  onEdgeVClick?: (row: number, col: number) => void;
  /** Whether edge clicks are enabled */
  interactive?: boolean;
  /** Player 1 (host) color */
  player1Color?: string;
  /** Player 2 (guest) color */
  player2Color?: string;
}

// ── Helpers for the custom React.memo comparator ────────────────────
// Default shallow comparison can't compare Sets / nested objects, so
// we serialize to a sorted string for O(n) cheap equality.
function setSig(s: Set<string> | undefined): string {
  if (!s || s.size === 0) return "";
  const arr = Array.from(s);
  arr.sort();
  return arr.join("|");
}

function arrSig(a: ReadonlyArray<string> | undefined): string {
  if (!a || a.length === 0) return "";
  return a.join("|");
}

function objSig(o: Record<string, string> | undefined): string {
  if (!o) return "";
  const keys = Object.keys(o);
  if (keys.length === 0) return "";
  keys.sort();
  return keys.map((k) => `${k}:${o[k]}`).join("|");
}

/**
 * Custom comparator: treats two prop sets as equal when their
 * gameplay-relevant content is identical, even if Set/Record/Array
 * references differ. Reference-stable callbacks from the parent
 * continue to skip render via reference equality.
 */
function propsAreEqual(
  prev: Readonly<DotsAndBoxesBoardProps>,
  next: Readonly<DotsAndBoxesBoardProps>,
): boolean {
  if (
    prev.onEdgeHClick !== next.onEdgeHClick ||
    prev.onEdgeVClick !== next.onEdgeVClick ||
    prev.interactive !== next.interactive ||
    prev.player1Color !== next.player1Color ||
    prev.player2Color !== next.player2Color
  ) {
    return false;
  }
  return (
    setSig(prev.drawnH) === setSig(next.drawnH) &&
    setSig(prev.drawnV) === setSig(next.drawnV) &&
    arrSig(prev.boxes) === arrSig(next.boxes) &&
    objSig(prev.boxOwners) === objSig(next.boxOwners)
  );
}

function DotsAndBoxesBoardImpl({
  drawnH,
  drawnV,
  boxes,
  boxOwners,
  onEdgeHClick,
  onEdgeVClick,
  interactive = false,
  player1Color = "#f59e0b",
  player2Color = "#f97316",
}: DotsAndBoxesBoardProps) {
  const drawnHSet = drawnH ?? EMPTY_SET;
  const drawnVSet = drawnV ?? EMPTY_SET;
  const boxesArr = boxes ?? EMPTY_ARR;
  const boxOwnersMap = boxOwners ?? EMPTY_OBJ;

  // ─── Track "newly drawn" edges + "newly claimed" boxes ─────────────
  //
  // We snapshot the previous render's sets in a ref so we can compute,
  // during the current render, which entries are brand new. CSS
  // keyframes fire on class attachment, then we overwrite the ref in
  // a post-render effect — so the animation triggers exactly once per
  // change, regardless of whether it's a user move or an auto-move.
  const prevDrawnHRef = useRef<Set<string>>(EMPTY_SET);
  const prevDrawnVRef = useRef<Set<string>>(EMPTY_SET);
  const prevBoxesRef = useRef<Set<string>>(EMPTY_SET);
  // First-render guard: skip animation on mount/refresh so an already-in-
  // progress match doesn't replay every edge and box appearing in again.
  const isFirstRenderRef = useRef(true);

  // Compute new-keys inline (cheap; ≤84 entries). Skipping useMemo here
  // also avoids passing a Set<string> as a dependency-array dependency,
  // which React's DependencyList signature does not accept.
  const newHKeys: Set<string> = (() => {
    if (isFirstRenderRef.current) return EMPTY_SET;
    const out = new Set<string>();
    for (const k of drawnHSet) if (!prevDrawnHRef.current.has(k)) out.add(k);
    return out;
  })();

  const newVKeys: Set<string> = (() => {
    if (isFirstRenderRef.current) return EMPTY_SET;
    const out = new Set<string>();
    for (const k of drawnVSet) if (!prevDrawnVRef.current.has(k)) out.add(k);
    return out;
  })();

  const newBoxKeys: Set<string> = (() => {
    if (isFirstRenderRef.current) return EMPTY_SET;
    const out = new Set<string>();
    for (const k of boxesArr) if (!prevBoxesRef.current.has(k)) out.add(k);
    return out;
  })();

  useEffect(() => {
    // On first commit, prime the refs to the current sets so the
    // existing edges/boxes don't trigger animations on the next update.
    prevDrawnHRef.current = new Set(drawnHSet);
    prevDrawnVRef.current = new Set(drawnVSet);
    prevBoxesRef.current = new Set(boxesArr);
    isFirstRenderRef.current = false;
  });

  // ─── Generate all edge positions ──────────────────────────────────
  // Memoized once; never recomputed for the lifetime of the component.
  const horizontalEdges = useMemo(() => {
    const edges: Array<{
      key: string;
      row: number;
      col: number;
      x: number;
      y: number;
    }> = [];
    for (let row = 0; row < DOTS; row++) {
      for (let col = 0; col < DOTS - 1; col++) {
        edges.push({
          key: `${row},${col}`,
          row,
          col,
          x: MARGIN + col * CELL_SIZE + DOT_RADIUS,
          y: MARGIN + row * CELL_SIZE - EDGE_HIT / 2,
        });
      }
    }
    return edges;
  }, []);

  const verticalEdges = useMemo(() => {
    const edges: Array<{
      key: string;
      row: number;
      col: number;
      x: number;
      y: number;
    }> = [];
    for (let row = 0; row < DOTS - 1; row++) {
      for (let col = 0; col < DOTS; col++) {
        edges.push({
          key: `${row},${col}`,
          row,
          col,
          x: MARGIN + col * CELL_SIZE - EDGE_HIT / 2,
          y: MARGIN + row * CELL_SIZE + DOT_RADIUS,
        });
      }
    }
    return edges;
  }, []);

  const dots = useMemo(() => {
    const d: Array<{ x: number; y: number }> = [];
    for (let row = 0; row < DOTS; row++) {
      for (let col = 0; col < DOTS; col++) {
        d.push({
          x: MARGIN + col * CELL_SIZE,
          y: MARGIN + row * CELL_SIZE,
        });
      }
    }
    return d;
  }, []);

  const edgeHWidth = BOX_SIZE;
  const edgeVHeight = BOX_SIZE;

  return (
    <svg
      viewBox={`0 0 ${VIEWBOX} ${VIEWBOX}`}
      className="w-full h-auto max-w-[560px] mx-auto select-none"
      role="img"
      aria-label="Dots and Boxes game board"
      style={
        // Promote to a GPU compositing layer to keep the grid crisp
        // while edges / boxes animate above it.
        { transform: "translateZ(0)", willChange: "auto" }
      }
    >
      {/* ── Animation keyframes (scoped to this SVG) ─────────────── */}
      <style>{`
        @keyframes dnb-edge-draw {
          0%   { stroke-width: 0;   opacity: 0; }
          55%  { stroke-width: 4.5; opacity: 1; }
          100% { stroke-width: 3;   opacity: 1; }
        }
        @keyframes dnb-box-fill {
          0%   { fill-opacity: 0;    transform: scale(0.55); }
          55%  { fill-opacity: 0.45; transform: scale(1.05); }
          100% { fill-opacity: 0.28; transform: scale(1); }
        }
        @keyframes dnb-text-pop {
          0%   { opacity: 0; transform: scale(0.4); }
          55%  { opacity: 1; transform: scale(1.15); }
          100% { opacity: 0.95; transform: scale(1); }
        }
        .dnb-edge-anim    { animation: dnb-edge-draw 280ms cubic-bezier(0.22, 1, 0.36, 1) both;
                            will-change: stroke-width, opacity; }
        .dnb-box-anim     { animation: dnb-box-fill 380ms cubic-bezier(0.25, 0.46, 0.45, 0.94) both;
                            transform-box: fill-box; transform-origin: center;
                            will-change: transform, fill-opacity; }
        .dnb-text-anim    { animation: dnb-text-pop  420ms cubic-bezier(0.25, 0.46, 0.45, 0.94) 60ms both;
                            transform-box: fill-box; transform-origin: center;
                            will-change: transform, opacity; }
        @media (prefers-reduced-motion: reduce) {
          .dnb-edge-anim, .dnb-box-anim, .dnb-text-anim { animation: none; will-change: auto; }
        }
      `}</style>

      {/* ── Subtle grid lines for box interiors (cosmetic, static) ─── */}
      {GRID.map((rowArr, row) =>
        rowArr.map((_, col) => (
          <rect
            key={`cell-${row}-${col}`}
            x={MARGIN + col * CELL_SIZE + DOT_RADIUS}
            y={MARGIN + row * CELL_SIZE + DOT_RADIUS}
            width={edgeHWidth}
            height={edgeVHeight}
            fill="rgba(251, 191, 36, 0.03)"
            stroke="none"
            rx={4}
          />
        )),
      )}

      {/* ── Horizontal edges ──────────────────────────────────────── */}
      {horizontalEdges.map((edge) => {
        const drawn = drawnHSet.has(edge.key);
        const isNew = drawn && newHKeys.has(edge.key);
        const showDisabled = !drawn && !interactive;
        const cursorCls =
          interactive && !drawn ? "cursor-pointer" : "cursor-default";
        const visible =
          drawn
            ? player1Color
            : interactive
              ? "rgba(251, 191, 36, 0.22)"
              : "rgba(251, 191, 36, 0.10)";
        return (
          <g key={`he-${edge.key}`}>
            <rect
              x={edge.x}
              y={edge.y}
              width={edgeHWidth}
              height={EDGE_HIT}
              fill="transparent"
              className={cursorCls}
              onClick={() => {
                if (interactive && !drawn && onEdgeHClick) {
                  onEdgeHClick(edge.row, edge.col);
                }
              }}
            >
              {interactive && !drawn && (
                <title>
                  Draw horizontal edge ({edge.row}, {edge.col})
                </title>
              )}
            </rect>

            <line
              x1={edge.x + 2}
              y1={edge.y + EDGE_HIT / 2}
              x2={edge.x + edgeHWidth - 2}
              y2={edge.y + EDGE_HIT / 2}
              stroke={visible}
              strokeWidth={drawn ? 3 : 1}
              strokeLinecap="round"
              opacity={showDisabled ? 0.45 : 1}
              className={
                (isNew ? "dnb-edge-anim" : "") +
                (interactive && !drawn
                  ? " transition-all duration-150 hover:stroke-amber-300 hover:stroke-[2.8]"
                  : "")
              }
            />
          </g>
        );
      })}

      {/* ── Vertical edges ────────────────────────────────────────── */}
      {verticalEdges.map((edge) => {
        const drawn = drawnVSet.has(edge.key);
        const isNew = drawn && newVKeys.has(edge.key);
        const showDisabled = !drawn && !interactive;
        const cursorCls =
          interactive && !drawn ? "cursor-pointer" : "cursor-default";
        const visible =
          drawn
            ? player2Color
            : interactive
              ? "rgba(251, 191, 36, 0.22)"
              : "rgba(251, 191, 36, 0.10)";
        return (
          <g key={`ve-${edge.key}`}>
            <rect
              x={edge.x}
              y={edge.y}
              width={EDGE_HIT}
              height={edgeVHeight}
              fill="transparent"
              className={cursorCls}
              onClick={() => {
                if (interactive && !drawn && onEdgeVClick) {
                  onEdgeVClick(edge.row, edge.col);
                }
              }}
            >
              {interactive && !drawn && (
                <title>
                  Draw vertical edge ({edge.row}, {edge.col})
                </title>
              )}
            </rect>

            <line
              x1={edge.x + EDGE_HIT / 2}
              y1={edge.y + 2}
              x2={edge.x + EDGE_HIT / 2}
              y2={edge.y + edgeVHeight - 2}
              stroke={visible}
              strokeWidth={drawn ? 3 : 1}
              strokeLinecap="round"
              opacity={showDisabled ? 0.45 : 1}
              className={
                (isNew ? "dnb-edge-anim" : "") +
                (interactive && !drawn
                  ? " transition-all duration-150 hover:stroke-orange-300 hover:stroke-[2.8]"
                  : "")
              }
            />
          </g>
        );
      })}

      {/* ── Claimed boxes ─────────────────────────────────────── */}
      {boxesArr.map((bk) => {
        const parts = bk.split(",");
        const r = Number(parts[0]);
        const c = Number(parts[1]);
        if (Number.isNaN(r) || Number.isNaN(c)) return null;
        const owner = boxOwnersMap[bk];
        const fillColor =
          owner === "host"
            ? player1Color
            : owner === "guest"
              ? player2Color
              : "#888";
        const bx = MARGIN + c * CELL_SIZE + DOT_RADIUS;
        const by = MARGIN + r * CELL_SIZE + DOT_RADIUS;
        const isNew = newBoxKeys.has(bk);
        return (
          <g key={`box-${bk}`}>
            <rect
              x={bx + 2}
              y={by + 2}
              width={BOX_SIZE - 4}
              height={BOX_SIZE - 4}
              fill={fillColor}
              fillOpacity={0.28}
              stroke={fillColor}
              strokeWidth={1.5}
              strokeOpacity={0.65}
              rx={6}
              className={isNew ? "dnb-box-anim" : ""}
              style={
                isNew
                  ? undefined
                  : { transformBox: "fill-box", transformOrigin: "center" }
              }
            />
            <text
              x={bx + BOX_SIZE / 2}
              y={by + BOX_SIZE / 2 + 5}
              textAnchor="middle"
              fill={fillColor}
              fontSize={16}
              fontWeight={700}
              style={
                isNew
                  ? { pointerEvents: "none", userSelect: "none" }
                  : {
                      pointerEvents: "none",
                      userSelect: "none",
                      transformBox: "fill-box",
                      transformOrigin: "center",
                      fillOpacity: 0.95,
                    }
              }
              className={isNew ? "dnb-text-anim" : ""}
            >
              {owner === "host" ? "H" : owner === "guest" ? "G" : "?"}
            </text>
          </g>
        );
      })}

      {/* ── Dots ──────────────────────────────────────────────── */}
      {dots.map((dot, i) => (
        <circle
          key={`dot-${i}`}
          cx={dot.x}
          cy={dot.y}
          r={DOT_RADIUS}
          fill="#fbbf24"
          className="drop-shadow-[0_0_6px_rgba(251,191,36,0.6)]"
        />
      ))}
    </svg>
  );
}

// ─── Module-level constants used as defaults ────────────────────────
// Re-using the same empty objects prevents passing a fresh reference
// each render, which would defeat React.memo's prop equality check.
// Mutable types so callers that expect `Set<string>` / `string[]` can
// accept them without a covariant mismatch.
const EMPTY_SET: Set<string> = new Set();
const EMPTY_ARR: string[] = [];
const EMPTY_OBJ: Record<string, string> = {};
const GRID = Array.from({ length: DOTS - 1 }, () =>
  Array.from({ length: DOTS - 1 }, () => 0),
);

// ─── Memoized export ─────────────────────────────────────────────────
// Default-export React.memo so the SVG re-renders ONLY when gameplay
// signals (drawn edges, claimed boxes, owners) actually change. Polls
// returning byte-identical game state therefore skip the SVG commit.
const DotsAndBoxesBoard = memo(DotsAndBoxesBoardImpl, propsAreEqual);
export default DotsAndBoxesBoard;
