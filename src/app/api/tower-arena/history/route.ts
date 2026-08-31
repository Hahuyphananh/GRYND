import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { listTowerArenaHistory } from "../../../../lib/tower-arena/serverStore";

export async function GET(req: Request) {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ ok: false, message: "Unauthorized" }, { status: 401 });
    const limit = Number(new URL(req.url).searchParams.get("limit") || 30);
    const res: any = await listTowerArenaHistory({ userId, limit: Number.isNaN(limit) ? 30 : limit });
    if (res.error) return NextResponse.json({ ok: false, message: res.error }, { status: res.status || 400 });
    return NextResponse.json({ ok: true, matches: res });
  } catch (error) {
    return NextResponse.json({ ok: false, message: "Unable to load history" }, { status: 500 });
  }
}