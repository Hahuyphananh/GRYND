import { NextResponse } from "next/server";
import { db } from "../../../../db";
import { diceLobbies } from "../../../../db/schema";
import { desc, eq } from "drizzle-orm";

export async function GET() {
  const rows = await db.select().from(diceLobbies).where(eq(diceLobbies.status, "waiting")).orderBy(desc(diceLobbies.createdAt)).limit(30);
  return NextResponse.json({ ok: true, lobbies: rows });
}
