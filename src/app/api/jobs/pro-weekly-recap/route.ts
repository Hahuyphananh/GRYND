// src/app/api/jobs/pro-weekly-recap/route.ts
//
// GET — the weekly GRYND PRO recap job.
//
// Mails each active member a summary of the solitaire games they finished in
// the last seven days, built from settled results and already-cached analyses
// (src/lib/proWeeklyRecap.ts). It writes no game state, recomputes no analysis
// and spends nobody's allowance.
//
// AUTHENTICATION is the shared cron guard: this endpoint emails real people, so
// an unauthenticated caller must never reach it. Scheduled weekly in vercel.json
// (Mondays 09:00 UTC); any scheduler that sends the CRON_SECRET bearer token
// works too.
//
// IDEMPOTENT: each member is claimed in `pro_weekly_recap_sends` before the
// send, so a retry of this route skips everyone already mailed this week and
// reports them as `skipped`. A failed send releases its claim for the next run.

import { verifyCronRequest } from "../../../../lib/security/cronAuth";
import { sendProWeeklyRecaps } from "../../../../lib/proWeeklyRecap";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const authError = verifyCronRequest(request);
  if (authError) return authError;

  try {
    const result = await sendProWeeklyRecaps({});
    return Response.json({ ok: true, ...result });
  } catch (error) {
    console.error("[pro-recap] run failed:", error);
    return Response.json({ ok: false, error: "Recap run failed" }, { status: 500 });
  }
}
