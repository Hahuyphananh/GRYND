// src/lib/crash-poker/botStrategy.js
//
// Client-safe betting strategy for the Crash Poker AI practice bot.
//
// At every open betting checkpoint the bot decides FOLD / CALL / RAISE like
// a real player. Difficulty heuristics mirror the poker table AIs:
//
//   • easy   — folds whenever a call is meaningful and rarely raises → easy
//              to push around and beat.
//   • medium — calls reasonable bets, folds when the bet is a large share of
//              its stack, raises occasionally.
//   • hard   — almost never folds, raises aggressively → you must make it pay
//              or fold yourself.
//
// The decision is made on the client (the bot has no account) but executed
// through the same server-authoritative `/api/crash-arena/action` route with
// `forBot: true`, exactly like the old ai-cashout pattern.

/** Difficulty picker values (shared with the lobby + create-ai route). */
export const CRASH_POKER_AI_DIFFICULTIES = ["easy", "medium", "hard"];

const DIFFICULTY_CONFIG = {
  easy: {
    foldThreshold: 1.5,   // fold when call ≥ 1.5× the ante already posted
    callChance: 0.7,
    raiseChance: 0.08,
    raiseUnits: [1, 2],   // raise by 1–2 big blinds over the required bet
  },
  medium: {
    foldThreshold: 3.0,
    callChance: 0.85,
    raiseChance: 0.18,
    raiseUnits: [1, 2, 3],
  },
  hard: {
    foldThreshold: 8.0,
    callChance: 0.95,
    raiseChance: 0.3,
    raiseUnits: [1, 2, 3, 4],
  },
};

/**
 * Pick the bot's action at an open checkpoint.
 *
 * @param {object} ctx
 * @param {number} ctx.requiredBet  total contribution required to stay in
 * @param {number} ctx.contributed  what the bot has already committed
 * @param {number} ctx.smallBlind   the ante/blind unit (fold sanity scale)
 * @param {number} ctx.bigBlind     the table wager (raise unit)
 * @param {number} ctx.remainingBalance  table balance left to bet with
 * @param {string} [ctx.difficulty] "easy" | "medium" | "hard"
 * @returns {{ action: "fold"|"call"|"raise", raiseTo?: number }}
 */
export function getBotBettingDecision({
  requiredBet,
  contributed,
  smallBlind,
  bigBlind,
  remainingBalance,
  difficulty = "medium",
}) {
  const cfg = DIFFICULTY_CONFIG[difficulty] || DIFFICULTY_CONFIG.medium;
  const toCall = Math.max(0, Number(requiredBet) - Number(contributed));
  const sb = Number(smallBlind) || 1;
  const bb = Number(bigBlind) || 2;
  const balance = Number(remainingBalance) || 0;

  // Already matched → check (call 0) unless the bot decides to raise.
  if (toCall <= 0) {
    if (Math.random() < cfg.raiseChance) {
      const units = cfg.raiseUnits[Math.floor(Math.random() * cfg.raiseUnits.length)];
      const raiseTo = Number(requiredBet) + bb * units;
      if (raiseTo - Number(contributed) <= balance) {
        return { action: "raise", raiseTo };
      }
    }
    return { action: "call" };
  }

  // Can't cover the call → either shove all-in (the server caps the call
  // at the bot's whole stack and marks it all-in) or fold. Hard bots push
  // their short stack; easy bots fold rather than gamble it away.
  if (toCall > balance) {
    const shoveChance =
      difficulty === "hard" ? 0.5 : difficulty === "easy" ? 0.1 : 0.25;
    if (Math.random() < shoveChance) {
      return { action: "call" }; // capped to all-in server-side
    }
    return { action: "fold" };
  }

  // The call is a large share of the blind unit → fold (difficulty-scaled).
  if (toCall >= sb * cfg.foldThreshold) {
    // Hard bots only fold when truly priced out.
    if (difficulty !== "hard" || toCall >= sb * (cfg.foldThreshold * 2)) {
      if (Math.random() < 0.8) return { action: "fold" };
    }
  }

  if (Math.random() < cfg.raiseChance) {
    const units = cfg.raiseUnits[Math.floor(Math.random() * cfg.raiseUnits.length)];
    const raiseTo = Number(requiredBet) + bb * units;
    if (raiseTo - Number(contributed) <= balance) {
      return { action: "raise", raiseTo };
    }
  }

  // Default: call (or check when the bot is somehow already matched).
  if (Math.random() > cfg.callChance) {
    return { action: "fold" };
  }
  return { action: "call" };
}
