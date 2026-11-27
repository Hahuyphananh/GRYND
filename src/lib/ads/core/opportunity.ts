// src/lib/ads/core/opportunity.ts
//
// ONE ID PER AD OPPORTUNITY, AND ONE SERVE PER ID.
//
// The chain is client-side, so the same placement can mount twice (React
// development double-effects, a client-side navigation that remounts the slot,
// a fast refresh). Two mounts asking two providers would both draw into the
// same page and could produce two impressions for one opportunity.
//
// Two layers guard that:
//
//   1. In-memory claim/serve sets keyed by opportunity id. A banner opportunity
//      id is stable for the DOCUMENT + placement, so a remount reuses it and
//      loses the claim. A refresh is a new document and therefore a genuinely
//      new opportunity.
//   2. A sessionStorage marker for the completed match, so replaying the same
//      result after a refresh cannot play a second video even if the existing
//      frequency record were lost. Storage failure only loses that extra guard;
//      the in-memory sets and the cadence still hold.

import type { AdKind } from "./types";

const VIDEO_SERVED_KEY = "grynd:adVideoServedMatches:v1";
const MAX_REMEMBERED_MATCHES = 25;

let pageViewId: string | null = null;
let fallbackCounter = 0;

/** A unique owner token for one mounted slot/player instance. */
export function newOpportunityOwner(): string {
  return `owner:${randomId()}`;
}

function randomId(): string {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === "function") {
    return cryptoObj.randomUUID();
  }
  fallbackCounter += 1;
  return `${Date.now().toString(36)}-${fallbackCounter}`;
}

function currentPageViewId(): string {
  if (!pageViewId) pageViewId = randomId();
  return pageViewId;
}

const claimed = new Map<string, string>();
const served = new Set<string>();

/** A banner opportunity is stable per document + placement. */
export function bannerOpportunityId(placement: string): string {
  return `banner:${placement}:${currentPageViewId()}`;
}

/** A video opportunity is stable per finished match, across the document. */
export function videoOpportunityId(matchId: string): string {
  return `video:${matchId}`;
}

export function createOpportunityId(kind: AdKind, key: string): string {
  return kind === "banner"
    ? `banner:${key}:${currentPageViewId()}`
    : `video:${key}`;
}

/**
 * Registers this attempt. False means the opportunity is already claimed by a
 * DIFFERENT owner or has already been served — the caller must render/request
 * nothing.
 *
 * `owner` lets one component instance re-enter after React's development
 * double-effect (same instance, same owner) while a second mounted instance is
 * still refused. Production remounts get a new owner and stay refused too.
 */
export function claimOpportunity(id: string, owner = "anonymous"): boolean {
  if (!id) return false;
  if (served.has(id)) return false;
  const current = claimed.get(id);
  if (current && current !== owner) return false;
  claimed.set(id, owner);
  return true;
}

/** Marks a creative as served; no fallback may run after this. */
export function markOpportunityServed(id: string): void {
  if (!id) return;
  served.add(id);
}

export function wasOpportunityServed(id: string): boolean {
  return served.has(id);
}

/** Test seam: a fresh document starts with no claims or serves. */
export function resetAdOpportunityState(): void {
  claimed.clear();
  served.clear();
  pageViewId = null;
  fallbackCounter = 0;
}

// ── Video: a served match survives a refresh in this tab ───────────────────

function videoStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage ?? null;
  } catch {
    return null;
  }
}

function readServedMatches(): string[] {
  const storage = videoStorage();
  if (!storage) return [];
  try {
    const raw = storage.getItem(VIDEO_SERVED_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}

/** True when this tab already played (or began) an ad for this match. */
export function wasMatchAdServed(matchId: string): boolean {
  if (!matchId) return false;
  return readServedMatches().includes(matchId);
}

/** Records a served match. Storage failure is swallowed: the cadence remains. */
export function markMatchAdServed(matchId: string): void {
  if (!matchId) return;
  const storage = videoStorage();
  if (!storage) return;
  try {
    const next = [matchId, ...readServedMatches().filter((id) => id !== matchId)].slice(
      0,
      MAX_REMEMBERED_MATCHES,
    );
    storage.setItem(VIDEO_SERVED_KEY, JSON.stringify(next));
  } catch {
    // Denied quota/storage: the in-memory and cadence guards still apply.
  }
}
