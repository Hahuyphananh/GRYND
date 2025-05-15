import { auth } from "@clerk/nextjs/server";
import { sql } from "@vercel/postgres";
import cheerio from "cheerio";

const MAX_RETRIES = 3;

/**
 * Fetch and sync sports data from ESPN
 * @param {number} retryCount
 * @returns {Promise<Response>}
 */
async function syncSportsData(retryCount = 0) {
  const { userId } = auth();

  if (!userId) {
    return new Response(JSON.stringify({
      success: false,
      error: "Utilisateur non authentifié",
    }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const sports = [
    {
      name: "Football",
      url: "https://www.espn.com/soccer/fixtures",
      icon_name: "football",
    },
    {
      name: "Basketball",
      url: "https://www.espn.com/nba/schedule",
      icon_name: "basketball",
    },
    {
      name: "Tennis",
      url: "https://www.espn.com/tennis/schedule",
      icon_name: "tennis",
    },
  ];

  try {
    for (const sport of sports) {
      try {
        const { rows: existingSport } = await sql`
          SELECT id FROM sports WHERE name = ${sport.name}
        `;

        const sportId = existingSport.length
          ? existingSport[0].id
          : (
              await sql`
                INSERT INTO sports (name, icon_name, is_active)
                VALUES (${sport.name}, ${sport.icon_name}, true)
                RETURNING id
              `
            )[0].id;

        const response = await fetch("/integrations/web-scraping/post", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: sport.url, getText: false }),
        });

        if (!response.ok) {
          throw new Error(`Failed to fetch ${sport.name} (${response.status})`);
        }

        const html = await response.text();
        const $ = cheerio.load(html);
        const events = [];

        $(".Table__TBODY tr").each((i, row) => {
          const teams = $(row).find("td:nth-child(1) a");
          if (teams.length >= 2) {
            const competition = $(row).closest(".Table").prev().text().trim();
            const homeTeam = $(teams[0]).text().trim();
            const awayTeam = $(teams[1]).text().trim();
            const startTime = new Date(
              $(row).find("td:nth-child(2)").attr("data-date")
            );

            if (homeTeam && awayTeam && !isNaN(startTime)) {
              events.push({ competition, homeTeam, awayTeam, startTime });
            }
          }
        });

        for (const event of events) {
          const { rows: existing } = await sql`
            SELECT id FROM events 
            WHERE home_team = ${event.homeTeam} 
              AND away_team = ${event.awayTeam}
              AND start_time = ${event.startTime}
          `;

          if (!existing.length) {
            await sql`
              INSERT INTO events (sport_id, competition, home_team, away_team, start_time)
              VALUES (
                ${sportId}, 
                ${event.competition}, 
                ${event.homeTeam}, 
                ${event.awayTeam}, 
                ${event.startTime}
              )
            `;
          }
        }
      } catch (err) {
        console.error(`❌ Error processing ${sport.name}:`, err);
        if (retryCount < MAX_RETRIES) {
          return syncSportsData(retryCount + 1);
        }
        throw err;
      }
    }

    return new Response(JSON.stringify({
      success: true,
      message: "Sports data synchronized successfully",
      retryCount,
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  } catch (error) {
    console.error("❌ Sync failure:", error);
    return new Response(JSON.stringify({
      success: false,
      error: `Failed to sync sports data: ${error.message}`,
      retryCount,
    }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

/**
 * Route entry
 * @param {Request} request
 * @returns {Promise<Response>}
 */
export async function POST(request) {
  return syncSportsData();
}
