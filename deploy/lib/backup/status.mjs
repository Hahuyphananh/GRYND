// deploy/lib/backup/status.mjs
//
// Read-only backup readiness for the Control Center.
//
// This module answers one question honestly: is there a backup we could
// actually recover from? It reads a local ledger and nothing else. It never
// connects to the database, never reads a credential, never runs a backup and
// never writes a file. If the ledger is absent, the answer is "no evidence",
// not "fine".
//
// The distinction the brief asks for — a backup that EXISTS versus one whose
// integrity and restore have been VERIFIED — is a single field, `verified`, and
// it is deliberately strict:
//
//   verified === true  only when a completed restore test records the SAME
//                      sha256 as the current newest backup, with zero row
//                      mismatches, against a NON-production target.
//
// A restore test of last week's dump does not verify today's. A restore into
// production is not a drill and does not count.
//
// The ledger is append-only JSONL at <root>/state/backup/ledger.jsonl, written
// by whatever runner is approved. Its record schema (see LEDGER_SCHEMA below) is
// the contract; this module only reads it.

import fs from "node:fs/promises";
import path from "node:path";

import { isInside } from "../layout.mjs";
import { redactString } from "../ops/redact.mjs";

/**
 * Record shapes the ledger may contain. Unknown events are ignored rather than
 * failing the page, so a future runner can add records without breaking status.
 *
 *   { "event": "backup.completed", "at": ISO, "id": string, "bytes": number,
 *     "sha256": string, "destination": { "id": string, "kind": string },
 *     "durationMs": number }
 *   { "event": "backup.failed",    "at": ISO, "code": string, "message": string }
 *   { "event": "restore.verified", "at": ISO, "backupId": string, "sha256": string,
 *     "tablesChecked": number, "mismatches": number,
 *     "target": "scratch" | "branch" | "local" | "staging", "durationMs": number }
 *   { "event": "restore.failed",   "at": ISO, "backupId": string, "code": string,
 *     "message": string }
 *   { "event": "retention.applied","at": ISO, "deleted": number, "kept": number }
 */
export const LEDGER_SCHEMA = Object.freeze({
  "backup.completed": ["at", "id", "bytes", "sha256"],
  "backup.failed": ["at", "code"],
  "restore.verified": ["at", "backupId", "sha256", "mismatches", "target"],
  "restore.failed": ["at", "backupId", "code"],
  "retention.applied": ["at"],
});

/** Targets a restore test may use. Anything else is not a drill. */
export const SAFE_RESTORE_TARGETS = Object.freeze(["scratch", "branch", "local", "staging"]);

/** A page cannot be allowed to imply health it has not observed. */
export const DEFAULT_POLICY = Object.freeze({
  /** How often a backup is expected. Daily by default. */
  expectedCadenceHours: 24,
  /** Age beyond this is "stale": 1.5x the cadence, so one late run is not an alarm. */
  staleAfterHours: 36,
  /** A restore drill older than this stops counting as current evidence. */
  restoreTestStaleAfterDays: 90,
  /** Window the retention summary describes. */
  retentionDays: 30,
  /** Soft guard: a dump larger than this probably means something changed. */
  maxBytes: 2 * 1024 ** 3,
  /** Below this, a "successful" dump is suspiciously small. */
  minBytes: 1024,
});

/** Ledger location under an existing release layout. Never created here. */
export function backupPaths(releaseLayout) {
  const dir = path.join(releaseLayout.state, "backup");
  if (!isInside(releaseLayout.root, dir)) {
    throw new Error(`backup state directory escaped the release root: ${dir}`);
  }
  return { root: releaseLayout.root, dir, ledger: path.join(dir, "ledger.jsonl") };
}

function parseAt(value) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

/**
 * Read the ledger. Torn or malformed lines are skipped, not fatal: a half-written
 * line from a crashed runner must not take the status page down with it.
 */
export async function readBackupLedger({ paths, maxLines = 5_000 }) {
  let text;
  try {
    text = await fs.readFile(paths.ledger, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { records: [], skipped: 0, present: false };
    throw error;
  }

  const lines = text.split("\n").filter(Boolean);
  const tail = lines.slice(-maxLines);
  const records = [];
  let skipped = 0;

  for (const line of tail) {
    try {
      const record = JSON.parse(line);
      const required = LEDGER_SCHEMA[record?.event];
      if (!required) {
        skipped += 1;
        continue;
      }
      if (parseAt(record.at) === null) {
        skipped += 1;
        continue;
      }
      records.push(record);
    } catch {
      skipped += 1;
    }
  }

  records.sort((a, b) => parseAt(a.at) - parseAt(b.at));
  return { records, skipped, present: true };
}

export function humanBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return null;
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // Whole values read better without a decimal: "5 MiB", not "5.0 MiB".
  const rounded = Math.round(value * 10) / 10;
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return `${text} ${units[unit]}`;
}

function hoursBetween(fromMs, toMs) {
  return Math.round(((toMs - fromMs) / 3_600_000) * 10) / 10;
}

/**
 * Compose the status view from ledger records.
 *
 * Pure and synchronous so the thresholds can be tested without a clock, a
 * filesystem or a destination.
 *
 * @param {object} input
 * @param {object[]} input.records
 * @param {Date} [input.now]
 * @param {object} [input.policy]
 * @param {{ id: string, kind: string, check?: () => Promise<{ state: string, detail?: string }> } | null} [input.destination]
 * @param {{ state: string, detail?: string, checkedAt?: string } | null} [input.destinationProbe]
 */
export function buildBackupStatus({
  records = [],
  now = new Date(),
  policy = DEFAULT_POLICY,
  destination = null,
  destinationProbe = null,
  skipped = 0,
} = {}) {
  const nowMs = now.getTime();
  const warnings = [];
  const warn = (code, severity, message) => warnings.push({ code, severity, message });

  // Sort a copy: "newest" and gap detection are meaningless on an unordered
  // ledger, and a caller should not have to know that.
  const ordered = [...records].sort((a, b) => (parseAt(a.at) ?? 0) - (parseAt(b.at) ?? 0));

  const completed = ordered.filter((record) => record.event === "backup.completed");
  const failures = ordered.filter((record) => record.event === "backup.failed");
  const restores = ordered.filter((record) => record.event === "restore.verified" || record.event === "restore.failed");

  const newest = completed[completed.length - 1] ?? null;
  const newestFailure = failures[failures.length - 1] ?? null;
  const newestRestore = restores[restores.length - 1] ?? null;

  // ── last successful backup ──────────────────────────────────────────────
  const lastSuccess = newest
    ? {
        id: typeof newest.id === "string" ? newest.id : null,
        at: newest.at,
        bytes: Number.isFinite(newest.bytes) ? newest.bytes : null,
        sha256: typeof newest.sha256 === "string" ? newest.sha256 : null,
        destination: newest.destination
          ? { id: newest.destination.id ?? null, kind: newest.destination.kind ?? null }
          : null,
        durationMs: Number.isFinite(newest.durationMs) ? newest.durationMs : null,
      }
    : null;

  if (!lastSuccess) {
    warn("NO_SUCCESSFUL_BACKUP", "critical", "No successful backup has ever been recorded.");
  }

  const size = lastSuccess && lastSuccess.bytes !== null ? { bytes: lastSuccess.bytes, human: humanBytes(lastSuccess.bytes) } : null;

  let age = null;
  if (lastSuccess) {
    const hours = hoursBetween(Date.parse(lastSuccess.at), nowMs);
    age = { hours, stale: hours > policy.staleAfterHours, staleAfterHours: policy.staleAfterHours };
    if (age.stale) {
      warn(
        "STALE_BACKUP",
        "critical",
        `Newest backup is ${hours}h old; expected one every ${policy.expectedCadenceHours}h (stale after ${policy.staleAfterHours}h).`,
      );
    }
  }

  if (size && size.bytes !== null) {
    if (size.bytes === 0 || size.bytes < policy.minBytes) {
      warn("BACKUP_SUSPICIOUSLY_SMALL", "warning", `Newest backup is ${size.human ?? "0 B"}; an empty or truncated dump can restore to an empty schema.`);
    } else if (size.bytes > policy.maxBytes) {
      warn("BACKUP_UNUSUALLY_LARGE", "warning", `Newest backup is ${size.human}; larger than the ${humanBytes(policy.maxBytes)} guard.`);
    }
  }

  // ── last failed backup ──────────────────────────────────────────────────
  const lastFailure = newestFailure
    ? {
        at: newestFailure.at,
        code: typeof newestFailure.code === "string" ? newestFailure.code : "UNKNOWN",
        message: redactString(typeof newestFailure.message === "string" ? newestFailure.message : ""),
      }
    : null;

  if (lastFailure && (!lastSuccess || parseAt(lastFailure.at) > parseAt(lastSuccess.at))) {
    warn("LAST_BACKUP_FAILED", "critical", `The most recent backup attempt failed (${lastFailure.code}) after the last success.`);
  }

  // ── restore-drill evidence ──────────────────────────────────────────────
  let restoreTest = null;
  if (newestRestore) {
    const ok = newestRestore.event === "restore.verified";
    const target = typeof newestRestore.target === "string" ? newestRestore.target : null;
    const ageDays = Math.floor((nowMs - Date.parse(newestRestore.at)) / 86_400_000);
    restoreTest = {
      at: newestRestore.at,
      ok,
      backupId: typeof newestRestore.backupId === "string" ? newestRestore.backupId : null,
      sha256: typeof newestRestore.sha256 === "string" ? newestRestore.sha256 : null,
      tablesChecked: Number.isFinite(newestRestore.tablesChecked) ? newestRestore.tablesChecked : null,
      mismatches: Number.isFinite(newestRestore.mismatches) ? newestRestore.mismatches : null,
      target,
      ageDays,
      stale: ageDays > policy.restoreTestStaleAfterDays,
      code: typeof newestRestore.code === "string" ? newestRestore.code : null,
    };
  }

  // A restore test is evidence only for the exact artifact it restored, from a
  // non-production target, with no row mismatches.
  const targetIsSafe = restoreTest?.target ? SAFE_RESTORE_TARGETS.includes(restoreTest.target) : false;
  const verified = Boolean(
    restoreTest &&
      restoreTest.ok &&
      lastSuccess &&
      restoreTest.sha256 &&
      lastSuccess.sha256 &&
      restoreTest.sha256 === lastSuccess.sha256 &&
      (restoreTest.mismatches === null || restoreTest.mismatches === 0) &&
      targetIsSafe,
  );

  if (!restoreTest) {
    warn("NO_RESTORE_TEST", "warning", "No restore test has been recorded. An untested backup is a file, not a recovery plan.");
  } else if (!restoreTest.ok) {
    warn("RESTORE_TEST_FAILED", "critical", `The last restore test failed (${restoreTest.code ?? "unknown error"}).`);
  } else {
    if (restoreTest.target && !targetIsSafe) {
      warn(
        "RESTORE_TEST_ON_PRODUCTION",
        "critical",
        `The last restore test targeted "${restoreTest.target}", which is not an isolated target. It does not count as verification.`,
      );
    }
    if (restoreTest.stale) {
      warn("RESTORE_TEST_STALE", "warning", `The last restore test is ${restoreTest.ageDays} days old; drills are expected within ${policy.restoreTestStaleAfterDays} days.`);
    }
    if (!verified && targetIsSafe && lastSuccess) {
      warn(
        "RESTORE_TEST_NOT_CURRENT",
        "warning",
        "The last restore test verified a different backup than the newest one. The newest backup itself is unverified.",
      );
    }
    if (Number.isFinite(restoreTest.mismatches) && restoreTest.mismatches > 0) {
      warn("RESTORE_MISMATCH", "critical", `The last restore had ${restoreTest.mismatches} table(s) with row-count mismatches.`);
    }
  }

  // ── retention ───────────────────────────────────────────────────────────
  const windowStart = nowMs - policy.retentionDays * 86_400_000;
  const inWindow = completed.filter((record) => parseAt(record.at) >= windowStart);

  const gaps = [];
  for (let index = 1; index < inWindow.length; index += 1) {
    const previous = parseAt(inWindow[index - 1].at);
    const current = parseAt(inWindow[index].at);
    const deltaHours = (current - previous) / 3_600_000;
    if (deltaHours > policy.expectedCadenceHours * 1.5) {
      gaps.push({ afterAt: inWindow[index - 1].at, beforeAt: inWindow[index].at, hours: Math.round(deltaHours) });
    }
  }

  const retention = {
    windowDays: policy.retentionDays,
    backupsInWindow: inWindow.length,
    oldestAt: inWindow.length > 0 ? inWindow[0].at : null,
    newestAt: inWindow.length > 0 ? inWindow[inWindow.length - 1].at : null,
    gaps,
    // "Within policy" means a run exists for most of the window; a single
    // backup in a 30-day window is not retention, it is luck.
    withinPolicy: inWindow.length >= Math.floor(policy.retentionDays * 0.8),
  };

  if (inWindow.length > 0 && gaps.length > 0) {
    warn("RETENTION_GAP", "warning", `${gaps.length} gap(s) longer than the expected cadence in the last ${policy.retentionDays} days.`);
  }
  if (completed.length > 0 && !retention.withinPolicy) {
    warn(
      "RETENTION_BELOW_POLICY",
      "warning",
      `Only ${inWindow.length} backup(s) in the last ${policy.retentionDays} days; retention policy expects roughly daily runs.`,
    );
  }

  // ── destination ─────────────────────────────────────────────────────────
  let destinationState = { id: null, kind: "none", state: "not_configured", detail: null, checkedAt: null };

  if (destinationProbe) {
    destinationState = {
      id: destination?.id ?? null,
      kind: destination?.kind ?? "unknown",
      state: destinationProbe.state ?? "unknown",
      detail: redactString(destinationProbe.detail ?? "") || null,
      checkedAt: destinationProbe.checkedAt ?? now.toISOString(),
    };
  } else if (lastSuccess?.destination?.id) {
    destinationState = {
      id: lastSuccess.destination.id,
      kind: lastSuccess.destination.kind ?? "unknown",
      state: "unknown",
      detail: "Recorded from the last successful backup; not probed by this report.",
      checkedAt: null,
    };
  }

  if (destinationState.state === "not_configured") {
    warn("DESTINATION_NOT_CONFIGURED", "critical", "No off-VM backup destination is configured. A backup on the production VM is not a backup.");
  } else if (destinationState.state === "unreachable") {
    warn("DESTINATION_UNREACHABLE", "critical", `The backup destination did not respond${destinationState.detail ? `: ${destinationState.detail}` : "."}`);
  } else if (destinationState.state === "unknown") {
    warn("DESTINATION_HEALTH_UNKNOWN", "warning", "Destination health has not been verified by a probe.");
  }

  // The brief's rule, encoded: the only copy must not live on the VM.
  if (lastSuccess && !lastSuccess.destination) {
    warn("LOCAL_ONLY", "critical", "The newest backup records no destination, so it may exist only on this VM.");
  }

  const evidence = !lastSuccess && !restoreTest ? "none" : verified ? "restore-verified" : "metadata-only";
  const ok = !warnings.some((entry) => entry.severity === "critical");

  return {
    ok,
    evidence,
    verified,
    generatedAt: now.toISOString(),
    policy: { ...policy },
    destination: destinationState,
    lastSuccess,
    lastFailure,
    size,
    age,
    retention,
    restoreTest,
    warnings,
    ledger: { present: completed.length > 0 || failures.length > 0 || restores.length > 0, records: records.length, skipped },
    // Stated on every response so the page cannot imply more than was checked.
    disclosure:
      "Read-only. Backups are not created, restored or verified by this report. 'verified' is true only for a restore test of the newest backup into an isolated target with zero mismatches.",
  };
}

/**
 * Read the ledger and build the status. The only I/O is a read of one file.
 *
 * `destination.check()` is called only when an adapter is supplied; the default
 * is no adapter, so no network call is made and the page says so.
 */
export async function backupStatus({
  releaseLayout,
  now = new Date(),
  policy = DEFAULT_POLICY,
  destination = null,
} = {}) {
  const paths = backupPaths(releaseLayout);
  const { records, skipped, present } = await readBackupLedger({ paths });

  let destinationProbe = null;
  if (destination?.check) {
    try {
      const result = await destination.check();
      destinationProbe = {
        state: result?.state ?? "unknown",
        detail: result?.detail ?? null,
        checkedAt: result?.checkedAt ?? now.toISOString(),
      };
    } catch (error) {
      destinationProbe = {
        state: "unreachable",
        detail: redactString(error?.message ?? "destination check failed"),
        checkedAt: now.toISOString(),
      };
    }
  } else if (!present && !destination) {
    destinationProbe = { state: "not_configured", detail: null, checkedAt: now.toISOString() };
  }

  return buildBackupStatus({ records, skipped, now, policy, destination, destinationProbe });
}
