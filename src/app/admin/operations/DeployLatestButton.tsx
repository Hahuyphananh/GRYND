"use client";

// The one control on the operations page: deploy the newest `main` commit.
//
// It does not deploy anything itself — it asks /api/admin/deploy-latest, which
// dispatches the release workflow. The button is only rendered when a newer
// commit exists; when the newest commit is already live the row says so.

import { useState, type ReactNode } from "react";

import type { CommitInfo } from "../../../lib/admin/deployLatest";

type DeployResponse = {
  success?: boolean;
  status?: string;
  commit?: string;
  shortCommit?: string;
  runUrl?: string | null;
  workflowUrl?: string | null;
  message?: string;
  error?: string;
};

type Props = {
  liveCommit: string;
  latest: CommitInfo | null;
  configured: boolean;
  upToDate: boolean;
  unavailableReason: string | null;
  workflowUrl: string;
};

const BUTTON =
  "rounded-lg bg-[#f5ff3b] px-3 py-1.5 text-xs font-semibold text-[#0a0f1e] transition hover:bg-[#e8f22e] disabled:cursor-not-allowed disabled:opacity-50";
const LINK = "text-xs text-[#00e5ff] hover:underline";

function GitHubLink({ href, children }: { href: string | null | undefined; children: ReactNode }) {
  // Only GitHub URLs are ever linked, whatever the API returns.
  if (!href || !href.startsWith("https://github.com/")) return null;
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className={LINK}>
      {children}
    </a>
  );
}

export default function DeployLatestButton({
  liveCommit,
  latest,
  configured,
  upToDate,
  unavailableReason,
  workflowUrl,
}: Props) {
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<DeployResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!configured) {
    return (
      <span
        className="flex flex-wrap items-center gap-2 text-xs text-[#7f9bbd]"
        title={
          unavailableReason ??
          "One-click deploy is not configured on this server. This link opens the release workflow; sign in and run it with deploy=true."
        }
        data-admin-deploy-latest-fallback
      >
        <span>deploy button: not configured</span>
        <GitHubLink href={workflowUrl}>run the workflow on GitHub ↗</GitHubLink>
      </span>
    );
  }

  if (upToDate || (latest && latest.commit === liveCommit)) {
    return <span className="text-xs text-emerald-400">newest commit is live</span>;
  }

  if (!latest) {
    return (
      <span className="flex flex-wrap items-center gap-2 text-xs text-amber-300" data-admin-deploy-latest-fallback>
        <span>{unavailableReason ?? "the newest commit could not be read"}</span>
        <GitHubLink href={workflowUrl}>open the workflow on GitHub ↗</GitHubLink>
      </span>
    );
  }

  const deploy = async () => {
    const confirmed = window.confirm(
      `Deploy ${latest.shortCommit} to production?\n\nThis runs the release workflow: tests, build, then activate and verify on the host.`,
    );
    if (!confirmed) return;

    setPending(true);
    setError(null);
    setResult(null);

    try {
      const response = await fetch("/api/admin/deploy-latest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: `Admin dashboard deploy of ${latest.shortCommit}` }),
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
    <span className="flex flex-wrap items-center gap-2">
      <button type="button" onClick={deploy} disabled={pending} className={BUTTON} data-admin-deploy-latest>
        {pending ? "Requesting deploy…" : `Deploy ${latest.shortCommit}`}
      </button>

      {result?.status === "dispatched" && (
        <span className="text-xs text-emerald-400" aria-live="polite">
          requested ·{" "}
          <GitHubLink href={result.workflowUrl ?? result.runUrl}>view the workflow ↗</GitHubLink>
        </span>
      )}
      {result?.status === "already-running" && (
        <span className="text-xs text-amber-300" aria-live="polite">
          a deploy for {result.shortCommit} is already running · <GitHubLink href={result.runUrl}>view it ↗</GitHubLink>
        </span>
      )}
      {result?.status === "already-live" && (
        <span className="text-xs text-emerald-400" aria-live="polite">
          {result.shortCommit} is already live
        </span>
      )}
      {result?.status === "not-configured" && (
        <span className="text-xs text-amber-300" aria-live="polite">
          {result.message}
        </span>
      )}
      {error && (
        <span className="text-xs text-red-300" aria-live="polite">
          {error}
        </span>
      )}
    </span>
  );
}
