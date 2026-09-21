// src/lib/lane-rush-duel/constants.js
//
// Shared constants + bridge generation + outcome resolution
// for the "Lane Rush" match system. One shared fixed bridge per
// match, 1 bad tile per row, alternating turns, flags, and a 15s
// pick window. No points, no banking, no multipliers.
//
// ── Game rules ────────────────────────────────────────────────────
// Both players race the SAME shared fixed bridge (10 rows, 1 bad
// tile per row). On your turn you may:
//   • JUMP — pick a tile. Safe → advance 1 row and keep your turn.
//     Bad → fall to row 1, switch turns.
//   • FLAG — call the bad tile (2 per match, can only be placed
//     after you have personally landed safely on a row). A CORRECT
//     flag claims the row (advance 1 row, keep your turn) and
//     reveals the bad tile to both players; a WRONG flag busts you
//     (fall to row 1, switch turns).
//   • Your turn times out after 15s → attempt ends, switch turns.
//
// The bridge is generated once per match via buildBridge server-side.
// First player is randomly selected. First player to successfully
// cross row 10 wins the match.
//
// Flags are visible to both players once placed. A player may only
// flag after they have personally landed safely on that row.
//
// Terminal conditions:
//   • WIN: the first player to successfully cross row 10 wins instantly.
//   • Bust (picked the bad tile / wrong flag) → fall to row 1, switch turns.
//   • Timeout (15s elapses) → attempt ends, switch turns.
//
// Flags: 2 per player per match. Visible to both once placed.
//
// Provably fair: the shared bridge is derived from a SHARED server
// seed + the host's client seed + the match id as nonce, persisted
// so both clients can verify fairness post-match.
//
import crypto from "crypto";

// ── Bridge configuration ──────────────────────────────────────────
// 10 rows (0-indexed), 1 bad tile per row. Same bridge for both players.
export const MAX_ROWS = 10; // rows 0..9, row 10 is the winning row
export const FLAGS_PER_PLAYER = 2;
export const TILE_CHOICE_SECONDS = 15; // per-turn choice window

// ── Provably-fair bridge generation ─────────────────────────────
// Build the shared bridge: 10 rows, each with 1 bad tile index (0..N-1)
// depending on the risk path width for that difficulty.
// For the new game, each row has a single bad tile position.
// The bridge uses the same provably-fair digest system as the old game,
// but simplified to one bad tile per row rather than per lane per path.
export function buildBridge({ serverSeed, clientSeed, nonce, difficulty = "easy" }) {
  const config = LANE_RUNNER_DIFFICULTIES[difficulty] ?? LANE_RUNNER_DIFFICULTIES.easy;
  const width = config.width; // 4 for easy, 3 for medium, 2 for hard
  const bridge = [];
  const prevBad = -1; // previous row's bad tile position (for memory rule)

  for (let row = 0; row < MAX_ROWS; row += 1) {
    // For row 0, no previous row → sentinel -1
    const prevTriple = row > 0 ? `${bridge[row - 1]}:-1:-1` : "-1:-1:-1";

    // Simulate a provably-fair bad tile for this row.
    // We only need one bad tile (not per path). Use the safe path's digest.
    const digest = crypto
      .createHash("sha256")
      .update(
        `${serverSeed}:${clientSeed}:${nonce}:${row}:safe:${prevTriple}`,
      )
      .digest("hex");
    let badTile = Number.parseInt(digest.slice(0, 8), 16) % width;

    // Same-path memory rule (from old game): bad tile never sits in the
    // same position as the previous row's bad tile on the same path.
    // Since we have one bad tile per row, we just bump if it repeats.
    if (badTile === prevBad && width > 1) {
      badTile = (badTile + 1) % width;
    }
    prevBad = badTile;

    bridge.push(badTile);
  }
  return bridge;
}

// Simulate a single digest for bridge generation.
function simulateBridgeDigest(serverSeed, clientSeed, nonce, row, path, prevTriple) {
  const digest = crypto
    .createHash("sha256")
    .update(`${serverSeed}:${clientSeed}:${nonce}:${row}:${path}:${prevTriple}`)
    .digest("hex");
  return { digest };
}

// ── Turn & bridge state ──────────────────────────────────────────
// Tracks the current row each player is on (0-indexed, 0..9).
// Row 10 means the player has won.
export function currentRowOf(match, seat) {
  return Number(seat === "player1" ? match.p1Lane : match.p2Lane) || 0;
}

// Has this player personally landed safely on the current row?
// Derived from action history: a safe pick on the row they're standing on.
export function hasLandedSafely(match, seat) {
  const actions = Array.isArray(match?.actions) ? match.actions : [];
  const lane = currentRowOf(match, seat);
  return actions.some(
    (a) =>
      a &&
      a.seat === seat &&
      a.action === "pick" &&
      a.safe === true &&
      (a.round ?? a.lane) === lane,
  );
}

// How many flags the player has remaining this match.
export function flagsLeft(match, seat) {
  const actions = Array.isArray(match?.actions) ? match.actions : [];
  const used = actions.filter(
    (a) => a && a.action === "flag" && a.seat === seat,
  ).length;
  return Math.max(0, FLAGS_PER_PLAYER - used);
}

// Can this player place a flag on the current row?
// Only after they have personally landed safely on it.
export function canFlag(match, seat) {
  return hasLandedSafely(match, seat) && flagsLeft(match, seat) > 0;
}

// ── Outcome resolution ──────────────────────────────────────────
// Given the player who busted (or null if no one busted), decide the
// match result based on who crossed row 10 first.
export function decideOutcome({ loserId, player1Id, player2Id, p1Lane, p2Lane }) {
  // If there's a loser (busted), the other player wins.
  if (loserId === player1Id) return "player1";
  if (loserId === player2Id) return "player2";
  // If neither busted, check who reached row 10 first.
  if (p1Lane >= MAX_ROWS) return "player1";
  if (p2Lane >= MAX_ROWS) return "player2";
  // Neither has won yet (should not happen if called at terminal state).
  return null;
}

// ── No longer used in the new game; kept for backward compatibility. ────
// export function bankedWinnerOf(match) {
//   return null;
// }