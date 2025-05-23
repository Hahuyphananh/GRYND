// /app/api/sync-user/route.ts
import { auth } from "@clerk/nextjs";
import { NextResponse } from "next/server";
import { sql } from "@vercel/postgres";

export async function POST() {
  try {
    const { userId } = auth();

    if (!userId) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }

    // Fetch user data from Clerk
    const response = await fetch(`https://api.clerk.com/v1/users/${userId}`, {
      headers: {
        Authorization: `Bearer ${process.env.CLERK_SECRET_KEY}`,
      },
    });

    const clerkUser = await response.json();

    const email = clerkUser.email_addresses?.[0]?.email_address ?? null;
    const firstName = clerkUser.first_name ?? null;
    const lastName = clerkUser.last_name ?? null;
    const username = clerkUser.username ?? null;
    const imageUrl = clerkUser.image_url ?? null;

    if (!email) {
      return NextResponse.json({ success: false, error: "Missing email from Clerk" }, { status: 400 });
    }

    // Insert or update user
    await sql`
      INSERT INTO users (id, email, username, first_name, last_name, image_url)
      VALUES (${userId}, ${email}, ${username}, ${firstName}, ${lastName}, ${imageUrl})
      ON CONFLICT (id) DO UPDATE SET
        email = EXCLUDED.email,
        username = EXCLUDED.username,
        first_name = EXCLUDED.first_name,
        last_name = EXCLUDED.last_name,
        image_url = EXCLUDED.image_url,
        updated_at = NOW();
    `;

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("Sync user error:", err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}
