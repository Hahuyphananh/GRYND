import { NextResponse } from "next/server";

export async function GET() {
  try {
    const res = await fetch(
      `https://api.the-odds-api.com/v4/sports/?apiKey=${process.env.ODDS_API_KEY}`,
    );

    if (!res.ok) throw new Error("Failed to fetch sports list");

    const data = await res.json();

    return NextResponse.json({ success: true, sports: data });
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err.message },
      { status: 500 },
    );
  }
}
