// tests/admin-operations.test.mjs
//
// Tests for the read-only admin operations surface:
//   - src/lib/admin/operations.ts  (the host state reader)
//   - src/lib/admin/mfaDiagnostics.ts (configuration presence)
//
// The two properties that matter most here:
//   1. the reader never reads `env/`, so the admin page cannot leak a secret;
//   2. MFA diagnostics report presence ONLY, never a value or a length.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  BACKUP_STALE_AFTER_HOURS,
  DEFAULT_RELEASE_ROOT,
  deploymentLog,
  formatBytes,
  getOperationsSnapshot,
  isFailedDeployment,
  readLiveBuild,
  redactText,
  releaseRoot,
  safeText,
} from "../src/lib/admin/operations";
import { buildMfaDiagnostics, requiredMfaVariables, sessionSecretSource } from "../src/lib/admin/mfaDiagnostics";

const NOW = Date.parse("2026-10-26T12:00:00.000Z");
const SHA = "a".repeat(64);
const OTHER_SHA = "b".repeat(64);

async function makeRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "grynd-ops-page-"));
  await fs.mkdir(path.join(root, "state"), { recursive: true });
  return root;
}

async function writeJson(root, relative, value) {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value));
}

async function writeLines(root, relative, lines) {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
}

const ACTIVE = {
  releaseId: "20261025T143012Z-3f9c2ab",
  commit: "3f9c2ab0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6",
  buildId: "build-123",
  activatedAt: "2026-10-26T10:00:00.000Z",
  actor: "ops",
  reason: "release",
  previousReleaseId: "20261024T143012Z-1111111",
  health: { ok: true, attempts: 1, results: [{ name: "app", ok: true, status: 200, ms: 5 }] },
};

const DEPLOYMENT = {
  runId: "123456789",
  commit: "3f9c2ab0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6",
  releaseId: "20261025T143012Z-3f9c2ab",
  buildId: "build-123",
  event: "workflow_dispatch",
  target: "production",
  outcome: "activated",
  stage: "health",
  reason: "approved release",
  requestedBy: "Hahuyphananh",
  startedAt: "2026-10-26T09:50:00.000Z",
  finishedAt: "2026-10-26T10:00:00.000Z",
  durationMs: 600_000,
  health: { ok: true },
  rollback: null,
};

// ── reader ────────────────────────────────────────────────────────────────

test("operations: an unconfigured root is reported, not faked", async () => {
  const root = path.join(os.tmpdir(), `grynd-missing-${Date.now()}`);
  const snapshot = await getOperationsSnapshot({ env: { GRYND_RELEASE_ROOT: root }, now: NOW });

  assert.equal(snapshot.configured, false);
  assert.equal(snapshot.active, null);
  assert.deepEqual(snapshot.deployments, []);
  assert.ok(snapshot.reason.includes("No operations state"));
  assert.ok(snapshot.warnings.some((warning) => warning.code === "STATE_UNAVAILABLE"));
});

test("operations: active release, deployments and audit are read and bounded", async () => {
  const root = await makeRoot();
  await writeJson(root, "state/active.json", ACTIVE);
  await writeJson(root, "state/deployments.json", { schema: 1, records: [DEPLOYMENT] });
  await writeLines(root, "state/audit.jsonl", [
    { at: "2026-10-26T10:00:00.000Z", outcome: "ok", actor: "ops", event: "activate" },
  ]);
  await writeLines(root, "state/ops/audit.jsonl", [
    { at: "2026-10-26T11:00:00.000Z", event: "ops.denied", actor: "mallory", detail: { code: "OPS_DISABLED" } },
  ]);

  const snapshot = await getOperationsSnapshot({ env: { GRYND_RELEASE_ROOT: root }, now: NOW });

  assert.equal(snapshot.configured, true);
  assert.equal(snapshot.active.releaseId, ACTIVE.releaseId);
  assert.equal(snapshot.active.shortCommit, "3f9c2ab");
  assert.equal(snapshot.active.health.ok, true);

  assert.equal(snapshot.deployments.length, 1);
  assert.equal(snapshot.deployments[0].outcome, "activated");
  assert.equal(snapshot.deployments[0].shortCommit, "3f9c2ab");

  assert.equal(snapshot.audit.length, 2);
  assert.deepEqual(snapshot.audit.map((entry) => entry.source), ["release", "ops"]);
  assert.equal(snapshot.audit[1].detail.code, "OPS_DISABLED");
});

test("operations: the reader never reads env/ — a secret there cannot reach the page", async () => {
  const root = await makeRoot();
  await mkdirEnv(root);
  await writeJson(root, "state/active.json", ACTIVE);

  const snapshot = await getOperationsSnapshot({ env: { GRYND_RELEASE_ROOT: root }, now: NOW });
  const serialized = JSON.stringify(snapshot);

  assert.ok(!serialized.includes("SENTINEL_SECRET_VALUE"));
  assert.ok(!serialized.includes("sentinelpassword"));
  assert.ok(!serialized.includes("env/app.env"));
});

async function mkdirEnv(root) {
  const dir = path.join(root, "env");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "app.env"),
    "DATABASE_URL=postgres://sentineluser:sentinelpassword@db.example/grynd\nCLERK_SECRET_KEY=SENTINEL_SECRET_VALUE\n",
  );
}

test("operations: audit details are redacted on the way out", async () => {
  const root = await makeRoot();
  await writeLines(root, "state/audit.jsonl", [
    {
      at: "2026-10-26T10:00:00.000Z",
      event: "connect",
      actor: "ops",
      detail: {
        note: "tried postgres://user:hunter2@db/grynd",
        databaseUrl: "postgres://user:hunter2@db/grynd",
        attempts: 3,
      },
    },
  ]);

  const snapshot = await getOperationsSnapshot({ env: { GRYND_RELEASE_ROOT: root }, now: NOW });
  const serialized = JSON.stringify(snapshot);

  assert.ok(!serialized.includes("hunter2"));
  assert.equal(snapshot.audit[0].detail.databaseUrl, "[redacted]");
  assert.equal(snapshot.audit[0].detail.attempts, 3);
});

test("operations: backup verified only when the restore test matches the newest artifact", async () => {
  const root = await makeRoot();
  await writeLines(root, "state/backup/ledger.jsonl", [
    {
      event: "backup.completed",
      at: "2026-10-26T11:00:00.000Z",
      id: "b1",
      bytes: 5_242_880,
      sha256: SHA,
      destination: { id: "grynd-backups", kind: "oci-object-storage" },
    },
    {
      event: "restore.verified",
      at: "2026-10-26T11:30:00.000Z",
      backupId: "b1",
      sha256: OTHER_SHA,
      tablesChecked: 19,
      mismatches: 0,
      target: "scratch",
    },
  ]);

  const snapshot = await getOperationsSnapshot({ env: { GRYND_RELEASE_ROOT: root }, now: NOW });

  assert.equal(snapshot.backup.verified, false, "a different sha must not count as verified");
  assert.equal(snapshot.backup.restoreTestOk, true);
  assert.ok(snapshot.warnings.some((warning) => warning.code === "RESTORE_TEST_NOT_CURRENT"));
  assert.equal(formatBytes(snapshot.backup.bytes), "5 MiB");
});

test("operations: a matching restore test is reported as verified", async () => {
  const root = await makeRoot();
  await writeLines(root, "state/backup/ledger.jsonl", [
    {
      event: "backup.completed",
      at: "2026-10-26T11:00:00.000Z",
      id: "b1",
      bytes: 2048,
      sha256: SHA,
      destination: { id: "grynd-backups", kind: "oci-object-storage" },
    },
    {
      event: "restore.verified",
      at: "2026-10-26T11:30:00.000Z",
      backupId: "b1",
      sha256: SHA,
      tablesChecked: 19,
      mismatches: 0,
      target: "scratch",
    },
  ]);

  const snapshot = await getOperationsSnapshot({ env: { GRYND_RELEASE_ROOT: root }, now: NOW });
  assert.equal(snapshot.backup.verified, true);
  assert.ok(!snapshot.warnings.some((warning) => warning.code === "LOCAL_ONLY"));
});

test("operations: a stale backup is critical", async () => {
  const root = await makeRoot();
  const old = new Date(NOW - (BACKUP_STALE_AFTER_HOURS + 5) * 3_600_000).toISOString();
  await writeLines(root, "state/backup/ledger.jsonl", [
    { event: "backup.completed", at: old, id: "b1", bytes: 2048, sha256: SHA, destination: { id: "x", kind: "oci" } },
  ]);

  const snapshot = await getOperationsSnapshot({ env: { GRYND_RELEASE_ROOT: root }, now: NOW });
  assert.equal(snapshot.backup.stale, true);
  assert.ok(snapshot.warnings.some((warning) => warning.code === "STALE_BACKUP" && warning.severity === "critical"));
});

test("operations: a torn or corrupt state file degrades instead of throwing", async () => {
  const root = await makeRoot();
  await fs.writeFile(path.join(root, "state/active.json"), "{ not json");
  await fs.writeFile(path.join(root, "state/audit.jsonl"), "not-json\n{\"at\":\"2026-10-26T10:00:00.000Z\",\"event\":\"ok\"}\n");

  const snapshot = await getOperationsSnapshot({ env: { GRYND_RELEASE_ROOT: root }, now: NOW });

  assert.equal(snapshot.configured, true);
  assert.equal(snapshot.active, null);
  assert.equal(snapshot.audit.length, 1);
});

test("operations: the live commit is the one this build was made from", () => {
  const live = readLiveBuild({
    VERCEL_GIT_COMMIT_SHA: "3F9C2AB0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6",
    VERCEL_GIT_COMMIT_MESSAGE: "feat(ops): show the live commit\n\nbody that is not repeated",
    VERCEL_GIT_COMMIT_REF: "main",
    VERCEL_GIT_REPO_OWNER: "Hahuyphananh",
    VERCEL_GIT_REPO_SLUG: "GRYND",
    VERCEL_DEPLOYMENT_ID: "dpl_abc123",
    VERCEL_ENV: "production",
    VERCEL_URL: "grynd-abc.vercel.app",
  });

  assert.equal(live.source, "build-env");
  assert.equal(live.commit, "3f9c2ab0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6");
  assert.equal(live.shortCommit, "3f9c2ab");
  assert.equal(live.message, "feat(ops): show the live commit body that is not repeated");
  assert.equal(live.ref, "main");
  assert.equal(live.repo, "Hahuyphananh/GRYND");
  assert.equal(live.environment, "production");
  assert.equal(live.deploymentId, "dpl_abc123");
  assert.equal(live.url, "grynd-abc.vercel.app");

  // A placeholder is not a commit: "unknown" beats a value that is not what is live.
  assert.equal(readLiveBuild({}), null);
  assert.equal(readLiveBuild({ VERCEL_GIT_COMMIT_SHA: "dev" }), null);
  assert.equal(readLiveBuild({ VERCEL_GIT_COMMIT_SHA: "   " }), null);

  // An unexpected environment is dropped rather than rendered.
  const odd = readLiveBuild({ VERCEL_GIT_COMMIT_SHA: "a".repeat(40), VERCEL_ENV: "staging-ish" });
  assert.equal(odd.environment, null);
});

test("operations: the snapshot names the live commit with or without host state", async () => {
  const root = await makeRoot();
  await writeJson(root, "state/active.json", ACTIVE);

  // A platform build: no host release files are needed, the build metadata is
  // enough — and it must survive an unreadable state root too.
  const fromBuild = await getOperationsSnapshot({
    env: { GRYND_RELEASE_ROOT: root, VERCEL_GIT_COMMIT_SHA: "b".repeat(40) },
    now: NOW,
  });
  assert.equal(fromBuild.live.source, "build-env");
  assert.equal(fromBuild.live.shortCommit, "bbbbbbb");

  const missing = await getOperationsSnapshot({
    env: { GRYND_RELEASE_ROOT: path.join(root, "absent"), VERCEL_GIT_COMMIT_SHA: "c".repeat(40) },
    now: NOW,
  });
  assert.equal(missing.configured, false);
  assert.equal(missing.live.shortCommit, "ccccccc", "the live commit does not depend on host state");

  // A self-hosted release with no build metadata falls back to the active release.
  const fromHost = await getOperationsSnapshot({ env: { GRYND_RELEASE_ROOT: root }, now: NOW });
  assert.equal(fromHost.live.source, "host-release");
  assert.equal(fromHost.live.commit, ACTIVE.commit);
  assert.equal(fromHost.live.deploymentId, ACTIVE.releaseId);
});

test("operations: a failed deploy keeps its log lines and never leaks a secret", async () => {
  const root = await makeRoot();
  await writeJson(root, "state/deployments.json", {
    schema: 1,
    records: [
      {
        ...DEPLOYMENT,
        outcome: "failed",
        stage: "health",
        reason: "health gate failed postgres://user:hunter2@db/grynd",
        health: { ok: false, checks: [{ name: "app", ok: false, status: 503, error: "HTTP 503" }] },
        rollback: { attempted: true, target: "20261024T143012Z-1111111", ok: false, error: "revert unhealthy" },
      },
    ],
  });

  const snapshot = await getOperationsSnapshot({ env: { GRYND_RELEASE_ROOT: root }, now: NOW });
  const record = snapshot.deployments[0];

  assert.equal(record.health.ok, false);
  assert.equal(record.health.checks[0].name, "app");
  assert.equal(record.health.checks[0].status, 503);
  assert.equal(isFailedDeployment(record), true);
  assert.equal(isFailedDeployment(snapshot.deployments[1] ?? null), false);

  const log = deploymentLog(record).join("\n");
  assert.match(log, /outcome\s+failed/);
  assert.match(log, /stage\s+health/);
  assert.match(log, /health\s+app: FAILED: HTTP 503/);
  assert.match(log, /rollback\s+FAILED/);
  assert.ok(!log.includes("hunter2"), "the log must be redacted like every other ops value");
});

test("operations: the page names the live commit and only the newest attempt", async () => {
  const source = await fs.readFile("src/app/admin/operations/page.tsx", "utf8");

  assert.match(source, /Live commit/);
  assert.match(source, /Latest commit/);
  // The newest record only — a commit history table is exactly what this page
  // used to render instead of saying what is live.
  assert.match(source, /snapshot\.deployments\[0\]/);
  assert.ok(!/snapshot\.deployments\.slice\(0, 10\)/.test(source));
  assert.match(source, /deploymentLog\(latestDeployment\)/, "the failed deploy must show its log");
});

test("operations: helpers bound text and resolve an absolute root only", () => {
  assert.equal(safeText("  hello\nworld  "), "hello world");
  assert.equal(safeText("x".repeat(500)).length, 200);
  assert.equal(safeText(42), null);

  // Normalised, not resolved: resolving a runtime value makes the bundler
  // trace the whole project (see the comment in releaseRoot).
  assert.equal(releaseRoot({ GRYND_RELEASE_ROOT: "/srv/grynd" }), path.normalize("/srv/grynd"));
  assert.equal(releaseRoot({ GRYND_RELEASE_ROOT: "relative/path" }), "/home/ubuntu/grynd");
  assert.equal(releaseRoot({}), path.normalize(DEFAULT_RELEASE_ROOT));

  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1536), "1.5 KiB");
  assert.equal(formatBytes(null), "unknown");

  assert.ok(!redactText("postgres://u:p@h/db").includes("p@h"));
});

// ── MFA diagnostics ───────────────────────────────────────────────────────

test("mfa diagnostics: nothing configured is critical and names every factor", () => {
  const diagnostics = buildMfaDiagnostics({});

  assert.equal(diagnostics.anyConfigured, false);
  assert.equal(diagnostics.factors.email.configured, false);
  assert.equal(diagnostics.factors.totp.configured, false);
  assert.equal(diagnostics.factors.passphrase.configured, false);
  assert.ok(diagnostics.warnings.some((warning) => warning.code === "NO_MFA_FACTOR"));
  assert.equal(diagnostics.otpStore.kind, "memory");
  assert.equal(diagnostics.sessionSecret.source, "insecure-fallback");
  assert.ok(diagnostics.sessionSecret.secure === false);
});

test("mfa diagnostics: each mail path is recognised", () => {
  const resend = buildMfaDiagnostics({ RESEND_API_KEY: "re_placeholder" });
  assert.equal(resend.factors.email.configured, true);

  const smtp = buildMfaDiagnostics({ SMTP_HOST: "smtp.example" });
  assert.equal(smtp.factors.email.configured, true);

  const blank = buildMfaDiagnostics({ RESEND_API_KEY: "   ", SMTP_HOST: "  " });
  assert.equal(blank.factors.email.configured, false);
});

test("mfa diagnostics: totp and passphrase are presence-gated", () => {
  const diagnostics = buildMfaDiagnostics({
    ADMIN_TOTP_SECRET: "placeholder",
    ADMIN_MFA_PASSPHRASE: "placeholder",
    GAME_SESSION_SECRET: "placeholder",
  });

  assert.equal(diagnostics.anyConfigured, true);
  assert.equal(diagnostics.factors.totp.configured, true);
  assert.equal(diagnostics.factors.passphrase.configured, true);
  assert.ok(!diagnostics.warnings.some((warning) => warning.code === "NO_MFA_FACTOR"));
  assert.equal(diagnostics.sessionSecret.source, "env");
});

test("mfa diagnostics: the signing-secret fallback order matches adminMfa", () => {
  assert.equal(sessionSecretSource({ GAME_SESSION_SECRET: "x" }).source, "env");
  assert.equal(sessionSecretSource({ NEXTAUTH_SECRET: "x" }).source, "env");
  assert.equal(sessionSecretSource({ CLERK_SECRET_KEY: "x" }).source, "clerk-fallback");
  assert.equal(sessionSecretSource({}).source, "insecure-fallback");
});

test("mfa diagnostics: redis changes the OTP durability report", () => {
  const memory = buildMfaDiagnostics({ RESEND_API_KEY: "x" });
  assert.equal(memory.otpStore.kind, "memory");
  assert.ok(memory.warnings.some((warning) => warning.code === "OTP_STORE_IN_MEMORY"));

  const redis = buildMfaDiagnostics({
    RESEND_API_KEY: "x",
    UPSTASH_REDIS_REST_URL: "https://redis.example",
    UPSTASH_REDIS_REST_TOKEN: "placeholder",
  });
  assert.equal(redis.otpStore.kind, "redis");
  assert.ok(!redis.warnings.some((warning) => warning.code === "OTP_STORE_IN_MEMORY"));
});

test("mfa diagnostics: email-only is flagged as a single point of failure", () => {
  const diagnostics = buildMfaDiagnostics({ RESEND_API_KEY: "x" });
  assert.ok(diagnostics.warnings.some((warning) => warning.code === "SINGLE_FACTOR_PATH"));
});

test("mfa diagnostics: never returns a configured value", () => {
  const env = {
    RESEND_API_KEY: "re_SUPERSECRETVALUE",
    ADMIN_MFA_PASSPHRASE: "SUPERSECRETPASSPHRASE",
    ADMIN_TOTP_SECRET: "SUPERSECRETTOTP",
    GAME_SESSION_SECRET: "SUPERSECRETSESSION",
  };
  const serialized = JSON.stringify(buildMfaDiagnostics(env));

  for (const secret of ["SUPERSECRETVALUE", "SUPERSECRETPASSPHRASE", "SUPERSECRETTOTP", "SUPERSECRETSESSION"]) {
    assert.ok(!serialized.includes(secret), `diagnostics leaked ${secret}`);
  }
  assert.ok(requiredMfaVariables().includes("ADMIN_TOTP_SECRET"));
});

// ── static guarantees ─────────────────────────────────────────────────────

test("admin operations: the status endpoint no longer hardcodes email as available", async () => {
  const source = await fs.readFile("src/app/api/admin/mfa/status/route.ts", "utf8");
  // Strip comments: the rationale comment quotes the old behaviour.
  const code = source.replace(/\/\/.*$/gm, "");
  assert.ok(!/email:\s*true/.test(code), "email availability must be derived from configuration");
  assert.match(source, /buildMfaDiagnostics/);
});

test("admin operations: both pages re-check the admin gate", async () => {
  for (const page of ["src/app/admin/operations/page.tsx", "src/app/admin/operations/logs/page.tsx"]) {
    const source = await fs.readFile(page, "utf8");
    assert.match(source, /requireAdminPage\(\)/, `${page} must gate itself`);
    assert.match(source, /robots:\s*\{\s*index:\s*false/, `${page} must be noindex`);
  }
});

test("admin operations: no restart control is reachable from the admin pages", async () => {
  for (const page of ["src/app/admin/operations/page.tsx", "src/app/admin/operations/logs/page.tsx"]) {
    const source = await fs.readFile(page, "utf8");
    for (const forbidden of ["systemctl", "restart.app", "restart.realtime", "child_process"]) {
      assert.ok(!source.includes(forbidden), `${page} must not contain ${forbidden}`);
    }
  }
});

test("admin operations: the navbar exposes an admin link only for admins", async () => {
  const source = await fs.readFile("src/components/navigation-bar.jsx", "utf8");
  assert.match(source, /isAdmin\s*&&\s*\(/, "the link must be conditional");
  assert.match(source, /href="\/admin"/);
});
