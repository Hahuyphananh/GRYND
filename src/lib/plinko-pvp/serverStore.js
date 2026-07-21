// src/lib/plinko-pvp/serverStore.js
//
// Server-side canonical helpers for the Plinko Duel PvP match system.
//
// Why a dedicated serverStore (mirrors `src/lib/mines-pvp/serverStore.js`,
// `src/lib/blackjack-pvp/serverStore.js`, `src/lib/roulette-pvp/serverStore.js`):
//   The match state machine has to be authoritative on the server:
//     * matchmaking lock (stake-keyed) prevents lobby-race duplicates
//     * 3-second ready banner auto-advance (waits without manual click)
//     * server-side deterministic ball simulation (same seed → same path)
//     * 20-second per-ball commit window auto-launch (AFK → safe mid-board shot)
//     * input lock-in per ball (one-shot per player per ball — matches
//       roulette-pvp's anti-cheat pattern; a player cannot rewrite their
//       inputs at the last millisecond to scrub the result)
//     * 3-ball aggregate scoring with 90/10 payout split (winner gets
//       1.9× stake back, house keeps 0.1×)
//   Centralising this in a tiny module keeps the API routes thin and
//   makes the state machine testable in isolation.
//
// State machine:
//   waiting → ready → ball_1 → ball_2 → ball_3 → finished
//   (waiting → cancelled; any non-terminal → cancelled by grace timeout)
//
// Unlike mines-pvp (turn-based: p1_turn → p2_turn) or blackjack-pvp
// (alternating: round_1 → between_rounds → round_2), Plinko Duel is
// PARALLEL: both players commit inputs for the same ball independently.
// The ball resolves when both seats have either committed or been
// auto-launched. There is NO "between_balls" server state — the match
// advances ball_N → ball_(N+1) immediately and the client renders the
// 3-second "Ball X incoming…" overlay in parallel.

import { eq, and, sql, isNull, inArray } from "drizzle-orm";
import { db } from "../../db/client";
import {
  plinkoPvpMatches,
  plinkoPvpRounds,
  users,
} from "../../db/schema";
import { sendSystemNotificationEmail } from "../emails/system";
import {
  BALL_OUTCOME,
  LAUNCHABLE_STATES,
  MATCH_STATUS,
  MAX_BALL_POINTS,
  MAX_STAKE,
  MIN_STAKE,
  PLINKO_PVP_LOCK_NAMESPACE,
  READY_WINDOW_MS,
  REQUIRED_BALLS,
  RESULT,
  ROUND_DEADLINE_MS,
  ROUND_TIMER_SECONDS,
  autoLaunchInputs,
  computePayout,
  round2,
} from "./constants";
import { hashSeed, simulateBall, simulateDualBalls } from "./physics";

// ── Helpers ───────────────────────────────────────────────────────────

// Schema self-check: probe that plinko_pvp_matches has the
// `p1_ready` / `p2_ready` columns the launchBall UPDATE references.
// This exists because migration 0052 was rejected on Neon in an
// earlier form (a bad partial index — see the comment at the top of
// `src/db/migrations/0052_plinko_pvp_ready_and_collision.sql`) and
// may never have been re-applied, so the columns can be missing on
// the live DB and turn every launchBall call into an opaque 500.
//
// Cache semantics — important:
//   * We only cache `true` for the lifetime of the server instance.
//   * We DO NOT cache `false` permanently — a transient probe failure
//     (Neon cold-start race, brief network blip, deploy during
//     migration) would otherwise wedge every subsequent launchBall
//     call to 503 for the rest of the Lambda's life, even after the
//     schema was eventually fixed.
//   * On `false` we clear the cache so the NEXT call retries the
//     probe. This is self-healing the moment the migration lands.
//   * In-flight probes are deduped via the cached promise so a stampede
//     of N concurrent first-callers runs exactly one SELECT.
//
// We SELECT against `id = -1` (no matching row) so the query
// validates the column references without ever touching the user's
// actual match rows.
let readyColumnsCheck = null; // null = unchecked, true = ok, Promise<boolean> = in-flight
export async function ensurePlinkoReadyColumns() {
  // Already-known good — short-circuit so the hot path is query-free.
  if (readyColumnsCheck === true) return true;
  // A probe is already in flight — share its result.
  if (
    readyColumnsCheck !== null &&
    typeof readyColumnsCheck.then === "function"
  ) {
    return await readyColumnsCheck;
  }
  // Start a fresh probe. We deliberately do NOT cache `false` so a
  // single transient failure does not permanently 503 the instance.
  const probe = (async () => {
    try {
      await db
        .select({
          p1Ready: plinkoPvpMatches.p1Ready,
          p2Ready: plinkoPvpMatches.p2Ready,
        })
        .from(plinkoPvpMatches)
        .where(eq(plinkoPvpMatches.id, -1))
        .limit(1);
      return true;
    } catch (err) {
      console.error(
        "[plinko-pvp][SCHEMA-DRIFT] plinko_pvp_matches is missing p1_ready and/or p2_ready columns. " +
          "This is almost always a missing migration. Run migration 0053 " +
          "(src/db/migrations/0053_plinko_pvp_schema_safety_net.sql) to backfill " +
          "the columns. The launch API will refuse to write until the schema is up to date.",
        "Underlying PG error:",
        err && err.message ? err.message : err,
      );
      // Don't poison the cache — the next caller will retry the probe.
      readyColumnsCheck = null;
      return false;
    }
  })();
  readyColumnsCheck = probe;
  const ok = await probe;
  if (ok) {
    // Pin `true` so future calls skip the SELECT entirely.
    readyColumnsCheck = true;
  }
  return ok;
}

// ── Deferred per-seat ready-flag clear ───────────────────────────────
//
// After `resolveBall` advances the match to the next ball we
// briefly leave `p1Ready`/`p2Ready` set to true so the OPPONENT
// client — whose own polling cadence (800 ms) is much slower than
// the server's sub-millisecond `bothReady` flip — gets a window
// during which the match view can render the "Both ready —
// launching!" badge before ball animation starts.
//
// Implementation notes:
//   • The clear is fired via Node's setTimeout AFTER the launching
//     transaction commits. `handle.unref()` keeps the timer from
//     pinning the process alive (best-effort, fire-and-forget).
//   • The deferred query is GUARDED with a CASE WHEN ... IS NULL
//     expression on the per-seat `current_inputs` column so a
//     late-firing timer (serverless cold-start, deploy during
//     clear, network blip) NEVER wipes a seat that has already
//     committed inputs for the next ball. This guard is essential
//     because in serverless / multi-worker deployments the timer
//     may fire on a different Lambda instance than the one that
//     scheduled it and therefore CANNOT be cancelled in-memory
//     from the next `/launch` POST's process. The DB-side guard
//     is the only reliable cross-instance correctness mechanism.
//   • On the FINAL ball we clear the flags inline inside
//     `resolveMatch` (no deferred clear) so the FINISHED row
//     shows chips as NOT READY on the very next poll.
const deferredReadyClears = new Map();

function scheduleDeferredReadyClear(matchId, delayMs = 1500) {
  const handle = setTimeout(async () => {
    deferredReadyClears.delete(matchId);
    try {
      await db
        .update(plinkoPvpMatches)
        .set({
          // Only flip back to false if that seat has NOT yet
          // committed inputs for the next ball (current
          // ball by virtue of resolveBall having cleared them).
          // If the seat has committed, p{N}_ready stays true
          // and the chip keeps looking READY through the new
          // round. SQL-side guarding avoids cross-instance
          // race conditions where the timer outlives the
          // launching transaction in a different Lambda.
          p1Ready: sql`CASE WHEN ${plinkoPvpMatches.p1CurrentInputs} IS NULL THEN false ELSE ${plinkoPvpMatches.p1Ready} END`,
          p2Ready: sql`CASE WHEN ${plinkoPvpMatches.p2CurrentInputs} IS NULL THEN false ELSE ${plinkoPvpMatches.p2Ready} END`,
        })
        .where(eq(plinkoPvpMatches.id, matchId));
    } catch (err) {
      console.warn(
        `[plinko-pvp] deferred ready clear for match ${matchId} failed:`,
        err && err.message ? err.message : err,
      );
    }
  }, delayMs);
  if (typeof handle.unref === "function") handle.unref();
  deferredReadyClears.set(matchId, handle);
}

// Build a `players: { p1: {...}, p2: {...} }` envelope from a list of
// user rows keyed by clerkId. Used by the API routes so the match view
// can show "Alice vs Bob" instead of "user_abcd1234 vs user_efgh5678".
//
// Returns a plain object keyed by `clerkId` → `{ id, displayName,
// profileImageUrl, ... }`. Falls back to a derived flag (`missing: true`)
// if the lookup didn't find a row for that id (defensive — should not
// happen given Clerk auth, but better than a TypeError in the JSON
// response).
function summariseUsers(rows) {
  const out = {};
  for (const r of rows) {
    if (!r || !r.clerkId) continue;
    out[r.clerkId] = {
      id: r.clerkId,
      displayName: r.displayName || r.clerkId,
      profileImageUrl: r.profileImageUrl || null,
    };
  }
  return out;
}

// Enrich a match (or list of matches) with a `players` field derived
// from the `users` table. The match row's `player1Id`/`player2Id` are
// Clerk ids — we look them up and surface displayName + profileImageUrl
// so the client can render proper player heads instead of truncation.
//
// Accepts: one match, or an array of matches, or null/undefined.
// Returns: the same shape, with `players` attached (omitted when no
// caller ever passes player1/player2 ids).
export function attachPlayerNames(matchOrMatches) {
  if (!matchOrMatches) return matchOrMatches;
  const list = Array.isArray(matchOrMatches) ? matchOrMatches : [matchOrMatches];
  if (list.length === 0) return matchOrMatches;
  const ids = new Set();
  for (const m of list) {
    if (!m) continue;
    if (m.player1Id) ids.add(m.player1Id);
    if (m.player2Id) ids.add(m.player2Id);
  }
  if (ids.size === 0) return matchOrMatches;
  // Synchronous-looking wrapper around drizzle's async select — we
  // expose a separate async helper below for the route use site.
  // This sync helper is only used internally after the lookup.
  return { __needsLookup: true, ids: Array.from(ids), list, isArray: Array.isArray(matchOrMatches) };
}

// Async version — does the actual users-table fetch. Routes call this.
export async function enrichMatchesWithUsers(matchOrMatches) {
  if (!matchOrMatches) return matchOrMatches;
  const list = Array.isArray(matchOrMatches) ? matchOrMatches : [matchOrMatches];
  if (list.length === 0) return matchOrMatches;
  const ids = new Set();
  for (const m of list) {
    if (!m) continue;
    if (m.player1Id) ids.add(m.player1Id);
    if (m.player2Id) ids.add(m.player2Id);
  }
  if (ids.size === 0) {
    return Array.isArray(matchOrMatches)
      ? matchOrMatches
      : { ...matchOrMatches, players: null };
  }
  let rows = [];
  try {
    // `users` exposes `name` + `profilePicture` (displayName /
    // profileImageUrl only exist on chatMessages). Output keys stay
    // aliased so summariseUsers + every consumer reading
    // players.p1.displayName keeps working unchanged. Bug fix: the
    // previous query referenced non-existent columns, breaking
    // match-view names AND surfacing a 500 on the "I'm Ready" POST.
    rows = await db
      .select({
        clerkId: users.clerkId,
        displayName: users.name,
        profileImageUrl: users.profilePicture,
      })
      .from(users)
      .where(inArray(users.clerkId, Array.from(ids)));
  } catch (err) {
    // Fall back to no enrichment on lookup error — never let this
    // crash the route. We log so this is visible in server logs.
    console.warn(
      "[plinko-pvp] enrichMatchesWithUsers: users lookup failed:",
      err && err.message ? err.message : err,
    );
    rows = [];
  }
  const summary = summariseUsers(rows);

  const enrichOne = (m) => {
    if (!m) return m;
    const p1 = m.player1Id ? summary[m.player1Id] || null : null;
    const p2 = m.player2Id ? summary[m.player2Id] || null : null;
    return {
      ...m,
      players: {
        p1: p1 || (m.player1Id ? { id: m.player1Id, displayName: m.player1Id, missing: true } : null),
        p2: p2 || (m.player2Id ? { id: m.player2Id, displayName: m.player2Id, missing: true } : null),
      },
    };
  };

  return Array.isArray(matchOrMatches) ? list.map(enrichOne) : enrichOne(matchOrMatches);
}

// Per-row pacing helper: derive the per-ball deadline duration in ms
// from a match row, falling back to the server-side default if the
// column is null/0. Mirrors roulette-pvp's `roundDeadlineMs` so admin
// tooling can override per-match pacing via `round_timer_seconds`
// without code changes.
function roundDeadlineMs(match) {
  const t = Number(match?.roundTimerSeconds);
  if (Number.isFinite(t) && t > 0) return t * 1000;
  return ROUND_DEADLINE_MS;
}

// Stable deterministic hash from numeric stake to a signed 32-bit int.
// Used purely as the second key of the two-key pg_advisory_xact_lock
// for stake-keyed matchmaking. Collisions on distinct stakes would
// only briefly serialise (no correctness risk). Mirrors the helper
// used by mines-pvp / blackjack-pvp / roulette-pvp.
function hashStakeToInt(stake) {
  const fixed = Number(stake).toFixed(2);
  let h = 2166136261; // FNV-1a 32-bit offset basis
  for (let i = 0; i < fixed.length; i += 1) {
    h ^= fixed.charCodeAt(i);
    h = Math.imul(h, 16777619); // FNV-1a 32-bit prime
  }
  return (h | 0) & 0x7fffffff;
}

// Map a 1-based ball number to the canonical match.status enum value.
// Ball 4+ never happens (REQUIRED_BALLS=3) but the helper is defensive
// — returns BALL_3 for any out-of-range input so a future schema bump
// doesn't crash the status machine.
function statusForBallNumber(ballNumber) {
  const n = Math.max(1, Math.min(REQUIRED_BALLS, Number(ballNumber) || 1));
  if (n === 1) return MATCH_STATUS.BALL_1;
  if (n === 2) return MATCH_STATUS.BALL_2;
  return MATCH_STATUS.BALL_3;
}

// Seat label ("player1" | "player2") for a user in a given match row.
// Returns null if the user is not a participant.
export function seatForUser(match, userId) {
  if (!match || !userId) return null;
  if (match.player1Id === userId) return "player1";
  if (match.player2Id === userId) return "player2";
  return null;
}

export function isParticipant(match, userId) {
  return seatForUser(match, userId) !== null;
}

// Validate the host-picked stake at lobby creation time. The match
// has no other player-chosen params (mines-pvp's minesCount is gone).
// Returns `{ ok: true }` on success, `{ ok: false, error }` otherwise.
export function validateMatchParams({ stakeAmount }) {
  const stake = Number(stakeAmount);
  if (!Number.isFinite(stake) || stake < MIN_STAKE || stake > MAX_STAKE) {
    return {
      ok: false,
      error: `Stake must be a number in [${MIN_STAKE}, ${MAX_STAKE}]`,
    };
  }
  return { ok: true };
}

// Deterministic per-(match, ball, seat) seed for the physics simulator.
// Same match + ball number + seat always yields the same trajectory.
// Uses physics.hashSeed (cyrb53 variant) so the seed space is huge
// and collision-resistant across matches.
//
// `variant` distinguishes manual commits ("manual") from AFK
// auto-launches ("auto") so an admin can reproduce either path
// from the match state alone — no XOR magic, no hidden state.
function seedForBall(matchId, ballNumber, seat /* 1 | 2 */, variant = "manual") {
  return hashSeed(`plinko:${matchId}:p${seat}:ball${ballNumber}:${variant}`);
}

// Validate the player-submitted commit inputs. Returns the canonical
// (number, number, number) triple on success, or an error envelope.
// Server-side validation is defence-in-depth — the API route should
// already validate, but a bad value here would silently poison the
// trajectory. Throws early so the upstream bug is caught in dev/test.
function validateLaunchInputs({ startX, power, angleDeg }) {
  const sx = Number(startX);
  const pw = Number(power);
  const ad = Number(angleDeg);
  if (
    !Number.isFinite(sx) ||
    !Number.isFinite(pw) ||
    !Number.isFinite(ad)
  ) {
    return { ok: false, error: "Inputs must be finite numbers", status: 400 };
  }
  if (sx < 0 || sx > 500) {
    return { ok: false, error: "startX must be in [0, 500]", status: 400 };
  }
  if (pw < 0 || pw > 100) {
    return { ok: false, error: "power must be in [0, 100]", status: 400 };
  }
  if (ad < -45 || ad > 45) {
    return { ok: false, error: "angleDeg must be in [-45, 45]", status: 400 };
  }
  return { ok: true, startX: sx, power: pw, angleDeg: ad };
}

// Defensive score sanity check. The simulator is supposed to award
// 0/40/100/140 per ball — anything else is a bug in the bucket
// classifier or the physics module. Throw so a regression is caught
// in dev/test instead of silently corrupting a match result.
function assertBallPoints(playerSeat, ballNumber, points) {
  if (
    !Number.isInteger(points) ||
    points < 0 ||
    points > MAX_BALL_POINTS
  ) {
    throw new RangeError(
      `[plinko-pvp] ${playerSeat} ball ${ballNumber} produced invalid points=${points} (expected integer in [0, ${MAX_BALL_POINTS}])`,
    );
  }
}

// ── Lobby helpers ─────────────────────────────────────────────────────

// Open (waiting) matches for the casino lobby listing. Most recent
// first; `player2Id IS NULL` is the canonical "open" predicate.
export async function listOpenMatches({ limit = 30 } = {}) {
  return db
    .select({
      id: plinkoPvpMatches.id,
      player1Id: plinkoPvpMatches.player1Id,
      stakeAmount: plinkoPvpMatches.stakeAmount,
      createdAt: plinkoPvpMatches.createdAt,
    })
    .from(plinkoPvpMatches)
    .where(
      and(
        eq(plinkoPvpMatches.status, MATCH_STATUS.WAITING),
        isNull(plinkoPvpMatches.player2Id),
      ),
    )
    .orderBy(sql`${plinkoPvpMatches.createdAt} DESC`)
    .limit(limit);
}

// Find the caller's own open (waiting) match so the lobby page can
// surface a "resume + cancel" banner. Returns at most one row (a user
// can only have one open match at a time).
export async function listMyWaitingMatch({ userId }) {
  if (!userId) return [];
  return db
    .select({
      id: plinkoPvpMatches.id,
      player1Id: plinkoPvpMatches.player1Id,
      stakeAmount: plinkoPvpMatches.stakeAmount,
      createdAt: plinkoPvpMatches.createdAt,
    })
    .from(plinkoPvpMatches)
    .where(
      and(
        eq(plinkoPvpMatches.player1Id, userId),
        eq(plinkoPvpMatches.status, MATCH_STATUS.WAITING),
        isNull(plinkoPvpMatches.player2Id),
      ),
    )
    .orderBy(sql`${plinkoPvpMatches.createdAt} DESC`)
    .limit(1);
}

// ── Create / Join matchmaking ─────────────────────────────────────────
//
// Single-transaction stake-keyed matchmaking (mirrors mines-pvp /
// blackjack-pvp / roulette-pvp):
//
//   1. Postgres `pg_advisory_xact_lock` keyed on
//      (PLINKO_PVP_LOCK_NAMESPACE, hash(stake)) serialises every
//      concurrent matchmaker for the same stake across all workers.
//      Without this, two matchmakers calling `createOrJoin`
//      concurrently could both observe "no open match" and both
//      INSERT a fresh waiting row.
//   2. `FOR UPDATE` + re-fetch + conditional UPDATE filtering on
//      `status='waiting' AND player2_id IS NULL` catches the
//      "creator cancelled in parallel" race.
export async function createOrJoin({ userId, stakeAmount }) {
  const validation = validateMatchParams({ stakeAmount });
  if (!validation.ok) {
    return { error: validation.error, status: 400 };
  }

  const lockKey = hashStakeToInt(stakeAmount);

  return await db.transaction(async (tx) => {
    // Acquire stake-keyed advisory lock; auto-released on commit/rollback.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${PLINKO_PVP_LOCK_NAMESPACE}, ${lockKey})`,
    );

    // 1) Look for an existing open match with matching stake.
    const [openMatch] = await tx
      .select()
      .from(plinkoPvpMatches)
      .where(
        and(
          eq(plinkoPvpMatches.status, MATCH_STATUS.WAITING),
          isNull(plinkoPvpMatches.player2Id),
          eq(plinkoPvpMatches.stakeAmount, Number(stakeAmount).toFixed(2)),
        ),
      )
      .orderBy(sql`${plinkoPvpMatches.createdAt} ASC`)
      .limit(1)
      .for("update");

    if (openMatch) {
      if (openMatch.player1Id === userId) {
        // Caller's own existing lobby — just return it.
        return { match: openMatch, joined: false };
      }
      return await joinExistingMatch(tx, openMatch.id, userId, stakeAmount);
    }

    // 2) No open match — create a fresh waiting match.
    return await createWaitingMatch(tx, userId, stakeAmount);
  });
}

async function createWaitingMatch(tx, userId, stakeAmount) {
  // Deduct creator stake (atomic: only if balance is sufficient).
  const [creator] = await tx
    .update(users)
    .set({ balance: sql`${users.balance} - ${stakeAmount}` })
    .where(
      and(
        eq(users.clerkId, userId),
        sql`${users.balance} >= ${stakeAmount}`,
      ),
    )
    .returning({ balance: users.balance });

  if (!creator) {
    return { error: "Insufficient balance", status: 400 };
  }

  const [match] = await tx
    .insert(plinkoPvpMatches)
    .values({
      player1Id: userId,
      stakeAmount: Number(stakeAmount).toFixed(2),
      status: MATCH_STATUS.WAITING,
      currentBall: 1,
      p1Score: 0,
      p2Score: 0,
      p1CurrentInputs: null,
      p2CurrentInputs: null,
      roundTimerSeconds: ROUND_TIMER_SECONDS,
      houseFee: "0.00",
      prizePaid: "0.00",
      startedAt: null,
    })
    .returning();

  // Fire system notification for large PvP create stakes.
  if (Number(stakeAmount) >= 1000) {
    sendSystemNotificationEmail({
      eventType: "bet_placed",
      description: `User ${userId} created plinko PvP lobby (${stakeAmount} stake).`,
      metadata: { userId, stakeAmount, matchId: match.id },
    }).catch(() => {});
  }

  return { match, joined: false };
}

async function joinExistingMatch(tx, candidateId, userId, stakeAmount) {
  // Re-fetch the candidate row INSIDE the same transaction with
  // FOR UPDATE so a parallel /cancel that committed first can't leave
  // us updating a row that's already cancelled.
  const [match] = await tx
    .select()
    .from(plinkoPvpMatches)
    .where(eq(plinkoPvpMatches.id, candidateId))
    .for("update");

  if (!match || match.status !== MATCH_STATUS.WAITING || match.player2Id) {
    return { error: "Lobby no longer available", status: 409 };
  }

  // Deduct joiner's stake (atomic: only if balance is sufficient).
  const [joiner] = await tx
    .update(users)
    .set({ balance: sql`${users.balance} - ${stakeAmount}` })
    .where(
      and(
        eq(users.clerkId, userId),
        sql`${users.balance} >= ${stakeAmount}`,
      ),
    )
    .returning({ balance: users.balance });

  if (!joiner) {
    return { error: "Insufficient balance", status: 400 };
  }

  // Brief 3-second "Ready" window so both players can read the
  // match-found banner before ball_1's 20-second commit window
  // opens. /status auto-advances to ball_1 once the deadline passes
  // (see advanceFromReady).
  const readyDeadline = new Date(Date.now() + READY_WINDOW_MS);

  const [updated] = await tx
    .update(plinkoPvpMatches)
    .set({
      player2Id: userId,
      status: MATCH_STATUS.READY,
      currentBall: 1,
      roundDeadline: readyDeadline,
      startedAt: new Date(),
    })
    .where(
      and(
        eq(plinkoPvpMatches.id, candidateId),
        // Defensive guard: only update if status is still `waiting`
        // and player2Id is still null when we commit.
        eq(plinkoPvpMatches.status, MATCH_STATUS.WAITING),
        isNull(plinkoPvpMatches.player2Id),
      ),
    )
    .returning();

  // If our conditional UPDATE didn't match any rows (because another
  // concurrent joiner raced us), refund joiner stake.
  if (!updated) {
    await tx
      .update(users)
      .set({ balance: sql`${users.balance} + ${stakeAmount}` })
      .where(eq(users.clerkId, userId));
    return { error: "Lobby no longer available", status: 409 };
  }

  return { match: updated, joined: true };
}

// ── Auto-advance ready → ball_1 ───────────────────────────────────────
//
// Fires from fetchMatchWithAutoResolve when the 3-second ready window
// elapses. Sets `status` to `ball_1` and opens the first 20-second
// commit window. Both players' current inputs are reset to null
// (in case a stale read left them set somehow).
async function advanceFromReady(tx, match) {
  const deadline = new Date(Date.now() + roundDeadlineMs(match));

  await tx
    .update(plinkoPvpMatches)
    .set({
      status: MATCH_STATUS.BALL_1,
      currentBall: 1,
      roundDeadline: deadline,
      p1CurrentInputs: null,
      p2CurrentInputs: null,
    })
    .where(
      and(
        eq(plinkoPvpMatches.id, match.id),
        eq(plinkoPvpMatches.status, MATCH_STATUS.READY),
      ),
    );

  const [refreshed] = await tx
    .select()
    .from(plinkoPvpMatches)
    .where(eq(plinkoPvpMatches.id, match.id));
  return refreshed || match;
}

// ── Cancel (creator only, while in waiting) ───────────────────────────

export async function cancelMatch({ userId, matchId }) {
  return await db.transaction(async (tx) => {
    const [match] = await tx
      .select()
      .from(plinkoPvpMatches)
      .where(eq(plinkoPvpMatches.id, matchId))
      .for("update");

    if (!match) return { error: "Match not found", status: 404 };
    if (match.status !== MATCH_STATUS.WAITING) {
      return {
        error: "Match cannot be cancelled after opponent joins",
        status: 400,
      };
    }
    if (match.player1Id !== userId) {
      return { error: "Only the creator can cancel", status: 403 };
    }

    // Refund creator stake.
    await tx
      .update(users)
      .set({
        balance: sql`${users.balance} + ${Number(match.stakeAmount)}`,
      })
      .where(eq(users.clerkId, userId));

    const [updated] = await tx
      .update(plinkoPvpMatches)
      .set({
        status: MATCH_STATUS.CANCELLED,
        endedAt: new Date(),
      })
      .where(eq(plinkoPvpMatches.id, matchId))
      .returning();

    return { match: updated };
  });
}

// ── Match fetch with row lock (for atomic operations) ─────────────────

async function fetchMatchForUpdate(tx, matchId) {
  const [match] = await tx
    .select()
    .from(plinkoPvpMatches)
    .where(eq(plinkoPvpMatches.id, matchId))
    .for("update");
  return match;
}

// ── resolveBall (private) ─────────────────────────────────────────────
//
// Persists the just-played ball: inserts a plinko_pvp_rounds history
// row, increments the cumulative match-level p1Score / p2Score, and
// advances the match to ball_(N+1) (or calls resolveMatch if this
// was the final ball).
//
// Both p1CurrentInputs and p2CurrentInputs MUST be populated before
// this is called. The caller is responsible for that — the only
// callers are launchBall (right after a manual commit fills the
// last gap) and forceBallAdvance (right after auto-launching the
// missing player(s)).
async function resolveBall(tx, match) {
  const ballNumber = Number(match.currentBall) || 1;
  if (ballNumber < 1 || ballNumber > REQUIRED_BALLS) {
    // Defensive: should never fire (LAUNCHABLE_STATES guards upstream).
    return match;
  }
  if (!match.p1CurrentInputs || !match.p2CurrentInputs) {
    // Defensive: both seats must be in before resolveBall runs.
    return match;
  }

  const p1 = match.p1CurrentInputs;
  const p2 = match.p2CurrentInputs;

  // Sanity-check the per-ball points. The simulator is supposed to
  // award 0/40/100/140 — anything else is a bug we want to surface
  // loudly rather than silently write a corrupt score.
  assertBallPoints("p1", ballNumber, Number(p1?.result?.points) || 0);
  assertBallPoints("p2", ballNumber, Number(p2?.result?.points) || 0);

  const ballPointsPlayer1 = Number(p1.result.points);
  const ballPointsPlayer2 = Number(p2.result.points);

  // Decide the per-ball outcome for the history row. Ties are awarded
  // when both players scored the same (e.g. both fell out, or both
  // landed in the same-point bucket).
  let ballOutcome;
  if (ballPointsPlayer1 > ballPointsPlayer2) ballOutcome = BALL_OUTCOME.P1;
  else if (ballPointsPlayer2 > ballPointsPlayer1) ballOutcome = BALL_OUTCOME.P2;
  else ballOutcome = BALL_OUTCOME.TIE;

  // Persist the per-ball history snapshot BEFORE we mutate the match
  // row, so the history always reflects the ball's final state. The
  // jsonb columns capture both the raw inputs and the simulation
  // summary (finalX / finalY / fellOut / bucketIndex / points / path)
  // so the match view can replay the ball animation directly from
  // this row without re-simulating.
  await tx.insert(plinkoPvpRounds).values({
    matchId: match.id,
    ballNumber,
    // Raw inputs (what the player committed).
    player1Inputs: {
      startX: p1.startX,
      power: p1.power,
      angleDeg: p1.angleDeg,
    },
    player2Inputs: {
      startX: p2.startX,
      power: p2.power,
      angleDeg: p2.angleDeg,
    },
    // Full simulation result (so the client can render the path).
    player1Result: p1.result,
    player2Result: p2.result,
    player1AutoLaunched: Boolean(p1.autoLaunched),
    player2AutoLaunched: Boolean(p2.autoLaunched),
    ballPointsPlayer1,
    ballPointsPlayer2,
    ballOutcome,
  });

  // Cumulative match-level scores (sum of per-ball points).
  const newScoreP1 = (Number(match.p1Score) || 0) + ballPointsPlayer1;
  const newScoreP2 = (Number(match.p2Score) || 0) + ballPointsPlayer2;

  // Decide next status / round. If this was the final ball, the
  // match resolves (90/10 payout + finished state). Otherwise we
  // advance to ball_(N+1) with a fresh 20-second commit window.
  // The 3-second "Ball X incoming" countdown is purely client-side —
  // the server hands them a 20s window immediately and the UI
  // reserves ~3s for the transition overlay.
  if (ballNumber >= REQUIRED_BALLS) {
    // Final ball — wipe per-ball inputs and let `resolveMatch`
    // explicitly clear p1Ready/p2Ready in its setValues so the
    // FINISHED match row shows chips as NOT READY on the very
    // next poll. The deferred clear path is intentionally NOT
    // used for the final ball — the match is over and there is
    // no point preserving the ready state.
    return await resolveMatch(tx, {
      ...match,
      p1Score: newScoreP1,
      p2Score: newScoreP2,
      p1CurrentInputs: null,
      p2CurrentInputs: null,
    });
  }

  const nextBall = ballNumber + 1;
  const nextDeadline = new Date(Date.now() + roundDeadlineMs(match));
  const [updated] = await tx
    .update(plinkoPvpMatches)
    .set({
      status: statusForBallNumber(nextBall),
      currentBall: nextBall,
      p1Score: newScoreP1,
      p2Score: newScoreP2,    // Clear per-ball inputs so the next ball's commits start fresh.
    //
    // ⚠️ DELIBERATELY preserve p1Ready/p2Ready=true here so the
    // OPPONENT client's polling cadence has a brief window to
    // surface the "Both ready — launching!" badge before the
    // deferred clear scheduled by `scheduleDeferredReadyClear`
    // (fire-and-forget, ~1500 ms) wipes them. The deferred
    // UPDATE has a SQL guard so it never tampers with a seat
    // that has already committed for the new ball — see the
    // helper's comment block for the full rationale.
    p1CurrentInputs: null,
    p2CurrentInputs: null,
    roundDeadline: nextDeadline,
  })
  .where(eq(plinkoPvpMatches.id, match.id))
  .returning();

  return updated || match;
}

// ── launchBall (the main commit action) ───────────────────────────────
//
// Server-side authoritative commit. The player posts their (startX,
// power, angleDeg) and the server:
//   1. Validates the inputs
//   2. Generates a deterministic seed via hashSeed
//   3. Runs the physics simulator (single-ball) and stores the full
//      result on `p{N}CurrentInputs` (startX/power/angleDeg +
//      autoLaunched + seed + simulation result including path)
//   4. Flips p{N}Ready = true on the same row
//   5. If BOTH p1Ready AND p2Ready (the new "both-clicked-Ready"
//      gate), RUNEVERYTHING with simulateDualBalls so the two balls
//      can knock each other off course, overwrite both p{N}CurrentInputs
//      with the collision-aware paths, and call resolveBall.
//
// One-shot lock-in: once a player has committed for a given ball,
// resubmitting returns 409. This matches roulette-pvp's anti-cheat
// pattern (a player cannot rewrite their bets at the last
// millisecond to scrub the result) and is the secure default.
export async function launchBall({ userId, matchId, startX, power, angleDeg }) {
  const validation = validateLaunchInputs({ startX, power, angleDeg });
  if (!validation.ok) {
    return { error: validation.error, status: validation.status };
  }

  // Schema self-check. If p1_ready / p2_ready are missing from the live
  // DB (migration 0052 was rejected on Neon in an earlier form and may
  // never have been re-applied) we short-circuit with a clear 503 so
  // the route can surface "Run migration 0053" instead of a silent 500.
  const schemaOk = await ensurePlinkoReadyColumns();
  if (!schemaOk) {
    return {
      error:
        "Plinko Duel schema is outdated: the p1_ready / p2_ready columns are missing. " +
        "Run migration 0053 (npm run db:migrate) to backfill the columns, then retry.",
      status: 503,
      code: "MIGRATION_INCOMPLETE",
    };
  }

  return await db.transaction(async (tx) => {
    const match = await fetchMatchForUpdate(tx, matchId);

    if (!match) return { error: "Match not found", status: 404 };
    if (!isParticipant(match, userId)) {
      return { error: "Forbidden", status: 403 };
    }
    if (!LAUNCHABLE_STATES.has(match.status)) {
      return {
        error: "Match is not awaiting a ball launch",
        status: 400,
      };
    }

    // Stale-deadline guard: if the commit window has elapsed, reject
    // the manual commit. The next /status poll will trigger the AFK
    // auto-launch via fetchMatchWithAutoResolve.
    if (
      match.roundDeadline &&
      new Date(match.roundDeadline).getTime() <= Date.now()
    ) {
      return { error: "Ball commit window has expired", status: 400 };
    }

    const seat = seatForUser(match, userId); // "player1" | "player2"
    const seatNumber = seat === "player1" ? 1 : 2;

    // One-shot lock-in: if the player has already committed for this
    // ball, reject. The client UI's "launched" flag is mirrored here
    // server-side so a malicious client can't rewrite its commit at
    // the last millisecond to scrub the result.
    if (
      (seat === "player1" && match.p1CurrentInputs) ||
      (seat === "player2" && match.p2CurrentInputs) ||
      (!seat && (match.p1CurrentInputs || match.p2CurrentInputs))
    ) {
      return {
        error: "Already launched for this ball",
        status: 409,
      };
    }

    // Deterministic seed: same matchId + ballNumber + seat → same
    // trajectory. Lets an admin replay a match's exact ball paths
    // for audit / dispute resolution.
    const ballNumber = Number(match.currentBall) || 1;
    const seed = seedForBall(match.id, ballNumber, seatNumber);

    // Pipe the inputs through the deterministic single-ball
    // simulator. This gives the caller an immediate view of THEIR
    // ball animation; if the opponent hasn't readied up yet we
    // store this pre-computation so /status can surface it too.
    // When BOTH are ready we'll re-simulate as a pair via
    // simulateDualBalls and overwrite the single-ball result with
    // the collision-aware path.
    const result = simulateBall({
      startX: validation.startX,
      power: validation.power,
      angleDeg: validation.angleDeg,
      seed,
    });

    // Persist the commit + flip the per-seat ready flag.
    const payload = {
      startX: validation.startX,
      power: validation.power,
      angleDeg: validation.angleDeg,
      autoLaunched: false,
      seed,
      result: {
        path: result.path,
        fellOut: result.fellOut,
        finalX: result.finalX,
        finalY: result.finalY,
        bucketIndex: result.bucketIndex,
        points: result.points,
      },
    };

    // Persist the commit + flip the per-seat ready flag.
    //
    // BUG-FIX: an earlier revision used computed-property-name
    // setters (`{ [currentInputsCol]: payload, [readyCol]: true }`).
    // JavaScript resolves those to `{ p{N}CurrentInputs: ...,
    // p{N}Ready: ... }` at object-construction time so Drizzle
    // resolves the column correctly at runtime — BUT the resulting
    // object loses TypeScript type narrowing for the jsonb column,
    // and under jsonb-serialization edge cases (composite connection
    // retries, drizzle's jsonb type inference) the resulting
    // parameter binding can send `null` for the jsonb column when
    // the seed-bearing nested object is briefly replaced. We branch
    // explicitly on seat so each UPDATE uses statically-typed
    // column references whose jsonb binding is unambiguous per
    // Drizzle's type system.
    const updateWhere = and(
      eq(plinkoPvpMatches.id, matchId),
      eq(plinkoPvpMatches.status, match.status),
      // Defense-in-depth: also gate on `currentBall` so a
      // concurrent forceBallAdvance that advanced to ball_(N+1)
      // can't lose a stale manual commit at ball_N. The
      // in-memory "already committed" check after FOR UPDATE is
      // the primary guard; this clause is belt-and-suspenders
      // against future schema changes that let currentBall
      // advance independently of status.
      eq(plinkoPvpMatches.currentBall, match.currentBall),
    );
    // Staleness-clear over the OPPOSITE seat.
    //
    // If BOTH `p{N}_current_inputs` columns are null at the time
    // of this commit, we are committing for a freshly-resolved
    // ball — `resolveBall` cleared the previous round's inputs in
    // the same transaction AND deliberately preserved
    // `p{N}_ready=true` (so the OPPONENT client's polling cadence
    // can render the "Both ready — launching!" badge during a
    // brief grace window before the deferred clear fires).
    //
    // That preserved flag for the OPPOSITE seat is now STALE for
    // the new ball — explicitly clear it on the first commit of
    // the new round so it doesn't carry over as a phantom READY
    // chip while the OPPOSITE player hasn't yet committed. Mid-
    // round (any seat already has a current ball commit) we must
    // NOT touch the OPPOSITE seat's flag — they're legitimately
    // still READY for THIS ball and we mustn't strand them on a
    // "NOT READY" chip just because we changed the round state.
    const isStartOfNewBall =
      !match.p1CurrentInputs && !match.p2CurrentInputs;
    const setValues = seat === "player2"
      ? {
          p2CurrentInputs: payload,
          p2Ready: true,
          ...(isStartOfNewBall ? { p1Ready: false } : {}),
        }
      : {
          p1CurrentInputs: payload,
          p1Ready: true,
          ...(isStartOfNewBall ? { p2Ready: false } : {}),
        };
    const [updated] = await tx
      .update(plinkoPvpMatches)
      .set(setValues)
      .where(updateWhere)
      .returning();

    if (!updated) {
      // Lost a race to a concurrent commit (same player, different
      // tab). Refetch so the caller can retry against fresh state.
      const [refreshed] = await tx
        .select()
        .from(plinkoPvpMatches)
        .where(eq(plinkoPvpMatches.id, matchId));
      return { match: refreshed, raced: true };
    }

    // Both seats are in + both readied up → re-simulate as a pair
    // so balls can interact, overwrite results on the match row,
    // then resolve the ball immediately. (When only one seat is
    // ready we keep the single-ball result and wait for /status.)
    const bothReady = Boolean(updated.p1Ready && updated.p2Ready);
    let resolvedRow = updated;

    if (bothReady) {
      // Re-simulate with collision so both balls reflect each other.
      const p1Inputs = updated.p1CurrentInputs;
      const p2Inputs = updated.p2CurrentInputs;
      const dual = simulateDualBalls(
        {
          startX: p1Inputs.startX,
          power: p1Inputs.power,
          angleDeg: p1Inputs.angleDeg,
          seed: p1Inputs.seed,
        },
        {
          startX: p2Inputs.startX,
          power: p2Inputs.power,
          angleDeg: p2Inputs.angleDeg,
          seed: p2Inputs.seed,
        },
      );

      // Sanity-check the dual-sim points individually before
      // overwriting the cached results.
      assertBallPoints("p1", ballNumber, dual.result1.points || 0);
      assertBallPoints("p2", ballNumber, dual.result2.points || 0);

      // Overwrite the per-seat cached results with the
      // collision-aware ones. The single-ball pre-compute from
      // above is discarded — simulateDualBalls is the canonical
      // trajectory once both seats are in.
      const newP1 = {
        ...p1Inputs,
        result: {
          path: dual.result1.path,
          fellOut: dual.result1.fellOut,
          finalX: dual.result1.finalX,
          finalY: dual.result1.finalY,
          bucketIndex: dual.result1.bucketIndex,
          points: dual.result1.points,
        },
      };
      const newP2 = {
        ...p2Inputs,
        result: {
          path: dual.result2.path,
          fellOut: dual.result2.fellOut,
          finalX: dual.result2.finalX,
          finalY: dual.result2.finalY,
          bucketIndex: dual.result2.bucketIndex,
          points: dual.result2.points,
        },
      };

      const [dualSaved] = await tx
        .update(plinkoPvpMatches)
        .set({ p1CurrentInputs: newP1, p2CurrentInputs: newP2 })
        .where(eq(plinkoPvpMatches.id, matchId))
        .returning();

      resolvedRow = dualSaved || updated;
      resolvedRow = await resolveBall(tx, resolvedRow);
    }

    // Determine if THIS POST was the one that flipped the round
    // from "not-yet-resolved" to "resolved". Use the resolved row's
    // p1CurrentInputs / round_round as the source of truth.
    const wasJustResolved = bothReady;
    return {
      match: resolvedRow,
      p1Result: resolvedRow.p1CurrentInputs?.result ?? null,
      p2Result: resolvedRow.p2CurrentInputs?.result ?? null,
      // myResult is the caller's view of their own ball. When both
      // readied up we serve the collision-aware result for the
      // caller's seat; otherwise the pre-compute from
      // simulateBall above (no collision detected yet).
      myResult: wasJustResolved
        ? seat === "player1"
          ? resolvedRow.p1CurrentInputs?.result ?? result
          : resolvedRow.p2CurrentInputs?.result ?? result
        : result,
      justResolved: wasJustResolved,
    };
  }).then((result) => {
    // Post-commit: schedule a brief deferred clear of the
    // per-seat ready flags so the OPPONENT client's 800 ms
    // polling cadence has a brief window to render the "Both
    // ready — launching!" badge before the flags wipe. Only
    // schedule on a NON-FINAL ball — the final ball is handled
    // directly by resolveMatch (clears in setValues) and the
    // match is over, so there's no point preserving the ready
    // state. `requiredBalls` is the constant cap and the SQL
    // guard in scheduleDeferredReadyClear ensures correctness
    // even if the timer fires on a different serverless instance
    // than the one that scheduled it (see helper comment block).
    if (result?.justResolved && (result.match?.currentBall ?? 0) < REQUIRED_BALLS) {
      scheduleDeferredReadyClear(matchId, 1500);
    }
    return result;
  });
}

// ── forceBallAdvance (private, called from fetchMatchWithAutoResolve) ──
//
// Server-side "AFK nudge": if the per-ball commit window has elapsed
// and either player hasn't committed, auto-launch the missing player(s)
// with `autoLaunchInputs({ seed: hashSeed(...) })`, then resolve the
// ball exactly as if both had committed manually.
//
// The auto-launched inputs use a SEPARATE seed namespace from the
// manual-commit path so an admin can distinguish AFK balls from
// real ones in the round history.
async function forceBallAdvance(tx, match) {
  if (!LAUNCHABLE_STATES.has(match.status)) return match;
  if (!match.roundDeadline) return match;
  if (new Date(match.roundDeadline).getTime() > Date.now()) return match;

  const ballNumber = Number(match.currentBall) || 1;
  const updates = {};

  // p1 missing → auto-launch. The "auto" variant produces a
  // different (deterministic) seed than a manual commit at the
  // same (matchId, ballNumber, seat) so an admin can reproduce
  // either path from the match state alone.
  if (!match.p1CurrentInputs) {
    const afkSeed = seedForBall(match.id, ballNumber, 1, "auto");
    const inputs = autoLaunchInputs({ seed: afkSeed });
    const result = simulateBall({ ...inputs, seed: afkSeed });
    updates.p1CurrentInputs = {
      startX: inputs.startX,
      power: inputs.power,
      angleDeg: inputs.angleDeg,
      autoLaunched: true,
      seed: afkSeed,
      result: {
        path: result.path,
        fellOut: result.fellOut,
        finalX: result.finalX,
        finalY: result.finalY,
        bucketIndex: result.bucketIndex,
        points: result.points,
      },
    };
    updates.p1Ready = true;
  }

  // p2 missing → auto-launch.
  if (!match.p2CurrentInputs) {
    const afkSeed = seedForBall(match.id, ballNumber, 2, "auto");
    const inputs = autoLaunchInputs({ seed: afkSeed });
    const result = simulateBall({ ...inputs, seed: afkSeed });
    updates.p2CurrentInputs = {
      startX: inputs.startX,
      power: inputs.power,
      angleDeg: inputs.angleDeg,
      autoLaunched: true,
      seed: afkSeed,
      result: {
        path: result.path,
        fellOut: result.fellOut,
        finalX: result.finalX,
        finalY: result.finalY,
        bucketIndex: result.bucketIndex,
        points: result.points,
      },
    };
    updates.p2Ready = true;
  }

  // Conditional UPDATE: only fire if the row is still in the same
  // status and ball. A concurrent manual commit that arrived in
  // the same window will have either landed or been rejected; if
  // it landed, the missing-side check above will see the commit
  // and skip the auto-launch for that side.
  const [updated] = await tx
    .update(plinkoPvpMatches)
    .set(updates)
    .where(
      and(
        eq(plinkoPvpMatches.id, match.id),
        eq(plinkoPvpMatches.status, match.status),
        eq(plinkoPvpMatches.currentBall, match.currentBall),
      ),
    )
    .returning();

  const effective = updated || match;

  // Both seats are now guaranteed to be in (we just filled any
  // gaps). To honour the user spec ("balls should knock each other
  // out when connecting together") we re-run simulateDualBalls to
  // recompute both paths with ball-ball collision physics, even if
  // one or both seats were AFK-launched. This overwrites whatever
  // single-ball paths were pre-computed (manually or via autoLaunch)
  // with the collision-aware canonical paths that the rounds row
  // persists. launchBall already does this on the manual-both-ready
  // path; we mirror the behaviour here so AFK balls still knock.
  if (effective.p1CurrentInputs && effective.p2CurrentInputs) {
    const p1 = effective.p1CurrentInputs;
    const p2 = effective.p2CurrentInputs;
    const dual = simulateDualBalls(
      {
        startX: p1.startX,
        power: p1.power,
        angleDeg: p1.angleDeg,
        seed: p1.seed,
      },
      {
        startX: p2.startX,
        power: p2.power,
        angleDeg: p2.angleDeg,
        seed: p2.seed,
      },
    );
    // Sanity-check before persisting (mirrors launchBall).
    assertBallPoints("p1", ballNumber, dual.result1.points || 0);
    assertBallPoints("p2", ballNumber, dual.result2.points || 0);

    const dualPayload = {
      p1CurrentInputs: {
        ...p1,
        result: {
          path: dual.result1.path,
          fellOut: dual.result1.fellOut,
          finalX: dual.result1.finalX,
          finalY: dual.result1.finalY,
          bucketIndex: dual.result1.bucketIndex,
          points: dual.result1.points,
        },
      },
      p2CurrentInputs: {
        ...p2,
        result: {
          path: dual.result2.path,
          fellOut: dual.result2.fellOut,
          finalX: dual.result2.finalX,
          finalY: dual.result2.finalY,
          bucketIndex: dual.result2.bucketIndex,
          points: dual.result2.points,
        },
      },
    };

    const [dualSaved] = await tx
      .update(plinkoPvpMatches)
      .set(dualPayload)
      .where(eq(plinkoPvpMatches.id, match.id))
      .returning();

    const withDual = dualSaved || effective;
    return await resolveBall(tx, withDual);
  }
  return effective;
}

// ── resolveMatch (private, ball_3 → finished) ─────────────────────────
//
// End-state: both players' 3 balls are in, the cumulative scores are
// known, decide the winner per computePayout, credit / refund per the
// 90/10 split, and stamp the match as `finished`.
//
// Per user spec:
//   p1Score > p2Score → PLAYER1 wins, gets 1.9× stake back, p2 loses stake
//   p1Score < p2Score → PLAYER2 wins, gets 1.9× stake back, p1 loses stake
//   p1Score == p2Score → TIE, both refunded in full, no house fee
async function resolveMatch(tx, match) {
  const p1Score = Number(match.p1Score) || 0;
  const p2Score = Number(match.p2Score) || 0;

  const payout = computePayout({
    stakeAmount: match.stakeAmount,
    p1Score,
    p2Score,
  });

  // Apply balance changes per the payout math. Ties refund both
  // players in full (no fee). Winner gets (stake + 0.9 × stake) =
  // 1.9× their stake back. Loser loses their stake (handled by the
  // deduction at lobby create/join time — we don't double-deduct).
  let winnerUserId = null;
  if (payout.result === RESULT.PLAYER1) {
    winnerUserId = match.player1Id;
    await tx
      .update(users)
      .set({ balance: sql`${users.balance} + ${payout.winnerNet}` })
      .where(eq(users.clerkId, match.player1Id));
  } else if (payout.result === RESULT.PLAYER2) {
    winnerUserId = match.player2Id;
    await tx
      .update(users)
      .set({ balance: sql`${users.balance} + ${payout.winnerNet}` })
      .where(eq(users.clerkId, match.player2Id));
  } else {
    // TIE — refund both players in full, no house fee.
    await tx
      .update(users)
      .set({
        balance: sql`${users.balance} + ${Number(match.stakeAmount)}`,
      })
      .where(eq(users.clerkId, match.player1Id));
    await tx
      .update(users)
      .set({
        balance: sql`${users.balance} + ${Number(match.stakeAmount)}`,
      })
      .where(eq(users.clerkId, match.player2Id));
  }

  // Stamp the match as finished. `result` uses the long form
  // ('player1' | 'player2' | 'tie') to match the schema's
  // `plinko_pvp_matches.result` varchar(20) column.
  const setValues = {
    status: MATCH_STATUS.FINISHED,
    currentBall: REQUIRED_BALLS, // freeze the round counter at 3
    p1CurrentInputs: null,
    p2CurrentInputs: null,
    // Explicitly clear the per-seat ready flags on the FINAL
    // ball so the FINISHED row lands as `p1Ready=false,
    // p2Ready=false` immediately on commit. The deferred clear
    // path is for non-final balls only — see comments on
    // `resolveBall` and `scheduleDeferredReadyClear`.
    p1Ready: false,
    p2Ready: false,
    roundDeadline: null,
    result: payout.result,
    houseFee: round2(payout.houseFee).toFixed(2),
    prizePaid: round2(payout.prizePaid).toFixed(2),
    endedAt: new Date(),
  };
  if (winnerUserId !== null) setValues.winnerId = winnerUserId;

  const [updated] = await tx
    .update(plinkoPvpMatches)
    .set(setValues)
    .where(eq(plinkoPvpMatches.id, match.id))
    .returning();

  const finalRow = updated || match;

  // Best-effort stat side-effects (failures don't roll the match).
  // Bumps pvpWins / gamesWon / totalWon / biggestWin on the winner
  // and gamesLost / totalWagered on the loser. Mirrors mines-pvp's
  // `recordPvPResult` so the global PvP leaderboards stay fresh.
  if (payout.result === RESULT.PLAYER1 || payout.result === RESULT.PLAYER2) {
    await recordPvPResult(tx, finalRow, winnerUserId, payout.result).catch(
      () => {},
    );
  }

  return finalRow;
}

// Best-effort stat side-effect — mirrors mines-pvp / blackjack-pvp /
// roulette-pvp. Bumps pvpWins / gamesWon / totalWon / biggestWin on
// the winner and gamesLost / totalWagered on the loser so the
// global PvP leaderboards stay fresh without re-running aggregate
// queries on every match.
async function recordPvPResult(tx, match, winnerId, result) {
  const loserId =
    result === RESULT.PLAYER1 ? match.player2Id : match.player1Id;
  if (!winnerId || !loserId) return;

  await tx
    .update(users)
    .set({ pvpWins: sql`${users.pvpWins} + 1` })
    .where(eq(users.clerkId, winnerId));
  await tx
    .update(users)
    .set({
      gamesWon: sql`${users.gamesWon} + 1`,
      totalWon: sql`${users.totalWon} + ${Number(match.prizePaid) || 0}`,
      biggestWin:
        Number(match.prizePaid) > 0
          ? sql`GREATEST(${users.biggestWin}, ${Number(match.prizePaid)})`
          : sql`${users.biggestWin}`,
    })
    .where(eq(users.clerkId, winnerId));
  await tx
    .update(users)
    .set({
      gamesLost: sql`${users.gamesLost} + 1`,
      totalWagered: sql`${users.totalWagered} + ${Number(match.stakeAmount)}`,
    })
    .where(eq(users.clerkId, loserId));
}

// ── Status fetch with auto-resolve ────────────────────────────────────
//
// Single source of forward progress for the client polling loop.
// Handles three auto-advance paths:
//
//   1. `ready` deadline elapsed → advance to ball_1 (3s banner).
//   2. Per-ball deadline elapsed + at least one seat uncommitted →
//      auto-launch the missing seat(s) and resolve the ball.
//   3. Both seats committed (already handled inside launchBall) —
//      this path just no-ops because the ball is already resolved.
//
// The path also returns the freshly-updated match row so the client
// can render the new state without an extra /status round-trip.
export async function fetchMatchWithAutoResolve(userId, matchId) {
  return await db.transaction(async (tx) => {
    const match = await fetchMatchForUpdate(tx, matchId);
    if (!match) return { error: "Match not found", status: 404 };
    if (!isParticipant(match, userId)) {
      return { error: "Forbidden", status: 403 };
    }

    // 1) Auto-advance the brief Ready window into ball_1.
    if (
      match.status === MATCH_STATUS.READY &&
      match.roundDeadline &&
      new Date(match.roundDeadline).getTime() <= Date.now()
    ) {
      const advanced = await advanceFromReady(tx, match);
      // No ball resolved here — just transitioned `ready → ball_1`,
      // so the routine-state automatic advance never preserves the
      // ready flag (p{N}_ready is already false in this state). No
      // deferred clear is needed for this path.
      return { match: advanced, autoResolvedBall: false };
    }

    // 2) Per-ball AFK auto-launch. Fires when the ball's 20-second
    //    deadline has elapsed and one or both seats are still
    //    uncommitted. forceBallAdvance fills the gaps and resolves
    //    the ball.
    if (
      LAUNCHABLE_STATES.has(match.status) &&
      match.roundDeadline &&
      new Date(match.roundDeadline).getTime() <= Date.now() &&
      (!match.p1CurrentInputs || !match.p2CurrentInputs)
    ) {
      const resolved = await forceBallAdvance(tx, match);
      // forceBallAdvance auto-launched any missing seats so both
      // seats are now READY + committed, which then drove
      // resolveBall to advance the match to `ball_(N+1)` while
      // preserving `p{N}_ready=true` for the brief grace window.
      // Schedule a deferred clear so the OPPONENT client (whose
      // own poll cadence may have missed the sub-millisecond
      // bothReady flip) gets to render the "Both ready —
      // launching!" badge. The SQL guard on the deferred query
      // prevents late firing from clobbering a real commit.
      return { match: resolved, autoResolvedBall: true };
    }

    return { match, autoResolvedBall: false };
  }).then((result) => {
    // Post-commit: schedule a brief deferred clear of the
    // per-seat ready flags so the OPPONENT client's 800 ms polling
    // cadence has a brief window to render the "Both ready —
    // launching!" badge before the flags wipe. Mirrors the post-
    // commit scheduling in launchBall. Only schedule on a NON-
    // FINAL ball; the final ball is cleared inline by resolveMatch.
    if (result?.autoResolvedBall && (result.match?.currentBall ?? 0) < REQUIRED_BALLS) {
      scheduleDeferredReadyClear(matchId, 1500);
    }
    return result;
  });
}

// ── Round history fetch ───────────────────────────────────────────────
//
// Returns up to REQUIRED_BALLS rows in ball-number ASC order. The
// client uses this to render the per-ball replay animation (it
// already has the live ball paths from launchBall responses, but
// this is the canonical source for the reveal screen).
export async function fetchMatchRounds(matchId) {
  return db
    .select()
    .from(plinkoPvpRounds)
    .where(eq(plinkoPvpRounds.matchId, matchId))
    .orderBy(sql`${plinkoPvpRounds.ballNumber} ASC`);
}

// ── Lightweight read for /status (no row lock) ────────────────────────
//
// Returns the raw row without auto-resolving. The caller is
// responsible for running `fetchMatchWithAutoResolve` if it's about
// to render the result and the deadline may have elapsed. Used by
// admin tooling and tests that want to do their own post-processing.
export async function fetchMatch(matchId) {
  const [match] = await db
    .select()
    .from(plinkoPvpMatches)
    .where(eq(plinkoPvpMatches.id, matchId));
  return match || null;
}
