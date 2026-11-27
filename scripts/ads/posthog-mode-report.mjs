#!/usr/bin/env node
// scripts/ads/posthog-mode-report.mjs
//
// Ad performance by GAME MODE, queried from PostHog with HogQL.
//
// `ad_mode` is the bounded dimension the ad reporting layer sends for every
// post-match event (solo, daily, puzzle-daily, puzzle-unlimited, puzzle-ranked,
// puzzle-ai, puzzle-strategic). This script answers the two questions a
// publisher actually has:
//
//   * how many impressions does each mode produce?
//   * how often does a request for that mode end in a fill?
//
// It reads credentials from the environment, never accepts a key as an argument
// (arguments end up in shell history and process lists):
//
//   POSTHOG_PERSONAL_API_KEY   personal API key with `query:read` (phx_…)
//   POSTHOG_PROJECT_ID         numeric project id
//   POSTHOG_HOST               app host, e.g. https://us.posthog.com
//                              (an ingest host like us.i.posthog.com is
//                              normalised to the app host)
//
// Usage:
//   node scripts/ads/posthog-mode-report.mjs [--days 30] [--json]
//   node --env-file=/home/ubuntu/grynd/env/app.env scripts/ads/posthog-mode-report.mjs
//
// The query is read-only. A missing credential or a refused query exits 1 with
// one line — it never prints the key.

const EVENTS = [
  "ad_request",
  "ad_fill",
  "ad_no_fill",
  "ad_timeout",
  "ad_blocked",
  "ad_error",
  "ad_impression",
  "ad_video_start",
  "ad_video_complete",
];

/**
 * PostHog serves the query API from the app host, but the in-app client uses an
 * ingest host (`us.i.posthog.com`). Strip the ingest prefix so a copied ingest
 * URL still works.
 */
export function normalizePosthogHost(raw) {
  const value = String(raw ?? "").trim() || "https://us.posthog.com";
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`POSTHOG_HOST is not a URL: ${value}`);
  }
  if (url.protocol !== "https:") throw new Error("POSTHOG_HOST must be https");
  url.hostname = url.hostname.replace(/\.i\.posthog\.com$/, ".posthog.com");
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

/** The exact HogQL. Exported so the test can assert the filters. */
export function buildModeQuery(days = 30) {
  const window = Number.isInteger(days) && days > 0 && days <= 365 ? days : 30;
  return `
SELECT
    coalesce(nullIf(properties.ad_mode, ''), 'untagged') AS mode,
    countIf(event = 'ad_request') AS requests,
    countIf(event = 'ad_fill') AS fills,
    countIf(event IN ('ad_no_fill', 'ad_timeout')) AS no_fills,
    countIf(event = 'ad_blocked') AS blocked,
    countIf(event = 'ad_error') AS errors,
    countIf(event = 'ad_impression') AS impressions,
    countIf(event = 'ad_video_start') AS starts,
    countIf(event = 'ad_video_complete') AS completes,
    round(countIf(event = 'ad_fill') / nullIf(countIf(event = 'ad_request'), 0) * 100, 1) AS fill_rate_pct,
    round(countIf(event = 'ad_impression') / nullIf(countIf(event = 'ad_fill'), 0) * 100, 1) AS play_rate_pct
FROM events
WHERE timestamp >= now() - INTERVAL ${window} DAY
  AND properties.placement = 'post-match'
  AND event IN (${EVENTS.map((event) => `'${event}'`).join(", ")})
GROUP BY mode
ORDER BY impressions DESC, requests DESC
`.trim();
}

/** Render the result rows as a compact markdown table. */
export function formatReport(rows, { days = 30 } = {}) {
  const lines = [
    `Post-match ad performance by mode — last ${days} days`,
    "",
    "| mode | requests | fills | fill rate | no fill | blocked | errors | impressions | starts | completes | play rate |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  let total = { requests: 0, fills: 0, impressions: 0, completes: 0 };
  const n = (value) => Number(value) || 0;
  const pct = (value) => (value == null ? "—" : `${value}%`);

  for (const row of rows) {
    const requests = n(row.requests);
    const fills = n(row.fills);
    const impressions = n(row.impressions);
    const completes = n(row.completes);
    total = {
      requests: total.requests + requests,
      fills: total.fills + fills,
      impressions: total.impressions + impressions,
      completes: total.completes + completes,
    };
    lines.push(
      `| ${row.mode ?? "untagged"} | ${requests} | ${fills} | ${pct(row.fill_rate_pct)} | ${n(row.no_fills)} | ${n(row.blocked)} | ${n(row.errors)} | ${impressions} | ${n(row.starts)} | ${completes} | ${pct(row.play_rate_pct)} |`,
    );
  }

  const rate = (part, whole) => (whole > 0 ? `${Math.round((part / whole) * 1000) / 10}%` : "—");
  lines.push(
    `| **all modes** | ${total.requests} | ${total.fills} | ${rate(total.fills, total.requests)} | | | | ${total.impressions} | | ${total.completes} | ${rate(total.completes, total.impressions)} |`,
  );
  lines.push(
    "",
    "fill rate = ad_fill / ad_request; play rate = ad_impression / ad_fill. `untagged` means an event arrived without `ad_mode` (older builds, or a surface that does not pass one).",
  );
  return lines.join("\n");
}

async function queryPosthog({ host, projectId, key, query, fetchImpl = fetch }) {
  const response = await fetchImpl(`${host}/api/projects/${projectId}/query/`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: { kind: "HogQLQuery", query }, name: "GRYND ad performance by mode" }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = body?.detail || body?.error || `HTTP ${response.status}`;
    throw new Error(`PostHog query refused: ${String(detail).slice(0, 300)}`);
  }
  return body;
}

/** Turn the HogQL result (`columns` + `results`) into objects. */
export function rowsFromResult(body) {
  const columns = body?.columns;
  const results = body?.results;
  if (!Array.isArray(columns) || !Array.isArray(results)) {
    throw new Error("PostHog returned an unexpected result shape");
  }
  return results.map((row) => Object.fromEntries(columns.map((column, index) => [column, row[index]])));
}

function parseArgs(argv) {
  const options = { days: 30, json: false };
  for (const arg of argv) {
    if (arg === "--json") options.json = true;
    else if (arg.startsWith("--days=")) options.days = Number(arg.slice("--days=".length));
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`unknown argument ${arg}`);
  }
  if (!Number.isInteger(options.days) || options.days <= 0 || options.days > 365) {
    throw new Error("--days must be an integer between 1 and 365");
  }
  return options;
}

export async function runReport(argv = process.argv.slice(2), { env = process.env, fetchImpl = fetch } = {}) {
  const options = parseArgs(argv);
  if (options.help) return { help: true };

  const key = String(env.POSTHOG_PERSONAL_API_KEY ?? "").trim();
  const projectId = String(env.POSTHOG_PROJECT_ID ?? "").trim();
  if (!key) throw new Error("POSTHOG_PERSONAL_API_KEY is not set");
  if (!/^[0-9]{1,12}$/.test(projectId)) throw new Error("POSTHOG_PROJECT_ID is not a numeric project id");

  const host = normalizePosthogHost(env.POSTHOG_HOST || env.NEXT_PUBLIC_POSTHOG_HOST);
  const query = buildModeQuery(options.days);
  const body = await queryPosthog({ host, projectId, key, query, fetchImpl });
  const rows = rowsFromResult(body);
  return { rows, days: options.days, json: options.json };
}

const invokedDirectly = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) {
  try {
    const result = await runReport();
    if (result.help) {
      console.log("node scripts/ads/posthog-mode-report.mjs [--days 30] [--json]");
    } else if (result.json) {
      console.log(JSON.stringify(result.rows, null, 2));
    } else {
      console.log(formatReport(result.rows, { days: result.days }));
    }
  } catch (error) {
    console.error(`posthog-mode-report: ${error.message}`);
    process.exit(1);
  }
}
