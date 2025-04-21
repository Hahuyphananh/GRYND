async function handler({ gameId, action, amount, userId }) {
  const session = getSession();
  if (!session?.user?.id) {
    return { error: "Not authenticated" };
  }

  const [game] = await sql`
    SELECT * FROM poker_games 
    WHERE id = ${gameId} AND status = 'active'
  `;

  if (!game) {
    return { error: "Game not found or inactive" };
  }

  const positions = await sql`
    SELECT * FROM poker_player_positions 
    WHERE game_id = ${gameId} 
    ORDER BY position
  `;

  const currentPosition = positions.find(
    (p) => p.position === game.current_player_position
  );
  if (currentPosition?.player_id !== userId) {
    return { error: "Not your turn" };
  }

  switch (action) {
    case "fold": {
      await sql`
        UPDATE poker_player_positions 
        SET has_folded = true 
        WHERE game_id = ${gameId} AND player_id = ${userId}
      `;
      break;
    }

    case "check": {
      if (currentPosition.current_bet < game.min_bet) {
        return { error: "Cannot check, must call or fold" };
      }
      break;
    }

    case "call": {
      const callAmount = game.min_bet - currentPosition.current_bet;
      if (callAmount > currentPosition.stack) {
        return { error: "Not enough chips to call" };
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
        return { error: "Invalid raise amount" };
      }
      if (amount > currentPosition.stack) {
        return { error: "Not enough chips to raise" };
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

      const [updatedPosition] = await sql`
        SELECT current_bet FROM poker_player_positions
        WHERE game_id = ${gameId} AND player_id = ${userId}
      `;

      await sql`
        UPDATE poker_games 
        SET 
          pot = pot + ${currentPosition.stack},
          min_bet = GREATEST(min_bet, ${updatedPosition.current_bet}),
          last_action_position = ${game.current_player_position}
        WHERE id = ${gameId}
      `;
      break;
    }

    default:
      return { error: "Invalid action" };
  }

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

  const [updatedGame] = await sql`
    SELECT * FROM poker_games 
    WHERE id = ${gameId}
  `;

  return {
    game: updatedGame,
    positions: await sql`
      SELECT * FROM poker_player_positions 
      WHERE game_id = ${gameId} 
      ORDER BY position
    `,
  };
}
export async function POST(request) {
  return handler(await request.json());
}