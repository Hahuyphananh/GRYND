// src/lib/auth/requireAgeVerified.ts
//
// Server-side 18+ gate for game / wagering API routes.
//
// WHY THIS EXISTS: the page middleware (src/proxy.ts) only guards page
// NAVIGATIONS. Every /api/* path is listed as public there, so an API request
// never reaches the middleware age gate. Any route that starts a game, takes a
// wager, submits a move, or moves the economy must therefore verify the caller
// itself.
//
// AUTHORITATIVE SOURCE: the server-written `users.age` column, which is written
// only by /api/update-birthdate (and which itself rejects invalid dates,
// under-18, and over-120). Request input is never consulted. The lookup reuses
// the middleware's cache key so both gates agree.
//
// LEGACY GRANDFATHERING: accounts created before LEGACY_CUTOFF predate age
// collection entirely — no DOB was ever requested at sign-up, so there is no
// record to check. Rather than lock those players out, the gate allows them and
// logs that it did. This is deliberately NOT a backfill: no age is invented, so
// "unverified legacy account" stays distinguishable from "verified adult".
// It never applies to an account with a recorded age (and in particular never
// rescues a recorded under-18 age), and it shrinks on its own as users complete
// /complete-profile. The page middleware is intentionally left alone, so a
// legacy user navigating to a game is still prompted for a DOB — the exemption
// is a safety net for in-flight sessions and direct API calls, not a way to
// avoid ever collecting the data.
//
// ROLLOUT — controlled by API_AGE_GATE:
//   "enforce" (default) — reject with 401/403/503.
//   "log"               — decide as usual, log what WOULD be rejected, allow.
//   "off"               — skip the age check entirely.
//
// Authentication is NEVER governed by that flag: even "off"/"log" return 401
// for a signed-out caller. The flag only relaxes the AGE portion, so it can
// never silently downgrade a route to unauthenticated.
//
// NOTE: results are plain objects rather than discriminated unions on purpose.
// This repo compiles with `strict: false`, where narrowing a union on a boolean
// literal discriminant doesn't work as expected.

import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { users } from "../../db/schema";
import { cacheGet, cacheSet } from "../redis/cache";
import { CacheKeys, CacheTTL } from "../redis/keys";
import { MINIMUM_AGE } from "../ageVerification";
import { withTimeout } from "../security/withTimeout";

export type AgeGateMode = "off" | "log" | "enforce";

export type AgeGateFailureReason =
  | "unauthenticated"
  | "missing_age"
  | "underage"
  | "age_lookup_failed";

export type AgeGateFailure = {
  status: 401 | 403 | 503;
  error: string;
  reason: AgeGateFailureReason;
};

export type AgeGateResult = {
  ok: boolean;
  /** The verified Clerk user id when `ok`, otherwise null. */
  userId: string | null;
  /** The rejection to surface when not `ok`, otherwise null. */
  failure: AgeGateFailure | null;
};

/** How long to wait for the age lookup before treating it as unavailable. */
const AGE_LOOKUP_TIMEOUT_MS = 1500;

/** Identity sentinel: distinguishes "never settled" from "no age on file". */
const NOT_SETTLED = { age: null, createdAt: null };

/**
 * Accounts created before this instant are grandfathered (see file header).
 *
 * End-of-day on the date the gate shipped, so that literally every account in
 * existence at rollout is covered — using midnight would have excluded accounts
 * created earlier the same day. Override with LEGACY_AGE_GATE_CUTOFF (ISO
 * string), or set it to "off" once the legacy population has supplied a DOB.
 *
 * Caveat: `users.created_at` is a `timestamp WITHOUT time zone` written by
 * `defaultNow()`, so its stored offset depends on the DB session timezone.
 * A few hours of skew is irrelevant for a policy cutoff, which is why this is a
 * date rather than a precise instant.
 */
const DEFAULT_LEGACY_CUTOFF = "2026-09-19T00:00:00.000Z";

let warnedUnknownMode = false;

/**
 * Resolve the rollout mode. Unset or unrecognised values fall back to
 * "enforce" — fail secure, never fail open, on a typo'd env var.
 */
export function getAgeGateMode(): AgeGateMode {
  const raw = (process.env.API_AGE_GATE || "").trim().toLowerCase();
  if (raw === "off" || raw === "log" || raw === "enforce") return raw;

  if (raw !== "" && !warnedUnknownMode) {
    warnedUnknownMode = true;
    console.warn(`[age-gate] unrecognised API_AGE_GATE="${raw}" — falling back to "enforce".`);
  }
  return "enforce";
}

/**
 * The legacy cutoff, or null when grandfathering is disabled.
 *
 * An unparseable override falls back to the default rather than silently
 * disabling the exemption — a typo shouldn't lock out every legacy account.
 */
export function getLegacyAgeCutoff(): Date | null {
  const raw = (process.env.LEGACY_AGE_GATE_CUTOFF || "").trim();
  if (raw.toLowerCase() === "off") return null;

  const value = raw || DEFAULT_LEGACY_CUTOFF;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    console.warn(
      `[age-gate] unparseable LEGACY_AGE_GATE_CUTOFF="${raw}" — using the default cutoff.`,
    );
    return new Date(DEFAULT_LEGACY_CUTOFF);
  }
  return parsed;
}

/** True when `createdAt` predates the legacy cutoff. */
export function isLegacyAccount(createdAt: Date | string | null | undefined): boolean {
  const cutoff = getLegacyAgeCutoff();
  if (cutoff === null) return false;
  if (!createdAt) return false; // unknown creation time -> don't exempt

  const created = createdAt instanceof Date ? createdAt : new Date(createdAt);
  if (Number.isNaN(created.getTime())) return false;

  return created.getTime() < cutoff.getTime();
}

/** Cap on distinct grandfathered users logged per process instance. */
const MAX_LOGGED_GRANDFATHERS = 500;
const loggedGrandfathers = new Set<string>();

function logGrandfatheredOnce(userId: string, createdAt: Date | string | null) {
  if (loggedGrandfathers.size >= MAX_LOGGED_GRANDFATHERS) return;
  if (loggedGrandfathers.has(userId)) return;
  loggedGrandfathers.add(userId);

  const created = createdAt instanceof Date ? createdAt.toISOString() : String(createdAt);
  console.warn(
    `[age-gate] grandfathered legacy account user=${userId} createdAt=${created} — send to /complete-profile`,
  );
}

type AgeLookup = {
  /** The caller's age, or null when there is no age record. */
  age: number | null;
  /** When the account was created, used only for the legacy exemption. */
  createdAt: Date | null;
  /** True when the lookup never settled — an outage, not a missing record. */
  failed: boolean;
};

/**
 * Read the caller's age from the cache, falling back to the DB.
 *
 * Keeps "no age record on file" distinct from "the lookup never completed" so
 * an outage can't be reported as (or mistaken for) a missing age record.
 */
async function lookupAge(userId: string): Promise<AgeLookup> {
  try {
    const cached = await cacheGet<number>(CacheKeys.userAge(userId));
    if (typeof cached === "number" && Number.isFinite(cached)) {
      // A cached age is by definition a real record, so createdAt is unneeded.
      return { age: cached, createdAt: null, failed: false };
    }
  } catch {
    // A cache error is not fatal — fall through to the authoritative DB.
  }

  // Normalise "no row" to a fresh object so identity tells it apart from the
  // NOT_SETTLED sentinel below.
  const row = await withTimeout(
    db
      .select({ age: users.age, createdAt: users.createdAt })
      .from(users)
      .where(eq(users.clerkId, userId))
      .limit(1)
      .then((rows) => rows[0] ?? { age: null, createdAt: null }),
    AGE_LOOKUP_TIMEOUT_MS,
    NOT_SETTLED,
  );

  if (row === NOT_SETTLED) {
    console.warn(`[age-gate] age lookup did not settle for user=${userId}`);
    return { age: null, createdAt: null, failed: true };
  }

  const age = row.age;
  const createdAt = row.createdAt ?? null;

  if (age === null || age === undefined || !Number.isFinite(Number(age))) {
    return { age: null, createdAt, failed: false };
  }

  try {
    await cacheSet(CacheKeys.userAge(userId), age, CacheTTL.userAge);
  } catch {
    // Non-fatal: caching is an optimisation, the DB remains the source.
  }

  return { age: Number(age), createdAt, failed: false };
}

/** Map an age lookup onto the failure it warrants, or null when allowed. */
function failureFor(lookup: AgeLookup): AgeGateFailure | null {
  if (lookup.failed) {
    return { status: 503, error: "Age verification unavailable", reason: "age_lookup_failed" };
  }
  if (lookup.age === null) {
    return { status: 403, error: "Age verification required", reason: "missing_age" };
  }
  if (lookup.age < MINIMUM_AGE) {
    return { status: 403, error: "Must be 18+", reason: "underage" };
  }
  return null;
}

/**
 * Framework-free core check. `userId` may be supplied by a caller that already
 * authenticated the request (e.g. a socket handler), skipping the Clerk call.
 */
export async function resolveAgeGate(userId?: string): Promise<AgeGateResult> {
  let resolvedUserId = userId;
  if (!resolvedUserId) {
    const session = await auth();
    resolvedUserId = session.userId ?? undefined;
  }

  if (!resolvedUserId) {
    return {
      ok: false,
      userId: null,
      failure: { status: 401, error: "Unauthorized", reason: "unauthenticated" },
    };
  }

  const mode = getAgeGateMode();
  if (mode === "off") {
    return { ok: true, userId: resolvedUserId, failure: null };
  }

  const lookup = await lookupAge(resolvedUserId);

  // Legacy exemption: no age on record AND the account predates age collection.
  // Checked before failureFor so it can't be reported as a missing record.
  // `failed` is excluded so a lookup outage is never dressed up as "legacy".
  if (lookup.age === null && !lookup.failed && isLegacyAccount(lookup.createdAt)) {
    logGrandfatheredOnce(resolvedUserId, lookup.createdAt);
    return { ok: true, userId: resolvedUserId, failure: null };
  }

  const failure = failureFor(lookup);
  if (failure === null) {
    return { ok: true, userId: resolvedUserId, failure: null };
  }

  // Shadow mode: report what enforcement WOULD do, but let the request through
  // so the rollout can be measured without affecting real players.
  if (mode === "log") {
    console.warn(
      `[age-gate] would reject user=${resolvedUserId} reason=${failure.reason} status=${failure.status}`,
    );
    return { ok: true, userId: resolvedUserId, failure: null };
  }

  return { ok: false, userId: null, failure };
}

/** JSON response for a failed gate. Standard `Response`, so it works anywhere. */
export function ageGateResponse(failure: AgeGateFailure): Response {
  return Response.json(
    { success: false, error: failure.error, reason: failure.reason },
    { status: failure.status },
  );
}

/**
 * Route-handler helper — the call site used by game APIs:
 *
 *   const gate = await requireAgeVerifiedUser();
 *   if (gate.response) return gate.response;
 */
export async function requireAgeVerifiedUser(): Promise<{
  response: Response | null;
  userId: string | null;
}> {
  const result = await resolveAgeGate();
  if (result.failure) {
    return { response: ageGateResponse(result.failure), userId: null };
  }
  return { response: null, userId: result.userId };
}
