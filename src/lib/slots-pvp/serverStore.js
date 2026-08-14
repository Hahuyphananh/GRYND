// src/lib/slots-pvp/serverStore.js
//
// Server-side canonical helpers for the PvP Slots ("Skill Slots") match
// system. Mirrors `src/lib/plinko-pvp/serverStore.js`:
//
//   The round state machine has to be authoritative on the server:
//     * server-side deterministic spin resolution (same seed → same
//       reels — reproducible for audit)
//     * EXACTLY 10-second rounds: `round_deadline` is stamped at round
//       open and auto-resolves any unstoppped reels the moment it
//       passes (enforced on every /status poll — the same timer/
//       state-sync approach as plinko-pvp / mines-pvp)
//     * simultaneous play: both players stop their 3 reels
//       independently; the round resolves when BOTH boards are locked
//       (or the deadline passes)
//     * one-shot reel stops (a stopped reel can never be stopped again)
//     * up to MAX_ROUNDS (5) rounds per match — best-of-5, and a
//       player reaching ROUNDS_TO_WIN (3) round wins ends the match
//       IMMEDIATELY (the remaining rounds are not played)
//
// Round flow (status enum matches `slots_pvp_status` in migration 0059):
//   waiting → ready → spin_1 → … → spin_5 → finished
//   waiting → cancelled (creator cancel, or disconnect forfeit before
//   the opponent joins)
//   ready/spin_N → finished (natural resolve, or disconnect forfeit
//   resolving the match as a win for the opponent)
//
// FINAL scoring (server-authoritative, per user spec — "Fruit Fortune
// Survival"):
//   * Single survival round: each player stops columns on a 3-column
//     sliding window. GRACE phase ends at the first horizontal/diagonal
//     3-in-a-row combo; from then on every stop must re-form a combo or
//     the player busts. Winner = higher `survived` (columns survived
//     after the first combo), tiebreak `linesFormed`.
//   * `buildRoundResult` produces the `slots_pvp_rounds` row with both
//     survival snapshots; `spin_points_*` stores the survived counts and
//     `round_winner` the round result (player1|player2|draw|grace_draw).
//   * Both players grace-fail → RESULT.GRACE_DRAW: each refunded 95% of
//     their wager (house keeps 5% from each = 10% total).
//   * `resolveSpinRound` tallies rounds_won_* + aggregate `p1_score` /
//     `p2_score` (total survived) onto the match row, then
//     `settleMatch` applies the payout: normal win = mines-pvp style
//     90/10 (winner credited stake + 90% of loser's stake, house keeps
//     10%); draw = full refund; grace_draw = 95% each.
//   * Both stakes are deducted atomically at `createMatch`, so the only
//     balance movement at the end is the winner credit (or refunds).
//
// Centralising this in a tiny module keeps the API routes thin and
// makes the state machine testable in isolation (the pure transitions
// live in `./engine.js` and are shared with the test runner).

import { eq, and, sql, isNull, inArray, notInArray } from "drizzle-orm";
import { db } from "../../db/client";
import { slotsPvpMatches, slotsPvpRounds, users } from "../../db/schema";
import { getTheme, THEME_IDS } from "../slotThemes.jsx";
import {
  ACTIVE_STATES,
  MATCH_STATUS,
  MAX_ROUNDS,
  MIN_STAKE,
  MAX_STAKE,
  RESULT,
  ROUNDS_TO_WIN,
  ROUND_TIMER_SECONDS,
  READY_WINDOW_MS,
  SLOTS_PVP_LOCK_NAMESPACE,
  TERMINAL_STATES,
  BOT_STOP_MS,
  TEST_ACCOUNT_EMAIL_DOMAIN,
  computePayout,
  isSpinStatus,
  round2,
} from "./constants.js";
import {
  applyColumnStop,
  autoStopActiveColumn,
  buildRoundResult,
  canResolveRound,
  decideMatchResult,
  jettisonActiveColumn,
  openSpinState,
  planAdvanceAfterResolve,
} from "./engine.js";

// ── Helpers ───────────────────────────────────────────────────────────

/** Seat label ("player1" | "player2") for a user in a given match row. */
export function seatForUser(match, userId) {
  if (!match || !userId) return null;
  if (match.player1Id === userId) return "player1";
  if (match.player2Id === userId) return "player2";
  return null;
}

export function isParticipant(match, userId) {
  return seatForUser(match, userId) !== null;
}

/** Validate host-picked params at lobby creation: stake + theme. */
export function validateMatchParams({ stakeAmount, theme }) {
  const stake = Number(stakeAmount);
  if (!Number.isFinite(stake) || stake < MIN_STAKE || stake > MAX_STAKE) {
    return {
      ok: false,
      error: `Stake must be a number in [${MIN_STAKE}, ${MAX_STAKE}]`,
    };
  }
  if (theme != null && !THEME_IDS.includes(theme)) {
    return {
      ok: false,
      error: `Theme must be one of: ${THEME_IDS.join(", ")}`,
    };
  }
  return { ok: true };
}

/** Theme symbol pool for a round (drives column generation + matching). */
function themeSymbolsForSpin(match) {
  return getTheme(match.theme || "fruit").symbols;
}

// ── Lobby helpers ─────────────────────────────────────────────────────

// Open (waiting) matches for the casino lobby listing. Most recent
// first; `player2Id IS NULL` is the canonical "open" predicate.
// Test-account lobbies (the "codetest" bot accounts) are excluded so
// real players only ever pair with real players.
export async function listOpenMatches({ limit = 30 } = {}) {
  const testIds = await fetchTestAccountClerkIds();
  const where = [
    eq(slotsPvpMatches.status, MATCH_STATUS.WAITING),
    isNull(slotsPvpMatches.player2Id),
  ];
  if (testIds.length > 0) {
    where.push(notInArray(slotsPvpMatches.player1Id, testIds));
  }
  return db
    .select()
    .from(slotsPvpMatches)
    .where(and(...where))
    .orderBy(sql`${slotsPvpMatches.createdAt} DESC`)
    .limit(limit);
}

// ── Test-account identification ───────────────────────────────────────
//
// The developer's test accounts ("codetest") live on a dedicated email
// domain. They are used exclusively by the "Test vs Bot" button, so the
// matchmaker must NEVER pair a real player against them and their
// matches must never move real tokens. The clerkIds are resolved once
// and cached (short TTL) — the list only changes when the developer
// creates another test account, so a stale list for a minute is fine.

let testAccountCache = { ids: null, at: 0 };
const TEST_ACCOUNT_CACHE_TTL_MS = 60 * 1000;

async function fetchTestAccountClerkIds() {
  const now = Date.now();
  if (testAccountCache.ids && now - testAccountCache.at < TEST_ACCOUNT_CACHE_TTL_MS) {
    return testAccountCache.ids;
  }
  let ids = [];
  try {
    const rows = await db
      .select({ clerkId: users.clerkId })
      .from(users)
      .where(
        sql`${users.email} ILIKE ${`%@${TEST_ACCOUNT_EMAIL_DOMAIN}`}`,
      );
    ids = rows.map((r) => r.clerkId).filter(Boolean);
  } catch (err) {
    console.warn(
      "[slots-pvp] test-account lookup failed (defaulting to none):",
      err && err.message ? err.message : err,
    );
    ids = [];
  }
  testAccountCache = { ids, at: now };
  return ids;
}

/** True when the clerkId belongs to one of the developer's test accounts. */
export async function isTestAccountClerkId(clerkId) {
  if (!clerkId) return false;
  const ids = await fetchTestAccountClerkIds();
  return ids.includes(clerkId);
}

/** True when a match involves a test account (practice / bot match). */
export async function isBotMatch(match) {
  if (!match) return false;
  if (match.isTest === true) return true;
  // NOTE: both awaits are required — `||` between two promises would
  // short-circuit to the first promise and never resolve the second.
  return (
    (await isTestAccountClerkId(match.player1Id)) ||
    (await isTestAccountClerkId(match.player2Id))
  );
}

// Stable deterministic hash from numeric stake to a signed 32-bit int.
// Used purely as the second key of the two-key pg_advisory_xact_lock
// for stake-keyed matchmaking. Collisions on distinct stakes would
// only briefly serialise (no correctness risk). Mirrors the helper
// used by plinko-pvp / mines-pvp / blackjack-pvp.
function hashStakeToInt(stake) {
  const fixed = Number(stake).toFixed(2);
  let h = 2166136261; // FNV-1a 32-bit offset basis
  for (let i = 0; i < fixed.length; i += 1) {
    h ^= fixed.charCodeAt(i);
    h = Math.imul(h, 16777619); // FNV-1a 32-bit prime
  }
  return (h | 0) & 0x7fffffff;
}

// Build a `players: { p1, p2 }` envelope from user rows keyed by
// clerkId so lobby / match views render real names + avatars instead
// of clerkId truncation (mirrors plinko-pvp's enrichMatchesWithUsers).
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

// Attach `players: { p1, p2 }` (displayName + profileImageUrl) to a
// match or list of matches. Best-effort — never throws; a failed
// users lookup degrades to clerkId labels.
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
    rows = await db
      .select({
        clerkId: users.clerkId,
        displayName: users.name,
        profileImageUrl: users.profilePicture,
      })
      .from(users)
      .where(inArray(users.clerkId, Array.from(ids)));
  } catch (err) {
    console.warn(
      "[slots-pvp] enrichMatchesWithUsers: users lookup failed:",
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

// ── Create / Join matchmaking ─────────────────────────────────────────
//
// Single-transaction stake-keyed matchmaking (mirrors plinko-pvp
// createOrJoin):
//   1. Postgres `pg_advisory_xact_lock` keyed on
//      (SLOTS_PVP_LOCK_NAMESPACE, hash(stake)) serialises every
//      concurrent matchmaker for the same stake across all workers.
//      Without this, two matchmakers calling `createOrJoin`
//      concurrently could both observe "no open match" and both
//      INSERT a fresh waiting row.
//   2. `FOR UPDATE` + re-fetch + conditional UPDATE filtering on
//      `status='waiting' AND player2_id IS NULL` catches the
//      "creator cancelled in parallel" race.
//
// `theme` is the host-picked slot theme (mirrors mines-pvp's
// host-picked `mines_count` param); a joiner consumes whatever theme
// the host chose. Both stakes are escrowed at create/join time so the
// payout math is balance-neutral, exactly like the other PvP games.
export async function createOrJoin({ userId, stakeAmount, theme = "fruit" }) {
  const validation = validateMatchParams({ stakeAmount, theme });
  if (!validation.ok) {
    return { error: validation.error, status: 400 };
  }
  if (!userId) {
    return { error: "userId is required", status: 400 };
  }

  const lockKey = hashStakeToInt(stakeAmount);

  // Resolve the developer's test-account clerkIds up front so lobbies
  // hosted by a codetest are never offered to a real player.
  const testIds = await fetchTestAccountClerkIds();

  return await db.transaction(async (tx) => {
    // Acquire stake-keyed advisory lock; auto-released on commit/rollback.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${SLOTS_PVP_LOCK_NAMESPACE}, ${lockKey})`,
    );

    // 1) Look for an existing open match with matching stake (never a
    //    test-account lobby — those are only joined via the Test button).
    const openMatchWhere = [
      eq(slotsPvpMatches.status, MATCH_STATUS.WAITING),
      isNull(slotsPvpMatches.player2Id),
      eq(slotsPvpMatches.stakeAmount, Number(stakeAmount).toFixed(2)),
    ];
    if (testIds.length > 0) {
      openMatchWhere.push(notInArray(slotsPvpMatches.player1Id, testIds));
    }
    const [openMatch] = await tx
      .select()
      .from(slotsPvpMatches)
      .where(and(...openMatchWhere))
      .orderBy(sql`${slotsPvpMatches.createdAt} ASC`)
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
    return await createWaitingMatch(tx, userId, stakeAmount, theme);
  });
}

async function createWaitingMatch(tx, userId, stakeAmount, theme) {
  const stake = Number(stakeAmount).toFixed(2);

  // Deduct creator stake (atomic: only if balance is sufficient).
  const [creator] = await tx
    .update(users)
    .set({ balance: sql`${users.balance} - ${stake}` })
    .where(
      and(eq(users.clerkId, userId), sql`${users.balance} >= ${stake}`),
    )
    .returning({ balance: users.balance });

  if (!creator) {
    return { error: "Insufficient balance", status: 400 };
  }

  const [match] = await tx
    .insert(slotsPvpMatches)
    .values({
      player1Id: userId,
      stakeAmount: stake,
      theme,
      status: MATCH_STATUS.WAITING,
      currentSpin: 1,
      roundsWonPlayer1: 0,
      roundsWonPlayer2: 0,
      p1Score: 0,
      p2Score: 0,
      p1CurrentInputs: null,
      p2CurrentInputs: null,
      roundTimerSeconds: ROUND_TIMER_SECONDS,
      houseFee: "0.00",
      prizePaid: "0.00",
    })
    .returning();

  return { match, joined: false };
}

async function joinExistingMatch(tx, candidateId, userId, stakeAmount) {
  // Re-fetch the candidate row INSIDE the same transaction with
  // FOR UPDATE so a parallel /cancel that committed first can't leave
  // us updating a row that's already cancelled.
  const [match] = await tx
    .select()
    .from(slotsPvpMatches)
    .where(eq(slotsPvpMatches.id, candidateId))
    .for("update");

  if (!match || match.status !== MATCH_STATUS.WAITING || match.player2Id) {
    return { error: "Lobby no longer available", status: 409 };
  }

  const stake = Number(stakeAmount).toFixed(2);

  // Deduct joiner's stake (atomic: only if balance is sufficient).
  const [joiner] = await tx
    .update(users)
    .set({ balance: sql`${users.balance} - ${stake}` })
    .where(
      and(eq(users.clerkId, userId), sql`${users.balance} >= ${stake}`),
    )
    .returning({ balance: users.balance });

  if (!joiner) {
    return { error: "Insufficient balance", status: 400 };
  }

  // Brief 3-second "Ready" window so both players can read the
  // match-found banner before spin_1's 10-second window opens.
  // /status auto-advances to spin_1 once the deadline passes
  // (see advanceFromReady).
  const readyDeadline = new Date(Date.now() + READY_WINDOW_MS);

  const [updated] = await tx
    .update(slotsPvpMatches)
    .set({
      player2Id: userId,
      status: MATCH_STATUS.READY,
      currentSpin: 1,
      roundDeadline: readyDeadline,
      startedAt: new Date(),
    })
    .where(
      and(
        eq(slotsPvpMatches.id, candidateId),
        // Defensive guard: only update if status is still `waiting`
        // and player2Id is still null when we commit.
        eq(slotsPvpMatches.status, MATCH_STATUS.WAITING),
        isNull(slotsPvpMatches.player2Id),
      ),
    )
    .returning();

  // If our conditional UPDATE didn't match any rows (because another
  // concurrent joiner raced us), refund joiner stake.
  if (!updated) {
    await tx
      .update(users)
      .set({ balance: sql`${users.balance} + ${stake}` })
      .where(eq(users.clerkId, userId));
    return { error: "Lobby no longer available", status: 409 };
  }

  return { match: updated, joined: true };
}

// ── Round history ─────────────────────────────────────────────────────

// All resolved rounds for a match, oldest first. Used by the match
// view's reveal screen + round-history strip (mirrors plinko-pvp
// fetchMatchRounds).
export async function fetchMatchRounds(matchId) {
  return db
    .select()
    .from(slotsPvpRounds)
    .where(eq(slotsPvpRounds.matchId, matchId))
    .orderBy(sql`${slotsPvpRounds.spinNumber} ASC`);
}

// ── Match creation ────────────────────────────────────────────────────
//
// Creates a match and deducts BOTH players' stakes atomically (guarded
// by balance, mirroring mines-pvp's createWaitingMatch / joinExistingMatch
// so the eventual payout math is balance-neutral). When `player2Id` is
// provided the match skips the lobby and goes straight to the ready
// banner; otherwise it opens as a waiting lobby for the future
// stake-keyed matchmaking step.

export async function createMatch({
  player1Id,
  player2Id = null,
  stakeAmount,
  theme = "fruit",
}) {
  const validation = validateMatchParams({ stakeAmount, theme });
  if (!validation.ok) {
    return { error: validation.error, status: 400 };
  }
  if (!player1Id) {
    return { error: "player1Id is required", status: 400 };
  }
  if (player1Id === player2Id) {
    return { error: "A player cannot play themselves", status: 400 };
  }

  const stake = Number(stakeAmount).toFixed(2);

  return await db.transaction(async (tx) => {
    // Deduct player1's stake (atomic: only if balance is sufficient).
    const [p1] = await tx
      .update(users)
      .set({ balance: sql`${users.balance} - ${stake}` })
      .where(
        and(eq(users.clerkId, player1Id), sql`${users.balance} >= ${stake}`),
      )
      .returning({ balance: users.balance });

    if (!p1) {
      return { error: "Insufficient balance", status: 400 };
    }

    // Both players present → deduct player2's stake too.
    if (player2Id) {
      const [p2] = await tx
        .update(users)
        .set({ balance: sql`${users.balance} - ${stake}` })
        .where(
          and(eq(users.clerkId, player2Id), sql`${users.balance} >= ${stake}`),
        )
        .returning({ balance: users.balance });

      if (!p2) {
        // Refund player1 and bail — the match never opens.
        await tx
          .update(users)
          .set({ balance: sql`${users.balance} + ${stake}` })
          .where(eq(users.clerkId, player1Id));
        return { error: "Insufficient balance", status: 400 };
      }
    }

    const now = new Date();
    const [match] = await tx
      .insert(slotsPvpMatches)
      .values({
        player1Id,
        player2Id: player2Id || null,
        stakeAmount: stake,
        theme,
        status: MATCH_STATUS.WAITING,
        currentSpin: 1,
        roundsWonPlayer1: 0,
        roundsWonPlayer2: 0,
        p1Score: 0,
        p2Score: 0,
        p1CurrentInputs: null,
        p2CurrentInputs: null,
        roundTimerSeconds: ROUND_TIMER_SECONDS,
        houseFee: "0.00",
        prizePaid: "0.00",
        // Two players already present → skip straight to the ready
        // banner (auto-advances to spin_1 after READY_WINDOW_MS).
        ...(player2Id
          ? {
              status: MATCH_STATUS.READY,
              roundDeadline: new Date(now.getTime() + READY_WINDOW_MS),
              startedAt: now,
            }
          : {}),
      })
      .returning();

    return { match };
  });
}

// ── Practice (Test vs Bot) match ──────────────────────────────────────
//
// Creates a FREE-PLAY match against one of the developer's test accounts
// (the "codetest" bot). Follows the dice-flush / farkle AI convention:
// no stake is escrowed from either side and no payout is credited at
// settlement — the match exists purely to test the game loop. The match
// skips the waiting lobby and goes straight to the `ready` banner; the
// bot seat is driven by the poll-time auto-stop (at a snappy
// BOT_STOP_MS cadence, see advanceFromReady / forceSpinAdvance) until
// its run ends.

export async function createTestMatch({ userId, stakeAmount, theme = "fruit" }) {
  const validation = validateMatchParams({ stakeAmount, theme });
  if (!validation.ok) {
    return { error: validation.error, status: 400 };
  }
  if (!userId) {
    return { error: "userId is required", status: 400 };
  }

  // The bot occupies the player2 seat — pick any test account that isn't
  // the caller (defensive; the caller shouldn't be a test account).
  const testIds = await fetchTestAccountClerkIds();
  const botId = testIds.find((id) => id !== userId) || testIds[0];
  if (!botId) {
    return { error: "No test bot available", status: 500 };
  }

  const stake = Number(stakeAmount).toFixed(2);
  const now = new Date();

  // No balance movement anywhere in this function — free play.
  const [match] = await db
    .insert(slotsPvpMatches)
    .values({
      player1Id: userId,
      player2Id: botId,
      stakeAmount: stake,
      theme,
      // Both players present → skip straight to the ready banner
      // (auto-advances to spin_1 after READY_WINDOW_MS).
      status: MATCH_STATUS.READY,
      currentSpin: 1,
      roundsWonPlayer1: 0,
      roundsWonPlayer2: 0,
      p1Score: 0,
      p2Score: 0,
      p1CurrentInputs: null,
      p2CurrentInputs: null,
      roundDeadline: new Date(now.getTime() + READY_WINDOW_MS),
      roundTimerSeconds: ROUND_TIMER_SECONDS,
      houseFee: "0.00",
      prizePaid: "0.00",
      startedAt: now,
    })
    .returning();

  return { match, test: true };
}

// ── Auto-advance ready → spin_1 ───────────────────────────────────────

async function advanceFromReady(tx, match) {
  const now = Date.now();
  const symbols = themeSymbolsForSpin(match);
  // Opens the single survival round: each player's run carries its own
  // per-column 10s deadline (inside p{N}CurrentInputs), so the match
  // row's round_deadline is only used for the ready window above.
  const open = openSpinState({
    matchId: match.id,
    spinNumber: 1,
    symbols,
    now,
  });

  // Practice matches: the test-bot seat stops its columns on a snappy
  // BOT_STOP_MS cadence instead of the full 10s column timer, so the
  // bot plays like a live opponent (driven by the /status polls).
  let botSeat = null;
  if (await isBotMatch(match)) {
    if (await isTestAccountClerkId(match.player2Id)) botSeat = "player2";
    else if (await isTestAccountClerkId(match.player1Id)) botSeat = "player1";
  }
  if (botSeat) {
    const botKey = botSeat === "player1" ? "p1CurrentInputs" : "p2CurrentInputs";
    open[botKey] = {
      ...open[botKey],
      activeDeadline: now + BOT_STOP_MS,
    };
  }

  const [updated] = await tx
    .update(slotsPvpMatches)
    .set({
      status: MATCH_STATUS.SPIN_1,
      currentSpin: 1,
      roundDeadline: null,
      startedAt: match.startedAt || new Date(),
      p1CurrentInputs: open.p1CurrentInputs,
      p2CurrentInputs: open.p2CurrentInputs,
    })
    .where(
      and(
        eq(slotsPvpMatches.id, match.id),
        eq(slotsPvpMatches.status, MATCH_STATUS.READY),
      ),
    )
    .returning();

  return updated || match;
}

// ── Fetch with row lock ───────────────────────────────────────────────

async function fetchMatchForUpdate(tx, matchId) {
  const [match] = await tx
    .select()
    .from(slotsPvpMatches)
    .where(eq(slotsPvpMatches.id, matchId))
    .for("update");
  return match;
}

// ── Resolve a round (both boards locked) ──────────────────────────────
//
// Persists the just-played round: writes a `slots_pvp_rounds` history
// row (both players' full scoring snapshots + round winner), tallies
// the round into the match-level score (`rounds_won_*` + aggregate
// `p1_score`/`p2_score`), then advances to the next spin (fresh hidden
// reels + fresh 10s deadline) or — after round MAX_ROUNDS — finalizes
// the match (winner, payout, leaderboard).
async function resolveSpinRound(tx, match) {
  if (!match || !canResolveRound(match)) return match;

  // Persist the final locked input state first so status readers see
  // it before the advance below overwrites it with the next round.
  await tx
    .update(slotsPvpMatches)
    .set({
      p1CurrentInputs: match.p1CurrentInputs,
      p2CurrentInputs: match.p2CurrentInputs,
    })
    .where(eq(slotsPvpMatches.id, match.id));

  const symbols = themeSymbolsForSpin(match);

  // History row for this round — scores are computed server-side from
  // the locked boards (clients never submit scores).
  const row = buildRoundResult(match, symbols);
  await tx.insert(slotsPvpRounds).values(row);

  // Tally the round into the match-level score.
  const roundsWonPlayer1 =
    (Number(match.roundsWonPlayer1) || 0) +
    (row.roundWinner === RESULT.PLAYER1 ? 1 : 0);
  const roundsWonPlayer2 =
    (Number(match.roundsWonPlayer2) || 0) +
    (row.roundWinner === RESULT.PLAYER2 ? 1 : 0);
  const p1Score = (Number(match.p1Score) || 0) + row.spinPointsPlayer1;
  const p2Score = (Number(match.p2Score) || 0) + row.spinPointsPlayer2;
  const tallies = { roundsWonPlayer1, roundsWonPlayer2, p1Score, p2Score };

  // The plan decides whether the match ends now — round MAX_ROUNDS
  // resolved, OR a player just reached ROUNDS_TO_WIN (first-to-3,
  // best-of-5) and the remaining rounds are skipped. Passing the
  // POST-round tallies lets the plan detect the early finish.
  const plan = planAdvanceAfterResolve({
    match,
    symbols,
    tallies,
    now: Date.now(),
  });

  if (plan.finished) {
    // The single survival round just resolved → finalize (winner +
    // payout). Pass the round's own winner through so GRACE_DRAW (both
    // players grace-failed) settles with the 5%-each refund, not the
    // full-refund plain-draw path.
    const [updated] = await tx
      .update(slotsPvpMatches)
      .set({
        status: MATCH_STATUS.FINISHED,
        roundDeadline: null,
        p1CurrentInputs: null,
        p2CurrentInputs: null,
        ...tallies,
        ...(await settleMatch(tx, match, tallies, {
          forcedResult: row.roundWinner,
        })),
        endedAt: plan.endedAt || new Date(),
      })
      .where(eq(slotsPvpMatches.id, match.id))
      .returning();
    return updated || match;
  }

  const [updated] = await tx
    .update(slotsPvpMatches)
    .set({
      status: plan.status,
      currentSpin: plan.currentSpin,
      roundDeadline: plan.roundDeadline,
      p1CurrentInputs: plan.p1CurrentInputs,
      p2CurrentInputs: plan.p2CurrentInputs,
      ...tallies,
    })
    .where(eq(slotsPvpMatches.id, match.id))
    .returning();
  return updated || match;
}

// ── Settle the finished match (winner + payout + leaderboard) ─────────
//
// Pure-compute + balance side-effects for the match end (mirrors
// mines-pvp resolveMatch / recordPvPResult):
//   1. result — the round winner when `forcedResult` is passed (single
//      round), otherwise decideMatchResult (used by forfeits).
//   2. computePayout — 90/10 split, full-refund draw, or 95%-each
//      grace_draw.
//   3. Credit the winner, or refund both (draw / grace_draw).
//   4. Bump the PvP leaderboard counters (pvpWins / totalWon / …).
// Returns the settlement fields to stamp onto the match row.
async function settleMatch(tx, match, tallies, { forcedResult = null } = {}) {
  const result = forcedResult || decideMatchResult(tallies);
  const payout = computePayout({
    stakeAmount: match.stakeAmount,
    result,
  });

  // Practice matches (Test vs Bot) are free play: nothing was escrowed,
  // so nothing is credited — the winner/result are still stamped so the
  // reveal UI works, but no balance or leaderboard side-effects run.
  if (await isBotMatch(match)) {
    const winnerId =
      result === RESULT.PLAYER1
        ? match.player1Id
        : result === RESULT.PLAYER2
          ? match.player2Id
          : null;
    return {
      winnerId,
      result,
      houseFee: "0.00",
      prizePaid: "0.00",
    };
  }

  if (result === RESULT.DRAW || result === RESULT.GRACE_DRAW) {
    // DRAW: both fully refunded (no rake). GRACE_DRAW: both players
    // grace-failed → each refunded 95% of their wager (house keeps 5%
    // from each = 10% total, carried in `houseFee`).
    const refund = payout.refundEach ?? payout.stake;
    await tx
      .update(users)
      .set({ balance: sql`${users.balance} + ${refund}` })
      .where(eq(users.clerkId, match.player1Id));
    await tx
      .update(users)
      .set({ balance: sql`${users.balance} + ${refund}` })
      .where(eq(users.clerkId, match.player2Id));
    return {
      winnerId: null,
      result,
      houseFee: payout.houseFee.toFixed(2),
      prizePaid: payout.prizePaid.toFixed(2),
    };
  }

  const winnerId =
    result === RESULT.PLAYER1 ? match.player1Id : match.player2Id;
  const loserId =
    result === RESULT.PLAYER1 ? match.player2Id : match.player1Id;

  // Winner gets their stake back + 90% of the loser's stake.
  await tx
    .update(users)
    .set({ balance: sql`${users.balance} + ${payout.winnerNet}` })
    .where(eq(users.clerkId, winnerId));

  const settlement = {
    winnerId,
    result,
    houseFee: payout.houseFee.toFixed(2),
    prizePaid: payout.prizePaid.toFixed(2),
  };

  // Best-effort leaderboard side-effects (mirrors mines-pvp
  // recordPvPResult) — failures never roll back the settlement.
  await recordPvPResult(tx, winnerId, loserId, match, settlement, result).catch(
    () => {},
  );

  return settlement;
}

// Best-effort stat side-effect — mirrors mines-pvp recordPvPResult.
// Bumps pvpWins / gamesWon / gamesLost / totalWon / totalWagered so the
// global PvP leaderboards stay fresh. `settlement` carries the already-
// computed prizePaid (the match row isn't stamped with it until AFTER
// this call, so reading it from the row would see the old 0.00).
async function recordPvPResult(tx, winnerId, loserId, match, settlement, result) {
  if (!winnerId || !loserId) return;

  const prizePaid = Number(settlement.prizePaid) || 0;

  await tx
    .update(users)
    .set({ pvpWins: sql`${users.pvpWins} + 1` })
    .where(eq(users.clerkId, winnerId));
  await tx
    .update(users)
    .set({
      gamesWon: sql`${users.gamesWon} + 1`,
      totalWon: sql`${users.totalWon} + ${prizePaid}`,
      biggestWin:
        prizePaid > 0
          ? sql`GREATEST(${users.biggestWin}, ${prizePaid})`
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

// ── stopColumn (the main skill action) ────────────────────────────────
//
// Server-authoritative column stop / jettison. The player POSTs the
// column index (or `jettison: true`) and the server:
//   1. Validates participation, spin status, column index, the active
//      column's deadline (plus the COLUMN_STOP_GRACE_MS lag cushion),
//      and the stop-order rules (initial phase: any of columns 0..2,
//      once each; sliding phase: only the active stream column).
//   2. Lands the column on the player's `p{N}CurrentInputs` and runs the
//      grace / survival combo logic — or, for a jettison, skips the
//      active column (advances the stream) without landing anything.
//   3. If BOTH runs have now ended → resolves the round immediately
//      (writes history + advances), otherwise persists the change.
//
// Rejects with 400 once the active column's deadline + grace window has
// passed — the next /status poll triggers the auto-stop + resolve path
// instead.

export async function stopColumn({
  userId,
  matchId,
  columnIndex,
  currentSpin = null,
  jettison = false,
}) {
  return await db.transaction(async (tx) => {
    const match = await fetchMatchForUpdate(tx, matchId);
    if (!match) return { error: "Match not found", status: 404 };
    if (!isParticipant(match, userId)) {
      return { error: "Forbidden", status: 403 };
    }
    const seat = seatForUser(match, userId);

    // `currentSpin` is the spin number the client believes is live (from
    // its last /status poll). Passed through so the engine can reject
    // stale actions from a round that already advanced.
    const applied = jettison
      ? jettisonActiveColumn(match, seat, Date.now(), currentSpin)
      : applyColumnStop(match, seat, columnIndex, Date.now(), currentSpin);
    if (!applied.ok) return { error: applied.error, status: applied.status };

    const inputsKey = seat === "player1" ? "p1CurrentInputs" : "p2CurrentInputs";
    let resultRow = applied.match;
    let roundResolved = false;

    if (canResolveRound(applied.match)) {
      // Both runs ended → resolve in the same transaction. (A jettison
      // never lands a column, so this only fires for a real stop.)
      resultRow = await resolveSpinRound(tx, applied.match);
      roundResolved = true;
    } else {
      const [updated] = await tx
        .update(slotsPvpMatches)
        .set({ [inputsKey]: applied.match[inputsKey] })
        .where(
          and(
            eq(slotsPvpMatches.id, matchId),
            eq(slotsPvpMatches.status, match.status),
            eq(slotsPvpMatches.currentSpin, match.currentSpin),
          ),
        )
        .returning();
      resultRow = updated || applied.match;
    }

    const myRun = resultRow[inputsKey] || {};
    return {
      match: resultRow,
      seat,
      columnStopped: Array.isArray(myRun.stoppedOrder)
        ? myRun.stoppedOrder[myRun.stoppedOrder.length - 1]
        : null,
      jettisoned: jettison === true,
      runEnded: Boolean(myRun.ended),
      survived: Number(myRun.survived) || 0,
      roundResolved,
    };
  });
}

// ── AFK deadline advance ──────────────────────────────────────────────
//
// Server-side "10s nudge": if an active column's per-column deadline
// has passed, auto-stop it (marked `anyAutoStopped`), then resolve the
// round exactly as if both players had finished manually. Called from
// `fetchMatchWithAutoResolve` on every status poll — guarantees a
// column never spins longer than COLUMN_TIMER_SECONDS and that an AFK
// player's run still resolves (grace-fail / bust as the landing lands).
async function forceSpinAdvance(tx, match) {
  if (!isSpinStatus(match.status)) return match;
  const now = Date.now();
  let next = match;

  // Practice matches: the test-bot seat auto-stops on the fast
  // BOT_STOP_MS cadence (re-stamped after every landing), so the bot
  // plays a column roughly every 1.5s instead of stalling 10s per
  // column. The human player keeps the normal 10s timer.
  let botSeat = null;
  if (await isBotMatch(match)) {
    if (await isTestAccountClerkId(match.player2Id)) botSeat = "player2";
    else if (await isTestAccountClerkId(match.player1Id)) botSeat = "player1";
  }

  const advanceSeat = (seat) => {
    const inputsKey = seat === "player1" ? "p1CurrentInputs" : "p2CurrentInputs";
    const run = next[inputsKey];
    if (
      run &&
      !run.ended &&
      run.activeDeadline &&
      new Date(run.activeDeadline).getTime() <= now
    ) {
      next = autoStopActiveColumn(next, seat, now);
      if (botSeat === seat && next[inputsKey] && !next[inputsKey].ended) {
        next[inputsKey] = {
          ...next[inputsKey],
          activeDeadline: now + BOT_STOP_MS,
        };
      }
    }
  };

  advanceSeat("player1");
  advanceSeat("player2");

  if (canResolveRound(next)) {
    return await resolveSpinRound(tx, next);
  }

  if (next !== match) {
    // Some run(s) were auto-advanced but the round isn't over yet.
    const [updated] = await tx
      .update(slotsPvpMatches)
      .set({
        p1CurrentInputs: next.p1CurrentInputs,
        p2CurrentInputs: next.p2CurrentInputs,
      })
      .where(
        and(
          eq(slotsPvpMatches.id, match.id),
          eq(slotsPvpMatches.status, match.status),
          eq(slotsPvpMatches.currentSpin, match.currentSpin),
        ),
      )
      .returning();
    return updated || next;
  }

  return next;
}

// ── fetchMatchWithAutoResolve ─────────────────────────────────────────
//
// The canonical per-poll entry point (mirrors plinko-pvp). Inside a
// transaction it:
//   1. ready + both players present + ready window elapsed → spin_1
//   2. spin round + deadline passed → auto-stop + resolve
// Returns the fresh match for the caller (route scrubs the opponent's
// hidden reels before responding).

export async function fetchMatchWithAutoResolve(userId, matchId) {
  return await db.transaction(async (tx) => {
    const match = await fetchMatchForUpdate(tx, matchId);
    if (!match) return { match: null, error: "Match not found", status: 404 };
    if (!isParticipant(match, userId)) {
      return { match, error: "Forbidden", status: 403 };
    }

    let current = match;
    if (
      current.status === MATCH_STATUS.READY &&
      current.player2Id &&
      current.roundDeadline &&
      new Date(current.roundDeadline).getTime() <= Date.now()
    ) {
      current = await advanceFromReady(tx, current);
    }
    if (isSpinStatus(current.status)) {
      current = await forceSpinAdvance(tx, current);
    }
    return { match: current };
  });
}

// ── Scrub the opponent's hidden board ─────────────────────────────────
//
// While the round is live, each player may only see THEIR OWN sliding
// window plus the opponent's RUN STATUS (in grace / alive / out, how
// many they've survived). The opponent's columns, window, and combo
// lines stay hidden until the round resolves. Finished matches expose
// both (the rounds history is the replay source of truth).

export function scrubMatchForViewer(match, userId) {
  if (!match) return match;
  const seat = seatForUser(match, userId);
  if (!seat || TERMINAL_STATES.has(match.status)) return match;

  const visible = { ...match };
  const oppKey = seat === "player1" ? "p2CurrentInputs" : "p1CurrentInputs";
  const opp = visible[oppKey];

  if (opp && isSpinStatus(match.status)) {
    // Reveal only the opponent's run status — never their columns /
    // window / active-column symbols.
    visible[oppKey] = {
      stoppedCount: Number(opp.stoppedCount) || 0,
      stoppedOrder: Array.isArray(opp.stoppedOrder) ? opp.stoppedOrder : [],
      firstComboAt: opp.firstComboAt ?? null,
      survived: Number(opp.survived) || 0,
      linesFormed: Number(opp.linesFormed) || 0,
      busted: Boolean(opp.busted),
      graceFailed: Boolean(opp.graceFailed),
      ended: Boolean(opp.ended),
      activeIndex: opp.activeIndex ?? null,
      activeDeadline: opp.activeDeadline ?? null,
      openedAt: opp.openedAt ?? null,
    };
  }
  return visible;
}

// ── Cancel / forfeit ──────────────────────────────────────────────────
//
// Both players' stakes are deducted at `createMatch`, so every
// non-settled exit MUST refund what was taken. `cancelMatch` (creator
// only, while `waiting` — player2 hasn't joined yet) refunds player1's
// stake.
//
// `forfeitMatch` mirrors plinko-pvp's disconnect forfeit exactly: it is
// called by the internal /api/slots-pvp/disconnect-forfeit route once
// the realtime server confirms a participant's socket has stayed
// disconnected past the grace window. A WAITING match (no opponent
// yet) is cancelled and the creator's stake refunded; an ACTIVE match
// (ready or mid-spin) is resolved as a decisive win for the OPPONENT
// with the standard 90/10 payout — the same money math as a natural
// settlement. Idempotent: terminal matches are left untouched, so a
// forfeit racing a natural resolve can never double-pay.

export async function cancelMatch({ userId, matchId }) {
  return await db.transaction(async (tx) => {
    const match = await fetchMatchForUpdate(tx, matchId);
    if (!match) return { error: "Match not found", status: 404 };
    if (match.status !== MATCH_STATUS.WAITING) {
      return {
        error: "Match cannot be cancelled after the opponent joins",
        status: 400,
      };
    }
    if (match.player1Id !== userId) {
      return { error: "Only the creator can cancel", status: 403 };
    }
    // Refund the creator's deducted stake — practice matches escrow
    // nothing, so there is nothing to refund.
    if (!(await isBotMatch(match))) {
      await tx
        .update(users)
        .set({ balance: sql`${users.balance} + ${Number(match.stakeAmount)}` })
        .where(eq(users.clerkId, match.player1Id));
    }

    const [updated] = await tx
      .update(slotsPvpMatches)
      .set({ status: MATCH_STATUS.CANCELLED, endedAt: new Date() })
      .where(eq(slotsPvpMatches.id, matchId))
      .returning();
    return { match: updated || match };
  });
}

export async function forfeitMatch({ loserClerkId, matchId }) {
  return await db.transaction(async (tx) => {
    const match = await fetchMatchForUpdate(tx, matchId);
    if (!match) return { error: "Match not found", status: 404 };
    // Practice matches escrow nothing — every non-settled exit is a
    // plain no-op on balances (winner/result still stamped for the UI).
    const isBot = await isBotMatch(match);

    // No opponent yet — cancel + refund the creator (the only
    // participant in WAITING is player1, i.e. the disconnected player).
    if (match.status === MATCH_STATUS.WAITING) {
      if (match.player1Id !== loserClerkId) {
        return { error: "Only the creator can cancel", status: 403 };
      }
      if (!isBot) {
        await tx
          .update(users)
          .set({ balance: sql`${users.balance} + ${Number(match.stakeAmount)}` })
          .where(eq(users.clerkId, loserClerkId));
      }
      const [updated] = await tx
        .update(slotsPvpMatches)
        .set({ status: MATCH_STATUS.CANCELLED, endedAt: new Date() })
        .where(eq(slotsPvpMatches.id, matchId))
        .returning();
      return { match: updated || match, cancelled: true };
    }

    // Already finished / cancelled — idempotent no-op (a forfeit racing
    // a natural resolve reads the committed terminal row here).
    if (!ACTIVE_STATES.has(match.status)) {
      return { match, alreadyTerminal: true };
    }
    if (match.player1Id !== loserClerkId && match.player2Id !== loserClerkId) {
      return { error: "Caller is not a participant", status: 403 };
    }

    const loserIsP1 = match.player1Id === loserClerkId;
    const winnerUserId = loserIsP1 ? match.player2Id : match.player1Id;

    // The OPPONENT wins the best-of-5 match outright. Their rounds-won
    // is forced to ROUNDS_TO_WIN so decideMatchResult — the SAME
    // decision rule a natural settlement uses — picks them; then the
    // standard 90/10 payout applies. The client never decides anything:
    // the winner is derived server-side from the authenticated loser.
    const tallies = {
      roundsWonPlayer1: loserIsP1 ? 0 : ROUNDS_TO_WIN,
      roundsWonPlayer2: loserIsP1 ? ROUNDS_TO_WIN : 0,
      p1Score: Number(match.p1Score) || 0,
      p2Score: Number(match.p2Score) || 0,
    };
    const result = decideMatchResult(tallies);
    const payout = computePayout({
      stakeAmount: match.stakeAmount,
      result,
    });

    // Winner gets their stake back + 90% of the forfeiter's stake —
    // unless this is a practice match (nothing was escrowed).
    if (!isBot) {
      await tx
        .update(users)
        .set({ balance: sql`${users.balance} + ${payout.winnerNet}` })
        .where(eq(users.clerkId, winnerUserId));
    }

    const settlement = isBot
      ? { winnerId: winnerUserId, result, houseFee: "0.00", prizePaid: "0.00" }
      : {
          winnerId: winnerUserId,
          result,
          houseFee: payout.houseFee.toFixed(2),
          prizePaid: payout.prizePaid.toFixed(2),
        };

    // Best-effort leaderboard side-effects (mirrors settleMatch) —
    // never run for practice matches.
    if (!isBot) {
      await recordPvPResult(
        tx,
        winnerUserId,
        loserClerkId,
        match,
        settlement,
        result,
      ).catch(() => {});
    }

    const [updated] = await tx
      .update(slotsPvpMatches)
      .set({
        status: MATCH_STATUS.FINISHED,
        ...tallies,
        roundDeadline: null,
        p1CurrentInputs: null,
        p2CurrentInputs: null,
        ...settlement,
        endedAt: new Date(),
      })
      .where(eq(slotsPvpMatches.id, matchId))
      .returning();
    return { match: updated || match, forfeited: true };
  });
}

// ── fetchMatch (raw read, no auto-resolve) ────────────────────────────

export async function fetchMatch(matchId) {
  const [match] = await db
    .select()
    .from(slotsPvpMatches)
    .where(eq(slotsPvpMatches.id, matchId));
  return match || null;
}

// Re-export round2 + match-length constants so routes/tests use one
// rounding helper and one source of truth for the best-of-5 shape.
export { round2, MAX_ROUNDS, ROUNDS_TO_WIN };
