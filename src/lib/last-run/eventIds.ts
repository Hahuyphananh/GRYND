// src/lib/last-run/eventIds.ts
//
// A DETERMINISTIC event id for a LAST RUN completion.
//
// `match_lifecycle_events.event_id` is a primary key. Deriving it from the
// match id means a retried persistence call targets the SAME row and conflicts
// instead of writing a second completion event — idempotency at the database,
// not just in the process.
//
// Pure: node:crypto only, so it is safe to unit test without a database.

import { createHash } from "node:crypto";

/**
 * A stable RFC-4122-shaped UUID (version 5 variant bits) for one match's
 * completion event.
 */
export function completionEventId(matchId: string): string {
  const hex = createHash("sha256").update(`last-run:${String(matchId)}:completed`).digest("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `8${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}
