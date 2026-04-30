import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db";
import { diceLobbies } from "../../../../db/schema";

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ ok: false, message: "Unauthorized" }, { status: 401 });
  const { wager = 10 } = await req.json().catch(() => ({}));
  const [row] = await db.insert(diceLobbies).values({ hostUserId: userId, wager: Number(wager), status: "waiting" }).returning({ id: diceLobbies.id });
  return NextResponse.json({ ok: true, lobbyId: row.id });
}
