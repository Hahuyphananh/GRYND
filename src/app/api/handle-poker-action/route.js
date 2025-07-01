import { auth } from "@clerk/nextjs/server";
import { sql } from "@vercel/postgres";

export async function POST(request) {
  const { userId } = await auth();
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
          SET current_bet = ${game.min_bet}, stack = stack - ${callAmount}
          WHERE game_id = ${gameId} AND player_id = ${userId}
        `;

        await sql`
          UPDATE poker_games SET pot = pot + ${callAmount} WHERE id = ${gameId}
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

        const raiseAmount = amount - currentPosition.current_bet;
        if (raiseAmount > currentPosition.stack) {
          return new Response(JSON.stringify({ error: "Not enough chips to raise" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }

        await sql`
          UPDATE poker_player_positions 
          SET current_bet = ${amount}, stack = stack - ${raiseAmount}
          WHERE game_id = ${gameId} AND player_id = ${userId}
        `;

        await sql`
          UPDATE poker_games 
          SET pot = pot + ${raiseAmount}, min_bet = ${amount}, last_action_position = ${game.current_player_position}
          WHERE id = ${gameId}
        `;
        break;
      }

      case "all-in": {
        await sql`
          UPDATE poker_player_positions 
          SET current_bet = current_bet + stack, stack = 0, is_all_in = true
          WHERE game_id = ${gameId} AND player_id = ${userId}
        `;

        const { rows: updated } = await sql`
          SELECT current_bet FROM poker_player_positions
          WHERE game_id = ${gameId} AND player_id = ${userId}
        `;
        const updatedBet = updated[0]?.current_bet || 0;

        await sql`
          UPDATE poker_games 
          SET pot = pot + ${currentPosition.stack}, min_bet = GREATEST(min_bet, ${updatedBet}), last_action_position = ${game.current_player_position}
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

    const { rows: updatedGameRows } = await sql`
      SELECT * FROM poker_games WHERE id = ${gameId}
    `;
    const updatedGame = updatedGameRows[0];

    const { rows: updatedPositions } = await sql`
      SELECT * FROM poker_player_positions WHERE game_id = ${gameId} ORDER BY position
    `;

    const playerPosition = updatedPositions.find((p) => p.player_id === parseInt(userId));
    const aiPosition = updatedPositions.find((p) => p.player_id === null);

    const playerHand = playerPosition?.hand ? JSON.parse(playerPosition.hand) : ["?", "?"];
    const opponentHand = aiPosition?.hand ? JSON.parse(aiPosition.hand) : ["?", "?"];

    const result = updatedGame.status === "showdown"
      ? {
          message: "Fin de la main.",
          won: true,
          winAmount: parseFloat(updatedGame.pot || 0),
          bet: parseFloat(playerPosition?.current_bet || 0),
        }
      : null;

    return new Response(
      JSON.stringify({
        pot: updatedGame.pot,
        playerHand,
        opponentHand,
        result,
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
