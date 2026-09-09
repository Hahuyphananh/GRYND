// app/api/game-plays/route.ts
//
// GET  /api/game-plays  → { counts: { [gameLabel]: number } } — total plays
//                        per game label, for the casino lobby's "Most
//                        Played" sort. No auth required (public chrome).
//
// POST /api/game-plays  → increments a game's play count. Body:
//                        { gameLabel: string }. Fired from the same
//                        client-side edge that records "Recently played"
//                        (a REAL game session start via CreatorModeHost's
//                        autoStart), so a play means "a player started the
//                        game", never a page view. Public + best-effort:
//                        the increment is idempotent-per-event and can't
//                        be gamed into anything meaningful (no rewards,
//                        no leaderboard effect).

import { db } from "../../../db";
import { gamePlays } from "../../../db/schema";
import { sql } from "drizzle-orm";

// Sanity limits — labels come from game pages (e.g. "plinko-duel",
// "chess-ai", "mines-duel"); anything else is rejected before touching the
// DB, so the endpoint can't be used to write arbitrary rows.
const LABEL_MAX = 64;
const LABEL_RE = /^[a-z0-9-]{1,64}$/;

export async function GET() {
  try {
    const rows = await db
      .select({
        gameLabel: gamePlays.gameLabel,
        plays: gamePlays.plays,
      })
      .from(gamePlays)
      .orderBy(sql`plays DESC`);

    const counts = {};
    for (const row of rows) {
      counts[row.gameLabel] = Number(row.plays) || 0;
    }

    return Response.json({ success: true, counts });
  } catch (error) {
    console.error("[game-plays] failed to load counts:", error);
    return Response.json(
      { success: false, error: "Unable to load play counts" },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  let label = "";
  try {
    const body = await request.json().catch(() => ({}));
    label = String(body?.gameLabel ?? "").trim().toLowerCase();
  } catch {
    // fall through to the validation below
  }

  if (!label || label.length > LABEL_MAX || !LABEL_RE.test(label)) {
    return Response.json(
      { success: false, error: "Invalid game label" },
      { status: 400 },
    );
  }

  try {
    // One row per label — upsert so the first play creates it.
    await db
      .insert(gamePlays)
      .values({ gameLabel: label, plays: 1, lastPlayedAt: new Date() })
      .onConflictDoUpdate({
        target: gamePlays.gameLabel,
        set: {
          plays: sql`${gamePlays.plays} + 1`,
          lastPlayedAt: new Date(),
        },
      });

    return Response.json({ success: true });
  } catch (error) {
    console.error("[game-plays] failed to record play:", error);
    return Response.json(
      { success: false, error: "Unable to record play" },
      { status: 500 },
    );
  }
}
