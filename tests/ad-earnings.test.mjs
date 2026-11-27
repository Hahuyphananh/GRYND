/**
 * Ad earnings — integration contract.
 *
 * The Operations dashboard adds up what HilltopAds, ExoClick and Adcash report.
 * These tests pin the properties that make that number trustworthy:
 *
 *   1. money is parsed once into integer minor units and summed as integers,
 *   2. totals are grouped by currency and never converted,
 *   3. a provider that is unconfigured, failed or answered in an unknown shape
 *      contributes NOTHING and is labelled — it is never reported as zero,
 *   4. each adapter speaks the documented request of its network,
 *   5. credentials never appear in a result, and the surface is admin-only.
 *
 * Run: npm run test:earnings
 */

import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  earningsRange,
  emptyProvider,
  isIsoDay,
  normalizeCurrency,
  parseCount,
  parseMoneyToCents,
  summarizeProvider,
  totalByCurrency,
} from "../src/lib/advertising/earnings/types.ts";
import {
  buildEarningsReport,
  loadAdEarnings,
  resetEarningsCache,
} from "../src/lib/advertising/earnings/index.ts";
import {
  fetchAdcashEarnings,
  fetchExoclickEarnings,
  fetchHilltopEarnings,
} from "../src/lib/advertising/earnings/providers.ts";

const read = (path) => fs.readFileSync(path, "utf8");
const ROUTE = read("src/app/api/admin/ad-earnings/route.ts");
const PANEL = read("src/components/admin/AdEarningsPanel.tsx");
const OPERATIONS = read("src/app/admin/operations/page.tsx");

// ── Harness ────────────────────────────────────────────────────────────────

const originalFetch = globalThis.fetch;
let calls = [];

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch(handler) {
  calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  calls = [];
});

function withEnv(values, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(values)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const restore = () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  try {
    const result = fn();
    return result instanceof Promise ? result.finally(restore) : (restore(), result);
  } catch (error) {
    restore();
    throw error;
  }
}

const RANGE = earningsRange(2, new Date("2026-11-26T00:00:00Z"));

// ── Money and ranges ───────────────────────────────────────────────────────

test("money is exact: decimals parse to integer cents, junk is refused", () => {
  assert.equal(parseMoneyToCents("183.98"), 18398);
  assert.equal(parseMoneyToCents(0.1 + 0.2), 30);
  assert.equal(parseMoneyToCents("0"), 0);
  assert.equal(parseMoneyToCents("-1"), null, "negative revenue is not a measurement");
  assert.equal(parseMoneyToCents("abc"), null);
  assert.equal(parseMoneyToCents(""), null);
  assert.equal(parseMoneyToCents(null), null);
  assert.equal(parseCount("1200"), 1200);
  assert.equal(parseCount(-5), null);
  assert.equal(parseCount(undefined), null);
});

test("the window is inclusive, UTC, and clamped to the documented maximum", () => {
  const now = new Date("2026-11-26T23:00:00Z");
  assert.deepEqual(earningsRange(7, now), {
    from: "2026-11-20",
    to: "2026-11-26",
    days: 7,
  });
  assert.equal(earningsRange(1, now).from, "2026-11-26");
  assert.equal(earningsRange(1000, now).days, 120, "Adcash caps at 120 days");
  assert.equal(earningsRange(0, now).days, 1);
  assert.equal(isIsoDay("2026-02-30"), false, "a non-existent day is not a day");
  assert.equal(isIsoDay("2026-11-26"), true);
  assert.equal(normalizeCurrency(" eur "), "EUR");
  assert.equal(normalizeCurrency("euro"), null);
});

// ── Aggregation never invents a number ────────────────────────────────────

test("a provider that did not report contributes nothing and is never zero-filled", () => {
  const ok = summarizeProvider("adcash", "EUR", [
    { provider: "adcash", date: "2026-11-25", revenueCents: 1234, impressions: 100, clicks: 2 },
    { provider: "adcash", date: "2026-11-26", revenueCents: 766, impressions: 50, clicks: 1 },
  ]);
  const failed = emptyProvider("exoclick", "error", "http-500");
  const unconfigured = emptyProvider("hilltop", "not_configured", "key missing");

  assert.equal(ok.status, "ok");
  assert.equal(ok.revenueCents, 2000);
  assert.equal(ok.rows.length, 2);

  const totals = totalByCurrency([ok, failed, unconfigured]);
  assert.equal(totals.length, 1);
  assert.deepEqual(totals[0], {
    currency: "EUR",
    revenueCents: 2000,
    impressions: 150,
    clicks: 3,
    providers: ["adcash"],
  });
});

test("different currencies are totalled separately, never converted", () => {
  const eur = summarizeProvider("exoclick", "EUR", [
    { provider: "exoclick", date: "2026-11-26", revenueCents: 500, impressions: 10, clicks: 0 },
  ]);
  const usd = summarizeProvider("hilltop", "USD", [
    { provider: "hilltop", date: "2026-11-26", revenueCents: 900, impressions: 20, clicks: 1 },
  ]);

  const totals = totalByCurrency([eur, usd]);
  assert.deepEqual(
    totals.map((total) => [total.currency, total.revenueCents]),
    [
      ["USD", 900],
      ["EUR", 500],
    ],
  );

  const report = buildEarningsReport(RANGE, [eur, usd]);
  assert.equal(report.singleCurrency, false);
  assert.equal(report.totals.length, 2);
  assert.deepEqual(
    report.providers.map((provider) => provider.provider),
    ["hilltop", "exoclick", "adcash"],
    "every network is always listed, including one that did not report",
  );
});

// ── Adcash ─────────────────────────────────────────────────────────────────

test("Adcash exchanges its reporting token, then asks for daily earnings", async () => {
  await withEnv(
    { ADCASH_REPORTING_API_TOKEN: "adcash-secret", ADCASH_REPORTING_BASE_URL: undefined },
    async () => {
      stubFetch((url) => {
        if (url.endsWith("/auth/token")) {
          return json({ data: { access_token: "access-1", token_type: "Bearer" } });
        }
        if (url.includes("/publishers/reports")) {
          return json({
            data: {
              rows: [
                { date: "2026-11-25", earnings: "12.34", impressions: 1000, clicks: 3 },
                { date: "2026-11-26", earnings: "7.66", impressions: 500, clicks: 1 },
              ],
            },
            meta: { currency: "EUR", timezone: "Europe/Paris" },
          });
        }
        return json({ error: { message: "unexpected", code: 6 } }, 404);
      });

      const result = await fetchAdcashEarnings(RANGE);

      assert.equal(result.status, "ok");
      assert.equal(result.currency, "EUR");
      assert.equal(result.revenueCents, 2000);
      assert.equal(result.impressions, 1500);
      assert.equal(result.clicks, 4);

      assert.equal(calls.length, 2);
      assert.equal(calls[0].url, "https://adcash.myadcash.com/api/v2/auth/token");
      assert.deepEqual(JSON.parse(calls[0].init.body), { api_token: "adcash-secret" });

      const reportUrl = new URL(calls[1].url);
      assert.equal(reportUrl.pathname, "/api/v2/publishers/reports");
      assert.equal(reportUrl.searchParams.get("start_date"), RANGE.from);
      assert.equal(reportUrl.searchParams.get("end_date"), RANGE.to);
      assert.equal(reportUrl.searchParams.get("group_by"), "date");
      assert.equal(calls[1].init.headers.authorization, "Bearer access-1");

      assert.ok(!JSON.stringify(result).includes("adcash-secret"), "the token never leaves");
    },
  );
});

// ── ExoClick ───────────────────────────────────────────────────────────────

test("ExoClick logs in, then requests publisher statistics by date", async () => {
  await withEnv(
    { EXOCLICK_REPORTING_API_TOKEN: "exo-secret", EXOCLICK_REPORTING_CURRENCY: "eur" },
    async () => {
      stubFetch((url) => {
        if (url.endsWith("/login")) return json({ token: "session-1", type: "Bearer" });
        if (url.endsWith("/statistics/p/global")) {
          return json({
            result: [
              {
                revenue: 5.5,
                impressions: 10,
                clicks: 1,
                group_by: { date: { date: "2026-11-26" } },
              },
            ],
          });
        }
        return json({}, 404);
      });

      const result = await fetchExoclickEarnings(RANGE);

      assert.equal(result.status, "ok");
      assert.equal(result.currency, "EUR", "declared account currency, upper-cased");
      assert.equal(result.revenueCents, 550);

      assert.equal(calls[0].url, "https://api.exoclick.com/v2/login");
      assert.deepEqual(JSON.parse(calls[0].init.body), { api_token: "exo-secret" });

      const body = JSON.parse(calls[1].init.body);
      assert.deepEqual(body.filter, { date_from: RANGE.from, date_to: RANGE.to });
      assert.deepEqual(body.group_by, ["date"]);
      assert.equal(calls[1].init.headers.authorization, "Bearer session-1");
      assert.ok(!JSON.stringify(result).includes("exo-secret"));
    },
  );
});

test("ExoClick without a declared currency is not reported as zero", async () => {
  await withEnv(
    {
      EXOCLICK_REPORTING_API_TOKEN: "exo-secret",
      EXOCLICK_REPORTING_CURRENCY: undefined,
    },
    async () => {
      stubFetch(() => {
        throw new Error("no request may be made without a currency");
      });
      const result = await fetchExoclickEarnings(RANGE);
      assert.equal(result.status, "not_configured");
      assert.match(result.reason, /EXOCLICK_REPORTING_CURRENCY/);
      assert.equal(calls.length, 0, "an unlabelable figure is not even fetched");
    },
  );
});

// ── HilltopAds ─────────────────────────────────────────────────────────────

test("HilltopAds asks its publisher statistics endpoint for a daily window", async () => {
  await withEnv(
    { HILLTOP_REPORTING_API_KEY: "ht-secret", HILLTOP_REPORTING_CURRENCY: "USD" },
    async () => {
      stubFetch((url) => {
        assert.match(url, /^https:\/\/api\.hilltopads\.com\/publisher\/listStats\?/);
        return json([
          { date: "2026-11-25", revenue: "1.25", impressions: 5, clicks: 0 },
          { date: "2026-11-26", revenue: "0.75", impressions: 5, clicks: 2 },
        ]);
      });

      const result = await fetchHilltopEarnings(RANGE);

      assert.equal(result.status, "ok");
      assert.equal(result.currency, "USD");
      assert.equal(result.revenueCents, 200);
      assert.equal(result.clicks, 2);

      const query = new URL(calls[0].url).searchParams;
      assert.equal(query.get("key"), "ht-secret");
      assert.equal(query.get("date"), RANGE.from);
      assert.equal(query.get("date2"), RANGE.to);
      assert.equal(query.get("group"), "date");
      assert.ok(!JSON.stringify(result).includes("ht-secret"));
    },
  );
});

test("an unrecognised provider response fails closed instead of reading as zero", async () => {
  await withEnv(
    { HILLTOP_REPORTING_API_KEY: "ht-secret", HILLTOP_REPORTING_CURRENCY: "USD" },
    async () => {
      stubFetch(() => json({ unexpected: { shape: true } }));
      const result = await fetchHilltopEarnings(RANGE);
      assert.equal(result.status, "unexpected-response");
      assert.equal(result.revenueCents, 0);
      assert.ok(result.reason);
    },
  );
});

test("an HTTP failure is an error, not a zero-revenue day", async () => {
  await withEnv({ ADCASH_REPORTING_API_TOKEN: "adcash-secret" }, async () => {
    stubFetch(() => json({ error: { message: "nope" } }, 500));
    const result = await fetchAdcashEarnings(RANGE);
    assert.equal(result.status, "error");
    assert.match(result.reason, /http-500/);
    assert.equal(result.rows.length, 0);
  });
});

test("an unconfigured host makes no request at all", async () => {
  await withEnv(
    {
      ADCASH_REPORTING_API_TOKEN: undefined,
      EXOCLICK_REPORTING_API_TOKEN: undefined,
      HILLTOP_REPORTING_API_KEY: undefined,
    },
    async () => {
      stubFetch(() => {
        throw new Error("no request may be made without a credential");
      });
      const [adcash, exoclick, hilltop] = await Promise.all([
        fetchAdcashEarnings(RANGE),
        fetchExoclickEarnings(RANGE),
        fetchHilltopEarnings(RANGE),
      ]);
      assert.equal(adcash.status, "not_configured");
      assert.equal(exoclick.status, "not_configured");
      assert.equal(hilltop.status, "not_configured");
      assert.equal(calls.length, 0);
    },
  );
});

// ── Caching ────────────────────────────────────────────────────────────────

test("the report is cached per window, so three APIs are not polled per view", async () => {
  await withEnv(
    {
      ADCASH_REPORTING_API_TOKEN: undefined,
      EXOCLICK_REPORTING_API_TOKEN: undefined,
      HILLTOP_REPORTING_API_KEY: undefined,
    },
    async () => {
      resetEarningsCache();
      stubFetch(() => {
        throw new Error("unconfigured providers make no request");
      });
      const first = await loadAdEarnings(7);
      const second = await loadAdEarnings(7);
      assert.equal(first, second, "the cached report object is reused");
      assert.equal(first.days, 7);
      assert.equal(first.providers.length, 3);
      resetEarningsCache();
    },
  );
});

// ── Admin surface ──────────────────────────────────────────────────────────

test("the earnings route is admin-only and never cached by the browser", () => {
  assert.match(ROUTE, /await auth\(\)/);
  assert.match(ROUTE, /await isAdmin\(userId\)/);
  assert.match(ROUTE, /Cache-Control": "no-store"/);
  assert.match(ROUTE, /loadAdEarnings\(days\)/);
  assert.match(ROUTE, /Math\.min\(120, Math\.max\(1, value\)\)/);
});

test("the Operations page renders the panel, and the panel holds no secrets", () => {
  assert.match(OPERATIONS, /import AdEarningsPanel from/);
  assert.match(OPERATIONS, /<AdEarningsPanel \/>/);
  assert.match(PANEL, /\/api\/admin\/ad-earnings\?days=/);
  assert.ok(!/process\.env/.test(PANEL), "a client component must not read server env");
  assert.ok(!/REPORTING_(API_TOKEN|API_KEY)/.test(PANEL), "no credential name in the browser");
});
