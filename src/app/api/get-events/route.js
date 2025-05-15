import { auth } from "@clerk/nextjs/server";
import { sql } from "@vercel/postgres";

/**
 * @param {Request} request
 * @returns {Promise<Response>}
 */
export async function POST(request) {
  const { userId } = auth();

  if (!userId) {
    return new Response(JSON.stringify({ error: "Utilisateur non authentifié" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  let { sportId } = await request.json();

  try {
    const baseQuery = `
      SELECT 
        e.id,
        e.home_team AS team1,
        e.away_team AS team2,
        e.start_time AS date,
        s1.odds AS odds1,
        s2.odds AS odds2,
        m.id AS market_id
      FROM events e
      JOIN markets m ON m.event_id = e.id AND m.name = 'Match Winner'
      JOIN selections s1 ON s1.market_id = m.id AND s1.name = e.home_team
      JOIN selections s2 ON s2.market_id = m.id AND s2.name = e.away_team
      WHERE e.status = 'scheduled'
      ${sportId ? "AND e.sport_id = $1" : ""}
      ORDER BY e.start_time ASC
      LIMIT 10
    `;

    const queryParams = sportId ? [sportId] : [];
    const { rows: events } = await sql(baseQuery, queryParams);

    return new Response(JSON.stringify({ events }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("❌ Error fetching matches:", err);
    return new Response(JSON.stringify({ error: "Erreur serveur" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
