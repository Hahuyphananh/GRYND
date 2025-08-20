import { NextResponse } from "next/server";
import { sql } from "@vercel/postgres";

export async function POST(req) {
  try {
    const { gameId, action, amount = 0 } = await req.json();

    // 1) Find the human whose turn it is (fallback to first active human)
    let { rows: playerRows } = await sql`
      SELECT id, stack, current_bet, position
      FROM poker_player_positions
      WHERE game_id = ${gameId} AND is_ai = FALSE AND is_turn = TRUE
      LIMIT 1
    `;
    let player = playerRows[0];

    if (!player) {
      const { rows: fallbackRows } = await sql`
        SELECT id, stack, current_bet, position
        FROM poker_player_positions
        WHERE game_id = ${gameId} AND is_ai = FALSE AND has_folded = FALSE
        ORDER BY position
        LIMIT 1
      `;
      player = fallbackRows[0];
      if (!player) {
        return NextResponse.json({ error: "No human players left" }, { status: 404 });
      }
    }

    // 2) Apply the human action + record last_action
    if (action === "fold") {
      await sql`
        UPDATE poker_player_positions
        SET has_folded = TRUE,
            last_action = 'fold'
        WHERE id = ${player.id}
      `;
    } else if (action === "call") {
      await sql`
        UPDATE poker_player_positions
        SET stack = stack - ${amount},
            current_bet = current_bet + ${amount},
            last_action = 'call'
        WHERE id = ${player.id}
      `;
      await sql`
        UPDATE poker_games
        SET pot = pot + ${amount}
        WHERE id = ${gameId}
      `;
    } else if (action === "raise") {
      await sql`
        UPDATE poker_player_positions
        SET stack = stack - ${amount},
            current_bet = current_bet + ${amount},
            last_action = 'raise'
        WHERE id = ${player.id}
      `;
      await sql`
        UPDATE poker_games
        SET pot = pot + ${amount}
        WHERE id = ${gameId}
      `;
    } else if (action === "check") {
      await sql`
        UPDATE poker_player_positions
        SET last_action = 'check'
        WHERE id = ${player.id}
      `;
    }

    // 3) Advance the turn to the next active player (step-by-step loop continues on the frontend)
    //    Clear all turns, then set the next one
    await sql`
      UPDATE poker_player_positions
      SET is_turn = FALSE
      WHERE game_id = ${gameId}
    `;

    const { rows: activeRows } = await sql`
      SELECT id
      FROM poker_player_positions
      WHERE game_id = ${gameId} AND has_folded = FALSE
      ORDER BY position
    `;
    // --- 3.1️⃣ Check if only one player remains --- 
if (activeRows.length <= 1) {
  // Call the end route to determine winner
  const endRes = await fetch(`${process.env.NEXT_PUBLIC_BASE_URL}/api/poker/multi/end`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ gameId }),
  });

  const endData = await endRes.json();
  return NextResponse.json(endData);
}


    if (activeRows.length > 0) {
      const ids = activeRows.map((r) => r.id);
      // If the actor just folded, player.id won't be in ids → indexOf = -1 → next becomes ids[0]
      const currentIndex = ids.indexOf(player.id);
      const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % ids.length;
      const nextId = ids[nextIndex];

      await sql`
        UPDATE poker_player_positions
        SET is_turn = TRUE
        WHERE id = ${nextId}
      `;
    }

    // 4) Return a rich game state (frontend needs has_folded & lastAction & numeric id)
    const { rows: players } = await sql`
      SELECT
        id,
        player_id,
        stack,
        current_bet,
        is_ai,
        position,
        is_turn,
        has_folded,
        last_action
      FROM poker_player_positions
      WHERE game_id = ${gameId}
      ORDER BY position
    `;

    const { rows: gameRows } = await sql`
      SELECT id AS "gameId", pot
      FROM poker_games
      WHERE id = ${gameId}
    `;

    return NextResponse.json({
      ...gameRows[0],
      players: players.map((p) => ({
        id: p.id,                 // numeric row id (use this when calling /ai-turn)
        playerId: p.player_id,    // external id for the human (if any)
        stack: p.stack,
        tokens: p.stack,          // keep old field for UI compatibility
        currentBet: p.current_bet,
        isAI: p.is_ai,
        position: p.position,
        isTurn: p.is_turn,
        has_folded: p.has_folded,
        lastAction: p.last_action,
      })),
    });
  } catch (err) {
    console.error("❌ Poker action error:", err);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  }
}
