import { auth } from "@clerk/nextjs/server";
import { sql } from "@vercel/postgres";

/**
 * @param {Request} request
 * @returns {Promise<Response>}
 */
export async function POST(request) {
  const { userId } = auth();

  if (!userId) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  let { limit } = await request.json();

  if (!limit || typeof limit !== "number" || limit <= 0 || limit > 100) {
    limit = 10;
  }

  try {
    const { rows: events } = await sql`
      SELECT 
        e.*,
        s.name as sport_name,
        s.icon_name as sport_icon,
        json_agg(
          json_build_object(
            'id', m.id,
            'name', m.name,
            'selections', (
              SELECT json_agg(
                json_build_object(
                  'id', sel.id,
                  'name', sel.name,
                  'odds', sel.odds
                )
              )
              FROM selections sel
              WHERE sel.market_id = m.id 
              AND sel.status = 'active'
            )
          )
        ) as markets
      FROM events e
      JOIN sports s ON e.sport_id = s.id
      LEFT JOIN markets m ON m.event_id = e.id
      WHERE e.start_time > NOW()
      GROUP BY e.id, s.name, s.icon_name
      ORDER BY e.start_time
      LIMIT ${limit}
    `;

    return new Response(JSON.stringify({ events }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("❌ Error fetching events:", err);
    return new Response(JSON.stringify({ error: "Failed to fetch events" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
