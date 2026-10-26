// deploy/lib/workflow-records.mjs
//
// The deployment record written by GitHub Actions. It is deliberately a
// WHITELIST: only the fields below survive. A token, an SSH key, a host name or
// any other value the workflow might accidentally carry is dropped before it can
// reach the dashboard.
//
//   <root>/state/deployments.json   { schema: 1, records: [ newest … oldest ] }
//
// The file is appended on the host by the deploy job, not fetched from GitHub by
// the dashboard. That keeps GitHub credentials out of the dashboard entirely.

import fs from "node:fs/promises";
import path from "node:path";

import { DeployError, assertReleaseId, isInside } from "./layout.mjs";

export const DEPLOYMENT_SCHEMA = 1;
export const MAX_DEPLOYMENT_RECORDS = 50;
export const MAX_RECORD_BYTES = 256 * 1024;

const COMMIT_RE = /^[0-9a-f]{40}$/;
const BUILD_ID_RE = /^[A-Za-z0-9_-]{1,120}$/;
const RUN_ID_RE = /^[0-9]{1,20}$/;
const HASH_RE = /^sha256:[0-9a-f]{64}$/;
const LOGIN_RE = /^[A-Za-z0-9-]{1,39}$/;
const OUTCOMES = new Set(["activated", "skipped", "failed", "install-failed"]);
const EVENTS = new Set(["push", "workflow_dispatch"]);
const TARGETS = new Set(["production", "staging"]);
const STAGES = new Set(["health", "service-restart", "pointer-swap", "install", "refused", "unknown"]);
const MAX_TEXT = 200;
const MAX_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Strip control characters and bound a value; null when it carries no text. */
export function safeText(value, max = MAX_TEXT) {
  if (typeof value !== "string") return null;
  const cleaned = Array.from(value, (character) => {
    const code = character.codePointAt(0);
    return (code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127 ? " " : character;
  })
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
  return cleaned.length > 0 ? cleaned : null;
}

function isoOrNull(value) {
  if (typeof value !== "string") return null;
  const time = Date.parse(value);
  if (Number.isNaN(time)) return null;
  return new Date(time).toISOString();
}

function intOrNull(value, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  if (rounded < min || rounded > max) return null;
  return rounded;
}

function enumOrNull(value, allowed) {
  return typeof value === "string" && allowed.has(value) ? value : null;
}

function commitOrNull(value) {
  return typeof value === "string" && COMMIT_RE.test(value) ? value : null;
}

function releaseIdOrNull(value) {
  if (typeof value !== "string") return null;
  try {
    return assertReleaseId(value);
  } catch {
    return null;
  }
}

function checksOrEmpty(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 12).flatMap((entry) => {
    if (!isObject(entry)) return [];
    const name = safeText(entry.name, 40);
    if (!name) return [];
    return [
      {
        name,
        ok: entry.ok === true,
        status: intOrNull(entry.status, { min: 0, max: 599 }),
        ms: intOrNull(entry.ms, { min: 0, max: 600_000 }),
        error: safeText(entry.error, 160),
      },
    ];
  });
}

function healthOrNull(value) {
  if (!isObject(value)) return null;
  return { ok: value.ok === true, checks: checksOrEmpty(value.checks) };
}

function rollbackOrNull(value) {
  if (!isObject(value)) return null;
  return {
    attempted: value.attempted === true,
    target: releaseIdOrNull(value.target),
    ok: typeof value.ok === "boolean" ? value.ok : null,
    error: safeText(value.error, 160),
  };
}

/** The only shape that can be persisted or displayed. */
export function sanitizeDeploymentRecord(input) {
  if (!isObject(input)) throw new DeployError("deployment record is not an object", "INVALID_RECORD");

  const commit = commitOrNull(input.commit);
  if (!commit) throw new DeployError("deployment record has no valid commit", "INVALID_RECORD");

  const runId = typeof input.runId === "string" && RUN_ID_RE.test(input.runId) ? input.runId : null;
  if (!runId) throw new DeployError("deployment record has no valid run id", "INVALID_RECORD");

  const outcome = enumOrNull(input.outcome, OUTCOMES);
  if (!outcome) throw new DeployError("deployment record has no valid outcome", "INVALID_RECORD");

  return {
    schema: DEPLOYMENT_SCHEMA,
    runId,
    runAttempt: intOrNull(input.runAttempt, { min: 1, max: 1000 }),
    workflow: safeText(input.workflow, 80) ?? "release.yml",
    event: enumOrNull(input.event, EVENTS) ?? "workflow_dispatch",
    target: enumOrNull(input.target, TARGETS) ?? "production",
    commit,
    shortCommit: commit.slice(0, 7),
    releaseId: releaseIdOrNull(input.releaseId),
    buildId: typeof input.buildId === "string" && BUILD_ID_RE.test(input.buildId) ? input.buildId : null,
    builtAt: isoOrNull(input.builtAt),
    startedAt: isoOrNull(input.startedAt),
    finishedAt: isoOrNull(input.finishedAt),
    durationMs: intOrNull(input.durationMs, { min: 0, max: MAX_DURATION_MS }),
    requestedBy: typeof input.requestedBy === "string" && LOGIN_RE.test(input.requestedBy) ? input.requestedBy : null,
    reason: safeText(input.reason),
    outcome,
    stage: enumOrNull(input.stage, STAGES),
    skipReason: safeText(input.skipReason),
    artifactHash:
      typeof input.artifactHash === "string" && HASH_RE.test(input.artifactHash) ? input.artifactHash : null,
    health: healthOrNull(input.health),
    rollback: rollbackOrNull(input.rollback),
  };
}

/**
 * Build a record from the results of a deployment attempt.
 *
 * `install` / `activation` are the values returned (or thrown) by the release
 * library; `status` is the host status report used as a fallback for health.
 */
export function createDeploymentRecord({
  request = {},
  install = null,
  activation = null,
  skipReason = null,
  startedAt = null,
  finishedAt = new Date().toISOString(),
} = {}) {
  const commit = commitOrNull(request.commit);
  if (!commit) throw new DeployError("cannot record a deployment without a valid commit", "INVALID_RECORD");

  const start = isoOrNull(startedAt) ?? isoOrNull(request.startedAt);
  const end = isoOrNull(finishedAt) ?? new Date().toISOString();
  const durationMs = start ? Math.max(0, Date.parse(end) - Date.parse(start)) : null;

  const installed = install?.ok === true;
  const activated = installed && activation?.ok === true;
  const skippedByActivation = activated && activation?.skipped === true;

  let outcome = "failed";
  if (skipReason) outcome = "skipped";
  else if (!installed) outcome = "install-failed";
  else if (skippedByActivation) outcome = "skipped";
  else if (activated) outcome = "activated";

  const revert = activation?.revert ?? null;
  const rollback = revert
    ? {
        attempted: true,
        target: revert.target ?? null,
        ok: !revert.error && revert.health?.ok === true,
        error: revert.error ?? null,
      }
    : null;

  const health = activation?.health ?? activation?.active?.health ?? null;

  return sanitizeDeploymentRecord({
    runId: request.runId,
    runAttempt: request.runAttempt,
    workflow: request.workflow,
    event: request.event,
    target: request.target,
    commit,
    releaseId: request.releaseId,
    buildId: request.buildId,
    builtAt: request.builtAt,
    startedAt: start,
    finishedAt: end,
    durationMs,
    requestedBy: request.requestedBy,
    reason: request.reason,
    outcome,
    stage: activation?.stage ?? (installed ? null : "install"),
    skipReason: skipReason ?? (skippedByActivation ? "already active" : null),
    artifactHash: request.artifactHash,
    health,
    rollback,
  });
}

function deploymentsFile(layout) {
  return layout.deploymentsState ?? path.join(layout.state, "deployments.json");
}

/** Read the record file; a missing or malformed file is an empty history. */
export async function readDeploymentRecords(layout, { limit = MAX_DEPLOYMENT_RECORDS } = {}) {
  let text;
  try {
    text = await fs.readFile(deploymentsFile(layout), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { records: [], error: null };
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { records: [], error: "state/deployments.json is not valid JSON" };
  }
  if (!isObject(parsed) || !Array.isArray(parsed.records)) {
    return { records: [], error: "state/deployments.json has an unexpected shape" };
  }

  const records = [];
  for (const candidate of parsed.records.slice(0, Math.max(1, limit))) {
    try {
      records.push(sanitizeDeploymentRecord(candidate));
    } catch {
      // A single malformed record must not hide the rest of the history.
    }
  }
  return { records, error: null };
}

/** Insert/replace one record and keep the newest `MAX_DEPLOYMENT_RECORDS`. */
export async function appendDeploymentRecord(layout, record) {
  const safe = sanitizeDeploymentRecord(record);
  const existing = await readDeploymentRecords(layout, { limit: MAX_DEPLOYMENT_RECORDS });
  const withoutSameRun = existing.records.filter(
    (entry) => !(entry.runId === safe.runId && entry.commit === safe.commit),
  );
  const records = [safe, ...withoutSameRun].slice(0, MAX_DEPLOYMENT_RECORDS);

  const file = deploymentsFile(layout);
  if (!isInside(layout.state, file)) {
    throw new DeployError("deployment record path escapes state/", "INVALID_ROOT");
  }
  await fs.mkdir(layout.state, { recursive: true, mode: 0o755 });
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`;
  await fs.writeFile(tmp, `${JSON.stringify({ schema: DEPLOYMENT_SCHEMA, records }, null, 2)}\n`, {
    mode: 0o640,
  });
  await fs.rename(tmp, file);

  return { ok: true, added: records.length > 0 && records[0].runId === safe.runId, total: records.length, records };
}
