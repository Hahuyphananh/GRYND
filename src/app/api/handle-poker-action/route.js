import { auth } from "@clerk/nextjs/server";
import { sql } from "@vercel/postgres";

/**
 * @param {Request} request
 * @returns {Promise<Response>}
 */
export async function POST(request) {
  const { userId } = auth();
  if (!userId) {
    return new Response(JSON.stringify({ error: "Not authenticated" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { gameId, action, amount } = await request.json();

  if (!gameId || !action) {
    return new Response(JSON.stringify({ error: "Missing required parameters" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const { rows: games } = await sql`
      SELECT * FROM poker_games 
      WHERE id = ${gameId} AND status = 'active'
    `;
    const game = games[0];

    if (!game) {
      return new Response(JSON.stringify({ error: "Game not found or inactive" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    const { rows: positions } = await sql`
      SELECT * FROM poker_player_positions 
      WHERE game_id = ${gameId}
      ORDER BY position
    `;

    const currentPosition = positions.find(
      (p) => p.position === game.current_player_position
    );

    if (!currentPosition || currentPosition.player_id !== parseInt(userId)) {
      return new Response(JSON.stringify({ error: "Not your turn" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }

    // ✅ Action handlers
    switch (action) {
      case "fold":
        await sql`
          UPDATE poker_player_positions 
          SET has_folded = true 
          WHERE game_id = ${gameId} AND player_id = ${userId}
        `;
        break;

      case "check":
        if (currentPosition.current_bet < game.min_bet) {
          return new Response(JSON.stringify({ error: "Cannot check, must call or fold" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }
        break;

      case "call": {
        const callAmount = game.min_bet - currentPosition.current_bet;
        if (callAmount > currentPosition.stack) {
          return new Response(JSON.stringify({ error: "Not enough chips to call" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }

        await sql`
          UPDATE poker_player_positions 
          SET 
            current_bet = ${game.min_bet},
            stack = stack - ${callAmount}
          WHERE game_id = ${gameId} AND player_id = ${userId}
        `;

        await sql`
          UPDATE poker_games 
          SET pot = pot + ${callAmount}
          WHERE id = ${gameId}
        `;
        break;
      }

      case "raise": {
        if (!amount || amount <= game.min_bet) {
          return new Response(JSON.stringify({ error: "Invalid raise amount" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }

        if (amount > currentPosition.stack) {
          return new Response(JSON.stringify({ error: "Not enough chips to raise" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }

        const raiseAmount = amount - currentPosition.current_bet;

        await sql`
          UPDATE poker_player_positions 
          SET 
            current_bet = ${amount},
            stack = stack - ${raiseAmount}
          WHERE game_id = ${gameId} AND player_id = ${userId}
        `;

        await sql`
          UPDATE poker_games 
          SET 
            pot = pot + ${raiseAmount},
            min_bet = ${amount},
            last_action_position = ${game.current_player_position}
          WHERE id = ${gameId}
        `;
        break;
      }

      case "all-in": {
        await sql`
          UPDATE poker_player_positions 
          SET 
            current_bet = current_bet + stack,
            stack = 0,
            is_all_in = true
          WHERE game_id = ${gameId} AND player_id = ${userId}
        `;

        const { rows: updated } = await sql`
          SELECT current_bet FROM poker_player_positions
          WHERE game_id = ${gameId} AND player_id = ${userId}
        `;
        const updatedBet = updated[0]?.current_bet || 0;

        await sql`
          UPDATE poker_games 
          SET 
            pot = pot + ${currentPosition.stack},
            min_bet = GREATEST(min_bet, ${updatedBet}),
            last_action_position = ${game.current_player_position}
          WHERE id = ${gameId}
        `;
        break;
      }

      default:
        return new Response(JSON.stringify({ error: "Invalid action" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
    }

    // 🔁 Determine next player
    let nextPosition = (game.current_player_position + 1) % game.total_players;
    let roundComplete = false;

    while (true) {
      const nextPlayer = positions.find((p) => p.position === nextPosition);
      if (!nextPlayer || nextPlayer.has_folded || nextPlayer.is_all_in) {
        nextPosition = (nextPosition + 1) % game.total_players;
        if (nextPosition === game.last_action_position) {
          roundComplete = true;
          break;
        }
        continue;
      }
      break;
    }

    if (roundComplete) {
      const rounds = ["preflop", "flop", "turn", "river"];
      const currentRoundIndex = rounds.indexOf(game.current_round);

      if (currentRoundIndex < rounds.length - 1) {
        await sql`
          UPDATE poker_games 
          SET 
            current_round = ${rounds[currentRoundIndex + 1]},
            current_player_position = ${game.dealer_position},
            min_bet = 0,
            last_action_position = null
          WHERE id = ${gameId}
        `;

        await sql`
          UPDATE poker_player_positions 
          SET current_bet = 0 
          WHERE game_id = ${gameId}
        `;
      } else {
        await sql`
          UPDATE poker_games 
          SET status = 'showdown' 
          WHERE id = ${gameId}
        `;
      }
    } else {
      await sql`
        UPDATE poker_games 
        SET current_player_position = ${nextPosition}
        WHERE id = ${gameId}
      `;
    }

    const { rows: updatedGameRows } = await sql`
      SELECT * FROM poker_games 
      WHERE id = ${gameId}
    `;

    const { rows: updatedPositions } = await sql`
      SELECT * FROM poker_player_positions 
      WHERE game_id = ${gameId}
      ORDER BY position
    `;

    return new Response(
      JSON.stringify({
        game: updatedGameRows[0],
        positions: updatedPositions,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (err) {
    console.error("❌ Poker action error:", err);
    return new Response(JSON.stringify({ error: "Server error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
