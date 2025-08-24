import { NextResponse } from "next/server";
import { sql } from "@vercel/postgres";

// Safely parse JSONB/string
function parseMaybeJSON(v, fallback) {
  if (v == null) return fallback;
  if (typeof v === "string") {
    try { return JSON.parse(v); } catch { return fallback; }
  }
  return v;
}

function chooseAIAction({ callAmount, stack, stage }) {
  // Very simple policy:
  // - If can't cover call -> fold
  // - If nothing to call -> mostly check, sometimes raise small
  // - Otherwise: mostly call, sometimes raise small
  if (stack <= 0) return { action: "check", amount: 0 };
  if (callAmount > stack) return { action: "fold", amount: 0 };

  const r = Math.random();
  if (callAmount === 0) {
    if (r < 0.8) return { action: "check", amount: 0 };
    const raiseBy = Math.min(stack, 10 + Math.floor(Math.random() * 41)); // 10..50
    return { action: "raise", amount: raiseBy };
  } else {
    if (r < 0.7) return { action: "call", amount: callAmount };
    const extra = Math.min(stack - callAmount, 10 + Math.floor(Math.random() * 41)); // 10..50
    const total = callAmount + Math.max(0, extra);
    return { action: "raise", amount: total };
  }
}

// Get next active (not folded, stack >= 0) player after index i (wrap)
function getNextActive(players, startIndex) {
  const n = players.length;
  for (let step = 1; step <= n; step++) {
    const idx = (startIndex + step) % n;
    const p = players[idx];
    if (!p.has_folded) return p;
  }
  return null;
}

// First to act postflop is seat after dealer
function firstToActPostflop(players, dealerPos) {
  const n = players.length;
  for (let step = 1; step <= n; step++) {
    const idx = (dealerPos + step) % n;
    const p = players[idx];
    if (!p.has_folded) return p;
  }
  return null;
}

export async function POST(req) {
  try {
    const { gameId, aiId } = await req.json();

    // --- Load game + players (ordered by position)
    const { rows: gameRows } = await sql`
      SELECT id, stage, deck, community_cards, pot, current_player_position, dealer_position
      FROM poker_games
      WHERE id = ${gameId}
      LIMIT 1;
    `;
    if (!gameRows[0]) {
      return NextResponse.json({ error: "Game not found" }, { status: 404 });
    }

    const game = gameRows[0];
    let stage = game.stage || "preflop";
    let deck = parseMaybeJSON(game.deck, []);
    let community = parseMaybeJSON(game.community_cards, []);
    let pot = Number(game.pot ?? 0);

    const { rows: players } = await sql`
      SELECT id, player_id, position, stack, current_bet, is_ai, has_folded, is_turn, last_action
      FROM poker_player_positions
      WHERE game_id = ${gameId}
      ORDER BY position ASC;
    `;
    if (players.length === 0) {
      return NextResponse.json({ error: "No players in game" }, { status: 400 });
    }

    // Find acting AI
    const actingIndex = players.findIndex(p => p.id === aiId);
    if (actingIndex === -1) {
      return NextResponse.json({ error: "AI player not found" }, { status: 404 });
    }
    const ai = players[actingIndex];
    if (!ai.is_ai) {
      return NextResponse.json({ error: "Player is not AI" }, { status: 400 });
    }
    if (ai.has_folded) {
      return NextResponse.json({ error: "AI already folded" }, { status: 400 });
    }

    const highestBet = Math.max(...players.map(p => Number(p.current_bet || 0)));
    const callAmount = Math.max(0, highestBet - Number(ai.current_bet || 0));
    const decision = chooseAIAction({ callAmount, stack: Number(ai.stack || 0), stage });

    // Normalize amounts
    let action = decision.action;
    let amount = Math.max(0, Math.floor(Number(decision.amount || 0)));

    // Clamp for stack
    if (action === "call") amount = Math.min(amount, Number(ai.stack || 0));
    if (action === "raise") amount = Math.min(amount, Number(ai.stack || 0));

    // --- Apply AI action
    if (action === "fold") {
      await sql`
        UPDATE poker_player_positions
        SET has_folded = TRUE, last_action = 'fold', is_turn = FALSE
        WHERE id = ${aiId} AND game_id = ${gameId};
      `;
    } else if (action === "check") {
      await sql`
        UPDATE poker_player_positions
        SET last_action = 'check', is_turn = FALSE
        WHERE id = ${aiId} AND game_id = ${gameId};
      `;
    } else {
      // call or raise → increase current_bet and pot
      await sql`
        UPDATE poker_player_positions
        SET stack = stack - ${amount},
            current_bet = current_bet + ${amount},
            last_action = ${action},
            is_turn = FALSE
        WHERE id = ${aiId} AND game_id = ${gameId};
      `;
      pot += amount;
      await sql`
        UPDATE poker_games
        SET pot = ${pot}
        WHERE id = ${gameId};
      `;
    }

    // --- Reload players after action
    const { rows: updatedPlayers } = await sql`
      SELECT id, player_id, position, stack, current_bet, is_ai, has_folded, is_turn, last_action
      FROM poker_player_positions
      WHERE game_id = ${gameId}
      ORDER BY position ASC;
    `;

    // If only one player remains, stop here (frontend can call /end)
    const active = updatedPlayers.filter(p => !p.has_folded);
    if (active.length <= 1) {
      // Clear turns
      await sql`UPDATE poker_player_positions SET is_turn = FALSE WHERE game_id = ${gameId};`;
      return NextResponse.json({
        gameId,
        pot,
        stage,
        players: updatedPlayers.map(p => ({
          id: p.id,
          playerId: p.player_id,
          tokens: Number(p.stack || 0),
          currentBet: Number(p.current_bet || 0),
          isAI: p.is_ai,
          position: p.position,
          isTurn: false,
          has_folded: p.has_folded,
          lastAction: p.last_action,
        })),
      });
    }

    // --- Did the betting round end? (everyone matched the highest)
    const highestUpdated = Math.max(...updatedPlayers.map(p => Number(p.current_bet || 0)));
    const allMatched =
      updatedPlayers.filter(p => !p.has_folded)
        .every(p => Number(p.current_bet || 0) === highestUpdated);

    let roundEnded = false;

    if (allMatched) {
      roundEnded = true;

      // Reset current bets
      await sql`UPDATE poker_player_positions SET current_bet = 0 WHERE game_id = ${gameId};`;

      // Advance stage and deal community cards
      if (stage === "preflop") {
        // Burn + flop (we’re skipping burns for simplicity)
        const flop = [deck.shift(), deck.shift(), deck.shift()];
        community = [...community, ...flop];
        stage = "flop";
      } else if (stage === "flop") {
        community = [...community, deck.shift()];
        stage = "turn";
      } else if (stage === "turn") {
        community = [...community, deck.shift()];
        stage = "river";
      } else if (stage === "river") {
        stage = "showdown";
      }

      // Update game with stage/deck/community
      await sql`
        UPDATE poker_games
        SET stage = ${stage},
            deck = ${JSON.stringify(deck)},
            community_cards = ${JSON.stringify(community)}
        WHERE id = ${gameId};
      `;

      // Clear all turns
      await sql`UPDATE poker_player_positions SET is_turn = FALSE WHERE game_id = ${gameId};`;

      // Decide first to act for next round (postflop: seat after dealer)
      if (stage !== "showdown") {
        const starter = firstToActPostflop(updatedPlayers, game.dealer_position);
        if (starter) {
          await sql`
            UPDATE poker_player_positions
            SET is_turn = TRUE
            WHERE id = ${starter.id} AND game_id = ${gameId};
          `;
          await sql`
            UPDATE poker_games
            SET current_player_position = ${starter.position}
            WHERE id = ${gameId};
          `;
        }
      }
    } else {
      // --- Continue same round: set next player after the acting AI
      const idxNow = updatedPlayers.findIndex(p => p.id === aiId);
      const nextP = getNextActive(updatedPlayers, idxNow);

      await sql`UPDATE poker_player_positions SET is_turn = FALSE WHERE game_id = ${gameId};`;
      if (nextP) {
        await sql`
          UPDATE poker_player_positions
          SET is_turn = TRUE
          WHERE id = ${nextP.id} AND game_id = ${gameId};
        `;
        await sql`
          UPDATE poker_games
          SET current_player_position = ${nextP.position}
          WHERE id = ${gameId};
        `;
      }
    }

    // --- Return final, updated snapshot
    const { rows: finalPlayers } = await sql`
      SELECT id, player_id, position, stack, current_bet, is_ai, has_folded, is_turn, last_action
      FROM poker_player_positions
      WHERE game_id = ${gameId}
      ORDER BY position ASC;
    `;
    const { rows: finalGameRows } = await sql`
      SELECT id, stage, community_cards, pot
      FROM poker_games
      WHERE id = ${gameId}
      LIMIT 1;
    `;
    const finalGame = finalGameRows[0] || {};
    const finalCommunity = parseMaybeJSON(finalGame.community_cards, []);

    return NextResponse.json({
      gameId,
      pot: Number(finalGame.pot || 0),
      stage: finalGame.stage || stage,
      communityCards: finalCommunity, // frontend can ignore if not showing yet
      roundEnded,
      players: finalPlayers.map(p => ({
        id: p.id,
        playerId: p.player_id,
        tokens: Number(p.stack || 0),
        currentBet: Number(p.current_bet || 0),
        isAI: p.is_ai,
        position: p.position,
        isTurn: p.is_turn,
        has_folded: p.has_folded,
        lastAction: p.last_action,
      })),
    });
  } catch (err) {
    console.error("❌ AI turn error:", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
