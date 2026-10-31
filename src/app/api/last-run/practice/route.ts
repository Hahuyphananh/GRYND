import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";

import { createPracticeMatch } from "../../../../lib/last-run/matchRegistry";

export const dynamic = "force-dynamic";

/**
 * LAST RUN practice — a free match against the server-scripted AI.
 *
 *   POST ?level=easy|normal|hard  (optionally { name?, level? })
 *     → { matchId, level } (idempotent per level while the practice is live)
 *
 * Same authority model as the ranked queue: the seed, the course and the AI's
 * run are all minted server-side, and the player still submits `{ jump, duck }`
 * only. `level` picks how consistent that scripted run is (easy / normal /
 * hard); an unknown value falls back to `normal` rather than failing, because a
 * difficulty is a preference, not something a player can fix.
 *
 * Nothing is wagered, rated or recorded, so this route never touches
 * `last_run_matches`, the rating writer or the trophy writer.
 *
 * Auth is Clerk's session only; the name is cosmetic and sanitised server-side.
 */
export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  // The match screen sends the level in the query string (it posts no body for
  // a rematch); the lobby sends it in the body. Both are untrusted and both go
  // through the same sanitiser inside the registry.
  const requestedLevel = body?.level ?? req.nextUrl.searchParams.get("level");
  const { matchId, level } = createPracticeMatch({ userId, name: body?.name, level: requestedLevel });

  return NextResponse.json({ success: true, matchId, level, practice: true });
}
