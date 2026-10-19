import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { requireAgeVerifiedUser } from "../../../../lib/auth/requireAgeVerified";
import { db } from "../../../../db";
import { poolLobbies } from "../../../../db/schema";
import { requireStake } from "../../../../lib/games/stakes";

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
    // A public Pool lobby is a staked match, so the stake is REQUIRED and must
    // be legal for the game (`requireStake`). It is stored on the lobby row, not
    // charged here: a lobby waiting for an opponent costs nothing. The JOINING
    // transaction escrows BOTH seats at this amount (`src/lib/pool/lobbyJoin`).
    const stake = requireStake(wager, "pool");
    if (!stake.ok) {
      return NextResponse.json(
        { ok: false, message: stake.error, code: stake.code },
        { status: stake.status },
      );
    }
    const [row] = await db
      .insert(poolLobbies)
      .values({
        id: crypto.randomUUID(),
        hostUserId: userId,
        wager: stake.stake,
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
