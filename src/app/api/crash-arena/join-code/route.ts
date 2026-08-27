import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db/client";
import { crashArenaTables } from "../../../../db/schema";
import { eq, ne, and, isNotNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { normalizeJoinCode } from "../../../../lib/crash-arena/joinCode";

/**
 * POST /api/crash-arena/join-code
 *
 * Body: { joinCode: string }
 *
 * Resolves a private-table invite code to its table (poker-style "join with
 * invite code" flow). Only PRIVATE tables have codes, so a code always
 * resolves to one. The player then navigates to the table with the code in
 * the URL, and the join route validates it again server-side.
 *
 * Returns the table id + basic info so the lobby can redirect the player
 * (and show a friendly confirmation). Signed-in only.
 */
export async function POST(req: Request) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }

    const { joinCode } = await req.json();
    const code = normalizeJoinCode(joinCode);
    if (!code) {
      return NextResponse.json({ success: false, error: "Enter an invite code" }, { status: 400 });
    }

    const [table] = await db
      .select({
        id: crashArenaTables.id,
        name: crashArenaTables.name,
        wager: crashArenaTables.wagerAmount,
        minBuyIn: crashArenaTables.minimumBuyin,
        status: crashArenaTables.status,
      })
      .from(crashArenaTables)
      .where(
        and(
          isNotNull(crashArenaTables.joinCode),
          eq(crashArenaTables.joinCode, code),
          ne(crashArenaTables.status, "closed"),
        ),
      )
      .limit(1);

    if (!table) {
      return NextResponse.json({
        success: false,
        error: "No private game matches that invite code",
      }, { status: 404 });
    }

    return NextResponse.json({
      success: true,
      data: {
        tableId: table.id,
        name: table.name,
        wager: Number(table.wager),
        minBuyIn: Number(table.minBuyIn),
      },
    });
  } catch (err) {
    console.error("[crash-arena:join-code]", err);
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}
