// src/lib/pool/rack.ts
//
// THE rack, and the shape of a Pool Masters match state as the SERVER keeps it.
//
// The rack used to live inside the match page (`setupBalls`). It has to be
// shared now: a staked match settles on the server's own simulation of the
// shots, and the server can only reproduce a shot if it starts from exactly the
// same table the players do. Same layout, same order, same numbers.
//
// WHY SEAT-KEYED: the client's synced payload carries `myTeam`/`oppTeam` — the
// SHOOTER's view — which is fine for display but cannot be persisted, because
// "my" depends on who is reading. The server's copy keys the groups by SEAT
// (`team1`/`team2`), so the same row means the same thing to both players and to
// the settlement that reads it.

import { BALL_LAYOUT } from "./constants";
import type { Ball, PlayerTurn, Team } from "./types";

/** The opening table: cue ball on the head spot, the rack on the foot spot. */
export function setupPoolBalls(): Ball[] {
  const balls: Ball[] = [
    {
      id: 0,
      number: 0,
      x: 180,
      y: 250,
      vx: 0,
      vy: 0,
      color: "#f5f5f5",
      striped: false,
      pocketed: false,
    },
  ];
  let k = 1;
  for (let r = 0; r < 5; r++)
    for (let c = 0; c <= r; c++) {
      const d = BALL_LAYOUT[k - 1];
      balls.push({
        id: k,
        number: d.n,
        x: 620 + r * 19,
        y: 250 - r * 11 + c * 22,
        vx: 0,
        vy: 0,
        color: d.c,
        striped: d.s,
        pocketed: false,
      });
      k++;
    }
  return balls;
}

/** Where the cue ball is re-spotted after a scratch. */
export const CUE_SPOT = { x: 180, y: 250 } as const;

/**
 * The server's authoritative match state. Everything a settle needs is here:
 * both groups by seat, whose turn it is, and who won.
 */
export interface PoolServerState {
  balls: Ball[];
  turn: PlayerTurn;
  team1: Team;
  team2: Team;
  openTable: boolean;
  ballInHand: boolean;
  winner: PlayerTurn | null;
  version: number;
  /** The seat that took the last shot (so a client can orient the display). */
  lastShooter?: PlayerTurn | null;
  /** Set when the last shot was a foul, with the ruling's own wording. */
  foul?: boolean;
  foulMessage?: string | null;
  /** The client's id for the stroke this state came from (replay guard). */
  lastShotId?: string | null;
}

/** The state a freshly created match starts in. `firstTurn` comes from the lobby. */
export function createInitialPoolState(firstTurn: PlayerTurn = 1): PoolServerState {
  return {
    balls: setupPoolBalls(),
    turn: firstTurn,
    team1: null,
    team2: null,
    openTable: true,
    ballInHand: false,
    winner: null,
    version: 1,
    lastShooter: null,
  };
}

/** The seat a Clerk id holds in a match row, or null when they hold none. */
export function poolSeatFor(
  match: { player1Id: string | null; player2Id: string | null },
  clerkId: string | null | undefined,
): PlayerTurn | null {
  if (!clerkId) return null;
  if (match.player1Id === clerkId) return 1;
  if (match.player2Id === clerkId) return 2;
  return null;
}

/**
 * Read a stored `pool_matches.game_state` as the server's seat-keyed state.
 *
 * Two shapes exist in the wild and both must read correctly:
 *
 *   * rows written by `/api/pool/submit-shot` — already seat-keyed (`team1` /
 *     `team2`), the shape every new settlement is derived from;
 *   * rows written by the page's live sync (`myTeam` / `oppTeam` plus the
 *     `perspectiveSeat` that names whose view it is) — re-keyed here, because
 *     "my" means nothing to a settlement.
 *
 * A match that has never had a shot stored (the row the lobby inserts) has no
 * `balls`, and returns null so the caller seeds the rack itself.
 */
export function readPoolServerState(raw: unknown): PoolServerState | null {
  if (!raw || typeof raw !== "object") return null;
  const gs = raw as Record<string, any>;
  if (!Array.isArray(gs.balls) || gs.balls.length === 0) return null;

  const perspective: PlayerTurn = gs.perspectiveSeat === 2 ? 2 : 1;
  const hasSeatKeys = "team1" in gs || "team2" in gs;
  const team1: Team = hasSeatKeys
    ? (gs.team1 ?? null)
    : perspective === 1
      ? (gs.myTeam ?? null)
      : (gs.oppTeam ?? null);
  const team2: Team = hasSeatKeys
    ? (gs.team2 ?? null)
    : perspective === 1
      ? (gs.oppTeam ?? null)
      : (gs.myTeam ?? null);

  return {
    balls: gs.balls as Ball[],
    turn: gs.turn === 2 ? 2 : 1,
    team1,
    team2,
    openTable: gs.openTable ?? !(team1 && team2),
    ballInHand: gs.ballInHand === true,
    winner: gs.winner === 1 || gs.winner === 2 ? gs.winner : null,
    version: typeof gs.version === "number" ? gs.version : 0,
    lastShooter:
      gs.lastShooter === 1 || gs.lastShooter === 2 ? gs.lastShooter : null,
    foul: gs.foul === true,
    foulMessage: typeof gs.foulMessage === "string" ? gs.foulMessage : null,
    lastShotId: typeof gs.lastShotId === "string" ? gs.lastShotId : null,
  };
}
