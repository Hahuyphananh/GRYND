import { currentUser } from "@clerk/nextjs/server";
import { db } from "../../../db/index";
import { users } from "../../../db/schema";
import { eq } from "drizzle-orm";

export async function POST() {
  const clerkUser = await currentUser();
  if (!clerkUser || !clerkUser.emailAddresses?.[0]?.emailAddress) {
    return new Response("Unauthorized", { status: 401 });
  }

  const email = clerkUser.emailAddresses[0].emailAddress;
  const name = clerkUser.firstName || "Unnamed";
  const existingUser = await db.query.users.findFirst({
    where: eq(users.email, email),
  });

  if (!existingUser) {
    await db.insert(users).values({
      name,
      email,
      password: "clerk-oauth", // Placeholder since Clerk handles auth
      balance: "1000.00",
      gamesWon: 0,
      gamesLost: 0,
      createdAt: new Date(),
    });
  }

  return new Response("User synced", { status: 200 });
}
