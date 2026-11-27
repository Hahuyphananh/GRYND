// src/lib/advertising/earnings/index.ts
//
// SERVER-ONLY entry point for the admin earnings report.
//
// The three reporting APIs are rate limited (Adcash 60/min, ExoClick 30/min per
// IP) and the Operations page is read by humans, so the report is cached in
// process for five minutes and concurrent reads share one in-flight promise.
// A cached report is served as-is: this module never merges a fresh provider
// into a stale total, which would make a currency total internally inconsistent.
//
// Nothing here runs in the browser. Tokens live only in the server environment
// and are never part of the report.

import { fetchProviderEarnings } from "./providers";
import {
  EARNINGS_PROVIDERS,
  earningsRange,
  emptyProvider,
  totalByCurrency,
  type EarningsProviderId,
  type EarningsRange,
  type EarningsReport,
  type ProviderEarnings,
} from "./types";

export const EARNINGS_CACHE_TTL_MS = 5 * 60_000;

interface CacheEntry {
  at: number;
  report: EarningsReport;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<EarningsReport>>();

/** Builds the report from the provider results. Pure; exported for tests. */
export function buildEarningsReport(
  range: EarningsRange,
  providers: readonly ProviderEarnings[],
): EarningsReport {
  const totals = totalByCurrency(providers);
  const reported = providers.filter((provider) => provider.status === "ok");
  const singleCurrency =
    totals.length === 1 && reported.every((provider) => provider.currency !== null);

  return {
    days: range.days,
    from: range.from,
    to: range.to,
    generatedAt: new Date().toISOString(),
    // Every network is always listed. A provider the caller did not include is
    // shown as not-queried rather than silently omitted, so a missing row can
    // never be mistaken for "this network earned nothing".
    providers: EARNINGS_PROVIDERS.map(
      (id) =>
        providers.find((provider) => provider.provider === id) ??
        emptyProvider(id, "not_configured", "not-queried"),
    ),
    totals,
    singleCurrency,
  };
}

async function fetchAll(range: EarningsRange): Promise<EarningsReport> {
  const providers = await Promise.all(
    EARNINGS_PROVIDERS.map((provider: EarningsProviderId) =>
      // An adapter that throws is treated as a failed provider, never as a
      // missing row: the dashboard must show that a network could not answer.
      fetchProviderEarnings(provider, range).catch(() =>
        ({
          provider,
          status: "error",
          currency: null,
          revenueCents: 0,
          impressions: null,
          clicks: null,
          rows: [],
          reason: "adapter-threw",
          fetchedAt: null,
        }) satisfies ProviderEarnings,
      ),
    ),
  );

  return buildEarningsReport(range, providers);
}

/**
 * The report for the last `days` UTC days. Adcash caps its window at 120 days,
 * so the range is clamped there for every provider.
 */
export async function loadAdEarnings(days: number): Promise<EarningsReport> {
  const range = earningsRange(days);
  const key = `${range.from}:${range.to}`;

  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < EARNINGS_CACHE_TTL_MS) {
    return cached.report;
  }

  const running = inFlight.get(key);
  if (running) return running;

  const job = fetchAll(range).finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, job);

  const report = await job;
  cache.set(key, { at: Date.now(), report });

  // Keep the cache bounded: a handful of windows is all an operator can ask for.
  if (cache.size > 8) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) cache.delete(oldest[0]);
  }

  return report;
}

/** Test seam: forget every cached and in-flight report. */
export function resetEarningsCache(): void {
  cache.clear();
  inFlight.clear();
}
