import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db";
import { eq } from "drizzle-orm";
import { users } from "../../../../db/schema";
import { getHighestTitle, isTitleUnlocked } from "../../../../lib/titles";

export async function POST() {
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
      columns: { id: true, level: true, highestTitle: true, selectedTitle: true },
    });

    if (!dbUser) {
      return new Response(JSON.stringify({ success: false, error: "User not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    const level = Number(dbUser.level || 1);
    const computedHighest = getHighestTitle(level);
    const highestTitle = computedHighest?.title || null;
    const unlockedNow = !!highestTitle && highestTitle !== dbUser.highestTitle;

    const updates = {};
    if (unlockedNow) updates.highestTitle = highestTitle;

    if (dbUser.selectedTitle && !isTitleUnlocked(level, dbUser.selectedTitle)) {
      updates.selectedTitle = null;
    }

    if (Object.keys(updates).length) {
      await db.update(users).set(updates).where(eq(users.id, dbUser.id));
    }

    return new Response(
      JSON.stringify({
        success: true,
        level,
        highestTitle,
        newUnlockedTitle: unlockedNow ? highestTitle : null,
        selectedTitle: updates.selectedTitle === null ? null : dbUser.selectedTitle,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("[SYNC_TITLE_ERROR]", error);
    return new Response(JSON.stringify({ success: false, error: "Failed to sync titles" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
