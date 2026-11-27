// src/lib/advertising/earnings/types.ts
//
// The provider-neutral shape of an advertising earnings report.
//
// ── WHY MONEY IS IN MINOR UNITS, AND WHY THERE IS NO SINGLE TOTAL ─────────
//
// Provider APIs report revenue as a DECIMAL STRING or float in the account's
// own currency ("183.98"). Adding floats accumulates error, so every amount is
// converted once, at the edge, to integer minor units (cents) and only integers
// are summed.
//
// The three networks do not necessarily settle in the same currency: Adcash
// returns its currency in the response metadata, while ExoClick and HilltopAds
// report a bare number whose currency comes from the account. Summing euros and
// dollars would require an exchange rate, and this code does not know one — so
// totals are grouped BY CURRENCY and never converted. A report with one
// currency has one total; a report with two shows two.

export type EarningsProviderId = "hilltop" | "exoclick" | "adcash";

export const EARNINGS_PROVIDERS: readonly EarningsProviderId[] = [
  "hilltop",
  "exoclick",
  "adcash",
];

/**
 * `ok`                  at least one row was parsed
 * `not_configured`      no reporting credential on this host
 * `error`               the request failed (network, HTTP, auth, rate limit)
 * `unexpected-response` the API answered, but not in a shape this adapter can
 *                       read. It contributes NOTHING; it is never reported as
 *                       zero revenue.
 */
export type EarningsStatus = "ok" | "not_configured" | "error" | "unexpected-response";

/** One provider-day. `date` is YYYY-MM-DD in the provider's reporting date. */
export interface EarningsRow {
  provider: EarningsProviderId;
  date: string;
  revenueCents: number;
  impressions: number | null;
  clicks: number | null;
}

export interface ProviderEarnings {
  provider: EarningsProviderId;
  status: EarningsStatus;
  /** ISO 4217 code when the provider reported one or the host is told it. */
  currency: string | null;
  revenueCents: number;
  impressions: number | null;
  clicks: number | null;
  rows: EarningsRow[];
  /** Short, non-secret diagnostic. Never a URL, token or header value. */
  reason?: string;
  fetchedAt: string | null;
}

export interface EarningsTotal {
  currency: string;
  revenueCents: number;
  impressions: number;
  clicks: number;
  /** Providers that actually contributed to this currency's total. */
  providers: EarningsProviderId[];
}

export interface EarningsReport {
  /** Length of the window, in days, including today. */
  days: number;
  /** Inclusive UTC window the providers were asked for. */
  from: string;
  to: string;
  generatedAt: string;
  providers: ProviderEarnings[];
  totals: EarningsTotal[];
  /** False when providers reported different or unknown currencies. */
  singleCurrency: boolean;
}

export interface EarningsRange {
  from: string;
  to: string;
  days: number;
}

/** Today's UTC date as YYYY-MM-DD. */
export function utcDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function shiftUtcDay(day: string, deltaDays: number): string {
  const parsed = Date.parse(`${day}T00:00:00Z`);
  const base = Number.isFinite(parsed) ? parsed : Date.now();
  return new Date(base + deltaDays * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The inclusive window for `days` (1–120), ending today in UTC. Adcash caps a
 * request at 120 days before today, so the clamp lives here rather than in each
 * adapter.
 */
export function earningsRange(days: number, now: Date = new Date()): EarningsRange {
  const raw = Number.isFinite(days) ? Math.trunc(days) : 7;
  const bounded = Math.min(120, Math.max(1, raw));
  const to = utcDay(now);
  return { from: shiftUtcDay(to, -(bounded - 1)), to, days: bounded };
}

/** `"183.98"` → `18398`. Non-numeric, negative or non-finite values → null. */
export function parseMoneyToCents(value: unknown): number | null {
  const amount =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value.trim())
        : Number.NaN;
  if (!Number.isFinite(amount) || amount < 0) return null;
  return Math.round(amount * 100);
}

/** A non-negative integer, or null. Provider counts arrive as numbers/strings. */
export function parseCount(value: unknown): number | null {
  const amount =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value.trim())
        : Number.NaN;
  if (!Number.isFinite(amount) || amount < 0) return null;
  return Math.trunc(amount);
}

/** True for a real YYYY-MM-DD calendar day. Provider rows carry these. */
export function isIsoDay(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

/** A three-letter ISO 4217 code, upper-cased, or null. */
export function normalizeCurrency(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const code = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : null;
}

/** The empty per-provider result, used by every failure path. */
export function emptyProvider(
  provider: EarningsProviderId,
  status: EarningsStatus,
  reason?: string,
  currency: string | null = null,
): ProviderEarnings {
  return {
    provider,
    status,
    currency,
    revenueCents: 0,
    impressions: null,
    clicks: null,
    rows: [],
    ...(reason ? { reason } : {}),
    fetchedAt: null,
  };
}

/** Folds parsed rows into the provider's own totals. */
export function summarizeProvider(
  provider: EarningsProviderId,
  currency: string | null,
  rows: EarningsRow[],
): ProviderEarnings {
  const ordered = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  const impressions = ordered.some((row) => row.impressions !== null)
    ? ordered.reduce((sum, row) => sum + (row.impressions ?? 0), 0)
    : null;
  const clicks = ordered.some((row) => row.clicks !== null)
    ? ordered.reduce((sum, row) => sum + (row.clicks ?? 0), 0)
    : null;

  return {
    provider,
    status: ordered.length > 0 ? "ok" : "unexpected-response",
    currency,
    revenueCents: ordered.reduce((sum, row) => sum + row.revenueCents, 0),
    impressions,
    clicks,
    rows: ordered,
    ...(ordered.length > 0 ? {} : { reason: "no-reportable-rows" }),
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Groups provider results by currency and sums each group. A provider with no
 * currency (or no rows) contributes to no total, so an unavailable network can
 * never quietly deflate a number that looks authoritative.
 */
export function totalByCurrency(providers: readonly ProviderEarnings[]): EarningsTotal[] {
  const totals = new Map<string, EarningsTotal>();

  for (const provider of providers) {
    if (provider.status !== "ok" || !provider.currency) continue;
    const currency = provider.currency;
    const current =
      totals.get(currency) ??
      { currency, revenueCents: 0, impressions: 0, clicks: 0, providers: [] };

    current.revenueCents += provider.revenueCents;
    current.impressions += provider.impressions ?? 0;
    current.clicks += provider.clicks ?? 0;
    if (!current.providers.includes(provider.provider)) {
      current.providers.push(provider.provider);
    }
    totals.set(currency, current);
  }

  return [...totals.values()].sort((a, b) => b.revenueCents - a.revenueCents);
}
