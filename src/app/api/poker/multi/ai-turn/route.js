import { NextResponse } from "next/server";
import { sql } from "@vercel/postgres";

export async function POST(req) {
  try {
    const { gameId, aiId } = await req.json();

    // --- Random AI action ---
    const actions = ["fold", "call", "raise"];
    const action = actions[Math.floor(Math.random() * actions.length)];
    const amount = action === "raise" ? Math.floor(Math.random() * 50) + 10 : 0;

    // --- Update AI player ---
    if (action === "fold") {
      await sql`
        UPDATE poker_player_positions
        SET has_folded = TRUE,
            last_action = ${action},
            is_turn = FALSE
        WHERE id = ${aiId} AND game_id = ${gameId};
      `;
    } else {
      await sql`
        UPDATE poker_player_positions
        SET stack = stack - ${amount},
            current_bet = current_bet + ${amount},
            last_action = ${action},
            is_turn = FALSE
        WHERE id = ${aiId} AND game_id = ${gameId};
      `;

      if (action === "call" || action === "raise") {
        await sql`
          UPDATE poker_games
          SET pot = pot + ${amount}
          WHERE id = ${gameId};
        `;
      }
    }

   // Clear all turns first
await sql`
  UPDATE poker_player_positions
  SET is_turn = FALSE
  WHERE game_id = ${gameId};
`;

// Set next player's turn
await sql`
  UPDATE poker_player_positions p
  SET is_turn = TRUE
  FROM (
    SELECT id
    FROM poker_player_positions
    WHERE game_id = ${gameId} AND has_folded = FALSE AND is_turn = FALSE
    ORDER BY position ASC
    LIMIT 1
  ) sub
  WHERE p.id = sub.id;
`;


    // --- Fetch updated game state ---
    const { rows: players } = await sql`
      SELECT id as player_id, stack, current_bet, is_ai, position, is_turn, last_action
      FROM poker_player_positions
      WHERE game_id = ${gameId}
      ORDER BY position ASC
    `;

    const { rows: game } = await sql`
      SELECT id as "gameId", pot
      FROM poker_games
      WHERE id = ${gameId}
    `;

    return NextResponse.json({
      ...game[0],
      players: players.map(p => ({
        id: p.player_id,
        tokens: p.stack,
        currentBet: p.current_bet,
        isAI: p.is_ai,
        position: p.position,
        isTurn: p.is_turn,
        lastAction: p.last_action,
      })),
    });

  } catch (err) {
    console.error("❌ AI turn error:", err);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  }
}
