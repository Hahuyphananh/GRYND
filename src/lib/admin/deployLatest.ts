// src/lib/admin/deployLatest.ts
//
// "Deploy the newest commit of an allowlisted branch" for the admin operations
// dashboard.
//
// The dashboard does NOT build on the host and does NOT hold SSH keys. It asks
// GitHub Actions to run the same release workflow CI already uses:
//
//   POST /repos/{repo}/actions/workflows/release.yml/dispatches
//   { ref: "<allowlisted branch>", inputs: { deploy: "true", reason } }
//
// That workflow checks out the commit, runs the test suite and the build, and
// then installs, activates and verifies the release behind the protected
// `grynd-production` environment. The app's only job is to request it.
//
// The branch is an allowlist, not caller input: `DEPLOY_BRANCHES` is the only
// set of values this module will ever put in `ref`. Anything else is refused
// here as well as in the API route and in the workflow guard.
//
// The token is read here and never returned: `readDeployConfig` is the only
// place GITHUB_DEPLOY_TOKEN is touched, and every value that leaves this module
// is a commit, a short commit, a message, a URL, a branch name or an error code.
//
// Everything is injectable (env + fetch) so the dispatch contract can be tested
// without a token or a network.

const GITHUB_API = "https://api.github.com";

/** The release workflow the dashboard may dispatch. Not user input. */
export const DEPLOY_WORKFLOW = "release.yml";

/** The only branches that may ever be deployed. Not user input. */
export const DEPLOY_BRANCHES = ["main", "solitaire-first"] as const;
export type DeployBranch = (typeof DEPLOY_BRANCHES)[number];

/** The intended production branch: the Solitaire-first release. */
export const DEFAULT_DEPLOY_BRANCH: DeployBranch = "solitaire-first";

/** The repository this dashboard belongs to; GITHUB_DEPLOY_REPO overrides it. */
export const DEFAULT_DEPLOY_REPO = "Hahuyphananh/GRYND";

/** Env vars the host must set before the button can do anything. */
export const DEPLOY_ENV_VARS = ["GITHUB_DEPLOY_TOKEN", "GITHUB_DEPLOY_REPO"] as const;

const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const COMMIT_RE = /^[0-9a-f]{40}$/i;
const MAX_REASON = 160;

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type DeployConfig = {
  /** `owner/name`, or null when the configured value is not a repository name. */
  repo: string | null;
  /** Present only on the server. Never rendered. */
  token: string | null;
  workflow: string;
  /** The allowlisted branch to deploy, or null when the request was not allowed. */
  branch: DeployBranch | null;
};

export type CommitInfo = {
  commit: string;
  shortCommit: string;
  message: string | null;
  url: string | null;
};

export type DeployTarget = {
  configured: boolean;
  latest: CommitInfo | null;
  upToDate: boolean;
  reason: string | null;
  /** Public workflow page, available even when the token is absent. */
  workflowUrl: string;
};

/** A deploy target plus the branch it describes, as the operations page needs it. */
export type BranchDeployTarget = DeployTarget & { branch: DeployBranch };

export type DeployOutcome =
  | { status: "not-configured"; message: string }
  | { status: "already-live"; branch: DeployBranch; commit: string; shortCommit: string }
  | { status: "already-running"; branch: DeployBranch; commit: string; shortCommit: string; runUrl: string | null }
  | {
      status: "dispatched";
      branch: DeployBranch;
      commit: string;
      shortCommit: string;
      workflowUrl: string;
      message: string;
    };

export type DeployFailureCode =
  | "not-configured"
  | "branch-not-allowed"
  | "github-auth"
  | "github-not-found"
  | "github-unavailable"
  | "dispatch-rejected";

export class DeployError extends Error {
  readonly code: DeployFailureCode;

  constructor(code: DeployFailureCode, message: string) {
    super(message);
    this.name = "DeployError";
    this.code = code;
  }
}

// ── configuration ─────────────────────────────────────────────────────────

/** True only for a branch on the allowlist. The single widening point. */
export function isDeployBranch(value: unknown): value is DeployBranch {
  return typeof value === "string" && (DEPLOY_BRANCHES as readonly string[]).includes(value);
}

export function readDeployConfig(
  env: NodeJS.ProcessEnv = process.env,
  requestedBranch: unknown = DEFAULT_DEPLOY_BRANCH,
): DeployConfig {
  const configuredRepo = env.GITHUB_DEPLOY_REPO?.trim();
  const repo = REPO_RE.test(configuredRepo ?? DEFAULT_DEPLOY_REPO)
    ? (configuredRepo ?? DEFAULT_DEPLOY_REPO)
    : null;

  return {
    repo,
    token: env.GITHUB_DEPLOY_TOKEN?.trim() || null,
    workflow: DEPLOY_WORKFLOW,
    branch: isDeployBranch(requestedBranch) ? requestedBranch : null,
  };
}

/** The message shown when the request names a branch outside the allowlist. */
export function branchNotAllowedMessage(): string {
  return `Only ${DEPLOY_BRANCHES.join(" and ")} can be deployed from this dashboard.`;
}

/** The message the dashboard shows while the token is absent — no secret names. */
export function notConfiguredMessage(): string {
  return "Deploying from the dashboard needs GITHUB_DEPLOY_TOKEN (Actions: write, Contents: read) and GITHUB_DEPLOY_REPO on the host.";
}

/** The public workflow page; this is safe to render without a token. */
export function deployWorkflowUrl(repo: string | null = DEFAULT_DEPLOY_REPO): string {
  return `https://github.com/${repo ?? DEFAULT_DEPLOY_REPO}/actions/workflows/${DEPLOY_WORKFLOW}`;
}

function authHeaders(token: string): HeadersInit {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "grynd-admin-dashboard",
  };
}

function timeoutSignal(ms: number): AbortSignal | undefined {
  return typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(ms) : undefined;
}

/** Map a GitHub status to a code and a message that carries no request detail. */
function githubError(status: number): DeployError {
  if (status === 401 || status === 403) {
    return new DeployError(
      "github-auth",
      "GitHub refused the deploy token. Check it still has Actions: write on this repository.",
    );
  }
  if (status === 404) {
    return new DeployError(
      "github-not-found",
      "GitHub could not find the repository or the release workflow. Check GITHUB_DEPLOY_REPO.",
    );
  }
  return new DeployError("github-unavailable", `GitHub answered HTTP ${status}.`);
}

// ── reads ─────────────────────────────────────────────────────────────────

/**
 * The newest commit on the configured branch, as GitHub reports it.
 *
 * The SHA is validated rather than trusted: only a 40-character hex commit can
 * be displayed or dispatched.
 */
export async function fetchLatestCommit(
  config: DeployConfig,
  fetchImpl: FetchLike = fetch,
  signal: AbortSignal | undefined = timeoutSignal(5_000),
): Promise<CommitInfo> {
  if (!config.token || !config.repo) {
    throw new DeployError("not-configured", notConfiguredMessage());
  }
  if (!config.branch) {
    throw new DeployError("branch-not-allowed", branchNotAllowedMessage());
  }
  const branch = config.branch;

  let response: Response;
  try {
    response = await fetchImpl(`${GITHUB_API}/repos/${config.repo}/commits/${encodeURIComponent(branch)}`, {
      headers: authHeaders(config.token),
      cache: "no-store",
      signal,
    });
  } catch {
    throw new DeployError("github-unavailable", "GitHub did not answer the commit lookup.");
  }

  if (!response.ok) throw githubError(response.status);

  const body = (await response.json().catch(() => null)) as
    | { sha?: unknown; html_url?: unknown; commit?: { message?: unknown } }
    | null;
  const rawCommit = body?.sha;
  const commit = typeof rawCommit === "string" && COMMIT_RE.test(rawCommit) ? rawCommit.toLowerCase() : null;
  if (!commit) {
    throw new DeployError("github-unavailable", "GitHub returned a commit that could not be read.");
  }

  const rawMessage = body?.commit?.message;
  const firstLine = typeof rawMessage === "string" ? rawMessage.split("\n")[0].trim() : "";
  const message = firstLine ? firstLine.replace(/\s+/g, " ").slice(0, 200) : null;

  return {
    commit,
    shortCommit: commit.slice(0, 7),
    message,
    url: typeof body?.html_url === "string" ? body.html_url : null,
  };
}

/**
 * A workflow_dispatch run already queued or running for this exact commit on
 * this branch.
 *
 * This is what stops a second click (or two admins) from firing two deploys:
 * GitHub's own state answers the question instead of an in-process timer that
 * would not survive a restart or a second app instance.
 */
export async function findActiveRun(
  config: DeployConfig,
  commit: string,
  fetchImpl: FetchLike = fetch,
  signal: AbortSignal | undefined = timeoutSignal(5_000),
): Promise<{ runUrl: string | null } | null> {
  if (!config.token || !config.repo || !config.branch) return null;

  try {
    const response = await fetchImpl(
      `${GITHUB_API}/repos/${config.repo}/actions/workflows/${config.workflow}/runs?branch=${encodeURIComponent(
        config.branch,
      )}&event=workflow_dispatch&per_page=10`,
      { headers: authHeaders(config.token), cache: "no-store", signal },
    );
    if (!response.ok) return null;

    const body = (await response.json().catch(() => null)) as
      | { workflow_runs?: Array<{ head_sha?: unknown; status?: unknown; html_url?: unknown }> }
      | null;
    const active = (body?.workflow_runs ?? []).find(
      (run) =>
        typeof run.head_sha === "string" &&
        run.head_sha.toLowerCase() === commit.toLowerCase() &&
        (run.status === "queued" || run.status === "in_progress" || run.status === "waiting" || run.status === "pending"),
    );
    if (!active) return null;

    return { runUrl: typeof active.html_url === "string" ? active.html_url : null };
  } catch {
    // A failed look-up must not block the deploy: the workflow's own
    // concurrency group is the backstop.
    return null;
  }
}

// ── the dispatch ──────────────────────────────────────────────────────────

export async function dispatchDeploy(
  config: DeployConfig,
  reason: string,
  fetchImpl: FetchLike = fetch,
  signal: AbortSignal | undefined = timeoutSignal(10_000),
): Promise<void> {
  if (!config.token || !config.repo) {
    throw new DeployError("not-configured", notConfiguredMessage());
  }
  if (!config.branch) {
    throw new DeployError("branch-not-allowed", branchNotAllowedMessage());
  }

  let response: Response;
  try {
    response = await fetchImpl(`${GITHUB_API}/repos/${config.repo}/actions/workflows/${config.workflow}/dispatches`, {
      method: "POST",
      headers: { ...authHeaders(config.token), "Content-Type": "application/json" },
      cache: "no-store",
      signal,
      body: JSON.stringify({
        ref: config.branch,
        inputs: {
          deploy: "true",
          reason: reason.replace(/\s+/g, " ").trim().slice(0, MAX_REASON),
        },
      }),
    });
  } catch {
    throw new DeployError("github-unavailable", "GitHub did not answer the deploy request.");
  }

  if (!response.ok) throw githubError(response.status);
  // GitHub answers a successful dispatch with 204 No Content. A 200 without a
  // dispatch is not a thing; anything else is treated as rejected.
  if (response.status !== 204 && response.status !== 201) {
    throw new DeployError("dispatch-rejected", `GitHub accepted the request but answered HTTP ${response.status}.`);
  }

  // No commit is sent: GitHub runs the workflow at the head of `ref`. The
  // dashboard only dispatches when that head IS the commit shown, and the
  // workflow re-checks the checked-out SHA against the selected branch head.
}

// ── orchestration ─────────────────────────────────────────────────────────

/**
 * Request a deploy of the newest commit on an allowlisted branch, unless it is
 * already live or a run for it is already queued.
 *
 * Returns an outcome instead of throwing for the states the dashboard should
 * explain calmly; transport failures throw `DeployError`. A branch outside the
 * allowlist throws `branch-not-allowed` before any network call.
 */
export async function deployLatest({
  liveCommit,
  branch = DEFAULT_DEPLOY_BRANCH,
  reason = "Admin operations dashboard",
  env = process.env,
  fetchImpl = fetch,
}: {
  liveCommit: string | null;
  branch?: unknown;
  reason?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
}): Promise<DeployOutcome> {
  const config = readDeployConfig(env, branch);
  if (!config.token || !config.repo) {
    return { status: "not-configured", message: notConfiguredMessage() };
  }
  if (!config.branch) {
    throw new DeployError("branch-not-allowed", branchNotAllowedMessage());
  }
  const selected = config.branch;

  const latest = await fetchLatestCommit(config, fetchImpl);

  if (liveCommit && liveCommit.toLowerCase() === latest.commit) {
    return { status: "already-live", branch: selected, commit: latest.commit, shortCommit: latest.shortCommit };
  }

  const active = await findActiveRun(config, latest.commit, fetchImpl);
  if (active) {
    return {
      status: "already-running",
      branch: selected,
      commit: latest.commit,
      shortCommit: latest.shortCommit,
      runUrl: active.runUrl,
    };
  }

  await dispatchDeploy(config, reason, fetchImpl);

  return {
    status: "dispatched",
    branch: selected,
    commit: latest.commit,
    shortCommit: latest.shortCommit,
    workflowUrl: deployWorkflowUrl(config.repo),
    message: `Deploy requested for ${selected}@${latest.shortCommit}. The workflow builds and then activates it behind the production environment.`,
  };
}

/**
 * What the page needs to render one branch's row: whether it can dispatch at
 * all, which commit is newest, and whether that commit is already live.
 *
 * Never throws — a GitHub outage renders "could not check" beside the live
 * commit rather than a 500 on the operations page.
 */
export async function getDeployTarget(
  liveCommit: string | null,
  {
    branch = DEFAULT_DEPLOY_BRANCH,
    env = process.env,
    fetchImpl = fetch,
  }: { branch?: unknown; env?: NodeJS.ProcessEnv; fetchImpl?: FetchLike } = {},
): Promise<DeployTarget> {
  const config = readDeployConfig(env, branch);
  const workflowUrl = deployWorkflowUrl(config.repo);
  if (!config.token || !config.repo) {
    return { configured: false, latest: null, upToDate: false, reason: notConfiguredMessage(), workflowUrl };
  }
  if (!config.branch) {
    return { configured: false, latest: null, upToDate: false, reason: branchNotAllowedMessage(), workflowUrl };
  }

  try {
    const latest = await fetchLatestCommit(config, fetchImpl);
    return {
      configured: true,
      latest,
      upToDate: Boolean(liveCommit && liveCommit.toLowerCase() === latest.commit),
      reason: null,
      workflowUrl,
    };
  } catch (error) {
    return {
      configured: true,
      latest: null,
      upToDate: false,
      reason: error instanceof DeployError ? error.message : "The newest commit could not be read from GitHub.",
      workflowUrl,
    };
  }
}

/**
 * Both allowlisted branches, in allowlist order, for the operations page's
 * selector. One GitHub read per branch; a failure on one does not hide the other.
 */
export async function getDeployTargets(
  liveCommit: string | null,
  options: { env?: NodeJS.ProcessEnv; fetchImpl?: FetchLike } = {},
): Promise<BranchDeployTarget[]> {
  return Promise.all(
    DEPLOY_BRANCHES.map(async (branch) => ({
      branch,
      ...(await getDeployTarget(liveCommit, { ...options, branch })),
    })),
  );
}
