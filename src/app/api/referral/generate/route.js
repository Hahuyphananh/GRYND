import { auth } from "@clerk/nextjs/server";
import { sql } from "../../../../db/sql";

function makeReferralCode(userId) {
  const prefix = userId
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(0, 4)
    .toUpperCase();
  const random = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `${prefix}${random}`;
}

export async function POST() {
  const { userId } = await auth();

  if (!userId) {
    return new Response(
      JSON.stringify({ success: false, error: "Unauthorized" }),
      {
        status: 401,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  try {
    const existing = await sql`
      SELECT referral_code FROM users WHERE clerk_id = ${userId} LIMIT 1
    `;

    if (!existing.rows.length) {
      return new Response(
        JSON.stringify({ success: false, error: "User not found" }),
        {
          status: 404,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    if (existing.rows[0].referral_code) {
      return new Response(
        JSON.stringify({
          success: true,
          referralCode: existing.rows[0].referral_code,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    let code = makeReferralCode(userId);
    for (let i = 0; i < 5; i += 1) {
      const conflict =
        await sql`SELECT id FROM users WHERE referral_code = ${code} LIMIT 1`;
      if (!conflict.rows.length) break;
      code = makeReferralCode(userId);
    }

    await sql`
      UPDATE users
      SET referral_code = ${code}
      WHERE clerk_id = ${userId}
    `;

    return new Response(JSON.stringify({ success: true, referralCode: code }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[REFERRAL_GENERATE_ERROR]", error);
    return new Response(
      JSON.stringify({
        success: false,
        error: "Failed to generate referral code",
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
}
