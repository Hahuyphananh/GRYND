"use client";

// src/components/dominoes/DominoHand.tsx
//
// THE VIEWER'S OWN HAND, and the three things a turn can be.
//
// `hand` is the VIEWER's tiles only — the projection the server builds per
// caller. The opponent's hand never reaches this component (it is not in the
// payload at all), so there is nothing here to accidentally render.
//
// ── THE CONTROLS ARE INTENT, NEVER OUTCOME ────────────────────────────────
//
//   play → `{ action: { type: "play", tile, end? }, expectedVersion }`
//   draw → `{ action: { type: "draw" }, expectedVersion }`
//   pass → `{ action: { type: "pass" }, expectedVersion }`
//
// No hand, no chain, no end value, no turn owner, no winner and no result is
// ever sent — the store derives all of it and refuses anything else.
//
// Which controls are ENABLED is read off public information plus the viewer's own
// hand (`playOptionsFor` / `availableActions` in lib/dominoes/ui): a tile that
// fits neither open end gets no placement button, drawing is offered only while
// nothing is playable and the pile has tiles, and passing only once the pile is
// empty. That is an affordance, not authority — the store re-validates every
// action inside its row-locked transaction, so a stale tab is refused (409) and
// resynced rather than trusted.
//
// ── WHY THE END BUTTONS ARE SEPARATE ──────────────────────────────────────
//
// A play needs to know WHICH end, and letting the player tap the physical end on
// the chain is ambiguous once the chain wraps on a phone. Two labelled buttons
// that print the open value they attach to ("Play left · 6") are unambiguous with
// a mouse, a finger or a keyboard, and they are what a screen reader reads out.

import DominoTile from "./DominoTile";
import { useTranslation } from "../../hooks/useTranslation";
import {
  availableActions,
  playOptionsFor,
  tileLabel,
  type OpenEnds,
} from "../../lib/dominoes/ui";

export type DominoHandProps = {
  hand?: string[] | null;
  /** The viewer's selected tile, or null. Owned by the page. */
  selected?: string | null;
  onSelect?: (tile: string | null) => void;
  onPlay?: (tile: string, end?: "left" | "right") => void;
  onDraw?: () => void;
  onPass?: () => void;
  openEnds?: OpenEnds;
  chainEmpty?: boolean;
  drawPileCount?: number;
  /** The server's own gate: whose turn it is, and whether the round is on. */
  isViewerTurn?: boolean;
  isLive?: boolean;
  /** A submission is in flight: every control is disabled until it answers. */
  pending?: boolean;
};

export default function DominoHand({
  hand = [],
  selected = null,
  onSelect,
  onPlay,
  onDraw,
  onPass,
  openEnds = null,
  chainEmpty = false,
  drawPileCount = 0,
  isViewerTurn = false,
  isLive = true,
  pending = false,
}: DominoHandProps) {
  const { t } = useTranslation();
  const tiles = Array.isArray(hand) ? hand : [];
  const options = playOptionsFor(tiles, openEnds, chainEmpty);
  const actions = availableActions({
    hand: tiles,
    openEnds,
    chainEmpty,
    drawPileCount,
    isViewerTurn,
  });

  const selectedEnds = selected
    ? (options.find((option) => option.tile === selected)?.ends ?? [])
    : [];
  const canSubmit = Boolean(isLive) && Boolean(isViewerTurn) && !pending;
  const leftValue = openEnds?.left ?? null;
  const rightValue = openEnds?.right ?? null;

  // One sentence explaining the current control state. Kept short because it is
  // announced on every turn change (`role="status"`).
  let hintKey: string;
  if (!isLive) hintKey = "hint_round_over";
  else if (pending) hintKey = "hint_sending";
  else if (!isViewerTurn) hintKey = "hint_waiting_opponent";
  else if (selected && selectedEnds.length > 0) {
    hintKey = chainEmpty ? "hint_opens_chain" : "hint_choose_end";
  } else if (selected) hintKey = "hint_no_fit";
  else if (options.length > 0) hintKey = "hint_select";
  else if (actions.canDraw) hintKey = "hint_draw";
  else hintKey = "hint_pass";
  const hint = t(`games.dominoes.${hintKey}`);

  const playButton = (end: "left" | "right", value: number | null) => {
    if (!selected) return null;
    const label = t(
      end === "left" ? "games.dominoes.play_left" : "games.dominoes.play_right",
    );
    const disabled = !canSubmit || !selectedEnds.includes(end);
    return (
      <button
        key={end}
        type="button"
        className={`dominoes-action-button is-${end}`}
        data-testid={`dominoes-play-${end}`}
        disabled={disabled}
        aria-label={
          value === null
            ? t("games.dominoes.play_tile_aria", { end: label, tile: tileLabel(selected) })
            : t("games.dominoes.play_end_aria", { end: label, value })
        }
        onClick={() => onPlay?.(selected, end)}
      >
        <span aria-hidden="true">{end === "left" ? "◀" : "▶"}</span>
        <span className="dominoes-action-label">{label}</span>
        {value === null ? null : (
          <span className="dominoes-action-value" aria-hidden="true">
            {value}
          </span>
        )}
      </button>
    );
  };

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
        <div className="dominoes-hand-tiles" role="group" aria-label={t("games.dominoes.your_tiles")}>
          {tiles.map((tile) => {
            const playable = options.some((option) => option.tile === tile);
            return (
              <DominoTile
                key={tile}
                tile={tile}
                testId="dominoes-hand-tile"
                interactive
                playable={playable && isLive}
                selected={selected === tile}
                disabled={!canSubmit}
                onClick={() => onSelect?.(selected === tile ? null : tile)}
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

      <div className="dominoes-controls" data-testid="dominoes-controls">
        {selected && chainEmpty ? (
          <button
            type="button"
            className="dominoes-action-button is-open"
            data-testid="dominoes-play-open"
            disabled={!canSubmit || selectedEnds.length === 0}
            aria-label={t("games.dominoes.play_open_aria", { tile: tileLabel(selected) })}
            onClick={() => onPlay?.(selected)}
          >
            <span className="dominoes-action-label">
              {t("games.dominoes.play_open", { tile: tileLabel(selected) })}
            </span>
          </button>
        ) : (
          <>
            {playButton("left", leftValue)}
            {playButton("right", rightValue)}
          </>
        )}

        <button
          type="button"
          className="dominoes-action-button is-secondary"
          data-testid="dominoes-draw"
          disabled={!canSubmit || !actions.canDraw}
          aria-label={
            actions.canDraw
              ? t("games.dominoes.draw_aria", { count: drawPileCount })
              : t("games.dominoes.draw_disabled")
          }
          onClick={() => onDraw?.()}
        >
          <span className="dominoes-action-label">{t("games.dominoes.draw")}</span>
          <span className="dominoes-action-value" aria-hidden="true">
            {drawPileCount}
          </span>
        </button>

        <button
          type="button"
          className="dominoes-action-button is-secondary"
          data-testid="dominoes-pass"
          disabled={!canSubmit || !actions.canPass}
          aria-label={
            actions.canPass
              ? t("games.dominoes.pass_turn")
              : t("games.dominoes.pass_disabled")
          }
          onClick={() => onPass?.()}
        >
          <span className="dominoes-action-label">{t("games.dominoes.pass")}</span>
        </button>
      </div>

      <p
        className="dominoes-hint"
        role="status"
        aria-live="polite"
        data-testid="dominoes-hint"
      >
        {hint}
      </p>
    </section>
  );
}
