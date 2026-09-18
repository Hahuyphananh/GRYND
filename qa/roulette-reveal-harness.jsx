// qa/roulette-reveal-harness.jsx
//
// Mounts the REAL Roulette PvP match page
// (src/app/casino/roulette/[matchId]/PageClient.jsx, unmodified) in a browser
// with a scripted `/api/roulette-pvp/match/:id` endpoint, so
// qa/roulette-reveal-check.mjs can time the result reveal.
//
// Fidelity: everything under test is production code — the server-driven spin
// effect, the canvas animation, the reveal, the grid/strip/history masking, the
// round-result banner. Only the page's surroundings are faked (auth, router,
// analytics, socket, audio, and the chrome components), and only with no-op
// shells that never touch the reveal path. See the check for the stub list.
import { Suspense } from "react";
import { createRoot } from "react-dom/client";
import { ROULETTE_NUMBERS } from "../src/lib/rouletteConfig";
import RoulettePvpGamePage from "../src/app/casino/roulette/[matchId]/PageClient";

const MATCH_ID = "1";

// A mid-match row, shaped like the real `/api/roulette-pvp/match/:id` payload.
const match = {
  id: 1,
  status: "round_1",
  stakeAmount: "100.00",
  isAi: false,
  player1Id: "user_1",
  player2Id: "user_2",
  player1Name: "You",
  player2Name: "Opponent",
  player1IconKey: null,
  player2IconKey: null,
  player1NameColor: null,
  player2NameColor: null,
  playerOnePoints: 1000,
  playerTwoPoints: 1000,
  player1Bets: null,
  player2Bets: null,
  currentRound: 1,
  roundNumber: 1,
  roundDeadline: new Date(Date.now() + 60_000).toISOString(),
  scorePlayer1: 0,
  scorePlayer2: 0,
  // No spin has resolved yet, so the page does NOT animate on mount — the
  // check drives every resolution explicitly and can therefore observe the
  // whole spin.
  lastSpinResult: null,
  lastSpinResultIndex: null,
};

const rounds = [];

// Settle a round exactly the way `resolveRound` does: append the history row,
// then stamp the match with the result and the advanced round number. The
// page's next poll cannot tell this apart from a real resolution.
window.__settleRound = ({ number, winner = "player1", call = null } = {}) => {
  const spinResultIndex = ROULETTE_NUMBERS.indexOf(number);
  if (spinResultIndex < 0) throw new Error(`not a wheel number: ${number}`);
  const roundNumber = rounds.length + 1;
  rounds.push({
    id: roundNumber,
    matchId: 1,
    roundNumber,
    isSuddenDeath: false,
    spinResultIndex,
    spinResult: number,
    player1Bets: { [String(number)]: 10 },
    player2Bets: {},
    player1TotalBet: "10.00",
    player2TotalBet: "0.00",
    player1Payout: winner === "player1" ? "20.00" : "0.00",
    player2Payout: "0.00",
    player1Net: winner === "player1" ? "10.00" : "-10.00",
    player2Net: winner === "player1" ? "-10.00" : "10.00",
    roundWinner: winner,
    serverEliminated: [],
    eliminations: {},
    // A single-number call equal to the winning number is the strongest early
    // leak the history row can produce: "call 17 ✓" hands over 17 outright.
    calls: call ? { player1: call, player2: null } : {},
    callResults: call
      ? {
          player1: { correct: call === number, transfer: 5 },
          player2: { correct: false, transfer: 0 },
        }
      : {},
  });
  match.lastSpinResultIndex = spinResultIndex;
  match.lastSpinResult = number;
  match.roundNumber = roundNumber;
  match.playerOnePoints = 1000 + (winner === "player1" ? 10 : -10);
  match.playerTwoPoints = 1000 + (winner === "player1" ? -10 : 10);
  return { roundNumber, spinResultIndex };
};

// Test hook: lock this player's bets the way the server does on a lock-in
// (`player1Bets` set, points already deducted). Lets a check observe the
// locked-but-not-yet-spinning layout — including the mobile "Bets locked" cue —
// without a spin running. Pass `null` to un-lock. No game code involved.
window.__lockMyBets = (bets) => {
  match.player1Bets = bets;
};

// The page's only network call in this flow is the status poll. Every other
// endpoint falls back to a benign success so a stray click cannot error out.
window.fetch = async (url) => {
  const path = String(url);
  if (path.startsWith("/api/roulette-pvp/match/")) {
    return {
      ok: true,
      json: async () => ({
        success: true,
        data: {
          match: { ...match },
          rounds: rounds.map((r) => ({ ...r })),
        },
      }),
    };
  }
  return { ok: true, json: async () => ({ success: true, data: {} }) };
};

// Next renders dynamic route segments inside a Suspense boundary, and the page
// unwraps its `params` Promise with `use()` — so mirror that here rather than
// crashing on the first suspend.
createRoot(document.getElementById("root")).render(
  <Suspense fallback={<div>harness: suspending on params</div>}>
    <RoulettePvpGamePage params={{ matchId: MATCH_ID }} />
  </Suspense>,
);
