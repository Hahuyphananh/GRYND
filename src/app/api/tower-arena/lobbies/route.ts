import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { listOpenTowerArenaMatches } from "../../../../lib/tower-arena/serverStore";

export async function GET() {
  try {
    const { userId } = await auth();
    const lobbies = await listOpenTowerArenaMatches({
      excludeUserId: userId ?? undefined,
    });
    return NextResponse.json({ ok: true, lobbies });
  } catch (error) {
    return NextResponse.json({ ok: false, message: "Unable to list lobbies" }, { status: 500 });
  }
}