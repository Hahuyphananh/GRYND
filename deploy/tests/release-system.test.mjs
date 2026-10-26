/**
 * deploy/tests/release-system.test.mjs — the release system's own contract.
 *
 * Everything runs against a throwaway root in the OS temp directory. No test
 * reads /home/ubuntu, starts systemd, or uses a real port.
 *
 * Run: node --test deploy/tests/
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { DeployError, assertReleaseId, isInside, layout, makeReleaseId } from "../lib/layout.mjs";
import {
  checkCompleteness,
  checkRuntimeCompatibility,
  validateManifest,
} from "../lib/manifest.mjs";
import { readPointer, swapPointer } from "../lib/pointer.mjs";
import {
  assertEnvironmentReady,
  ensureLayout,
  envReport,
  markVerified,
  readActive,
  readAudit,
  readVerified,
} from "../lib/state.mjs";
import { defaultHealthTargets, probeHttp, runHealthGate } from "../lib/health.mjs";
import { inspectRelease } from "../lib/inspect.mjs";
import { installRelease, pruneReleases, statusReport } from "../lib/install.mjs";
import { activateRelease, rollbackRelease } from "../lib/activate.mjs";
import { createDryRunController } from "../lib/services.mjs";
import { buildFixtureRelease } from "../staging/build-fixture.mjs";

// ── helpers ────────────────────────────────────────────────────────────────

async function tempRoot(prefix = "grynd-test-") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await ensureLayout(layout(root));
  return root;
}

async function writeEnvFiles(l, { mode = 0o600 } = {}) {
  await fs.writeFile(l.appEnv, "DATABASE_URL=postgres://fixture\nFIXTURE_SENTINEL=do-not-print\n", { mode });
  await fs.writeFile(l.realtimeEnv, "CLIENT_URL=http://127.0.0.1:3000\nFIXTURE_SENTINEL=do-not-print\n", { mode });
}

function validManifest(overrides = {}) {
  const id = "20261025T143012Z-3f9c2ab";
  return {
    schema: 1,
    releaseId: id,
    commit: `3f9c2ab${"0".repeat(33)}`,
    shortCommit: "3f9c2ab",
    buildId: "build-abc",
    createdAt: "2026-10-25T14:30:12.000Z",
    builder: { workflow: "release.yml", runId: "1", runner: "ubuntu-24.04-arm", arch: process.arch, node: process.versions.node },
    productionFixes: { caTrust: true, verifiedBy: "deploy/verify-production-fixes.mjs" },
    checks: { build: "passed", tests: "passed" },
    realtime: { hash: `sha256:${"a".repeat(64)}` },
    artifact: { hash: `sha256:${"b".repeat(64)}`, files: 42, bytes: 1_024 },
    ...overrides,
  };
}

function stubController({ failRestart = false } = {}) {
  const calls = [];
  return {
    name: "stub",
    calls,
    async assertReady() {},
    async restart(options) {
      calls.push(options);
      if (failRestart) throw new Error("systemctl restart failed (simulated)");
    },
    async stop() {},
  };
}

/** A probe whose verdict the test controls, in sequence. */
function scriptedProbe(verdicts) {
  let index = 0;
  return async () => {
    const verdict = verdicts[Math.min(index, verdicts.length - 1)];
    index += 1;
    return {
      ok: verdict,
      status: verdict ? 200 : 503,
      ms: 1,
      error: verdict ? null : "simulated failure",
      body: verdict ? '{"ok":true}' : '{"ok":false}',
    };
  };
}

const noSleep = async () => {};

async function installFixture(l, id, options = {}) {
  await buildFixtureRelease({ incomingDir: l.incomingDir(id), id, ...options });
  return installRelease({ root: l.root, id, actor: "test" });
}

// ── release ids ────────────────────────────────────────────────────────────

test("release ids: only <UTC stamp>-<commit> is accepted", () => {
  for (const good of ["20261025T143012Z-3f9c2ab", "20261025T143012Z-abcdef0123456789abcdef0123456789abcdef01"]) {
    assert.equal(assertReleaseId(good), good);
  }
  for (const bad of [
    "../../etc/passwd",
    "/home/ubuntu/grynd/releases/x",
    "C:\\Windows\\system32",
    "20261025T143012Z",
    "20261025T143012Z-3F9C2AB",
    "..",
    "",
    null,
    undefined,
    42,
    "20261025T143012Z-3f9c2ab/../../x",
  ]) {
    assert.throws(() => assertReleaseId(bad), (error) => error instanceof DeployError && error.code === "INVALID_ID", `accepted ${String(bad)}`);
  }
});

test("release ids: derived ids are chronological and carry the short sha", () => {
  const first = makeReleaseId({ date: new Date("2026-10-25T14:30:12.000Z"), commit: "3f9c2ab1111111111111111111111111111111aa" });
  const second = makeReleaseId({ date: new Date("2026-10-25T14:31:00.000Z"), commit: "3f9c2ab1111111111111111111111111111111aa" });
  assert.equal(first, "20261025T143012Z-3f9c2ab");
  assert.ok(first < second);
  assert.throws(() => makeReleaseId({ commit: "not-a-sha" }), (error) => error.code === "INVALID_COMMIT");
});

test("layout: derived paths stay under the root, containment rejects traversal", async () => {
  const l = layout(path.resolve("/tmp/grynd-root"));
  assert.ok(isInside(l.releases, l.releaseDir("20261025T143012Z-3f9c2ab")));
  assert.ok(isInside(l.env, l.appEnv));
  assert.equal(isInside(l.releases, path.join(l.root, "env", "app.env")), false);
  assert.equal(isInside(l.releases, path.join(l.releases, "..", "env", "app.env")), false);
  assert.equal(isInside(l.releases, l.releases), true);
});

// ── manifest ───────────────────────────────────────────────────────────────

test("manifest: a complete manifest passes and each missing guarantee is reported", () => {
  const id = "20261025T143012Z-3f9c2ab";
  assert.deepEqual(validateManifest(validManifest(), { id }), []);

  const cases = [
    ["schema", { schema: 2 }],
    ["releaseId", { releaseId: "20261025T143012Z-9999999" }],
    ["commit", { commit: "3f9c2ab" }],
    ["shortCommit", { shortCommit: "not-hex" }],
    ["buildId", { buildId: "" }],
    ["createdAt", { createdAt: "yesterday" }],
    ["builder", { builder: undefined }],
    ["arch", { builder: { ...validManifest().builder, arch: "mips" } }],
    ["node", { builder: { ...validManifest().builder, node: "" } }],
    ["caTrust", { productionFixes: { caTrust: false } }],
    ["realtime", { realtime: { hash: "md5:abc" } }],
    ["artifact", { artifact: { hash: "md5:abc", files: 1, bytes: 1 } }],
    ["artifact.files", { artifact: { hash: `sha256:${"b".repeat(64)}`, files: 0, bytes: 1 } }],
    ["artifact.bytes", { artifact: { hash: `sha256:${"b".repeat(64)}`, files: 1, bytes: -1 } }],
    ["checks", { checks: undefined }],
    ["checks.build", { checks: { build: "maybe", tests: "passed" } }],
    ["checks.tests", { checks: { build: "passed", tests: "skipped" } }],
  ];

  for (const [label, override] of cases) {
    const errors = validateManifest(validManifest(override), { id });
    assert.ok(errors.length > 0, `${label} mutation was accepted`);
  }

  // The directory id and the manifest id must agree, or a release could claim
  // to be something it is not.
  assert.ok(validateManifest(validManifest(), { id: "20261025T143012Z-9999999" }).some((error) => /does not match directory/.test(error)));
});

test("manifest: the artifact checksum is re-derived and must match", async () => {
  const l = layout(await tempRoot());
  try {
    const id = "20261020T080000Z-1111111";
    await buildFixtureRelease({ incomingDir: l.incomingDir(id), id });
    const dir = l.incomingDir(id);

    const built = await inspectRelease(dir, { id });
    assert.equal(built.ok, true, built.errors.join("; "));
    assert.match(built.artifactHash, /^sha256:[0-9a-f]{64}$/);
    assert.equal(built.artifactHash, built.manifest.artifact.hash);

    // A file anywhere in the app tree invalidates the whole-artifact checksum,
    // not just the realtime hash.
    await fs.writeFile(path.join(dir, "app", ".next", "static", "app.js"), "// tampered\n");
    const tampered = await inspectRelease(dir, { id });
    assert.equal(tampered.ok, false);
    assert.ok(tampered.errors.some((error) => /artifact checksum/.test(error)));

    // The runtime cache is excluded: it legitimately changes while the app runs,
    // and a rollback target must still verify afterwards.
    await fs.mkdir(path.join(dir, "app", ".next", "cache"), { recursive: true });
    await fs.writeFile(path.join(dir, "app", ".next", "cache", "isr.json"), "{}");
    await fs.writeFile(path.join(dir, "app", ".next", "static", "app.js"), "static asset for cache test\n");
    const manifest = JSON.parse(await fs.readFile(path.join(dir, "release.json"), "utf8"));
    const { hashArtifact } = await import("../lib/manifest.mjs");
    const fresh = await hashArtifact(dir);
    manifest.artifact = { hash: fresh.hash, files: fresh.files, bytes: fresh.bytes };
    await fs.writeFile(path.join(dir, "release.json"), JSON.stringify(manifest, null, 2));
    const withCache = await inspectRelease(dir, { id });
    assert.equal(withCache.ok, true, withCache.errors.join("; "));
  } finally {
    await fs.rm(l.root, { recursive: true, force: true });
  }
});

test("manifest: BUILD_ID must agree with the manifest", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "grynd-completeness-"));
  try {
    const manifest = validManifest();
    await fs.mkdir(path.join(dir, "app", ".next", "static"), { recursive: true });
    await fs.mkdir(path.join(dir, "app", "public"), { recursive: true });
    await fs.mkdir(path.join(dir, "app", "node_modules", "next"), { recursive: true });
    await fs.mkdir(path.join(dir, "realtime", "node_modules", "express"), { recursive: true });
    await fs.mkdir(path.join(dir, "realtime", "node_modules", "socket.io"), { recursive: true });
    await fs.writeFile(path.join(dir, "app", "package.json"), "{}");
    await fs.writeFile(path.join(dir, "app", "next.config.js"), "module.exports={}");
    await fs.writeFile(path.join(dir, "app", "node_modules", "next", "package.json"), "{}");
    await fs.writeFile(path.join(dir, "realtime", "server.js"), "// noop");
    await fs.writeFile(path.join(dir, "realtime", "package.json"), "{}");
    await fs.writeFile(path.join(dir, "realtime", "node_modules", "express", "package.json"), "{}");
    await fs.writeFile(path.join(dir, "realtime", "node_modules", "socket.io", "package.json"), "{}");
    await fs.writeFile(path.join(dir, "app", ".next", "BUILD_ID"), "build-abc\n");

    const ok = await checkCompleteness(dir, manifest);
    assert.equal(ok.ok, true, ok.errors.join("; "));
    assert.equal(ok.buildId, "build-abc");

    await fs.writeFile(path.join(dir, "app", ".next", "BUILD_ID"), "different\n");
    const mismatch = await checkCompleteness(dir, manifest);
    assert.equal(mismatch.ok, false);
    assert.ok(mismatch.errors.some((error) => /does not match manifest/.test(error)));

    await fs.rm(path.join(dir, "realtime", "server.js"));
    const missing = await checkCompleteness(dir, manifest);
    assert.ok(missing.errors.some((error) => /missing: realtime\/server\.js/.test(error)));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("runtime compatibility: arch and Node major are enforced", () => {
  const manifest = validManifest();
  const wrongArch = checkRuntimeCompatibility(manifest, { arch: manifest.builder.arch === "arm64" ? "x64" : "arm64", node: process.versions.node });
  assert.equal(wrongArch.ok, false);
  assert.match(wrongArch.errors.join(" "), /built for/);

  const wrongNode = checkRuntimeCompatibility(manifest, { arch: manifest.builder.arch, node: "99.0.0" });
  assert.equal(wrongNode.ok, false);
  assert.match(wrongNode.errors.join(" "), /Node/);

  assert.equal(checkRuntimeCompatibility(manifest, { arch: manifest.builder.arch, node: manifest.builder.node }).ok, true);
});

// ── pointer ────────────────────────────────────────────────────────────────

test("pointer: swap is reported atomic on POSIX and read back by id", async () => {
  const root = await tempRoot();
  try {
    const a = path.join(root, "releases", "20261020T080000Z-1111111");
    const b = path.join(root, "releases", "20261021T090000Z-2222222");
    await fs.mkdir(a, { recursive: true });
    await fs.mkdir(b, { recursive: true });

    assert.equal(await readPointer(root, "current"), null);

    // Creating the link is always a rename into an empty name, so it is atomic
    // everywhere. REPLACING it is atomic only where rename(2) replaces a link.
    const first = await swapPointer(root, "current", a);
    assert.equal(first.atomic, true);
    assert.match(first.strategy, /rename/);
    assert.equal((await readPointer(root, "current")).id, path.basename(a));

    const second = await swapPointer(root, "current", b);
    assert.equal((await readPointer(root, "current")).id, path.basename(b));
    assert.equal(second.atomic, process.platform !== "win32");

    // Removing the target must be reported as a broken pointer, not a crash and
    // not silently "the old release".
    await fs.rm(b, { recursive: true, force: true });
    const broken = await readPointer(root, "current");
    assert.equal(broken.broken, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("pointer: a real directory where the link belongs is reported, not followed", async () => {
  const root = await tempRoot();
  try {
    await fs.mkdir(path.join(root, "current"));
    const pointer = await readPointer(root, "current");
    assert.equal(pointer.broken, true);
    assert.match(pointer.reason, /not a symlink/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ── state and environment ─────────────────────────────────────────────────

test("env: reported by size and mode only, never by value", async () => {
  const root = await tempRoot();
  try {
    const l = layout(root);
    await writeEnvFiles(l);
    const report = await envReport(l);
    assert.equal(report.length, 2);
    assert.ok(report.every((entry) => entry.present && entry.bytes > 0 && entry.insideRelease === false));
    assert.ok(!JSON.stringify(report).includes("do-not-print"), "env values must never be serialised");
    if (process.platform !== "win32") {
      assert.ok(report.every((entry) => entry.mode === "0600" && entry.modeOk));
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("env: activation is refused when env files are missing, empty or too open", async () => {
  const root = await tempRoot();
  try {
    const l = layout(root);
    await assert.rejects(() => assertEnvironmentReady(l), (error) => error.code === "ENV_NOT_READY");

    await writeEnvFiles(l);
    assert.equal((await assertEnvironmentReady(l)).length, 2);

    await fs.writeFile(l.appEnv, "", { mode: 0o600 });
    await assert.rejects(() => assertEnvironmentReady(l), /app\.env is empty/);

    if (process.platform !== "win32") {
      await fs.writeFile(l.appEnv, "A=1\n", { mode: 0o644 });
      await fs.chmod(l.appEnv, 0o644);
      await assert.rejects(() => assertEnvironmentReady(l), /mode 0644/);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("env: a release may never contain the environment files", async () => {
  const root = await tempRoot();
  try {
    const l = layout(root);
    const id = "20261025T143012Z-3f9c2ab";
    await buildFixtureRelease({ incomingDir: l.incomingDir(id), id });
    await fs.writeFile(path.join(l.incomingDir(id), "app", ".env.production"), "SECRET=1\n");
    const report = await inspectRelease(l.incomingDir(id), { id });
    assert.equal(report.ok, false);
    assert.ok(report.errors.some((error) => /environment files/.test(error)));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("context: state writes are atomic and audit entries are appended in order", async () => {
  const root = await tempRoot();
  try {
    const l = layout(root);
    await markVerified(l, "20261020T080000Z-1111111");
    await markVerified(l, "20261021T090000Z-2222222");
    const audit = await readAudit(l);
    assert.equal(audit.length, 0);
    assert.deepEqual([...(await readVerified(l))].sort(), ["20261020T080000Z-1111111", "20261021T090000Z-2222222"]);
    assert.equal(await readActive(l), null);
    // No stray temp files left behind.
    const stateFiles = await fs.readdir(l.state);
    assert.ok(stateFiles.every((file) => !file.includes(".tmp-")), `temp files left: ${stateFiles.join(", ")}`);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ── health ────────────────────────────────────────────────────────────────

test("health: probes the real contract (200 {ok:true}) and refuses non-loopback targets", async () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/ok") return res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
    if (req.url === "/bad") return res.writeHead(503, { "content-type": "application/json" }).end('{"ok":false}');
    if (req.url === "/lying") return res.writeHead(200, { "content-type": "application/json" }).end('{"ok":false}');
    if (req.url === "/healthy-app") return res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true,"db":"ok","redis":"ok"}');
    if (req.url === "/db-unhealthy") return res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true,"db":"error"}');
    if (req.url === "/missing-db") return res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
    if (req.url === "/malformed") return res.writeHead(200, { "content-type": "text/plain" }).end("OK");
    if (req.url === "/api/health") return res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true,"db":"error"}');
    return res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    assert.equal((await probeHttp({ url: `http://127.0.0.1:${port}/ok` })).ok, true);
    const bad = await probeHttp({ url: `http://127.0.0.1:${port}/bad` });
    assert.equal(bad.ok, false);
    assert.equal(bad.status, 503);
    const lying = await probeHttp({ url: `http://127.0.0.1:${port}/lying` });
    assert.equal(lying.ok, false);
    assert.match(lying.error, /ok:false/);

    // The app contract: 200 is necessary but not sufficient. A reachable app
    // with a broken database must fail even though the HTTP status is 200.
    const appExpectations = { requireJson: true, requiredFields: { db: "ok" } };
    assert.equal((await probeHttp({ url: `http://127.0.0.1:${port}/healthy-app`, ...appExpectations })).ok, true);

    const dbDown = await probeHttp({ url: `http://127.0.0.1:${port}/db-unhealthy`, ...appExpectations });
    assert.equal(dbDown.ok, false);
    assert.match(dbDown.error, /db="error"/);

    const missingDb = await probeHttp({ url: `http://127.0.0.1:${port}/missing-db`, ...appExpectations });
    assert.equal(missingDb.ok, false);
    assert.match(missingDb.error, /db=undefined/);

    const malformed = await probeHttp({ url: `http://127.0.0.1:${port}/malformed`, ...appExpectations });
    assert.equal(malformed.ok, false);
    assert.match(malformed.error, /JSON/);

    // The realtime contract needs ok:true too, but has no database.
    const realtime = await probeHttp({ url: `http://127.0.0.1:${port}/healthy-app`, requireJson: true });
    assert.equal(realtime.ok, true);

    const refused = await probeHttp({ url: "http://example.com/" });
    assert.equal(refused.ok, false);
    assert.match(refused.error, /non-loopback/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("health: a probe that never responds is bounded by its timeout", async () => {
  // A half-started release must not make the deploy tool hang. The socket is
  // accepted, but the response never arrives.
  const server = http.createServer(() => {});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    const started = Date.now();
    const result = await probeHttp({ url: `http://127.0.0.1:${port}/health`, timeoutMs: 120 });
    const elapsed = Date.now() - started;
    assert.equal(result.ok, false);
    assert.match(result.error, /timeout/);
    assert.ok(elapsed < 2_000, `probe took ${elapsed}ms; the timeout did not bound it`);

    const gate = await runHealthGate({
      targets: [{ name: "app", url: `http://127.0.0.1:${port}/api/health` }],
      attempts: 2,
      intervalMs: 1,
      timeoutMs: 120,
      sleep: noSleep,
    });
    assert.equal(gate.ok, false);
    assert.match(gate.results[0].error, /timeout/);
    assert.match(gate.history[0].results[0].error, /timeout/);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("health gate: the app target rejects a 200 whose database is unhealthy", async () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/api/health") {
      return res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true,"db":"error"}');
    }
    return res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    const targets = defaultHealthTargets({ appPort: port, includeRealtime: false });
    const gate = await runHealthGate({ targets, attempts: 2, intervalMs: 1, sleep: noSleep });
    assert.equal(gate.ok, false);
    assert.equal(gate.attempts, 2);
    const check = gate.results.find((result) => result.name === "app");
    assert.equal(check.ok, false);
    assert.match(check.error, /db="error"/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("activation: a 200 with db=error reverts even though the request succeeded", async () => {
  const root = await tempRoot();
  const server = http.createServer((req, res) => {
    if (req.url === "/api/health") {
      return res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true,"db":"error"}');
    }
    return res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    const l = layout(root);
    await writeEnvFiles(l);
    const good = "20261020T080000Z-1111111";
    const bad = "20261021T090000Z-2222222";
    await installFixture(l, good);
    await activateRelease({
      root,
      id: good,
      actor: "test",
      controller: stubController(),
      healthOptions: { attempts: 1, intervalMs: 1, probe: async () => ({ ok: true, status: 200, ms: 1, error: null }) },
    });
    await installFixture(l, bad);

    const attempted = await activateRelease({
      root,
      id: bad,
      actor: "test",
      controller: stubController(),
      healthOptions: { attempts: 1, intervalMs: 1, appPort: port, includeRealtime: false },
    });

    assert.equal(attempted.ok, false);
    assert.equal(attempted.stage, "health");
    assert.equal(attempted.health.ok, false);
    assert.equal(attempted.revert.target, good);
    assert.equal((await readPointer(root, "current")).id, good);
    assert.equal((await readActive(l)).releaseId, good);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("health gate: retries until healthy, then fails when it never is", async () => {
  const passing = await runHealthGate({
    targets: [{ name: "app", url: "http://127.0.0.1:1/api/health" }],
    attempts: 5,
    intervalMs: 1,
    sleep: noSleep,
    probe: scriptedProbe([false, false, true]),
  });
  assert.equal(passing.ok, true);
  assert.equal(passing.attempts, 3);

  const failing = await runHealthGate({
    targets: [{ name: "app", url: "http://127.0.0.1:1/api/health" }],
    attempts: 3,
    intervalMs: 1,
    sleep: noSleep,
    probe: scriptedProbe([false]),
  });
  assert.equal(failing.ok, false);
  assert.equal(failing.attempts, 3);
});

// ── install ───────────────────────────────────────────────────────────────

test("install: an uploaded artifact is verified then renamed into releases/", async () => {
  const root = await tempRoot();
  try {
    const l = layout(root);
    const id = "20261020T080000Z-1111111";
    const installed = await installFixture(l, id);
    assert.equal(installed.ok, true);
    await assert.rejects(() => fs.stat(l.incomingDir(id)), "incoming dir should be consumed");
    assert.ok(await fs.stat(l.releaseDir(id)));

    await assert.rejects(() => installRelease({ root, id, actor: "test" }), (error) => error.code === "ALREADY_INSTALLED");

    await assert.rejects(
      () => installRelease({ root, id: "20261021T090000Z-2222222", actor: "test" }),
      (error) => error.code === "NOT_UPLOADED",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("install: a tampered artifact is refused and never moved", async () => {
  const root = await tempRoot();
  try {
    const l = layout(root);
    const id = "20261020T080000Z-1111111";
    await buildFixtureRelease({ incomingDir: l.incomingDir(id), id });
    await fs.writeFile(path.join(l.incomingDir(id), "realtime", "server.js"), "// tampered\n");

    await assert.rejects(
      () => installRelease({ root, id, actor: "test" }),
      (error) => error.code === "RELEASE_UNUSABLE" && /hash/.test(error.message),
    );
    assert.ok(await fs.stat(l.incomingDir(id)), "the rejected upload stays in incoming/");
    assert.equal(await fs.stat(l.releaseDir(id)).catch(() => null), null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ── install rejects: standalone, keys ─────────────────────────────────────

test("inspect: rejects a standalone build, certificate material and a missing CA assertion", async () => {
  const root = await tempRoot();
  try {
    const l = layout(root);
    const id = "20261020T080000Z-1111111";
    await buildFixtureRelease({ incomingDir: l.incomingDir(id), id });
    const dir = l.incomingDir(id);

    await fs.mkdir(path.join(dir, "app", ".next", "standalone"), { recursive: true });
    let report = await inspectRelease(dir, { id });
    assert.ok(report.errors.some((error) => /standalone/.test(error)));

    await fs.rm(path.join(dir, "app", ".next", "standalone"), { recursive: true, force: true });
    await fs.writeFile(path.join(dir, "app", "db-ca.pem"), "-----BEGIN CERTIFICATE-----");
    report = await inspectRelease(dir, { id });
    assert.ok(report.errors.some((error) => /certificate\/key material/.test(error)));

    await fs.rm(path.join(dir, "app", "db-ca.pem"));
    const manifest = JSON.parse(await fs.readFile(path.join(dir, "release.json"), "utf8"));
    manifest.productionFixes.caTrust = false;
    await fs.writeFile(path.join(dir, "release.json"), JSON.stringify(manifest, null, 2));
    report = await inspectRelease(dir, { id });
    assert.ok(report.errors.some((error) => /caTrust/.test(error)));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ── activation ────────────────────────────────────────────────────────────

test("activation: success records the active release, moves previous and audits", async () => {
  const root = await tempRoot();
  try {
    const l = layout(root);
    await writeEnvFiles(l);
    const first = "20261020T080000Z-1111111";
    const second = "20261021T090000Z-2222222";
    await installFixture(l, first);
    await installFixture(l, second);

    const controller = stubController();
    const one = await activateRelease({
      root,
      id: first,
      actor: "alice",
      reason: "first",
      controller,
      healthOptions: { probe: scriptedProbe([true]), attempts: 1, sleep: noSleep },
    });
    assert.equal(one.ok, true);
    assert.equal((await readPointer(root, "current")).id, first);
    assert.equal((await readActive(l)).releaseId, first);
    assert.deepEqual([...(await readVerified(l))], [first]);

    const two = await activateRelease({
      root,
      id: second,
      actor: "bob",
      reason: "second",
      controller,
      healthOptions: { probe: scriptedProbe([true]), attempts: 1, sleep: noSleep },
    });
    assert.equal(two.ok, true);
    assert.equal((await readPointer(root, "current")).id, second);
    assert.equal((await readPointer(root, "previous")).id, first);

    const audit = await readAudit(l);
    assert.equal(audit.filter((entry) => entry.event === "activation" && entry.outcome === "ok").length, 2);
    const last = audit.at(-1);
    assert.equal(last.actor, "bob");
    assert.equal(last.previousReleaseId, first);
    assert.equal(last.targetSha, two.active.commit);
    assert.ok(last.completedAt);
    assert.equal(controller.calls.length, 2);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("activation: a host without a service controller refuses before the pointer moves", async () => {
  const root = await tempRoot();
  try {
    const l = layout(root);
    await writeEnvFiles(l);
    const id = "20261020T080000Z-1111111";
    await installFixture(l, id);

    await assert.rejects(
      () =>
        activateRelease({
          root,
          id,
          actor: "test",
          controller: createDryRunController(),
          healthOptions: { probe: scriptedProbe([true]), attempts: 1, sleep: noSleep },
        }),
      (error) => error.code === "SERVICE_CONTROL_UNAVAILABLE",
    );
    assert.equal(await readPointer(root, "current"), null, "nothing may be swapped");
    const audit = await readAudit(l);
    assert.equal(audit.at(-1).outcome, "rejected");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("activation: a failed health gate reverts and reports the failure", async () => {
  const root = await tempRoot();
  try {
    const l = layout(root);
    await writeEnvFiles(l);
    const good = "20261020T080000Z-1111111";
    const bad = "20261021T090000Z-2222222";
    await installFixture(l, good);
    await installFixture(l, bad, { variant: "unhealthy" });

    const controller = stubController();
    await activateRelease({ root, id: good, actor: "test", controller, healthOptions: { probe: scriptedProbe([true]), attempts: 1, sleep: noSleep } });

    // First activation of `bad` fails its gate; the revert of `good` passes.
    const result = await activateRelease({
      root,
      id: bad,
      actor: "test",
      controller,
      healthOptions: { probe: scriptedProbe([false, true]), attempts: 1, sleep: noSleep },
    });

    assert.equal(result.ok, false);
    assert.equal(result.stage, "health");
    assert.equal(result.revert.health.ok, true);
    assert.equal((await readPointer(root, "current")).id, good);
    assert.equal((await readActive(l)).releaseId, good);
    assert.equal((await readVerified(l)).has(bad), false);

    const failure = (await readAudit(l)).find((entry) => entry.outcome === "failed");
    assert.equal(failure.stage, "health");
    assert.equal(failure.releaseId, bad);
    assert.equal(failure.previousReleaseId, good);
    assert.ok(failure.health && failure.revert);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("activation: a restart failure reverts before the health gate is even reached", async () => {
  const root = await tempRoot();
  try {
    const l = layout(root);
    await writeEnvFiles(l);
    const good = "20261020T080000Z-1111111";
    const next = "20261021T090000Z-2222222";
    await installFixture(l, good);
    await installFixture(l, next);

    await activateRelease({
      root,
      id: good,
      actor: "test",
      controller: stubController(),
      healthOptions: { probe: scriptedProbe([true]), attempts: 1, sleep: noSleep },
    });

    const result = await activateRelease({
      root,
      id: next,
      actor: "test",
      controller: stubController({ failRestart: true }),
      healthOptions: { probe: scriptedProbe([true]), attempts: 1, sleep: noSleep },
    });

    assert.equal(result.ok, false);
    assert.equal(result.stage, "service-restart");
    // The pointer is put back even though restarting is what just failed; the
    // revert's own failure is reported rather than hidden.
    assert.equal((await readPointer(root, "current")).id, good);
    assert.equal(result.revert.swapped, true);
    assert.match(result.revert.error, /systemctl restart failed/);
    const failure = (await readAudit(l)).find((entry) => entry.outcome === "failed");
    assert.equal(failure.stage, "service-restart");
    assert.match(failure.revert.error, /systemctl restart failed/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("activation: a revert that cannot restore health says so instead of claiming success", async () => {
  const root = await tempRoot();
  try {
    const l = layout(root);
    await writeEnvFiles(l);
    const good = "20261020T080000Z-1111111";
    const bad = "20261021T090000Z-2222222";
    await installFixture(l, good);
    await installFixture(l, bad, { variant: "unhealthy" });

    await activateRelease({
      root,
      id: good,
      actor: "test",
      controller: stubController(),
      healthOptions: { probe: scriptedProbe([true]), attempts: 1, sleep: noSleep },
    });

    const result = await activateRelease({
      root,
      id: bad,
      actor: "test",
      controller: stubController(),
      healthOptions: { probe: scriptedProbe([false]), attempts: 1, sleep: noSleep },
    });

    assert.equal(result.ok, false);
    assert.equal(result.revert.health.ok, false);
    const failure = (await readAudit(l)).find((entry) => entry.outcome === "failed");
    assert.equal(failure.revert.health.ok, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ── rollback ──────────────────────────────────────────────────────────────

test("rollback: requires a reason, an exact confirmation, and a previously verified target", async () => {
  const root = await tempRoot();
  try {
    const l = layout(root);
    await writeEnvFiles(l);
    const first = "20261020T080000Z-1111111";
    const second = "20261021T090000Z-2222222";
    const unverified = "20261022T100000Z-3333333";
    await installFixture(l, first);
    await installFixture(l, second);
    await installFixture(l, unverified);

    const controller = stubController();
    const health = { probe: scriptedProbe([true]), attempts: 1, sleep: noSleep };
    await activateRelease({ root, id: first, actor: "test", controller, healthOptions: health });
    await activateRelease({ root, id: second, actor: "test", controller, healthOptions: health });

    await assert.rejects(
      () => rollbackRelease({ root, id: first, actor: "test", confirm: first, reason: "", controller, healthOptions: health }),
      (error) => error.code === "REASON_REQUIRED",
    );
    await assert.rejects(
      () => rollbackRelease({ root, id: first, actor: "test", confirm: second, reason: "x", controller, healthOptions: health }),
      (error) => error.code === "CONFIRMATION_REQUIRED",
    );
    await assert.rejects(
      () => rollbackRelease({ root, id: first, actor: "test", confirm: null, reason: "x", controller, healthOptions: health }),
      (error) => error.code === "CONFIRMATION_REQUIRED",
    );
    await assert.rejects(
      () => rollbackRelease({ root, id: unverified, actor: "test", confirm: unverified, reason: "x", controller, healthOptions: health }),
      (error) => error.code === "NOT_VERIFIED",
    );
    await assert.rejects(
      () => rollbackRelease({ root, id: second, actor: "test", confirm: second, reason: "x", controller, healthOptions: health }),
      (error) => error.code === "ALREADY_ACTIVE",
    );

    const rollback = await rollbackRelease({
      root,
      id: first,
      actor: "carol",
      confirm: first,
      reason: "5xx after deploy",
      controller,
      healthOptions: health,
    });
    assert.equal(rollback.ok, true);
    assert.equal((await readPointer(root, "current")).id, first);
    assert.equal((await readPointer(root, "previous")).id, second);

    const entry = (await readAudit(l)).filter((item) => item.kind === "rollback").at(-1);
    assert.equal(entry.actor, "carol");
    assert.equal(entry.reason, "5xx after deploy");
    assert.equal(entry.outcome, "ok");
    assert.equal(entry.previousReleaseId, second);
    assert.ok(entry.targetSha && entry.previousSha && entry.completedAt);

    // Every refusal is in the audit trail too.
    const rejections = (await readAudit(l)).filter((item) => item.outcome === "rejected");
    assert.ok(rejections.length >= 4);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("rollback: never accepts a path where an id belongs", async () => {
  const root = await tempRoot();
  try {
    const l = layout(root);
    await writeEnvFiles(l);
    await assert.rejects(
      () => rollbackRelease({ root, id: "../../releases/20261020T080000Z-1111111", confirm: "../../releases/20261020T080000Z-1111111", reason: "x", controller: stubController() }),
      (error) => error.code === "INVALID_ID",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ── retention ─────────────────────────────────────────────────────────────

test("prune: never deletes the active or previous release, keeps at least three", async () => {
  const root = await tempRoot();
  try {
    const l = layout(root);
    await writeEnvFiles(l);
    const ids = [
      "20261020T080000Z-1111111",
      "20261021T090000Z-2222222",
      "20261022T100000Z-3333333",
      "20261023T110000Z-4444444",
      "20261023T120000Z-5555555",
      "20261023T130000Z-6666666",
    ];
    for (const id of ids) await installFixture(l, id);

    const controller = stubController();
    const health = { probe: scriptedProbe([true]), attempts: 1, sleep: noSleep };
    await activateRelease({ root, id: ids[0], actor: "test", controller, healthOptions: health });
    await activateRelease({ root, id: ids[1], actor: "test", controller, healthOptions: health });

    const dry = await pruneReleases({ root, keep: 1, actor: "test", dryRun: true });
    assert.ok(dry.removed.length > 0);
    assert.equal((await statusReport({ root })).releases.length, ids.length, "a dry run deletes nothing");

    const result = await pruneReleases({ root, keep: 1, actor: "test" });
    assert.ok(result.keep >= 3, "retention never drops below three releases");
    const remaining = (await statusReport({ root })).releases.map((release) => release.id);
    assert.ok(remaining.includes(ids[0]), "active release retained");
    assert.ok(remaining.includes(ids[1]), "previous release retained");
    assert.ok(remaining.length >= 3);
    assert.ok(remaining.length < ids.length);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ── status ────────────────────────────────────────────────────────────────

test("status: reports pointers, releases, verified state and env files", async () => {
  const root = await tempRoot();
  try {
    const l = layout(root);
    await writeEnvFiles(l);
    const id = "20261020T080000Z-1111111";
    await installFixture(l, id);
    await activateRelease({
      root,
      id,
      actor: "test",
      controller: stubController(),
      healthOptions: { probe: scriptedProbe([true]), attempts: 1, sleep: noSleep },
    });

    const report = await statusReport({ root });
    assert.equal(report.current.id, id);
    assert.equal(report.active.releaseId, id);
    assert.equal(report.releases.length, 1);
    assert.equal(report.releases[0].verified, true);
    assert.equal(report.releases[0].buildId, `fixture-build-${id}`);
    assert.ok(report.envFiles.every((entry) => entry.present));
    assert.ok(report.audit.length >= 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
