"use client";

// src/components/dominoes/DominoChain.tsx
//
// THE SHARED CHAIN — the one piece of the position both seats see.
//
// It is read straight from the authoritative snapshot: `chain` is the engine's
// left-to-right line of already-played tiles (each with the orientation the
// server resolved), and `openEnds` is the two values a tile may be attached to.
// Nothing here is inferred, and nothing is optimistic.
//
// ── GROWTH, WRAPPING AND SMALL SCREENS ────────────────────────────────────
//
// A chain grows in BOTH directions: the engine PREPENDS a tile attached to the
// left end and APPENDS one attached to the right (see `applyAction` — the array
// is the line, so appending a left-hand tile would make `openEndsOf` read the
// wrong end). This renders the array in exactly that order, left to right.
//
// A full 28-tile line cannot fit any phone. Rather than shrinking the tiles into
// unreadability or forcing a horizontal scroll that hides the far end, the line
// WRAPS: it reads left-to-right, top-to-bottom, and the container scrolls
// vertically once the chain outgrows the space reserved for it. Both open values
// are always printed in chips at the ends, so "which ends can I attach to" is
// answered even when the far end has wrapped out of view.
//
// ── ANIMATION ─────────────────────────────────────────────────────────────
//
// Only the newest tile animates in (a short scale/opacity fade). Placement is
// information-carrying, so the cue is restrained and the whole thing is disabled
// under `prefers-reduced-motion: reduce` in globals.css — no transforms, no
// transition, the tile simply appears.

import { useEffect, useRef } from "react";

import DominoTile from "./DominoTile";
import { tileLabel } from "../../lib/dominoes/ui";
import { useTranslation } from "../../hooks/useTranslation";

/** One tile of the engine's chain, as the projection sends it. */
export type ChainTileLike = {
  id?: unknown;
  end?: unknown;
  left?: unknown;
  right?: unknown;
  isDouble?: unknown;
  seat?: unknown;
};

export type DominoChainProps = {
  chain?: ChainTileLike[] | null;
  /** The two values the next tile must match; `null` before the chain opens. */
  openEnds?: { left?: number | null; right?: number | null } | null;
  /** Live match? A finished board keeps its last position, dimmed by CSS. */
  isLive?: boolean;
};

export default function DominoChain({
  chain = [],
  openEnds = null,
  isLive = true,
}: DominoChainProps) {
  const { t } = useTranslation();
  const tiles = Array.isArray(chain) ? chain : [];
  const newest = tiles.length > 0 ? tiles[tiles.length - 1] : null;
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  // Follow the newest tile as the chain grows (including after a reconnect, when
  // the whole line arrives at once and the end is what matters). A wrapped
  // chain scrolls vertically, so "nearest" is enough and never yanks the page.
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

  return (
    <div className="dominoes-chain-wrap">
      <div
        ref={scrollerRef}
        className="dominoes-chain"
        data-testid="dominoes-chain"
        data-chain-length={tiles.length}
        data-live={isLive ? "true" : "false"}
        role="list"
        aria-label={
          tiles.length === 0
            ? t("games.dominoes.chain_aria_empty")
            : t(
                tiles.length === 1
                  ? "games.dominoes.chain_aria_one"
                  : "games.dominoes.chain_aria",
                { count: tiles.length },
              )
        }
      >
        {tiles.length === 0 ? (
          <p className="dominoes-chain-empty" data-testid="dominoes-chain-empty">
            {t("games.dominoes.chain_empty")}
          </p>
        ) : (
          <>
            <span
              className="dominoes-end-chip is-left"
              data-testid="dominoes-open-left"
              aria-hidden={left === null}
            >
              {left === null ? "" : `◀ ${left}`}
            </span>

            {tiles.map((tile, index) => {
              const isLatest = index === tiles.length - 1;
              const seat = tile?.seat === "player1" || tile?.seat === "player2" ? tile.seat : null;
              return (
                <span
                  key={`${String(tile?.id ?? "tile")}-${index}`}
                  className="dominoes-chain-slot"
                  data-domino-latest={isLatest ? "1" : undefined}
                  role="listitem"
                >
                  <DominoTile
                    tile={String(tile?.id ?? "")}
                    seat={seat}
                    isNew={newest === tile}
                    testId="dominoes-chain-tile"
                    label={tileLabel(tile?.id)}
                  />
                </span>
              );
            })}

            <span
              className="dominoes-end-chip is-right"
              data-testid="dominoes-open-right"
              aria-hidden={right === null}
            >
              {right === null ? "" : `${right} ▶`}
            </span>
          </>
        )}
      </div>
    </div>
  );
}
