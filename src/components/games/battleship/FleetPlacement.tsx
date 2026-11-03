"use client";

// src/components/games/battleship/FleetPlacement.tsx
//
// The placement screen: five ships, one board, and as many ways to place them as
// the platform's devices need.
//
//   * SELECT + TAP/CLICK — pick a ship in the list, then a cell. This is the
//     mobile path and it is also the desktop path.
//   * DRAG AND DROP (desktop) — drag a ship from the list onto a cell.
//   * ROTATE — the button, or the R key, flips the selected ship.
//   * AUTO PLACE / RESET — deal a legal fleet, or start over.
//   * CONFIRM — enabled only when all five ships are down and legal.
//
// Every placement decision is made by the PURE model in
// src/lib/battleship/placement.ts; this component only renders it and prints the
// model's rejection message. The 60-second clock is part of the screen: when it
// reaches zero the fleet is locked in, auto-filled first if the player had not
// finished, so nobody is stranded on the placement screen.

import { useCallback, useEffect, useRef, useState } from "react";

import { BOARD_CELL, FLEET_SPEC, SHIP_KEYS } from "../../../lib/battleship/constants";
import type { Coordinate, Fleet, Orientation, ShipKey } from "../../../lib/battleship/types";
import {
  PLACEMENT_SECONDS,
  autoPlace,
  emptyPlacement,
  isPlaced,
  placeShip,
  placementComplete,
  placementOf,
  removeShip,
  rotate,
  toFleet,
  type PlacementState,
} from "../../../lib/battleship/placement";
import BoardGrid from "./BoardGrid";
import ShipVisual from "./ShipVisual";

/** The placement board never shows attack results, only the player's ships. */
const EMPTY_CELLS = Array.from({ length: 10 }, () =>
  Array.from({ length: 10 }, () => BOARD_CELL.UNKNOWN),
);

export interface FleetPlacementProps {
  onFleetConfirmed: (fleet: Fleet) => void;
}

export default function FleetPlacement({ onFleetConfirmed }: FleetPlacementProps) {
  const [placement, setPlacement] = useState<PlacementState>(emptyPlacement);
  const [activeShip, setActiveShip] = useState<ShipKey>(SHIP_KEYS[0]);
  const [orientation, setOrientation] = useState<Orientation>("horizontal");
  const [hover, setHover] = useState<Coordinate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(PLACEMENT_SECONDS);

  // Refs keep the timer and the drag handlers reading the CURRENT state rather
  // than the state of the render that registered them.
  const placementRef = useRef(placement);
  placementRef.current = placement;
  const activeShipRef = useRef(activeShip);
  activeShipRef.current = activeShip;
  const orientationRef = useRef(orientation);
  orientationRef.current = orientation;
  const confirmedRef = useRef(false);

  useEffect(() => {
    const timer = setInterval(() => {
      setSecondsLeft((remaining) => (remaining > 0 ? remaining - 1 : 0));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // R rotates, exactly like the button — the desktop shortcut the board games use.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "r" || event.key === "R") {
        setOrientation((current) => rotate(current));
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const complete = placementComplete(placement);

  const confirm = useCallback(() => {
    if (confirmedRef.current) return;
    const fleet = toFleet(placementRef.current);
    if (!fleet) {
      setError("Place all five ships before confirming your fleet.");
      return;
    }
    confirmedRef.current = true;
    onFleetConfirmed(fleet);
  }, [onFleetConfirmed]);

  // The clock running out locks the fleet in: fill anything missing, then confirm.
  useEffect(() => {
    if (secondsLeft > 0 || confirmedRef.current) return;
    const filled = autoPlace(placementRef.current);
    setPlacement(filled);
    const fleet = toFleet(filled);
    if (!fleet) return;
    confirmedRef.current = true;
    onFleetConfirmed(fleet);
  }, [secondsLeft, onFleetConfirmed]);

  const placeAt = useCallback((coordinate: Coordinate, ship: ShipKey) => {
    const result = placeShip(placementRef.current, {
      ship,
      orientation: orientationRef.current,
      x: coordinate.x,
      y: coordinate.y,
    });
    if (result.ok === false) {
      setError(result.message);
      return;
    }
    setError(null);
    setPlacement(result.state);
    setHover(null);
    const next = SHIP_KEYS.find((key) => !isPlaced(result.state, key));
    if (next) setActiveShip(next);
  }, []);

  const previewPlacement = hover
    ? { ship: activeShip, orientation, x: hover.x, y: hover.y }
    : null;
  const previewValid =
    previewPlacement !== null && placeShip(placement, previewPlacement).ok === true;

  const clock = `${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, "0")}`;

  return (
    <section data-testid="fleet-placement" className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,20rem)]">
      <div className="min-w-0 rounded-2xl border border-white/10 bg-[#061229]/70 p-3 sm:p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-black uppercase tracking-[0.18em] text-white">Deploy your fleet</h2>
            <p className="mt-1 text-[11px] text-white/45">
              Tap a ship, then a cell. Drag from the list on desktop. R rotates.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span
              data-testid="placement-timer"
              className={`rounded-lg border px-2.5 py-1 text-[11px] font-black tabular-nums ${
                secondsLeft <= 10
                  ? "border-red-400/60 text-red-300"
                  : "border-[#ffec08]/40 text-[#ffec08]"
              }`}
            >
              {clock}
            </span>
            <button
              type="button"
              data-testid="placement-rotate"
              onClick={() => setOrientation((current) => rotate(current))}
              className="rounded-lg border border-white/15 px-2.5 py-1 text-[11px] font-bold text-white/80 transition hover:border-[#ffec08]/60 hover:text-[#ffec08]"
            >
              Rotate · {orientation === "horizontal" ? "H" : "V"}
            </button>
          </div>
        </div>

        <BoardGrid
          title="My Fleet"
          subtitle="Placement"
          cells={EMPTY_CELLS}
          ships={placement.ships.map((ship) => ({ placement: ship }))}
          preview={previewPlacement ? { placement: previewPlacement, valid: previewValid } : null}
          onCellClick={(coordinate) => placeAt(coordinate, activeShip)}
          onCellDrop={(coordinate) => placeAt(coordinate, activeShipRef.current)}
          onCellHover={setHover}
          testId="placement-board"
          footnote={error ?? "Ships may touch, including diagonally. They may never share a cell."}
        />

        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            data-testid="placement-auto"
            onClick={() => {
              setError(null);
              setPlacement(autoPlace(placementRef.current));
            }}
            className="rounded-lg border border-[#ffec08]/40 bg-[#ffec08]/10 px-3 py-2 text-[11px] font-black uppercase tracking-wider text-[#ffec08] transition hover:bg-[#ffec08]/20"
          >
            Auto place
          </button>
          <button
            type="button"
            data-testid="placement-reset"
            onClick={() => {
              setError(null);
              setPlacement(emptyPlacement());
              setActiveShip(SHIP_KEYS[0]);
            }}
            className="rounded-lg border border-white/15 px-3 py-2 text-[11px] font-black uppercase tracking-wider text-white/70 transition hover:border-white/40"
          >
            Reset
          </button>
          <button
            type="button"
            data-testid="placement-confirm"
            onClick={confirm}
            disabled={!complete}
            className="ml-auto rounded-lg border-b-4 border-[#b7a800] bg-[#ffec08] px-4 py-2 text-[11px] font-black uppercase tracking-wider text-[#0a1200] transition disabled:cursor-not-allowed disabled:opacity-40"
          >
            Confirm fleet
          </button>
        </div>
      </div>

      <aside className="min-w-0 rounded-2xl border border-white/10 bg-[#061229]/70 p-3 sm:p-4">
        <h2 className="text-[10px] font-black uppercase tracking-[0.2em] text-[#ffec08]">Your ships</h2>
        <ul className="mt-3 space-y-2">
          {FLEET_SPEC.map((ship) => {
            const placed = isPlaced(placement, ship.key);
            const current = placementOf(placement, ship.key);
            const active = activeShip === ship.key;

            return (
              <li key={ship.key}>
                <button
                  type="button"
                  draggable
                  onDragStart={(event) => {
                    event.dataTransfer.setData("text/plain", ship.key);
                    event.dataTransfer.effectAllowed = "move";
                    setActiveShip(ship.key);
                  }}
                  onClick={() => {
                    setActiveShip(ship.key);
                    if (current) setOrientation(current.orientation);
                  }}
                  data-testid={`placement-ship-${ship.key}`}
                  data-active={active ? "true" : "false"}
                  data-placed={placed ? "true" : "false"}
                  className={`w-full rounded-xl border px-3 py-2 text-left transition ${
                    active
                      ? "border-[#ffec08]/70 bg-[#ffec08]/10"
                      : "border-white/10 bg-black/20 hover:border-white/30"
                  }`}
                >
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="text-[11px] font-bold capitalize text-white/85">{ship.name}</span>
                    <span className="text-[10px] tabular-nums text-white/45">{ship.length} cells</span>
                  </span>
                  <span className="mt-1.5 flex h-3 items-center">
                    <ShipVisual ship={ship.key} orientation="horizontal" size="sm" />
                  </span>
                  <span className="mt-1 block text-[10px] text-white/40">
                    {placed ? "Placed — tap to move" : "Tap, then pick a cell"}
                  </span>
                </button>
                {placed ? (
                  <button
                    type="button"
                    onClick={() => setPlacement(removeShip(placement, ship.key))}
                    className="mt-1 w-full rounded-lg border border-white/10 py-1 text-[9px] font-bold uppercase tracking-wider text-white/40 transition hover:border-red-400/50 hover:text-red-300"
                  >
                    Lift {ship.name}
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
        <p className="mt-3 text-[10px] leading-snug text-white/35">
          {complete
            ? "Fleet ready. Confirm when you are happy with the layout."
            : "All five ships must be placed before the fleet can be confirmed."}
        </p>
      </aside>
    </section>
  );
}
