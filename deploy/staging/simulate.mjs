// deploy/staging/simulate.mjs
//
// End-to-end staging simulation for the release system. Creates its own root in
// the OS temp directory, builds fixture releases, and drives the real modules
// and the real CLI. It never reads or writes /home/ubuntu, never touches a
// systemd unit and never uses a port below 1024.
//
//   node deploy/staging/simulate.mjs
//   KEEP=1 node deploy/staging/simulate.mjs     (leave the root behind for inspection)
//
// Exit code 0 only when every check passes.

import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { layout } from "../lib/layout.mjs";
import { ensureLayout, envReport, readActive, readAudit, readVerified } from "../lib/state.mjs";
import { readPointer } from "../lib/pointer.mjs";
import { installRelease, pruneReleases, statusReport } from "../lib/install.mjs";
import { activateRelease, rollbackRelease } from "../lib/activate.mjs";
import { createLocalController } from "../lib/services.mjs";
import { buildFixtureRelease, fixtureId } from "./build-fixture.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const CLI = path.join(REPO_ROOT, "deploy", "release.mjs");

const checks = [];
function record(name, ok, detail = "") {
  checks.push({ name, ok, detail });
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}\n`);
}
function check(name, condition, detail) {
  record(name, Boolean(condition), detail);
  return Boolean(condition);
}
async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function getJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

/** Run the CLI exactly as an operator would, returning exit code + output. */
function cli(args, { root, env = {} } = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args, "--root", root], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, GRYND_RELEASE_ROOT: root, ...env },
  });
  return {
    code: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    combined: `${result.stdout || ""}${result.stderr || ""}`,
  };
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "grynd-staging-sim-"));
  const l = layout(root);
  await ensureLayout(l);

  const appPort = await freePort();
  const realtimePort = await freePort();
  const sentinel = `SENTINEL_${Math.random().toString(36).slice(2)}_DO_NOT_PRINT`;
  const actor = "staging-simulator";

  await fs.writeFile(l.appEnv, `DATABASE_URL=postgres://fixture\nFIXTURE_SENTINEL=${sentinel}\n`, { mode: 0o600 });
  await fs.writeFile(l.realtimeEnv, `CLIENT_URL=http://127.0.0.1:${appPort}\nFIXTURE_SENTINEL=${sentinel}\n`, { mode: 0o600 });

  const controller = createLocalController({
    root,
    app: { command: process.execPath, args: ["server.mjs"], cwd: "current/app", env: { PORT: String(appPort) } },
    realtime: { command: process.execPath, args: ["server.js"], cwd: "current/realtime", env: { PORT: String(realtimePort) } },
  });

  const healthOptions = { appPort, realtimePort, attempts: 25, intervalMs: 150, timeoutMs: 1_000 };
  const activation = (id, extra = {}) =>
    activateRelease({ root, id, actor, controller, healthOptions, ...extra });
  const rollback = (id, extra = {}) =>
    rollbackRelease({ root, id, actor, controller, healthOptions, ...extra });

  const ids = {
    v1: fixtureId({ at: "2026-10-20T08:00:00Z", sha: "1111111" }),
    v2: fixtureId({ at: "2026-10-21T09:15:00Z", sha: "2222222" }),
    v3bad: fixtureId({ at: "2026-10-22T10:30:00Z", sha: "3333333" }),
    v4: fixtureId({ at: "2026-10-23T11:45:00Z", sha: "4444444" }),
    v5: fixtureId({ at: "2026-10-23T12:00:00Z", sha: "5555555" }),
    v6: fixtureId({ at: "2026-10-23T13:00:00Z", sha: "6666666" }),
    v7: fixtureId({ at: "2026-10-23T14:00:00Z", sha: "7777777" }),
  };
  const built = {};

  process.stdout.write(`\nGRYND release staging simulation\nroot: ${root}\napp: 127.0.0.1:${appPort}   realtime: 127.0.0.1:${realtimePort}\n\n`);

  try {
    // ── 1. release creation + install ────────────────────────────────────
    for (const [key, id] of Object.entries(ids)) {
      built[key] = await buildFixtureRelease({
        incomingDir: l.incomingDir(id),
        id,
        variant: key === "v3bad" ? "unhealthy" : "ok",
      });
    }
    check(
      "1a fixture release carries manifest + BUILD_ID + realtime hash",
      built.v1.manifest.releaseId === ids.v1 && built.v1.realtimeHash === built.v1.manifest.realtime.hash,
    );

    const installed = await installRelease({ root, id: ids.v1, actor });
    check("1b install moves incoming/<id> into releases/<id>", installed.ok && (await readPointer(root, "current")) === null);
    check(
      "1c incoming directory is consumed, release directory exists",
      !(await fs.stat(l.incomingDir(ids.v1)).catch(() => null)) && Boolean(await fs.stat(l.releaseDir(ids.v1)).catch(() => null)),
    );

    const duplicate = await installRelease({ root, id: ids.v1, actor }).then(
      () => null,
      (error) => error,
    );
    check("1d a release id is never overwritten", duplicate?.code === "ALREADY_INSTALLED", duplicate?.code ?? "no error");

    // ── 2. first activation ──────────────────────────────────────────────
    const first = await activation(ids.v1);
    check("2a first activation passes the health gate", first.ok === true, first.ok ? "" : JSON.stringify(first.health));
    check("2b current points at the new release", (await readPointer(root, "current"))?.id === ids.v1);

    const live = await getJson(`http://127.0.0.1:${appPort}/api/build-id`);
    check(
      "2c the running app resolves its BUILD_ID through current/",
      live.body?.buildId === built.v1.buildId,
      `served ${live.body?.buildId}`,
    );
    const staticAsset = await fetch(`http://127.0.0.1:${appPort}/static/asset-${built.v1.buildId}.txt`);
    check("2d static assets are served from the active release", staticAsset.status === 200);
    const rt = await getJson(`http://127.0.0.1:${realtimePort}/health`);
    check("2e realtime reports the active release marker", rt.body?.marker === ids.v1, `marker ${rt.body?.marker}`);
    check("2f activation is recorded in state/active.json", (await readActive(l))?.releaseId === ids.v1);

    // ── 3. second activation moves `previous` ───────────────────────────
    await installRelease({ root, id: ids.v2, actor });
    const second = await activation(ids.v2);
    check("3a second activation passes the gate", second.ok === true);
    check("3b previous points at the release that was active", (await readPointer(root, "previous"))?.id === ids.v1);
    check("3c both releases are marked verified", (await readVerified(l)).has(ids.v1) && (await readVerified(l)).has(ids.v2));
    const liveV2 = await getJson(`http://127.0.0.1:${appPort}/api/build-id`);
    check("3d the app now serves the second BUILD_ID", liveV2.body?.buildId === built.v2.buildId);

    // ── 4. failed activation reverts ─────────────────────────────────────
    await installRelease({ root, id: ids.v3bad, actor });
    const beforeFailure = await readActive(l);
    const failed = await activation(ids.v3bad);
    check("4a an unhealthy release fails activation", failed.ok === false && failed.stage === "health", failed.stage ?? "");
    check("4b current is reverted to the previous release", (await readPointer(root, "current"))?.id === ids.v2);
    check("4c the revert passed its own health gate", failed.revert?.health?.ok === true);
    check("4d active.json still records the last good release", (await readActive(l))?.releaseId === beforeFailure?.releaseId);
    const revertedHealth = await getJson(`http://127.0.0.1:${appPort}/api/health`);
    check("4e the reverted release is actually serving", revertedHealth.status === 200);
    check("4f the failed release is not marked verified", !(await readVerified(l)).has(ids.v3bad));
    const auditAfterFailure = await readAudit(l, { limit: 20 });
    const failureEntry = auditAfterFailure.find((entry) => entry.releaseId === ids.v3bad && entry.outcome === "failed");
    check(
      "4g the failed attempt is audited with stage, target and previous sha",
      failureEntry?.stage === "health" && failureEntry?.targetSha === built.v3bad.commit && failureEntry?.previousSha === built.v2.commit,
    );
    const staleRoot = await fs.stat(l.releaseDir(ids.v3bad)).catch(() => null);
    check("4h the failed release stays on disk for inspection", Boolean(staleRoot));

    // ── 5. rollback ─────────────────────────────────────────────────────
    const rb = await rollback(ids.v1, { confirm: ids.v1, reason: "staging rollback check" });
    check("5a rollback to a verified release succeeds", rb.ok === true);
    check("5b rollback moves current backwards", (await readPointer(root, "current"))?.id === ids.v1);
    check("5c rollback serves the older BUILD_ID", (await getJson(`http://127.0.0.1:${appPort}/api/build-id`)).body?.buildId === built.v1.buildId);
    const rbAudit = (await readAudit(l, { limit: 20 })).filter((entry) => entry.kind === "rollback" && entry.outcome === "ok").pop();
    check(
      "5d rollback records actor, target sha, previous sha, reason and outcome",
      rbAudit?.actor === actor &&
        rbAudit?.targetSha === built.v1.commit &&
        rbAudit?.previousSha === built.v2.commit &&
        rbAudit?.reason === "staging rollback check" &&
        Boolean(rbAudit?.completedAt),
    );
    check("5e rollback updates the previous pointer to the release it left", (await readPointer(root, "previous"))?.id === ids.v2);

    // ── 6. refusal contracts (through the CLI, as an operator meets them) ─
    const refusal = (args) => cli(args, { root });
    const noReason = refusal(["rollback", ids.v2, "--actor", actor, "--confirm", ids.v2]);
    check("6a rollback without a reason is refused", noReason.code === 2, `exit ${noReason.code}`);
    const wrongConfirm = refusal(["rollback", ids.v2, "--actor", actor, "--confirm", ids.v1, "--reason", "x"]);
    check("6b rollback with a mismatched --confirm is refused", wrongConfirm.code === 2, `exit ${wrongConfirm.code}`);
    const pathId = refusal(["rollback", "../../etc/passwd", "--confirm", "../../etc/passwd", "--reason", "x"]);
    check("6c a filesystem path is not a release id", pathId.code === 2 && /Invalid release id/.test(pathId.combined));
    const notVerified = refusal(["rollback", ids.v3bad, "--actor", actor, "--confirm", ids.v3bad, "--reason", "x"]);
    check("6d rollback to a never-verified release is refused", notVerified.code === 2 && /never passed/.test(notVerified.combined));
    const alreadyActive = refusal(["rollback", ids.v1, "--actor", actor, "--confirm", ids.v1, "--reason", "x"]);
    check("6e rollback to the active release is refused", alreadyActive.code === 2 && /already active/.test(alreadyActive.combined));

    // ── 7. artifact gates ───────────────────────────────────────────────
    await buildFixtureRelease({ incomingDir: l.incomingDir(ids.v4), id: ids.v4 });
    await fs.writeFile(path.join(l.incomingDir(ids.v4), "app", ".next", "BUILD_ID"), "tampered-build\n");
    const tampered = await installRelease({ root, id: ids.v4, actor }).then(() => null, (error) => error);
    check("7a an artifact whose BUILD_ID disagrees with its manifest is refused", tampered?.code === "RELEASE_UNUSABLE", tampered?.code ?? "installed");
    check("7b a refused artifact is not moved into releases/", !(await fs.stat(l.releaseDir(ids.v4)).catch(() => null)));

    await fs.rm(l.incomingDir(ids.v4), { recursive: true, force: true });
    await buildFixtureRelease({ incomingDir: l.incomingDir(ids.v4), id: ids.v4 });
    await fs.writeFile(path.join(l.incomingDir(ids.v4), "realtime", "server.js"), "// modified after hashing\n");
    const hashMismatch = await installRelease({ root, id: ids.v4, actor }).then(() => null, (error) => error);
    check("7c a realtime tree that does not match its recorded hash is refused", hashMismatch?.code === "RELEASE_UNUSABLE" && /hash/.test(hashMismatch.message));

    await fs.rm(l.incomingDir(ids.v4), { recursive: true, force: true });
    await buildFixtureRelease({ incomingDir: l.incomingDir(ids.v4), id: ids.v4 });
    await fs.writeFile(path.join(l.incomingDir(ids.v4), "app", ".env.production"), "SECRET=1\n");
    const envLeak = await installRelease({ root, id: ids.v4, actor }).then(() => null, (error) => error);
    check("7d an artifact containing an env file is refused", envLeak?.code === "RELEASE_UNUSABLE" && /environment files/.test(envLeak.message));

    await fs.rm(l.incomingDir(ids.v4), { recursive: true, force: true });
    await buildFixtureRelease({ incomingDir: l.incomingDir(ids.v4), id: ids.v4 });
    const mismatchedArch = JSON.parse(await fs.readFile(path.join(l.incomingDir(ids.v4), "release.json"), "utf8"));
    mismatchedArch.builder.arch = process.arch === "arm64" ? "x64" : "arm64";
    await fs.writeFile(path.join(l.incomingDir(ids.v4), "release.json"), JSON.stringify(mismatchedArch, null, 2));
    const wrongArch = await installRelease({ root, id: ids.v4, actor }).then(() => null, (error) => error);
    check("7e an artifact built for another architecture is refused", wrongArch?.code === "RELEASE_UNUSABLE" && /architecture|built for/.test(wrongArch.message));

    await fs.rm(l.incomingDir(ids.v4), { recursive: true, force: true });
    await buildFixtureRelease({ incomingDir: l.incomingDir(ids.v4), id: ids.v4 });
    const noCa = JSON.parse(await fs.readFile(path.join(l.incomingDir(ids.v4), "release.json"), "utf8"));
    noCa.productionFixes.caTrust = false;
    await fs.writeFile(path.join(l.incomingDir(ids.v4), "release.json"), JSON.stringify(noCa, null, 2));
    const missingFix = await installRelease({ root, id: ids.v4, actor }).then(() => null, (error) => error);
    check("7f an artifact that does not assert the CA fix is refused", missingFix?.code === "RELEASE_UNUSABLE" && /caTrust/.test(missingFix.message));

    await fs.rm(l.incomingDir(ids.v4), { recursive: true, force: true });
    await buildFixtureRelease({ incomingDir: l.incomingDir(ids.v4), id: ids.v4 });
    await installRelease({ root, id: ids.v4, actor });
    check("7g a clean artifact installs after the rejected ones", Boolean(await fs.stat(l.releaseDir(ids.v4)).catch(() => null)));

    const appTamperId = "20261020T090000Z-aaaaaaaa";
    await buildFixtureRelease({ incomingDir: l.incomingDir(appTamperId), id: appTamperId });
    await fs.writeFile(path.join(l.incomingDir(appTamperId), "app", ".next", "static", "tampered.js"), "// modified after hashing\n");
    const appTamper = await installRelease({ root, id: appTamperId, actor }).then(() => null, (error) => error);
    check(
      "7h an artifact whose app files do not match its checksum is refused",
      appTamper?.code === "RELEASE_UNUSABLE" && /checksum/.test(appTamper.message),
      appTamper?.code ?? "installed",
    );

    // ── 8. retention ────────────────────────────────────────────────────
    for (const key of ["v5", "v6", "v7"]) {
      await buildFixtureRelease({ incomingDir: l.incomingDir(ids[key]), id: ids[key] });
      await installRelease({ root, id: ids[key], actor });
    }
    const beforePrune = await statusReport({ root });
    const pruned = await pruneReleases({ root, keep: 3, actor });
    const afterIds = (await statusReport({ root })).releases.map((release) => release.id);
    check("8a prune keeps at least three releases", afterIds.length >= 3 && afterIds.length < beforePrune.releases.length, `${beforePrune.releases.length} -> ${afterIds.length}`);
    check(
      "8b prune never removes the active or previous release",
      afterIds.includes(ids.v1) && afterIds.includes(ids.v2),
      `removed ${pruned.removed.join(", ") || "(none)"}`,
    );
    check("8c pruned releases disappear from the verified set", !(await readVerified(l)).has(ids.v5) || afterIds.includes(ids.v5));

    // ── 9. environment handling ─────────────────────────────────────────
    const envState = await envReport(l);
    check("9a env files are reported present and non-empty", envState.every((entry) => entry.present && entry.bytes > 0));
    check(
      "9b env files are 0600 on POSIX and live outside releases/",
      envState.every((entry) => entry.insideRelease === false && (process.platform === "win32" || entry.mode === "0600")),
    );
    const statusJson = cli(["status", "--json"], { root }).stdout;
    const stateFiles = await fs.readdir(l.state);
    const stateText = (
      await Promise.all(stateFiles.map((file) => fs.readFile(path.join(l.state, file), "utf8").catch(() => "")))
    ).join("\n");
    const releaseManifests = await Promise.all(
      (await fs.readdir(l.releases)).map((id) => fs.readFile(path.join(l.releases, id, "release.json"), "utf8").catch(() => "")),
    );
    check(
      "9c no environment value appears in output, state or manifests",
      !statusJson.includes(sentinel) && !stateText.includes(sentinel) && !releaseManifests.join("\n").includes(sentinel),
    );

    // ── 10. activation without a controller is refused ──────────────────
    const noController = cli(["activate", ids.v2, "--actor", actor], { root });
    check(
      "10a activation cannot proceed on a host that cannot restart services",
      noController.code === 2 && /No service controller is enabled/.test(noController.combined),
    );
    check("10b the refused activation did not move current", (await readPointer(root, "current"))?.id === ids.v1);

    const finalStatus = await statusReport({ root });
    check(
      "10c status reports the active release, pointers and verified set",
      finalStatus.active?.releaseId === ids.v1 && finalStatus.current?.id === ids.v1 && finalStatus.verified.length >= 2,
    );
  } finally {
    await controller.stop();
    if (process.env.KEEP === "1") {
      process.stdout.write(`\nkept ${root}\n`);
    } else {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  }

  const failed = checks.filter((entry) => !entry.ok);
  process.stdout.write(`\n${checks.length - failed.length}/${checks.length} checks passed\n`);
  if (failed.length > 0) {
    process.stdout.write(`\nFAILED:\n${failed.map((entry) => `  - ${entry.name}${entry.detail ? `: ${entry.detail}` : ""}`).join("\n")}\n`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`\nsimulation crashed: ${error.stack || error.message}\n`);
  process.exitCode = 1;
});
