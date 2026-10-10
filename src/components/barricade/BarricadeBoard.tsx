"use client";

// src/components/barricade/BarricadeBoard.tsx
//
// The Barricade board. It RENDERS a position; it never decides one.
//
// Everything a player can do here was already decided by the rules engine:
//   * the highlighted destinations are the `legalMoves` the engine offered;
//   * the barricade slots marked legal come from the engine's own generator,
//     and a slot the engine has not cleared yet is drawn neutral;
//   * a click reports the intent (`onMove` / `onPlaceWall`) and the page applies
//     it through `applyAction`, which validates it again.
//
// So there is no second copy of the movement or barricade rules in the UI: if
// the engine would not allow it, this component cannot perform it.
//
// GEOMETRY. The board is one CSS grid of 17 tracks — 9 squares plus the 8
// grooves between them, on each axis. A square occupies a square track; a
// barricade lies IN a groove track and spans the two squares it separates, which
// is why a wall is drawn (and clicked) on the boundary rather than in a cell.
// Row 0 — player1's baseline — is drawn at the BOTTOM, so each player races
// towards the far side of the screen.

import type { CSSProperties } from "react";

import { BOARD_SIZE, ORIENTATIONS, WALL_SLOTS } from "../../lib/barricade/constants";
import { goalRowFor, positionKey, wallKey } from "../../lib/barricade/rules";
import type {
  BarricadeState,
  LegalMoveAction,
  Orientation,
  Position,
  Seat,
  WallPlacement,
} from "../../lib/barricade/types";

export interface BarricadePreview {
  wall: WallPlacement;
  ok: boolean;
  message: string;
}

export interface BarricadeBoardProps {
  /** The authoritative position, straight from the rules engine. */
  state: BarricadeState;
  /** The seat the viewer controls (its pawn, its goal row, its barricades). */
  mySeat: Seat;
  /** The seat to move, per the engine. */
  activeSeat: Seat;
  /** The engine's legal moves for the active seat. */
  moves: readonly LegalMoveAction[];
  /** Barricade mode: grooves become clickable instead of squares. */
  wallMode: boolean;
  /** Which way the barricade the player is about to place faces. */
  orientation: Orientation;
  /**
   * Barricade slots the engine's generator cleared, or `null` while that list is
   * still being computed (slots then render neutral, and the click is validated
   * all the same).
   */
  legalWallKeys: ReadonlySet<string> | null;
  /** The barricade under the cursor / keyboard focus, with the engine's verdict. */
  preview: BarricadePreview | null;
  /** True while the opponent is thinking — the board stops taking input. */
  disabled: boolean;
  onMove: (to: Position) => void;
  onPlaceWall: (wall: WallPlacement) => void;
  onHoverWall: (wall: WallPlacement | null) => void;
}

/** Grid track (1-based) of a square. Row 0 is the bottom row. */
const squareRow = (row: number) => 2 * (BOARD_SIZE - 1 - row) + 1;
const squareColumn = (col: number) => 2 * col + 1;
/** The groove between rows `row` and `row + 1`, and between columns `col`/`col + 1`. */
const horizontalGrooveRow = (row: number) => 2 * (BOARD_SIZE - 1 - row);
const verticalGrooveColumn = (col: number) => 2 * col + 2;

function squareStyle(row: number, col: number): CSSProperties {
  return { gridRow: squareRow(row), gridColumn: squareColumn(col) };
}

function wallStyle(wall: WallPlacement): CSSProperties {
  return wall.orientation === ORIENTATIONS[0]
    ? { gridRow: horizontalGrooveRow(wall.row), gridColumn: `${squareColumn(wall.col)} / span 3` }
    : { gridRow: `${squareRow(wall.row + 1)} / span 3`, gridColumn: verticalGrooveColumn(wall.col) };
}

function squareLabel(position: Position, occupant: "mine" | "theirs" | null, legal: boolean) {
  const where = `Row ${position.row + 1}, column ${position.col + 1}`;
  if (occupant === "mine") return `${where}: your pawn`;
  if (occupant === "theirs") return `${where}: the AI's pawn`;
  if (legal) return `${where}: move your pawn here`;
  return `${where}: empty`;
}

function wallLabel(wall: WallPlacement) {
  const axis = wall.orientation === ORIENTATIONS[0] ? "horizontal" : "vertical";
  return `${axis} barricade between rows ${wall.row + 1} and ${wall.row + 2}, columns ${wall.col + 1} and ${wall.col + 2}`;
}

export default function BarricadeBoard({
  state,
  mySeat,
  activeSeat,
  moves,
  wallMode,
  orientation,
  legalWallKeys,
  preview,
  disabled,
  onMove,
  onPlaceWall,
  onHoverWall,
}: BarricadeBoardProps) {
  const myGoalRow = goalRowFor(mySeat);
  const opponentGoalRow = goalRowFor(mySeat === "player1" ? "player2" : "player1");
  const moveTargets = new Set(moves.map((action) => positionKey(action.to)));
  const lastAction = state.lastAction;
  const lastDestination =
    lastAction && lastAction.action.type === "move" ? positionKey(lastAction.action.to) : null;

  const rows = Array.from({ length: BOARD_SIZE }, (_, index) => index);
  // A barricade lies IN a groove, and there are only 8 of them per axis: slot
  // 8 would sit past the far edge, so the groove controls stop at WALL_SLOTS.
  const slots = Array.from({ length: WALL_SLOTS }, (_, index) => index);
  const isPlaced = (col: number, row: number) =>
    state.walls.some((placed) => placed.col === col && placed.row === row);

  const occupiedBy = (position: Position): "mine" | "theirs" | null => {
    if (positionKey(state.pawns[mySeat]) === positionKey(position)) return "mine";
    const opponent: Seat = mySeat === "player1" ? "player2" : "player1";
    if (positionKey(state.pawns[opponent]) === positionKey(position)) return "theirs";
    return null;
  };

  return (
    <div
      className="barricade-board"
      role="group"
      aria-label={`Barricade board. You play ${mySeat === "player1" ? "blue" : "purple"}.`}
      data-testid="barricade-board"
      data-wall-mode={wallMode ? "true" : "false"}
      data-orientation={orientation}
      data-active-seat={activeSeat}
    >
      {/* ── Squares: where pawns stand and where they may go ───────────── */}
      {rows.map((row) =>
        rows.map((col) => {
          const position: Position = { col, row };
          const key = positionKey(position);
          const occupant = occupiedBy(position);
          const legal = moveTargets.has(key);
          const isMyGoal = row === myGoalRow;
          const isTheirGoal = row === opponentGoalRow;
          const classes = ["barricade-square"];
          if (isMyGoal) classes.push("is-my-goal");
          if (isTheirGoal) classes.push("is-their-goal");
          if (legal) classes.push("is-legal");
          if (occupant) classes.push(occupant === "mine" ? "is-mine" : "is-theirs");
          if (lastDestination === key) classes.push("is-last");
          if (wallMode) classes.push("is-dimmed");
          return (
            <button
              key={key}
              type="button"
              className={classes.join(" ")}
              style={squareStyle(row, col)}
              data-testid="barricade-square"
              data-col={col}
              data-row={row}
              data-occupant={occupant ?? "none"}
              data-legal={legal ? "true" : "false"}
              data-goal={isMyGoal ? "mine" : isTheirGoal ? "theirs" : "none"}
              disabled={disabled}
              tabIndex={disabled || wallMode || (!legal && !occupant) ? -1 : 0}
              aria-label={squareLabel(position, occupant, legal)}
              onClick={() => {
                if (wallMode) return;
                onMove(position);
              }}
            >
              {occupant ? (
                <span
                  className={`barricade-pawn ${occupant === "mine" ? "is-mine" : "is-theirs"}`}
                  aria-hidden="true"
                />
              ) : null}
              {legal && !occupant ? (
                <span className="barricade-move-dot" aria-hidden="true" />
              ) : null}
            </button>
          );
        }),
      )}

      {/* ── Barricades already on the board ────────────────────────────── */}
      {state.walls.map((wall) => (
        <div
          key={wallKey(wall)}
          className={`barricade-wall ${wall.owner === mySeat ? "is-mine" : "is-theirs"}`}
          style={wallStyle(wall)}
          data-testid="barricade-wall"
          data-orientation={wall.orientation}
          data-owner={wall.owner}
          aria-hidden="true"
        />
      ))}

      {/* ── Barricade mode: the grooves become the controls ────────────── */}
      {wallMode
        ? slots.map((row) =>
            slots.map((col) => {
              if (isPlaced(col, row)) return null;
              const wall: WallPlacement = { col, row, orientation };
              const key = wallKey(wall);
              const cleared = legalWallKeys ? legalWallKeys.has(key) : null;
              const isPreviewed = Boolean(
                preview && preview.wall.col === col && preview.wall.row === row,
              );
              const classes = ["barricade-slot"];
              if (cleared === true) classes.push("is-cleared");
              if (cleared === false) classes.push("is-illegal");
              if (isPreviewed) classes.push(preview?.ok ? "is-preview-ok" : "is-preview-invalid");
              return (
                <button
                  key={`slot-${key}`}
                  type="button"
                  className={classes.join(" ")}
                  style={wallStyle(wall)}
                  data-testid="barricade-slot"
                  data-col={col}
                  data-row={row}
                  data-orientation={orientation}
                  data-legal={cleared === null ? "unknown" : cleared ? "true" : "false"}
                  disabled={disabled}
                  aria-label={wallLabel(wall)}
                  onMouseEnter={() => onHoverWall(wall)}
                  onMouseLeave={() => onHoverWall(null)}
                  onFocus={() => onHoverWall(wall)}
                  onBlur={() => onHoverWall(null)}
                  onClick={() => onPlaceWall(wall)}
                />
              );
            }),
          )
        : null}
    </div>
  );
}
