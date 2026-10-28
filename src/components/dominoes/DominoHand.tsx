"use client";

// src/components/dominoes/DominoHand.tsx
//
// THE VIEWER'S OWN HAND — the row of tiles under the board.
//
// `hand` is the VIEWER's tiles only — the projection the server builds per
// caller. The opponent's hand never reaches this component (it is not in the
// payload at all), so there is nothing here to accidentally render.
//
// ── WHY THE CONTROLS ARE NOT IN HERE ──────────────────────────────────────
//
// The three actions (play on an end, draw, pass) live in the board's right-hand
// SIDEBAR (DominoActions), not under the tiles: they stay in one place on every
// screen size and never move as the hand grows or shrinks. This component owns
// only what belongs to the hand itself — the tiles and their count.
//
// A tile is selectable whenever the board is live and it is the viewer's turn;
// which tiles are PLAYABLE is read off public information plus the viewer's own
// hand (`playOptionsFor` in lib/dominoes/ui) and marked with `is-playable`. That
// is an affordance, not authority — the store re-validates every action inside
// its row-locked transaction, so a stale tab is refused (409) and resynced rather
// than trusted.
//
// ── PICKING A TILE UP (POINTER DEVICES) ───────────────────────────────────
//
// A playable tile is also a drag SOURCE: a mouse or pen can carry it onto an end
// of the chain, which is the gesture a table of dominoes invites. Only a tile that
// really fits an end is draggable (a tile that fits nothing would be a dead
// gesture), and only while the board is accepting input at all.
//
// STARTING A DRAG SELECTS THE TILE. That is not decoration: the board's end chips
// are rendered as tap/drop targets for the SELECTED tile, so picking a tile up is
// what makes the ends it fits light up as places to put it. A drag is therefore
// never a second, parallel notion of "what I am holding" — it is the same one,
// expressed with the pointer.

import DominoTile from "./DominoTile";
import { useTranslation } from "../../hooks/useTranslation";
import {
  DOMINO_DRAG_TYPE,
  playOptionsFor,
  tileLabel,
  type OpenEnds,
} from "../../lib/dominoes/ui";

export type DominoHandProps = {
  hand?: string[] | null;
  /** The viewer's selected tile, or null. Owned by the page. */
  selected?: string | null;
  onSelect?: (tile: string | null) => void;
  openEnds?: OpenEnds;
  chainEmpty?: boolean;
  /** The server's own gate: whose turn it is, and whether the round is on. */
  isViewerTurn?: boolean;
  isLive?: boolean;
  /** A submission is in flight: every control is disabled until it answers. */
  pending?: boolean;
  /** A playable tile was picked up (pointer devices): make it the selection. */
  onDragStart?: (tile: string) => void;
  /** The drag ended — dropped anywhere, or cancelled with Escape. */
  onDragEnd?: () => void;
};

export default function DominoHand({
  hand = [],
  selected = null,
  onSelect,
  openEnds = null,
  chainEmpty = false,
  isViewerTurn = false,
  isLive = true,
  pending = false,
  onDragStart,
  onDragEnd,
}: DominoHandProps) {
  const { t } = useTranslation();
  const tiles = Array.isArray(hand) ? hand : [];
  const options = playOptionsFor(tiles, openEnds, chainEmpty);
  const canSelect = Boolean(isLive) && Boolean(isViewerTurn) && !pending;

  return (
    <section
      className="dominoes-hand"
      data-testid="dominoes-hand"
      data-viewer-turn={isViewerTurn ? "true" : "false"}
      data-selected={selected ?? ""}
      aria-label={t("games.dominoes.your_hand")}
    >
      <div className="dominoes-hand-head">
        <h2 className="dominoes-hand-title">
          {t("games.dominoes.your_hand")}
          <span className="dominoes-hand-count" data-testid="dominoes-hand-count">
            {t(
              tiles.length === 1
                ? "games.dominoes.tiles_count_one"
                : "games.dominoes.tiles_count",
              { count: tiles.length },
            )}
          </span>
        </h2>
      </div>

      {tiles.length === 0 ? (
        <p className="dominoes-hand-empty" data-testid="dominoes-hand-empty">
          {t("games.dominoes.hand_empty")}
        </p>
      ) : (
        <div
          className="dominoes-hand-tiles"
          role="group"
          aria-label={t("games.dominoes.your_tiles")}
        >
          {tiles.map((tile) => {
            const playable = options.some((option) => option.tile === tile);
            // A dead gesture is worse than none: only a tile with somewhere to go
            // can be picked up, and only while the board is accepting input.
            const draggable = playable && canSelect;
            return (
              <DominoTile
                key={tile}
                tile={tile}
                testId="dominoes-hand-tile"
                interactive
                playable={playable && isLive}
                selected={selected === tile}
                disabled={!canSelect}
                onClick={() => onSelect?.(selected === tile ? null : tile)}
                draggable={draggable}
                onDragStart={(event) => {
                  // The tile travels in the payload AND becomes the selection, so
                  // the board's ends light up as the pointer passes over them.
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData(DOMINO_DRAG_TYPE, tile);
                  event.dataTransfer.setData("text/plain", tile);
                  onDragStart?.(tile);
                }}
                onDragEnd={() => onDragEnd?.()}
                label={
                  playable
                    ? t("games.dominoes.tile_playable", { tile: tileLabel(tile) })
                    : t("games.dominoes.tile_not_playable", { tile: tileLabel(tile) })
                }
              />
            );
          })}
        </div>
      )}
    </section>
  );
}
