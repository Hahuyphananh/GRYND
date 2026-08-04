"use client";
import React from "react";
import WagerSection from "./WagerSection";
import { CRASH_WAGERS } from "../../lib/games/crash/constants";

// Re-exported for callers that need the standard wager list.
export { CRASH_WAGERS };

/**
 * TableList — one "table amount" section per wager.
 *
 * Each section renders its own table-amount card (with a Create Table
 * button) and an "Available Games" list underneath, so there are exactly
 * CRASH_WAGERS.length available-game sections, grouped by stake.
 *
 * Props:
 *   grouped       — { wager: table[] } — lobby tables grouped by wager
 *   isSignedIn    — whether the user is authenticated
 *   creating      — wager currently being created (or null)
 *   busyTableId   — table id with an in-flight join (or null)
 *   onCreate      — (wager) => void
 *   onJoin        — (table) => void
 */
export default function TableList({
  grouped = {},
  isSignedIn = false,
  creating = null,
  busyTableId = null,
  onCreate,
  onJoin,
}) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-5 lg:grid-cols-3">
      {CRASH_WAGERS.map((wager) => (
        <WagerSection
          key={wager}
          wager={wager}
          tables={grouped[wager] || []}
          isSignedIn={isSignedIn}
          creating={creating}
          busyTableId={busyTableId}
          onCreate={onCreate}
          onJoin={onJoin}
        />
      ))}
    </div>
  );
}
