import { auth } from "@clerk/nextjs/server";
import { and, eq } from "drizzle-orm";
import { db } from "../../../../db";
import { userSpecialTitles, users } from "../../../../db/schema";

export async function POST(request) {
  const { userId } = await auth();
  if (!userId) {
    return new Response(
      JSON.stringify({ success: false, error: "Unauthorized" }),
      { status: 401 },
    );
  }

  const { titleKey } = await request.json();
  const normalizedKey = String(titleKey || "").trim();

  const appUser = await db.query.users.findFirst({
    where: eq(users.clerkId, userId),
    columns: { id: true },
  });

  if (!appUser) {
    return new Response(
      JSON.stringify({ success: false, error: "User not found" }),
      { status: 404 },
    );
  }

  if (!normalizedKey) {
    await db
      .update(users)
      .set({ selectedSpecialTitle: null })
      .where(eq(users.id, appUser.id));
    return new Response(
      JSON.stringify({ success: true, selectedSpecialTitle: null }),
      { status: 200 },
    );
  }

  const unlocked = await db
    .select({ id: userSpecialTitles.id })
    .from(userSpecialTitles)
    .where(
      and(
        eq(userSpecialTitles.userId, appUser.id),
        eq(userSpecialTitles.titleKey, normalizedKey),
      ),
    )
    .limit(1);

  if (!unlocked.length) {
    return new Response(
      JSON.stringify({ success: false, error: "Title not unlocked" }),
      { status: 403 },
    );
  }

  // Equipping a special title clears every other title slot —
  // the user can only ever display one title at a time.
  await db
    .update(users)
    .set({
      selectedSpecialTitle: normalizedKey,
      selectedTitle: null,
      selectedStreakType: null,
      showPrestigeBadge: false,
    })
    .where(eq(users.id, appUser.id));

  return new Response(
    JSON.stringify({ success: true, selectedSpecialTitle: normalizedKey }),
    { status: 200 },
  );
}
