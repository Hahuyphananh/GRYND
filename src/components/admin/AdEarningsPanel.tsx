"use client";

// src/components/admin/AdEarningsPanel.tsx
//
// Ad earnings on the admin Operations page.
//
// It renders ONLY what /api/admin/ad-earnings returned: per-provider revenue,
// impressions and clicks, and one total per currency. Three rules are visible
// in the UI because they are the honest ones:
//
//   * a provider that is not configured, failed, or answered in an unknown
//     shape is shown as such — never as $0.00, which would read as a real
//     measurement;
//   * currencies are never added together, because no exchange rate is known
//     here. A single-currency account sees one total; a mixed account sees one
//     total per currency;
//   * the report is a snapshot from the providers' reporting APIs (cached for
//     five minutes server-side), not a live impression count. Display networks
//     update their statistics with a delay.

import { useCallback, useEffect, useState } from "react";

interface ProviderEarnings {
  provider: string;
  status: "ok" | "not_configured" | "error" | "unexpected-response";
  currency: string | null;
  revenueCents: number;
  impressions: number | null;
  clicks: number | null;
  reason?: string;
  fetchedAt: string | null;
}

interface EarningsTotal {
  currency: string;
  revenueCents: number;
  impressions: number;
  clicks: number;
  providers: string[];
}

interface EarningsReport {
  days: number;
  from: string;
  to: string;
  generatedAt: string;
  providers: ProviderEarnings[];
  totals: EarningsTotal[];
  singleCurrency: boolean;
}

const PANEL = "mb-4 rounded-xl border border-[#1b2a4a] bg-panel";
const LABEL = "text-[11px] uppercase tracking-wider text-[#7f9bbd]";

const PROVIDER_LABEL: Record<string, string> = {
  hilltop: "HilltopAds",
  exoclick: "ExoClick",
  adcash: "Adcash",
};

const STATUS_STYLE: Record<ProviderEarnings["status"], string> = {
  ok: "text-emerald-400",
  not_configured: "text-[#7f9bbd]",
  error: "text-red-400",
  "unexpected-response": "text-amber-300",
};

const STATUS_LABEL: Record<ProviderEarnings["status"], string> = {
  ok: "reported",
  not_configured: "not configured",
  error: "failed",
  "unexpected-response": "unreadable response",
};

/**
 * Currency-first formatting: the code is always printed, because three
 * providers can settle in different currencies and a bare symbol would be
 * ambiguous.
 */
function money(cents: number, currency: string): string {
  const value = Number.isFinite(cents) ? Math.max(0, Math.round(cents)) : 0;
  return `${currency} ${(value / 100).toFixed(2)}`;
}

function count(value: number | null): string {
  return value === null ? "—" : value.toLocaleString("en-US");
}

function when(value: string | null): string {
  if (!value) return "—";
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "—";
  return `${new Date(time).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export default function AdEarningsPanel() {
  const [days, setDays] = useState<7 | 30>(7);
  const [report, setReport] = useState<EarningsReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(
    async (window: 7 | 30, signal: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const response = await fetch(`/api/admin/ad-earnings?days=${window}`, {
          cache: "no-store",
          credentials: "include",
          signal,
        });
        if (!response.ok) {
          if (!signal.aborted) {
            setError(
              response.status === 403
                ? "Admin access is required for this report."
                : `The earnings report could not be loaded (HTTP ${response.status}).`,
            );
            setReport(null);
          }
          return;
        }
        const body = (await response.json()) as { success?: boolean } & EarningsReport;
        if (signal.aborted) return;
        if (!body?.success) {
          setError("The earnings report could not be loaded.");
          setReport(null);
          return;
        }
        setReport(body);
      } catch {
        if (!signal.aborted) {
          setError("The earnings report could not be loaded.");
          setReport(null);
        }
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(days, controller.signal);
    return () => controller.abort();
  }, [days, load]);

  return (
    <section className={PANEL} aria-labelledby="ad-earnings-heading">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#1b2a4a] px-5 py-3">
        <div>
          <h2 id="ad-earnings-heading" className="text-sm font-semibold text-white">
            Ad earnings
          </h2>
          <p className="mt-0.5 text-xs text-[#7f9bbd]">
            Publisher reporting APIs · {report ? `${report.from} → ${report.to}` : "—"} · cached 5
            min server-side
          </p>
        </div>
        <div className="flex items-center gap-1" role="group" aria-label="Earnings window">
          {([7, 30] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setDays(option)}
              aria-pressed={days === option}
              className={`rounded-lg border px-3 py-1 text-xs ${
                days === option
                  ? "border-[#f5ff3b] text-[#f5ff3b]"
                  : "border-[#1b2a4a] text-[#c9f7ff] hover:border-[#f5ff3b]"
              }`}
            >
              {option}d
            </button>
          ))}
        </div>
      </div>

      {loading && !report ? (
        <p className="px-5 py-6 text-sm text-[#7f9bbd]">Querying the three networks…</p>
      ) : error ? (
        <p className="px-5 py-6 text-sm text-red-300">{error}</p>
      ) : !report ? (
        <p className="px-5 py-6 text-sm text-[#7f9bbd]">No report.</p>
      ) : (
        <>
          <div className="grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-4">
            {report.totals.length === 0 ? (
              <div className="rounded-lg border border-[#16233d] bg-black/20 p-4">
                <div className={LABEL}>Combined</div>
                <div className="mt-1 font-mono text-2xl text-white">—</div>
                <div className="mt-1 text-xs text-[#7f9bbd]">
                  No network reported earnings for this window. The per-provider rows below say
                  why.
                </div>
              </div>
            ) : (
              report.totals.map((total) => (
                <div key={total.currency} className="rounded-lg border border-[#16233d] bg-black/20 p-4">
                  <div className={LABEL}>
                    Combined{report.totals.length > 1 ? ` (${total.currency})` : ""}
                  </div>
                  <div className="mt-1 font-mono text-2xl text-white">
                    {money(total.revenueCents, total.currency)}
                  </div>
                  <div className="mt-1 text-xs text-[#7f9bbd]">
                    {total.providers.map((id) => PROVIDER_LABEL[id] ?? id).join(" + ")} ·{" "}
                    {count(total.impressions)} impressions · {count(total.clicks)} clicks
                  </div>
                </div>
              ))
            )}
            <div className="rounded-lg border border-[#16233d] bg-black/20 p-4">
              <div className={LABEL}>Report generated</div>
              <div className="mt-1 text-sm text-[#e6f7ff]">{when(report.generatedAt)}</div>
              <div className="mt-1 text-xs text-[#7f9bbd]">
                {report.singleCurrency
                  ? "One currency across the reporting networks."
                  : "Currencies are summed per currency — no exchange rate is assumed."}
              </div>
            </div>
          </div>

          <div className="border-t border-[#16233d] px-5 py-4">
            <table className="w-full text-left text-xs">
              <thead className="text-[11px] uppercase tracking-wider text-[#7f9bbd]">
                <tr>
                  <th className="py-1 font-medium">Network</th>
                  <th className="py-1 font-medium">Status</th>
                  <th className="py-1 text-right font-medium">Revenue</th>
                  <th className="py-1 text-right font-medium">Impressions</th>
                  <th className="py-1 text-right font-medium">Clicks</th>
                </tr>
              </thead>
              <tbody>
                {report.providers.map((provider) => (
                  <tr key={provider.provider} className="border-t border-[#16233d]">
                    <td className="py-1.5 text-[#c9f7ff]">
                      {PROVIDER_LABEL[provider.provider] ?? provider.provider}
                    </td>
                    <td className={`py-1.5 ${STATUS_STYLE[provider.status]}`}>
                      {STATUS_LABEL[provider.status]}
                      {provider.reason ? (
                        <span className="ml-1 text-[#5f7794]">({provider.reason})</span>
                      ) : null}
                    </td>
                    <td className="py-1.5 text-right font-mono text-[#e6f7ff]">
                      {provider.status === "ok" && provider.currency
                        ? money(provider.revenueCents, provider.currency)
                        : "—"}
                    </td>
                    <td className="py-1.5 text-right font-mono text-[#a9c4dd]">
                      {count(provider.impressions)}
                    </td>
                    <td className="py-1.5 text-right font-mono text-[#a9c4dd]">
                      {count(provider.clicks)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-3 text-[11px] text-[#5f7794]">
              Revenue is what each network reports for the same UTC window; networks publish
              statistics with their own delay, so today&apos;s figure can still move. A row that is
              not &ldquo;reported&rdquo; contributes nothing to a total.
            </p>
          </div>
        </>
      )}
    </section>
  );
}
