import { auth } from "@clerk/nextjs/server";
import { sql } from "@vercel/postgres";
import { getUserLevel } from "../../../lib/vipLevels";

export async function POST(request) {
  const { userId } = await auth();

  if (!userId) {
    return new Response(JSON.stringify({ success: false, error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const { amount, selectionId, source = "real" } = await request.json();

    const betAmount = Number(amount);
    if (!betAmount || betAmount <= 0) {
      return new Response(JSON.stringify({ success: false, error: "Invalid amount" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const userResult = await sql`
      SELECT id, balance, total_wagered, level
      FROM users
      WHERE clerk_id = ${userId}
      LIMIT 1
    `;

    const dbUser = userResult.rows[0];
    if (!dbUser) {
      return new Response(JSON.stringify({ success: false, error: "User not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (Number(dbUser.balance) < betAmount) {
      return new Response(JSON.stringify({ success: false, error: "Insufficient balance" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    let event = null;

    await sql.begin(async (tx) => {
      await tx`
        UPDATE users
        SET balance = balance - ${betAmount}
        WHERE id = ${dbUser.id}
      `;

      if (source === "real") {
        const updatedWagered = Number(dbUser.total_wagered || 0) + betAmount;
        const previousLevel = Number(dbUser.level || getUserLevel(Number(dbUser.total_wagered || 0)));
        const nextLevel = getUserLevel(updatedWagered);

        let bonus = 0;
        if (nextLevel > previousLevel) {
          bonus = nextLevel * 100;
          event = { type: "LEVEL_UP", level: nextLevel, bonus };
        }

        await tx`
          UPDATE users
          SET total_wagered = ${updatedWagered},
              level = ${nextLevel},
              balance = balance + ${bonus}
          WHERE id = ${dbUser.id}
        `;
      }

      await tx`
        INSERT INTO bets (user_id, selection_id, amount, potential_win, status)
        VALUES (${dbUser.id}, ${selectionId ?? null}, ${betAmount}, 0, 'pending')
      `;
    });

    return new Response(
      JSON.stringify({ success: true, event }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("[PLACE_BET_ERROR]", error);
    return new Response(JSON.stringify({ success: false, error: "Failed to place bet" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
