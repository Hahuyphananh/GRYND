import { NextResponse } from "next/server";
import { db } from "../../../../db/client";
import { slotJackpots } from "../../../../db/schema";
import { eq } from "drizzle-orm";

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const theme = searchParams.get("theme") || "fruit";

    const [row] = await db
      .select({ amount: slotJackpots.amount })
      .from(slotJackpots)
      .where(eq(slotJackpots.theme, theme));

    // If no row exists yet (e.g., migration hasn't run), return 0
    const amount = row ? Number(row.amount) : 0;

    return NextResponse.json({ success: true, data: { theme, amount } });
  } catch (err) {
    console.error("Jackpot fetch error:", err);
    return NextResponse.json({ success: true, data: { amount: 0 } }, { status: 200 });
  }
}
