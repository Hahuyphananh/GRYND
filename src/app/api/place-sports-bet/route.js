import { auth } from "@clerk/nextjs/server";
import { getNeonSql } from "@/db/neon";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req) {
  try {
    const sql = getNeonSql();
    const { userId } = await auth();

    if (!userId) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Safe body parsing for Vercel
    let body;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    // Extract values
    const eventId = String(body.eventId || "").trim();
    const choice = String(body.choice || "").trim();
    const marketType = body.marketType ? String(body.marketType) : null;

    const betAmount = Number(body.betAmount);
    const odds = Number(body.odds);
    const lineValue =
      body.lineValue !== undefined && body.lineValue !== null
        ? Number(body.lineValue)
        : null;

    // Basic validation
    if (!eventId || eventId.length < 2) {
      return Response.json({ error: "Invalid eventId" }, { status: 400 });
    }

    if (!choice) {
      return Response.json({ error: "Invalid choice" }, { status: 400 });
    }

    if (!Number.isFinite(betAmount) || betAmount < 1) {
      return Response.json({ error: "Invalid bet amount" }, { status: 400 });
    }

    if (!Number.isFinite(odds) || odds < 1.01) {
      return Response.json({ error: "Invalid odds" }, { status: 400 });
    }

    // Get user
    const userResult = await sql`
      SELECT id, balance
      FROM users
      WHERE clerk_id = ${userId}
      LIMIT 1
    `;

    if (userResult.rows.length === 0) {
      return Response.json({ error: "User not found" }, { status: 404 });
    }

    const dbUser = userResult.rows[0];
    const balance = Number(dbUser.balance || 0);

    if (balance < betAmount) {
      return Response.json(
        { error: "Insufficient balance" },
        { status: 400 }
      );
    }

    const newBalance = balance - betAmount;

    // Transaction style flow
    await sql`BEGIN`;

    try {
      // Insert bet
      await sql`
        INSERT INTO sports_bets (
          user_id,
          event_external_id,
          bet_amount,
          choice,
          odds,
          market_type,
          line_value,
          payout,
          result
        )
        VALUES (
          ${dbUser.id},
          ${eventId},
          ${betAmount},
          ${choice},
          ${odds},
          ${marketType},
          ${lineValue},
          0,
          'pending'
        )
      `;

      // Update balance
      await sql`
        UPDATE users
        SET balance = ${newBalance}
        WHERE clerk_id = ${userId}
      `;

      await sql`COMMIT`;
    } catch (dbErr) {
      await sql`ROLLBACK`;
      console.error("DB ERROR:", dbErr);

      return Response.json(
        { error: "Database transaction failed" },
        { status: 500 }
      );
    }

    return Response.json({
      success: true,
      newBalance,
    });
  } catch (error) {
    console.error("PLACE BET ERROR:", error);

    return Response.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
