// src/app/admin/operations/page.tsx
//
// Read-only operations dashboard for the admin area.
//
// Deliberately NOT a control surface: there are no restart buttons here. The
// Phase 6 design keeps privileged actions in the loopback-only Control Center,
// so a stolen admin session cannot bounce production. This page only reads
// files the deployment tooling already wrote.
//
// Every value is rendered as text by React, never injected as HTML, and the
// reader in src/lib/admin/operations.ts bounds and redacts what it returns.

import type { Metadata } from "next";
import Link from "next/link";

import { buildMfaDiagnostics } from "../../../lib/admin/mfaDiagnostics";
import { formatBytes, getOperationsSnapshot } from "../../../lib/admin/operations";
import { requireAdminPage } from "../../../lib/admin/requireAdminPage";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
  title: "Operations | GRYND Admin",
  description: "Read-only deployment, backup and audit status for GRYND.",
};

const CARD = "rounded-xl border border-[#1b2a4a] bg-[#0d1830] p-5";
const LABEL = "text-[11px] uppercase tracking-wider text-[#7f9bbd]";
const VALUE = "mt-1 text-sm text-[#e6f7ff]";

function fmtTime(value: string | null): string {
  if (!value) return "never";
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "unknown";
  return `${new Date(time).toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

function fmtDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

const OUTCOME_STYLE: Record<string, string> = {
  activated: "text-emerald-400",
  verified: "text-emerald-400",
  ok: "text-emerald-400",
  skipped: "text-amber-300",
  failed: "text-red-400",
  "install-failed": "text-red-400",
};

function Outcome({ value }: { value: string | null }) {
  if (!value) return <span className="text-[#7f9bbd]">—</span>;
  return <span className={OUTCOME_STYLE[value] ?? "text-[#e6f7ff]"}>{value}</span>;
}

// The gate page (/admin/mfa-required) can only offer the factors this host can
// honour, so an operator who lands there needs to know WHICH variable to set.
// Same three factors, same order, as the gate page and /api/admin/mfa/status.
const FACTOR_ROWS = [
  { key: "email", label: "Email code", short: "email code" },
  { key: "totp", label: "Authenticator app", short: "authenticator app" },
  { key: "passphrase", label: "Passphrase", short: "passphrase" },
] as const;

const SEVERITY_STYLE: Record<string, string> = {
  critical: "border-red-500/40 bg-red-500/10 text-red-300",
  warning: "border-amber-400/40 bg-amber-400/10 text-amber-200",
  info: "border-sky-500/40 bg-sky-500/10 text-sky-200",
};

/**
 * Ask the realtime service whether it is alive. Bounded, never throws, and the
 * URL is never rendered: it can carry an internal host name.
 */
async function probeRealtime(): Promise<{ state: "ok" | "unreachable" | "not_configured"; detail: string }> {
  const base = process.env.REALTIME_INTERNAL_URL?.trim();
  if (!base) return { state: "not_configured", detail: "REALTIME_INTERNAL_URL is not set" };

  try {
    const response = await fetch(new URL("/health", base), {
      signal: AbortSignal.timeout(1_500),
      cache: "no-store",
    });
    if (!response.ok) return { state: "unreachable", detail: `health returned HTTP ${response.status}` };
    const body = (await response.json().catch(() => null)) as { ok?: unknown } | null;
    if (body && body.ok === false) return { state: "unreachable", detail: "the service reported itself unhealthy" };
    return { state: "ok", detail: "responding on the internal health endpoint" };
  } catch {
    return { state: "unreachable", detail: "the health probe did not answer" };
  }
}

export default async function OperationsPage() {
  await requireAdminPage();

  const [snapshot, realtime] = await Promise.all([getOperationsSnapshot(), probeRealtime()]);
  const mfa = buildMfaDiagnostics(process.env);

  const critical = snapshot.warnings.filter((warning) => warning.severity === "critical");
  const rest = snapshot.warnings.filter((warning) => warning.severity !== "critical");
  const factors = FACTOR_ROWS.map((row) => ({ ...row, status: mfa.factors[row.key] }));
  const missingFactors = factors.filter((factor) => !factor.status.configured);
  const latestDeployment = snapshot.deployments[0] ?? null;
  const recentAudit = [...snapshot.audit].reverse().slice(0, 8);

  return (
    <main className="min-h-screen bg-[#0a0f1e] px-4 py-8 text-[#c9f7ff] sm:px-6 lg:px-10">
      <div className="mx-auto max-w-6xl">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-white">Operations</h1>
            <p className="mt-1 text-sm text-[#7f9bbd]">
              Read-only. Sourced from the host state files written by the release tooling.
            </p>
          </div>
          <nav className="flex gap-2 text-sm">
            <Link
              href="/admin"
              className="rounded-lg border border-[#1b2a4a] px-3 py-1.5 text-[#c9f7ff] hover:border-[#f5ff3b]"
            >
              Admin dashboard
            </Link>
            <Link
              href="/admin/operations/logs"
              className="rounded-lg border border-[#1b2a4a] px-3 py-1.5 text-[#c9f7ff] hover:border-[#f5ff3b]"
            >
              View all logs
            </Link>
          </nav>
        </div>

        {!snapshot.configured && (
          <div className="mb-5 rounded-xl border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-200">
            <p className="font-semibold">Operations state is not readable.</p>
            <p className="mt-1 text-red-200/80">{snapshot.reason}</p>
            <p className="mt-2 text-xs text-red-200/60">
              Expected root: <code className="font-mono">{snapshot.root}</code>. Set{" "}
              <code className="font-mono">GRYND_RELEASE_ROOT</code> and grant the app user read access to{" "}
              <code className="font-mono">state/</code> — never to <code className="font-mono">env/</code>.
            </p>
          </div>
        )}

        {critical.length > 0 && (
          <div className="mb-3 space-y-2">
            {critical.map((warning) => (
              <div
                key={warning.code}
                className={`rounded-lg border px-4 py-2 text-sm ${SEVERITY_STYLE[warning.severity]}`}
              >
                <span className="font-mono text-xs">{warning.code}</span> — {warning.message}
              </div>
            ))}
          </div>
        )}
        {rest.length > 0 && (
          <div className="mb-5 space-y-2">
            {rest.map((warning) => (
              <div
                key={warning.code}
                className={`rounded-lg border px-4 py-2 text-sm ${SEVERITY_STYLE[warning.severity]}`}
              >
                <span className="font-mono text-xs">{warning.code}</span> — {warning.message}
              </div>
            ))}
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <section className={CARD}>
            <div className={LABEL}>Active release</div>
            <div className={VALUE}>
              {snapshot.active?.releaseId ? (
                <span className="font-mono">{snapshot.active.releaseId}</span>
              ) : (
                <span className="text-[#7f9bbd]">not recorded</span>
              )}
            </div>
            <div className="mt-2 text-xs text-[#7f9bbd]">
              commit{" "}
              <span className="font-mono text-[#c9f7ff]">{snapshot.active?.shortCommit ?? "—"}</span>
              {snapshot.active?.buildId ? ` · build ${snapshot.active.buildId.slice(0, 10)}` : ""}
            </div>
            <div className="mt-1 text-xs text-[#7f9bbd]">activated {fmtTime(snapshot.active?.activatedAt ?? null)}</div>
            {snapshot.active?.health && (
              <div className={`mt-2 text-xs ${snapshot.active.health.ok ? "text-emerald-400" : "text-red-400"}`}>
                health gate: {snapshot.active.health.ok ? "passed" : "FAILED"}
              </div>
            )}
          </section>

          <section className={CARD}>
            <div className={LABEL}>Newest backup</div>
            <div className={VALUE}>
              {snapshot.backup?.lastSuccessAt ? fmtTime(snapshot.backup.lastSuccessAt) : "never"}
            </div>
            <div className="mt-2 text-xs text-[#7f9bbd]">
              {snapshot.backup?.bytes != null ? formatBytes(snapshot.backup.bytes) : "size unknown"}
              {snapshot.backup?.ageHours != null ? ` · ${snapshot.backup.ageHours}h old` : ""}
            </div>
            <div className="mt-2 text-xs">
              {snapshot.backup?.verified ? (
                <span className="text-emerald-400">restore verified</span>
              ) : (
                <span className="text-amber-300">NOT restore-verified</span>
              )}
            </div>
            <div className="mt-1 text-xs text-[#7f9bbd]">
              destination: {snapshot.backup?.destinationKind ?? "none recorded"}
            </div>
          </section>

          <section className={CARD}>
            <div className={LABEL}>Realtime service</div>
            <div
              className={`mt-1 text-sm ${
                realtime.state === "ok"
                  ? "text-emerald-400"
                  : realtime.state === "not_configured"
                    ? "text-[#7f9bbd]"
                    : "text-red-400"
              }`}
            >
              {realtime.state === "ok" ? "responding" : realtime.state === "not_configured" ? "not configured" : "unreachable"}
            </div>
            <div className="mt-2 text-xs text-[#7f9bbd]">{realtime.detail}</div>
            <div className="mt-2 text-xs text-[#7f9bbd]">
              The app itself is serving this page. Unit state is only available in the Control Center.
            </div>
          </section>

          <section className={CARD}>
            <div className={LABEL}>Admin second factor</div>
            <div className="mt-1 text-sm">
              {mfa.anyConfigured ? (
                <span className="text-emerald-400">
                  {factors.length - missingFactors.length} of {factors.length} factor(s) available
                </span>
              ) : (
                <span className="text-red-400">none configured — admin access is refused</span>
              )}
            </div>
            <div className="mt-2 text-xs text-[#7f9bbd]">
              {missingFactors.length === 0
                ? "Every factor this host can use is configured."
                : `Missing: ${missingFactors.map((factor) => factor.short).join(", ")}`}
            </div>
            <a
              href="#admin-second-factor"
              className="mt-2 inline-block text-xs text-[#f5ff3b] hover:underline"
            >
              What to set →
            </a>
            {mfa.sessionSecret.source === "insecure-fallback" && (
              <div className="mt-2 text-xs text-red-400">MFA cookie signing secret is not configured.</div>
            )}
          </section>
        </div>

        {/* The detail behind the card above: one row per factor, with the
            variable that turns it on. Names only — buildMfaDiagnostics never
            returns a value, a prefix or a length. */}
        <section
          id="admin-second-factor"
          className="mt-6 rounded-xl border border-[#1b2a4a] bg-[#0d1830]"
        >
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#1b2a4a] px-5 py-3">
            <h2 className="text-sm font-semibold text-white">Admin second factor</h2>
            <Link href="/admin/mfa-required" className="text-xs text-[#f5ff3b] hover:underline">
              Open the verification page →
            </Link>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-[11px] uppercase tracking-wider text-[#7f9bbd]">
                <tr>
                  <th className="px-5 py-2 font-medium">Factor</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-5 py-2 font-medium">What to set</th>
                </tr>
              </thead>
              <tbody>
                {factors.map((factor) => (
                  <tr key={factor.key} className="border-t border-[#16233d] align-top">
                    <td className="px-5 py-2 text-xs text-[#e6f7ff]">{factor.label}</td>
                    <td className="px-3 py-2 text-xs">
                      {factor.status.configured ? (
                        <span className="text-emerald-400">available</span>
                      ) : (
                        <span className="text-red-400">missing</span>
                      )}
                    </td>
                    <td className="px-5 py-2 text-xs">
                      {factor.status.configured ? (
                        <span className="text-[#7f9bbd]">configured on this host</span>
                      ) : (
                        <>
                          <div className="text-amber-200">{factor.status.reason}</div>
                          <div className="mt-1 font-mono text-[10px] text-[#7f9bbd]">
                            {factor.status.variables.join(" · ")}
                          </div>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="border-t border-[#1b2a4a] px-5 py-3 text-xs text-[#7f9bbd]">
            <div>
              Cookie signing secret:{" "}
              <span className={mfa.sessionSecret.secure ? "text-emerald-400" : "text-red-400"}>
                {mfa.sessionSecret.source === "env"
                  ? "dedicated secret"
                  : mfa.sessionSecret.source === "clerk-fallback"
                    ? "falling back to CLERK_SECRET_KEY"
                    : "missing — signed with a development value"}
              </span>
            </div>
            <div className="mt-1">
              Email codes:{" "}
              <span className={mfa.otpStore.kind === "redis" ? "text-emerald-400" : "text-amber-300"}>
                {mfa.otpStore.kind === "redis" ? "held in Redis" : "held in process memory"}
              </span>
            </div>
          </div>
        </section>

        <section className="mt-6 rounded-xl border border-[#1b2a4a] bg-[#0d1830]">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#1b2a4a] px-5 py-3">
            <h2 className="text-sm font-semibold text-white">GitHub deployments</h2>
            <span className="text-xs text-[#7f9bbd]">
              {latestDeployment ? `latest run ${latestDeployment.runId ?? "—"}` : "no records"}
            </span>
          </div>

          {snapshot.deployments.length === 0 ? (
            <p className="px-5 py-6 text-sm text-[#7f9bbd]">
              No deploy-job records on this host. Runs that stopped before the deploy job are visible in GitHub only.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-[11px] uppercase tracking-wider text-[#7f9bbd]">
                  <tr>
                    <th className="px-5 py-2 font-medium">Started</th>
                    <th className="px-3 py-2 font-medium">Commit</th>
                    <th className="px-3 py-2 font-medium">Release</th>
                    <th className="px-3 py-2 font-medium">Outcome</th>
                    <th className="px-3 py-2 font-medium">Stage</th>
                    <th className="px-3 py-2 font-medium">Health</th>
                    <th className="px-5 py-2 font-medium">Duration</th>
                  </tr>
                </thead>
                <tbody>
                  {snapshot.deployments.slice(0, 10).map((record) => (
                    <tr key={`${record.runId}-${record.commit}`} className="border-t border-[#16233d]">
                      <td className="px-5 py-2 text-xs text-[#a9c4dd]">{fmtTime(record.startedAt)}</td>
                      <td className="px-3 py-2 font-mono text-xs">{record.shortCommit}</td>
                      <td className="px-3 py-2 font-mono text-xs text-[#a9c4dd]">{record.releaseId ?? "—"}</td>
                      <td className="px-3 py-2 text-xs">
                        <Outcome value={record.outcome} />
                      </td>
                      <td className="px-3 py-2 text-xs text-[#a9c4dd]">{record.stage ?? "—"}</td>
                      <td className="px-3 py-2 text-xs">
                        {record.health ? (
                          <span className={record.health.ok ? "text-emerald-400" : "text-red-400"}>
                            {record.health.ok ? "ok" : "failed"}
                          </span>
                        ) : (
                          <span className="text-[#7f9bbd]">—</span>
                        )}
                      </td>
                      <td className="px-5 py-2 text-xs text-[#a9c4dd]">{fmtDuration(record.durationMs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="mt-6 rounded-xl border border-[#1b2a4a] bg-[#0d1830]">
          <div className="flex items-center justify-between border-b border-[#1b2a4a] px-5 py-3">
            <h2 className="text-sm font-semibold text-white">Recent activity</h2>
            <Link href="/admin/operations/logs" className="text-xs text-[#f5ff3b] hover:underline">
              View all logs →
            </Link>
          </div>
          {recentAudit.length === 0 ? (
            <p className="px-5 py-6 text-sm text-[#7f9bbd]">No audit entries recorded on this host.</p>
          ) : (
            <ul className="divide-y divide-[#16233d]">
              {recentAudit.map((entry, index) => (
                <li key={`${entry.at}-${entry.event}-${index}`} className="flex flex-wrap gap-x-3 gap-y-1 px-5 py-2 text-xs">
                  <span className="text-[#7f9bbd]">{fmtTime(entry.at)}</span>
                  <span className="font-mono text-[10px] uppercase text-[#00e5ff]">{entry.source}</span>
                  <span className="font-mono text-[#c9f7ff]">{entry.event}</span>
                  {entry.actor && <span className="text-[#a9c4dd]">by {entry.actor}</span>}
                  {entry.outcome && <Outcome value={entry.outcome} />}
                </li>
              ))}
            </ul>
          )}
        </section>

        <p className="mt-6 text-xs text-[#5f7794]">
          Service restarts, rollbacks and configuration changes are not available here by design. Use the Control
          Center over the SSH tunnel.
        </p>
      </div>
    </main>
  );
}
