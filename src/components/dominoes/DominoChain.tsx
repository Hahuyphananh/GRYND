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
// ── WHERE THE LAST TILE WENT ──────────────────────────────────────────────
//
// The engine records the end every accepted play was attached to (`end`), and
// the last element of `chain` is the last tile played. A small marker above that
// tile names the side, so a player who looked away (or came back to a board
// mid-match) can see which end just moved without reading the whole line. It is
// drawn with the app's icons, not text arrows, to match the rest of the board.
//
// ── THE LINE GROWS LIKE A REAL TABLE ──────────────────────────────────────
//
// A chain grows in BOTH directions: the engine PREPENDS a tile attached to the
// left end and APPENDS one attached to the right (see `applyAction` — the array
// is the line, so appending a left-hand tile would make `openEndsOf` read the
// wrong end). This renders one continuous row in exactly that order, so a tile
// played on the left widens the line to the left and one on the right widens it
// to the right, the way the tiles actually spread on a table.
//
// The row is NOT wrapped into a block of rows and it is not squeezed to fit: it
// keeps growing and the board scrolls along it, with the newest tile scrolled
// into view. Both open values are pinned as chips at the two edges of the board
// (sticky, so they stay visible while the line scrolls), which answers "which
// ends can I attach to" even when the far end of a long chain is off screen.
//
// ── ANIMATION ─────────────────────────────────────────────────────────────
//
// Only the newest tile animates in (a short scale/opacity fade). Placement is
// information-carrying, so the cue is restrained and the whole thing is disabled
// under `prefers-reduced-motion: reduce` in globals.css — no transforms, no
// transition, the tile simply appears.

import { useEffect, useRef } from "react";
import { IconArrowLeft, IconArrowRight } from "@tabler/icons-react";

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
  const tiles = Array.isArray(chain) ? chain : [];
  const newest = tiles.length > 0 ? tiles[tiles.length - 1] : null;
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  // Follow the newest tile as the chain grows (including after a reconnect, when
  // the whole line arrives at once and the end is what matters). The line is one
  // long row, so this scrolls the board horizontally to whichever end the tile
  // landed on — and `inline: "nearest"` never yanks the page itself.
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
              {left === null ? null : (
                <>
                  <IconArrowLeft size={13} aria-hidden="true" />
                  {left}
                </>
              )}
            </span>

            {tiles.map((tile, index) => {
              const isLatest = index === tiles.length - 1;
              const seat =
                tile?.seat === "player1" || tile?.seat === "player2" ? tile.seat : null;
              const facedLeft = valueOf(tile?.left);
              const facedRight = valueOf(tile?.right);
              return (
                <span
                  key={`${String(tile?.id ?? "tile")}-${index}`}
                  className="dominoes-chain-slot"
                  data-domino-latest={isLatest ? "1" : undefined}
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
                  <DominoTile
                    tile={String(tile?.id ?? "")}
                    left={facedLeft}
                    right={facedRight}
                    seat={seat}
                    isNew={newest === tile}
                    testId="dominoes-chain-tile"
                    // The name follows the FACE, so what is announced is what is
                    // drawn: a tile attached the other way round is "3–6" here.
                    label={tileLabel(
                      facedLeft !== null && facedRight !== null
                        ? `${facedLeft}-${facedRight}`
                        : tile?.id,
                    )}
                  />
                </span>
              );
            })}

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
        )}
      </div>
    </div>
  );
}
