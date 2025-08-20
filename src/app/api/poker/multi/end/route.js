import { NextResponse } from "next/server";
import { sql } from "@vercel/postgres";

export async function POST(req) {
  try {
    const { gameId } = await req.json();

    // --- 1️⃣ Fetch all active players (not folded) ---
    const { rows: players } = await sql`
      SELECT id, player_id, stack, hand, is_ai, has_folded
      FROM poker_player_positions
      WHERE game_id = ${gameId} AND has_folded = false
    `;

    if (players.length === 0) {
      return NextResponse.json({ error: "No players left to determine winner" }, { status: 400 });
    }

    // --- 2️⃣ Determine winner ---
    // Currently random among remaining players
    // Replace with proper poker hand evaluation later
    const winnerIndex = Math.floor(Math.random() * players.length);
    const winner = players[winnerIndex];

    // --- 3️⃣ Fetch current pot ---
    const { rows: gameRows } = await sql`
      SELECT pot
      FROM poker_games
      WHERE id = ${gameId}
    `;
    const pot = gameRows[0].pot;

    // --- 4️⃣ Award pot to winner ---
    await sql`
      UPDATE poker_player_positions
      SET stack = stack + ${pot}
      WHERE id = ${winner.id}
    `;

    // --- 5️⃣ Reset for next hand ---
    await sql`
      UPDATE poker_games
      SET pot = 0
      WHERE id = ${gameId}
    `;
    await sql`
      UPDATE poker_player_positions
      SET current_bet = 0,
          has_folded = false,
          is_turn = false
      WHERE game_id = ${gameId}
    `;

    // --- 6️⃣ Return winner info ---
    return NextResponse.json({
      winner: {
        id: winner.player_id,
        isAI: winner.is_ai,
        stack: winner.stack + pot,
      },
      potAwarded: pot,
    });

  } catch (err) {
    console.error("❌ End hand error:", err);
    return NextResponse.json({ error: "Server error ending hand" }, { status: 500 });
  }
}
