import { auth } from "@clerk/nextjs/server";
import { getNeonSql } from "../../../../db/neon";
import { parseAndValidateJson } from "../../../../lib/security/validation";
import { computeEquippedStreakTitle } from "../../../../lib/streakTitles";
import { resolvePrestigeBadge } from "../../../../lib/prestige";
import { searchNameFor } from "../../../../lib/searchName";

export async function POST(request) {
  const sql = getNeonSql();
  try {
    const { userId } = await auth();

    if (!userId) {
      return Response.json(
        {
          success: false,
          users: [],
          debug: {
            step: "auth",
            error: "Unauthorized",
          },
        },
        { status: 401 },
      );
    }

    const parsed = await parseAndValidateJson(request, {
      name: { type: "string", required: true, minLength: 1, maxLength: 80 },
    });

    if (!parsed.ok) {
      return parsed.response;
    }

    //  DEBUG 1
    const rawInput = parsed.data.name;

    // The ONE fold, shared with every write to `users.search_name` so the two
    // sides can never drift (src/lib/searchName.ts).
    const normalized = searchNameFor(rawInput);

    // A query that folds away to nothing (spaces, punctuation) would otherwise
    // become `LIKE '%%'` and return the first 10 accounts in the table.
    if (!normalized) {
      return Response.json({
        success: true,
        users: [],
        debug: { rawInput, normalized, resultCount: 0 },
      });
    }

    let currentUserId = null;

    const current = await sql`
  SELECT id FROM users WHERE clerk_id = ${userId} LIMIT 1
`;

    if (current.length > 0) {
      currentUserId = current[0].id;
    }

    //  DEBUG 3
    const queryString = normalized;

    // Match on the folded `search_name`. The fallback to `name` covers rows
    // written before the column was maintained (and any row seeded outside the
    // app), so a search never silently returns nothing for a real account.
    // The REPLACE/LOWER stay so a fallback name that still carries spaces or
    // capitals matches the folded query too.
    //
    // The self-exclusion is a whole separate statement, NOT an inline
    // `sql`${currentUserId ? sql`AND id != ...` : sql``}` fragment:
    // `getNeonSql()` (src/db/neon.ts) is a plain tagged-template helper, not
    // Neon's nesting-capable one — a nested fragment is interpolated as a bare
    // `$n` placeholder, so the previous form produced
    // `... LIKE $1 $2 ORDER BY` and every search failed to parse (500), which
    // the profile UI swallowed as "no results".
    const found = currentUserId
      ? await sql`
  SELECT id, name, selected_icon AS icon_key, selected_streak_type, daily_streak_current, daily_streak_best,
    xp, prestige_level, show_prestige_badge
  FROM users
  WHERE REPLACE(LOWER(COALESCE(NULLIF(search_name, ''), name)), ' ', '') LIKE '%' || ${queryString} || '%'
    AND id != ${currentUserId}
  ORDER BY name ASC
  LIMIT 10
`
      : await sql`
  SELECT id, name, selected_icon AS icon_key, selected_streak_type, daily_streak_current, daily_streak_best,
    xp, prestige_level, show_prestige_badge
  FROM users
  WHERE REPLACE(LOWER(COALESCE(NULLIF(search_name, ''), name)), ' ', '') LIKE '%' || ${queryString} || '%'
  ORDER BY name ASC
  LIMIT 10
`;

    const users = found ?? [];

    // Compute streak titles + server-resolved prestige badges for each user
    const usersWithStreak = users.map((u) => {
      const streakInfo = computeEquippedStreakTitle({
        selectedStreakType: u.selected_streak_type,
        dailyStreakCurrent: u.daily_streak_current,
        dailyStreakBest: u.daily_streak_best,
      });
      return {
        ...u,
        streakTitle: streakInfo.title,
        prestigeBadge: resolvePrestigeBadge({
          xp: u.xp,
          prestigeLevel: u.prestige_level,
          showPrestigeBadge: u.show_prestige_badge,
        }),
      };
    });

    //  EVERYTHING DEBUGGED HERE
    return Response.json({
      success: true,
      users: usersWithStreak,
      debug: {
        rawInput,
        normalized,
        queryString,
        currentUserId,
        resultCount: usersWithStreak.length,
        results: usersWithStreak,
      },
    });
  } catch (error) {
    return Response.json(
      {
        success: false,
        users: [],
        debug: {
          error: error?.message || "Unknown error",
        },
      },
      { status: 500 },
    );
  }
}
