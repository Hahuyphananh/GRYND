import { auth } from "@clerk/nextjs/server";
import { sql } from "@vercel/postgres";

export async function POST(req) {
  const { userId } = await auth();
  if (!userId) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
    });
  }

  try {
    const { eventId, betAmount, choice, odds, marketType = null, lineValue = null } = await req.json();

    if (!eventId || !betAmount || !choice || !odds) {
      return new Response(JSON.stringify({ error: "Missing fields" }), {
        status: 400,
      });
    }

    const balanceResult = await sql`
  SELECT balance FROM users WHERE clerk_id = ${userId}
`;

    const userBalance = parseFloat(balanceResult.rows[0]?.balance ?? 0);
    if (userBalance < betAmount) {
      return new Response(JSON.stringify({ error: "Insufficient balance" }), {
        status: 400,
      });
    }

    try {
      await sql`
        INSERT INTO sports_bets (user_id, event_external_id, bet_amount, choice, odds, market_type, line_value)
        VALUES (${userId}, ${String(eventId)}, ${betAmount}, ${choice}, ${odds}, ${marketType}, ${lineValue})
      `;
    } catch (migrationErr) {
  console.error("🔥 REAL INSERT ERROR:", migrationErr);

  const legacyEventId = Number(eventId);

  if (!Number.isFinite(legacyEventId)) {
    return new Response(
      JSON.stringify({
        error: "Insert failed",
        detail: migrationErr.message, // 👈 SHOW REAL ERROR
      }),
      { status: 400 }
    );
  }

  await sql`
    INSERT INTO sports_bets (user_id, event_id, bet_amount, choice, odds)
    VALUES (${userId}, ${legacyEventId}, ${betAmount}, ${choice}, ${odds})
  `;
}

    const newBalance = userBalance - betAmount;
    await sql`
  UPDATE users SET balance = ${newBalance}
  WHERE clerk_id = ${userId}
`;

    return new Response(JSON.stringify({ success: true, newBalance }), { status: 200 });
  } catch (error) {
    console.error("Error placing sports bet:", error);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
    });
  }
}
