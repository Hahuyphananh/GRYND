import { NextResponse } from "next/server";
import { parseAndValidateJson } from "../../../lib/security/validation";

export async function POST(request) {
  try {
    const parsed = await parseAndValidateJson(request, {
      sportId: {
        type: "string",
        required: true,
        minLength: 3,
        maxLength: 64,
        pattern: /^[a-z0-9_\-]+$/i,
      },
    });

    if (!parsed.ok) return parsed.response;

    const { sportId } = parsed.data;
    const apiKey = process.env.ODDS_API_KEY;

    if (!apiKey) {
      return NextResponse.json(
        { success: false, error: "ODDS_API_KEY is not configured" },
        { status: 500 }
      );
    }

    const oddsUrl = `https://api.the-odds-api.com/v4/sports/${sportId}/odds/?apiKey=${apiKey}&regions=eu&markets=h2h&oddsFormat=decimal`;
    const res = await fetch(oddsUrl, { cache: "no-store" });

    if (!res.ok) {
      return NextResponse.json(
        { success: false, error: "Failed to fetch events data" },
        { status: res.status }
      );
    }

    const data = await res.json();
    const events = Array.isArray(data)
      ? data.map((event) => ({
          id: event.id,
          team1: event.bookmakers?.[0]?.markets?.[0]?.outcomes?.[0]?.name ?? null,
          team2: event.bookmakers?.[0]?.markets?.[0]?.outcomes?.[1]?.name ?? null,
          date: event.commence_time,
          odds1: event.bookmakers?.[0]?.markets?.[0]?.outcomes?.[0]?.price ?? null,
          odds2: event.bookmakers?.[0]?.markets?.[0]?.outcomes?.[1]?.price ?? null,
          oddsDraw: null,
        }))
      : [];

    return NextResponse.json({ success: true, events }, { status: 200 });
  } catch (err) {
    console.error("Error in /api/get-events:", err);
    console.log("force redeploy");
    return NextResponse.json(
      { success: false, error: "Erreur serveur" },
      { status: 500 }
    );
  }
}
