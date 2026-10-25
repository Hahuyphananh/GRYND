"use client";

// src/components/dominoes/DominoChain.tsx
//
// THE SHARED CHAIN — the one piece of the position both seats see, drawn as a
// real table.
//
// It reads the authoritative snapshot and nothing else: `chain` is the engine's
// left-to-right line of played tiles (each with the facing the server resolved)
// and `openEnds` is the two values a tile may be attached to. Nothing here is
// inferred and nothing is optimistic.
//
// ── THE SHAPE OF THE TABLE ────────────────────────────────────────────────
//
// The geometry lives in `src/lib/dominoes/layout.ts` (pure and tested); this file
// only paints it. That module grows a path out of the chain's opening tile:
//
//   * tiles attach on BOTH ends, so a left play widens the table leftwards and a
//     right play widens it rightwards, without the line sliding under the player;
//   * a DOUBLE lies crosswise, as it does on a real table, and hands the chain
//     off at one of its two ends — so the tiles after it run PERPENDICULAR to the
//     run that led in;
//   * a run that gets long turns as well, so the table snakes and grows instead
//     of running off the felt;
//   * no two tiles ever occupy the same square, and no tile ever floats off its
//     neighbour: the path is one connected line.
//
// The surface is sized from the layout in half-tile cells, so the board EXPANDS
// as the chain grows and the viewport scrolls to follow, with the newest tile
// scrolled into view. Both open values stay pinned at the corners of the board,
// so "which ends can I attach to" is answered even when the far end is off
// screen.
//
// ── WHERE THE LAST TILE WENT ──────────────────────────────────────────────
//
// The engine records the end every accepted play was attached to (`end`), and
// the last element of `chain` is the last tile played. A small marker above that
// tile names the side, so a player who looked away (or came back mid-match) can
// see which end just moved without reading the whole line.
//
// ── ANIMATION ─────────────────────────────────────────────────────────────
//
// Only the newest tile animates — it is DROPPED onto the felt and settles, for
// either seat, since it is the newest tile of the chain whichever player laid
// it. It then keeps a thin ring, so the last move stays findable. Placement
// carries information, so the cue is restrained, and it is disabled entirely
// under `prefers-reduced-motion: reduce` in globals.css: no transforms, no fade,
// the tile simply appears.

import { useEffect, useMemo, useRef } from "react";
import { IconArrowLeft, IconArrowRight } from "@tabler/icons-react";

import DominoTile from "./DominoTile";
import { layoutChain, type ChainTileLike as LayoutChainTileLike } from "../../lib/dominoes/layout";
import { tileLabel } from "../../lib/dominoes/ui";
import { useTranslation } from "../../hooks/useTranslation";

/** One tile of the engine's chain, as the projection sends it. */
export type ChainTileLike = LayoutChainTileLike & {
  left?: unknown;
  right?: unknown;
  seat?: unknown;
};

export type DominoChainProps = {
  chain?: ChainTileLike[] | null;
  /** The two values the next tile must match; `null` before the chain opens. */
  openEnds?: { left?: number | null; right?: number | null } | null;
  /** Live match? A finished board keeps its last position, dimmed by CSS. */
  isLive?: boolean;
};

/** A facing half as a number, or null when the projection did not carry one. */
function valueOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export default function DominoChain({
  chain = [],
  openEnds = null,
  isLive = true,
}: DominoChainProps) {
  const { t } = useTranslation();
  const tiles = useMemo(() => (Array.isArray(chain) ? chain : []), [chain]);
  const newest = tiles.length > 0 ? tiles[tiles.length - 1] : null;
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  // One layout per chain. Every tile is placed in half-tile cells, so the surface
  // grows in both directions as the table does.
  const layout = useMemo(() => layoutChain(tiles), [tiles]);
  // The newest tile is the last INDEX in the engine's order, which is not
  // necessarily the last entry the layout emits — but it is always the tile with
  // the highest index, so it is the one flagged latest below.
  const newestIndex = tiles.length - 1;

  // Follow the newest tile as the chain grows (including after a reconnect, when
  // the whole table arrives at once and the end is what matters). `block` and
  // `inline` are both "nearest", so the page around the board never jumps.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || tiles.length === 0) return;
    const latest = scroller.querySelector<HTMLElement>('[data-domino-latest="1"]');
    if (!latest) return;
    if (typeof latest.scrollIntoView !== "function") return;
    latest.scrollIntoView({ block: "nearest", inline: "nearest" });
    // Only when the chain LENGTH changes: a re-render for the countdown must not
    // keep re-scrolling under the player's finger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tiles.length]);

  const left = openEnds?.left ?? null;
  const right = openEnds?.right ?? null;
  // The end the newest tile was attached to, or null when the engine did not
  // record one. The opening tile records "left" (it opens the line), and there
  // is no side to report on a one-tile chain, so the marker waits for a second
  // tile before it appears.
  const lastEnd =
    tiles.length > 1 && (newest?.end === "left" || newest?.end === "right")
      ? newest.end
      : null;

  /** Cells → CSS length. One cell is half a tile, which is `--dm-half`. */
  const cells = (count: number) => `calc(var(--dm-half) * ${count})`;

  return (
    <div
      className="dominoes-chain"
      data-testid="dominoes-chain"
      data-chain-length={tiles.length}
      data-live={isLive ? "true" : "false"}
      data-cols={layout.cols}
      data-rows={layout.rows}
    >
      <div className="dominoes-chain-scroller" ref={scrollerRef}>
        {tiles.length === 0 ? (
          <p className="dominoes-chain-empty" data-testid="dominoes-chain-empty">
            {t("games.dominoes.chain_empty")}
          </p>
        ) : (
          <div
            className="dominoes-chain-surface"
            role="list"
            data-testid="dominoes-chain-surface"
            aria-label={t(
              tiles.length === 1
                ? "games.dominoes.chain_aria_one"
                : "games.dominoes.chain_aria",
              { count: tiles.length },
            )}
            style={{
              width: cells(Math.max(layout.cols, 2)),
              height: cells(Math.max(layout.rows, 2)),
            }}
          >
            {layout.tiles.map((placed) => {
              const tile = tiles[placed.index];
              const isLatest = placed.index === newestIndex;
              const seat =
                tile?.seat === "player1" || tile?.seat === "player2" ? tile.seat : null;
              const facedLeft = valueOf(tile?.left);
              const facedRight = valueOf(tile?.right);
              return (
                <span
                  key={`${String(tile?.id ?? "tile")}-${placed.index}`}
                  className="dominoes-chain-slot"
                  // The slot is a square box centred on the tile, so the marker
                  // above it stays upright while the tile itself is rotated.
                  style={{
                    left: cells(placed.cx - layout.minX - 1),
                    top: cells(placed.cy - layout.minY - 1),
                    width: cells(2),
                    height: cells(2),
                  }}
                  data-domino-latest={isLatest ? "1" : undefined}
                  data-rotation={placed.rotation}
                  data-direction={placed.direction}
                  data-double={placed.isDouble ? "true" : "false"}
                  role="listitem"
                >
                  {isLatest && lastEnd ? (
                    <span
                      className="dominoes-last-marker"
                      data-testid="dominoes-last-marker"
                      data-end={lastEnd}
                      role="note"
                      aria-label={t(
                        lastEnd === "left"
                          ? "games.dominoes.last_play_aria_left"
                          : "games.dominoes.last_play_aria_right",
                      )}
                    >
                      {lastEnd === "left" ? (
                        <IconArrowLeft size={12} aria-hidden="true" />
                      ) : null}
                      <span aria-hidden="true">
                        {t(
                          lastEnd === "left"
                            ? "games.dominoes.side_left"
                            : "games.dominoes.side_right",
                        )}
                      </span>
                      {lastEnd === "right" ? (
                        <IconArrowRight size={12} aria-hidden="true" />
                      ) : null}
                    </span>
                  ) : null}
                  <span
                    className={`dominoes-chain-tile-box ${isLatest ? "is-latest" : ""}`}
                    style={{ transform: `translate(-50%, -50%) rotate(${placed.rotation}deg)` }}
                  >
                    <DominoTile
                      tile={String(tile?.id ?? "")}
                      left={facedLeft}
                      right={facedRight}
                      seat={seat}
                      isNew={isLatest}
                      testId="dominoes-chain-tile"
                      // The name follows the FACE, so what is announced is what
                      // is drawn: a tile attached the other way round is "3–6".
                      label={tileLabel(
                        facedLeft !== null && facedRight !== null
                          ? `${facedLeft}-${facedRight}`
                          : tile?.id,
                      )}
                    />
                  </span>
                </span>
              );
            })}
          </div>
        )}
      </div>

      {/* The two open values, pinned at the corners of the BOARD (not of the
          line), so a long or snaking chain scrolling underneath never hides
          which ends are playable. */}
      {tiles.length > 0 ? (
        <>
          <span
            className="dominoes-end-chip is-left"
            data-testid="dominoes-open-left"
            aria-hidden={left === null}
          >
            {left === null ? null : (
              <>
                <IconArrowLeft size={13} aria-hidden="true" />
                {left}
              </>
            )}
          </span>
          <span
            className="dominoes-end-chip is-right"
            data-testid="dominoes-open-right"
            aria-hidden={right === null}
          >
            {right === null ? null : (
              <>
                {right}
                <IconArrowRight size={13} aria-hidden="true" />
              </>
            )}
          </span>
        </>
      ) : null}
    </div>
  );
}
