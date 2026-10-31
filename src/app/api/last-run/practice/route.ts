import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";

import { createPracticeMatch } from "../../../../lib/last-run/matchRegistry";

export const dynamic = "force-dynamic";

/**
 * LAST RUN practice — a free match against the server-scripted AI.
 *
 *   POST → { matchId } (idempotent while the practice is still live)
 *
 * Same authority model as the ranked queue: the seed, the course and the AI's
 * run are all minted server-side, and the player still submits `{ jump, duck }`
 * only. Nothing is wagered, rated or recorded, so this route never touches
 * `last_run_matches`, the rating writer or the trophy writer.
 *
 * Auth is Clerk's session only; the name is cosmetic and sanitised server-side.
 */
export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const { matchId } = createPracticeMatch({ userId, name: body?.name });

  return NextResponse.json({ success: true, matchId, practice: true });
}
