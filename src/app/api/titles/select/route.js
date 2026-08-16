import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db";
import { eq } from "drizzle-orm";
import { users } from "../../../../db/schema";
import { isTitleUnlocked, getTitleByName } from "../../../../lib/titles";

export async function POST(request) {
  const { userId } = await auth();

  if (!userId) {
    return new Response(
      JSON.stringify({
        success: false,
        error: "Unauthorized",
      }),
      {
        status: 401,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  try {
    const body = await request.json();
    const title = String(body?.title || "").trim();

    const dbUser = await db.query.users.findFirst({
      where: eq(users.clerkId, userId),
      columns: {
        id: true,
        level: true,
      },
    });

    if (!dbUser) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "User not found",
        }),
        {
          status: 404,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    //  UNEQUIP TITLE
    if (!title) {
      await db
        .update(users)
        .set({
          selectedTitle: null,
        })
        .where(eq(users.id, dbUser.id));

      return new Response(
        JSON.stringify({
          success: true,
          selectedTitle: null,
          message: "Title unequipped",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    const titleMeta = getTitleByName(title);

    if (!titleMeta) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Unknown title",
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    if (!isTitleUnlocked(Number(dbUser.level || 1), title)) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Title is still locked",
        }),
        {
          status: 403,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    await db
      .update(users)
      .set({
        selectedTitle: title,
      })
      .where(eq(users.id, dbUser.id));

    return new Response(
      JSON.stringify({
        success: true,
        selectedTitle: title,
        rarity: titleMeta.rarity,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    console.error("[SELECT_TITLE_ERROR]", error);

    return new Response(
      JSON.stringify({
        success: false,
        error: "Failed to select title",
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
}
