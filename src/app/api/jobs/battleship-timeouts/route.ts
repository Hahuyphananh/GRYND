// src/app/api/jobs/battleship-timeouts/route.ts
//
// GET /api/jobs/battleship-timeouts
//
// The DURABLE scheduler for Battleship deadlines. It is a database sweep, not an
// in-memory timer: every overdue placement or combat round is found by deadline
// on the row, settled under its own row lock, and the work is idempotent — so a
// restart, a missed run or a duplicated run all converge on the same state.
//
// Scheduled by `deploy/jobs/grynd-job-battleship-timeouts.timer` every minute on
// the Oracle host (and by the matching `vercel.json` cron), with the same
// CRON_SECRET bearer verification as the other jobs.
//
// The sweep only WRITES. Everything a client can observe is published here,
// after the commits, through the same event vocabulary the attack route uses.

import { verifyCronRequest } from "../../../../lib/security/cronAuth";
import { sweepBattleshipTimeouts } from "../../../../lib/battleship/serverStore";
import {
  publishForfeit,
  publishRoundResult,
  publishTimeoutNotice,
} from "../../../../lib/battleship/publish";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const authError = verifyCronRequest(request);
  if (authError) return authError;

  const result = await sweepBattleshipTimeouts();

  for (const event of result.events) {
    if (event.kind === "attack_timeout") {
      publishTimeoutNotice(event.matchId, event.round, event.seats);
    } else if (event.kind === "round_resolved") {
      publishRoundResult(event.matchId, event.round);
    } else {
      publishForfeit(event);
    }
  }

  return Response.json(
    {
      ok: result.ok,
      runAt: new Date().toISOString(),
      checked: result.checked,
      resolved: result.resolved,
      failed: result.failed,
      events: result.events.length,
    },
    { status: result.ok ? 200 : 500 },
  );
}
