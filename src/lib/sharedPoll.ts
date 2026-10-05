"use client";

// ── Cross-tab shared-fetch primitives ────────────────────────────────────
//
// Pure, DOM-free helpers behind `useSharedPoll`. They are separated out so the
// (subtle) time/lease arithmetic can be unit-tested without a browser, and so
// every consumer of the shared scheduler reasons about "is a fetch due?"
// identically.
//
// The problem they solve: every open GRYND tab ran its OWN interval for the
// same cheap-but-not-free reads (live stats, friend presence, active-player
// counts) and its own presence heartbeat write. Five tabs meant five requests
// per tick for data that is identical across all of them. These helpers let a
// browser collapse that to ONE request per tick, shared to the other tabs.

/** Fraction of the interval that counts as "another tab just did it". */
export const SHARED_POLL_SLACK = 0.8;

/** The minimal `localStorage` surface used here, so tests can pass a fake. */
export interface PollStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Parse a stored epoch-ms stamp. Anything unusable reads as 0 (never). */
export function parseStamp(raw: string | null | undefined): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * True when `lastAt` is recent enough that re-fetching now would duplicate
 * work another tab (or this one) already did within `intervalMs * slack`.
 * `intervalMs <= 0` is never fresh, so a misconfigured caller still fetches.
 */
export function isFresh(
  lastAt: number,
  now: number,
  intervalMs: number,
  slack = SHARED_POLL_SLACK,
): boolean {
  if (!lastAt || intervalMs <= 0) return false;
  return now - lastAt < intervalMs * slack;
}

/**
 * Try to claim the shared fetch slot for `key`.
 *
 * Returns `true` when THIS tab should perform the fetch — and, as a side
 * effect, records the claim so other tabs see it as fresh and skip. Returns
 * `false` when someone already did it recently.
 *
 * Storage failures degrade to "claim" (always fetch): a browser that blocks
 * localStorage must keep working, just without the cross-tab saving.
 */
export function claimFetchSlot(
  storage: PollStorage | null | undefined,
  key: string,
  now: number,
  intervalMs: number,
  slack = SHARED_POLL_SLACK,
): boolean {
  if (!storage) return true;
  try {
    const last = parseStamp(storage.getItem(key));
    if (isFresh(last, now, intervalMs, slack)) return false;
    storage.setItem(key, String(now));
    return true;
  } catch {
    return true;
  }
}

/**
 * True when the leader lease for `key` is free (expired, or never taken).
 * A leader renews its lease every tick, so an expired lease means the leader
 * tab was hidden/closed and another tab should take over.
 */
export function leaseIsFree(
  storage: PollStorage | null | undefined,
  key: string,
  now: number,
): boolean {
  if (!storage) return true;
  try {
    return parseStamp(storage.getItem(key)) <= now;
  } catch {
    return true;
  }
}

/** Take/renew the leader lease for `key` until `now + ttlMs`. */
export function renewLease(
  storage: PollStorage | null | undefined,
  key: string,
  now: number,
  ttlMs: number,
): void {
  if (!storage) return;
  try {
    storage.setItem(key, String(now + Math.max(0, ttlMs)));
  } catch {
    // Storage unavailable — the caller degrades to per-tab polling.
  }
}

/**
 * The browser's `localStorage`, or null where it is unavailable (SSR, private
 * mode, storage disabled). Never throws. Callers that only need the leader
 * lease pass the result straight to the helpers above; a null store degrades to
 * "this tab is the leader" so nothing ever stops working.
 */
export function getPollStorage(): PollStorage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}
