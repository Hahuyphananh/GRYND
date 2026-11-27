// src/lib/ads/core/order.ts
//
// CONFIGURABLE PROVIDER PRIORITY.
//
// The order lives in environment variables, not in this file:
//
//   NEXT_PUBLIC_ADS_BANNER_ORDER=hilltop,exoclick,adcash
//   NEXT_PUBLIC_ADS_VIDEO_ORDER=hilltop,exoclick,adcash
//
// Both are public by design: the order is not a secret, and the browser needs
// it to run the banner chain. Unknown tokens are ignored, duplicates are
// collapsed, and an empty/invalid list falls back to the built-in order. A
// provider therefore cannot be enabled by listing it here — eligibility still
// requires its switch, its zone/tag and (for banners) an approved placement.
//
// Reordering is a deploy-time change, not a code change.

import { AD_PROVIDERS, type AdProviderId } from "./types";

export const DEFAULT_AD_ORDER: readonly AdProviderId[] = [
  "hilltop",
  "exoclick",
  "adcash",
  "adexchange",
];

/** Parses a comma-separated priority list. First occurrence wins. */
export function parseProviderOrder(
  raw: string | null | undefined,
  fallback: readonly AdProviderId[] = DEFAULT_AD_ORDER,
): AdProviderId[] {
  const parsed: AdProviderId[] = [];
  const seen = new Set<string>();

  for (const token of (raw ?? "").split(",")) {
    const id = token.trim().toLowerCase();
    if (!id || seen.has(id)) continue;
    if (!(AD_PROVIDERS as readonly string[]).includes(id)) continue;
    seen.add(id);
    parsed.push(id as AdProviderId);
  }

  return parsed.length > 0 ? parsed : [...fallback];
}

/** The banner priority, read at build time by Next. */
export function bannerProviderOrder(): AdProviderId[] {
  return parseProviderOrder(process.env.NEXT_PUBLIC_ADS_BANNER_ORDER);
}

/** The post-match video priority, read at build time by Next. */
export function videoProviderOrder(): AdProviderId[] {
  return parseProviderOrder(process.env.NEXT_PUBLIC_ADS_VIDEO_ORDER);
}

/**
 * Keeps the configured priority but drops providers the caller knows are not
 * eligible (disabled, unconfigured, wrong placement, refused consent).
 *
 * Eligibility is a predicate, never a second hard-coded order.
 */
export function eligibleProviders(
  order: readonly AdProviderId[],
  isEligible: (id: AdProviderId) => boolean,
): AdProviderId[] {
  return order.filter((id) => isEligible(id));
}

// ── ROTATION ────────────────────────────────────────────────────────────────
//
// A fixed priority means the first configured provider wins every opportunity
// it can fill, so a second provider is only ever used as a fallback — and
// HilltopAds additionally loads AT MOST ONCE per tab, which starves every later
// banner in that tab. `NEXT_PUBLIC_ADS_ROTATION=false` turns this off; the
// default is on.
//
// The rotation is derived from the OPPORTUNITY id, not from a clock or a
// counter: the same opportunity always yields the same order, so a React
// remount, a re-render or a double-effect cannot reorder an in-flight chain or
// make a retry land on a different provider. Different document loads, slots
// and matches get different ids, so over time the first provider alternates.
//
// Rotation only re-orders the eligible list. It cannot enable a provider:
// switches, configuration, placement and consent still filter first.

function switchOn(value: string | undefined, fallback = true): boolean {
  const raw = (value ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === "false" || raw === "0" || raw === "off" || raw === "no") return false;
  return raw === "true" || raw === "1" || raw === "on" || raw === "yes";
}

/** Rotation is on unless an operator explicitly disables it. */
export function adRotationEnabled(): boolean {
  return switchOn(process.env.NEXT_PUBLIC_ADS_ROTATION);
}

/** FNV-1a, 32-bit. Deterministic, cheap and good enough to spread ids. */
function stableHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** A stable rotation offset in `[0, length)`. Empty/single lists do not turn. */
export function rotationOffset(key: string, length: number): number {
  if (!Number.isInteger(length) || length <= 1) return 0;
  if (!key) return 0;
  return stableHash(key) % length;
}

/** Rotates a list left by `offset`, wrapping. The input is never mutated. */
export function rotateProviderOrder(
  order: readonly AdProviderId[],
  offset: number,
): AdProviderId[] {
  if (order.length <= 1) return [...order];
  const shift = ((Math.trunc(offset) % order.length) + order.length) % order.length;
  return [...order.slice(shift), ...order.slice(0, shift)];
}

/**
 * The eligible order rotated for one opportunity. With rotation disabled, or a
 * disabled chance, the configured order is returned unchanged.
 */
export function rotatedProviderOrder(
  order: readonly AdProviderId[],
  key: string,
): AdProviderId[] {
  if (order.length <= 1) return [...order];
  if (!adRotationEnabled()) return [...order];
  return rotateProviderOrder(order, rotationOffset(key, order.length));
}
