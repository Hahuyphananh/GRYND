/**
 * deploy/tests/ops.test.mjs — the restricted operations runtime.
 *
 * Every gate is exercised against a temporary release root with an injected
 * command runner, unit reader and health gate. No unit is restarted, no port is
 * bound and no production path is read. A test in this file asserts that
 * property statically: the runtime contains no shell, no server and no socket.
 *
 * Run: node --test deploy/tests/ops.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { layout } from "../lib/layout.mjs";
import {
  EXCLUDED_ACTIONS,
  MANAGED_UNITS,
  OPERATION_IDS,
  OPERATIONS,
  assertArgv,
  getOperation,
} from "../lib/ops/allowlist.mjs";
import {
  INGESTIBLE_EVENTS,
  appendAudit,
  appendIngestedEvent,
  readAllEntries,
  verifyAudit,
} from "../lib/ops/audit.mjs";
import { REQUIRED_CONFIG, configStatus, parseEnvFile } from "../lib/ops/config.mjs";
import { issueToken, verifyToken } from "../lib/ops/confirm.mjs";
import { createOpsRuntime, normalizePhrase, preflightBinaries } from "../lib/ops/execute.mjs";
import { opsPaths } from "../lib/ops/paths.mjs";
import { findLeakedSecrets, redact, redactString } from "../lib/ops/redact.mjs";
import { verifyOperation } from "../lib/ops/verify.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEPLOY = path.resolve(HERE, "..");

// ── fixtures ──────────────────────────────────────────────────────────────

const APP_UNIT = MANAGED_UNITS.app;
const REALTIME_UNIT = MANAGED_UNITS.realtime;

async function makeRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "grynd-ops-"));
  const releaseLayout = layout(root);
  await fs.mkdir(releaseLayout.state, { recursive: true });
  return { root, releaseLayout, paths: opsPaths(releaseLayout) };
}

/** A clock the test can move, so token expiry is exercised without waiting. */
function makeClock(start = "2026-10-26T12:00:00.000Z") {
  let current = new Date(start).getTime();
  const now = () => new Date(current);
  now.advance = (ms) => {
    current += ms;
  };
  return now;
}

function makeRun(overrides = {}) {
  const calls = [];
  const run = async (argv, options) => {
    calls.push({ argv, options });
    return {
      ok: true,
      exitCode: 0,
      signal: null,
      timedOut: false,
      ms: 11,
      stdout: "active",
      stderr: "",
      ...overrides,
    };
  };
  run.calls = calls;
  return run;
}

function makeReader(states = {}) {
  const calls = [];
  const reader = {
    calls,
    async state(unit) {
      calls.push(unit);
      const state = states[unit] ?? "active";
      return { unit, state, active: state === "active", error: null };
    },
  };
  return reader;
}

function makeGate(ok = true) {
  const calls = [];
  const gate = async ({ targets }) => {
    calls.push(targets);
    return {
      ok,
      attempts: 1,
      results: targets.map((target) => ({
        name: target.name,
        ok,
        status: ok ? 200 : 503,
        ms: 4,
        error: ok ? null : "probe failed",
        url: target.url,
      })),
      history: [],
    };
  };
  gate.calls = calls;
  return gate;
}

const TEST_SECRET = Buffer.from("test-secret-key-material-0123456789abcdef", "utf8");

function makeRuntime({
  releaseLayout,
  paths,
  env = { GRYND_OPS_ENABLED: "1" },
  run = makeRun(),
  reader = makeReader(),
  healthGate = makeGate(true),
  now = makeClock(),
  preflight = async () => ({ ok: true }),
  auditWriter,
  secret = TEST_SECRET,
  appPort,
  realtimePort,
} = {}) {
  return createOpsRuntime({
    root: releaseLayout.root,
    releaseLayout,
    paths,
    env,
    secret,
    run,
    reader,
    healthGate,
    now,
    preflight,
    auditWriter,
    appPort,
    realtimePort,
    // Keep the unit-state poll short; production uses 6 x 500ms.
    pollAttempts: 2,
    pollIntervalMs: 1,
  });
}

async function planAndApply(runtime, options = {}) {
  const { operation = "restart.app", actor = "alice", reason = "routine restart after config review" } = options;
  const plan = await runtime.plan(operation, { actor });
  return runtime.apply({
    operationId: operation,
    token: plan.token,
    confirm: options.confirm ?? plan.confirmPhrase,
    actor: options.applyActor ?? actor,
    reason,
  });
}

async function auditLines(paths) {
  const entries = await readAllEntries(paths);
  return entries;
}

// ── the catalogue is the boundary ─────────────────────────────────────────

test("ops: only the two restart operations exist, and each is a real allowlisted command", () => {
  assert.deepEqual(OPERATION_IDS, ["restart.app", "restart.realtime"]);

  for (const id of OPERATION_IDS) {
    const operation = OPERATIONS[id];
    assert.equal(operation.action, "restart");
    assert.ok(Object.isFrozen(operation), `${id} must be frozen`);
    assert.ok(Object.isFrozen(operation.argv), `${id} argv must be frozen`);
    // Absolute paths only, and the verb is the fixed "restart" in position 3.
    assert.ok(operation.argv[0].startsWith("/"));
    assert.ok(operation.argv[2].startsWith("/"));
    assert.equal(operation.argv[3], "restart");
    assert.equal(operation.argv[4], operation.unit);
    assert.equal(operation.argv.length, 5);
    // A timeout and impact text are part of the card an operator approves.
    assert.ok(operation.timeoutMs > 0 && operation.timeoutMs <= 120_000);
    assert.ok(operation.impact.length > 40);
    assert.ok(operation.confirmPhrase.includes(operation.unit));
  }
});

test("ops: unknown, absent and prototype operation ids are refused", () => {
  for (const id of ["restart.nginx", "stop.app", "exec", "", "RESTART.APP", "__proto__", "constructor", "toString", null, 42]) {
    assert.throws(() => getOperation(id), (error) => error.code === "UNKNOWN_OPERATION", `accepted ${String(id)}`);
  }
});

test("ops: an argv that differs from the allowlist is refused", () => {
  const operation = getOperation("restart.app");

  assert.ok(assertArgv(operation, operation.argv));

  const attacks = [
    [operation.argv[0], operation.argv[1], operation.argv[2], "restart", REALTIME_UNIT],
    [operation.argv[0], operation.argv[1], operation.argv[2], "stop", APP_UNIT],
    [operation.argv[0], operation.argv[1], operation.argv[2], "restart", `${APP_UNIT} --now`],
    [operation.argv[0], operation.argv[1], operation.argv[2], "restart"],
    [...operation.argv, "extra"],
    "sudo systemctl restart grynd-app.service",
  ];

  for (const argv of attacks) {
    assert.throws(() => assertArgv(operation, argv), (error) => error.code === "ARGV_MISMATCH");
  }
});

test("ops: the excluded actions are documented, including nginx and reboot", () => {
  const ids = EXCLUDED_ACTIONS.map((entry) => entry.id);
  for (const id of ["nginx.reload", "vm.reboot", "exec", "firewall.*", "config.write", "release.activate", "release.rollback"]) {
    assert.ok(ids.includes(id), `exclusion list must mention ${id}`);
    const entry = EXCLUDED_ACTIONS.find((candidate) => candidate.id === id);
    assert.ok(entry.why.length > 20, `${id} needs a reason`);
  }
  // Nothing in the catalogue may be a stop, reboot or reload.
  for (const id of OPERATION_IDS) assert.ok(!/stop|reboot|reload/.test(id));
});

// ── confirmation, replay and CSRF-shaped attacks ──────────────────────────

test("ops: a plan shows unit, action, impact and phrase, and executes nothing", async () => {
  const { releaseLayout, paths } = await makeRoot();
  const run = makeRun();
  const runtime = makeRuntime({ releaseLayout, paths, run });

  const plan = await runtime.plan("restart.app", { actor: "alice" });

  assert.equal(run.calls.length, 0, "planning must not run anything");
  assert.equal(plan.operation, "restart.app");
  assert.equal(plan.unit, APP_UNIT);
  assert.equal(plan.action, "restart");
  assert.ok(plan.impact.includes("connection errors"));
  assert.equal(plan.confirmPhrase, `restart ${APP_UNIT}`);
  assert.ok(plan.token.length > 40);
  assert.equal(new Date(plan.expiresAt) - new Date(plan.issuedAt), 120_000);
  assert.equal(plan.executionEnabled, true);
});

test("ops: apply with the exact phrase, a reason and a fresh token succeeds once", async () => {
  const { releaseLayout, paths } = await makeRoot();
  const run = makeRun();
  const runtime = makeRuntime({ releaseLayout, paths, run });

  const result = await planAndApply(runtime, { reason: "deploy follow-up restart" });

  assert.equal(result.outcome, "verified");
  assert.equal(result.ok, true);
  assert.equal(run.calls.length, 1);
  assert.deepEqual(run.calls[0].argv, [...OPERATIONS["restart.app"].argv]);
  assert.equal(result.actor, "alice");
  assert.equal(result.reason, "deploy follow-up restart");
  assert.equal(result.verification.health.ok, true);
  assert.ok(result.audit.seq > 0);
});

test("ops: a wrong or missing confirmation phrase is refused and does not burn the token", async () => {
  const { releaseLayout, paths } = await makeRoot();
  const run = makeRun();
  const runtime = makeRuntime({ releaseLayout, paths, run });
  const plan = await runtime.plan("restart.app", { actor: "alice" });

  for (const confirm of ["yes", "", "restart grynd-app", `restart ${REALTIME_UNIT}`, undefined]) {
    await assert.rejects(
      () =>
        runtime.apply({
          operationId: "restart.app",
          token: plan.token,
          confirm,
          actor: "alice",
          reason: "trying the wrong phrase",
        }),
      (error) => error.code === "CONFIRMATION_MISMATCH",
    );
  }
  assert.equal(run.calls.length, 0);

  // The refusals happened before token verification, so the plan is still usable.
  const applied = await runtime.apply({
    operationId: "restart.app",
    token: plan.token,
    confirm: plan.confirmPhrase,
    actor: "alice",
    reason: "correct phrase after a typo",
  });
  assert.equal(applied.outcome, "verified");
});

test("ops: confirmation is case- and whitespace-insensitive but not fuzzy", () => {
  assert.equal(normalizePhrase("  Restart   GRYND-app.service "), normalizePhrase(`restart ${APP_UNIT}`));
  assert.notEqual(normalizePhrase("restart grynd-app"), normalizePhrase(`restart ${APP_UNIT}`));
});

test("ops: a missing reason is refused", async () => {
  const { releaseLayout, paths } = await makeRoot();
  const runtime = makeRuntime({ releaseLayout, paths });
  const plan = await runtime.plan("restart.app", { actor: "alice" });

  for (const reason of ["", "  ", undefined, "hi"]) {
    await assert.rejects(
      () =>
        runtime.apply({
          operationId: "restart.app",
          token: plan.token,
          confirm: plan.confirmPhrase,
          actor: "alice",
          reason,
        }),
      (error) => error.code === "REASON_REQUIRED",
    );
  }
});

test("ops: a token is single-use — replay is refused and happens only once", async () => {
  const { releaseLayout, paths } = await makeRoot();
  const run = makeRun();
  const runtime = makeRuntime({ releaseLayout, paths, run });
  const plan = await runtime.plan("restart.app", { actor: "alice" });

  const request = {
    operationId: "restart.app",
    token: plan.token,
    confirm: plan.confirmPhrase,
    actor: "alice",
    reason: "first and only use",
  };

  const first = await runtime.apply(request);
  assert.equal(first.outcome, "verified");

  await assert.rejects(() => runtime.apply(request), (error) => error.code === "TOKEN_REPLAYED");
  assert.equal(run.calls.length, 1, "a replayed token must not run the command again");
});

test("ops: a token is bound to one operation and one actor", async () => {
  const { releaseLayout, paths } = await makeRoot();
  const run = makeRun();
  const runtime = makeRuntime({ releaseLayout, paths, run });

  const appPlan = await runtime.plan("restart.app", { actor: "alice" });

  await assert.rejects(
    () =>
      runtime.apply({
        operationId: "restart.realtime",
        token: appPlan.token,
        confirm: getOperation("restart.realtime").confirmPhrase,
        actor: "alice",
        reason: "cross-operation attempt",
      }),
    (error) => error.code === "TOKEN_WRONG_OPERATION",
  );

  await assert.rejects(
    () =>
      runtime.apply({
        operationId: "restart.app",
        token: appPlan.token,
        confirm: appPlan.confirmPhrase,
        actor: "mallory",
        reason: "cross-actor attempt",
      }),
    (error) => error.code === "TOKEN_WRONG_ACTOR",
  );

  assert.equal(run.calls.length, 0);
});

test("ops: an expired token is refused", async () => {
  const { releaseLayout, paths } = await makeRoot();
  const clock = makeClock();
  const run = makeRun();
  const runtime = makeRuntime({ releaseLayout, paths, run, now: clock });
  const plan = await runtime.plan("restart.app", { actor: "alice" });

  clock.advance(121_000);

  await assert.rejects(
    () =>
      runtime.apply({
        operationId: "restart.app",
        token: plan.token,
        confirm: plan.confirmPhrase,
        actor: "alice",
        reason: "too slow",
      }),
    (error) => error.code === "TOKEN_EXPIRED",
  );
  assert.equal(run.calls.length, 0);
});

test("ops: forged and malformed tokens are refused", async () => {
  const { releaseLayout, paths } = await makeRoot();
  const run = makeRun();
  const runtime = makeRuntime({ releaseLayout, paths, run });
  const plan = await runtime.plan("restart.app", { actor: "alice" });

  const [payload] = plan.token.split(".");
  const forged = [
    `${payload}.${"A".repeat(43)}`,
    "not-a-token",
    "",
    `${payload}.`,
    `.${plan.token.split(".")[1]}`,
    `${Buffer.from('{"v":1,"op":"restart.app","actor":"alice","nonce":"0".repeat(32),"iat":0,"exp":99999999999999}').toString("base64url")}.${plan.token.split(".")[1]}`,
  ];

  for (const token of forged) {
    await assert.rejects(
      () =>
        runtime.apply({
          operationId: "restart.app",
          token,
          confirm: plan.confirmPhrase,
          actor: "alice",
          reason: "forged token attempt",
        }),
      (error) => error.code === "TOKEN_INVALID",
    );
  }
  assert.equal(run.calls.length, 0);
});

test("ops: a token signed with a different key is refused", () => {
  const operation = getOperation("restart.app");
  const foreign = issueToken({
    operation,
    actor: "alice",
    secret: Buffer.from("a-completely-different-key-0123456789abcdef", "utf8"),
  });

  assert.throws(
    () => verifyToken({ token: foreign.token, operation, actor: "alice", secret: TEST_SECRET }),
    (error) => error.code === "TOKEN_INVALID",
  );
});

// ── authorization and the disabled default ────────────────────────────────

test("ops: service actions are disabled unless the host explicitly enables them", async () => {
  const { releaseLayout, paths } = await makeRoot();
  const run = makeRun();
  const runtime = makeRuntime({ releaseLayout, paths, run, env: {} });

  const plan = await runtime.plan("restart.app", { actor: "alice" });
  assert.equal(plan.executionEnabled, false);
  assert.ok(plan.note);

  await assert.rejects(
    () =>
      runtime.apply({
        operationId: "restart.app",
        token: plan.token,
        confirm: plan.confirmPhrase,
        actor: "alice",
        reason: "should be refused by default",
      }),
    (error) => error.code === "OPS_DISABLED",
  );
  assert.equal(run.calls.length, 0);
  assert.equal(runtime.enabled(), false);
});

test("ops: only the literal value 1 enables execution", async () => {
  for (const value of ["true", "TRUE", "yes", "on", "0", "", undefined]) {
    const { releaseLayout, paths } = await makeRoot();
    const runtime = makeRuntime({ releaseLayout, paths, env: { GRYND_OPS_ENABLED: value } });
    assert.equal(runtime.enabled(), false, `${String(value)} must not enable execution`);
  }
});

test("ops: an operation and an actor are required to apply", async () => {
  const { releaseLayout, paths } = await makeRoot();
  const runtime = makeRuntime({ releaseLayout, paths });

  await assert.rejects(
    () => runtime.apply({ operationId: "rm -rf /", token: "x", confirm: "x", actor: "alice", reason: "nope" }),
    (error) => error.code === "UNKNOWN_OPERATION",
  );

  await assert.rejects(() => runtime.plan("restart.app", { actor: "" }), (error) => error.code === "ACTOR_REQUIRED");
});

test("ops: request text cannot influence the command that runs", async () => {
  const { releaseLayout, paths } = await makeRoot();
  const run = makeRun();
  const runtime = makeRuntime({ releaseLayout, paths, run });

  const injections = [
    "restart.app --now",
    "restart.app; reboot",
    "restart.app && rm -rf /",
    "$(reboot)",
    "../../etc/passwd",
    "restart.app\nstop.app",
  ];

  for (const operationId of injections) {
    await assert.rejects(() => runtime.plan(operationId, { actor: "alice" }), (error) => error.code === "UNKNOWN_OPERATION");
  }
  assert.equal(run.calls.length, 0);

  // Each operation runs exactly the frozen catalogue array, character for character.
  for (const operationId of OPERATION_IDS) {
    const operationRun = makeRun();
    const operationRuntime = makeRuntime({ releaseLayout, paths, run: operationRun });
    await planAndApply(operationRuntime, { operation: operationId, reason: "argv identity check" });

    assert.equal(operationRun.calls.length, 1);
    assert.deepEqual(operationRun.calls[0].argv, [...OPERATIONS[operationId].argv]);
    assert.equal(operationRun.calls[0].options.timeoutMs, OPERATIONS[operationId].timeoutMs);
  }

  // A mutated copy is refused even though its shape is a valid argv.
  const tampered = [...getOperation("restart.app").argv];
  tampered[3] = "stop";
  assert.throws(() => assertArgv(getOperation("restart.app"), tampered), (error) => error.code === "ARGV_MISMATCH");
});

test("ops: a binary that resolves elsewhere is refused before any command runs", async () => {
  const operation = getOperation("restart.app");

  await assert.rejects(
    () => preflightBinaries(operation.argv, { realpath: async (candidate) => `${candidate}.evil` }),
    (error) => error.code === "BINARY_MISMATCH",
  );

  await assert.rejects(
    () =>
      preflightBinaries(operation.argv, {
        realpath: async (candidate) => {
          if (candidate.endsWith("sudo")) {
            const error = new Error("gone");
            error.code = "ENOENT";
            throw error;
          }
          return candidate;
        },
      }),
    (error) => error.code === "BINARY_MISSING",
  );

  assert.deepEqual(
    await preflightBinaries(operation.argv, { realpath: async (candidate) => candidate }),
    { ok: true },
  );
});

// ── timeouts, failures and honest reporting ───────────────────────────────

test("ops: a timed-out command is reported as timed out, still verified, and never retried", async () => {
  const { releaseLayout, paths } = await makeRoot();
  const run = makeRun({ ok: false, exitCode: null, timedOut: true, signal: "SIGTERM", ms: 30_000 });
  const reader = makeReader();
  const runtime = makeRuntime({ releaseLayout, paths, run, reader });

  const result = await planAndApply(runtime, { reason: "simulated hang" });

  assert.equal(result.outcome, "timed_out");
  assert.equal(result.ok, false);
  assert.equal(result.command.timedOut, true);
  assert.equal(run.calls.length, 1, "a timeout must not be retried");
  assert.ok(reader.calls.length > 0, "state must still be read after a timeout");
  assert.match(result.message, /NOT a confirmed restart/);
});

test("ops: a failed command is reported as failed with its exit code", async () => {
  const { releaseLayout, paths } = await makeRoot();
  const run = makeRun({ ok: false, exitCode: 4, stderr: "Job for grynd-app.service failed" });
  const runtime = makeRuntime({ releaseLayout, paths, run });

  const result = await planAndApply(runtime, { reason: "simulated failure" });

  assert.equal(result.outcome, "command_failed");
  assert.equal(result.ok, false);
  assert.equal(result.command.exitCode, 4);
  assert.match(result.message, /exit 4/);
});

test("ops: a successful command with a failing health gate is not a success", async () => {
  const { releaseLayout, paths } = await makeRoot();
  const run = makeRun();
  const runtime = makeRuntime({ releaseLayout, paths, run, healthGate: makeGate(false) });

  const result = await planAndApply(runtime, { reason: "health gate failure" });

  assert.equal(result.outcome, "verification_failed");
  assert.equal(result.ok, false);
  assert.equal(result.command.ok, true);
  assert.equal(result.verification.health.ok, false);
  assert.match(result.message, /Do not treat this as a successful restart/);
});

test("ops: a crash-looping unit is caught even though systemctl exited 0", async () => {
  const { releaseLayout, paths } = await makeRoot();
  const run = makeRun();
  const reader = makeReader({ [APP_UNIT]: "failed" });
  const runtime = makeRuntime({ releaseLayout, paths, run, reader });

  const result = await planAndApply(runtime, { reason: "unit failed after restart" });

  assert.equal(result.outcome, "verification_failed");
  assert.equal(result.verification.unit.state, "failed");
  assert.equal(result.ok, false);
});

test("ops: no automatic restart is triggered by a health result", async () => {
  const { releaseLayout, paths } = await makeRoot();
  const run = makeRun();
  const runtime = makeRuntime({ releaseLayout, paths, run, healthGate: makeGate(false) });

  await planAndApply(runtime, { reason: "unhealthy result must not loop" });

  assert.equal(run.calls.length, 1, "a health failure must not schedule another restart");
});

test("ops: verification reports both units and attributes states to the right role", async () => {
  const operation = getOperation("restart.realtime");
  const reader = makeReader({ [APP_UNIT]: "active", [REALTIME_UNIT]: "activating" });

  const result = await verifyOperation({
    operation,
    units: MANAGED_UNITS,
    reader,
    healthGate: makeGate(true),
    pollAttempts: 2,
    pollIntervalMs: 1,
    sleep: async () => {},
  });

  const app = result.units.find((unit) => unit.role === "app");
  const realtime = result.units.find((unit) => unit.role === "realtime");

  assert.equal(app.unit, APP_UNIT);
  assert.equal(app.state, "active");
  assert.equal(realtime.unit, REALTIME_UNIT);
  assert.equal(realtime.state, "activating");
  assert.equal(result.ok, false, "an activating unit is not a verified restart");
});

// ── configuration is readable but not disclosable ─────────────────────────

// These fixtures must be shaped like real credentials or the redactor would
// never be exercised. They are assembled at runtime so that no key-shaped
// literal sits in the source, where a secret scanner (rightly) cannot tell a
// test fixture from a leak.
const FAKE_CLERK_SECRET = ["sk", "live", "SENTINELCLERK1234567890"].join("_");
const FAKE_CLERK_PUBLISHABLE = ["pk", "test", "SENTINELPUBLISHABLE"].join("_");
const FAKE_ROTATED_SECRET = ["sk", "live", "abcdefghijklmnop"].join("_");
const FAKE_PEM = [
  "-----BEGIN",
  "PRIVATE KEY-----",
  "MIIE...",
  "-----END PRIVATE KEY-----",
].join(" ");

const VALID_APP_ENV = {
  DATABASE_URL: "postgresql://sentineluser:SENTINELPW@db.example:5432/grynd",
  CLERK_SECRET_KEY: FAKE_CLERK_SECRET,
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: FAKE_CLERK_PUBLISHABLE,
  NEXT_PUBLIC_SOCKET_URL: "https://socket.example.com",
  REALTIME_INTERNAL_URL: "http://127.0.0.1:3001",
  REALTIME_INTERNAL_SECRET: "SENTINELREALTIMESECRET1234567890",
};

const VALID_REALTIME_ENV = {
  PORT: "3001",
  CLERK_SECRET_KEY: FAKE_CLERK_SECRET,
  REALTIME_INTERNAL_SECRET: "SENTINELREALTIMESECRET1234567890",
};

const SECRET_SENTINELS = [
  "SENTINELPW",
  "SENTINELCLERK1234567890",
  "SENTINELPUBLISHABLE",
  "SENTINELREALTIMESECRET1234567890",
  "sentineluser",
];

async function writeEnvFiles(releaseLayout, { app = {}, realtime = {} } = {}) {
  await fs.mkdir(releaseLayout.env, { recursive: true, mode: 0o750 });
  const render = (values) =>
    `${Object.entries(values)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n")}\n`;
  await fs.writeFile(releaseLayout.appEnv, render(app), { mode: 0o600 });
  await fs.writeFile(releaseLayout.realtimeEnv, render(realtime), { mode: 0o600 });
}

test("ops: configuration status never discloses a value", async () => {
  const { releaseLayout } = await makeRoot();
  await writeEnvFiles(releaseLayout, { app: VALID_APP_ENV, realtime: VALID_REALTIME_ENV });

  const report = await configStatus({ layout: releaseLayout });
  const serialized = JSON.stringify(report);

  assert.deepEqual(findLeakedSecrets(serialized, SECRET_SENTINELS), []);
  assert.equal(report.ok, true);
  assert.equal(report.summary.keysMissing, 0);
  assert.equal(report.summary.keysInvalid, 0);

  // Key NAMES are shown (that is the deliverable); values are not.
  const names = report.files.flatMap((file) => file.keys.map((key) => key.key));
  assert.ok(names.includes("DATABASE_URL"));
  assert.ok(names.includes("REALTIME_INTERNAL_SECRET"));
});

test("ops: configuration status names missing keys and bad formats without echoing them", async () => {
  const { releaseLayout } = await makeRoot();
  const app = { ...VALID_APP_ENV, DATABASE_URL: "http://not-a-postgres-dsn" };
  delete app.REALTIME_INTERNAL_SECRET;
  await writeEnvFiles(releaseLayout, { app, realtime: VALID_REALTIME_ENV });

  const report = await configStatus({ layout: releaseLayout });
  const appFile = report.files.find((file) => file.name === "app.env");
  const database = appFile.keys.find((key) => key.key === "DATABASE_URL");
  const missing = appFile.keys.find((key) => key.key === "REALTIME_INTERNAL_SECRET");

  assert.equal(report.ok, false);
  assert.equal(database.valid, false);
  assert.equal(database.reason, "format");
  assert.equal(missing.present, false);
  assert.equal(missing.reason, "missing");
  assert.deepEqual(findLeakedSecrets(JSON.stringify(report), SECRET_SENTINELS), []);
});

test("ops: a missing env file is a finding, not a crash", async () => {
  const { releaseLayout } = await makeRoot();
  const report = await configStatus({ layout: releaseLayout });

  assert.equal(report.ok, false);
  assert.equal(report.summary.filesOk, 0);
  assert.equal(report.files.length, 2);
  for (const file of report.files) assert.equal(file.present, false);
  assert.ok(report.disclosure.includes("never"));
});

const POSIX_ONLY = { skip: process.platform === "win32" ? "POSIX file modes only" : false };

test("ops: configuration status reports file permissions", POSIX_ONLY, async () => {
  const { releaseLayout } = await makeRoot();
  await writeEnvFiles(releaseLayout, { app: VALID_APP_ENV, realtime: VALID_REALTIME_ENV });

  const tight = await configStatus({ layout: releaseLayout });
  assert.equal(tight.files[0].mode, "0600");
  assert.equal(tight.files[0].modeOk, true);

  await fs.chmod(releaseLayout.appEnv, 0o644);
  const loose = await configStatus({ layout: releaseLayout });
  const appFile = loose.files.find((file) => file.name === "app.env");
  assert.equal(appFile.mode, "0644");
  assert.equal(appFile.modeOk, false);
  assert.equal(loose.ok, false);
});

test("ops: dotenv parsing handles comments, quotes, export and CRLF", () => {
  const { map, malformed } = parseEnvFile(
    ['# comment', "", "export A=1", 'B="two words"', "C='single'", "D=plain", "not a pair", "=nokey", "E="].join("\r\n"),
  );

  assert.equal(map.get("A"), "1");
  assert.equal(map.get("B"), "two words");
  assert.equal(map.get("C"), "single");
  assert.equal(map.get("D"), "plain");
  assert.equal(map.get("E"), "");
  assert.equal(malformed, 2);
});

test("ops: the required key list is names and rules only", () => {
  for (const [file, entries] of Object.entries(REQUIRED_CONFIG)) {
    assert.ok(file.endsWith(".env"));
    for (const entry of entries) {
      assert.equal(typeof entry.key, "string");
      assert.equal(typeof entry.rule, "string");
      assert.equal(entry.value, undefined, "the required-key table must not carry values");
    }
  }
});

test("ops: editing configuration is refused and the attempt is recorded", async () => {
  const { releaseLayout, paths } = await makeRoot();
  const runtime = makeRuntime({ releaseLayout, paths });

  await assert.rejects(() => runtime.refuseConfigChange({ actor: "alice" }), (error) => error.code === "NOT_IMPLEMENTED");

  const entries = await auditLines(paths);
  const denial = entries.find((entry) => entry.event === "config.change.denied");
  assert.ok(denial, "a refused config change must be recorded");
  assert.equal(denial.actor, "alice");
});

// ── redaction ─────────────────────────────────────────────────────────────

test("ops: redaction removes credentials by field name and by shape", () => {
  const value = {
    password: "hunter2",
    DATABASE_URL: "postgresql://user:secretpw@db:5432/x",
    nested: { apiKey: "abc123", note: "connected via postgres://user:secretpw@db" },
    bearer: "Authorization: Bearer abcdefghijklmnop",
    pem: FAKE_PEM,
    jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop",
  };

  const serialized = JSON.stringify(redact(value));

  for (const secret of ["hunter2", "secretpw", "abcdefghijklmnop", "MIIE", "abc123"]) {
    assert.ok(!serialized.includes(secret), `redaction leaked ${secret}`);
  }
  assert.ok(serialized.includes("[redacted]"));
});

test("ops: a secret pasted into a reason never reaches the audit log", async () => {
  const { releaseLayout, paths } = await makeRoot();
  const runtime = makeRuntime({ releaseLayout, paths });

  await planAndApply(runtime, {
    reason: `rotated ${FAKE_ROTATED_SECRET} and used postgres://u:SENTINELPW@host/db`,
  });

  const entries = await auditLines(paths);
  const serialized = JSON.stringify(entries);

  assert.ok(!serialized.includes(FAKE_ROTATED_SECRET));
  assert.ok(!serialized.includes("SENTINELPW"));
  assert.ok(serialized.includes("[redacted]"));
});

test("ops: the plan token never appears in the audit log", async () => {
  const { releaseLayout, paths } = await makeRoot();
  const runtime = makeRuntime({ releaseLayout, paths });

  const plan = await runtime.plan("restart.app", { actor: "alice" });
  const entries = await auditLines(paths);

  assert.ok(JSON.stringify(entries).includes(plan.tokenFingerprint));
  assert.ok(!JSON.stringify(entries).includes(plan.token), "the token itself must never be logged");
});

test("ops: redaction is bounded and leaves ordinary identifiers readable", () => {
  const long = "a".repeat(5000);
  assert.ok(redactString(long).length < 500);

  // Unit names, release ids and commit shas are the point of an audit log.
  assert.equal(redactString(APP_UNIT), APP_UNIT);
  assert.equal(redactString("20261025T143012Z-3f9c2ab"), "20261025T143012Z-3f9c2ab");
  assert.equal(redactString("3f9c2ab0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6"), "3f9c2ab0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6");
});

// ── audit completeness and tamper evidence ────────────────────────────────

test("ops: a successful action records start and result with actor and reason", async () => {
  const { releaseLayout, paths } = await makeRoot();
  const runtime = makeRuntime({ releaseLayout, paths });

  await planAndApply(runtime, { actor: "alice", reason: "post-deploy restart" });
  const entries = await auditLines(paths);

  const planEntry = entries.find((entry) => entry.event === "ops.plan");
  const start = entries.find((entry) => entry.event === "service.action.start");
  const result = entries.find((entry) => entry.event === "service.action.result");

  assert.ok(planEntry && start && result);
  assert.equal(start.actor, "alice");
  assert.equal(start.detail.reason, "post-deploy restart");
  assert.equal(start.detail.unit, APP_UNIT);
  assert.ok(Array.isArray(start.detail.argv));
  assert.equal(result.detail.outcome, "verified");
  assert.equal(result.detail.verified, true);
});

test("ops: every refusal is audited with a machine-readable code", async () => {
  const { releaseLayout, paths } = await makeRoot();
  const runtime = makeRuntime({ releaseLayout, paths, env: {} });

  const plan = await runtime.plan("restart.app", { actor: "alice" });

  await assert.rejects(
    () =>
      runtime.apply({
        operationId: "restart.app",
        token: plan.token,
        confirm: "wrong",
        actor: "alice",
        reason: "refusal path",
      }),
    () => true,
  );

  const denials = (await auditLines(paths)).filter((entry) => entry.event === "ops.denied");
  assert.ok(denials.length > 0, "a refusal must be recorded");
  assert.equal(denials[0].detail.code, "OPS_DISABLED");
  assert.equal(denials[0].actor, "alice");
});

test("ops: every non-verified outcome is recorded, including a broken chain of evidence", async () => {
  const cases = [
    { name: "timed out", run: makeRun({ ok: false, timedOut: true }), gate: makeGate(true), expected: "timed_out" },
    { name: "command failed", run: makeRun({ ok: false, exitCode: 1 }), gate: makeGate(true), expected: "command_failed" },
    { name: "health failed", run: makeRun(), gate: makeGate(false), expected: "verification_failed" },
    { name: "verified", run: makeRun(), gate: makeGate(true), expected: "verified" },
  ];

  for (const scenario of cases) {
    const { releaseLayout, paths } = await makeRoot();
    const runtime = makeRuntime({ releaseLayout, paths, run: scenario.run, healthGate: scenario.gate });
    const result = await planAndApply(runtime, { reason: `scenario ${scenario.name}` });

    assert.equal(result.outcome, scenario.expected, scenario.name);

    const entries = await auditLines(paths);
    const start = entries.find((entry) => entry.event === "service.action.start");
    const finish = entries.find((entry) => entry.event === "service.action.result");
    assert.ok(start, `${scenario.name}: start must be recorded`);
    assert.ok(finish, `${scenario.name}: result must be recorded`);
    assert.equal(finish.detail.outcome, scenario.expected);
  }
});

test("ops: the audit chain verifies, and tampering is detected at the edited entry", async () => {
  const { paths } = await makeRoot();
  for (let index = 0; index < 6; index += 1) {
    await appendAudit({
      paths,
      event: "ops.plan",
      actor: "alice",
      detail: { index },
      now: new Date(Date.UTC(2026, 9, 26, 12, 0, index)),
    });
  }

  const intact = await verifyAudit({ paths });
  assert.equal(intact.ok, true);
  assert.equal(intact.entries, 6);
  assert.equal(intact.pruned, false);

  // Edit one line's actor and leave the hash untouched.
  const lines = (await fs.readFile(paths.auditLog, "utf8")).split("\n").filter(Boolean);
  const tampered = JSON.parse(lines[3]);
  tampered.actor = "mallory";
  lines[3] = JSON.stringify(tampered);
  await fs.writeFile(paths.auditLog, `${lines.join("\n")}\n`);

  const broken = await verifyAudit({ paths });
  assert.equal(broken.ok, false);
  assert.equal(broken.brokenAt, 4);
  assert.match(broken.reason, /hash does not match/);
});

test("ops: deleting an audit line is detected as a sequence gap", async () => {
  const { paths } = await makeRoot();
  for (let index = 0; index < 4; index += 1) {
    await appendAudit({ paths, event: "ops.plan", actor: "alice", detail: { index } });
  }

  const lines = (await fs.readFile(paths.auditLog, "utf8")).split("\n").filter(Boolean);
  lines.splice(1, 1);
  await fs.writeFile(paths.auditLog, `${lines.join("\n")}\n`);

  const broken = await verifyAudit({ paths });
  assert.equal(broken.ok, false);
  assert.match(broken.reason, /sequence gap/);
});

test("ops: retention rotates whole segments and says when the log is pruned", async () => {
  const { paths } = await makeRoot();

  for (let index = 0; index < 10; index += 1) {
    await appendAudit({
      paths,
      event: "ops.plan",
      actor: "alice",
      detail: { index },
      now: new Date(Date.UTC(2026, 9, 26, 12, 0, index)),
      maxEntries: 3,
      maxArchives: 2,
    });
  }

  const names = await fs.readdir(paths.stateOps);
  const archives = names.filter((name) => /^audit-.*\.jsonl$/.test(name));
  assert.equal(archives.length, 2, "retention keeps exactly two archives");

  const verified = await verifyAudit({ paths });
  assert.equal(verified.ok, true);
  assert.equal(verified.pruned, true, "a trimmed log must say so");
  assert.ok(verified.firstSeq > 1);
  assert.equal(verified.lastSeq, 10);

  // Rotation must not silently overwrite: every surviving seq is unique.
  const entries = await readAllEntries(paths);
  const seqs = entries.map((entry) => entry.seq);
  assert.equal(new Set(seqs).size, seqs.length);
});

test("ops: the dashboard may append only auth events", async () => {
  const { paths } = await makeRoot();

  for (const event of INGESTIBLE_EVENTS) {
    const entry = await appendIngestedEvent({ paths, event, actor: "alice", detail: { ip: "127.0.0.1" } });
    assert.equal(entry.event, event);
  }

  for (const event of ["service.action.start", "login.bypass", "ops.plan"]) {
    await assert.rejects(
      () => appendIngestedEvent({ paths, event, actor: "mallory" }),
      (error) => error.code === "EVENT_NOT_INGESTIBLE",
    );
  }

  const verified = await verifyAudit({ paths });
  assert.equal(verified.ok, true);
});

test("ops: a mixed audit view merges release and ops entries newest last", async () => {
  const { releaseLayout, paths } = await makeRoot();
  await fs.writeFile(
    releaseLayout.auditLog,
    `${JSON.stringify({ at: "2026-10-26T11:00:00.000Z", action: "activate", actor: "ops" })}\n`,
  );
  await appendAudit({
    paths,
    event: "ops.plan",
    actor: "alice",
    detail: {},
    now: new Date("2026-10-26T12:00:00.000Z"),
  });

  const runtime = makeRuntime({ releaseLayout, paths });
  const merged = await runtime.auditTail({ limit: 10 });

  assert.equal(merged.length, 2);
  assert.equal(merged[0].source, "release");
  assert.equal(merged[1].source, "ops");
});

test("ops: the audit log refuses an unusable event name", async () => {
  const { paths } = await makeRoot();
  for (const event of ["", "no-dots", "UPPER.case", 42, null]) {
    await assert.rejects(
      () => appendAudit({ paths, event, actor: "alice" }),
      (error) => error.code === "INVALID_AUDIT_EVENT",
    );
  }
});

// ── the broker, end to end ────────────────────────────────────────────────
//
// These spawn the real CLI in a temporary root. None of them can reach a real
// command: the confirmation, the disabled gate and the confirmation phrase are
// all checked before the binary preflight, and the suite never enables a path
// that could run `sudo systemctl`. The actual restart is exercised by staging,
// not by a unit test that might touch the host it runs on.

const REPO = path.resolve(DEPLOY, "..");

function runOps(args, { root, env = {}, stdin } = {}) {
  const childEnv = { ...process.env, GRYND_RELEASE_ROOT: root };
  delete childEnv.GRYND_OPS_ENABLED;
  delete childEnv.GRYND_OPS_TOKEN_SECRET;
  Object.assign(childEnv, env);

  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [path.join(DEPLOY, "ops.mjs"), ...args],
      { cwd: REPO, env: childEnv, timeout: 20_000, windowsHide: true },
      (error, stdout, stderr) => {
        resolve({
          code: typeof error?.code === "number" ? error.code : error ? 1 : 0,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
        });
      },
    );
    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

function jsonResponse(run) {
  try {
    return JSON.parse(run.stdout.trim());
  } catch {
    throw new Error(`broker did not return JSON (exit ${run.code}): ${run.stdout}${run.stderr}`);
  }
}

test("ops broker: unknown actions and unknown fields are refused", async () => {
  const { root } = await makeRoot();

  const unknownAction = await runOps(["--stdin"], { root, stdin: JSON.stringify({ action: "reboot.now" }) });
  assert.equal(unknownAction.code, 2);
  assert.equal(jsonResponse(unknownAction).code, "UNKNOWN_ACTION");

  const unknownField = await runOps(["--stdin"], {
    root,
    stdin: JSON.stringify({ action: "status", sudo: true }),
  });
  assert.equal(unknownField.code, 2);
  assert.equal(jsonResponse(unknownField).code, "INVALID_REQUEST");

  const badJson = await runOps(["--stdin"], { root, stdin: "{ not json" });
  assert.equal(badJson.code, 2);
  assert.equal(jsonResponse(badJson).code, "INVALID_REQUEST");
});

test("ops broker: an oversized request is refused before parsing", async () => {
  const { root } = await makeRoot();
  const oversized = JSON.stringify({ action: "status", padding: "x".repeat(9000) });
  const run = await runOps(["--stdin"], { root, stdin: oversized });

  assert.equal(run.code, 2);
  assert.equal(jsonResponse(run).code, "REQUEST_TOO_LARGE");
});

test("ops broker: a plan cannot be applied on a disabled host", async () => {
  const { root } = await makeRoot();

  const planned = await runOps(["plan", "restart.app", "--actor", "alice", "--json"], { root });
  assert.equal(planned.code, 0);
  const plan = jsonResponse(planned).result;
  assert.equal(plan.executionEnabled, false);
  assert.ok(plan.token);

  const applied = await runOps(["--stdin"], {
    root,
    stdin: JSON.stringify({
      action: "ops.apply",
      operation: "restart.app",
      token: plan.token,
      confirm: plan.confirmPhrase,
      actor: "alice",
      reason: "should never run on a disabled host",
    }),
  });

  assert.equal(applied.code, 2);
  assert.equal(jsonResponse(applied).code, "OPS_DISABLED");
  // The refusal must not echo the token back.
  assert.ok(!applied.stdout.includes(plan.token));
});

test("ops broker: a wrong confirmation phrase is refused before any command", async () => {
  const { root } = await makeRoot();

  const planned = await runOps(["plan", "restart.app", "--actor", "alice", "--json"], {
    root,
    env: { GRYND_OPS_ENABLED: "1" },
  });
  const plan = jsonResponse(planned).result;

  const applied = await runOps(["--stdin"], {
    root,
    env: { GRYND_OPS_ENABLED: "1" },
    stdin: JSON.stringify({
      action: "ops.apply",
      operation: "restart.app",
      token: plan.token,
      confirm: "yes do it",
      actor: "alice",
      reason: "wrong phrase on purpose",
    }),
  });

  assert.equal(applied.code, 2);
  assert.equal(jsonResponse(applied).code, "CONFIRMATION_MISMATCH");
});

test("ops broker: login outcomes can be recorded, then the chain verifies", async () => {
  const { root, paths } = await makeRoot();

  const appended = await runOps(["--stdin"], {
    root,
    stdin: JSON.stringify({ action: "audit.append", event: "login.failure", actor: "alice", detail: { ip: "127.0.0.1" } }),
  });
  assert.equal(appended.code, 0);
  assert.equal(jsonResponse(appended).ok, true);

  const refused = await runOps(["--stdin"], {
    root,
    stdin: JSON.stringify({ action: "audit.append", event: "service.action.start", actor: "mallory" }),
  });
  assert.equal(refused.code, 2);
  assert.equal(jsonResponse(refused).code, "EVENT_NOT_INGESTIBLE");

  const verified = await runOps(["audit-verify", "--json"], { root });
  assert.equal(verified.code, 0);
  assert.equal(jsonResponse(verified).result.ok, true);

  const entries = await readAllEntries(paths);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].event, "login.failure");
});

test("ops CLI: config output never contains a configured value", async () => {
  const { root, releaseLayout } = await makeRoot();
  await writeEnvFiles(releaseLayout, { app: VALID_APP_ENV, realtime: VALID_REALTIME_ENV });

  const human = await runOps(["config"], { root });
  assert.equal(human.code, 0);
  assert.deepEqual(findLeakedSecrets(human.stdout, SECRET_SENTINELS), []);
  assert.ok(human.stdout.includes("DATABASE_URL"));
  assert.ok(human.stdout.includes("Values are never displayed"));

  const json = await runOps(["config", "--json"], { root });
  assert.equal(json.code, 0);
  assert.deepEqual(findLeakedSecrets(json.stdout, SECRET_SENTINELS), []);
});

test("ops CLI: plan renders the impact and the exact phrase", async () => {
  const { root } = await makeRoot();
  const run = await runOps(["plan", "restart.realtime", "--actor", "alice"], { root });

  assert.equal(run.code, 0);
  assert.ok(run.stdout.includes(REALTIME_UNIT));
  assert.ok(run.stdout.includes("Every connected WebSocket is dropped"));
  assert.ok(run.stdout.includes(`Confirm by typing: restart ${REALTIME_UNIT}`));
  assert.ok(run.stdout.includes("disabled"));
});

test("ops CLI: an unknown command prints usage and exits 2", async () => {
  const { root } = await makeRoot();
  const run = await runOps(["format-disk"], { root });
  assert.equal(run.code, 2);
  assert.ok(run.stdout.includes("GRYND restricted operations"));
});

test("ops broker: backup status is read-only and distinguishes exists from verified", async () => {
  const { root } = await makeRoot();

  const empty = await runOps(["--stdin"], { root, stdin: JSON.stringify({ action: "backup.status" }) });
  assert.equal(empty.code, 0);
  const emptyBody = jsonResponse(empty);
  assert.equal(emptyBody.result.evidence, "none");
  assert.equal(emptyBody.result.verified, false);
  assert.ok(emptyBody.result.warnings.some((warning) => warning.code === "NO_SUCCESSFUL_BACKUP"));

  // A ledger with a backup and a matching restore test: the same path the
  // dashboard reads, derived from GRYND_RELEASE_ROOT.
  const ledgerDir = path.join(root, "state", "backup");
  await fs.mkdir(ledgerDir, { recursive: true });
  const sha = "c".repeat(64);
  const at = new Date(Date.now() - 3_600_000).toISOString();
  await fs.writeFile(
    path.join(ledgerDir, "ledger.jsonl"),
    [
      JSON.stringify({
        event: "backup.completed",
        at,
        id: "b1",
        bytes: 2_097_152,
        sha256: sha,
        destination: { id: "grynd-backups", kind: "oci-object-storage" },
      }),
      JSON.stringify({
        event: "restore.verified",
        at,
        backupId: "b1",
        sha256: sha,
        tablesChecked: 19,
        mismatches: 0,
        target: "scratch",
      }),
    ].join("\n"),
  );

  const verified = await runOps(["--stdin"], { root, stdin: JSON.stringify({ action: "backup.status" }) });
  assert.equal(verified.code, 0);
  const body = jsonResponse(verified);
  assert.equal(body.result.verified, true);
  assert.equal(body.result.evidence, "restore-verified");
  assert.equal(body.result.size.human, "2 MiB");
});

test("ops CLI: backup renders readiness and says when a restore is unverified", async () => {
  const { root } = await makeRoot();
  const run = await runOps(["backup"], { root });

  assert.equal(run.code, 0);
  assert.ok(run.stdout.includes("Backup evidence: none"));
  assert.ok(run.stdout.includes("NOT restore-verified"));
  assert.ok(run.stdout.includes("Last successful backup: NEVER"));
  assert.ok(run.stdout.includes("DESTINATION_NOT_CONFIGURED"));
});

// ── the runtime has no shell and no network ───────────────────────────────

test("ops: the runtime contains no shell, no server and no arbitrary execution", async () => {
  const opsDir = path.join(DEPLOY, "lib", "ops");
  const files = (await fs.readdir(opsDir)).map((name) => path.join(opsDir, name));
  files.push(path.join(DEPLOY, "ops.mjs"));

  const forbidden = [
    "node:http",
    "node:https",
    "node:net",
    "node:dgram",
    "createServer",
    "shell: true",
    "execSync",
    "spawnSync",
    "eval(",
    "new Function",
  ];

  for (const file of files) {
    const source = await fs.readFile(file, "utf8");
    for (const needle of forbidden) {
      assert.ok(!source.includes(needle), `${path.basename(file)} must not contain ${JSON.stringify(needle)}`);
    }
  }
});

test("ops: status is read-only and reports the enforced boundary", async () => {
  const { releaseLayout, paths } = await makeRoot();
  await writeEnvFiles(releaseLayout, { app: VALID_APP_ENV, realtime: VALID_REALTIME_ENV });

  const run = makeRun();
  const runtime = makeRuntime({ releaseLayout, paths, run });
  const status = await runtime.status();

  assert.equal(run.calls.length, 0, "status must not run a command");
  assert.equal(status.enabled, true);
  assert.equal(status.operations.length, 2);
  assert.ok(status.excluded.some((entry) => entry.id === "nginx.reload"));
  assert.equal(status.units.app.unit, APP_UNIT);
  assert.equal(status.config.ok, true);
  assert.deepEqual(findLeakedSecrets(JSON.stringify(status), SECRET_SENTINELS), []);
});
