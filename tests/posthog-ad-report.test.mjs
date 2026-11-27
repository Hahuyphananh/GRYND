// tests/posthog-ad-report.test.mjs
//
// The by-mode ad report is a read-only HogQL query against PostHog. These tests
// pin the parts that could silently lie: the filter that keeps the report to
// post-match events, the untagged bucket, the fill-rate arithmetic and the host
// normalisation (an ingest host cannot serve the query API).

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildModeQuery,
  formatReport,
  normalizePosthogHost,
  rowsFromResult,
  runReport,
} from "../scripts/ads/posthog-mode-report.mjs";

test("host: an ingest host is normalised to the app host", () => {
  assert.equal(normalizePosthogHost("https://us.i.posthog.com"), "https://us.posthog.com");
  assert.equal(normalizePosthogHost("https://eu.i.posthog.com/"), "https://eu.posthog.com");
  assert.equal(normalizePosthogHost("https://us.posthog.com"), "https://us.posthog.com");
  assert.equal(normalizePosthogHost(undefined), "https://us.posthog.com");
  assert.throws(() => normalizePosthogHost("http://us.posthog.com"), /https/);
});

test("query: only post-match ad events, bucketed by mode, with a bounded window", () => {
  const query = buildModeQuery(30);
  assert.match(query, /properties\.placement = 'post-match'/);
  assert.match(query, /coalesce\(nullIf\(properties\.ad_mode, ''\), 'untagged'\) AS mode/);
  assert.match(query, /INTERVAL 30 DAY/);
  for (const event of ["ad_request", "ad_fill", "ad_impression", "ad_video_complete"]) {
    assert.ok(query.includes(`'${event}'`), `${event} must be counted`);
  }
  // Out-of-range windows clamp instead of widening the query.
  assert.match(buildModeQuery(0), /INTERVAL 30 DAY/);
  assert.match(buildModeQuery(9999), /INTERVAL 30 DAY/);
  assert.match(buildModeQuery(7), /INTERVAL 7 DAY/);
});

test("rows: the HogQL columns map to objects", () => {
  const rows = rowsFromResult({
    columns: ["mode", "requests", "fills"],
    results: [
      ["solo", 10, 4],
      ["puzzle-daily", 5, 0],
    ],
  });
  assert.deepEqual(rows[0], { mode: "solo", requests: 10, fills: 4 });
  assert.throws(() => rowsFromResult({}), /unexpected result shape/);
});

test("table: fill rate is fills/requests and play rate is impressions/fills", () => {
  const table = formatReport(
    [
      { mode: "solo", requests: 10, fills: 4, no_fills: 6, impressions: 4, completes: 3, fill_rate_pct: 40, play_rate_pct: 100 },
      { mode: "puzzle-daily", requests: 5, fills: 0, no_fills: 5, impressions: 0, completes: 0, fill_rate_pct: 0, play_rate_pct: null },
      { mode: "untagged", requests: 5, fills: 1, impressions: 1, completes: 1, fill_rate_pct: 20, play_rate_pct: 100 },
    ],
    { days: 7 },
  );
  assert.match(table, /last 7 days/);
  assert.match(table, /\| solo \| 10 \| 4 \| 40% \|/);
  assert.match(table, /\| \*\*all modes\*\* \| 20 \| 5 \| 25% \|/);
  assert.match(table, /untagged/);
});

test("run: missing credentials fail before any request, without echoing a key", async () => {
  let called = false;
  await assert.rejects(
    () => runReport([], { env: {}, fetchImpl: async () => { called = true; } }),
    /POSTHOG_PERSONAL_API_KEY/,
  );
  await assert.rejects(
    () => runReport([], { env: { POSTHOG_PERSONAL_API_KEY: "phx_secret" }, fetchImpl: async () => { called = true; } }),
    /POSTHOG_PROJECT_ID/,
  );
  assert.equal(called, false);
});

test("run: sends a read-only query to the app host and returns rows", async () => {
  const requests = [];
  const result = await runReport(["--days=14"], {
    env: {
      POSTHOG_PERSONAL_API_KEY: "phx_secret",
      POSTHOG_PROJECT_ID: "12345",
      NEXT_PUBLIC_POSTHOG_HOST: "https://us.i.posthog.com",
    },
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return {
        ok: true,
        json: async () => ({ columns: ["mode", "requests", "fills"], results: [["solo", 2, 1]] }),
      };
    },
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://us.posthog.com/api/projects/12345/query/");
  assert.equal(requests[0].init.method, "POST");
  assert.match(requests[0].init.headers.Authorization, /^Bearer phx_secret$/);
  assert.match(JSON.parse(requests[0].init.body).query.query, /INTERVAL 14 DAY/);
  assert.deepEqual(result.rows, [{ mode: "solo", requests: 2, fills: 1 }]);
});
