// src/app/api/learn/coaching/route.ts
//
// POST /api/learn/coaching
//
// The GRYND PRO coaching report: analytics, weak-area detection, recommendations
// and a deterministic daily plan, built from the player's own device-local
// learning record.
//
// ── ACCESS CONTROL ────────────────────────────────────────────────────────
//
// This is a PRO surface and the gate is SERVER-SIDE, mirroring
// /api/stats/performance:
//
//   * the caller must be signed in (401 otherwise);
//   * membership is resolved from the caller's own subscription row through the
//     platform's existing authoritative check (`getMembershipTier`, the same one
//     /api/membership/status, the ad entitlement and the performance dashboard
//     use). There is no `isPro`/`premium` request field, header or cookie in
//     this file: a client cannot claim membership;
//   * a NON-member gets a 200 with `{ pro: false, locked: true }` and NO report
//     of any kind. Only the locked explanation keys and the upgrade URL are
//     returned, so hiding the UI is not what protects the analytics;
//   * an unreadable membership state is a 503, never "free": a member who paid
//     must not be shown an upsell because the database was slow.
//
// ── DATA ──────────────────────────────────────────────────────────────────
//
// Learning progress is device-local (lessonProgress.ts / practiceProgress.ts),
// so the client posts the sanitized snapshot it already holds. This route never
// reads a match, an opponent, a hidden card or another account's data: the
// snapshot ids are all checked against the authored lesson/practice catalogs by
// `sanitizeCoachingSnapshot`, and every number in the report is derived from
// that sanitized snapshot. Nothing is written to the database — this endpoint is
// read-only and needs no migration.
//
// The response is `private, no-store`: one player's report must never be cached
// for another request.

import { auth } from "@clerk/nextjs/server";

import {
  COACHING_BENEFIT_KEYS,
  COACHING_UPGRADE_URL,
  buildCoachingReport,
  sanitizeCoachingSnapshot,
} from "../../../../lib/learn/coaching";
import { consumeRateLimit } from "../../../../lib/security/rateLimit";
import { withTimeout } from "../../../../lib/security/withTimeout";
import {
  getMembershipTier,
  type MembershipTier,
} from "../../../../lib/stripe/subscriptions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Bound on the entitlement read, as on every other PRO surface. */
const MEMBERSHIP_LOOKUP_TIMEOUT_MS = 3_000;

/** A sanitized snapshot is small; anything larger is refused, not parsed. */
const MAX_BODY_BYTES = 64 * 1024;

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

function lockedPayload() {
  return {
    success: true,
    pro: false,
    locked: true,
    upgradeUrl: COACHING_UPGRADE_URL,
    benefitKeys: COACHING_BENEFIT_KEYS,
    freeNoteKey: "learn.coaching.locked.note",
  };
}

export async function POST(request: Request) {
  const { userId } = await auth();
  if (!userId) {
    return Response.json(
      { success: false, error: "Unauthorized" },
      { status: 401, headers: NO_STORE },
    );
  }

  const rateLimit = await consumeRateLimit(`learn-coaching:${userId}`, {
    windowMs: 60_000,
    max: 30,
  });
  if (!rateLimit.allowed) {
    return Response.json(
      { success: false, error: "Too many requests, please try again later" },
      {
        status: 429,
        headers: {
          ...NO_STORE,
          "Retry-After": String(
            Math.max(1, Math.ceil((rateLimit.resetAt - Date.now()) / 1000)),
          ),
        },
      },
    );
  }

  // The entitlement check runs BEFORE the body is read: a free caller cannot
  // make this route parse, sanitize or analyse anything.
  let pro = false;
  let membershipUnavailable = false;
  try {
    const tier = await withTimeout<MembershipTier | null>(
      getMembershipTier(userId),
      MEMBERSHIP_LOOKUP_TIMEOUT_MS,
      null,
    );
    pro = tier === "pro";
    membershipUnavailable = tier === null;
    if (membershipUnavailable) {
      console.error("[learn/coaching] Membership lookup timed out");
    }
  } catch (error) {
    console.error("[learn/coaching] Failed to resolve membership:", error);
    pro = false;
    membershipUnavailable = true;
  }

  if (membershipUnavailable) {
    return Response.json(
      {
        success: false,
        error: "Unable to verify your membership right now. Please try again.",
      },
      { status: 503, headers: { ...NO_STORE, "Retry-After": "5" } },
    );
  }

  if (!pro) {
    // Locked: the explanation the page renders, and nothing else. No totals,
    // no skill breakdown, no history, no plan.
    return Response.json(lockedPayload(), { headers: NO_STORE });
  }

  const declaredLength = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return Response.json(
      { success: false, error: "Learning record is too large" },
      { status: 413, headers: NO_STORE },
    );
  }

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return Response.json(
      { success: false, error: "Invalid request body" },
      { status: 400, headers: NO_STORE },
    );
  }
  if (raw.length > MAX_BODY_BYTES) {
    return Response.json(
      { success: false, error: "Learning record is too large" },
      { status: 413, headers: NO_STORE },
    );
  }

  let body: unknown;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    return Response.json(
      { success: false, error: "Invalid request body" },
      { status: 400, headers: NO_STORE },
    );
  }

  // Accept either the wrapper the UI sends or a bare snapshot. The sanitizer is
  // the same in both cases: unknown ids are dropped, counts clamped and the
  // aggregates recomputed from the per-exercise buckets.
  const snapshotInput =
    body && typeof body === "object" && !Array.isArray(body) && "snapshot" in body
      ? (body as { snapshot: unknown }).snapshot
      : body;

  try {
    const report = buildCoachingReport(
      sanitizeCoachingSnapshot(snapshotInput),
      new Date(),
    );
    return Response.json(
      { success: true, pro: true, locked: false, report },
      { headers: NO_STORE },
    );
  } catch (error) {
    console.error("[learn/coaching] Failed to build the report:", error);
    return Response.json(
      { success: false, error: "Unable to build your coaching report" },
      { status: 500, headers: NO_STORE },
    );
  }
}
