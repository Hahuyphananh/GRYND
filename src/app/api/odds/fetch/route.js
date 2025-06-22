import { NextResponse } from "next/server";

export async function POST() {
  try {
    const apiKey = process.env.API_KEY;
    const url = `https://api.the-odds-api.com/v4/sports/?apiKey=${apiKey}`;

    const res = await fetch(url);
    const data = await res.json();

    return NextResponse.json({ success: true, data });
  } catch (err) {
    console.error("Odds API fetch error:", err);
    return NextResponse.json({ success: false, error: "Failed to fetch odds data" }, { status: 500 });
  }
}
