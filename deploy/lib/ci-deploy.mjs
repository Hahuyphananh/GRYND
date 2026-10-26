// deploy/lib/ci-deploy.mjs
//
// The host-side half of the GitHub Actions deployment. The workflow transfers a
// verified artifact into incoming/ and then runs ONE fixed script on the host
// with a JSON request on stdin. No release id, commit, reason or path is ever
// interpolated into a shell command.
//
// It performs the same operations the operator CLI performs:
//
//   verify installed/incoming → install → activate (health gate) → prune → record
//
// and always writes one deployment record, including for a failed activation
// (with the revert outcome). It never touches migrations or environment files.

import fs from "node:fs/promises";

import { DeployError, assertReleaseId, layout as makeLayout, releaseRoot } from "./layout.mjs";
import { assertReleaseUsable } from "./inspect.mjs";
import { installRelease, pruneReleases, statusReport } from "./install.mjs";
import { activateRelease } from "./activate.mjs";
import { createSystemdController } from "./services.mjs";
import {
  appendDeploymentRecord,
  createDeploymentRecord,
  safeText,
} from "./workflow-records.mjs";

const COMMIT_RE = /^[0-9a-f]{40}$/;
const RUN_ID_RE = /^[0-9]{1,20}$/;
const BUILD_ID_RE = /^[A-Za-z0-9_-]{1,120}$/;
const HASH_RE = /^sha256:[0-9a-f]{64}$/;

const MAX_REQUEST_BYTES = 64 * 1024;

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeIso(value) {
  if (typeof value !== "string") return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

/**
 * The workflow request is untrusted input arriving over SSH. Only these fields
 * are read; anything else (a token, a key, a host) is discarded.
 */
export function sanitizeDeploymentRequest(input) {
  if (!isObject(input)) throw new DeployError("deployment request is not an object", "INVALID_REQUEST");

  const releaseId = assertReleaseId(input.releaseId);
  if (typeof input.commit !== "string" || !COMMIT_RE.test(input.commit)) {
    throw new DeployError("deployment request has no valid full commit sha", "INVALID_REQUEST");
  }
  if (typeof input.runId !== "string" || !RUN_ID_RE.test(input.runId)) {
    throw new DeployError("deployment request has no valid workflow run id", "INVALID_REQUEST");
  }

  const artifactHash =
    typeof input.artifactHash === "string" && HASH_RE.test(input.artifactHash) ? input.artifactHash : null;

  return {
    releaseId,
    commit: input.commit,
    buildId: typeof input.buildId === "string" && BUILD_ID_RE.test(input.buildId) ? input.buildId : null,
    runId: input.runId,
    runAttempt:
      typeof input.runAttempt === "number" && Number.isInteger(input.runAttempt) && input.runAttempt > 0
        ? input.runAttempt
        : null,
    workflow: safeText(input.workflow, 80) ?? "release.yml",
    event: input.event === "push" || input.event === "workflow_dispatch" ? input.event : "workflow_dispatch",
    target: input.target === "staging" ? "staging" : "production",
    builtAt: safeIso(input.builtAt),
    startedAt: safeIso(input.startedAt),
    requestedBy: typeof input.requestedBy === "string" ? safeText(input.requestedBy, 39) : null,
    reason: safeText(input.reason),
    artifactHash,
  };
}

async function readRequestFile(file) {
  const info = await fs.stat(file);
  if (info.size > MAX_REQUEST_BYTES) {
    throw new DeployError("deployment request is too large", "INVALID_REQUEST");
  }
  return sanitizeDeploymentRequest(JSON.parse(await fs.readFile(file, "utf8")));
}

async function installOrAcceptExisting({ root, request, arch, node }) {
  try {
    const result = await installRelease({ root, id: request.releaseId, actor: "github-actions", arch, node });
    return { ok: true, result, alreadyInstalled: false };
  } catch (error) {
    if (error?.code !== "ALREADY_INSTALLED") throw error;
    // A retried workflow run must be idempotent: if the artifact is already
    // installed and still verifies, continue to activation instead of failing
    // on the immutable-release rule.
    const l = makeLayout(root);
    await assertReleaseUsable(l, request.releaseId, { arch, node });
    return { ok: true, alreadyInstalled: true, result: null };
  }
}

/**
 * Run one deployment attempt.
 *
 * @returns {Promise<{ok: boolean, outcome: string, install: object, activation: object|null, rollback: object|null, health: object|null, record: object}>}
 */
export async function runCiDeploy({
  root = releaseRoot(),
  request: rawRequest,
  controller = createSystemdController(),
  arch = process.arch,
  node = process.versions.node,
  clock = () => new Date(),
  healthOptions = {},
} = {}) {
  const request = isObject(rawRequest) ? sanitizeDeploymentRequest(rawRequest) : rawRequest;
  const l = makeLayout(root);
  const startedAt = request.startedAt ?? clock().toISOString();

  let install = { ok: false, error: null, code: null, alreadyInstalled: false };
  let activation = null;
  let prune = null;

  try {
    install = { ...(await installOrAcceptExisting({ root, request, arch, node })), error: null, code: null };
  } catch (error) {
    install = {
      ok: false,
      error: error.message,
      code: error.code ?? "INSTALL_FAILED",
      alreadyInstalled: false,
    };
  }

  if (install.ok) {
    try {
      activation = await activateRelease({
        root,
        id: request.releaseId,
        actor: "github-actions",
        reason: request.reason ?? "",
        kind: "deploy",
        controller,
        skipIfActive: true,
        healthOptions,
        arch,
        node,
      });
    } catch (error) {
      // activateRelease throws for preconditions (invalid id, env not ready,
      // controller unavailable). That is a failed attempt, not a crash.
      activation = {
        ok: false,
        stage: "refused",
        error: error.message,
        code: error.code ?? "ACTIVATION_REFUSED",
        health: null,
        revert: null,
      };
    }

    if (activation?.ok === true && activation.skipped !== true) {
      prune = await pruneReleases({ root, keep: 3, actor: "github-actions" }).catch((error) => ({
        ok: false,
        error: error.message,
      }));
    }
  }

  const status = await statusReport({ root }).catch(() => null);
  const finishedAt = clock().toISOString();
  const record = createDeploymentRecord({
    request,
    install,
    activation,
    startedAt,
    finishedAt,
  });
  await appendDeploymentRecord(l, record);

  const ok = record.outcome === "activated" || record.outcome === "skipped";
  return {
    ok,
    outcome: record.outcome,
    install: {
      ok: install.ok,
      alreadyInstalled: install.ok ? install.alreadyInstalled === true : false,
      error: install.ok ? null : install.error,
      code: install.ok ? null : install.code,
    },
    activation: activation
      ? {
          ok: activation.ok === true,
          skipped: activation.skipped === true,
          stage: activation.stage ?? null,
          error: activation.error ?? null,
          code: activation.code ?? null,
        }
      : null,
    prune: prune ? { ok: prune.ok !== false && !prune.error, removed: prune.removed ?? [], error: prune.error ?? null } : null,
    health: record.health,
    rollback: record.rollback,
    active: status?.active
      ? { releaseId: status.active.releaseId, commit: status.active.commit, buildId: status.active.buildId }
      : null,
    previous: status?.previous?.id ?? null,
    record,
  };
}

/** CLI entry: request JSON on stdin, one JSON result on stdout. */
export async function ciDeployMain(argv = process.argv.slice(2), { stdin = process.stdin } = {}) {
  const rootFlag = argv.find((arg) => arg.startsWith("--root="));
  const root = rootFlag ? rootFlag.slice("--root=".length) : releaseRoot();
  if (!root.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(root)) {
    throw new DeployError("--root must be an absolute path", "INVALID_ROOT");
  }

  const chunks = [];
  let bytes = 0;
  for await (const chunk of stdin) {
    bytes += chunk.length;
    if (bytes > MAX_REQUEST_BYTES) throw new DeployError("deployment request is too large", "INVALID_REQUEST");
    chunks.push(chunk);
  }

  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new DeployError("deployment request is not valid JSON", "INVALID_REQUEST");
  }

  return runCiDeploy({ root, request: parsed });
}

export { readRequestFile };
