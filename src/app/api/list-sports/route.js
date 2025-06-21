// /api/list-sports/route.js (or .ts if using TypeScript)
import { auth } from "@clerk/nextjs/server";

export async function POST(req) {
  const { userId } = auth();
  if (!userId) {
    return new Response(JSON.stringify({ error: "Not authenticated" }), { status: 401 });
  }

  try {
    const response = await fetch(`https://api.the-odds-api.com/v4/sports/?apiKey=${process.env.ODDS_API_KEY}`);
    const data = await response.json();

    const sports = data.map(sport => ({
      id: sport.key,
      name: sport.title,
      icon_name: "futbol", // default icon or based on sport.key
    }));

    return new Response(JSON.stringify({ sports }), {
      headers: { "Content-Type": "application/json" },
      status: 200,
    });
  } catch (err) {
    console.error("OddsAPI sports error:", err);
    return new Response(JSON.stringify({ error: "Server error fetching sports" }), { status: 500 });
  }
}
