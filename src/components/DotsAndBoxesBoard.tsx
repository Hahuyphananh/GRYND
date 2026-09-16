"use client";

import { memo, useEffect, useId, useMemo, useRef } from "react";
import { iconAssetUrl } from "../lib/iconAssets";
// The GRYND mark used for the AI seat's claimed boxes (the AI has no users
// row, so it can never resolve an official icon key). Static import so the
// asset can't go missing silently — `.src` is the hashed URL an <image>
// needs (the import itself is the Next image object).
import smallLogo from "../images/smalllogo.png";

// ─── Board constants ──────────────────────────────────────────────────
const DOTS = 7; // 7×7 dot grid
const CELL_SIZE = 130; // SVG units between dots — bigger grid so tapping edges is easier
const MARGIN = 60; // padding around the grid
const DOT_RADIUS = 7;
// Hit-area thickness for edges. This is the invisible tap target
// height/width around each edge. Larger values make edges much easier
// to hit on touch — especially when the board is scaled down on small
// screens. We keep it from growing past ~30 so horizontal/vertical
// corner hit-rects do not fully overlap and block vertical taps in the
// corner zone.
const EDGE_HIT = 34;
const VIEWBOX = MARGIN * 2 + (DOTS - 1) * CELL_SIZE; // 700

export const BOX_SIZE = CELL_SIZE - DOT_RADIUS * 2; // 116

// ─── Selection palette ─────────────────────────────────────────────────
// A drawn edge is CLAIMED, and the whole point of the board is reading your
// own claim graph at a glance — so drawn lines are painted in the color of
// whoever drew them, at full opacity and a heavier weight, while still-open
// edges are a faint NEUTRAL ghost. Open edges deliberately never use a
// player color (hover brightens the ghost instead), so a highlight can never
// be mistaken for a claim.
//
// `UNKNOWN_EDGE_COLOR` covers edges persisted before ownership was recorded
// (`edgeOwners`): those render neutral but still read as "taken".
const UNKNOWN_EDGE_COLOR = "#cbd5e1";
const EMPTY_EDGE_COLOR = "rgba(148, 163, 184, 0.38)";
const EMPTY_EDGE_COLOR_DIM = "rgba(148, 163, 184, 0.14)";
const DRAWN_STROKE = 6;
const EMPTY_STROKE = 3.4;
const EMPTY_STROKE_DIM = 2.4;

// Claimed-box mark: the box owner's pfp (official icon) — or the GRYND logo
// for the AI seat. Sized relative to the box so it scales with the grid.
const BOX_ICON_SIZE = Math.round(BOX_SIZE * 0.62);
const BOX_ICON_RADIUS = Math.round(BOX_ICON_SIZE * 0.22);
const AI_BOX_ICON_SRC: string = smallLogo.src;

interface DotsAndBoxesBoardProps {
  /** Currently drawn horizontal edges: Set of "row,col" keys (0-6 rows × 0-5 cols) */
  drawnH?: Set<string>;
  /** Currently drawn vertical edges: Set of "row,col" keys (0-5 rows × 0-6 cols) */
  drawnV?: Set<string>;
  /** Completed boxes: "row,col" (0-5) */
  boxes?: string[];
  /** Box ownership keys: row,col → "host" | "guest" */
  boxOwners?: Record<string, "host" | "guest">;
  /** Edge ownership keyed by the CANONICAL engine edge key ("h:0,0" /
   *  "v:0,0", as stored on `GameState.edgeOwners`) → "host" | "guest".
   *  A drawn edge with no recorded owner (a match persisted before
   *  ownership was tracked) renders in a neutral "taken" color. */
  edgeOwners?: Record<string, "host" | "guest">;
  /** Official icon key for the host seat — drawn inside the boxes the host
   *  claimed. Missing/invalid keys resolve to the official default icon. */
  hostIconKey?: string | null;
  /** Official icon key for the guest seat. */
  guestIconKey?: string | null;
  /** Free practice vs the GRYND AI — the guest box mark becomes the logo
   *  (the AI seat resolves no icon key). */
  isAiGame?: boolean;
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
  /**
   * Optional pre-translated tooltip strings for hoverable edges (a11y).
   * Each receives `{ row, col }` and should return a localized string.
   * If omitted, a sensible English fallback is used so the board remains
   * usable in tests, Storybook, or any caller that doesn't pass translations.
   */
  edgeTooltipH?: (row: number, col: number) => string;
  edgeTooltipV?: (row: number, col: number) => string;
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
    prev.player2Color !== next.player2Color ||
    prev.edgeTooltipH !== next.edgeTooltipH ||
    prev.edgeTooltipV !== next.edgeTooltipV ||
    prev.hostIconKey !== next.hostIconKey ||
    prev.guestIconKey !== next.guestIconKey ||
    prev.isAiGame !== next.isAiGame
  ) {
    return false;
  }
  return (
    setSig(prev.drawnH) === setSig(next.drawnH) &&
    setSig(prev.drawnV) === setSig(next.drawnV) &&
    arrSig(prev.boxes) === arrSig(next.boxes) &&
    objSig(prev.boxOwners) === objSig(next.boxOwners) &&
    objSig(prev.edgeOwners) === objSig(next.edgeOwners)
  );
}

function DotsAndBoxesBoardImpl({
  drawnH,
  drawnV,
  boxes,
  boxOwners,
  edgeOwners,
  hostIconKey = null,
  guestIconKey = null,
  isAiGame = false,
  onEdgeHClick,
  onEdgeVClick,
  interactive = false,
  player1Color = "#f59e0b",
  player2Color = "#f97316",
  edgeTooltipH = (row, col) => `Draw horizontal edge (${row}, ${col})`,
  edgeTooltipV = (row, col) => `Draw vertical edge (${row}, ${col})`,
}: DotsAndBoxesBoardProps) {
  const drawnHSet = drawnH ?? EMPTY_SET;
  const drawnVSet = drawnV ?? EMPTY_SET;
  const boxesArr = boxes ?? EMPTY_ARR;
  const boxOwnersMap = boxOwners ?? EMPTY_OBJ;
  const edgeOwnersMap = edgeOwners ?? EMPTY_OBJ;
  // Unique per board instance so the per-box avatar clip paths can't collide
  // with another board on the page (SSR-safe: `useId` is deterministic).
  const uid = useId();
  // Sanitized so it can be spliced into SVG `id`/`url(#...)` references.
  const clipPrefix = uid.replace(/[^a-zA-Z0-9_-]/g, "");

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

/** Stroke color for a drawn edge: the color of the player who drew it, or a
 *  neutral "taken" color when ownership wasn't recorded (legacy rows). */
const ownerColor = (
  owner: string | undefined,
  hostColor: string,
  guestColor: string,
): string => {
  if (owner === "host") return hostColor;
  if (owner === "guest") return guestColor;
  return UNKNOWN_EDGE_COLOR;
};

  return (
    <svg
      data-testid="dnb-board"
      viewBox={`0 0 ${VIEWBOX} ${VIEWBOX}`}
      className="w-full h-auto max-w-[640px] mx-auto select-none touch-manipulation"
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
        /* Ends at DRAWN_STROKE so the animation's fill-forwards state can't
           leave a freshly drawn edge thinner than the settled ones. */
        @keyframes dnb-edge-draw {
          0%   { stroke-width: 0;   opacity: 0; }
          55%  { stroke-width: 7;   opacity: 1; }
          100% { stroke-width: 6;   opacity: 1; }
        }
        @keyframes dnb-box-fill {
          0%   { fill-opacity: 0;    transform: scale(0.55); }
          55%  { fill-opacity: 0.45; transform: scale(1.05); }
          100% { fill-opacity: 0.28; transform: scale(1); }
        }
        @keyframes dnb-mark-pop {
          0%   { opacity: 0; transform: scale(0.4); }
          55%  { opacity: 1; transform: scale(1.15); }
          100% { opacity: 0.95; transform: scale(1); }
        }
        .dnb-edge-anim    { animation: dnb-edge-draw 280ms cubic-bezier(0.22, 1, 0.36, 1) both;
                            will-change: stroke-width, opacity; }
        .dnb-box-anim     { animation: dnb-box-fill 380ms cubic-bezier(0.25, 0.46, 0.45, 0.94) both;
                            transform-box: fill-box; transform-origin: center;
                            will-change: transform, fill-opacity; }
        .dnb-mark-anim    { animation: dnb-mark-pop 420ms cubic-bezier(0.25, 0.46, 0.45, 0.94) 60ms both;
                            transform-box: fill-box; transform-origin: center;
                            will-change: transform, opacity; }
        @media (prefers-reduced-motion: reduce) {
          .dnb-edge-anim, .dnb-box-anim, .dnb-mark-anim { animation: none; will-change: auto; }
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
        const isInteractive = interactive && !drawn;
        const cursorCls = isInteractive ? "cursor-pointer" : "cursor-default";
        // `edgeOwners` is keyed by the canonical engine key, i.e. the type
        // prefix + this orientation's "row,col" key.
        const visible = drawn
          ? ownerColor(edgeOwnersMap[`h:${edge.key}`], player1Color, player2Color)
          : interactive
            ? EMPTY_EDGE_COLOR
            : EMPTY_EDGE_COLOR_DIM;
        return (
          // `group` lets us trigger the visible-line hover state by
          // hovering the larger transparent hit rect above it.
          <g key={`he-${edge.key}`} className={isInteractive ? "group" : undefined}>
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
                <title>{edgeTooltipH(edge.row, edge.col)}</title>
              )}
            </rect>
            <line
              x1={edge.x + 2}
              y1={edge.y + EDGE_HIT / 2}
              x2={edge.x + edgeHWidth - 2}
              y2={edge.y + EDGE_HIT / 2}
              stroke={visible}
              strokeWidth={drawn ? DRAWN_STROKE : interactive ? EMPTY_STROKE : EMPTY_STROKE_DIM}
              strokeLinecap="round"
              className={
                (isNew ? "dnb-edge-anim" : "") +
                (isInteractive
                  ? " transition-all duration-150 group-hover:stroke-slate-200 group-hover:stroke-[4.6] group-hover:opacity-100"
                  : ""
                )
              }
            />
          </g>
        );
      })}

      {/* ── Vertical edges ────────────────────────────────────────── */}
      {verticalEdges.map((edge) => {
        const drawn = drawnVSet.has(edge.key);
        const isNew = drawn && newVKeys.has(edge.key);
        const isInteractive = interactive && !drawn;
        const cursorCls = isInteractive ? "cursor-pointer" : "cursor-default";
        // Same owner-based coloring as the horizontal pass: a line's color
        // answers "who claimed this?", not "which way does it run".
        const visible = drawn
          ? ownerColor(edgeOwnersMap[`v:${edge.key}`], player1Color, player2Color)
          : interactive
            ? EMPTY_EDGE_COLOR
            : EMPTY_EDGE_COLOR_DIM;
        return (
          <g key={`ve-${edge.key}`} className={isInteractive ? "group" : undefined}>
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
                <title>{edgeTooltipV(edge.row, edge.col)}</title>
              )}
            </rect>
            <line
              x1={edge.x + EDGE_HIT / 2}
              y1={edge.y + 2}
              x2={edge.x + EDGE_HIT / 2}
              y2={edge.y + edgeVHeight - 2}
              stroke={visible}
              strokeWidth={drawn ? DRAWN_STROKE : interactive ? EMPTY_STROKE : EMPTY_STROKE_DIM}
              strokeLinecap="round"
              className={
                (isNew ? "dnb-edge-anim" : "") +
                (isInteractive
                  ? " transition-all duration-150 group-hover:stroke-slate-200 group-hover:stroke-[4.6] group-hover:opacity-100"
                  : ""
                )
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
        // Owner mark: the claimer's pfp (official Grynd icon) — or the GRYND
        // logo for the AI seat, which has no users row and therefore never
        // resolves an icon key. `iconAssetUrl` validates the key and falls
        // back to the official default icon, so a legacy/unknown key still
        // renders a mark instead of an empty box.
        const isAiGuest = owner === "guest" && isAiGame;
        const markHref =
          owner === "host" || owner === "guest"
            ? isAiGuest
              ? AI_BOX_ICON_SRC
              : iconAssetUrl(owner === "host" ? hostIconKey : guestIconKey)
            : null;
        const iconX = bx + (BOX_SIZE - BOX_ICON_SIZE) / 2;
        const iconY = by + (BOX_SIZE - BOX_ICON_SIZE) / 2;
        const clipId = `dnb-${clipPrefix}-b${r}-${c}`;
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
              rx={8}
              className={isNew ? "dnb-box-anim" : ""}
              style={
                isNew
                  ? undefined
                  : { transformBox: "fill-box", transformOrigin: "center" }
              }
            />
            {markHref ? (
              <>
                {/* Rounded clip so the square icon artwork sits inside the
                    rounded box without hard corners. Geometry is static, so
                    one clip per claimed box is enough. */}
                <clipPath id={clipId}>
                  <rect
                    x={iconX}
                    y={iconY}
                    width={BOX_ICON_SIZE}
                    height={BOX_ICON_SIZE}
                    rx={BOX_ICON_RADIUS}
                    ry={BOX_ICON_RADIUS}
                  />
                </clipPath>
                <image
                  href={markHref}
                  x={iconX}
                  y={iconY}
                  width={BOX_ICON_SIZE}
                  height={BOX_ICON_SIZE}
                  clipPath={`url(#${clipId})`}
                  // Pfp icons are square (they fill the mark); the GRYND logo
                  // is a wide wordmark, so fit it whole rather than cropping.
                  preserveAspectRatio={
                    isAiGuest ? "xMidYMid meet" : "xMidYMid slice"
                  }
                  className={isNew ? "dnb-mark-anim" : ""}
                  style={{ pointerEvents: "none", userSelect: "none" }}
                />
              </>
            ) : (
              // No recorded owner (should not happen) — keep the legacy glyph
              // so the box still reads as claimed.
              <text
                x={bx + BOX_SIZE / 2}
                y={by + BOX_SIZE / 2 + 6}
                textAnchor="middle"
                fill={fillColor}
                fontSize={20}
                fontWeight={700}
                style={{
                  pointerEvents: "none",
                  userSelect: "none",
                  transformBox: "fill-box",
                  transformOrigin: "center",
                  fillOpacity: 0.95,
                }}
                className={isNew ? "dnb-mark-anim" : ""}
              >
                ?
              </text>
            )}
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
