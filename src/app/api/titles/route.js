import { auth } from "@clerk/nextjs/server";
import { db } from "../../../db";
import { eq } from "drizzle-orm";
import { users } from "../../../db/schema";
import { TITLE_MILESTONES, getUnlockedTitles, getHighestTitle, getNextTitle } from "../../../lib/titles";

export async function GET() {
  const { userId } = await auth();

  if (!userId) {
    return new Response(JSON.stringify({ success: false, error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const dbUser = await db.query.users.findFirst({
      where: eq(users.clerkId, userId),
      columns: {
        level: true,
        selectedTitle: true,
        highestTitle: true,
      },
    });

    if (!dbUser) {
      return new Response(JSON.stringify({ success: false, error: "User not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    const level = Number(dbUser.level || 1);
    const unlockedTitles = getUnlockedTitles(level);
    const computedHighest = getHighestTitle(level);
    const nextTitle = getNextTitle(level);

    return new Response(
      JSON.stringify({
        success: true,
        level,
        unlockedTitles,
        selectedTitle: dbUser.selectedTitle || null,
        highestTitle: dbUser.highestTitle || computedHighest?.title || null,
        nextTitle,
        allTitles: TITLE_MILESTONES,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("[GET_TITLES_ERROR]", error);
    return new Response(JSON.stringify({ success: false, error: "Failed to load titles" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
