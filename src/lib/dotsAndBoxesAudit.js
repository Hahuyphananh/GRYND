// ─── Dots & Boxes anti-cheat audit log ────────────────────────────────
//
// Records every rejected/invalid action. Uses an in-memory counter keyed
// by (clerkId, gameId, action, reason) to suppress duplicate writes
// (cheap), and escalates to adminAuditLogs at fixed thresholds so a
// single attacker probing the API doesn't flood the DB.
//
// Threshold schedule: log on the 3rd attempt, the 10th, and every
// 25 thereafter. Counter entries decay after 60 seconds so attempts
// across many different games don't pile up to false-positive scrutiny.

import { db } from "../db/client";
import { adminAuditLogs } from "../db/schema";

const COUNTER_TTL_MS = 60_000;
const ESCALATION_THRESHOLDS = new Set([3, 10, 25, 50, 100, 250, 500]);

const counters = new Map(); // key -> { count, firstSeen, lastSeen }

function pruneOldEntries() {
  const now = Date.now();
  for (const [k, v] of counters.entries()) {
    if (now - v.lastSeen > COUNTER_TTL_MS) counters.delete(k);
  }
}

/**
 * Best-effort IP extraction from a Next.js Request headers object
 * (or undefined if not provided).
 */
function inferIp(headers) {
  if (!headers || typeof headers.get !== "function") return null;
  const candidates = [
    "x-forwarded-for",
    "x-real-ip",
    "cf-connecting-ip",
    "x-vercel-forwarded-for",
    "true-client-ip",
  ];
  for (const h of candidates) {
    const v = headers.get(h);
    if (v) return v.split(",")[0].trim();
  }
  return null;
}

/**
 * Record an invalid/suspicious action for a Dots & Boxes game.
 *
 * Always increments an in-memory counter. Only writes to
 * adminAuditLogs at fixed thresholds so a flood of probes costs
 * almost nothing server-side.
 */
export async function recordInvalidAction({
  clerkId,
  gameId,
  action,
  reason,
  headers,
}) {
  if (!clerkId || !action) return { count: 0, escalated: false };

  pruneOldEntries();

  const key = `${clerkId}|${gameId || "-"}|${action}|${reason}`;
  const now = Date.now();
  const entry = counters.get(key);

  if (!entry) {
    counters.set(key, { count: 1, firstSeen: now, lastSeen: now });
    return { count: 1, escalated: false };
  }

  entry.count += 1;
  entry.lastSeen = now;

  if (!ESCALATION_THRESHOLDS.has(entry.count)) {
    return { count: entry.count, escalated: false };
  }

  // ── Escalate to durable audit log ─────────────────────────────────
  try {
    await db.insert(adminAuditLogs).values({
      event: "dots-and-boxes:invalid",
      clerkId,
      targetClerkId: gameId ? `dots_and_boxes_games:${gameId}` : clerkId,
      details: {
        gameId: gameId ?? null,
        action,
        reason,
        attempts: entry.count,
        firstSeen: new Date(entry.firstSeen).toISOString(),
        lastSeen: new Date(entry.lastSeen).toISOString(),
        ip: inferIp(headers),
      },
    });
    return { count: entry.count, escalated: true };
  } catch (e) {
    // Never let audit failure crash the route — log to console for ops
    console.error("dotsAndBoxesAudit: failed to record invalid action", {
      key,
      err: e?.message,
    });
    return { count: entry.count, escalated: false };
  }
}

/**
 * For tests / ops: reset the in-memory counter map. Do NOT call in
 * production code paths.
 */
export function _resetDotsAndBoxesAuditCountersForTests() {
  counters.clear();
}
