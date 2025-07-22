// app/lib/aiLogic.js
import { sql } from "@vercel/postgres";

export async function performAiAction(gameId) {
  const { rows: games } = await sql`
    SELECT * FROM poker_games WHERE id = ${gameId} AND status = 'active'
  `;
  const game = games[0];
  if (!game) return;

  const { rows: positions } = await sql`
    SELECT * FROM poker_player_positions WHERE game_id = ${gameId} ORDER BY position
  `;
  const aiPosition = positions.find(p => p.player_id === null);
  const currentPosition = positions.find(p => p.position === game.current_player_position);

  if (!aiPosition || aiPosition.position !== game.current_player_position) return;

  const callAmount = game.min_bet - aiPosition.current_bet;

  if (callAmount <= aiPosition.stack) {
    await sql`
      UPDATE poker_player_positions
      SET current_bet = ${game.min_bet}, stack = stack - ${callAmount}
      WHERE game_id = ${gameId} AND player_id IS NULL
    `;

    await sql`
      UPDATE poker_games
      SET pot = pot + ${callAmount}, current_player_position = 1
      WHERE id = ${gameId}
    `;
  } else {
    await sql`
      UPDATE poker_player_positions
      SET has_folded = true
      WHERE game_id = ${gameId} AND player_id IS NULL
    `;

    await sql`
      UPDATE poker_games
      SET status = 'completed', result = 'win'
      WHERE id = ${gameId}
    `;
  }
}
