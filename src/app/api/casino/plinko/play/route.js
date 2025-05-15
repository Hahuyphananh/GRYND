import { auth } from "@clerk/nextjs/server";
import { sql } from "@vercel/postgres";

/**
 * @param {Request} request
 * @returns {Promise<Response>}
 */
export async function POST(request) {
  const { userId } = auth();

  if (!userId) {
    return new Response(JSON.stringify({ error: "Utilisateur non authentifié" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { startPosition, betAmount } = await request.json();

  if (!betAmount || betAmount <= 0) {
    return new Response(JSON.stringify({ error: "Montant du pari invalide" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const { rows } = await sql`
      SELECT id, balance FROM users WHERE clerk_id = ${userId}
    `;
    const user = rows[0];

    if (!user || user.balance < betAmount) {
      return new Response(JSON.stringify({ error: "Solde insuffisant" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Plinko logic
    const multipliers = [
      10, 5, 3, 2, 1.5, 1.2, 1, 0.6, 0.4, 0.2, 0.4, 0.6, 1, 1.2, 1.5, 2, 3, 5, 10,
    ];
    const totalWidth = (multipliers.length - 1) * 24;
    const startX = 250 - totalWidth / 2;

    const path = [];
    let currentX = 250;
    let currentY = 50;
    path.push({ x: currentX, y: currentY });

    for (let row = 0; row < 19; row++) {
      currentY += 22;
      const direction = Math.random() < 0.5 ? -1 : 1;
      currentX += direction * 12;
      path.push({ x: currentX, y: currentY });
    }

    const finalX = currentX;
    const multiplierIndex = Math.round((finalX - startX) / 24);
    const clampedIndex = Math.max(0, Math.min(multipliers.length - 1, multiplierIndex));

    const finalMultiplierX = startX + clampedIndex * 24;
    path[path.length - 1].x = finalMultiplierX;
    path[path.length - 1].y = 460;

    const multiplier = multipliers[clampedIndex];
    const winAmount = betAmount * multiplier;
    const netChange = -betAmount + winAmount;

    // Update user balance
    const { rows: updatedRows } = await sql`
      UPDATE users SET balance = balance + ${netChange}
      WHERE clerk_id = ${userId}
      RETURNING balance
    `;
    const updatedUser = updatedRows[0];

    // Save game to DB
    await sql`
      INSERT INTO plinko_games (user_id, bet_amount, multiplier, win_amount, path)
      VALUES (${user.id}, ${betAmount}, ${multiplier}, ${winAmount}, ${JSON.stringify(path)})
    `;

    return new Response(
      JSON.stringify({
        success: true,
        data: {
          path,
          winAmount,
          multiplier,
          newBalance: updatedUser.balance,
        },
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (err) {
    console.error("❌ Plinko game error:", err);
    return new Response(JSON.stringify({ error: "Erreur serveur" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
