import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The server's wall clock, for clients that have to time an action against a
 * server-stamped instant.
 *
 * Clocked matches store their pacing as absolute instants (`turnDeadline`,
 * `readyDeadlineAt`, `roundDeadline`, `matchDeadline`, …) and the client arms one
 * read at that instant to turn it into a transition. The read must land AFTER
 * the instant — the stores advance only once it has passed — and a device whose
 * clock is skewed either fires early (a wasted read, then a retry) or late (the
 * game visibly starts late).
 *
 * Estimating `server − device` from ONE request/response pair removes nearly all
 * of that skew: it is the classic NTP estimate, so what is left is the round
 * trip's ASYMMETRY (a few ms), not the device's offset (seconds). `Date.now()`
 * is read when the response is built, so the pair is `sent → stamped →
 * received` and `estimateServerClockOffset` can attribute half the trip to each
 * direction.
 *
 * Deliberately trivial: no database, no auth, no Redis. It is called once per
 * match page, and an endpoint that can be slow is an endpoint that makes the
 * thing it is supposed to fix worse. The caller sends `cache: "no-store"`.
 */
export async function GET() {
  return NextResponse.json(
    { now: Date.now() },
    { headers: { "cache-control": "no-store" } },
  );
}
