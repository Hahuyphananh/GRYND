import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db";
import { poolLobbies } from "../../../../db/schema";

export async function POST(req: Request) {
  try {
    const { userId } = await auth();
    if (!userId)
      return NextResponse.json(
        { ok: false, message: "Unauthorized" },
        { status: 401 },
      );
    const { wager = 10 } = await req.json().catch(() => ({}));
    // Global bet cap (must match GLOBAL_MAX_BET in src/lib/games/economy.ts).
    if (!Number.isFinite(Number(wager)) || Number(wager) <= 0 || Number(wager) > 100000) {
      return NextResponse.json(
        { ok: false, message: "Wager must be between 1 and 100,000 tokens" },
        { status: 400 },
      );
    }
    const [row] = await db
      .insert(poolLobbies)
      .values({
        id: crypto.randomUUID(),
        hostUserId: userId,
        wager: Number(wager),
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
