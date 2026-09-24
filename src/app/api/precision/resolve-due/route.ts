// POST /api/precision/resolve-due
//
// Internal endpoint called by the realtime server's per-match due-transition
// scheduler. Applies whichever transition has come due for the match RIGHT
// NOW — the arming countdown elapsing, or the bot's stop deadline arriving —
// and returns everything the caller needs to ANNOUNCE it.
//
// Why this exists: both transitions used to be lazy side effects of a read, so
// they only ever happened on the next `get-match` poll, and a resolution the
// read performed was never broadcast (nothing on a read path can reach the
// socket server). A round decided by the bot's deadline therefore reached the
// players only when one of them happened to poll, and reached nobody else at
// all. The scheduler hits this endpoint at the stored instant instead, so the
// round opens and resolves ON TIME.
//
// Response:
//   { success: true, data: PrecisionDueReport }
// where `data.nextDueAtMs` is the next instant worth waking up for (null when
// nothing is pending) and the boolean flags describe the broadcast shape.
//
// This does NOT replace the lazy transition: `readMatch` still applies due
// transitions, so a restarted or absent scheduler degrades to the previous
// self-healing behaviour rather than stranding a round.
//
// The route is internal-only: when REALTIME_INTERNAL_SECRET is set the caller
// must send it in the `x-internal-secret` header (skipped in local dev, like
// the crash-arena sweeps). Nothing here trusts the caller for GAMEPLAY state —
// the instants live in the database, and this route only performs a transition
// whose deadline has already passed, so a caller cannot move a stop earlier.

import { NextRequest, NextResponse } from "next/server";
import { resolveDueTransitions } from "../../../../lib/precision/serverStore";
import { logError } from "../../../../lib/logError";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    // ── Optional shared-secret guard for the internal scheduler ─────────
    const secret = process.env.REALTIME_INTERNAL_SECRET;
    if (secret) {
      const header = req.headers.get("x-internal-secret");
      if (header !== secret) {
        return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
      }
    }

    const body = await req.json().catch(() => ({}));
    const matchId = String(body?.matchId ?? "");
    if (!matchId) {
      return NextResponse.json({ success: false, error: "Missing matchId." }, { status: 400 });
    }

    const data = await resolveDueTransitions(matchId);
    return NextResponse.json({ success: true, data });
  } catch (err) {
    await logError({
      errorType: "precision_resolve_due_error",
      errorMessage: err instanceof Error ? err.message : "Precision resolve-due failed",
      stackTrace: err instanceof Error ? err.stack : undefined,
      endpoint: "/api/precision/resolve-due",
      game: "Precision",
      metadata: { operation: "resolve_due_transitions" },
    });
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}
