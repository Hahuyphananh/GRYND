// src/lib/advertising/earnings/providers.ts
//
// SERVER-ONLY adapters for the three publisher reporting APIs.
//
// Every credential is read from a server environment variable and is never
// returned, logged or embedded in a reason string. Each adapter fails closed:
// an unconfigured host reports `not_configured`, a failed request reports
// `error`, and a response this module cannot read reports
// `unexpected-response` — never zero revenue, which would look like a real
// number on the dashboard.
//
// ── CONTRACTS (from each network's own documentation) ─────────────────────
//
// ADCASH — Publisher Reporting API v2
//   POST {base}/auth/token          {"api_token": "…"}   → {data:{access_token}}
//   GET  {base}/publishers/reports  start_date, end_date, group_by=date
//        Authorization: Bearer <access_token>
//   Response rows carry `earnings` (decimal string) and the currency in
//   `meta.currency`. Tokens live 15 minutes; 60 requests/minute.
//   https://support.adcash.com/en/articles/424-publisher-reporting-api-v-2
//
// EXOCLICK — Public API v2
//   POST https://api.exoclick.com/v2/login  {"api_token": "…"} → {token, type}
//   POST https://api.exoclick.com/v2/statistics/p/global
//        {filter:{date_from,date_to}, group_by:["date"], projection:{base:["*"]}}
//   Publisher rows carry `revenue`, `impressions`, `clicks` and
//   `group_by.date.date`. ExoClick does not return a currency on this route, so
//   the account currency must be declared with EXOCLICK_REPORTING_CURRENCY
//   (statistics are rate limited to 30/min per IP).
//
// HILLTOPADS — Publisher API
//   GET https://api.hilltopads.com/publisher/listStats
//       key, date, date2, group=date
//   HilltopAds publishes the request but NOT the response schema. This adapter
//   therefore reads the documented-by-convention revenue/impressions/clicks
//   field names defensively and fails closed (`unexpected-response`) when it
//   cannot find a revenue field or a day, rather than inventing a mapping.

import {
  emptyProvider,
  isIsoDay,
  normalizeCurrency,
  parseCount,
  parseMoneyToCents,
  summarizeProvider,
  type EarningsProviderId,
  type EarningsRange,
  type EarningsRow,
  type ProviderEarnings,
} from "./types";

const REQUEST_TIMEOUT_MS = 7_000;

export const ADCASH_DEFAULT_BASE_URL = "https://adcash.myadcash.com/api/v2";
export const EXOCLICK_API_BASE_URL = "https://api.exoclick.com/v2";
export const HILLTOP_API_BASE_URL = "https://api.hilltopads.com";

function env(name: string): string | null {
  const value = (process.env[name] ?? "").trim();
  return value ? value : null;
}

interface JsonResult {
  ok: boolean;
  body?: unknown;
  /** A short, non-secret diagnostic when `ok` is false. */
  reason?: string;
}

/** One bounded JSON request. Never throws. */
async function requestJson(url: string, init: RequestInit): Promise<JsonResult> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    // Deliberately no URL/error text: a tag URL can carry a token.
    return { ok: false, reason: "request-failed" };
  }

  if (!response.ok) {
    return { ok: false, reason: `http-${response.status}` };
  }

  try {
    return { ok: true, body: (await response.json()) as unknown };
  } catch {
    return { ok: false, reason: "invalid-json" };
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function arrayAt(value: unknown, ...path: string[]): unknown[] | null {
  let current: unknown = value;
  for (const key of path) {
    const parent = record(current);
    if (!parent) return null;
    current = parent[key];
  }
  return Array.isArray(current) ? current : null;
}

/** The first present field from a list of candidate names. */
function pick(source: Record<string, unknown>, names: readonly string[]): unknown {
  for (const name of names) {
    if (source[name] !== undefined) return source[name];
  }
  return undefined;
}

// ── Adcash ──────────────────────────────────────────────────────────────────

export async function fetchAdcashEarnings(range: EarningsRange): Promise<ProviderEarnings> {
  const token = env("ADCASH_REPORTING_API_TOKEN");
  if (!token) {
    return emptyProvider("adcash", "not_configured", "ADCASH_REPORTING_API_TOKEN is not set");
  }

  const base = (env("ADCASH_REPORTING_BASE_URL") ?? ADCASH_DEFAULT_BASE_URL).replace(/\/+$/, "");

  const auth = await requestJson(`${base}/auth/token`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ api_token: token }),
  });
  if (!auth.ok) return emptyProvider("adcash", "error", `auth:${auth.reason ?? "request-failed"}`);

  const accessToken = record(record(auth.body)?.data)?.access_token;
  if (typeof accessToken !== "string" || !accessToken) {
    return emptyProvider("adcash", "unexpected-response", "auth:no-access-token");
  }

  const query = new URLSearchParams({
    start_date: range.from,
    end_date: range.to,
    group_by: "date",
  });
  const report = await requestJson(`${base}/publishers/reports?${query.toString()}`, {
    method: "GET",
    headers: { accept: "application/json", authorization: `Bearer ${accessToken}` },
  });
  if (!report.ok) return emptyProvider("adcash", "error", `report:${report.reason ?? "request-failed"}`);

  const currency = normalizeCurrency(record(record(report.body)?.meta)?.currency);
  const rows = arrayAt(report.body, "data", "rows");
  if (!rows) return emptyProvider("adcash", "unexpected-response", "report:no-rows");

  const parsed: EarningsRow[] = [];
  let unreadable = 0;

  for (const raw of rows) {
    const row = record(raw);
    if (!row) {
      unreadable += 1;
      continue;
    }
    const revenue = parseMoneyToCents(pick(row, ["earnings", "revenue"]));
    const day = row.date ?? row.day;
    const date = isIsoDay(day)
      ? day
      : rows.length === 1
        ? range.to
        : null;
    if (revenue === null || !date) {
      unreadable += 1;
      continue;
    }
    parsed.push({
      provider: "adcash",
      date,
      revenueCents: revenue,
      impressions: parseCount(row.impressions),
      clicks: parseCount(row.clicks),
    });
  }

  if (parsed.length === 0) {
    return emptyProvider(
      "adcash",
      "unexpected-response",
      unreadable > 0 ? "report:unreadable-rows" : "report:no-reportable-rows",
      currency,
    );
  }

  const summary = summarizeProvider("adcash", currency, parsed);
  return {
    ...summary,
    ...(unreadable > 0 ? { reason: `${unreadable}-row(s)-unreadable` } : {}),
  };
}

// ── ExoClick ────────────────────────────────────────────────────────────────

export async function fetchExoclickEarnings(range: EarningsRange): Promise<ProviderEarnings> {
  const token = env("EXOCLICK_REPORTING_API_TOKEN");
  if (!token) {
    return emptyProvider("exoclick", "not_configured", "EXOCLICK_REPORTING_API_TOKEN is not set");
  }

  // The statistics route does not return a currency, so the account's
  // reporting currency has to be declared. Without it the revenue figure would
  // be unlabelable, and an unlabelled amount cannot be added to anything.
  const currency = normalizeCurrency(env("EXOCLICK_REPORTING_CURRENCY"));
  if (!currency) {
    return emptyProvider(
      "exoclick",
      "not_configured",
      "EXOCLICK_REPORTING_CURRENCY is not set (the statistics API returns no currency)",
    );
  }

  const login = await requestJson(`${EXOCLICK_API_BASE_URL}/login`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ api_token: token }),
  });
  if (!login.ok) return emptyProvider("exoclick", "error", `login:${login.reason ?? "request-failed"}`, currency);

  const loginBody = record(login.body);
  const sessionToken = loginBody?.token;
  const tokenType = typeof loginBody?.type === "string" ? loginBody.type : "Bearer";
  if (typeof sessionToken !== "string" || !sessionToken) {
    return emptyProvider("exoclick", "unexpected-response", "login:no-session-token", currency);
  }

  const stats = await requestJson(`${EXOCLICK_API_BASE_URL}/statistics/p/global`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: `${tokenType} ${sessionToken}`,
    },
    body: JSON.stringify({
      filter: { date_from: range.from, date_to: range.to },
      group_by: ["date"],
      order_by: [{ field: "date", order: "asc" }],
      projection: { base: ["*"], video: ["*"] },
    }),
  });
  if (!stats.ok) return emptyProvider("exoclick", "error", `stats:${stats.reason ?? "request-failed"}`, currency);

  const rows = arrayAt(stats.body, "result");
  if (!rows) return emptyProvider("exoclick", "unexpected-response", "stats:no-result", currency);

  const parsed: EarningsRow[] = [];
  let unreadable = 0;

  for (const raw of rows) {
    const row = record(raw);
    if (!row) {
      unreadable += 1;
      continue;
    }
    const revenue = parseMoneyToCents(row.revenue);
    const date = record(row.group_by);
    const day = record(date?.date)?.date;
    if (revenue === null || !isIsoDay(day)) {
      unreadable += 1;
      continue;
    }
    parsed.push({
      provider: "exoclick",
      date: day,
      revenueCents: revenue,
      impressions: parseCount(row.impressions),
      clicks: parseCount(row.clicks),
    });
  }

  if (parsed.length === 0) {
    return emptyProvider(
      "exoclick",
      "unexpected-response",
      unreadable > 0 ? "stats:unreadable-rows" : "stats:no-reportable-rows",
      currency,
    );
  }

  const summary = summarizeProvider("exoclick", currency, parsed);
  return {
    ...summary,
    ...(unreadable > 0 ? { reason: `${unreadable}-row(s)-unreadable` } : {}),
  };
}

// ── HilltopAds ──────────────────────────────────────────────────────────────

export async function fetchHilltopEarnings(range: EarningsRange): Promise<ProviderEarnings> {
  const key = env("HILLTOP_REPORTING_API_KEY");
  if (!key) {
    return emptyProvider("hilltop", "not_configured", "HILLTOP_REPORTING_API_KEY is not set");
  }

  const currency = normalizeCurrency(env("HILLTOP_REPORTING_CURRENCY"));
  if (!currency) {
    return emptyProvider(
      "hilltop",
      "not_configured",
      "HILLTOP_REPORTING_CURRENCY is not set (the statistics API returns no currency)",
    );
  }

  const query = new URLSearchParams({
    key,
    date: range.from,
    date2: range.to,
    group: "date",
  });
  const stats = await requestJson(`${HILLTOP_API_BASE_URL}/publisher/listStats?${query.toString()}`, {
    method: "GET",
    headers: { accept: "application/json" },
  });
  if (!stats.ok) return emptyProvider("hilltop", "error", `stats:${stats.reason ?? "request-failed"}`, currency);

  const body = record(stats.body);
  const rows =
    (Array.isArray(stats.body) ? stats.body : null) ??
    arrayAt(stats.body, "data") ??
    arrayAt(stats.body, "stats") ??
    arrayAt(stats.body, "result") ??
    // A keyed object such as {"2026-11-20": {...}} is also a common shape.
    (body
      ? Object.entries(body)
          .filter(([day]) => isIsoDay(day))
          .map(([day, value]) => ({ date: day, ...(record(value) ?? {}) }))
      : null);

  if (!rows) return emptyProvider("hilltop", "unexpected-response", "stats:no-rows", currency);

  const parsed: EarningsRow[] = [];
  let unreadable = 0;

  for (const raw of rows) {
    const row = record(raw);
    if (!row) {
      unreadable += 1;
      continue;
    }
    // Revenue field names are read tolerantly because HilltopAds does not
    // publish a response schema; if none of them is present the provider is
    // reported unreadable instead of contributing a fabricated zero.
    const revenue = parseMoneyToCents(
      pick(row, ["revenue", "earnings", "income", "profit", "amount"]),
    );
    const day = pick(row, ["date", "day"]);
    if (revenue === null || !isIsoDay(day)) {
      unreadable += 1;
      continue;
    }
    parsed.push({
      provider: "hilltop",
      date: day,
      revenueCents: revenue,
      impressions: parseCount(pick(row, ["impressions", "views", "shows"])),
      clicks: parseCount(row.clicks),
    });
  }

  if (parsed.length === 0) {
    return emptyProvider(
      "hilltop",
      "unexpected-response",
      unreadable > 0 ? "stats:unreadable-rows" : "stats:no-reportable-rows",
      currency,
    );
  }

  const summary = summarizeProvider("hilltop", currency, parsed);
  return {
    ...summary,
    ...(unreadable > 0 ? { reason: `${unreadable}-row(s)-unreadable` } : {}),
  };
}

/** The adapter for one provider. */
export function fetchProviderEarnings(
  provider: EarningsProviderId,
  range: EarningsRange,
): Promise<ProviderEarnings> {
  switch (provider) {
    case "adcash":
      return fetchAdcashEarnings(range);
    case "exoclick":
      return fetchExoclickEarnings(range);
    case "hilltop":
      return fetchHilltopEarnings(range);
  }
}
