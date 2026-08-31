import { NextResponse } from "next/server";
import { computePotPrize } from "../../../../lib/tower-arena/payout";

// GET /api/tower-arena/payout-preview?wager=100&maxPlayers=6
//
// Server-computed prize preview for the lobby, derived from the centralized
// Tower Arena payout config. The client NEVER recomputes pot / rake / prize
// math — it only displays the values returned here.
export async function GET(req: Request) {
  try {
    const params = new URL(req.url).searchParams;
    const wager = Number(params.get("wager"));
    const maxPlayers = Number(params.get("maxPlayers"));
    const cfg = computePotPrize({ maxPlayers, wager });
    return NextResponse.json({ ok: true, preview: cfg });
  } catch (error) {
    return NextResponse.json({ ok: false, message: "Unable to compute prize preview" }, { status: 500 });
  }
}