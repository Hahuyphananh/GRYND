// src/lib/proStatus.ts
//
// WHO IS GRYND PRO, AND WHAT THAT LOOKS LIKE NEXT TO THEIR NAME.
//
// The membership used to be invisible: every benefit was private (no ads, more
// analysis, a queue tie-break). Competitive players pay for a membership they
// can be SEEN to hold, so this module answers exactly two questions for every
// social surface (chat, leaderboards, profile):
//
//   1. is this account an active member? — the same authoritative source every
//      other perk reads (`tokenSubscriptions` with an active status), resolved
//      in ONE batched query per page so a leaderboard does not fan out.
//   2. which badge does the account wear? — "FOUNDER" for a member who backed
//      the project during its founding window, "PRO" for everyone after.
//
// The badge is decoration, never authority: nothing in the product gates a
// match, a rating or a result on it, and the client cannot ask for one — the
// server decides and the markup is rendered from that answer.
//
// FOUNDERS ARE RECOGNISED BY WHEN THEY SUBSCRIBED, not by a field somebody can
// edit: the earliest active subscription row's `created_at` is compared with
// the founding window. A cancelled-and-resubscribed account keeps its original
// row (subscriptions are not deleted), so the recognition does not flicker.

import { eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { tokenSubscriptions } from "../db/schema";
import { ACTIVE_SUBSCRIPTION_STATUSES } from "./stripe/subscriptions";

/** The label worn by a member after the founding window. */
export const PRO_BADGE_LABEL = "PRO";

/** The label worn by a member who joined during the founding window. */
export const FOUNDER_BADGE_LABEL = "FOUNDER";

/** Tooltip/aria label — states what the badge means, for everyone. */
export const PRO_BADGE_TITLE =
  "GRYND PRO member — supporting independent competitive gaming";

export const FOUNDER_BADGE_TITLE =
  "GRYND PRO founder — one of the first players funding independent competitive gaming";

/**
 * The end of the founding window (exclusive), ISO-8601.
 *
 * Configurable because it is a product decision, not a constant of the code: an
 * operator can close or extend the founder window without a deploy. The default
 * is deliberately generous — every member who subscribes while the site is
 * small should be recognised for it.
 */
export const DEFAULT_FOUNDER_CUTOFF_ISO = "2027-01-01T00:00:00.000Z";

/** The founding window's end as epoch ms, or null when the value is unusable. */
export function founderCutoffMs(
  value: string | undefined = process.env.NEXT_PUBLIC_PRO_FOUNDER_CUTOFF,
): number | null {
  const raw = (value ?? "").trim() || DEFAULT_FOUNDER_CUTOFF_ISO;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : Date.parse(DEFAULT_FOUNDER_CUTOFF_ISO);
}

/**
 * "FOUNDER" or "PRO" for a subscription that started at `since`.
 *
 * A missing/unparsable start date is NOT a founder claim: an account with no
 * readable subscription history is shown the ordinary badge. Pure, so both the
 * server render and a test can call it.
 */
export function proBadgeFor(
  since: unknown,
  cutoffMs: number | null = founderCutoffMs(),
): { label: string; founder: boolean; title: string } {
  const startedMs =
    since instanceof Date ? since.getTime() : Date.parse(String(since ?? ""));
  const founder =
    cutoffMs != null && Number.isFinite(startedMs) && startedMs < cutoffMs;
  return founder
    ? { label: FOUNDER_BADGE_LABEL, founder: true, title: FOUNDER_BADGE_TITLE }
    : { label: PRO_BADGE_LABEL, founder: false, title: PRO_BADGE_TITLE };
}

/**
 * Every clerk id in `clerkIds` that holds an active GRYND PRO subscription.
 *
 * ONE query per page, regardless of how many names are on it, which is what
 * makes this affordable to call from a leaderboard render. Unknown ids are
 * simply absent from the set. A database failure throws, so a caller decides
 * whether that means "no badges" (decoration) rather than silently assuming
 * nobody is a member.
 */
export async function getProClerkIds(
  clerkIds: readonly (string | null | undefined)[],
): Promise<Set<string>> {
  const unique = Array.from(
    new Set(
      (clerkIds ?? []).filter(
        (id): id is string => typeof id === "string" && id.trim().length > 0,
      ),
    ),
  );
  const members = new Set<string>();
  if (unique.length === 0) return members;

  const rows = await db
    .select({
      clerkId: tokenSubscriptions.clerkId,
      status: tokenSubscriptions.status,
      createdAt: tokenSubscriptions.createdAt,
    })
    .from(tokenSubscriptions)
    .where(inArray(tokenSubscriptions.clerkId, unique));

  for (const row of rows) {
    if (!row?.clerkId) continue;
    if (!ACTIVE_SUBSCRIPTION_STATUSES.includes(row.status as never)) continue;
    members.add(row.clerkId);
  }
  return members;
}

/** The same answer for a single account (profile page, own settings). */
export async function isProMember(clerkId: string | null | undefined): Promise<boolean> {
  if (!clerkId) return false;
  return (await getProClerkIds([clerkId])).has(clerkId);
}

/**
 * WHICH badge one account wears, for surfaces that need the label rather than
 * a boolean (a shared result post, for instance).
 *
 * Same authority as everything else here — the account's own subscription rows
 * — and the founding rule is `proBadgeFor`, so the mark in a public post cannot
 * drift from the mark next to the player's name on the ladder. `null` means
 * "not a member", which callers render as "no badge" rather than an error.
 */
export async function getProBadgeFor(
  clerkId: string | null | undefined,
): Promise<{ label: string; founder: boolean } | null> {
  if (!clerkId) return null;

  const rows = await db
    .select({
      status: tokenSubscriptions.status,
      createdAt: tokenSubscriptions.createdAt,
    })
    .from(tokenSubscriptions)
    .where(eq(tokenSubscriptions.clerkId, clerkId));

  let earliestMs: number | null = null;
  for (const row of rows) {
    if (!ACTIVE_SUBSCRIPTION_STATUSES.includes(row?.status as never)) continue;
    const started = row?.createdAt;
    const ms = started instanceof Date ? started.getTime() : Date.parse(String(started ?? ""));
    if (!Number.isFinite(ms)) continue;
    if (earliestMs === null || ms < earliestMs) earliestMs = ms;
  }
  if (earliestMs === null) return null;

  const badge = proBadgeFor(earliestMs);
  return { label: badge.label, founder: badge.founder };
}
