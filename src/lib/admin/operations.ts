// src/lib/admin/operations.ts
//
// Read-only reader for the deployment/operations state that lives on the host.
//
// This is the in-app mirror of the Control Center's read path. It reads ONLY
// `<root>/state/`:
//
//   state/active.json        the active release + the health results that let it in
//   state/deployments.json   GitHub deploy-job records (whitelisted on write)
//   state/audit.jsonl        release-tool audit (install, activation, revert, prune)
//   state/ops/audit.jsonl    operations audit (logins, service actions, refusals)
//   state/backup/ledger.jsonl backup + restore-test records
//
// It never reads `env/`, never opens a database connection and never executes
// anything. Every value that reaches a page is re-typed and bounded here, so a
// malformed or hostile file cannot inject markup or exhaust memory.
//
// The authoritative backup rules live in deploy/lib/backup/status.mjs; the
// summary below mirrors them. If those thresholds change, change both.

import fs from "node:fs/promises";
import path from "node:path";

export const DEFAULT_RELEASE_ROOT = "/home/ubuntu/grynd";

/** Hard caps: a state file is metadata, never a payload. */
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_LOG_BYTES = 4 * 1024 * 1024;
const MAX_LOG_ENTRIES = 200;
const MAX_DEPLOYMENTS = 25;

/** Backup thresholds, mirroring deploy/lib/backup/status.mjs. */
export const BACKUP_STALE_AFTER_HOURS = 36;
export const BACKUP_RESTORE_TEST_STALE_DAYS = 90;
const SAFE_RESTORE_TARGETS = new Set(["scratch", "branch", "local", "staging"]);

export type Severity = "critical" | "warning" | "info";

export type OpsWarning = { code: string; severity: Severity; message: string };

export type HealthCheck = {
  name: string;
  ok: boolean;
  status: number | null;
  error: string | null;
};

export type ActiveRelease = {
  releaseId: string | null;
  commit: string | null;
  shortCommit: string | null;
  buildId: string | null;
  activatedAt: string | null;
  actor: string | null;
  reason: string | null;
  previousReleaseId: string | null;
  health: { ok: boolean; attempts: number | null; checks: HealthCheck[] } | null;
};

export type DeploymentRecord = {
  runId: string | null;
  commit: string | null;
  shortCommit: string | null;
  releaseId: string | null;
  buildId: string | null;
  event: string | null;
  target: string | null;
  outcome: string | null;
  stage: string | null;
  reason: string | null;
  requestedBy: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  health: { ok: boolean } | null;
  rollback: { attempted: boolean; ok: boolean | null } | null;
};

export type AuditEntry = {
  at: string;
  source: "release" | "ops";
  event: string;
  actor: string | null;
  outcome: string | null;
  reason: string | null;
  detail: Record<string, string | number | boolean | null> | null;
};

export type BackupSummary = {
  present: boolean;
  lastSuccessAt: string | null;
  lastSuccessId: string | null;
  bytes: number | null;
  ageHours: number | null;
  stale: boolean;
  lastFailureAt: string | null;
  lastFailureCode: string | null;
  restoreTestAt: string | null;
  restoreTestOk: boolean | null;
  restoreTestTarget: string | null;
  restoreTestAgeDays: number | null;
  verified: boolean;
  destinationId: string | null;
  destinationKind: string | null;
};

export type OperationsSnapshot = {
  configured: boolean;
  root: string;
  reason: string | null;
  active: ActiveRelease | null;
  deployments: DeploymentRecord[];
  audit: AuditEntry[];
  backup: BackupSummary | null;
  warnings: OpsWarning[];
  generatedAt: string;
};

// ── primitives ────────────────────────────────────────────────────────────

/**
 * Resolve the release root. An absolute path is required so a relative value
 * cannot be used to walk somewhere unexpected.
 */
export function releaseRoot(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.GRYND_RELEASE_ROOT?.trim() || DEFAULT_RELEASE_ROOT;
  // `path.normalize`, not `path.resolve`: resolving a runtime value makes the
  // bundler trace the entire project (Turbopack warns about it), and we only
  // need a cleaned absolute path here.
  return path.isAbsolute(raw) ? path.normalize(raw) : DEFAULT_RELEASE_ROOT;
}

/** Fixed, root-relative state paths. No caller-supplied segment is ever joined. */
function stateFile(root: string, ...segments: string[]): string {
  const base = path.join(root, "state");
  const target = path.join(base, ...segments);
  const relative = path.relative(base, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("state path escaped the state directory");
  }
  return target;
}

/** Strip control characters and bound length; the only text sanitiser used. */
export function safeText(value: unknown, max = 200): string | null {
  if (typeof value !== "string") return null;
  const cleaned = Array.from(value, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return (code < 32 && code !== 9) || code === 127 ? " " : character;
  })
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
  return cleaned.length > 0 ? cleaned : null;
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function numOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function boolOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/**
 * Secrets must not survive a read. The writers already redact, but the release
 * audit is produced by a different tool, so this is the app's own net.
 */
const SECRET_KEY_RE =
  /(password|passwd|secret|token|api[-_]?key|private[-_]?key|credential|cookie|authorization|dsn|database[-_]?url|connection[-_]?string)/i;
const SECRET_VALUE_PATTERNS: Array<[RegExp, string]> = [
  [/\b(postgres(?:ql)?:\/\/)[^\s:@/]+:[^\s@/]*@/gi, "$1[redacted]@"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[redacted-jwt]"],
  [/\b(sk|rk)_(live|test)_[A-Za-z0-9]{6,}/g, "[redacted-key]"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*/g, "[redacted-private-key]"],
];

export function redactText(value: string): string {
  let out = value;
  for (const [pattern, replacement] of SECRET_VALUE_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/** Shallow, type-preserving redaction of an audit `details` object. */
function safeDetail(value: unknown): AuditEntry["detail"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>).slice(0, 20)) {
    if (SECRET_KEY_RE.test(key)) {
      out[key] = "[redacted]";
      continue;
    }
    if (typeof child === "string") out[key] = redactText(safeText(child, 200) ?? "");
    else if (typeof child === "number" || typeof child === "boolean") out[key] = child;
    else if (child === null) out[key] = null;
  }
  return Object.keys(out).length > 0 ? out : null;
}

async function readJson(file: string): Promise<{ value: unknown | null; reason: string | null }> {
  try {
    const stat = await fs.stat(file);
    if (stat.size > MAX_JSON_BYTES) return { value: null, reason: "file is larger than the expected size" };
    const text = await fs.readFile(file, "utf8");
    return { value: JSON.parse(text), reason: null };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { value: null, reason: code === "ENOENT" ? "not found" : code === "EACCES" ? "not readable" : "unreadable" };
  }
}

/**
 * Read the tail of a JSONL file. Oversized logs are read from the end so a
 * multi-megabyte audit trail cannot be loaded into memory by a page render.
 */
async function readJsonlTail(file: string, maxEntries = MAX_LOG_ENTRIES): Promise<unknown[]> {
  let text: string;
  try {
    const stat = await fs.stat(file);
    if (stat.size > MAX_LOG_BYTES) {
      const handle = await fs.open(file, "r");
      try {
        const length = Math.min(MAX_LOG_BYTES, stat.size);
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, stat.size - length);
        text = buffer.toString("utf8");
        // Drop the first (likely partial) line.
        text = text.slice(text.indexOf("\n") + 1);
      } finally {
        await handle.close();
      }
    } else {
      text = await fs.readFile(file, "utf8");
    }
  } catch {
    return [];
  }

  const lines = text.split("\n").filter(Boolean).slice(-maxEntries);
  const parsed: unknown[] = [];
  for (const line of lines) {
    try {
      parsed.push(JSON.parse(line));
    } catch {
      // A torn line is skipped; the page still renders.
    }
  }
  return parsed;
}

// ── normalisers ───────────────────────────────────────────────────────────

function normaliseChecks(value: unknown): HealthCheck[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 10).map((entry) => {
    const check = (entry ?? {}) as Record<string, unknown>;
    return {
      name: safeText(check.name, 40) ?? "check",
      ok: check.ok === true,
      status: numOrNull(check.status),
      error: safeText(check.error, 160),
    };
  });
}

function normaliseActive(value: unknown): ActiveRelease | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const health = (record.health ?? null) as Record<string, unknown> | null;

  const releaseId = safeText(record.releaseId, 80);
  const commit = safeText(record.commit, 40);
  if (!releaseId && !commit) return null;

  return {
    releaseId,
    commit,
    shortCommit: commit ? commit.slice(0, 7) : null,
    buildId: safeText(record.buildId, 120),
    activatedAt: isoOrNull(record.activatedAt),
    actor: safeText(record.actor, 100),
    reason: safeText(record.reason, 200),
    previousReleaseId: safeText(record.previousReleaseId, 80),
    health: health
      ? {
          ok: health.ok === true,
          attempts: numOrNull(health.attempts),
          checks: normaliseChecks(health.results ?? health.checks),
        }
      : null,
  };
}

function normaliseDeployment(value: unknown): DeploymentRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const commit = safeText(record.commit, 40);
  if (!commit) return null;

  const health = record.health as Record<string, unknown> | null;
  const rollback = record.rollback as Record<string, unknown> | null;

  return {
    runId: safeText(record.runId, 20),
    commit,
    shortCommit: commit.slice(0, 7),
    releaseId: safeText(record.releaseId, 80),
    buildId: safeText(record.buildId, 120),
    event: safeText(record.event, 40),
    target: safeText(record.target, 20),
    outcome: safeText(record.outcome, 40),
    stage: safeText(record.stage, 40),
    reason: safeText(record.reason, 200),
    requestedBy: safeText(record.requestedBy, 40),
    startedAt: isoOrNull(record.startedAt),
    finishedAt: isoOrNull(record.finishedAt),
    durationMs: numOrNull(record.durationMs),
    health: health ? { ok: health.ok === true } : null,
    rollback: rollback
      ? { attempted: rollback.attempted === true, ok: boolOrNull(rollback.ok) }
      : null,
  };
}

function normaliseAuditEntry(value: unknown, source: "release" | "ops"): AuditEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const at = isoOrNull(record.at);
  const event = safeText(record.event ?? record.action ?? record.outcome, 80);
  if (!at || !event) return null;

  return {
    at,
    source,
    event: redactText(event),
    actor: safeText(record.actor, 100),
    outcome: safeText(record.outcome, 40),
    reason: safeText(record.reason, 200),
    detail: safeDetail(record.detail ?? record.details),
  };
}

function normaliseBackup(records: unknown[]): BackupSummary | null {
  if (records.length === 0) return null;

  const completed = records.filter(
    (record) => (record as Record<string, unknown>)?.event === "backup.completed",
  ) as Record<string, unknown>[];
  const failed = records.filter(
    (record) => (record as Record<string, unknown>)?.event === "backup.failed",
  ) as Record<string, unknown>[];
  const restores = records.filter((record) => {
    const event = (record as Record<string, unknown>)?.event;
    return event === "restore.verified" || event === "restore.failed";
  }) as Record<string, unknown>[];

  const sorted = (list: Record<string, unknown>[]) =>
    [...list].sort((a, b) => (Date.parse(String(a.at)) || 0) - (Date.parse(String(b.at)) || 0));

  const newest = sorted(completed).at(-1) ?? null;
  const newestFailure = sorted(failed).at(-1) ?? null;
  const newestRestore = sorted(restores).at(-1) ?? null;

  const lastSuccessAt = newest ? isoOrNull(newest.at) : null;
  const ageHours = lastSuccessAt
    ? Math.round(((Date.now() - Date.parse(lastSuccessAt)) / 3_600_000) * 10) / 10
    : null;

  const restoreOk = newestRestore ? newestRestore.event === "restore.verified" : null;
  const restoreTarget = newestRestore ? safeText(newestRestore.target, 20) : null;
  const restoreSha = newestRestore ? safeText(newestRestore.sha256, 64) : null;
  const successSha = newest ? safeText(newest.sha256, 64) : null;
  const mismatches = newestRestore ? numOrNull(newestRestore.mismatches) : null;

  const verified = Boolean(
    restoreOk === true &&
      restoreSha &&
      successSha &&
      restoreSha === successSha &&
      (mismatches === null || mismatches === 0) &&
      restoreTarget &&
      SAFE_RESTORE_TARGETS.has(restoreTarget),
  );

  return {
    present: true,
    lastSuccessAt,
    lastSuccessId: newest ? safeText(newest.id, 80) : null,
    bytes: newest ? numOrNull(newest.bytes) : null,
    ageHours,
    stale: ageHours !== null && ageHours > BACKUP_STALE_AFTER_HOURS,
    lastFailureAt: newestFailure ? isoOrNull(newestFailure.at) : null,
    lastFailureCode: newestFailure ? safeText(newestFailure.code, 60) : null,
    restoreTestAt: newestRestore ? isoOrNull(newestRestore.at) : null,
    restoreTestOk: restoreOk,
    restoreTestTarget: restoreTarget,
    restoreTestAgeDays: newestRestore?.at
      ? Math.floor((Date.now() - Date.parse(String(newestRestore.at))) / 86_400_000)
      : null,
    verified,
    destinationId: newest
      ? safeText((newest.destination as Record<string, unknown> | undefined)?.id, 100)
      : null,
    destinationKind: newest
      ? safeText((newest.destination as Record<string, unknown> | undefined)?.kind, 40)
      : null,
  };
}

// ── the snapshot ──────────────────────────────────────────────────────────

export function formatBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return "unknown";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = Math.round(value * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)} ${units[unit]}`;
}

/**
 * Build the operations snapshot. Never throws: every failure becomes a reason
 * plus a warning, so an unreadable host renders an explanatory page rather than
 * a 500.
 */
export async function getOperationsSnapshot(
  { env = process.env, now = Date.now() }: { env?: NodeJS.ProcessEnv; now?: number } = {},
): Promise<OperationsSnapshot> {
  const root = releaseRoot(env);
  const warnings: OpsWarning[] = [];
  const generatedAt = new Date(now).toISOString();

  const stateDir = path.join(root, "state");
  try {
    await fs.access(stateDir);
  } catch {
    return {
      configured: false,
      root,
      reason: `No operations state at ${stateDir}. The release tooling has not been installed on this host, or this process cannot read it.`,
      active: null,
      deployments: [],
      audit: [],
      backup: null,
      warnings: [
        {
          code: "STATE_UNAVAILABLE",
          severity: "critical",
          message: "Deployment, audit and backup state is not readable from the application host.",
        },
      ],
      generatedAt,
    };
  }

  const [activeRaw, deploymentsRaw, releaseAuditRaw, opsAuditRaw, backupRaw] = await Promise.all([
    readJson(stateFile(root, "active.json")),
    readJson(stateFile(root, "deployments.json")),
    readJsonlTail(stateFile(root, "audit.jsonl")),
    readJsonlTail(stateFile(root, "ops", "audit.jsonl")),
    readJsonlTail(stateFile(root, "backup", "ledger.jsonl"), 500),
  ]);

  const active = normaliseActive(activeRaw.value);

  const deploymentsValue = deploymentsRaw.value as Record<string, unknown> | null;
  const deploymentRecords = Array.isArray(deploymentsValue?.records) ? deploymentsValue.records : [];
  const deployments = deploymentRecords
    .slice(0, MAX_DEPLOYMENTS)
    .map(normaliseDeployment)
    .filter((record): record is DeploymentRecord => record !== null);

  const audit = [
    ...releaseAuditRaw.map((entry) => normaliseAuditEntry(entry, "release")),
    ...opsAuditRaw.map((entry) => normaliseAuditEntry(entry, "ops")),
  ]
    .filter((entry): entry is AuditEntry => entry !== null)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .slice(-MAX_LOG_ENTRIES);

  const backup = normaliseBackup(backupRaw);

  if (!active) {
    warnings.push({
      code: "NO_ACTIVE_RELEASE",
      severity: "warning",
      message: "No active release is recorded. The app may be running from a checkout rather than a versioned release.",
    });
  }
  if (active && active.health && active.health.ok !== true) {
    warnings.push({
      code: "ACTIVE_RELEASE_UNHEALTHY",
      severity: "critical",
      message: "The active release last recorded a failed health gate.",
    });
  }
  if (deployments.length === 0) {
    warnings.push({
      code: "NO_DEPLOYMENT_RECORDS",
      severity: "info",
      message: "No deploy-job records are present. Runs that stopped before the deploy job appear in GitHub, not here.",
    });
  }
  if (!backup) {
    warnings.push({
      code: "NO_BACKUP_RECORDS",
      severity: "critical",
      message: "No backup has ever been recorded on this host.",
    });
  } else {
    if (!backup.lastSuccessAt) {
      warnings.push({ code: "NO_SUCCESSFUL_BACKUP", severity: "critical", message: "No successful backup is recorded." });
    }
    if (backup.stale) {
      warnings.push({
        code: "STALE_BACKUP",
        severity: "critical",
        message: `The newest backup is ${backup.ageHours}h old (stale after ${BACKUP_STALE_AFTER_HOURS}h).`,
      });
    }
    if (backup.lastFailureAt && (!backup.lastSuccessAt || backup.lastFailureAt > backup.lastSuccessAt)) {
      warnings.push({
        code: "LAST_BACKUP_FAILED",
        severity: "critical",
        message: `The most recent backup attempt failed (${backup.lastFailureCode ?? "unknown"}).`,
      });
    }
    if (!backup.restoreTestAt) {
      warnings.push({
        code: "NO_RESTORE_TEST",
        severity: "warning",
        message: "No restore test has been recorded. An untested backup is a file, not a recovery plan.",
      });
    } else if (backup.restoreTestOk !== true) {
      warnings.push({ code: "RESTORE_TEST_FAILED", severity: "critical", message: "The last restore test failed." });
    } else if (!backup.verified) {
      warnings.push({
        code: "RESTORE_TEST_NOT_CURRENT",
        severity: "warning",
        message: "The last restore test verified a different backup than the newest one.",
      });
    }
    if ((backup.restoreTestAgeDays ?? 0) > BACKUP_RESTORE_TEST_STALE_DAYS) {
      warnings.push({
        code: "RESTORE_TEST_STALE",
        severity: "warning",
        message: `The last restore test is ${backup.restoreTestAgeDays} days old.`,
      });
    }
    if (!backup.destinationId) {
      warnings.push({
        code: "LOCAL_ONLY",
        severity: "critical",
        message: "The newest backup records no destination, so it may exist only on this host.",
      });
    }
  }

  return {
    configured: true,
    root,
    reason: null,
    active,
    deployments,
    audit,
    backup,
    warnings,
    generatedAt,
  };
}
