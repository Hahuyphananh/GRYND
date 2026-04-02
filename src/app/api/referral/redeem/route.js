import { auth } from "@clerk/nextjs/server";
import { sql } from "@vercel/postgres";

const REFERRAL_BONUS = 250;

export async function POST(request) {
  const { userId } = await auth();

  if (!userId) {
    return new Response(JSON.stringify({ success: false, error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const { code } = await request.json();
    const normalizedCode = String(code || "").trim().toUpperCase();

    if (!normalizedCode) {
      return new Response(JSON.stringify({ success: false, error: "Referral code is required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const currentUserResult = await sql`SELECT id, referred_by_id FROM users WHERE clerk_id = ${userId} LIMIT 1`;
    const currentUser = currentUserResult.rows[0];

    if (!currentUser) {
      return new Response(JSON.stringify({ success: false, error: "User not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (currentUser.referred_by_id) {
      return new Response(JSON.stringify({ success: false, error: "Referral already redeemed" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const referrerResult = await sql`
      SELECT id, clerk_id FROM users WHERE referral_code = ${normalizedCode} LIMIT 1
    `;

    const referrer = referrerResult.rows[0];

    if (!referrer) {
      return new Response(JSON.stringify({ success: false, error: "Invalid referral code" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (Number(referrer.id) === Number(currentUser.id)) {
      return new Response(JSON.stringify({ success: false, error: "You cannot refer yourself" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    await sql.begin(async (tx) => {
      await tx`
        UPDATE users
        SET referred_by_id = ${referrer.id}
        WHERE id = ${currentUser.id}
      `;

      await tx`
        UPDATE users
        SET referral_count = COALESCE(referral_count, 0) + 1,
            referral_earnings = COALESCE(referral_earnings, 0) + ${REFERRAL_BONUS}
        WHERE id = ${referrer.id}
      `;

      await tx`
        UPDATE users
        SET balance = balance + ${REFERRAL_BONUS}
        WHERE id IN (${currentUser.id}, ${referrer.id})
      `;
    });

    return new Response(
      JSON.stringify({
        success: true,
        message: "Referral redeemed",
        reward: REFERRAL_BONUS,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("[REFERRAL_REDEEM_ERROR]", error);
    return new Response(JSON.stringify({ success: false, error: "Failed to redeem code" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
