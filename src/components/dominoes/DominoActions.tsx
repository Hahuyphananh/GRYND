"use client";

// src/components/dominoes/DominoActions.tsx
//
// THE ACTION SIDEBAR — everything a turn can DO, in one place on the right.
//
// ── WHY A SIDEBAR ─────────────────────────────────────────────────────────
//
// The buttons used to sit under the hand, so their position moved every time the
// hand grew or shrank and on a phone they slid off screen as the board scrolled.
// Here they are pinned in their own column next to the table: the open ends, the
// selected tile and the three actions are always in the same spot, at the same
// size, whatever the chain or the hand is doing.
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
// the chain is ambiguous once the line scrolls. Two labelled buttons that print
// the open value they attach to ("Play left · 6") are unambiguous with a mouse, a
// finger or a keyboard, and they are what a screen reader reads out.

import { IconArrowLeft, IconArrowRight } from "@tabler/icons-react";

import DominoTile from "./DominoTile";
import { useTranslation } from "../../hooks/useTranslation";
import {
  availableActions,
  playOptionsFor,
  tileLabel,
  type OpenEnds,
} from "../../lib/dominoes/ui";

export type DominoActionsProps = {
  hand?: string[] | null;
  /** The viewer's selected tile, or null. Owned by the page. */
  selected?: string | null;
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

export default function DominoActions({
  hand = [],
  selected = null,
  onPlay,
  onDraw,
  onPass,
  openEnds = null,
  chainEmpty = false,
  drawPileCount = 0,
  isViewerTurn = false,
  isLive = true,
  pending = false,
}: DominoActionsProps) {
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

  const playButton = (end: "left" | "right", value: number | null) => {
    if (!selected) return null;
    const label = t(end === "left" ? "games.dominoes.play_left" : "games.dominoes.play_right");
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
        {end === "left" ? (
          <IconArrowLeft size={15} className="dominoes-action-arrow" aria-hidden="true" />
        ) : (
          <IconArrowRight size={15} className="dominoes-action-arrow" aria-hidden="true" />
        )}
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
      className="dominoes-side-panel"
      data-testid="dominoes-actions"
      data-viewer-turn={isViewerTurn ? "true" : "false"}
      aria-label={t("games.dominoes.your_move")}
    >
      <h2 className="dominoes-side-title">{t("games.dominoes.your_move")}</h2>

      {/* The two values a tile may be attached to, directly above the buttons
          that attach to them. */}
      <div className="dominoes-side-ends">
        <span
          className="dominoes-side-end is-left"
          data-testid="dominoes-side-open-left"
          aria-hidden={leftValue === null}
        >
          <IconArrowLeft size={13} className="dominoes-side-end-arrow" aria-hidden="true" />
          {leftValue === null ? "—" : leftValue}
        </span>
        <span
          className="dominoes-side-end is-right"
          data-testid="dominoes-side-open-right"
          aria-hidden={rightValue === null}
        >
          {rightValue === null ? "—" : rightValue}
          <IconArrowRight size={13} className="dominoes-side-end-arrow" aria-hidden="true" />
        </span>
      </div>

      <div className="dominoes-side-selected" data-testid="dominoes-selected">
        {selected ? (
          <>
            <DominoTile
              tile={selected}
              testId="dominoes-selected-tile"
              label={tileLabel(selected)}
            />
            <span className="dominoes-side-selected-label">
              {t("games.dominoes.selected_tile")}
            </span>
          </>
        ) : (
          <span className="dominoes-side-selected-label">
            {t("games.dominoes.no_tile_selected")}
          </span>
        )}
      </div>

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

      <p className="dominoes-hint" role="status" aria-live="polite" data-testid="dominoes-hint">
        {t(`games.dominoes.${hintKey}`)}
      </p>
    </section>
  );
}
