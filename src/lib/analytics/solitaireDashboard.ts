// src/lib/analytics/solitaireDashboard.ts
//
// Server-only data layer for the Solitaire analytics dashboard.
//
// The event list is imported from `solitaire-analytics.ts`, so the dashboard
// can never drift from what the app actually emits: adding an event to the
// taxonomy adds a row here automatically.
//
// It talks to PostHog's Query API (HogQL) with a PERSONAL API key. That key
// must never reach the browser, so nothing here is imported by a client
// component — the admin route is the only caller.

import { SOLITAIRE_EVENTS } from "../solitaire-analytics";

export type DashboardRange = 7 | 30 | 90;
export const DASHBOARD_RANGES: readonly DashboardRange[] = [7, 30, 90];

export function parseRange(value: string | null): DashboardRange {
  const parsed = Number(value);
  return DASHBOARD_RANGES.includes(parsed as DashboardRange)
    ? (parsed as DashboardRange)
    : 30;
}

/** All recognised event names, in taxonomy order. */
export const DASHBOARD_EVENTS: readonly string[] = Object.values(SOLITAIRE_EVENTS);

const SAFE_EVENT = /^[a-z0-9_]{3,64}$/;

function sqlEventList(): string {
  return DASHBOARD_EVENTS.filter((name) => SAFE_EVENT.test(name))
    .map((name) => `'${name}'`)
    .join(", ");
}

export type DashboardConfig = {
  configured: boolean;
  projectId: string | null;
  host: string;
};

/** Which env vars are present — never returns their values. */
export function dashboardConfig(): DashboardConfig {
  const key = process.env.POSTHOG_PERSONAL_API_KEY || "";
  const projectId = process.env.POSTHOG_PROJECT_ID || "";
  return {
    configured: Boolean(key && projectId),
    projectId: projectId || null,
    host: process.env.POSTHOG_HOST || process.env.NEXT_PUBLIC_POSTHOG_HOST || "https://us.posthog.com",
  };
}

export type QueryResult = {
  ok: boolean;
  rows?: unknown[][];
  columns?: string[];
  error?: string;
};

/**
 * Run one HogQL query. Never throws: the dashboard shows an error banner rather
 * than taking the admin page down with a provider outage.
 */
export async function runHogQL(query: string, signal?: AbortSignal): Promise<QueryResult> {
  const key = process.env.POSTHOG_PERSONAL_API_KEY;
  const projectId = process.env.POSTHOG_PROJECT_ID;
  if (!key || !projectId) {
    return { ok: false, error: "PostHog Query API is not configured" };
  }
  const host = dashboardConfig().host.replace(/\/$/, "");
  try {
    const res = await fetch(`${host}/api/projects/${encodeURIComponent(projectId)}/query/`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: { kind: "HogQLQuery", query } }),
      signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return { ok: false, error: `PostHog returned ${res.status}${detail ? `: ${detail.slice(0, 180)}` : ""}` };
    }
    const json = (await res.json()) as { results?: unknown[][]; columns?: string[] };
    return { ok: true, rows: json.results ?? [], columns: json.columns ?? [] };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Query failed" };
  }
}

/** One query for totals per event. */
export function totalsQuery(days: DashboardRange): string {
  return [
    "SELECT event, count() AS total",
    "FROM events",
    `WHERE event IN (${sqlEventList()})`,
    `AND timestamp >= now() - INTERVAL ${days} DAY`,
    "GROUP BY event",
    "ORDER BY total DESC",
  ].join(" ");
}

/** One query for the daily series of the whole taxonomy. */
export function dailyQuery(days: DashboardRange): string {
  return [
    "SELECT toDate(timestamp) AS day, event, count() AS total",
    "FROM events",
    `WHERE event IN (${sqlEventList()})`,
    `AND timestamp >= now() - INTERVAL ${days} DAY`,
    "GROUP BY day, event",
    "ORDER BY day ASC",
  ].join(" ");
}

/** Property breakdowns that separate solo / daily / ranked / ai. */
export function modeQuery(days: DashboardRange): string {
  return [
    "SELECT properties.mode AS mode, count() AS total",
    "FROM events",
    `WHERE event IN (${sqlEventList()})`,
    `AND timestamp >= now() - INTERVAL ${days} DAY`,
    "GROUP BY mode",
    "ORDER BY total DESC",
  ].join(" ");
}

export type AnalyticsSnapshot = {
  configured: boolean;
  range: DashboardRange;
  generatedAt: string;
  totals: Record<string, number>;
  series: Array<{ day: string; event: string; total: number }>;
  modes: Array<{ mode: string | null; total: number }>;
  events: readonly string[];
  error?: string;
};

/**
 * Fetch everything the dashboard renders. PostHog being slow or down yields a
 * snapshot with `error` set and empty data — the page still loads.
 */
export async function loadAnalyticsSnapshot(range: DashboardRange): Promise<AnalyticsSnapshot> {
  const base: AnalyticsSnapshot = {
    configured: dashboardConfig().configured,
    range,
    generatedAt: new Date().toISOString(),
    totals: {},
    series: [],
    modes: [],
    events: DASHBOARD_EVENTS,
  };
  if (!base.configured) return base;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const [totals, series, modes] = await Promise.all([
      runHogQL(totalsQuery(range), controller.signal),
      runHogQL(dailyQuery(range), controller.signal),
      runHogQL(modeQuery(range), controller.signal),
    ]);

    if (!totals.ok) return { ...base, error: totals.error ?? "Query failed" };

    for (const row of totals.rows ?? []) {
      const [event, total] = row;
      if (typeof event === "string") base.totals[event] = Number(total) || 0;
    }
    if (series.ok) {
      base.series = (series.rows ?? [])
        .map(([day, event, total]) => ({
          day: String(day),
          event: String(event),
          total: Number(total) || 0,
        }))
        .filter((row) => row.day !== "null");
    }
    if (modes.ok) {
      base.modes = (modes.rows ?? []).map(([mode, total]) => ({
        mode: typeof mode === "string" ? mode : null,
        total: Number(total) || 0,
      }));
    }
    // A partial provider failure is worth surfacing, but not fatal.
    if (!series.ok || !modes.ok) {
      const problems: string[] = [];
      if (!series.ok && series.error) problems.push(series.error);
      if (!modes.ok && modes.error) problems.push(modes.error);
      base.error = problems.join(" · ") || "Partial query failure";
    }
    return base;
  } finally {
    clearTimeout(timeout);
  }
}
