import { NextResponse } from "next/server";

export async function GET(
  req: Request,
  context: { params: { sport: string } }
) {
  const { sport } = context.params; // ✅ use context

  try {
    const res = await fetch(
      `https://api.the-odds-api.com/v4/sports/${sport}/odds/?apiKey=${process.env.ODDS_API_KEY}&regions=us&markets=h2h&oddsFormat=decimal`,
      { cache: "no-store" } // optional: avoids stale caching
    );

    if (!res.ok) throw new Error("Failed to fetch odds");

    const data = await res.json();

    return NextResponse.json({ success: true, events: data });
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err.message },
      { status: 500 }
    );
  }
}
