import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";

import { submitInput } from "../../../../../../lib/last-run/matchRegistry";

export const dynamic = "force-dynamic";

/**
 * Submit an INPUT TRANSITION — `{ jump, duck }` and nothing else.
 *
 * There is deliberately no field for position, distance, collision, survival
 * time or winner: the server derives all of those by replaying the shared
 * engine. The response's `tick` is where the server scheduled the transition
 * (received-at + the fixed input lead), so clients never send a tick.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ matchId: string }> },
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });

  const { matchId } = await params;
  const payload = await req.json().catch(() => null);
  const accepted = submitInput({ matchId, userId, payload });

  if ("error" in accepted) {
    return NextResponse.json({ success: false, error: accepted.error }, { status: accepted.status });
  }
  return NextResponse.json({ success: true, tick: accepted.tick });
}
