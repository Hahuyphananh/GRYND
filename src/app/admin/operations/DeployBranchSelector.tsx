"use client";

// The one control on the operations page: choose an allowlisted branch and ask
// /api/admin/deploy-latest to deploy that branch's newest commit.
//
// It does not deploy anything itself. The options are the branches the server
// read from its own allowlist — the browser cannot add one — and the request
// names the branch, which the route validates again before any GitHub call.
// Nothing here ever sees the server-side GitHub deploy token.

import { useState, type ReactNode } from "react";

import type { BranchDeployTarget, DeployBranch } from "../../../lib/admin/deployLatest";

type DeployResponse = {
  success?: boolean;
  status?: string;
  branch?: string;
  commit?: string;
  shortCommit?: string;
  runUrl?: string | null;
  workflowUrl?: string | null;
  message?: string;
  error?: string;
};

type Props = {
  liveCommit: string | null;
  targets: BranchDeployTarget[];
  defaultBranch: DeployBranch;
};

const BUTTON =
  "rounded-lg bg-[#f5ff3b] px-3 py-1.5 text-xs font-semibold text-[#0a0f1e] transition hover:bg-[#e8f22e] disabled:cursor-not-allowed disabled:opacity-50";
const LINK = "text-xs text-[#00e5ff] hover:underline";
const SELECT =
  "mt-1 rounded-lg border border-[#1b2a4a] bg-[#0a0f1e] px-2 py-1.5 text-sm text-[#e6f7ff] focus:border-[#f5ff3b] focus:outline-hidden";

function GitHubLink({ href, children }: { href: string | null | undefined; children: ReactNode }) {
  // Only GitHub URLs are ever linked, whatever the API returns.
  if (!href || !href.startsWith("https://github.com/")) return null;
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className={LINK}>
      {children}
    </a>
  );
}

export default function DeployBranchSelector({ liveCommit, targets, defaultBranch }: Props) {
  const [selected, setSelected] = useState<DeployBranch>(defaultBranch);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<DeployResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const target = targets.find((entry) => entry.branch === selected) ?? targets[0] ?? null;
  if (!target) return null;

  const activeBranch = target.branch;
  const latest = target.latest;
  const alreadyLive = target.upToDate || Boolean(latest && liveCommit && latest.commit === liveCommit.toLowerCase());

  const chooseBranch = (value: string) => {
    // The value comes from our own <option> list, but re-checking keeps a
    // tampered DOM from putting a new name into state.
    const allowed = targets.find((entry) => entry.branch === value);
    if (!allowed) return;
    setSelected(allowed.branch);
    setResult(null);
    setError(null);
  };

  const deploy = async () => {
    if (!latest) return;

    // The confirmation names the branch AND the full commit: an operator must be
    // able to see exactly what is about to become production.
    const confirmed = window.confirm(
      `Deploy branch ${activeBranch} at ${latest.commit} to production?\n\n` +
        "This runs the release workflow for that exact commit: tests, build, then install, activate and health-check on the host. " +
        "It needs the grynd-production environment approval.",
    );
    if (!confirmed) return;

    setPending(true);
    setError(null);
    setResult(null);

    try {
      const response = await fetch("/api/admin/deploy-latest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          branch: activeBranch,
          reason: `Admin operations deploy of ${activeBranch}@${latest.shortCommit}`,
        }),
      });
      const body = (await response.json().catch(() => null)) as DeployResponse | null;

      if (!response.ok || !body?.success) {
        setError(body?.error ?? `The deploy request failed (HTTP ${response.status}).`);
        return;
      }
      setResult(body);
    } catch {
      setError("The deploy request did not reach the server.");
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="px-5 py-4">
      <div className="flex flex-wrap items-center gap-3">
        <label className="text-xs text-[#7f9bbd]">
          <span className="block text-[11px] uppercase tracking-wider">Deployment branch</span>
          <select
            value={activeBranch}
            onChange={(event) => chooseBranch(event.target.value)}
            className={SELECT}
            data-admin-deploy-branch-select
          >
            {targets.map((entry) => (
              <option key={entry.branch} value={entry.branch}>
                {entry.branch}
              </option>
            ))}
          </select>
        </label>

        {!target.configured ? (
          <span
            className="flex flex-wrap items-center gap-2 text-xs text-[#7f9bbd]"
            title={
              target.reason ??
              "One-click deploy is not configured on this server. This link opens the release workflow; sign in and run it with deploy=true."
            }
            data-admin-deploy-latest-fallback
          >
            <span>deploy button: not configured</span>
            <GitHubLink href={target.workflowUrl}>run the workflow on GitHub ↗</GitHubLink>
          </span>
        ) : alreadyLive ? (
          <span className="text-xs text-emerald-400">newest {activeBranch} commit is live</span>
        ) : !latest ? (
          <span className="flex flex-wrap items-center gap-2 text-xs text-amber-300" data-admin-deploy-latest-fallback>
            <span>{target.reason ?? "the newest commit could not be read"}</span>
            <GitHubLink href={target.workflowUrl}>open the workflow on GitHub ↗</GitHubLink>
          </span>
        ) : (
          <button type="button" onClick={deploy} disabled={pending} className={BUTTON} data-admin-deploy-latest>
            {pending ? "Requesting deploy…" : `Deploy ${activeBranch} @ ${latest.shortCommit}`}
          </button>
        )}
      </div>

      <dl className="mt-3 grid gap-x-6 gap-y-1 text-xs text-[#7f9bbd] sm:grid-cols-2">
        <div>
          branch <span className="font-mono text-[#a9c4dd]">{activeBranch}</span>
        </div>
        <div>
          live commit <span className="font-mono text-[#a9c4dd]">{liveCommit ?? "—"}</span>
        </div>
        <div className="sm:col-span-2 break-all">
          latest commit <span className="font-mono text-[#c9f7ff]">{latest ? latest.commit : "—"}</span>
        </div>
        {latest?.message && (
          <div className="sm:col-span-2">
            message <span className="text-[#e6f7ff]">{latest.message}</span>
          </div>
        )}
      </dl>

      <div className="mt-2 text-xs">
        {alreadyLive ? (
          <span className="text-emerald-400">the latest {activeBranch} commit is already live</span>
        ) : latest ? (
          <span className="text-amber-300">the latest {activeBranch} commit is not live yet</span>
        ) : null}
      </div>

      {result?.status === "dispatched" && (
        <p className="mt-2 text-xs text-emerald-400" aria-live="polite">
          requested {result.branch} @ {result.shortCommit} ·{" "}
          <GitHubLink href={result.workflowUrl ?? result.runUrl}>view the workflow ↗</GitHubLink>
        </p>
      )}
      {result?.status === "already-running" && (
        <p className="mt-2 text-xs text-amber-300" aria-live="polite">
          a deploy for {result.branch} @ {result.shortCommit} is already running ·{" "}
          <GitHubLink href={result.runUrl}>view it ↗</GitHubLink>
        </p>
      )}
      {result?.status === "already-live" && (
        <p className="mt-2 text-xs text-emerald-400" aria-live="polite">
          {result.branch} @ {result.shortCommit} is already live
        </p>
      )}
      {result?.status === "not-configured" && (
        <p className="mt-2 text-xs text-amber-300" aria-live="polite">
          {result.message}
        </p>
      )}
      {error && (
        <p className="mt-2 text-xs text-red-300" aria-live="polite">
          {error}
        </p>
      )}
    </div>
  );
}
