export type OddsRound = {
  max: number;
  starter: "player1" | "player2"; // who is the starter (attacker) in this attempt
  player1Number: number;
  player2Number: number;
  matched: boolean;
};

export type OddsGameState = {
  rounds: OddsRound[];
  totalRounds: number;
  winner: "player1" | "player2";
  result: "player1_won" | "player2_won";
  payout: number;
  firstStarter: "player1" | "player2";
};

const MAX_ITERATIONS_AT_TWO = 100;

export function resolveOddsGame(wager: number): OddsGameState {
  const rounds: OddsRound[] = [];
  let max = 100;
  let winner: "player1" | "player2" | null = null;
  // Randomly choose who starts the game
  let starter: "player1" | "player2" = Math.random() < 0.5 ? "player1" : "player2";
  const firstStarter = starter;

  while (!winner) {
    // ── First attempt at this range ──
    const challenger: "player1" | "player2" = starter === "player1" ? "player2" : "player1";
    const p1a = Math.floor(Math.random() * max) + 1;
    const p2a = Math.floor(Math.random() * max) + 1;
    const matched1 = p1a === p2a;

    rounds.push({ max, starter, player1Number: p1a, player2Number: p2a, matched: matched1 });

    if (matched1) {
      // Challenger (receiver) loses, starter wins
      winner = starter;
      break;
    }

    // ── REVERSE: roles swap, same range ──
    starter = challenger;

    const newChallenger: "player1" | "player2" = starter === "player1" ? "player2" : "player1";
    const p1b = Math.floor(Math.random() * max) + 1;
    const p2b = Math.floor(Math.random() * max) + 1;
    const matched2 = p1b === p2b;

    rounds.push({ max, starter, player1Number: p1b, player2Number: p2b, matched: matched2 });

    if (matched2) {
      // New challenger loses, new starter wins
      winner = starter;
      break;
    }

    // ── Still no match after reverse: halve the range ──
    max = Math.floor(max / 2);
    if (max < 2) max = 2;

    // Safety cap at max=2
    if (max === 2 && rounds.length >= MAX_ITERATIONS_AT_TWO) {
      rounds.push({ max: 2, starter, player1Number: 1, player2Number: 1, matched: true });
      winner = starter;
    }
  }

  return {
    rounds,
    totalRounds: rounds.length,
    winner,
    result: winner === "player1" ? "player1_won" : "player2_won",
    payout: wager * 2,
    firstStarter,
  };
}
