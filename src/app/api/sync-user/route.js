// app/api/sync-user/route.js

import { auth } from "@clerk/nextjs/server";
import { db } from "../../../db/index";
import { users } from "../../../db/schema";
import { eq } from "drizzle-orm";

export async function POST() {
  try {
    const { userId } = auth();

    if (!userId) {
      return new Response("Unauthorized", { status: 401 });
    }

    const email = `${userId}@clerk.user`; // Replace with actual email retrieval logic
    const name = "Unnamed"; // Replace with actual name retrieval logic

    const existing = await db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    if (!existing.length) {
      await db.insert(users).values({
        name,
        email,
        password: "clerk-oauth",
        balance: "1000.00",
        gamesWon: 0,
        gamesLost: 0,
        createdAt: new Date(),
      });
    }

    return new Response("User synced", { status: 200 });
  } catch (err) {
    console.error("❌ sync-user error:", err);
    return new Response("Internal Server Error", { status: 500 });
  }
}
