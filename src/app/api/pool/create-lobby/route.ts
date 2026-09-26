import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { requireAgeVerifiedUser } from "../../../../lib/auth/requireAgeVerified";
import { db } from "../../../../db";
import { poolLobbies } from "../../../../db/schema";
import { normalizeStake } from "../../../../lib/games/stakes";

export async function POST(req: Request) {
  try {
    const gate = await requireAgeVerifiedUser();
    if (gate.response) return gate.response;

    const { userId } = await auth();
    if (!userId)
      return NextResponse.json(
        { ok: false, message: "Unauthorized" },
        { status: 401 },
      );
    const { wager } = await req.json().catch(() => ({}));
    // STAKES ARE RETIRED (src/lib/games/stakes.js): a lobby is free to open.
    // The requested wager is normalized to 0, so the lobby (and the match it
    // becomes) carries no stake and no range check can reject free play.
    const stake = normalizeStake(wager);
    const [row] = await db
      .insert(poolLobbies)
      .values({
        id: crypto.randomUUID(),
        hostUserId: userId,
        wager: stake,
        gameMode: "pvp",
        status: "waiting",
      })
      .returning({ id: poolLobbies.id });
    return NextResponse.json({ ok: true, lobbyId: row.id });
  } catch (error: any) {
    return NextResponse.json(
      { ok: false, message: error?.message || "Unable to create lobby" },
      { status: 500 },
    );
  }
}
