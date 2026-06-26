"use client";

import { useMemo } from "react";

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

export default function DotsAndBoxesBoard({
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
  const drawnHSet = drawnH ?? new Set<string>();
  const drawnVSet = drawnV ?? new Set<string>();
  const boxesArr = boxes ?? [];
  const boxOwnersMap = boxOwners ?? {};

  // ─── Generate all edge positions ──────────────────────────────────

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

  // ─── Box size ─────────────────────────────────────────────────────

  const edgeHWidth = BOX_SIZE;
  const edgeVHeight = BOX_SIZE;

  return (
    <svg
      viewBox={`0 0 ${VIEWBOX} ${VIEWBOX}`}
      className="w-full h-auto max-w-[560px] mx-auto select-none"
      role="img"
      aria-label="Dots and Boxes game board"
    >
      {/* ── Subtle grid lines for box interiors (cosmetic) ─────────── */}
      {Array.from({ length: DOTS - 1 }).map((_, row) =>
        Array.from({ length: DOTS - 1 }).map((_, col) => (
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
        return (
          <g key={`he-${edge.key}`}>
            {/* Invisible hit area */}
            <rect
              x={edge.x}
              y={edge.y}
              width={edgeHWidth}
              height={EDGE_HIT}
              fill="transparent"
              className={
                interactive && !drawn
                  ? "cursor-pointer"
                  : "cursor-default"
              }
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

            {/* Visual edge indicator — faint line always visible */}
            <line
              x1={edge.x + 2}
              y1={edge.y + EDGE_HIT / 2}
              x2={edge.x + edgeHWidth - 2}
              y2={edge.y + EDGE_HIT / 2}
              stroke={
                drawn
                  ? player1Color
                  : "rgba(251, 191, 36, 0.18)"
              }
              strokeWidth={drawn ? 3 : 1}
              strokeLinecap="round"
              className={
                interactive && !drawn
                  ? "transition-all duration-150 hover:stroke-amber-400/70 hover:stroke-[2.5]"
                  : ""
              }
            />
          </g>
        );
      })}

      {/* ── Vertical edges ────────────────────────────────────────── */}
      {verticalEdges.map((edge) => {
        const drawn = drawnVSet.has(edge.key);
        return (
          <g key={`ve-${edge.key}`}>
            {/* Invisible hit area */}
            <rect
              x={edge.x}
              y={edge.y}
              width={EDGE_HIT}
              height={edgeVHeight}
              fill="transparent"
              className={
                interactive && !drawn
                  ? "cursor-pointer"
                  : "cursor-default"
              }
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

            {/* Visual edge indicator — faint line always visible */}
            <line
              x1={edge.x + EDGE_HIT / 2}
              y1={edge.y + 2}
              x2={edge.x + EDGE_HIT / 2}
              y2={edge.y + edgeVHeight - 2}
              stroke={
                drawn
                  ? player2Color
                  : "rgba(251, 191, 36, 0.18)"
              }
              strokeWidth={drawn ? 3 : 1}
              strokeLinecap="round"
              className={
                interactive && !drawn
                  ? "transition-all duration-150 hover:stroke-amber-400/70 hover:stroke-[2.5]"
                  : ""
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
            />
            <text
              x={bx + BOX_SIZE / 2}
              y={by + BOX_SIZE / 2 + 5}
              textAnchor="middle"
              fill={fillColor}
              fillOpacity={0.95}
              fontSize={16}
              fontWeight={700}
              style={{ pointerEvents: "none", userSelect: "none" }}
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
