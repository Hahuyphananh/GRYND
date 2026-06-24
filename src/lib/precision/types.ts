// ── Shared types for the Precision PvP casino game ──────────────────────
//
// This file only defines data shapes. No gameplay logic lives here.
// Implementation of the per-frame reducer / engine should live in
// `src/lib/precision/engine.ts` once gameplay begins.
//
// Conventions mirror `src/lib/pool/types.ts` so that consumers can reason
// about Precision state identically to other multiplayer games.

export type PlayerSeat = 1 | 2;

export type PrecisionPhase =
  | "waiting"      // lobby created, host is waiting for opponent
  | "starting"     // both seats are filled, game initialising
  | "ready_up"     // both players matched — each must click Ready before
                   // the server flips the match to "active"
  | "arming"       // server has scheduled a random-delay timer before
                   // the round opens for stops. The client NEVER learns
                   // the planned delay end — it only sees the phase
                   // transition to "active" when the server fires it.
  | "active"       // match in progress (stops accepted)
  | "finished";    // match ended (winner declared or resigned)

export type PrecisionEndReason =
  | "completed"    // legitimate game completion
  | "resigned"     // player quit mid-match
  | "timeout"      // turn timer expired
  | "disconnect"   // opponent disconnected
  | "forfeit";     // host cancelled the lobby

export interface PrecisionPlayer {
  seat: PlayerSeat;
  userId: string;
  name: string;
  profilePicture?: string | null;
  isReady: boolean;
  isConnected: boolean;
}

export interface PrecisionLobby {
  id: string;
  hostUserId: string;
  /** Display name for the host. Used in the matchmaking preview and in
   * the PrecisionWaitingRoom before opponent joins. */
  hostName: string;
  opponentUserId: string | null;
  opponentName?: string | null;
  wager: number;
  /** Precision is PvP-only — solo practice lives at
   * `/casino/precision/test`, a self-contained client-side page that
   * bypasses the lobby/match store entirely. Kept as a typed literal
   * (rather than removed) so historical lobby snapshots in
   * `precisionLobbyStore` continue to type-check on read. */
  gameMode: "pvp";
  status: "waiting" | "active";
  createdAt: number;
}

export interface PrecisionScore {
  seat1: number;
  seat2: number;
}

export interface PrecisionState {
  matchId: string;
  phase: PrecisionPhase;
  wager: number;
  players: PrecisionPlayer[];
  turn: PlayerSeat;
  // ── Best-of-5 win condition (server-authoritative) ─────────────────
  //
  // The match ends as soon as EITHER seat's score reaches TARGET_WINS.
  // Clients MUST treat these fields as read-only; the server increments
  // score only via the round-stop endpoint after independently computing
  // the round winner from the server-stored `targetMs`.
  score: PrecisionScore;
  /** 1..MAX_ROUNDS — the round currently in progress. */
  currentRound: number;
  /** Monotonic per-match round counter, incremented on every
   *  `armMatchRound` call. Independent of `currentRound`:
   *  `currentRound` does NOT advance on ties (ties replay the SAME
   *  round number with a fresh rolled target), while `roundSequence`
   *  DOES advance on every arm — including tie-replays — because it
   *  is the canonical identifier for the round-replay envelope
   *  (`roundId` + `roundNonce`). Always positive; starts at 0 in
   *  `makeInitialMatch` and reaches 1 on the first arm. Never
   *  decreases even on resign / cancel — ties cannot reuse an
   *  earlier sequence number. */
  roundSequence: number;
  /** Server-stamped identifier for the round currently being armed or
   *  played. Derived from `roundSequence` so it is unique within the
   *  match AND human-readable. The client must include this string in
   *  `precision:stop` payloads so the server can reject packets from
 *  *previous* rounds (an attacker who replays an old packet reveals a
 *  stale `roundId`). `null` between matches / before the first arm —
 *  clients must NOT submit a stop packet when it is null. */
  roundId: string | null;
  /** Server-rolled cryptographic nonce for the round currently being
   *  armed or played. Stamped at arm-start in `armMatchRound` via
 *  `crypto.randomUUID()` (or a Math.random fallback if not available).
 *  The server stores it on the public `match.roundNonce` so clients
 *  can include it in their stop packet; the server ONLY accepts a stop
 *  whose `nonce` matches the live `match.roundNonce`. Any old-round
 *  packet will fail this check. null between rounds / before the
 *  first arm. */
  roundNonce: string | null;
  /** Public copy of the round's target time (ms), revealed by the server
   *  at the moment `phase` flips from `arming` to `active`. `null` while
   *  the match is in `arming` / `waiting` / `ready_up` / `starting` —
   *  the server stores the rolled value in the private
   *  `precisionRoundTargets` map during those phases so clients cannot
   *  pre-read it. Once revealed the value persists on the public state
   *  until the round is decided and the next `armMatchRound` call rolls
   *  a fresh target. */
  targetMs: number | null;
  /** 1 / 2 / null. Set by the server once `score.seatN === TARGET_WINS`. */
  winnerSeat: PlayerSeat | null;
  /** Seat that won the most recently-decided round. Useful for a
   *  per-round toast. null when no rounds played yet. */
  lastRoundWinnerSeat: PlayerSeat | null;
  /** Server-stamped timestamp (ms) when the current `arming` phase
   *  BEGAN. Does NOT expose the planned end of the delay — clients can
   *  use this only to render an "X ms since arming started" indicator
   *  if desired. null when not arming. */
  armingStartedAt: number | null;
  /** Server-stamped instant (ms epoch) when the current round's
   *  `arming → active` transition fired — the source-of-truth GO
   *  instant. Server-authoritative; clients NEVER supply their own.
   *  Used by `recordRoundStop` to compute elapsedMs as the difference
   *  between this and the server-stamped STOP instant, fulfilling the
   *  "all timing on the server" requirement. null between rounds /
   *  before the first round. */
  roundGoInstant: number | null;
  /** Per-seat stop telemetry for the most recently DECIDED round.
   *  `stopInstant` is server-stamped at `recordRoundStop` receive time.
   *  `elapsedMs` = `stopInstant` - `roundGoInstant` from the round
   *  that just resolved. `diffMs` = `|elapsedMs - targetMs|`, also
   *  server-stamped. Stored so post-round result popups can show
   *  each player's reaction time AND the round-deciding delta
   *  without re-querying. Cleared on each new round's arm-start
   *  (replaced once both seats have submitted for the next round).
   *  null before the first round resolves. */
  lastRoundStops: {
    seat1: {
      stopInstant: number;
      elapsedMs: number;
      diffMs: number;
      userId: string;
    };
    seat2: {
      stopInstant: number;
      elapsedMs: number;
      diffMs: number;
      userId: string;
    };
  } | null;
  // Server-authoritative version counter — used by the reducer dedup logic.
  version: number;
  // Free-form payload for the eventual gameplay implementation. Treated as
  // opaque by the waiting-room and result-popup components.
  payload?: Record<string, unknown>;
}

export interface PrecisionMatchSummary {
  matchId: string;
  phase: PrecisionPhase;
  winnerSeat: PlayerSeat | null;
  result: "win" | "loss" | "draw";
  reason: PrecisionEndReason;
  wager: number;
  payout: number;
  endedAt: number;
  finalScore?: PrecisionScore;
}

export interface PrecisionRoundAction {
  matchId: string;
  seat: PlayerSeat;
  // Sequence number supplied by the client; the server mirrors this back to
  // the opponent along with a server-assigned `serverSeq` for dedup.
  clientSeq: number;
  payload?: Record<string, unknown>;
}

/** POST body for `/api/precision/round-stop`. Each player submits ONLY
 *  their own reaction signal; the server stamps the STOP instant at
 *  receive time and computes elapsed as
 *  `stopInstant - match.roundGoInstant` authoritatively. The server
 *  waits for BOTH seats and independently decides the round winner
 *  using the server-stored `targetMs`. */
export interface PrecisionRoundStop {
  matchId: string;
  userId: string;
  /** Server-rolled identifier for the round currently being armed or
   *  played. The client reads this from `match.roundId` after the
   *  `precision:roundArmStart` broadcast and includes it verbatim so
   *  the server can REJECT any stop packet whose `roundId` does not
   *  match the LIVE `match.roundId` (replay from a previous round). */
  roundId: string;
  /** Server-rolled cryptographic nonce for the round currently being
   *  armed or played. The client reads this from `match.roundNonce`
   *  after the `precision:roundArmStart` broadcast and includes it
   *  verbatim so the server can REJECT any stop packet whose `nonce`
   *  does not match the LIVE `match.roundNonce`. A previous-round
   *  packet will fail this check even if a tampering client mutated
   *  its `roundId`. */
  nonce: string;
}

export interface PrecisionRoundStopResponse {
  success: boolean;
  /** True once both players have submitted for this round. */
  bothStopped?: boolean;
  /** Round winner once both players have submitted. Seat number or null
   *  for a tie (no score change). */
  roundWinnerSeat?: PlayerSeat | null;
  /** True once score[*] >= TARGET_WINS and the server has transitioned
   *  the match to `phase: "finished"` and set `winnerSeat`. */
  matchFinished?: boolean;
  /** True if the caller had previously submitted and re-submitted; the
   *  server keeps the latest value but treats it as a no-op for
   *  round evaluation purposes. */
  alreadySubmitted?: boolean;
  /** Rejection reason if the server refused the submission. */
  error?: string;
  /** Updated match snapshot on success. */
  match?: PrecisionState;
}

export interface PrecisionEndPopupState {
  result: "win" | "loss" | "draw";
  reason: PrecisionEndReason;
  openedAt: number;
  payout: number;
  opponentName?: string;
  /** Display name of the seat that took the match. Used by the popup
   *  to render an explicit "Winner: [name]" row alongside the win /
   *  loss framing. Resolved server-side from the match's winning
   *  seat at the moment the popup opens so a malicious client
   *  cannot spoof the winner display. */
  winnerName?: string | null;
  /** Final settled score (seat1: wins, seat2: wins). Lets the popup
   *  show a "(3 : 1)" tally, distinguishing a clean win from a
   *  near-loss. */
  finalScore?: { seat1: number; seat2: number } | null;
  /** Payout multiplier applied to the wager (e.g. 1.9×). Used by the
   *  popup's "Prize" line to clarify the rule set. Defaults to 1.9. */
  prizeMultiplier?: number;
  /** Wager amount the match was played for. Used by the popup's
   *  prize line to show the basis (e.g. "1.9× on 100 wagered"). */
  wager?: number;
}
