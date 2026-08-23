import { auth, clerkClient } from "@clerk/nextjs/server";
import { db } from "../../../db/client";
import { users } from "../../../db/schema";
import { eq } from "drizzle-orm";

export async function POST(req) {
  const { userId } = await auth();
  const { birthDate } = await req.json();

  if (!userId) {
    return new Response(
      JSON.stringify({ success: false, error: "Unauthorized" }),
      {
        status: 401,
      },
    );
  }

  // Calculate age
  const age = Math.floor(
    (Date.now() - new Date(birthDate).getTime()) /
      (365.25 * 24 * 60 * 60 * 1000),
  );

  if (age < 18) {
    return new Response(
      JSON.stringify({ success: false, error: "Must be 18+" }),
      {
        status: 403,
      },
    );
  }

  try {
    // Update age in DB
    await db.update(users).set({ age }).where(eq(users.clerkId, userId));

    // Persist the actual birth date to Clerk public metadata — the privacy
    // policy promises DOB is stored for age verification, and
    // useAgeVerification() reads it from there. Best-effort: if Clerk
    // fails, the DB age still gates access, so don't fail the request.
    try {
      const client = await clerkClient();
      await client.users.updateUser(userId, {
        publicMetadata: { birthDate },
      });
    } catch (clerkErr) {
      console.error("Error persisting birthDate to Clerk metadata:", clerkErr);
    }

    return new Response(JSON.stringify({ success: true, age }), {
      status: 200,
    });
  } catch (error) {
    console.error("Error updating age:", error);
    return new Response(
      JSON.stringify({ success: false, error: "Server error" }),
      {
        status: 500,
      },
    );
  }
}
