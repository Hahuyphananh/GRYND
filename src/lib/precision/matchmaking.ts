// ── Auto-matchmaking for the Precision PvP casino game ─────────────────
//
// Pairs two players that click "Find match" at the SAME wager amount.
// The pairing is atomic with respect to a single Node.js event loop tick,
// which is sufficient for a single-process API deployment. (Cross-process
// workers would require a DB-backed queue — see the follow-up suggestions.)
//
// Conventions:
//   * Host-side wait state goes into `precisionLobbyStore` w/ status='waiting'.
//   * When paired, the same lobby id becomes the Precision match id so
//     both players navigate to the same /casino/precision/game/[id] URL.
//   * Polling via /api/precision/get-match surfaces the state transition
//     to both clients; no socket work needed because the match page already
//     re-renders when state.phase flips from "waiting" to "active".

import { precisionLobbyStore, precisionMatchStore } from "./serverStore";
import type { PrecisionLobby, PrecisionPlayer, PrecisionState } from "./types";

/** Construct the initial server-authoritative state for a new match.
 *  Used by both the PvP pairing path and the AI entry path so the score /
 *  round / target fields stay consistent. Exported so other routes (e.g.
 *  /api/precision/join-lobby) can build a canonical match state without
 *  duplicating the field defaults. */
export function makeInitialMatch(
  matchId: string,
  wager: number,
  players: PrecisionPlayer[],
  phase: PrecisionState["phase"] = "ready_up",
  currentTurn: PrecisionState["turn"] = 1,
): PrecisionState {
  return {
    matchId,
    phase,
    wager,
    players,
    turn: currentTurn,
    // Best-of-5 server-authoritative score — see recordRoundStop.
    score: { seat1: 0, seat2: 0 },
    currentRound: 1,
    // Replay-attack protection fields are null until the first
    // `armMatchRound` populates them. `roundSequence` is monotonic and
    // starts at 0 (the first arm will bump it to 1 — this matches the
    // 1-based "Round 1" the UI displays via `state.currentRound`).
    // `roundId` + `roundNonce` flow to the client via the
    // `precision:roundArmStart` broadcast so the client can include
    // them in subsequent stop packets.
    roundSequence: 0,
    roundId: null,
    roundNonce: null,
    // Target is server-only until the timing-timer reveals it. New
    // matches start in `ready_up` so the target is irrelevant here;
    // the rolled value lands during the first `armMatchRound` after
    // both players Ready.
    targetMs: null,
    winnerSeat: null,
    lastRoundWinnerSeat: null,
    armingStartedAt: null,
    // Server-stamped GO instant for the active round (null between
    // rounds / before the first round). Owns all round timing.
    roundGoInstant: null,
    // Per-seat stop telemetry for the most recently DECIDED round.
    // Replaced when both seats have submitted for the next round. null
    // before the first round resolves.
    lastRoundStops: null,
    version: 1,
  };
}

export interface AutoMatchWaitingResult {
  status: "waiting";
  gameId: string;
  lobby: PrecisionLobby;
}

export interface AutoMatchMatchedResult {
  status: "matched";
  gameId: string;
  match: PrecisionState;
  /** Opponent from the perspective of the caller (the joiner). */
  opponent: { userId: string; name: string; seat: 1 | 2 };
}

export type AutoMatchResult = AutoMatchWaitingResult | AutoMatchMatchedResult;

interface AutoPairOptions {
  /** Wager the caller is matching on, already clamped to a valid value. */
  wager: number;
  /** Stable id of the calling user (clerkId in production, fallback string
   *  used in the scaffold). Used to prevent self-pairing. */
  hostUserId: string;
  /** Display name, surfaces in the next pairing callback if matched. */
  hostName: string;
  /** Game mode — only "pvp" enters the matchmaking queue. */
  gameMode: "pvp" | "ai";
}

/**
 * Atomically either:
 *   1. Pair the caller with a waiting lobby at the same wager and return
 *      the joined match + opponent details; or
 *   2. Insert a new waiting lobby and return it for the caller to await.
 *
 * No two callers at the same wager can both end up in the "create new
 * waiting lobby" branch: Node's single-threaded execution ensures the map
 * walk + write below happens between awaits.
 */
export function tryAutoMatch({
  wager,
  hostUserId,
  hostName,
  gameMode,
}: AutoPairOptions): AutoMatchResult {
  // AI flow skips matchmaking entirely (the caller wants to play alone).
  if (gameMode === "ai") {
    return createAiEntry(wager, hostUserId, hostName);
  }

  // Idempotency: if this user already has a PvP queue entry at this
  // wager, return it instead of carving out a second waiting lobby.
  // Prevents double-click orphans that would surface in the public list
  // and confuse the pairing loop.
  for (const [id, lobby] of precisionLobbyStore) {
    if (
      lobby.status === "waiting" &&
      lobby.gameMode === "pvp" &&
      lobby.wager === wager &&
      lobby.hostUserId === hostUserId
    ) {
      return { status: "waiting", gameId: id, lobby };
    }
  }

  // Walk existing waiting PvP lobbies at the same wager. First non-self
  // match wins. We pair immediately, mutate the lobby, and synthesise the
  // match state beneath the lobby id.
  for (const [id, lobby] of precisionLobbyStore) {
    if (
      lobby.status === "waiting" &&
      lobby.gameMode === "pvp" &&
      lobby.wager === wager &&
      lobby.hostUserId !== hostUserId
    ) {
      const matchId = id;
      const opponentUserId = hostUserId;
      const opponentName = hostName;

      // Mutate the existing lobby so its public lookups (lists, get-match
      // fallback) reflect the new ownership atomically.
      lobby.opponentUserId = opponentUserId;
      lobby.opponentName = opponentName;
      lobby.status = "active";

      const players: PrecisionPlayer[] = [
        {
          seat: 1,
          userId: lobby.hostUserId,
          name: lobby.hostName ?? "Player 1",
          // Both players must explicitly click Ready before the match
          // begins — see `markPlayerReady` in serverStore.ts.
          isReady: false,
          isConnected: true,
        },
        {
          seat: 2,
          userId: opponentUserId,
          name: opponentName,
          isReady: false,
          isConnected: true,
        },
      ];

      const match = makeInitialMatch(matchId, lobby.wager, players, "ready_up");
      precisionMatchStore.set(matchId, match);

      return {
        status: "matched",
        gameId: matchId,
        match,
        opponent: {
          userId: lobby.hostUserId,
          name: lobby.hostName ?? "Player 1",
          seat: 2,
        },
      };
    }
  }

  // No waiting lobby at this wager — insert one and have the caller wait.
  const lobbyId = `lobby-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const lobby: PrecisionLobby = {
    id: lobbyId,
    hostUserId,
    hostName,
    opponentUserId: null,
    opponentName: null,
    wager,
    gameMode: "pvp",
    status: "waiting",
    createdAt: Date.now(),
  };
  precisionLobbyStore.set(lobbyId, lobby);
  return { status: "waiting", gameId: lobbyId, lobby };
}

function createAiEntry(
  wager: number,
  hostUserId: string,
  hostName: string,
): AutoMatchResult {
  const id = `match-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const lobby: PrecisionLobby = {
    id,
    hostUserId,
    hostName,
    opponentUserId: "ai-opponent",
    opponentName: "Precision AI",
    wager,
    gameMode: "ai",
    status: "active",
    createdAt: Date.now(),
  };
  precisionLobbyStore.set(id, lobby);
  const match = makeInitialMatch(
    id,
    wager,
    [
      {
        seat: 1,
        userId: hostUserId,
        name: hostName,
        isReady: true,
        isConnected: true,
      },
      {
        seat: 2,
        userId: "ai-opponent",
        name: "Precision AI",
        isReady: true,
        isConnected: true,
      },
    ],
    "active",
  );
  precisionMatchStore.set(id, match);
  return { status: "matched", gameId: id, match, opponent: {
    userId: "ai-opponent",
    name: "Precision AI",
    seat: 2,
  } };
}
