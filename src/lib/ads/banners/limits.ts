// src/lib/ads/banners/limits.ts
//
// Bounded waits for the sequential banner chain.
//
// A single-provider banner used to hold its reserved area for 8 s. A chain of
// three must not multiply that: the per-provider deadline and the whole-chain
// budget are separate settings, both clamped, and the last provider only gets
// whatever time is left. If all of them fail, the reserved space collapses.

function intInRange(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = Number.parseInt((raw ?? "").trim(), 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

export const DEFAULT_BANNER_PROVIDER_TIMEOUT_MS = 3_500;
export const DEFAULT_BANNER_CHAIN_BUDGET_MS = 8_000;

/** One provider's fill deadline. */
export function bannerProviderTimeoutMs(): number {
  return intInRange(
    process.env.NEXT_PUBLIC_ADS_BANNER_PROVIDER_TIMEOUT_MS,
    DEFAULT_BANNER_PROVIDER_TIMEOUT_MS,
    1_500,
    8_000,
  );
}

/** The whole chain's budget, including every provider attempt. */
export function bannerChainBudgetMs(): number {
  return intInRange(
    process.env.NEXT_PUBLIC_ADS_BANNER_BUDGET_MS,
    DEFAULT_BANNER_CHAIN_BUDGET_MS,
    2_000,
    15_000,
  );
}

/** Post-match video chain budget. Existing 4 s single-tag deadline is the cap. */
export const DEFAULT_VIDEO_CHAIN_BUDGET_MS = 6_000;

export function videoChainBudgetMs(): number {
  return intInRange(
    process.env.NEXT_PUBLIC_ADS_VIDEO_BUDGET_MS,
    DEFAULT_VIDEO_CHAIN_BUDGET_MS,
    2_000,
    12_000,
  );
}
