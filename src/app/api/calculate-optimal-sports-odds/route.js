import { auth } from "@clerk/nextjs/server";
import { sql } from "@vercel/postgres";

async function handler({ eventId }) {
  const { userId } = auth();

  if (!userId) {
    return new Response(
      JSON.stringify({ error: "Unauthorized" }),
      { status: 401, headers: { "Content-Type": "application/json" } }
    );
  }

  try {
    const [event] = await sql`
      SELECT * FROM events WHERE id = ${eventId}
    `.then(res => res.rows);

    if (!event) {
      return new Response(
        JSON.stringify({ error: "Event not found" }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    const historicalData = await sql`
      SELECT result_home, result_away 
      FROM events 
      WHERE sport_id = ${event.sport_id}
      AND status = 'completed'
      LIMIT 100
    `;

    let homeWins = 0;
    let draws = 0;
    let awayWins = 0;

    historicalData.rows.forEach((match) => {
      if (match.result_home > match.result_away) homeWins++;
      else if (match.result_home === match.result_away) draws++;
      else awayWins++;
    });

    const total = historicalData.rows.length || 1;
    const BASE_MARGIN = 0.05;

    const probabilities = [
      homeWins / total,
      draws / total,
      awayWins / total
    ];

    const adjustedOdds = probabilities.map(
      (prob) => 1 / (prob * (1 + BASE_MARGIN))
    );

    await sql`
      UPDATE events
      SET odds_a = ${adjustedOdds[0]},
          odds_draw = ${adjustedOdds[1]},
          odds_b = ${adjustedOdds[2]}
      WHERE id = ${eventId}
    `;

    return new Response(
      JSON.stringify({
        success: true,
        odds: {
          teamA: adjustedOdds[0].toFixed(2),
          draw: adjustedOdds[1].toFixed(2),
          teamB: adjustedOdds[2].toFixed(2)
        }
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Odds calculation error:", error);
    return new Response(
      JSON.stringify({ error: "Failed to calculate optimal odds" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}

export async function POST(request) {
  const body = await request.json();
  return handler(body);
}
