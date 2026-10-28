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
// ── PLACING A TILE BY TAPPING AN END ──────────────────────────────────────
//
// The two open-value chips are pinned at the board's corners, so they are where
// a player's eye already is when deciding a move — which makes them the natural
// target for "put the selected tile HERE". When the caller says the selected
// tile fits an end (`tappableEnds`), that chip becomes a real `<button>` that
// reports the placement upwards; when it does not fit, the chip stays the plain
// value badge it has always been, so the board never offers a target the engine
// would refuse. The sidebar's Play-left / Play-right buttons remain, unchanged:
// the board is a second way to say the same thing, not a replacement for it.
//
// WHAT THE CHIP IS NOT: it does not decide anything. `tappableEnds` is the
// caller's read of the same public information the sidebar uses, and the action
// it reports is the action a client may only ever send — `{ type: "play", tile,
// end }` — which the store re-validates inside its row lock.
//
// ── DROPPING A TILE ONTO THE TABLE ────────────────────────────────────────
//
// The chip is a small target at the corner of the board, and the gesture players
// actually make is to carry a tile over and put it down NEXT TO the dominoes. So
// the felt itself is the drop target: the chain end(s) the tile in hand fits are
// ringed (`is-drop-target`), the one under the pointer brightens
// (`is-drop-over`), and a drop anywhere over the felt places the tile on the end
// it was aimed at. Which end that is comes from the tile under the pointer, or —
// when the chain takes the tile on one side only — from the fact that there is
// only one place it can go.
//
// The drop only accepts OUR payload (`DOMINO_DRAG_TYPE`), so a file or a link
// dragged across the board is never mistaken for a tile, and it reports the same
// `onPlace(end)` a tap does. Nothing is ever optimistically placed: the tile
// appears when the server's snapshot says it did.
//
// ── ANIMATION ─────────────────────────────────────────────────────────────
//
// Only the newest tile animates — it is DROPPED onto the felt and settles, for
// either seat, since it is the newest tile of the chain whichever player laid
// it. It then keeps a thin ring, so the last move stays findable. Placement
// carries information, so the cue is restrained, and it is disabled entirely
// under `prefers-reduced-motion: reduce` in globals.css: no transforms, no fade,
// the tile simply appears.

import { useEffect, useMemo, useRef, type DragEvent as ReactDragEvent } from "react";
import { IconArrowLeft, IconArrowRight } from "@tabler/icons-react";

import DominoTile from "./DominoTile";
import { layoutChain, type ChainTileLike as LayoutChainTileLike } from "../../lib/dominoes/layout";
import { DOMINO_DRAG_TYPE, tileLabel, type ChainEnd } from "../../lib/dominoes/ui";
import { useTranslation } from "../../hooks/useTranslation";

/** The two ends, in the order the board reads them. */
const CHAIN_ENDS: readonly ChainEnd[] = ["left", "right"];

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
  /** The viewer's selected tile, named in a tappable end's accessible label. */
  selected?: string | null;
  /**
   * The ends the SELECTED tile may be placed on — empty whenever there is no
   * selection, it is not the viewer's turn, a submission is in flight, or the
   * tile fits nothing. A chip in this list becomes tappable; no other does.
   */
  tappableEnds?: readonly ChainEnd[] | null;
  /** Place the selected tile on `end`. Only ever reachable for a tappable end. */
  onPlace?: (end: ChainEnd) => void;
  /**
   * The end a dragged hand tile is currently hovering over, or null. Owned by the
   * board, not by this file: the chain paints the highlight it is told to paint.
   */
  dropOverEnd?: ChainEnd | null;
  /** A dragged tile entered an end that would accept it. */
  onDragEnterEnd?: (end: ChainEnd) => void;
  /** It left again (or the drag ended somewhere else, including a cancel). */
  onDragLeaveEnd?: (end: ChainEnd) => void;
};

/** A facing half as a number, or null when the projection did not carry one. */
function valueOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export default function DominoChain({
  chain = [],
  openEnds = null,
  isLive = true,
  selected = null,
  tappableEnds = null,
  onPlace,
  dropOverEnd = null,
  onDragEnterEnd,
  onDragLeaveEnd,
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
  // Ends that may be tapped right now. A tappable end with no open value cannot
  // exist (the chip is not offered at all), so the two are checked together.
  const canTap = (end: ChainEnd, value: number | null) =>
    value !== null && Array.isArray(tappableEnds) && tappableEnds.includes(end);

  /** Ends that would take the tile in hand right now (none without a selection). */
  const acceptingEnds = CHAIN_ENDS.filter((end) => canTap(end, end === "left" ? left : right));

  /**
   * Which end a dragged tile is over.
   *
   * The felt is the target, not the two corner chips: a player drops a tile NEXT
   * TO the dominoes, so the whole table has to answer. The end under the pointer
   * wins when its own tile is hit; a chain that accepts on one side only takes
   * every drop; and a chain that accepts on both (an opening double, or a value
   * that appears at both ends) is split down the middle of the felt, which is the
   * side the player is aiming at.
   *
   * Nothing here decides legality: `acceptingEnds` is the caller's read of the
   * same `playOptionsFor` the sidebar uses, and the action it reports is the one
   * action a client may send — the store re-validates it inside its row lock.
   */
  const endFromDrag = (event: ReactDragEvent<HTMLElement>): ChainEnd | null => {
    if (acceptingEnds.length === 0) return null;
    const under = (event.target as HTMLElement | null)
      ?.closest?.("[data-drop-end]")
      ?.getAttribute("data-drop-end");
    if ((under === "left" || under === "right") && acceptingEnds.includes(under)) return under;
    if (acceptingEnds.length === 1) return acceptingEnds[0];
    const scroller = scrollerRef.current;
    if (!scroller) return acceptingEnds[0];
    const box = scroller.getBoundingClientRect();
    return event.clientX < box.left + box.width / 2 ? "left" : "right";
  };

  /**
   * Is this drag carrying a hand tile?
   *
   * Checked during the gesture, so a file or a link dragged over the board is not
   * offered a place to land; the drop re-checks the payload itself, which is
   * where the authoritative answer lives. Safari hides custom types during
   * dragover ("protected mode") but exposes them at drop, so the gesture check
   * also accepts the plain-text payload the hand sets alongside its own type.
   */
  const isTileDrag = (transfer: DataTransfer | null) => {
    if (!transfer) return false;
    const types = Array.from(transfer.types ?? []);
    if (types.includes(DOMINO_DRAG_TYPE)) return true;
    return types.length === 1 && types[0] === "text/plain";
  };

  // The felt's own drop handling. `preventDefault` is what makes the table a drop
  // target at all, and the highlight is set on ENTER as well as on every dragover,
  // so it appears the moment the tile crosses onto the felt rather than on the
  // browser's next dragover tick. The drop reports the same `onPlace(end)` a tap
  // does, so drag and tap can never diverge.
  const hoverEnd = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!isTileDrag(event.dataTransfer)) return;
    const end = endFromDrag(event);
    if (!end) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    if (end !== dropOverEnd) onDragEnterEnd?.(end);
  };

  const feltDropProps = {
    onDragEnter: hoverEnd,
    onDragOver: hoverEnd,
    // NO `dragleave` HERE. Chromium reports `relatedTarget: null` for a pointer
    // that has merely moved onto one of the felt's own children, so a leave
    // handler cannot tell "over a chain tile" from "off the table" — and the
    // wrong guess clears the highlight the player is following. The gesture's own
    // `dragend` clears it instead, and entering the other end replaces it.
    onDrop: (event: ReactDragEvent<HTMLDivElement>) => {
      const end = endFromDrag(event);
      if (!end) return;
      // Whatever was dropped, the browser must not act on it (a file dropped on a
      // page navigates to it) — but only OUR payload is a tile.
      event.preventDefault();
      const tile = event.dataTransfer?.getData(DOMINO_DRAG_TYPE) ?? "";
      if (!tile) return;
      onDragLeaveEnd?.(end);
      onPlace?.(end);
    },
  };

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

  /**
   * One open-value chip: a placement BUTTON when the selected tile fits this end,
   * the plain value badge otherwise.
   *
   * Both shapes carry the same test id, class and printed value, so which one is
   * on the board is a statement about what the player may do right now — not
   * about what the board looks like.
   */
  const endChip = (end: ChainEnd, value: number | null) => {
    const side = end === "left" ? "is-left" : "is-right";
    const testId = end === "left" ? "dominoes-open-left" : "dominoes-open-right";
    const hovered = dropOverEnd === end;
    const arrow =
      end === "left" ? (
        <IconArrowLeft size={13} aria-hidden="true" />
      ) : (
        <IconArrowRight size={13} aria-hidden="true" />
      );

    if (value === null || !canTap(end, value)) {
      return (
        <span
          className={`dominoes-end-chip ${side}`}
          data-testid={testId}
          data-domino-end={end}
          data-tappable="false"
          // No target, and deliberately no `dragover` handling: the browser shows
          // its own "cannot drop here" cursor and the drop is discarded.
          data-drop-target="false"
          aria-hidden={value === null}
        >
          {value === null ? null : (
            <>
              {end === "left" ? arrow : null}
              {value}
              {end === "left" ? null : arrow}
            </>
          )}
        </span>
      );
    }

    // A placement target: tappable, and the drop target for a dragged tile. Both
    // arrive at the same `onPlace(end)`, so a tap and a drop cannot diverge.
    return (
      <button
        type="button"
        className={`dominoes-end-chip ${side} is-tappable ${hovered ? "is-drop-over" : ""}`}
        data-testid={testId}
        data-domino-end={end}
        data-tappable="true"
        data-drop-target="true"
        data-drop-over={hovered ? "true" : "false"}
        aria-label={t("games.dominoes.place_on_end_aria", {
          tile: tileLabel(selected),
          end: t(end === "left" ? "games.dominoes.side_left" : "games.dominoes.side_right"),
          value,
        })}
        onClick={() => onPlace?.(end)}
        onDragEnter={(event) => {
          // Entering is enough to accept: this chip is rendered only while the
          // SELECTED (i.e. picked-up) tile fits this end.
          event.preventDefault();
          onDragEnterEnd?.(end);
        }}
        onDragOver={(event) => {
          // preventDefault marks the element as a valid drop target for the
          // gesture; without it the browser refuses the drop outright.
          event.preventDefault();
          if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
        }}
        onDragLeave={(event) => {
          // Moving onto one of the chip's own children is not leaving it.
          const next = event.relatedTarget as Node | null;
          if (next && event.currentTarget.contains(next)) return;
          onDragLeaveEnd?.(end);
        }}
        onDrop={(event) => {
          event.preventDefault();
          onDragLeaveEnd?.(end);
          onPlace?.(end);
        }}
      >
        {end === "left" ? arrow : null}
        {value}
        {end === "left" ? null : arrow}
      </button>
    );
  };

  return (
    <div
      className="dominoes-chain"
      data-testid="dominoes-chain"
      data-chain-length={tiles.length}
      data-live={isLive ? "true" : "false"}
      data-cols={layout.cols}
      data-rows={layout.rows}
    >
      <div className="dominoes-chain-scroller" ref={scrollerRef} {...feltDropProps}>
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
              // The end(s) this tile owns: the first tile is the LEFT end and the
              // newest is the RIGHT end (a one-tile chain is both). A tile is a
              // drop target only while the tile in hand really fits that end, so
              // the highlight can never invite a placement the engine refuses.
              const tileEnds = acceptingEnds.filter((end) =>
                end === "left" ? placed.index === 0 : placed.index === newestIndex,
              );
              const isDropTarget = tileEnds.length > 0;
              const isDropOver =
                isDropTarget && dropOverEnd !== null && tileEnds.includes(dropOverEnd);
              return (
                <span
                  key={`${String(tile?.id ?? "tile")}-${placed.index}`}
                  className={[
                    "dominoes-chain-slot",
                    isDropTarget ? "is-drop-target" : "",
                    isDropOver ? "is-drop-over" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  data-drop-end={tileEnds.length === 1 ? tileEnds[0] : undefined}
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
          which ends are playable. An end the selected tile fits is also the
          tap target that places it, and only that end is. */}
      {tiles.length > 0 ? (
        <>
          {endChip("left", left)}
          {endChip("right", right)}
        </>
      ) : null}
    </div>
  );
}
