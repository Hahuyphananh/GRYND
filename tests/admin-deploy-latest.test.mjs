// tests/admin-deploy-latest.test.mjs
//
// Tests for the admin "deploy the newest main commit" control:
//   - src/lib/admin/deployLatest.ts  (GitHub dispatch, live/up-to-date logic)
//   - src/app/api/admin/deploy-latest/route.ts (auth + audit gate)
//   - src/app/admin/operations/DeployLatestButton.tsx (never sees the token)
//
// The properties that matter:
//   1. the token never leaves the server and never appears in a result;
//   2. an already-live commit or an already-running run does not dispatch;
//   3. the dispatch request is exactly the release workflow on main with
//      deploy=true — no caller-supplied repository, ref or workflow.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import {
  DEPLOY_REF,
  DEPLOY_WORKFLOW,
  DEFAULT_DEPLOY_REPO,
  DeployError,
  deployLatest,
  fetchLatestCommit,
  findActiveRun,
  getDeployTarget,
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
    commit: { message: "feat(admin): deploy button\n\nbody that is not shown" },
  };
}

/** A fetch stub that records calls and answers the three GitHub endpoints. */
function githubStub({ runs = [], dispatchStatus = 204, commitStatus = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    if (url.endsWith(`/repos/${REPO}/commits/main`)) {
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

test("deploy config: only a repository-shaped value is accepted", () => {
  const config = readDeployConfig(ENV);
  assert.equal(config.repo, REPO);
  assert.equal(config.token, TOKEN);
  assert.equal(config.workflow, DEPLOY_WORKFLOW);
  assert.equal(config.ref, DEPLOY_REF);

  assert.equal(readDeployConfig({ GITHUB_DEPLOY_TOKEN: "  " }).token, null);
  assert.equal(readDeployConfig({}).repo, DEFAULT_DEPLOY_REPO);
  assert.equal(readDeployConfig({ GITHUB_DEPLOY_REPO: "not a repo" }).repo, null);
  // The ref and workflow are never read from the environment.
  assert.equal(readDeployConfig({ GITHUB_DEPLOY_REPO: REPO, DEPLOY_REF: "feature" }).ref, "main");
});

// ── reads ─────────────────────────────────────────────────────────────────

test("latest commit: the SHA is validated and the message is one bounded line", async () => {
  const config = readDeployConfig(ENV);
  const { calls, fetchImpl } = githubStub();

  const latest = await fetchLatestCommit(config, fetchImpl);

  assert.equal(latest.commit, SHA);
  assert.equal(latest.shortCommit, SHA.slice(0, 7));
  assert.equal(latest.message, "feat(admin): deploy button");
  assert.equal(latest.url, `https://github.com/${REPO}/commit/${SHA}`);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://api.github.com/repos/${REPO}/commits/main`);
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

test("active run: only a queued/running run for this exact commit counts", async () => {
  const config = readDeployConfig(ENV);

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
  assert.equal(outcome.shortCommit, SHA.slice(0, 7));
  assert.equal(calls.length, 1, "only the commit lookup should run");
  assert.ok(!calls.some((call) => call.url.endsWith("/dispatches")));
});

test("deploy: an in-flight run for the newest commit is reported, not duplicated", async () => {
  const { calls, fetchImpl } = githubStub({
    runs: [{ head_sha: SHA, status: "queued", html_url: "https://github.com/x/y/actions/runs/9" }],
  });

  const outcome = await deployLatest({ liveCommit: OTHER, env: ENV, fetchImpl });

  assert.equal(outcome.status, "already-running");
  assert.equal(outcome.runUrl, "https://github.com/x/y/actions/runs/9");
  assert.ok(!calls.some((call) => call.url.endsWith("/dispatches")));
});

test("deploy: dispatches release.yml on main with deploy=true and no token in the result", async () => {
  const { calls, fetchImpl } = githubStub();

  const outcome = await deployLatest({
    liveCommit: OTHER,
    reason: "  Admin dashboard\n deploy  ",
    env: ENV,
    fetchImpl,
  });

  assert.equal(outcome.status, "dispatched");
  assert.equal(outcome.commit, SHA);
  assert.equal(outcome.workflowUrl, `https://github.com/${REPO}/actions/workflows/${DEPLOY_WORKFLOW}`);

  const dispatch = calls.find((call) => call.url.endsWith("/dispatches"));
  assert.ok(dispatch, "the workflow must be dispatched");
  assert.equal(dispatch.init.method, "POST");
  assert.equal(dispatch.url, `https://api.github.com/repos/${REPO}/actions/workflows/${DEPLOY_WORKFLOW}/dispatches`);

  const body = JSON.parse(dispatch.init.body);
  assert.deepEqual(body.ref, "main");
  assert.equal(body.inputs.deploy, "true");
  assert.equal(body.inputs.reason, "Admin dashboard deploy");
  assert.ok(!JSON.stringify(body).includes(TOKEN));

  // The token must never be part of anything rendered or logged.
  assert.ok(!JSON.stringify(outcome).includes(TOKEN));
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
});

// ── static guarantees ─────────────────────────────────────────────────────

test("deploy route: re-checks auth and admin, audits, and never shells out", async () => {
  const source = await fs.readFile("src/app/api/admin/deploy-latest/route.ts", "utf8");

  assert.match(source, /await auth\(\)/);
  assert.match(source, /isAdmin\(userId\)/);
  assert.match(source, /deployLatest\(/);
  assert.match(source, /adminAuditLog\("admin_deploy_dispatch"/);
  assert.ok(!/child_process|exec\(|spawn\(|cross-spawn/.test(source), "the app must not run host commands");
});

test("operations page: the deploy button sits beside the live commit", async () => {
  const page = await fs.readFile("src/app/admin/operations/page.tsx", "utf8");

  assert.match(page, /requireAdminPage\(\)/);
  assert.match(page, /getDeployTarget\(live\?\.commit \?\? null\)/);
  assert.match(page, /<DeployLatestButton/);
  assert.match(page, /workflowUrl=\{deploy\.workflowUrl\}/);
  assert.match(page, /Live commit/);
});

test("deploy button: the client never reads the GitHub token", async () => {
  const button = await fs.readFile("src/app/admin/operations/DeployLatestButton.tsx", "utf8");

  assert.ok(!button.includes("GITHUB_DEPLOY_TOKEN"), "the token is server-only");
  assert.match(button, /\/api\/admin\/deploy-latest/);
  assert.match(button, /startsWith\("https:\/\/github\.com\/"\)/, "only GitHub URLs are linked");
  assert.match(button, /data-admin-deploy-latest-fallback/);
  assert.match(button, /run the workflow on GitHub/);
});
