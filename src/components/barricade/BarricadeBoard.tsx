"use client";

// src/components/barricade/BarricadeBoard.tsx
//
// The Barricade board. It RENDERS a position; it never decides one.
//
// Everything a player can do here was already decided by the rules engine:
//   * the highlighted destinations are the `legalMoves` the engine offered;
//   * the highlighted grooves are the `legalWalls` the engine offered;
//   * a click is reported as an intent (`onMove` / `onPlaceWall`) and the page
//     applies it through `applyAction`, which validates it again.
//
// So there is no second copy of the movement or barricade rules in the UI: if
// the engine would not allow it, this component cannot offer it.
//
// BARRICADE PLACEMENT. There is no mode switch, no orientation switch and no
// ghost barricade to aim with the pointer. Placement is a CHOICE BETWEEN THE
// POSITIONS THE ENGINE OFFERS: every barricade the seat on turn may legally
// place is drawn as a quiet dashed groove (`barricade-slot`) and clicking one
// places exactly that barricade. A slot that is not offered cannot be clicked,
// because a slot that is not offered does not exist on the board.
//
// That is strictly stronger than aiming at a groove: the old ghost addressed the
// nearest of ALL 64 grooves and then asked the engine whether it was legal,
// which is why an illegal aim needed a red preview and a refusal notice to
// explain itself. Now the board can only ever offer legal positions, and each
// slot is a real button — so Tab reaches them in the engine's own order and
// Enter/Space places it, with no separate keyboard ghost to keep in sync.
//
// GEOMETRY. The board is one CSS grid of 17 tracks — 9 squares plus the 8
// grooves between them, on each axis. A square occupies a square track; a
// barricade lies IN a groove track and spans the two squares it separates, which
// is why a wall is drawn (and clicked) on the boundary rather than in a cell.
// Row 0 — player1's baseline — is the bottom of the CANONICAL board, but the
// board is projected per viewer: each seat sees its OWN baseline at the bottom
// and attacks the far row. So player2 sees a vertical mirror of the engine's
// coordinates, and every click is mapped back before it is reported.
//
// Pieces are coloured by SEAT, never by "mine/theirs": player1 is always blue
// and player2 always purple, whichever side of the screen the viewer sits on.

import { type CSSProperties } from "react";

import { BOARD_SIZE, ORIENTATIONS } from "../../lib/barricade/constants";
import { goalRowFor, positionKey, wallKey } from "../../lib/barricade/rules";
import { projectedRow, viewerRow } from "../../lib/barricade/ui";
import type {
  BarricadeState,
  LegalMoveAction,
  Position,
  Seat,
  WallPlacement,
} from "../../lib/barricade/types";

export interface BarricadeBoardProps {
  /** The authoritative position, straight from the rules engine. */
  state: BarricadeState;
  /** The seat the viewer controls (its pawn, its goal row, its barricades). */
  mySeat: Seat;
  /** The seat to move, per the engine. */
  activeSeat: Seat;
  /** The engine's legal moves for the active seat. */
  moves: readonly LegalMoveAction[];
  /**
   * The engine's legal barricade placements for the viewer's seat — the board's
   * whole placement menu. Empty when it is not the viewer's turn, when the match
   * is over, or when the seat has spent its reserve.
   */
  wallSlots: readonly WallPlacement[];
  /** True while the opponent is thinking — the board stops taking input. */
  disabled: boolean;
  onMove: (to: Position) => void;
  onPlaceWall: (wall: WallPlacement) => void;
}

/** Grid track (1-based) in CANONICAL coordinates. Row 0 is the bottom row. */
const squareRow = (row: number) => 2 * (BOARD_SIZE - 1 - row) + 1;
const squareColumn = (col: number) => 2 * col + 1;
/** The groove between rows `row` and `row + 1`, and between columns `col`/`col + 1`. */
const horizontalGrooveRow = (row: number) => 2 * (BOARD_SIZE - 1 - row);
const verticalGrooveColumn = (col: number) => 2 * col + 2;

/**
 * The board is PROJECTED for its viewer: every seat sees its own baseline at
 * the bottom. Only the bottom-baseline seat (player1) uses canonical rows; the
 * other seat gets a vertical mirror. Engine coordinates never change — this is
 * presentation only, and clicks still send the canonical square/groove.
 */
function viewRow(row: number, mySeat: Seat): number {
  return projectedRow(row, mySeat);
}

/** The lower row of a groove after projection (horizontal walls / vertical spans). */
function viewGrooveRow(row: number, mySeat: Seat): number {
  return Math.min(projectedRow(row, mySeat), projectedRow(row + 1, mySeat));
}

function squareStyle(row: number, col: number, mySeat: Seat): CSSProperties {
  return { gridRow: squareRow(viewRow(row, mySeat)), gridColumn: squareColumn(col) };
}

function wallStyle(wall: WallPlacement, mySeat: Seat): CSSProperties {
  if (wall.orientation === ORIENTATIONS[0]) {
    return {
      gridRow: horizontalGrooveRow(viewGrooveRow(wall.row, mySeat)),
      gridColumn: `${squareColumn(wall.col)} / span 3`,
    };
  }
  return {
    // A vertical wall spans the two rows it separates: the upper of the pair is
    // `row + 1` canonically, so project that row and span downwards.
    gridRow: `${squareRow(viewRow(wall.row + 1, mySeat))} / span 3`,
    gridColumn: verticalGrooveColumn(wall.col),
  };
}

function squareLabel(
  position: Position,
  occupant: "mine" | "theirs" | null,
  legal: boolean,
  mySeat: Seat,
) {
  const where = `Row ${viewerRow(position.row, mySeat)}, column ${position.col + 1}`;
  if (occupant === "mine") return `${where}: your pawn`;
  if (occupant === "theirs") return `${where}: the opponent's pawn`;
  if (legal) return `${where}: move your pawn here`;
  return `${where}: empty`;
}

function wallName(wall: WallPlacement, mySeat: Seat) {
  const axis = wall.orientation === ORIENTATIONS[0] ? "horizontal" : "vertical";
  const first = viewerRow(wall.row, mySeat);
  const second = viewerRow(wall.row + 1, mySeat);
  const low = Math.min(first, second);
  const high = Math.max(first, second);
  return `${axis} barrier between rows ${low} and ${high}, columns ${wall.col + 1} and ${wall.col + 2}`;
}

const wallLabel = (wall: WallPlacement, mySeat: Seat) => wallName(wall, mySeat);

const slotLabel = (wall: WallPlacement, mySeat: Seat) => `Place a ${wallName(wall, mySeat)}`;

export default function BarricadeBoard({
  state,
  mySeat,
  activeSeat,
  moves,
  wallSlots,
  disabled,
  onMove,
  onPlaceWall,
}: BarricadeBoardProps) {
  const myGoalRow = goalRowFor(mySeat);
  const opponentSeat: Seat = mySeat === "player1" ? "player2" : "player1";
  const opponentGoalRow = goalRowFor(opponentSeat);
  const moveTargets = new Set(moves.map((action) => positionKey(action.to)));
  const lastAction = state.lastAction;
  const lastDestination =
    lastAction && lastAction.action.type === "move" ? positionKey(lastAction.action.to) : null;

  const rows = Array.from({ length: BOARD_SIZE }, (_, index) => index);

  const seatAt = (position: Position): Seat | null => {
    if (positionKey(state.pawns[mySeat]) === positionKey(position)) return mySeat;
    if (positionKey(state.pawns[opponentSeat]) === positionKey(position)) return opponentSeat;
    return null;
  };

  return (
    <div
      className="barricade-board"
      role="group"
      aria-label={`Barrier Blitz board. You play ${mySeat === "player1" ? "blue" : "purple"}.`}
      data-testid="barricade-board"
      data-viewer-seat={mySeat}
      data-active-seat={activeSeat}
      data-wall-slots={wallSlots.length}
    >
      {/* ── Squares: where pawns stand and where they may go ───────────── */}
      {rows.map((row) =>
        rows.map((col) => {
          const position: Position = { col, row };
          const key = positionKey(position);
          const occupantSeat = seatAt(position);
          const occupant = occupantSeat === mySeat ? "mine" : occupantSeat ? "theirs" : null;
          const legal = moveTargets.has(key);
          const isMyGoal = row === myGoalRow;
          const isTheirGoal = row === opponentGoalRow;
          const classes = ["barricade-square"];
          if (isMyGoal) classes.push("is-my-goal", `goal-${mySeat}`);
          if (isTheirGoal) classes.push("is-their-goal", `goal-${opponentSeat}`);
          if (legal) classes.push("is-legal");
          if (occupantSeat) classes.push(`seat-${occupantSeat}`);
          if (lastDestination === key) classes.push("is-last");
          return (
            <button
              key={key}
              type="button"
              className={classes.join(" ")}
              style={squareStyle(row, col, mySeat)}
              data-testid="barricade-square"
              data-col={col}
              data-row={row}
              data-occupant={occupant ?? "none"}
              data-occupant-seat={occupantSeat ?? "none"}
              data-legal={legal ? "true" : "false"}
              data-goal={isMyGoal ? "mine" : isTheirGoal ? "theirs" : "none"}
              disabled={disabled}
              tabIndex={disabled || (!legal && !occupant) ? -1 : 0}
              aria-label={squareLabel(position, occupant, legal, mySeat)}
              onClick={() => onMove(position)}
            >
              {occupantSeat ? (
                <span
                  className={`barricade-pawn seat-${occupantSeat}`}
                  data-seat={occupantSeat}
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

      {/* ── Barriers already on the board ──────────────────────────────── */}
      {state.walls.map((wall) => (
        <div
          key={wallKey(wall)}
          className={`barricade-wall seat-${wall.owner}`}
          style={wallStyle(wall, mySeat)}
          data-testid="barricade-wall"
          data-col={wall.col}
          data-row={wall.row}
          data-orientation={wall.orientation}
          data-owner={wall.owner}
          role="img"
          aria-label={wallLabel(wall, mySeat)}
        />
      ))}
      {/* ── Every barrier the engine offers this turn ─────────────────────
          One button per legal placement, drawn on the groove it would occupy.            Nothing here is a preview or a guess: each slot IS a legal barrier,
          so clicking it needs no verdict and no explanation. */}
      {wallSlots.map((wall) => (
        <button
          key={wallKey(wall)}
          type="button"
          className="barricade-slot"
          style={wallStyle(wall, mySeat)}
          data-testid="barricade-slot"
          data-col={wall.col}
          data-row={wall.row}
          data-orientation={wall.orientation}
          disabled={disabled}
          tabIndex={disabled ? -1 : 0}
          aria-label={slotLabel(wall, mySeat)}
          onClick={() => onPlaceWall(wall)}
        />
      ))}
    </div>
  );
}
