async function handler({ retryCount = 0 } = {}) {
  const MAX_RETRIES = 3;
  const session = getSession();

  if (!session?.user?.id) {
    throw new Error("Unauthorized");
  }

  try {
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

    for (const sport of sports) {
      try {
        const existingSport = await sql(
          "SELECT id FROM sports WHERE name = $1",
          [sport.name]
        );

        const sportId = existingSport.length
          ? existingSport[0].id
          : (
              await sql(
                "INSERT INTO sports (name, icon_name, is_active) VALUES ($1, $2, $3) RETURNING id",
                [sport.name, sport.icon_name, true]
              )
            )[0].id;

        const response = await fetch("/integrations/web-scraping/post", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: sport.url,
            getText: false,
          }),
        });

        if (!response.ok) {
          throw new Error(
            `Failed to fetch ${sport.name} data: ${response.status}`
          );
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

            if (homeTeam && awayTeam && startTime) {
              events.push({ competition, homeTeam, awayTeam, startTime });
            }
          }
        });

        for (const event of events) {
          const existingEvent = await sql(
            "SELECT id FROM events WHERE home_team = $1 AND away_team = $2 AND start_time = $3",
            [event.homeTeam, event.awayTeam, event.startTime]
          );

          if (!existingEvent.length) {
            await sql.transaction([
              sql`
                INSERT INTO events (sport_id, competition, home_team, away_team, start_time)
                VALUES (${sportId}, ${event.competition}, ${event.homeTeam}, ${event.awayTeam}, ${event.startTime})
              `,
            ]);
          }
        }
      } catch (sportError) {
        console.error(`Error processing ${sport.name}:`, sportError);

        if (retryCount < MAX_RETRIES) {
          return handler({ retryCount: retryCount + 1 });
        }
        throw sportError;
      }
    }

    return {
      success: true,
      message: "Sports data synchronized successfully",
      retryCount,
    };
  } catch (error) {
    return {
      success: false,
      error: `Failed to sync sports data: ${error.message}`,
      retryCount,
    };
  }
}
export async function POST(request) {
  return handler(await request.json());
}