// src/app/admin/operations/logs/page.tsx
//
// The audit log page. Separate from the operations overview by request, and
// kept as a server component: the log is read, filtered and rendered on the
// server, so no audit data is shipped to the browser beyond the rows shown.
//
// Two sources are merged:
//   release — state/audit.jsonl, written by deploy/release.mjs
//   ops     — state/ops/audit.jsonl, the hash-chained operations audit

import type { Metadata } from "next";
import Link from "next/link";

import { getOperationsSnapshot } from "../../../../lib/admin/operations";
import { requireAdminPage } from "../../../../lib/admin/requireAdminPage";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
  title: "Operations log | GRYND Admin",
  description: "Audit log for deployments, service actions and authorization events.",
};

const SOURCES = ["all", "release", "ops"] as const;
type Source = (typeof SOURCES)[number];

function fmtTime(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return value;
  return `${new Date(time).toISOString().slice(0, 19).replace("T", " ")}Z`;
}

function pick(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}

export default async function OperationsLogsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAdminPage();

  const params = await searchParams;
  const requestedSource = pick(params.source);
  const source: Source = (SOURCES as readonly string[]).includes(requestedSource)
    ? (requestedSource as Source)
    : "all";
  const query = pick(params.q).trim().slice(0, 80).toLowerCase();

  const snapshot = await getOperationsSnapshot();

  const filtered = snapshot.audit
    .filter((entry) => (source === "all" ? true : entry.source === source))
    .filter((entry) => {
      if (!query) return true;
      const haystack = [entry.event, entry.actor, entry.outcome, entry.reason, JSON.stringify(entry.detail ?? {})]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(query);
    })
    .slice(-200)
    .reverse();

  const counts = {
    all: snapshot.audit.length,
    release: snapshot.audit.filter((entry) => entry.source === "release").length,
    ops: snapshot.audit.filter((entry) => entry.source === "ops").length,
  };

  return (
    <main className="min-h-screen bg-[#0a0f1e] px-4 py-8 text-[#c9f7ff] sm:px-6 lg:px-10">
      <div className="mx-auto max-w-6xl">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-white">Audit log</h1>
            <p className="mt-1 text-sm text-[#7f9bbd]">
              {snapshot.configured
                ? `${filtered.length} entries shown — most recent first`
                : "Host state is not readable."}
            </p>
          </div>
          <Link
            href="/admin/operations"
            className="rounded-lg border border-[#1b2a4a] px-3 py-1.5 text-sm text-[#c9f7ff] hover:border-[#f5ff3b]"
          >
            ← Operations
          </Link>
        </div>

        <form method="get" className="mb-4 flex flex-wrap items-center gap-2">
          <input
            type="search"
            name="q"
            defaultValue={pick(params.q)}
            placeholder="Filter by event, actor or reason"
            className="min-w-[220px] flex-1 rounded-lg border border-[#1b2a4a] bg-[#0d1830] px-3 py-1.5 text-sm text-[#e6f7ff] placeholder:text-[#5f7794] focus:border-[#f5ff3b] focus:outline-none"
          />
          <input type="hidden" name="source" value={source} />
          <button
            type="submit"
            className="rounded-lg border border-[#1b2a4a] px-3 py-1.5 text-sm text-[#c9f7ff] hover:border-[#f5ff3b]"
          >
            Filter
          </button>
        </form>

        <div className="mb-4 flex flex-wrap gap-2 text-xs">
          {SOURCES.map((option) => (
            <Link
              key={option}
              href={`/admin/operations/logs?source=${option}${query ? `&q=${encodeURIComponent(query)}` : ""}`}
              className={`rounded-lg border px-3 py-1.5 ${
                source === option
                  ? "border-[#f5ff3b] text-[#f5ff3b]"
                  : "border-[#1b2a4a] text-[#a9c4dd] hover:border-[#f5ff3b]"
              }`}
            >
              {option} ({counts[option]})
            </Link>
          ))}
        </div>

        <section className="rounded-xl border border-[#1b2a4a] bg-[#0d1830]">
          {filtered.length === 0 ? (
            <p className="px-5 py-8 text-sm text-[#7f9bbd]">
              {snapshot.configured
                ? "No audit entries match this filter."
                : (snapshot.reason ?? "No audit entries are readable from this host.")}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="text-[11px] uppercase tracking-wider text-[#7f9bbd]">
                  <tr>
                    <th className="px-4 py-2 font-medium">Time</th>
                    <th className="px-3 py-2 font-medium">Source</th>
                    <th className="px-3 py-2 font-medium">Event</th>
                    <th className="px-3 py-2 font-medium">Actor</th>
                    <th className="px-3 py-2 font-medium">Outcome</th>
                    <th className="px-4 py-2 font-medium">Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((entry, index) => (
                    <tr key={`${entry.at}-${entry.event}-${index}`} className="border-t border-[#16233d] align-top">
                      <td className="whitespace-nowrap px-4 py-2 font-mono text-[#a9c4dd]">{fmtTime(entry.at)}</td>
                      <td className="px-3 py-2 font-mono uppercase text-[#00e5ff]">{entry.source}</td>
                      <td className="px-3 py-2 font-mono text-[#e6f7ff]">{entry.event}</td>
                      <td className="px-3 py-2 text-[#a9c4dd]">{entry.actor ?? "—"}</td>
                      <td className="px-3 py-2">
                        <span
                          className={
                            entry.outcome === "ok" || entry.outcome === "verified" || entry.outcome === "activated"
                              ? "text-emerald-400"
                              : entry.outcome === "failed" || entry.outcome === "reverted"
                                ? "text-red-400"
                                : "text-[#a9c4dd]"
                          }
                        >
                          {entry.outcome ?? "—"}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-[#7f9bbd]">
                        {entry.reason && <div className="text-[#a9c4dd]">{entry.reason}</div>}
                        {entry.detail && (
                          <div className="mt-0.5 font-mono text-[10px] leading-relaxed">
                            {Object.entries(entry.detail)
                              .map(([key, value]) => `${key}=${String(value)}`)
                              .join(" · ")}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <p className="mt-4 text-xs text-[#5f7794]">
          Passwords, tokens, cookies and secret values are never written to these logs. The operations log is
          hash-chained on the host; run{" "}
          <code className="font-mono">node deploy/ops.mjs audit-verify</code> to check it.
        </p>
      </div>
    </main>
  );
}
