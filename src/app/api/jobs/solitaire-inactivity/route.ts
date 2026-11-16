// src/app/api/jobs/solitaire-inactivity/route.ts
//
// GET /api/jobs/solitaire-inactivity — settle abandoned Solitaire Duels.
//
// Solitaire Duel is untimed. A seat that stops playing forfeits after 20
// minutes (INACTIVITY_FORFEIT_MS) and the opponent wins; that rule is enforced
// inside the store. This job is what makes it true when NOBODY opens the
// match: without a sweep, a row that is only ever listed stays "playing"
// forever instead of being recorded as a loss.
//
// The sweep is per-seat and re-checks every candidate under the row lock, so
// it can never settle a match that came back, and a retried tick is a no-op.
// It writes only through the store's existing finalisation/settlement path —
// no rating, trophy or result is computed here.

import { verifyCronRequest } from "../../../../lib/security/cronAuth";
import { sweepInactiveMatches } from "../../../../lib/solitaire-duel/serverStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const authError = verifyCronRequest(request);
  if (authError) return authError;

  const requested = Number(new URL(request.url).searchParams.get("limit"));
  const limit = Number.isFinite(requested) && requested > 0 ? Math.min(500, requested) : 100;

  try {
    const result = await sweepInactiveMatches({ limit });
    return Response.json({ success: true, limit, ...result });
  } catch (error) {
    console.error("[jobs/solitaire-inactivity] sweep failed:", error);
    return Response.json(
      { success: false, error: "Inactivity sweep failed" },
      { status: 500 },
    );
  }
}
