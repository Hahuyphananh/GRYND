// /api/get-events/route.js
import { auth } from "@clerk/nextjs/server";

export async function POST(req) {
  const { userId } = auth();
  if (!userId) {
    return new Response(JSON.stringify({ error: "Not authenticated" }), { status: 401 });
  }

  const { sportId } = await req.json();
  if (!sportId) {
    return new Response(JSON.stringify({ error: "sportId is required" }), { status: 400 });
  }

  try {
    const response = await fetch(
      `https://api.the-odds-api.com/v4/sports/${sportId}/odds/?regions=eu&markets=h2h&apiKey=${process.env.ODDS_API_KEY}`
    );
    const data = await response.json();

    const events = data.map(event => ({
      id: event.id,
      team1: event.bookmakers?.[0]?.markets?.[0]?.outcomes?.[0]?.name || "Team A",
      team2: event.bookmakers?.[0]?.markets?.[0]?.outcomes?.[1]?.name || "Team B",
      odds1: event.bookmakers?.[0]?.markets?.[0]?.outcomes?.[0]?.price || 0,
      odds2: event.bookmakers?.[0]?.markets?.[0]?.outcomes?.[1]?.price || 0,
      date: event.commence_time,
    }));

    return new Response(JSON.stringify({ events }), {
      headers: { "Content-Type": "application/json" },
      status: 200,
    });
  } catch (err) {
    console.error("OddsAPI events error:", err);
    return new Response(JSON.stringify({ error: "Server error fetching events" }), { status: 500 });
  }
}
