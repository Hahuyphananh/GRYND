import { NextResponse } from "next/server";
import { computePotPrize } from "../../../../lib/tower-arena/payout";

// GET /api/tower-arena/payout-preview?wager=100
//
// Server-computed prize preview for the lobby, derived from the centralized
// Tower Arena payout config. The client NEVER recomputes pot / rake / prize
// math — it only displays the values returned here. There is no seat count:
// Tower Arena is 1v1, so the pot is always two entries.
export async function GET(req: Request) {
  try {
    const params = new URL(req.url).searchParams;
    const wager = Number(params.get("wager"));
    const cfg = computePotPrize({ wager });
    return NextResponse.json({ ok: true, preview: cfg });
  } catch (error) {
    return NextResponse.json({ ok: false, message: "Unable to compute prize preview" }, { status: 500 });
  }
}