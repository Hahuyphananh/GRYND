"use client";

// src/components/games/battleship/FleetStatus.tsx
//
// The fleet panel beside the boards. Two modes:
//
//   * own fleet   — every ship with its block visual and its state, so a player
//                   can see which hulls are damaged or gone.
//   * enemy fleet — `conceal`: the same five rows, but only the CELL COUNT and
//                   whether the ship is sunk. No positions, no blocks, nothing
//                   that could reveal where an enemy ship sits.

import { SHIP_LENGTHS } from "../../../lib/battleship/constants";
import type { ShipKey, ShipPlacement } from "../../../lib/battleship/types";
import ShipVisual from "./ShipVisual";

export interface FleetStatusProps {
  title: string;
  ships: readonly ShipPlacement[];
  /** Ships fully destroyed (identities are public once sunk). */
  sunk?: readonly ShipKey[];
  /** Per-cell damage for the viewer's OWN fleet. */
  damaged?: Partial<Readonly<Record<ShipKey, readonly boolean[]>>>;
  /** Hide positions: the opponent's fleet is never drawn. */
  conceal?: boolean;
  testId?: string;
}

export default function FleetStatus({
  title,
  ships,
  sunk = [],
  damaged = {},
  conceal = false,
  testId,
}: FleetStatusProps) {
  const afloat = ships.filter((placement) => !sunk.includes(placement.ship)).length;

  return (
    <section
      data-testid={testId}
      className="rounded-xl border border-white/10 bg-[#061229]/80 p-3"
    >
      <header className="flex items-baseline justify-between gap-2">
        <h3 className="text-[10px] font-black uppercase tracking-[0.2em] text-[#ffec08]">{title}</h3>
        <span className="text-[10px] text-white/40">{afloat} afloat</span>
      </header>

      <ul className="mt-2 space-y-1.5">
        {ships.map((placement) => {
          const isSunk = sunk.includes(placement.ship);
          return (
            <li
              key={placement.ship}
              data-testid={testId ? `${testId}-${placement.ship}` : undefined}
              data-sunk={isSunk ? "true" : "false"}
              className="flex items-center gap-2"
            >
              <span className="w-[4.5rem] shrink-0 text-[11px] font-semibold capitalize text-white/75">
                {placement.ship}
              </span>
              <span className="min-w-0 flex-1">
                {conceal ? (
                  <span className="text-[10px] uppercase tracking-wider text-white/35">
                    {SHIP_LENGTHS[placement.ship]} cells
                  </span>
                ) : (
                  <span className="flex h-3 items-center">
                    <ShipVisual
                      ship={placement.ship}
                      orientation="horizontal"
                      size="sm"
                      damaged={damaged[placement.ship]}
                    />
                  </span>
                )}
              </span>
              <span
                className={`shrink-0 text-[9px] font-black uppercase tracking-wider ${
                  isSunk ? "text-red-400" : "text-white/45"
                }`}
              >
                {isSunk ? "Sunk" : "Afloat"}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
