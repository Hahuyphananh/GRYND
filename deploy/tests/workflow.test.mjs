/**
 * deploy/tests/workflow.test.mjs — the GitHub Actions deployment contract.
 *
 * No test contacts GitHub, SSH or systemd. The CI runner is exercised with a
 * stub controller and a stub health probe against a throwaway root.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { layout } from "../lib/layout.mjs";
import { ensureLayout } from "../lib/state.mjs";
import { evaluateDeploymentGuard } from "../lib/deployment-guard.mjs";
import {
  MAX_DEPLOYMENT_RECORDS,
  appendDeploymentRecord,
  createDeploymentRecord,
  readDeploymentRecords,
  sanitizeDeploymentRecord,
} from "../lib/workflow-records.mjs";
import { ciDeployMain, runCiDeploy } from "../lib/ci-deploy.mjs";
import { buildFixtureRelease } from "../staging/build-fixture.mjs";

const ID_A = "20261025T120000Z-abc1234";
const ID_B = "20261026T130000Z-def5678";

function commitFor(id) {
  const short = id.slice(id.indexOf("-") + 1);
  return `${short}${"0".repeat(40 - short.length)}`;
}

function requestFor(id, overrides = {}) {
  return {
    releaseId: id,
    commit: commitFor(id),
    buildId: `build-${id.slice(0, 15)}`,
    runId: "12345",
    runAttempt: 1,
    workflow: "release.yml",
    event: "push",
    target: "production",
    builtAt: "2026-10-26T11:50:00.000Z",
    startedAt: "2026-10-26T12:00:00.000Z",
    requestedBy: "octocat",
    reason: "push abc1234",
    artifactHash: `sha256:${"b".repeat(64)}`,
    ...overrides,
  };
}

async function tempRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "grynd-ci-"));
  await ensureLayout(layout(root));
  return root;
}

async function writeEnvFiles(l) {
  await fs.writeFile(l.appEnv, "FIXTURE=do-not-print\n", { mode: 0o600 });
  await fs.writeFile(l.realtimeEnv, "FIXTURE=do-not-print\n", { mode: 0o600 });
}

function passingProbe() {
  return async () => ({ ok: true, status: 200, ms: 1, error: null });
}

function stubController({ failOnRestart = null } = {}) {
  let restarts = 0;
  return {
    name: "stub",
    restarts: () => restarts,
    async assertReady() {},
    async restart() {
      restarts += 1;
      if (restarts === failOnRestart) {
        throw new Error("systemctl restart failed (simulated)");
      }
    },
    async stop() {},
  };
}

async function installFixture(root, id) {
  const l = layout(root);
  await buildFixtureRelease({ incomingDir: l.incomingDir(id), id });
  return id;
}

// ── guard ──────────────────────────────────────────────────────────────────

test("guard: a push run may deploy only while its commit is main and not older than active", () => {
  assert.equal(evaluateDeploymentGuard({ event: "push", targetToMain: "identical" }).code, "CURRENT");
  assert.equal(evaluateDeploymentGuard({ event: "push", targetToMain: "ahead" }).proceed, false);
  assert.equal(evaluateDeploymentGuard({ event: "push", targetToMain: "behind" }).proceed, false);
  assert.equal(evaluateDeploymentGuard({ event: "push", targetToMain: "diverged" }).proceed, false);
  assert.equal(evaluateDeploymentGuard({ event: "push", targetToMain: "unavailable" }).proceed, false);

  const older = evaluateDeploymentGuard({
    event: "push",
    targetToMain: "identical",
    targetToActive: "ahead",
  });
  assert.equal(older.proceed, false);
  assert.equal(older.code, "OLDER_THAN_ACTIVE");

  const same = evaluateDeploymentGuard({
    event: "push",
    targetToMain: "identical",
    targetToActive: "identical",
  });
  assert.equal(same.proceed, true);
  assert.equal(same.code, "ALREADY_ACTIVE");

  const forward = evaluateDeploymentGuard({
    event: "push",
    targetToMain: "identical",
    targetToActive: "behind",
  });
  assert.equal(forward.proceed, true);
});

test("guard: only an explicit manual dispatch may bypass ordering", () => {
  const blocked = evaluateDeploymentGuard({
    event: "workflow_dispatch",
    targetToMain: "ahead",
    targetToActive: "ahead",
  });
  assert.equal(blocked.proceed, false);

  const manual = evaluateDeploymentGuard({
    event: "workflow_dispatch",
    targetToMain: "ahead",
    targetToActive: "ahead",
    allowOutOfOrder: true,
  });
  assert.equal(manual.proceed, true);
  assert.equal(manual.code, "OUT_OF_ORDER");

  // A push can never opt into out-of-order deployment.
  const push = evaluateDeploymentGuard({
    event: "push",
    targetToMain: "ahead",
    allowOutOfOrder: true,
  });
  assert.equal(push.proceed, false);
});

test("guard: a non-main ref or unverifiable comparison fails closed", () => {
  assert.equal(
    evaluateDeploymentGuard({ event: "push", branch: "refs/heads/feature", targetToMain: "identical" }).code,
    "NOT_MAIN",
  );
  assert.equal(
    evaluateDeploymentGuard({ event: "push", targetToMain: "not-a-status" }).code,
    "MAIN_UNKNOWN",
  );
  assert.equal(
    evaluateDeploymentGuard({
      event: "push",
      targetToMain: "identical",
      targetToActive: "not-a-status",
    }).proceed,
    false,
  );
});

// ── records ────────────────────────────────────────────────────────────────

function validRecord(overrides = {}) {
  return {
    runId: "12345",
    runAttempt: 1,
    workflow: "release.yml",
    event: "push",
    target: "production",
    commit: commitFor(ID_A),
    releaseId: ID_A,
    buildId: "build-abc123",
    builtAt: "2026-10-26T11:50:00.000Z",
    startedAt: "2026-10-26T12:00:00.000Z",
    finishedAt: "2026-10-26T12:00:30.000Z",
    durationMs: 30_000,
    requestedBy: "octocat",
    reason: "push abc1234",
    outcome: "activated",
    artifactHash: `sha256:${"b".repeat(64)}`,
    health: { ok: true, checks: [{ name: "app", ok: true, status: 200, ms: 12, error: null }] },
    rollback: null,
    ...overrides,
  };
}

test("records: unknown and secret-shaped fields are dropped", () => {
  const record = sanitizeDeploymentRecord(
    validRecord({
      token: "ghs_super_secret",
      // Assembled at runtime so the fixture is not a scan-detectable header.
      sshKey: ["-----BEGIN", "OPENSSH PRIVATE KEY-----"].join(" "),
      deployHost: "203.0.113.10",
      reason: "line\u0000one\ntwo",
      health: {
        ok: true,
        checks: [{ name: "app", ok: true, status: 200, ms: 3, error: "Bearer abcdefghijklmnop" }],
      },
    }),
  );

  const serialized = JSON.stringify(record);
  assert.equal(serialized.includes("ghs_super_secret"), false);
  assert.equal(serialized.includes("PRIVATE KEY"), false);
  assert.equal(serialized.includes("203.0.113.10"), false);
  assert.equal(serialized.includes("\\u0000"), false);
  assert.equal(record.reason, "line one two");
  assert.match(record.health.checks[0].error, /Bearer/); // display-side redaction happens in the dashboard
});

test("records: missing run id, commit or an invalid outcome is rejected", () => {
  assert.throws(() => sanitizeDeploymentRecord(validRecord({ runId: "" })), /run id/);
  assert.throws(() => sanitizeDeploymentRecord(validRecord({ commit: "abc" })), /commit/);
  assert.throws(() => sanitizeDeploymentRecord(validRecord({ outcome: "maybe" })), /outcome/);
});

test("records: append is idempotent per run, newest first and bounded", async () => {
  const root = await tempRoot();
  const l = layout(root);
  try {
    await appendDeploymentRecord(l, sanitizeDeploymentRecord(validRecord({ runId: "1" })));
    await appendDeploymentRecord(l, sanitizeDeploymentRecord(validRecord({ runId: "2" })));
    const replaced = await appendDeploymentRecord(
      l,
      sanitizeDeploymentRecord(validRecord({ runId: "2", outcome: "skipped", skipReason: "already active" })),
    );
    assert.equal(replaced.total, 2);
    let read = await readDeploymentRecords(l);
    assert.deepEqual(read.records.map((record) => record.runId), ["2", "1"]);
    assert.equal(read.records[0].outcome, "skipped");

    for (let index = 0; index < MAX_DEPLOYMENT_RECORDS + 5; index += 1) {
      await appendDeploymentRecord(l, sanitizeDeploymentRecord(validRecord({ runId: String(1000 + index) })));
    }
    read = await readDeploymentRecords(l);
    assert.equal(read.records.length, MAX_DEPLOYMENT_RECORDS);
    assert.equal(read.records[0].runId, String(1000 + MAX_DEPLOYMENT_RECORDS + 4));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("records: a corrupt history file is reported, then repaired by the next append", async () => {
  const root = await tempRoot();
  const l = layout(root);
  try {
    await fs.writeFile(l.deploymentsState, "{ truncated");
    const broken = await readDeploymentRecords(l);
    assert.deepEqual(broken.records, []);
    assert.match(broken.error, /not valid JSON/);

    await appendDeploymentRecord(l, sanitizeDeploymentRecord(validRecord()));
    const fixed = await readDeploymentRecords(l);
    assert.equal(fixed.records.length, 1);
    assert.equal(fixed.error, null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("records: createDeploymentRecord maps a failed activation and its revert", () => {
  const record = createDeploymentRecord({
    request: requestFor(ID_B, { runId: "777" }),
    install: { ok: true },
    activation: {
      ok: false,
      stage: "health",
      health: { ok: false, checks: [{ name: "app", ok: false, status: 200, ms: 2, error: "db=error" }] },
      revert: { target: ID_A, error: null, health: { ok: true, checks: [] } },
    },
    startedAt: "2026-10-26T12:00:00.000Z",
    finishedAt: "2026-10-26T12:00:05.000Z",
  });
  assert.equal(record.outcome, "failed");
  assert.equal(record.rollback.attempted, true);
  assert.equal(record.rollback.target, ID_A);
  assert.equal(record.rollback.ok, true);
  assert.equal(record.durationMs, 5_000);
});

// ── CI deployment runner ───────────────────────────────────────────────────

test("ci deploy: activates once, records it, and a retried run is a restart-free no-op", async () => {
  const root = await tempRoot();
  const l = layout(root);
  await writeEnvFiles(l);
  await installFixture(root, ID_B);
  const controller = stubController();
  try {
    const request = requestFor(ID_B);
    const first = await runCiDeploy({
      root,
      request,
      controller,
      healthOptions: { attempts: 1, probe: passingProbe() },
    });
    assert.equal(first.ok, true, first.activation?.error ?? "");
    assert.equal(first.outcome, "activated");
    assert.equal(first.active.releaseId, ID_B);
    assert.equal(controller.restarts(), 1);

    const firstRecords = await readDeploymentRecords(l);
    assert.equal(firstRecords.records.length, 1);
    assert.equal(firstRecords.records[0].outcome, "activated");
    assert.equal(firstRecords.records[0].releaseId, ID_B);

    const second = await runCiDeploy({
      root,
      request: { ...request, runId: "12346" },
      controller,
      healthOptions: { attempts: 1, probe: passingProbe() },
    });
    assert.equal(second.ok, true);
    assert.equal(second.outcome, "skipped");
    assert.equal(second.activation.skipped, true);
    assert.equal(controller.restarts(), 1, "an already-active release must not be restarted");

    const records = await readDeploymentRecords(l);
    assert.equal(records.records.length, 2);
    assert.equal(records.records[0].outcome, "skipped");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("ci deploy: a failed activation reverts and the record carries the rollback result", async () => {
  const root = await tempRoot();
  const l = layout(root);
  await writeEnvFiles(l);
  await installFixture(root, ID_A);
  // The first activation restarts once; the second activation's restart is the
  // one that fails, so its revert (the third restart) can succeed.
  const controller = stubController({ failOnRestart: 2 });
  try {
    const first = await runCiDeploy({
      root,
      request: requestFor(ID_A, { runId: "1" }),
      controller,
      healthOptions: { attempts: 1, probe: passingProbe() },
    });
    assert.equal(first.outcome, "activated");

    await installFixture(root, ID_B);
    const second = await runCiDeploy({
      root,
      request: requestFor(ID_B, { runId: "2" }),
      controller,
      healthOptions: { attempts: 1, probe: passingProbe() },
    });
    assert.equal(second.ok, false);
    assert.equal(second.outcome, "failed");
    assert.equal(second.rollback.attempted, true);
    assert.equal(second.rollback.target, ID_A);
    assert.equal(second.rollback.ok, true);

    const records = await readDeploymentRecords(l);
    assert.equal(records.records[0].outcome, "failed");
    assert.equal(records.records[0].rollback.ok, true);
    const status = JSON.parse(await fs.readFile(l.activeState, "utf8"));
    assert.equal(status.releaseId, ID_A);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("ci deploy CLI: invalid stdin is refused before anything is installed", async () => {
  const root = await tempRoot();
  try {
    await assert.rejects(
      () => ciDeployMain([`--root=${root}`], { stdin: Readable.from(["{ not json"]) }),
      (error) => error.code === "INVALID_REQUEST",
    );
    await assert.rejects(
      () =>
        ciDeployMain([`--root=${root}`], {
          stdin: Readable.from([JSON.stringify(requestFor(ID_A, { commit: "abc" }))]),
        }),
      (error) => error.code === "INVALID_REQUEST",
    );
    assert.deepEqual(await fs.readdir(layout(root).incoming), [], "nothing was uploaded or installed");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("ci deploy: an invalid request is refused before anything is installed", async () => {
  const root = await tempRoot();
  try {
    await assert.rejects(
      () => runCiDeploy({ root, request: requestFor("../../etc/passwd") }),
      (error) => error.code === "INVALID_ID",
    );
    await assert.rejects(
      () => runCiDeploy({ root, request: requestFor(ID_A, { commit: "abc" }) }),
      (error) => error.code === "INVALID_REQUEST",
    );
    assert.equal(await fs.stat(layout(root).releaseDir(ID_A)).catch(() => null), null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
