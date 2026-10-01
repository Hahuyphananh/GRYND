// src/lib/speed-typing/serverStore.ts
//
// The server-authoritative Speed Typing match store — MATCHMAKING, THE RACE,
// and COMPETITIVE SETTLEMENT.
//
// WHAT IS HERE
//   * `createOrJoin` — the queue/lobby half: one advisory lock, one
//     `SELECT … FOR UPDATE`, one conditional `UPDATE`. This is the destination
//     the platform's quick-queue worker calls (src/lib/quickQueueWorker.ts), so
//     a Speed Typing pairing produces a REAL match row and both seats land on
//     the same `/casino/speed-typing/<matchId>` URL. Joining is also what ARMS
//     the race: the row gets its server seed, its passage pair, and an absolute
//     GO instant one countdown in the future.
//   * `recordProgress` — the throttled checkpoint. A keystroke never becomes a
//     row; the socket layer calls this with what a seat has TYPED, and the
//     server derives the progress itself (`verifyTypedText`).
//   * `submitFinish` — the ONE mutating player action: verify against the
//     server's own passage, freeze the server-derived time/WPM/accuracy, then
//     resolve + settle the race inside the SAME row-locked transaction.
//   * `forfeitMatch` / `resolveDueRace` — the two ways a race ends without two
//     verified finishes (a seat left; the hard limit passed).
//   * `listOpenMatches` / `listMyWaitingMatch` / `listDueRaces` — the lobby
//     list, "resume my lobby", and the scheduler's due-race query.
//   * `fetchMatch` / `matchToDto` / `matchViewFor` — the read paths. The race
//     view (which carries the passage text) is built for PARTICIPANTS ONLY; a
//     non-participant cannot reach `fetchMatch` at all.
//   * `cancelMatch` — release an open lobby (the only way a `waiting` row
//     leaves the lobby list without being joined).
//   * `settleSpeedTypingMatch` — the settlement seam: the ONE place a finished
//     race records its result, and it delegates entirely to the platform's
//     existing writers (`applyRatingResult` / `applyTrophyResult`). There is no
//     Speed Typing-specific Elo or trophy maths here, and there never will be.
//
// AUTHORITY, IN ONE SENTENCE
//   A client may only ever say WHAT IT TYPED. Every number that decides a rated
//   match — progress, correctness, completion, elapsed time, WPM, accuracy, the
//   winner, the Elo delta, the trophies — is derived here from the server's own
//   passage (src/lib/speed-typing/passages.ts) and the server's own clock
//   (src/lib/speed-typing/rules.ts). No function in this file reads a winner, a
//   score, a duration or a rating from anything a caller passed in.
//
// ECONOMY
//   Speed Typing is unstaked: no tokens, no wagers, no balances, no payouts and
//   no house rake. There is deliberately no stake/prize column on the table and
//   no money-moving code path here. The only account stats a settled match
//   touches are `users.gamesWon` / `users.gamesLost`, plus the per-game Elo and
//   trophy rows owned by the shared writers.
//
// TRUST BOUNDARY
//   Every function takes a `userId` that the CALLER has already resolved from a
//   verified Clerk session (`requireAgeVerifiedUser`) or a verified token. No
//   function here reads a request body.

import { randomInt } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";

import { db } from "../../db/client";
import { speedTypingMatches, users } from "../../db/schema";
import { applyRatingResult } from "../rating";
import { applyTrophyResult } from "../trophyStore";
import { mirrorQueueCreated, mirrorQueueTransition } from "../canonicalQueueLifecycle";
import { coerceAiDifficulty } from "../aiDifficulty";
import { aiSeatRaceAt } from "./ai";
import { PASSAGE_VERSION, passageForRow, selectPassageForSeed } from "./passages";
import {
  coerceRaceState,
  createRaceState,
  emptySeatRace,
  evaluateCheckpoint,
  evaluateFinish,
  forfeitSeatRace,
  instantFromDate,
  isRaceDue,
  oppositeSeat,
  raceViewFor,
  resolveRace,
  seatForUser,
  userIdForSeat,
  verifyTypedText,
  type RaceState,
  type RaceView,
  type SeatRace,
} from "./rules";
import {
  DEFAULT_AI_DIFFICULTY,
  GAME_KEY,
  MATCH_STATUS,
  RACE_COUNTDOWN_MS,
  RACE_LIMIT_MS,
  RESOLUTION,
  RESULT,
  SEAT,
  SETTLEMENT_RESULT,
  SPEED_TYPING_AI_PLAYER_ID,
  SPEED_TYPING_LOCK_NAMESPACE,
  TERMINAL_STATUSES,
  type ResolutionReason,
  type SeatKey,
  type SettlementResult,
} from "./constants";

type MatchRow = typeof speedTypingMatches.$inferSelect;

export type StoreError = { error: string; status: number };

/** Seat ids, as the store speaks about them internally. */
export type Seats = { player1Id: string; player2Id: string | null };

/**
 * Route-level guard so a non-UUID id can never reach a Postgres `uuid` cast
 * (which would surface as a 500 instead of a 400). Mirrors
 * `isMatchId` in src/lib/mini-golf/serverStore.ts.
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isMatchId(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/** Seat→user-id mapping from a row. */
export function seatsFromRow(match: {
  player1Id: string;
  player2Id?: string | null;
}): Seats {
  return { player1Id: match.player1Id, player2Id: match.player2Id ?? null };
}

/** True when `userId` occupies either seat. */
export function isParticipant(
  match: { player1Id: string; player2Id?: string | null },
  userId: string | null,
): boolean {
  if (!userId) return false;
  return match.player1Id === userId || match.player2Id === userId;
}

/**
 * The practice bot's tier for a row. `NULL` (a human match, or a legacy row)
 * reads back as the documented default. There is no bot yet, so this exists
 * only so the future AI reads one value from one place.
 */
export function aiDifficultyForMatch(match: {
  aiDifficulty?: unknown;
  isAi?: boolean | null;
}) {
  if (!match?.isAi) return null;
  return coerceAiDifficulty(match.aiDifficulty ?? DEFAULT_AI_DIFFICULTY);
}

/** Client-facing DTO for a match row, from `viewerId`'s perspective. */
export function matchToDto(match: MatchRow, viewerId: string | null) {
  const seats = seatsFromRow(match);
  return {
    matchId: match.id,
    status: match.status,
    // The rated result, or null while the match is unfinished. `winnerId` is
    // the server's, never the client's.
    result: match.result ?? null,
    winnerId: match.winnerId ?? null,
    // Tells the match view nothing about a rating is ever shown for practice
    // matches — they are excluded from competitive progression by design.
    isAi: Boolean(match.isAi),
    aiDifficulty: aiDifficultyForMatch(match),
    // Seat order is player1 = host, player2 = joiner. A participant is told
    // which seat is theirs; a non-participant cannot reach this DTO at all
    // (see `fetchMatch`).
    viewerSeat: seats.player1Id === viewerId ? 1 : seats.player2Id === viewerId ? 2 : null,
    players: [
      { seat: 1 as const, userId: seats.player1Id },
      ...(seats.player2Id ? [{ seat: 2 as const, userId: seats.player2Id }] : []),
    ],
    createdAt: match.createdAt,
    startedAt: match.startedAt ?? null,
    endedAt: match.endedAt ?? null,
    // The race's absolute server clock: null until the race is armed, and the
    // only instant either client is ever told to count from.
    goAt: match.goAt ?? null,
    // Monotonic row revision. A client compares it against the one it last saw
    // to know its view is stale; it is never an INPUT to an authoritative write.
    revision: Number(match.revision ?? 0),
    resolutionReason: match.resolutionReason ?? null,
  };
}

/**
 * The participant view of a match: the lifecycle DTO plus the RACE.
 *
 * The race object is built ONLY for a real participant and is absent (`null`)
 * for anyone else — never a redacted copy, so there is no strip step to forget.
 * That single rule is what keeps the passage text server-side for everyone but
 * the two seats racing on it, and it is why the lifecycle DTO above stays
 * provably free of race data.
 */
export function matchViewFor({
  match,
  viewerId,
  nowMs = Date.now(),
}: {
  match: MatchRow;
  viewerId: string | null;
  nowMs?: number;
}) {
  const seat = seatForUser(match, viewerId);
  const race: RaceView | null = seat ? raceViewFor({ match, seat, nowMs }) : null;
  return { ...matchToDto(match, viewerId), race };
}

// ── Lobby / matchmaking ───────────────────────────────────────────────────

/** Open lobbies, oldest first (the order create-or-join fills them in). */
export async function listOpenMatches({ limit = 30 }: { limit?: number } = {}) {
  return await db
    .select()
    .from(speedTypingMatches)
    .where(
      and(
        eq(speedTypingMatches.status, MATCH_STATUS.WAITING),
        isNull(speedTypingMatches.player2Id),
      ),
    )
    .orderBy(sql`${speedTypingMatches.createdAt} ASC`)
    .limit(limit);
}

/** The caller's own still-waiting lobby, if any. */
export async function listMyWaitingMatch({ userId }: { userId: string }) {
  const [row] = await db
    .select()
    .from(speedTypingMatches)
    .where(
      and(
        eq(speedTypingMatches.status, MATCH_STATUS.WAITING),
        isNull(speedTypingMatches.player2Id),
        eq(speedTypingMatches.player1Id, userId),
      ),
    )
    .orderBy(sql`${speedTypingMatches.createdAt} ASC`)
    .limit(1);
  return row ?? null;
}

/**
 * Match the caller into an open lobby, or open a new one.
 *
 * The whole operation runs under a single `pg_advisory_xact_lock` (per-game
 * namespace) so two concurrent callers can never both see "no open lobby" and
 * each create one, and so a caller can never join a lobby that is being
 * cancelled. Identical to the Mini Golf / Plinko Duel pattern — this is the
 * ONE matchmaking implementation, reused rather than reinvented.
 *
 * Returns the same row for both paired players: the quick-queue worker calls
 * this once per seat and asserts the two ids match.
 */
export async function createOrJoin({ userId }: { userId: string }) {
  return await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${SPEED_TYPING_LOCK_NAMESPACE}, 0)`,
    );

    const [open] = await tx
      .select()
      .from(speedTypingMatches)
      .where(
        and(
          eq(speedTypingMatches.status, MATCH_STATUS.WAITING),
          isNull(speedTypingMatches.player2Id),
        ),
      )
      .orderBy(sql`${speedTypingMatches.createdAt} ASC`)
      .limit(1)
      .for("update");

    if (open) {
      // The caller's own lobby — return it rather than creating a second.
      if (open.player1Id === userId) return { match: open, joined: false };
      return await joinExistingMatch(tx, open.id, userId);
    }

    return await createWaitingMatch(tx, userId);
  });
}

async function createWaitingMatch(tx: any, userId: string) {
  const [match] = await tx
    .insert(speedTypingMatches)
    .values({
      player1Id: userId,
      status: MATCH_STATUS.WAITING,
      isAi: false,
    })
    .returning();

  // Mirror the lobby into the canonical queue lifecycle so the platform's
  // queue bookkeeping stays complete for every queue-matched game. Fire and
  // forget by design (a mirror failure can never fail a matchmaking call).
  mirrorQueueCreated({
    gameKey: GAME_KEY,
    matchId: match.id,
    playerCount: 1,
    queuedAt: match.createdAt ? new Date(match.createdAt) : undefined,
  });

  return { match, joined: false };
}

async function joinExistingMatch(tx: any, candidateId: string, userId: string) {
  const [match] = await tx
    .select()
    .from(speedTypingMatches)
    .where(eq(speedTypingMatches.id, candidateId))
    .for("update");

  if (!match || match.status !== MATCH_STATUS.WAITING || match.player2Id) {
    return { error: "Match is no longer available", status: 409 } as const;
  }

  // Both seats are known, so the match goes straight to `playing`: a typing
  // race has nothing to ready up, and every extra handshake is a way for two
  // players to sit on a dead screen.
  //
  // The join ALSO arms the race, in this one conditional UPDATE: the server
  // seed, the passage pair it resolves to, and an ABSOLUTE GO instant one
  // countdown from now. Arming on the join (rather than on a client's "I am
  // ready") means both seats are racing the same text off the same server
  // instant the moment they exist, with no third handshake to race.
  const nowMs = Date.now();
  const armed = armedRaceValues({ nowMs, revision: Number(match.revision ?? 0) });
  const [updated] = await tx
    .update(speedTypingMatches)
    .set({
      player2Id: userId,
      status: MATCH_STATUS.PLAYING,
      startedAt: new Date(nowMs),
      ...armed,
      updatedAt: new Date(nowMs),
    })
    .where(
      and(
        eq(speedTypingMatches.id, candidateId),
        eq(speedTypingMatches.status, MATCH_STATUS.WAITING),
        isNull(speedTypingMatches.player2Id),
      ),
    )
    .returning();

  if (!updated) {
    // Another joiner raced us and won the conditional UPDATE.
    return { error: "Match is no longer available", status: 409 } as const;
  }

  mirrorQueueCreated({
    gameKey: GAME_KEY,
    matchId: updated.id,
    playerCount: 2,
    queuedAt: updated.createdAt ? new Date(updated.createdAt) : undefined,
  });

  return { match: updated, joined: true };
}

/**
 * Start a free practice race against the built-in bot.
 *
 * Practice is UNRATED: the row is `isAi`, so `settleFinishedRace` skips
 * ratings, trophies and win counters entirely, and it never enters the open
 * lobby pool (the bot occupies player2 immediately, so it can never be joined
 * or listed).
 *
 * The race is ARMED here exactly as a real join arms it — one server seed, one
 * passage, one absolute GO instant one countdown ahead — so both seats race the
 * same text off the same clock. The human is player1 (host) and the bot takes
 * player2; the bot's progress is then advanced from the server clock on every
 * read (see `advanceAiRace`), so it always plays and can never be skipped.
 */
export async function createAiMatch({
  userId,
  difficulty,
}: {
  userId: string;
  difficulty?: unknown;
}) {
  const nowMs = Date.now();
  const tier = coerceAiDifficulty(difficulty ?? DEFAULT_AI_DIFFICULTY);
  const [match] = await db
    .insert(speedTypingMatches)
    .values({
      player1Id: userId,
      player2Id: SPEED_TYPING_AI_PLAYER_ID,
      status: MATCH_STATUS.PLAYING,
      isAi: true,
      aiDifficulty: tier,
      startedAt: new Date(nowMs),
      ...armedRaceValues({ nowMs, revision: 0 }),
    })
    .returning();

  return { match } as const;
}

// ── Read ──────────────────────────────────────────────────────────────────

export async function fetchMatch({
  userId,
  matchId,
}: {
  userId: string;
  matchId: string;
}) {
  const [match] = await db
    .select()
    .from(speedTypingMatches)
    .where(eq(speedTypingMatches.id, matchId))
    .limit(1);

  if (!match) return { error: "Match not found", status: 404 } as const;
  if (!isParticipant(match, userId)) {
    return { error: "Not a participant of this match", status: 403 } as const;
  }

  // The 403 above is the gate: only a participant ever reaches the view that
  // carries the passage text.
  //
  // For a practice race the bot is advanced to NOW first, so every poll shows
  // its live progress (and settles the race the instant both seats finish);
  // then the deadline is applied. A non-AI row is untouched by the first step.
  const advanced = await advanceAiIfPractice(match, Date.now());
  const current = await resolveRaceIfDue(advanced);
  return { match: current, dto: matchViewFor({ match: current, viewerId: userId }) } as const;
}

/**
 * Resolve a race whose hard limit has passed, on the READ path.
 *
 * WHY THIS EXISTS: the deadline is an ABSOLUTE server instant (`goAt +
 * RACE_LIMIT_MS`), and both seats stop being able to score at it — the store
 * already refuses every checkpoint and finish past it. But nothing used to
 * turn that elapsed instant into a verdict: `resolveDueRace` had no caller, so
 * a race where both players simply stopped typing (or walked away with the tab
 * still open) sat in `playing` forever, showing a client a finished clock and
 * an arena that could never be completed. Only a socket disconnect resolved it,
 * and only after the grace window.
 *
 * This is the same shape as Precision's `readMatch`, which applies its due
 * transitions on the read path for exactly this reason: a clocked match must
 * degrade to self-healing when no scheduler is running, never to a stranded
 * match. The arena polls the snapshot every 2 s, so both seats converge on the
 * verdict within a poll of the limit.
 *
 * Safe to call on every read: `resolveDueRace` takes the row lock and is
 * idempotent, so two seats polling concurrently settle the race exactly once.
 * Non-`playing` rows and unarmed rows are returned untouched, and a failure to
 * resolve degrades to the previous (unresolved) view rather than failing the
 * read.
 */
async function resolveRaceIfDue(match: MatchRow): Promise<MatchRow> {
  if (match.status !== MATCH_STATUS.PLAYING) return match;
  if (instantFromDate(match.goAt) == null) return match;
  if (!isRaceDue(match, Date.now())) return match;

  const result = await resolveDueRace({ matchId: match.id });
  return "error" in result ? match : result.match;
}

// ── Cancel ────────────────────────────────────────────────────────────────

/**
 * Cancel an open lobby. Only the creator, and only while still waiting.
 *
 * A cancelled lobby never settles, so no rating, trophy or stat is touched —
 * it is only removed from the available list and mirrored as cancelled.
 */
export async function cancelMatch({
  userId,
  matchId,
}: {
  userId: string;
  matchId: string;
}) {
  return await db.transaction(async (tx) => {
    const [match] = await tx
      .select()
      .from(speedTypingMatches)
      .where(eq(speedTypingMatches.id, matchId))
      .for("update");

    if (!match) return { error: "Match not found", status: 404 } as const;
    if (match.player1Id !== userId) {
      return { error: "Only the creator can cancel", status: 403 } as const;
    }
    if (match.status !== MATCH_STATUS.WAITING) {
      return {
        error: "Match cannot be cancelled after an opponent joins",
        status: 409,
      } as const;
    }

    const [updated] = await tx
      .update(speedTypingMatches)
      .set({
        status: MATCH_STATUS.CANCELLED,
        endedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(speedTypingMatches.id, match.id))
      .returning();

    mirrorQueueTransition({
      gameKey: GAME_KEY,
      matchId: match.id,
      status: "cancelled",
      playerCount: 1,
      cancelReason: "host_cancelled",
      at: new Date(),
    });

    return { match: updated ?? match } as const;
  });
}

// ── The race: arming, checkpoints, finish, forfeit, deadline ──────────────

/**
 * Server-generated race seed.
 *
 * `randomInt` (CSPRNG-backed) picks the seed; EVERYTHING downstream of it is
 * deterministic, so the seed plus the stored passage version reproduces the
 * exact text a match was raced on — forever, from two columns, with no prose in
 * the database. Same rule as Mini Golf's course seed.
 */
export function generateRaceSeed(): number {
  return randomInt(0, 0x100000000);
}

/**
 * The values that ARM a race. Pure, so the join UPDATE, `armRace`, and the
 * tests all build the same arming shape from the same expression.
 *
 * `goAt` is a FUTURE instant (now + the countdown), written as an absolute
 * timestamp. Both seats count down to the same server instant, so a slower
 * connection costs nobody anything and no client clock is consulted.
 */
export function armedRaceValues({
  nowMs,
  revision = 0,
  seed,
}: {
  nowMs: number;
  revision?: number;
  seed?: number;
}) {
  const raceSeed = Number.isFinite(Number(seed)) ? Number(seed) : generateRaceSeed();
  const passage = selectPassageForSeed({ seed: raceSeed, version: PASSAGE_VERSION });
  return {
    raceSeed,
    passageId: passage?.id ?? null,
    passageVersion: PASSAGE_VERSION,
    goAt: new Date(Math.floor(nowMs) + RACE_COUNTDOWN_MS),
    raceState: createRaceState({ version: Number(revision) + 1 }),
  };
}

/** The authoritative race state of a row (empty when the row is unarmed). */
export function raceStateOf(match: { raceState?: unknown }): RaceState {
  return coerceRaceState(match?.raceState);
}

/**
 * Arm a race that has an opponent but no GO instant yet.
 *
 * A row joined through `createOrJoin` is always armed in the join UPDATE, so
 * this covers the two leftovers: a row written before this release, and a
 * retried join that landed a seat but died before arming. Idempotent — an armed
 * row is returned untouched, so calling it twice can never restart a race that
 * is already running (which would hand both players a fresh passage mid-race).
 */
export async function armRace({ matchId, nowMs = Date.now() }: { matchId: string; nowMs?: number }) {
  return await db.transaction(async (tx) => {
    const [match] = await tx
      .select()
      .from(speedTypingMatches)
      .where(eq(speedTypingMatches.id, matchId))
      .for("update");

    if (!match) return { error: "Match not found", status: 404 } as const;
    if (instantFromDate(match.goAt) != null && match.raceSeed != null) {
      return { match, armed: false } as const;
    }
    if (!match.player2Id) {
      return { error: "Waiting for an opponent", status: 409 } as const;
    }
    if (TERMINAL_STATUSES.includes(String(match.status))) {
      return { error: "Match is not active", status: 409 } as const;
    }

    const [updated] = await tx
      .update(speedTypingMatches)
      .set({
        ...armedRaceValues({ nowMs, revision: Number(match.revision ?? 0) }),
        status: MATCH_STATUS.PLAYING,
        revision: sql`${speedTypingMatches.revision} + 1`,
        updatedAt: new Date(nowMs),
      })
      .where(eq(speedTypingMatches.id, match.id))
      .returning();

    return { match: updated ?? match, armed: true } as const;
  });
}

/**
 * Advance the practice bot's seat to the server's current instant.
 *
 * THE BOT'S "TURN". Speed Typing has no discrete turns, so the bot is modelled
 * as a typing SPEED (see ./ai.ts): this projects how far it has typed from the
 * elapsed server time and writes that seat state, exactly as a progress packet
 * from a real opponent would. Calling it on every read is what guarantees the
 * bot genuinely races — it can never be skipped, because nothing about its
 * progress depends on a client calling an endpoint.
 *
 * Idempotent and monotonic: a no-op for a non-AI row, an unarmed row, a row
 * whose race has already resolved, or a call that does not advance the cursor.
 * When the bot's write completes the race (both seats finished), it resolves and
 * settles inside this same transaction — the identical seam a real finish uses,
 * so a settled practice race is never rated.
 */
export async function advanceAiRace({
  matchId,
  nowMs = Date.now(),
}: {
  matchId: string;
  nowMs?: number;
}) {
  return await db.transaction(async (tx) => {
    const [match] = await tx
      .select()
      .from(speedTypingMatches)
      .where(eq(speedTypingMatches.id, matchId))
      .for("update");

    if (!match) return { error: "Match not found", status: 404 } as const;
    if (!match.isAi) return { match, advanced: false } as const;
    if (match.status !== MATCH_STATUS.PLAYING) return { match, advanced: false } as const;
    if (!match.player2Id) return { match, advanced: false } as const;

    const goAtMs = instantFromDate(match.goAt);
    if (goAtMs == null) return { match, advanced: false } as const;

    const state = raceStateOf(match);
    if (state.resolvedAtMs != null) return { match, advanced: false } as const;

    const passage = passageForRow(match);
    if (!passage) return { match, advanced: false } as const;

    const botSeat = SEAT.PLAYER2;
    const currentSeat = state.seats[botSeat] ?? emptySeatRace();
    const nextSeat = aiSeatRaceAt({
      difficulty: match.aiDifficulty,
      passageLength: passage.text.length,
      goAtMs,
      nowMs,
      current: currentSeat,
    });

    const changed =
      nextSeat.charsTyped !== currentSeat.charsTyped ||
      nextSeat.errors !== currentSeat.errors ||
      nextSeat.finished !== currentSeat.finished;
    if (!changed) return { match, advanced: false } as const;

    const seats = { ...state.seats, [botSeat]: nextSeat };
    // Only the SECOND verified finish ends the race by "finish"; until the
    // human has also completed, the practice race stays live so the player can
    // still beat the bot's clock.
    const bothFinished =
      seats[SEAT.PLAYER1]?.finished === true && seats[SEAT.PLAYER2]?.finished === true;
    const outcome = bothFinished
      ? resolveRace({ state: { ...state, seats }, reason: RESOLUTION.FINISH, nowMs })
      : null;

    const nextState: RaceState = {
      ...state,
      version: state.version + 1,
      seats,
      resolvedAtMs: outcome?.settled ? outcome.resolvedAtMs : state.resolvedAtMs,
      resolutionReason: outcome?.settled ? outcome.resolutionReason : state.resolutionReason,
    };

    const [updated] = await tx
      .update(speedTypingMatches)
      .set({
        ...progressColumnsFor(botSeat, nextSeat),
        ...(nextSeat.finished
          ? completedColumnFor(botSeat, new Date(nextSeat.finishedAtMs ?? nowMs))
          : {}),
        raceState: nextState,
        revision: sql`${speedTypingMatches.revision} + 1`,
        updatedAt: new Date(nowMs),
        ...(outcome?.settled ? terminalColumnsFor(match, outcome, nowMs) : {}),
      })
      .where(eq(speedTypingMatches.id, match.id))
      .returning();

    const settled = updated ?? match;
    if (outcome?.settled) {
      await settleFinishedRace(tx, match, outcome);
      mirrorCompletedRace(match);
    }

    return { match: settled, advanced: true } as const;
  });
}

/** Advance the bot (when the row is a practice race) and return the row. */
async function advanceAiIfPractice(match: MatchRow, nowMs: number): Promise<MatchRow> {
  if (!match.isAi || match.status !== MATCH_STATUS.PLAYING) return match;
  const advanced = await advanceAiRace({ matchId: match.id, nowMs });
  return "error" in advanced ? match : advanced.match;
}

/**
 * The scheduler's query: armed races whose hard limit has passed and which are
 * still unresolved. Read-only, and served by `speed_typing_matches_due_idx`.
 */
export async function listDueRaces({ limit = 50, nowMs = Date.now() }: { limit?: number; nowMs?: number } = {}) {
  const rows = await db
    .select()
    .from(speedTypingMatches)
    .where(
      and(
        eq(speedTypingMatches.status, MATCH_STATUS.PLAYING),
        sql`${speedTypingMatches.goAt} IS NOT NULL`,
        sql`${speedTypingMatches.goAt} <= ${new Date(nowMs - RACE_LIMIT_MS)}`,
      ),
    )
    .orderBy(sql`${speedTypingMatches.goAt} ASC`)
    .limit(limit);
  // The GO-instant arithmetic is the rules module's job (one definition), so a
  // row is only "due" when its own deadline has actually passed.
  return rows.filter((row) => isRaceDue(row, nowMs));
}

/**
 * Persist a throttled progress CHECKPOINT.
 *
 * The caller passes what the seat has TYPED and nothing else: the server
 * compares it against its own passage and derives the character count and the
 * error count itself, so a client can never claim progress it does not have.
 * (Which also means a shorter submission can never move a seat backwards, and
 * nothing typed before GO or after the hard limit is counted.)
 *
 * Cheap by design: `evaluateCheckpoint` rejects the overwhelming majority of
 * keystroke-rate calls as `below_threshold` / `no_advance` without a write, so a
 * whole race costs a handful of UPDATEs instead of thousands of rows.
 *
 * STALE CLIENTS / VERSION CONFLICTS are handled by making every write idempotent
 * and monotonic rather than by rejecting an out-of-date packet. The protocol is
 * "send the text I have typed so far", so a late or reordered packet carries
 * strictly less information than one already applied: it clamps to a
 * `no_advance` no-op instead of being refused, because refusing it would drop
 * valid progress while applying it twice is impossible (both counters only move
 * forward). The row's `revision`, returned to clients in the DTO, is the
 * staleness signal the CLIENT uses to know its view is old — it is never an
 * input the server trusts. (Contrast Mini Golf, whose shot command IS discrete
 * and therefore does gate on an expected version.)
 */
export async function recordProgress({
  userId,
  matchId,
  typedText,
  nowMs = Date.now(),
}: {
  userId: string;
  matchId: string;
  typedText: unknown;
  nowMs?: number;
}) {
  return await db.transaction(async (tx) => {
    const [match] = await tx
      .select()
      .from(speedTypingMatches)
      .where(eq(speedTypingMatches.id, matchId))
      .for("update");

    if (!match) return { error: "Match not found", status: 404 } as const;

    const seat = seatForUser(match, userId);
    if (!seat) {
      return { error: "Not a participant of this match", status: 403 } as const;
    }

    const state = raceStateOf(match);

    // Terminal: a benign no-op, not an error. A checkpoint stream keeps
    // arriving for a moment after a race ends, and the socket layer should not
    // have to treat a late packet as a failure.
    if (TERMINAL_STATUSES.includes(String(match.status))) {
      return {
        match,
        seat,
        accepted: false,
        reason: "resolved",
        seatState: state.seats[seat] ?? emptySeatRace(),
      } as const;
    }
    if (match.status !== MATCH_STATUS.PLAYING) {
      return { error: "Waiting for an opponent", status: 409 } as const;
    }

    const passage = passageForRow(match);
    if (!passage) {
      return { error: "Race is not armed", status: 409 } as const;
    }

    const verification = verifyTypedText({ passageText: passage.text, typedText });
    const decision = evaluateCheckpoint({
      state,
      seat,
      verification,
      nowMs,
      goAtMs: instantFromDate(match.goAt),
    });

    if (!decision.accept) {
      // No write at all: the throttle is what keeps a race out of the write
      // path. The caller gets the authoritative position back regardless.
      return {
        match,
        seat,
        accepted: false,
        reason: decision.reason,
        seatState: decision.seat,
      } as const;
    }

    const nextState: RaceState = {
      ...state,
      version: state.version + 1,
      seats: { ...state.seats, [seat]: decision.seat },
    };

    const [updated] = await tx
      .update(speedTypingMatches)
      .set({
        ...progressColumnsFor(seat, decision.seat),
        raceState: nextState,
        revision: sql`${speedTypingMatches.revision} + 1`,
        updatedAt: new Date(nowMs),
      })
      .where(eq(speedTypingMatches.id, match.id))
      .returning();

    return {
      match: updated ?? match,
      seat,
      accepted: true,
      reason: decision.reason,
      seatState: decision.seat,
    } as const;
  });
}

/** The two denormalised progress columns for a seat. Keeps the `set()` typed. */
function progressColumnsFor(seat: SeatKey, value: SeatRace) {
  return seat === SEAT.PLAYER1
    ? { player1CharsTyped: value.charsTyped, player1Errors: value.errors }
    : { player2CharsTyped: value.charsTyped, player2Errors: value.errors };
}

/** The `completed_at` column for a seat. */
function completedColumnFor(seat: SeatKey, at: Date) {
  return seat === SEAT.PLAYER1 ? { player1CompletedAt: at } : { player2CompletedAt: at };
}

/**
 * Submit a FINISH — the one mutating action a player has.
 *
 * The caller passes the text it typed. The server:
 *
 *   1. takes the row lock, so two finishes (and a finish racing a forfeit or a
 *      deadline resolution) serialise instead of interleaving;
 *   2. verifies the submission against the passage IT resolved from the row's
 *      own seed + version — never against anything from the request;
 *   3. freezes the elapsed time, WPM and accuracy from the server's GO instant
 *      and the server's now;
 *   4. if that was the second verified finish, resolves the race and settles it
 *      in the SAME transaction (the status flip and the rating change commit
 *      together, or neither does).
 *
 * Idempotent: a seat that already finished is a `duplicate` with no write at
 * all, so a replayed or retried packet can never produce a second result. The
 * shared writers are independently idempotent per `(user, game, match)` too.
 */
export async function submitFinish({
  userId,
  matchId,
  typedText,
  nowMs = Date.now(),
}: {
  userId: string;
  matchId: string;
  typedText: unknown;
  nowMs?: number;
}) {
  // Bring a practice bot's cursor up to NOW first, so a human finish that lands
  // second is compared against the bot's real finish instant (and a finish that
  // lands first leaves the bot the rest of the limit to answer). No-op for a
  // human race.
  await advanceAiRace({ matchId, nowMs });

  return await db.transaction(async (tx) => {
    const [match] = await tx
      .select()
      .from(speedTypingMatches)
      .where(eq(speedTypingMatches.id, matchId))
      .for("update");

    if (!match) return { error: "Match not found", status: 404 } as const;

    const seat = seatForUser(match, userId);
    if (!seat) {
      return { error: "Not a participant of this match", status: 403 } as const;
    }

    const state = raceStateOf(match);

    // A terminal match still answers, idempotently, with its stored result.
    if (TERMINAL_STATUSES.includes(String(match.status))) {
      return {
        match,
        seat,
        accepted: false,
        reason: state.seats[seat]?.finished ? "duplicate" : "resolved",
        seatState: state.seats[seat] ?? emptySeatRace(),
      } as const;
    }
    if (match.status !== MATCH_STATUS.PLAYING) {
      return { error: "Match is not active", status: 409 } as const;
    }

    const passage = passageForRow(match);
    if (!passage) {
      return { error: "Race is not armed", status: 409 } as const;
    }

    const verification = verifyTypedText({ passageText: passage.text, typedText });
    const decision = evaluateFinish({
      state,
      seat,
      verification,
      nowMs,
      goAtMs: instantFromDate(match.goAt),
    });

    if (!decision.accept) {
      return {
        match,
        seat,
        accepted: false,
        reason: decision.reason,
        firstMismatch: decision.firstMismatch,
        seatState: decision.seat,
      } as const;
    }

    const seats = { ...state.seats, [seat]: decision.seat };
    const bothFinished =
      seats[SEAT.PLAYER1]?.finished === true && seats[SEAT.PLAYER2]?.finished === true;

    // Only the SECOND verified finish can end the race by "finish"; until then
    // the match stays live and the opponent has the rest of the hard limit.
    const outcome = bothFinished
      ? resolveRace({
          state: { ...state, seats },
          reason: RESOLUTION.FINISH,
          nowMs,
        })
      : null;

    const nextState: RaceState = {
      ...state,
      version: state.version + 1,
      seats,
      resolvedAtMs: outcome?.settled ? outcome.resolvedAtMs : state.resolvedAtMs,
      resolutionReason: outcome?.settled ? outcome.resolutionReason : state.resolutionReason,
    };

    const [updated] = await tx
      .update(speedTypingMatches)
      .set({
        ...progressColumnsFor(seat, decision.seat),
        ...completedColumnFor(seat, new Date(nowMs)),
        raceState: nextState,
        revision: sql`${speedTypingMatches.revision} + 1`,
        updatedAt: new Date(nowMs),
        ...(outcome?.settled ? terminalColumnsFor(match, outcome, nowMs) : {}),
      })
      .where(eq(speedTypingMatches.id, match.id))
      .returning();

    const settled = updated ?? match;
    if (outcome?.settled) {
      await settleFinishedRace(tx, match, outcome);
      mirrorCompletedRace(match);
    }

    return {
      match: settled,
      seat,
      accepted: true,
      reason: "accepted",
      seatState: decision.seat,
      outcome: outcome ?? null,
    } as const;
  });
}

/**
 * End a race because a seat left or disconnected.
 *
 * Mirrors Mini Golf's abandonment path: a still-open lobby is released as
 * `cancelled` (there is no opponent to award anything to, and a cancelled match
 * never settles), while an active race is decided for the seat that is still
 * there and settled through the same seam as a played-out win. Idempotent — a
 * terminal match is reported, not an error, so a retry loop stops.
 */
export async function forfeitMatch({
  userId,
  matchId,
  nowMs = Date.now(),
}: {
  userId: string;
  matchId: string;
  nowMs?: number;
}) {
  return await db.transaction(async (tx) => {
    const [match] = await tx
      .select()
      .from(speedTypingMatches)
      .where(eq(speedTypingMatches.id, matchId))
      .for("update");

    if (!match) return { error: "Match not found", status: 404 } as const;

    const seat = seatForUser(match, userId);
    if (!seat) {
      return { error: "Not a participant of this match", status: 403 } as const;
    }
    if (TERMINAL_STATUSES.includes(String(match.status))) {
      return { match, forfeited: false, cancelled: false } as const;
    }

    // Still an open lobby: release it. Nothing settles.
    if (match.status === MATCH_STATUS.WAITING || !match.player2Id) {
      const [updated] = await tx
        .update(speedTypingMatches)
        .set({
          status: MATCH_STATUS.CANCELLED,
          endedAt: new Date(nowMs),
          revision: sql`${speedTypingMatches.revision} + 1`,
          updatedAt: new Date(nowMs),
        })
        .where(eq(speedTypingMatches.id, match.id))
        .returning();

      mirrorQueueTransition({
        gameKey: GAME_KEY,
        matchId: match.id,
        status: "cancelled",
        playerCount: 1,
        cancelReason: "disconnected",
        at: new Date(nowMs),
      });

      return { match: updated ?? match, forfeited: false, cancelled: true } as const;
    }

    const state = raceStateOf(match);
    const seats = { ...state.seats, [seat]: forfeitSeatRace(state.seats[seat] ?? emptySeatRace(), nowMs) };
    const outcome = resolveRace({
      state: { ...state, seats },
      reason: RESOLUTION.FORFEIT,
      nowMs,
    });
    const nextState: RaceState = {
      ...state,
      version: state.version + 1,
      seats,
      resolvedAtMs: outcome.resolvedAtMs,
      resolutionReason: outcome.resolutionReason,
    };

    const [updated] = await tx
      .update(speedTypingMatches)
      .set({
        raceState: nextState,
        revision: sql`${speedTypingMatches.revision} + 1`,
        updatedAt: new Date(nowMs),
        ...terminalColumnsFor(match, outcome, nowMs),
      })
      .where(eq(speedTypingMatches.id, match.id))
      .returning();

    await settleFinishedRace(tx, match, outcome);
    mirrorCompletedRace(match);

    return { match: updated ?? match, forfeited: true, cancelled: false } as const;
  });
}

/**
 * Resolve a race whose hard limit has passed.
 *
 * Called defensively by the read path (`resolveRaceIfDue`, inside `fetchMatch`)
 * and available to a scheduler, this is the "ran out of time" ending: the seat
 * that got further through the passage wins (a dead level, or a race where
 * neither seat typed anything, is a draw).
 * The verdict is computed from the authoritative checkpoints only — the last
 * WPM/accuracy each seat posted is irrelevant, and neither seat is asked. 
 *
 * Idempotent: a race that already resolved, or is not yet due, is a no-op, and
 * only one caller can win the row lock and write the result.
 */
export async function resolveDueRace({
  matchId,
  nowMs = Date.now(),
}: {
  matchId: string;
  nowMs?: number;
}) {
  // A practice bot's cursor must be current BEFORE the deadline verdict is
  // computed, so the tiebreak compares the bot's real progress. A no-op for a
  // human race, and idempotent either way.
  await advanceAiRace({ matchId, nowMs });

  return await db.transaction(async (tx) => {
    const [match] = await tx
      .select()
      .from(speedTypingMatches)
      .where(eq(speedTypingMatches.id, matchId))
      .for("update");

    if (!match) return { error: "Match not found", status: 404 } as const;
    if (match.status !== MATCH_STATUS.PLAYING) {
      return { match, resolved: false, reason: "not_playing" } as const;
    }

    const state = raceStateOf(match);
    if (state.resolvedAtMs != null) {
      return { match, resolved: false, reason: "already_resolved" } as const;
    }
    if (!isRaceDue(match, nowMs) || instantFromDate(match.goAt) == null) {
      return { match, resolved: false, reason: "not_due" } as const;
    }

    const outcome = resolveRace({ state, reason: RESOLUTION.DEADLINE, nowMs });
    const nextState: RaceState = {
      ...state,
      version: state.version + 1,
      resolvedAtMs: outcome.resolvedAtMs,
      resolutionReason: outcome.resolutionReason,
    };

    const [updated] = await tx
      .update(speedTypingMatches)
      .set({
        raceState: nextState,
        revision: sql`${speedTypingMatches.revision} + 1`,
        updatedAt: new Date(nowMs),
        ...terminalColumnsFor(match, outcome, nowMs),
      })
      .where(eq(speedTypingMatches.id, match.id))
      .returning();

    await settleFinishedRace(tx, match, outcome);
    mirrorCompletedRace(match);

    return { match: updated ?? match, resolved: true, reason: outcome.resolutionReason } as const;
  });
}

/** The terminal row fields a resolved race writes, in one expression. */
function terminalColumnsFor(
  match: MatchRow,
  outcome: { winnerSeat: SeatKey | null; resolutionReason: ResolutionReason | null },
  nowMs: number,
) {
  return {
    status: MATCH_STATUS.FINISHED,
    result:
      outcome.winnerSeat === SEAT.PLAYER1
        ? RESULT.PLAYER1
        : outcome.winnerSeat === SEAT.PLAYER2
          ? RESULT.PLAYER2
          : RESULT.TIE,
    // Null on a dead heat — there is no winner to name. `outcome.winnerSeat`
    // must be checked BEFORE it reaches `userIdForSeat`, which resolves a null
    // seat to player 2: without this guard a drawn row would name the second
    // seat as its winner, and every consumer that reads `winnerId` without also
    // checking `result` (history, evaluation, the boards) would report a draw
    // as a player-2 win.
    winnerId: outcome.winnerSeat ? userIdForSeat(match, outcome.winnerSeat) : null,
    resolutionReason: outcome.resolutionReason,
    endedAt: new Date(nowMs),
  };
}

/**
 * Settle a resolved race through the platform's shared writers.
 *
 * Practice (`isAi`) matches never touch rating, trophies or win counters, and a
 * race with no opponent cannot have one — the same two guards Mini Golf uses.
 * Everything else is delegated: this function contains no rating maths, no
 * trophy maths and no per-game rule of its own.
 */
async function settleFinishedRace(
  tx: any,
  match: MatchRow,
  outcome: { winnerSeat: SeatKey | null },
) {
  if (match.isAi) return { rated: false, trophied: false };
  if (!match.player2Id) return { rated: false, trophied: false };

  // A dead heat has no winner, so the seats are named by POSITION instead: the
  // shared writers journal both seats either way, with result "draw".
  const winnerClerkId = userIdForSeat(match, outcome.winnerSeat ?? SEAT.PLAYER1);
  const loserClerkId = userIdForSeat(
    match,
    outcome.winnerSeat ? oppositeSeat(outcome.winnerSeat) : SEAT.PLAYER2,
  );
  if (!winnerClerkId || !loserClerkId) return { rated: false, trophied: false };

  return await settleSpeedTypingMatch({
    tx,
    matchId: String(match.id),
    winnerClerkId,
    loserClerkId,
    result: settlementResultFor({ winnerSeat: outcome.winnerSeat }),
  });
}

/** The canonical queue mirror for a completed race (practice matches opt out). */
function mirrorCompletedRace(match: MatchRow) {
  if (match.isAi) return;
  mirrorQueueTransition({
    gameKey: GAME_KEY,
    matchId: match.id,
    status: "completed",
    playerCount: match.player2Id ? 2 : 1,
    cancelReason: null,
    at: new Date(),
  });
}

// ── Settlement (existing GRYND rating/trophy infrastructure only) ─────────

export type SettlementOutcome = {
  /** True when the result touched the rating rows (i.e. it was applied). */
  rated: boolean;
  /** True when the result touched the trophy rows (i.e. it was applied). */
  trophied: boolean;
};

/**
 * Record the outcome of a finished Speed Typing race.
 *
 * This is the game's ENTIRE competitive integration, and it is deliberately
 * thin: both numbers it can move come from the platform's shared writers.
 *
 *   * `applyRatingResult` — per-game Elo (src/lib/rating.js, maths in
 *     src/lib/elo.js). There is NO Speed Typing-specific rating formula.
 *   * `applyTrophyResult` — per-game trophies (src/lib/trophyStore.js,
 *     ±30 rules in src/lib/trophies.js). There is NO Speed Typing-specific
 *     trophy rule.
 *
 * Both are idempotent per `(user_id, game_key, match_id)` through their own
 * journals, so a replayed or concurrent settlement of the same match is a
 * guaranteed no-op — that journal, plus the caller's terminal `status` flip
 * under the row lock, is the game's whole exactly-once story.
 *
 * `gameKey: "speed-typing"` is written as a STRING LITERAL at each call site on
 * purpose: tests/trophy-system.test.mjs and tests/elo-rating.test.mjs audit the
 * source for `gameKey: "<key>"` to prove every rated game is wired to a shared
 * writer, and a constant reference would be invisible to that check.
 *
 * A draw moves both ratings by K × (0.5 − expected) and awards no trophies, but
 * it is still journaled so the event history stays complete.
 *
 * The returned `rated` / `trophied` flags report whether the shared writers
 * actually applied — not merely that they were called. A writer that refuses
 * (or fails) leaves the match finished and settled-at-most-once, so the caller
 * is told the truth and the last thing it does is claim a rating it did not get.
 *
 * No wager, no token, no payout, no rake: Speed Typing is unstaked, so the only
 * account stats touched are `users.gamesWon` / `users.gamesLost`.
 *
 * @param params.tx              the caller's settlement transaction
 * @param params.matchId         the authoritative match id (the journal key)
 * @param params.winnerClerkId   Clerk id of the winner (seat A on a draw)
 * @param params.loserClerkId    Clerk id of the loser  (seat B on a draw)
 * @param params.result          "win" (default) or "draw"
 */
export async function settleSpeedTypingMatch({
  tx,
  matchId,
  winnerClerkId,
  loserClerkId,
  result = SETTLEMENT_RESULT.WIN,
}: {
  tx: any;
  matchId: string;
  winnerClerkId: string;
  loserClerkId: string;
  result?: SettlementResult;
}): Promise<SettlementOutcome> {
  const eventId = String(matchId ?? "");
  const outcome =
    result === SETTLEMENT_RESULT.DRAW ? SETTLEMENT_RESULT.DRAW : SETTLEMENT_RESULT.WIN;

  // Never rate a seat against itself, and never with a missing id.
  if (!winnerClerkId || !loserClerkId) return { rated: false, trophied: false };
  if (String(winnerClerkId) === String(loserClerkId)) {
    return { rated: false, trophied: false };
  }
  if (!eventId) return { rated: false, trophied: false };

  if (outcome === SETTLEMENT_RESULT.DRAW) {
    // A draw is a result, not a win: no game counter moves, but the rating and
    // trophy journals are still written so the event history stays complete.
    const drawRating = await applyRatingResult({
      tx,
      gameKey: "speed-typing",
      matchId: eventId,
      winnerClerkId,
      loserClerkId,
      result: "draw",
    }).catch(() => null);
    const drawTrophy = await applyTrophyResult({
      tx,
      gameKey: "speed-typing",
      matchId: eventId,
      winnerClerkId,
      loserClerkId,
      result: "draw",
    }).catch(() => null);
    return { rated: drawRating?.applied === true, trophied: drawTrophy?.applied === true };
  }

  await tx
    .update(users)
    .set({ gamesWon: sql`${users.gamesWon} + 1` })
    .where(eq(users.clerkId, String(winnerClerkId)));
  await tx
    .update(users)
    .set({ gamesLost: sql`${users.gamesLost} + 1` })
    .where(eq(users.clerkId, String(loserClerkId)));

  // Both shared writers are best-effort BY CONTRACT: they never throw for an
  // expected input (a missing account is `{applied:false, reason:"user-not-found"}`,
  // not an exception), and a genuine database error is swallowed so a rating
  // hiccup can never roll back the match the players just played. Either way the
  // row is already terminal, so this reports WHAT THEY ACTUALLY APPLIED rather
  // than assuming success — a refused settlement is visible instead of implied.
  const appliedRating = await applyRatingResult({
    tx,
    gameKey: "speed-typing",
    matchId: eventId,
    winnerClerkId,
    loserClerkId,
  }).catch(() => null);
  const appliedTrophy = await applyTrophyResult({
    tx,
    gameKey: "speed-typing",
    matchId: eventId,
    winnerClerkId,
    loserClerkId,
  }).catch(() => null);

  return {
    rated: appliedRating?.applied === true,
    trophied: appliedTrophy?.applied === true,
  };
}

/**
 * Map a settled seat pair onto the shared writers' `result` token.
 *
 * Exported so the gameplay layer (and its tests) derive the token the same way:
 * a genuine dead heat is a draw, anything else is a win for `winnerSeat`.
 */
export function settlementResultFor({
  winnerSeat,
}: {
  winnerSeat: "player1" | "player2" | null;
}): SettlementResult {
  return winnerSeat === null ? SETTLEMENT_RESULT.DRAW : SETTLEMENT_RESULT.WIN;
}

/**
 * Same as `settlementResultFor`, but from a row's persisted `result` column.
 * Kept beside the seat form so a caller can settle from either representation
 * without re-deriving the rules in two places.
 */
export function settlementResultFromRow(result: unknown): SettlementResult {
  return result === RESULT.TIE ? SETTLEMENT_RESULT.DRAW : SETTLEMENT_RESULT.WIN;
}

/** True while a row is still in play (not terminal). */
export function isActiveStatus(status: unknown): boolean {
  return !TERMINAL_STATUSES.includes(String(status));
}
