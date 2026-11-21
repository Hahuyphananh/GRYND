import { auth } from "@clerk/nextjs/server";
import { getNeonSql } from "../../../../db/neon";
import { parseAndValidateJson } from "../../../../lib/security/validation";
import { computeEquippedStreakTitle } from "../../../../lib/streakTitles";
import { searchNameFor } from "../../../../lib/searchName";

export async function POST(request) {
  const sql = getNeonSql();
  try {
    const { userId } = await auth();

    if (!userId) {
      return Response.json({ success: false, users: [] }, { status: 401 });
    }

    const parsed = await parseAndValidateJson(request, {
      name: { type: "string", required: true, minLength: 1, maxLength: 80 },
    });

    if (!parsed.ok) {
      return parsed.response;
    }

    const rawInput = parsed.data.name;

    // The ONE fold, shared with every write to `users.search_name` so the two
    // sides can never drift (src/lib/searchName.ts).
    const normalized = searchNameFor(rawInput);

    // A query that folds away to nothing (spaces, punctuation) would otherwise
    // become `LIKE '%%'` and return the first 10 accounts in the table.
    if (!normalized) {
      return Response.json({ success: true, users: [] });
    }

    let currentUserId = null;

    const current = await sql`
  SELECT id FROM users WHERE clerk_id = ${userId} LIMIT 1
`;

    if (current.length > 0) {
      currentUserId = current[0].id;
    }

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
    xp
  FROM users
  WHERE REPLACE(LOWER(COALESCE(NULLIF(search_name, ''), name)), ' ', '') LIKE '%' || ${queryString} || '%'
    AND id != ${currentUserId}
  ORDER BY name ASC
  LIMIT 10
`
      : await sql`
  SELECT id, name, selected_icon AS icon_key, selected_streak_type, daily_streak_current, daily_streak_best,
    xp
  FROM users
  WHERE REPLACE(LOWER(COALESCE(NULLIF(search_name, ''), name)), ' ', '') LIKE '%' || ${queryString} || '%'
  ORDER BY name ASC
  LIMIT 10
`;

    const users = found ?? [];

    // Compute the streak title for each user
    const usersWithStreak = users.map((u) => {
      const streakInfo = computeEquippedStreakTitle({
        selectedStreakType: u.selected_streak_type,
        dailyStreakCurrent: u.daily_streak_current,
        dailyStreakBest: u.daily_streak_best,
      });
      return {
        ...u,
        streakTitle: streakInfo.title,
      };
    });

    return Response.json({ success: true, users: usersWithStreak });
  } catch (error) {
    // Never echo the driver message: it names tables and columns and is
    // exactly the reconnaissance a signed-in caller should not get for free.
    console.error("[friends/search] failed:", error);
    return Response.json(
      { success: false, users: [] },
      { status: 500 },
    );
  }
}
