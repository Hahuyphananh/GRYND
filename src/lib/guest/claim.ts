// src/lib/guest/claim.ts
//
// GUEST → ACCOUNT CONVERSION (Phase 4) — the ONLY writer of `guest_claims`.
//
// WHAT A CLAIM IS, EXACTLY
//
// A claim records that the account behind the current Clerk session has taken
// ownership of the guest practice record behind the current `grynd_guest`
// cookie. It writes ONE row (`guest_claims`) and touches NOTHING else:
//
//   · `guest_practice_results` keeps every original row, guest id and timestamp;
//   · `users` / `user_stats` / `player_ratings` / `player_trophies` / tokens /
//     quests / leaderboards are never read for writing or updated here;
//   · no Elo, trophy, win counter, wager or reward is granted retroactively.
//
// A guest's practice results were never rated and stay unrated; the claim only
// makes them visible as the account's own practice provenance.
//
// ── IDENTITY ─────────────────────────────────────────────────────────────
//
// `userId` must be a Clerk id and `guestId` must be an `isGuestId` value. Both
// are resolved by the route from the authenticated session and the HMAC-signed
// cookie — never from a body, query, header or storage. `claimGuestProgression`
// re-validates both, so a future caller cannot pass a client string either.
//
// ── ONE GUEST, ONE ACCOUNT ───────────────────────────────────────────────
//
// Inside the transaction the guest profile row is locked (`FOR UPDATE`), then:
//   1. no profile           → `no_progress` (nothing is created or claimed);
//   2. guest already claimed → same account: idempotent `already_claimed`;
//                              other account: `guest_already_claimed`;
//   3. account already holds a claim → `account_already_claimed`;
//   4. otherwise            → insert the claim with the current counts.
//
// The primary key on `guest_id` and the unique index on `claimed_by_user_id`
// are the real guarantees: a racing claim that passed the read is rejected by
// the database, and `isUniqueViolation` maps that 23505 back to the same
// idempotent/conflict outcome instead of a 500. Detecting the race after the
// fact is exactly as safe as detecting it before: only one row can exist.
//
// ── FAILURE ──────────────────────────────────────────────────────────────
//
// Everything happens in one transaction, so a failure rolls back the claim row
// and leaves the guest record untouched — retryable, never partial. The route
// never clears the guest cookie on failure, so the browser keeps its identity.

import { eq, sql } from "drizzle-orm";

import { db } from "../../db/client";
import { guestClaims, guestPracticeResults, guestProfiles } from "../../db/schema";
import { isGuestId } from "../guestIdentity";
import { summarizeGuestProgress, type GuestProgress } from "./practiceProgress";

/**
 * Clerk user ids are `user_` + alphanumerics (underscores appear in some
 * fixtures/instances); `users.clerk_id` is varchar(255), so 250 id characters
 * leaves the prefix inside the column.
 */
const CLERK_USER_ID_PATTERN = /^user_[A-Za-z0-9_-]{1,250}$/;

export type GuestClaimTotals = GuestProgress["totals"];

export type GuestClaimState =
  | { status: "unclaimed"; totals: GuestClaimTotals }
  | { status: "claimed_by_you"; claimedAt: string; totals: GuestClaimTotals }
  | { status: "guest_already_claimed" }
  | { status: "account_already_claimed"; claimedAt: string }
  | { status: "no_progress" }
  | { status: "invalid_identity" };

export type GuestClaimOutcome =
  | { status: "claimed"; claimedAt: string; totals: GuestClaimTotals }
  | { status: "already_claimed"; claimedAt: string; totals: GuestClaimTotals }
  | { status: "guest_already_claimed" }
  | { status: "account_already_claimed"; claimedAt: string }
  | { status: "no_progress" }
  | { status: "invalid_identity" };

export function isClerkUserId(value: unknown): value is string {
  return typeof value === "string" && CLERK_USER_ID_PATTERN.test(value);
}

function toIso(value: unknown): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return "";
}

function isUniqueViolation(error: unknown): boolean {
  const code =
    (error as { code?: unknown } | null)?.code ??
    (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  return code === "23505";
}

/** Win/loss/draw totals derived with COUNT(*), never from a mutable counter. */
async function resultTotals(executor: any, guestId: string): Promise<GuestClaimTotals> {
  const rows = await executor
    .select({
      result: guestPracticeResults.result,
      count: sql<number>`count(*)::int`,
    })
    .from(guestPracticeResults)
    .where(eq(guestPracticeResults.guestId, guestId))
    .groupBy(guestPracticeResults.result);

  return summarizeGuestProgress(
    (rows as Array<{ result: string; count: number }>).flatMap((row) =>
      Array.from({ length: Math.max(0, Number(row.count) || 0) }, () => ({
        gameKey: "guest",
        result: String(row.result),
      })),
    ),
  ).totals;
}

function claimRowToTotals(row: {
  matchCount: number;
  winCount: number;
  lossCount: number;
  drawCount: number;
}): GuestClaimTotals {
  return {
    matches: Number(row.matchCount) || 0,
    wins: Number(row.winCount) || 0,
    losses: Number(row.lossCount) || 0,
    draws: Number(row.drawCount) || 0,
  };
}

const CLAIM_COLUMNS = {
  guestId: guestClaims.guestId,
  claimedByUserId: guestClaims.claimedByUserId,
  claimedAt: guestClaims.claimedAt,
  matchCount: guestClaims.matchCount,
  winCount: guestClaims.winCount,
  lossCount: guestClaims.lossCount,
  drawCount: guestClaims.drawCount,
};

async function claimInTransaction(
  tx: any,
  userId: string,
  guestId: string,
): Promise<GuestClaimOutcome> {
  // The row lock serialises two accounts racing for the same guest. A guest
  // without a profile has never finished a practice match: nothing to claim,
  // and nothing is created.
  const [profile] = await tx
    .select({ guestId: guestProfiles.guestId })
    .from(guestProfiles)
    .where(eq(guestProfiles.guestId, guestId))
    .limit(1)
    .for("update");

  if (!profile) return { status: "no_progress" };

  const [byGuest] = await tx
    .select(CLAIM_COLUMNS)
    .from(guestClaims)
    .where(eq(guestClaims.guestId, guestId))
    .limit(1);

  if (byGuest) {
    if (byGuest.claimedByUserId === userId) {
      return {
        status: "already_claimed",
        claimedAt: toIso(byGuest.claimedAt),
        totals: claimRowToTotals(byGuest),
      };
    }
    return { status: "guest_already_claimed" };
  }

  const [byUser] = await tx
    .select(CLAIM_COLUMNS)
    .from(guestClaims)
    .where(eq(guestClaims.claimedByUserId, userId))
    .limit(1);

  if (byUser) {
    return { status: "account_already_claimed", claimedAt: toIso(byUser.claimedAt) };
  }

  const totals = await resultTotals(tx, guestId);
  // A profile with no result rows is not claimable: a claim is about preserved
  // practice history, so an empty record answers `no_progress` and writes
  // nothing (the profile itself stays, and a later finished match can claim).
  if (totals.matches === 0) return { status: "no_progress" };
  const now = new Date();

  await tx.insert(guestClaims).values({
    guestId,
    claimedByUserId: userId,
    claimedAt: now,
    matchCount: totals.matches,
    winCount: totals.wins,
    lossCount: totals.losses,
    drawCount: totals.draws,
  });

  return { status: "claimed", claimedAt: now.toISOString(), totals };
}

/**
 * Resolve a claim after the database rejected the insert with 23505. Re-reading
 * tells us which of the two constraints fired, so the caller gets an idempotent
 * success or a precise conflict — never a generic error.
 */
async function resolveClaimConflict(
  userId: string,
  guestId: string,
): Promise<GuestClaimOutcome> {
  const [byGuest] = await db
    .select(CLAIM_COLUMNS)
    .from(guestClaims)
    .where(eq(guestClaims.guestId, guestId))
    .limit(1);

  if (byGuest) {
    if (byGuest.claimedByUserId === userId) {
      return {
        status: "already_claimed",
        claimedAt: toIso(byGuest.claimedAt),
        totals: claimRowToTotals(byGuest),
      };
    }
    return { status: "guest_already_claimed" };
  }

  const [byUser] = await db
    .select(CLAIM_COLUMNS)
    .from(guestClaims)
    .where(eq(guestClaims.claimedByUserId, userId))
    .limit(1);

  if (byUser) {
    return { status: "account_already_claimed", claimedAt: toIso(byUser.claimedAt) };
  }

  // The conflicting row disappeared between the failure and the read (the
  // owning account deleted itself). The caller may retry; nothing was written.
  return { status: "no_progress" };
}

/**
 * Claim the guest record identified by `guestId` for `userId`.
 *
 * Atomic and concurrency-safe: one transaction, a row lock on the guest, and
 * two unique constraints behind it. Idempotent for the same account; a
 * different account can never take over an existing claim.
 */
export async function claimGuestProgression(input: {
  userId: unknown;
  guestId: unknown;
}): Promise<GuestClaimOutcome> {
  if (!isClerkUserId(input.userId) || !isGuestId(input.guestId)) {
    return { status: "invalid_identity" };
  }

  try {
    return await db.transaction((tx: any) =>
      claimInTransaction(tx, input.userId as string, input.guestId as string),
    );
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    return resolveClaimConflict(input.userId as string, input.guestId as string);
  }
}

/**
 * Read-only status for the signed-in account + the browser's guest cookie.
 *
 * Deliberately reveals nothing about another account: a guest claimed by
 * somebody else answers `guest_already_claimed` with no counts, no date and no
 * account id. A guest with no profile or no results answers `no_progress`.
 */
export async function getClaimState(input: {
  userId: unknown;
  guestId: unknown;
}): Promise<GuestClaimState> {
  if (!isClerkUserId(input.userId) || !isGuestId(input.guestId)) {
    return { status: "invalid_identity" };
  }
  const userId = input.userId as string;
  const guestId = input.guestId as string;

  const [profile] = await db
    .select({ guestId: guestProfiles.guestId })
    .from(guestProfiles)
    .where(eq(guestProfiles.guestId, guestId))
    .limit(1);

  const [byGuest] = await db
    .select(CLAIM_COLUMNS)
    .from(guestClaims)
    .where(eq(guestClaims.guestId, guestId))
    .limit(1);

  if (byGuest) {
    if (byGuest.claimedByUserId === userId) {
      return {
        status: "claimed_by_you",
        claimedAt: toIso(byGuest.claimedAt),
        totals: claimRowToTotals(byGuest),
      };
    }
    return { status: "guest_already_claimed" };
  }

  const [byUser] = await db
    .select(CLAIM_COLUMNS)
    .from(guestClaims)
    .where(eq(guestClaims.claimedByUserId, userId))
    .limit(1);

  if (byUser) {
    return { status: "account_already_claimed", claimedAt: toIso(byUser.claimedAt) };
  }

  if (!profile) return { status: "no_progress" };

  const totals = await resultTotals(db, guestId);
  if (totals.matches === 0) return { status: "no_progress" };

  return { status: "unclaimed", totals };
}
