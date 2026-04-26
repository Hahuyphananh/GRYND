import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db";
import { specialTitles, userSpecialTitles, users } from "../../../../db/schema";
import { and, eq } from "drizzle-orm";

export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return new Response(JSON.stringify({ success: false, error: "Unauthorized" }), { status: 401 });
  }

  const appUser = await db.query.users.findFirst({
    where: eq(users.clerkId, userId),
    columns: { id: true, selectedSpecialTitle: true },
  });

  if (!appUser) {
    return new Response(JSON.stringify({ success: false, error: "User not found" }), { status: 404 });
  }

  const allTitles = await db.select().from(specialTitles);
  const unlockedRows = await db
    .select({ titleKey: userSpecialTitles.titleKey, unlockedAt: userSpecialTitles.unlockedAt })
    .from(userSpecialTitles)
    .where(eq(userSpecialTitles.userId, appUser.id));

  const unlockedMap = new Map(unlockedRows.map((row) => [row.titleKey, row.unlockedAt]));

  const titles = allTitles.map((title) => ({
    ...title,
    unlocked: unlockedMap.has(title.key),
    unlockedAt: unlockedMap.get(title.key) || null,
  }));

  const selectedSpecialTitleName = titles.find((title) => title.key === appUser.selectedSpecialTitle)?.name || null;

  return new Response(
    JSON.stringify({
      success: true,
      selectedSpecialTitle: appUser.selectedSpecialTitle,
      selectedSpecialTitleName,
      unlockedCount: unlockedRows.length,
      totalCount: allTitles.length,
      titles,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}
