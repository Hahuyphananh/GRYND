import { NextResponse } from "next/server";
import { db } from "../../../../db";
import { desc, eq } from "drizzle-orm";
import { poolLobbies } from "../../../../db/schema";

export async function GET() {
  const rows = await db.select().from(poolLobbies).where(eq(poolLobbies.status, "waiting")).orderBy(desc(poolLobbies.createdAt)).limit(30);
  return NextResponse.json({ success: true, lobbies: rows });
}
