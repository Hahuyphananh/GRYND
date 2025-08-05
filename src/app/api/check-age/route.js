import { getAuth } from "@clerk/nextjs/server";
import { db } from "../../../db/client"; // adjust path
import { users } from "../../../db/schema";
import { eq } from "drizzle-orm";

export default async function handler(req, res) {
  const { userId } = getAuth(req);

  if (!userId) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const user = await db.query.users.findFirst({
      where: eq(users.clerkId, userId),
    });

    if (!user || !user.age) {
      return res.status(400).json({ error: "Profile incomplete" });
    }

    if (user.age < 18) {
      return res.status(403).json({ error: "Access denied - underage" });
    }

    return res.status(200).json({ age: user.age });
  } catch (err) {
    return res.status(500).json({ error: "Server error" });
  }
}
