// tests/admin-deploy-latest.test.mjs
//
// Tests for the admin "deploy an allowlisted branch" control:
//   - src/lib/admin/deployLatest.ts  (GitHub dispatch, branch allowlist, live/up-to-date logic)
//   - src/app/api/admin/deploy-latest/route.ts (auth + branch validation + audit gate)
//   - src/app/admin/operations/DeployBranchSelector.tsx (never sees the token)
//
// The properties that matter:
//   1. the token never leaves the server and never appears in a result;
//   2. a branch outside the allowlist is refused before any network call;
//   3. an already-live commit or an already-running run does not dispatch;
//   4. the dispatch request is exactly the release workflow on the SELECTED
//      branch with deploy=true — no caller-supplied repository or workflow.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import {
  DEFAULT_DEPLOY_BRANCH,
  DEPLOY_BRANCHES,
  DEPLOY_WORKFLOW,
  DEFAULT_DEPLOY_REPO,
  DeployError,
  deployLatest,
  fetchLatestCommit,
  findActiveRun,
  getDeployTarget,
  getDeployTargets,
  isDeployBranch,
  readDeployConfig,
} from "../src/lib/admin/deployLatest";

// A stand-in, not a token: nothing here talks to GitHub, and the value only has
// to be echoed back in the Authorization header assertion below.
const TOKEN = "sentinel-deploy-token";
const SHA = "3c8db18a8c24eabca21c495f7a7125404c52c18b";
const OTHER = "5d9ec29b9d35fbcba31d59608b1825404c52c18c";
const REPO = "Hahuyphananh/GRYND";

const ENV = { GITHUB_DEPLOY_TOKEN: TOKEN, GITHUB_DEPLOY_REPO: REPO };

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function commitBody(sha = SHA) {
  return {
    sha,
    html_url: `https://github.com/${REPO}/commit/${sha}`,
    commit: { message: "feat(product): solitaire first\n\nbody that is not shown" },
  };
}

/** A fetch stub that records calls and answers the three GitHub endpoints. */
function githubStub({ runs = [], dispatchStatus = 204, commitStatus = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    if (url.includes(`/repos/${REPO}/commits/`)) {
      return commitStatus === 200 ? jsonResponse(200, commitBody()) : jsonResponse(commitStatus, { message: "nope" });
    }
    if (url.includes(`/repos/${REPO}/actions/workflows/${DEPLOY_WORKFLOW}/runs`)) {
      return jsonResponse(200, { workflow_runs: runs });
    }
    if (url.endsWith(`/repos/${REPO}/actions/workflows/${DEPLOY_WORKFLOW}/dispatches`)) {
      return new Response(null, { status: dispatchStatus });
    }
    throw new Error(`unexpected GitHub URL: ${url}`);
  };
  return { calls, fetchImpl };
}

async function rejection(promiseFactory) {
  try {
    await promiseFactory();
  } catch (error) {
    return error;
  }
  assert.fail("expected the call to reject");
}

// ── configuration ─────────────────────────────────────────────────────────

test("deploy config: the branch allowlist is exact and solitaire-first is the default", () => {
  assert.deepEqual([...DEPLOY_BRANCHES], ["main", "solitaire-first"]);
  assert.equal(DEFAULT_DEPLOY_BRANCH, "solitaire-first");
  assert.equal(isDeployBranch("solitaire-first"), true);
  assert.equal(isDeployBranch("main"), true);
  assert.equal(isDeployBranch("feature"), false);
  assert.equal(isDeployBranch("refs/heads/main"), false);
  assert.equal(isDeployBranch(null), false);
});

test("deploy config: only a repository-shaped value is accepted and the branch is never trusted", () => {
  const config = readDeployConfig(ENV);
  assert.equal(config.repo, REPO);
  assert.equal(config.token, TOKEN);
  assert.equal(config.workflow, DEPLOY_WORKFLOW);
  assert.equal(config.branch, DEFAULT_DEPLOY_BRANCH);

  assert.equal(readDeployConfig(ENV, "main").branch, "main");
  assert.equal(readDeployConfig(ENV, "production").branch, null);
  assert.equal(readDeployConfig(ENV, "refs/heads/main").branch, null);

  assert.equal(readDeployConfig({ GITHUB_DEPLOY_TOKEN: "  " }).token, null);
  assert.equal(readDeployConfig({}).repo, DEFAULT_DEPLOY_REPO);
  assert.equal(readDeployConfig({ GITHUB_DEPLOY_REPO: "not a repo" }).repo, null);
  // The branch is a parameter, never an environment variable.
  assert.equal(readDeployConfig({ GITHUB_DEPLOY_REPO: REPO, DEPLOY_REF: "feature" }).branch, DEFAULT_DEPLOY_BRANCH);
});

// ── reads ─────────────────────────────────────────────────────────────────

test("latest commit: the SHA is validated and the message is one bounded line", async () => {
  const config = readDeployConfig(ENV, "solitaire-first");
  const { calls, fetchImpl } = githubStub();

  const latest = await fetchLatestCommit(config, fetchImpl);

  assert.equal(latest.commit, SHA);
  assert.equal(latest.shortCommit, SHA.slice(0, 7));
  assert.equal(latest.message, "feat(product): solitaire first");
  assert.equal(latest.url, `https://github.com/${REPO}/commit/${SHA}`);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://api.github.com/repos/${REPO}/commits/solitaire-first`);
  const headers = new Headers(calls[0].init.headers);
  assert.equal(headers.get("authorization"), `Bearer ${TOKEN}`);
  assert.equal(headers.get("accept"), "application/vnd.github+json");
});

test("latest commit: an unreadable sha is refused, not displayed", async () => {
  const config = readDeployConfig(ENV);
  const fetchImpl = async () => jsonResponse(200, { sha: "dev", commit: { message: "x" } });

  const error = await rejection(() => fetchLatestCommit(config, fetchImpl));
  assert.ok(error instanceof DeployError);
  assert.equal(error.code, "github-unavailable");
});

test("latest commit: GitHub failures become codes, never raw bodies", async () => {
  const config = readDeployConfig(ENV);

  const unauthorised = await rejection(() => fetchLatestCommit(config, async () => jsonResponse(401, { message: "Bad credentials" })));
  assert.equal(unauthorised.code, "github-auth");
  assert.ok(!unauthorised.message.includes("Bad credentials"));

  const missing = await rejection(() => fetchLatestCommit(config, async () => jsonResponse(404, { message: "Not Found" })));
  assert.equal(missing.code, "github-not-found");

  const offline = await rejection(() =>
    fetchLatestCommit(config, async () => {
      throw new Error("ECONNREFUSED");
    }),
  );
  assert.equal(offline.code, "github-unavailable");
});

test("latest commit: no token means no network call", async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    return jsonResponse(200, commitBody());
  };

  const error = await rejection(() => fetchLatestCommit(readDeployConfig({}), fetchImpl));
  assert.equal(error.code, "not-configured");
  assert.equal(called, false);
});

test("latest commit: a branch outside the allowlist never reaches GitHub", async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    return jsonResponse(200, commitBody());
  };

  const error = await rejection(() => fetchLatestCommit(readDeployConfig(ENV, "victim-branch"), fetchImpl));
  assert.equal(error.code, "branch-not-allowed");
  assert.equal(called, false);
});

test("active run: only a queued/running run for this exact commit counts", async () => {
  const config = readDeployConfig(ENV, "solitaire-first");

  const running = await findActiveRun(
    config,
    SHA,
    githubStub({
      runs: [
        { head_sha: OTHER, status: "in_progress", html_url: "https://github.com/x/y/actions/runs/1" },
        { head_sha: SHA, status: "in_progress", html_url: "https://github.com/x/y/actions/runs/2" },
      ],
    }).fetchImpl,
  );
  assert.equal(running.runUrl, "https://github.com/x/y/actions/runs/2");

  const completed = await findActiveRun(
    config,
    SHA,
    githubStub({ runs: [{ head_sha: SHA, status: "completed", html_url: "https://github.com/x/y/actions/runs/3" }] })
      .fetchImpl,
  );
  assert.equal(completed, null);
});

// ── orchestration ─────────────────────────────────────────────────────────

test("deploy: a commit that is already live is not dispatched", async () => {
  const { calls, fetchImpl } = githubStub();

  const outcome = await deployLatest({ liveCommit: SHA, env: ENV, fetchImpl });

  assert.equal(outcome.status, "already-live");
  assert.equal(outcome.branch, "solitaire-first");
  assert.equal(outcome.shortCommit, SHA.slice(0, 7));
  assert.equal(calls.length, 1, "only the commit lookup should run");
  assert.ok(!calls.some((call) => call.url.endsWith("/dispatches")));
});

test("deploy: an in-flight run for the newest commit is reported, not duplicated", async () => {
  const { calls, fetchImpl } = githubStub({
    runs: [{ head_sha: SHA, status: "queued", html_url: "https://github.com/x/y/actions/runs/9" }],
  });

  const outcome = await deployLatest({ liveCommit: OTHER, branch: "main", env: ENV, fetchImpl });

  assert.equal(outcome.status, "already-running");
  assert.equal(outcome.branch, "main");
  assert.equal(outcome.runUrl, "https://github.com/x/y/actions/runs/9");
  assert.ok(!calls.some((call) => call.url.endsWith("/dispatches")));
});

test("deploy: dispatches release.yml on the selected branch with deploy=true and no token in the result", async () => {
  const { calls, fetchImpl } = githubStub();

  const outcome = await deployLatest({
    liveCommit: OTHER,
    branch: "solitaire-first",
    reason: "  Admin dashboard\n deploy  ",
    env: ENV,
    fetchImpl,
  });

  assert.equal(outcome.status, "dispatched");
  assert.equal(outcome.branch, "solitaire-first");
  assert.equal(outcome.commit, SHA);
  assert.equal(outcome.workflowUrl, `https://github.com/${REPO}/actions/workflows/${DEPLOY_WORKFLOW}`);

  const dispatch = calls.find((call) => call.url.endsWith("/dispatches"));
  assert.ok(dispatch, "the workflow must be dispatched");
  assert.equal(dispatch.init.method, "POST");
  assert.equal(dispatch.url, `https://api.github.com/repos/${REPO}/actions/workflows/${DEPLOY_WORKFLOW}/dispatches`);

  const body = JSON.parse(dispatch.init.body);
  assert.deepEqual(body.ref, "solitaire-first");
  assert.equal(body.inputs.deploy, "true");
  assert.equal(body.inputs.reason, "Admin dashboard deploy");
  assert.ok(!JSON.stringify(body).includes(TOKEN));

  // The token must never be part of anything rendered or logged.
  assert.ok(!JSON.stringify(outcome).includes(TOKEN));
});

test("deploy: main stays deployable through the same contract", async () => {
  const { calls, fetchImpl } = githubStub();

  const outcome = await deployLatest({ liveCommit: OTHER, branch: "main", env: ENV, fetchImpl });

  assert.equal(outcome.status, "dispatched");
  assert.equal(outcome.branch, "main");
  const dispatch = calls.find((call) => call.url.endsWith("/dispatches"));
  assert.equal(JSON.parse(dispatch.init.body).ref, "main");
});

test("deploy: a branch outside the allowlist is refused before the network", async () => {
  let called = false;
  const error = await rejection(() =>
    deployLatest({
      liveCommit: OTHER,
      branch: "refs/heads/feature",
      env: ENV,
      fetchImpl: async () => {
        called = true;
        return jsonResponse(200, commitBody());
      },
    }),
  );

  assert.ok(error instanceof DeployError);
  assert.equal(error.code, "branch-not-allowed");
  assert.equal(called, false);
});

test("deploy: missing configuration is an outcome, not a crash", async () => {
  let called = false;
  const outcome = await deployLatest({
    liveCommit: OTHER,
    env: {},
    fetchImpl: async () => {
      called = true;
      return jsonResponse(200, commitBody());
    },
  });

  assert.equal(outcome.status, "not-configured");
  assert.match(outcome.message, /GITHUB_DEPLOY_TOKEN/);
  assert.equal(called, false);
});

test("deploy: a rejected dispatch is surfaced as a DeployError", async () => {
  const { fetchImpl } = githubStub({ dispatchStatus: 403 });

  const error = await rejection(() => deployLatest({ liveCommit: OTHER, env: ENV, fetchImpl }));
  assert.equal(error.code, "github-auth");
});

test("deploy target: the page learns configured, newest and up-to-date without a throw", async () => {
  const offline = await getDeployTarget(SHA, {
    env: ENV,
    fetchImpl: async () => {
      throw new Error("offline");
    },
  });
  assert.equal(offline.configured, true);
  assert.equal(offline.latest, null);
  assert.match(offline.reason, /did not answer/);

  const fresh = await getDeployTarget(SHA, { env: ENV, fetchImpl: githubStub().fetchImpl });
  assert.equal(fresh.upToDate, true);

  const behind = await getDeployTarget(OTHER, { env: ENV, fetchImpl: githubStub().fetchImpl });
  assert.equal(behind.upToDate, false);
  assert.equal(behind.latest.shortCommit, SHA.slice(0, 7));

  const unconfigured = await getDeployTarget(OTHER, { env: {} });
  assert.equal(unconfigured.configured, false);
  assert.equal(unconfigured.latest, null);
  assert.equal(
    unconfigured.workflowUrl,
    `https://github.com/${DEFAULT_DEPLOY_REPO}/actions/workflows/${DEPLOY_WORKFLOW}`,
  );

  const notAllowed = await getDeployTarget(OTHER, { branch: "feature", env: ENV, fetchImpl: githubStub().fetchImpl });
  assert.equal(notAllowed.configured, false);
  assert.equal(notAllowed.latest, null);
});

test("deploy targets: both allowlisted branches are reported, default first in the page", async () => {
  const targets = await getDeployTargets(OTHER, { env: ENV, fetchImpl: githubStub().fetchImpl });

  assert.deepEqual(
    targets.map((target) => target.branch),
    ["main", "solitaire-first"],
  );
  assert.ok(targets.every((target) => target.configured));
  assert.ok(targets.every((target) => target.latest.commit === SHA));
  assert.ok(targets.every((target) => target.upToDate === false));
});

// ── static guarantees ─────────────────────────────────────────────────────

test("deploy route: validates the branch, re-checks auth and admin, audits, and never shells out", async () => {
  const source = await fs.readFile("src/app/api/admin/deploy-latest/route.ts", "utf8");

  assert.match(source, /await auth\(\)/);
  assert.match(source, /isAdmin\(userId\)/);
  assert.match(source, /isDeployBranch\(branch\)/);
  assert.match(source, /DEPLOY_BRANCHES\.join/);
  assert.match(source, /deployLatest\(\{ liveCommit, branch, reason \}\)/);
  assert.match(source, /adminAuditLog\("admin_deploy_dispatch"/);
  assert.ok(!/child_process|exec\(|spawn\(|cross-spawn/.test(source), "the app must not run host commands");
});

test("operations page: the branch selector sits between the live commit and the newest attempt", async () => {
  const page = await fs.readFile("src/app/admin/operations/page.tsx", "utf8");

  assert.match(page, /requireAdminPage\(\)/);
  assert.match(page, /getDeployTargets\(live\?\.commit \?\? null\)/);
  assert.match(page, /<DeployBranchSelector/);
  assert.match(page, /defaultBranch=\{DEFAULT_DEPLOY_BRANCH\}/);
  assert.match(page, /Deployment target/);
  assert.match(page, /Live commit/);
  assert.match(page, /source branch/);
});

test("deploy selector: the client never reads the GitHub token and names branch + full sha", async () => {
  const selector = await fs.readFile("src/app/admin/operations/DeployBranchSelector.tsx", "utf8");

  assert.ok(!selector.includes("GITHUB_DEPLOY_TOKEN"), "the token is server-only");
  assert.match(selector, /\/api\/admin\/deploy-latest/);
  assert.match(selector, /branch: activeBranch/);
  assert.match(selector, /Deploy branch \$\{activeBranch\} at \$\{latest\.commit\}/);
  assert.match(selector, /startsWith\("https:\/\/github\.com\/"\)/, "only GitHub URLs are linked");
  assert.match(selector, /data-admin-deploy-latest-fallback/);
  assert.match(selector, /run the workflow on GitHub/);
  assert.match(selector, /data-admin-deploy-branch-select/);
});
