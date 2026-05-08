import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db";
import { poolLobbies } from "../../../../db/schema";

export async function POST(req: Request) {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ ok: false, message: "Unauthorized" }, { status: 401 });
    const { wager = 10 } = await req.json().catch(() => ({}));
    const [row] = await db
      .insert(poolLobbies)
      .values({ id: crypto.randomUUID(), hostUserId: userId, wager: Number(wager), gameMode: "pvp", status: "waiting" })
      .returning({ id: poolLobbies.id });
    return NextResponse.json({ ok: true, lobbyId: row.id });
  } catch (error: any) {
    return NextResponse.json({ ok: false, message: error?.message || "Unable to create lobby" }, { status: 500 });
  }
}
