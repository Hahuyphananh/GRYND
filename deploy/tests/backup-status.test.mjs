/**
 * deploy/tests/backup-status.test.mjs — read-only backup readiness.
 *
 * These tests never touch a database. They build ledger fixtures in a temporary
 * directory and assert the status view, with particular attention to the two
 * claims that must never be conflated: a backup that exists, and a backup whose
 * restore has been verified.
 *
 * Run: node --test deploy/tests/backup-status.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { layout } from "../lib/layout.mjs";
import {
  DEFAULT_POLICY,
  SAFE_RESTORE_TARGETS,
  backupPaths,
  backupStatus,
  buildBackupStatus,
  humanBytes,
  readBackupLedger,
} from "../lib/backup/status.mjs";
import { findLeakedSecrets } from "../lib/ops/redact.mjs";

const NOW = new Date("2026-10-26T12:00:00.000Z");
const SHA = "a".repeat(64);
const OTHER_SHA = "b".repeat(64);

const GOOD_DESTINATION = { id: "grynd-backups", kind: "oci-object-storage" };

function completed(overrides = {}) {
  return {
    event: "backup.completed",
    at: "2026-10-26T11:00:00.000Z",
    id: "backup-2026-10-26",
    bytes: 5_242_880,
    sha256: SHA,
    destination: GOOD_DESTINATION,
    durationMs: 42_000,
    ...overrides,
  };
}

function restoreVerified(overrides = {}) {
  return {
    event: "restore.verified",
    at: "2026-10-26T11:30:00.000Z",
    backupId: "backup-2026-10-26",
    sha256: SHA,
    tablesChecked: 19,
    mismatches: 0,
    target: "scratch",
    ...overrides,
  };
}

function codes(status) {
  return status.warnings.map((warning) => warning.code);
}

function hasCritical(status) {
  return status.warnings.some((warning) => warning.severity === "critical");
}

async function makeRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "grynd-backup-"));
  const releaseLayout = layout(root);
  await fs.mkdir(releaseLayout.state, { recursive: true });
  return { root, releaseLayout, paths: backupPaths(releaseLayout) };
}

async function writeLedger(paths, records) {
  await fs.mkdir(path.dirname(paths.ledger), { recursive: true });
  await fs.writeFile(paths.ledger, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

// ── no evidence is reported as no evidence ────────────────────────────────

test("backup status: a missing ledger reports no evidence, not health", () => {
  const status = buildBackupStatus({ records: [], now: NOW });

  assert.equal(status.evidence, "none");
  assert.equal(status.verified, false);
  assert.equal(status.ok, false);
  assert.equal(status.lastSuccess, null);
  assert.equal(status.size, null);
  assert.equal(status.age, null);
  assert.ok(codes(status).includes("NO_SUCCESSFUL_BACKUP"));
  assert.ok(codes(status).includes("DESTINATION_NOT_CONFIGURED"));
  assert.ok(codes(status).includes("NO_RESTORE_TEST"));
});

test("backup status: an absent ledger file is not an error", async () => {
  const { releaseLayout } = await makeRoot();
  const status = await backupStatus({ releaseLayout, now: NOW });

  assert.equal(status.evidence, "none");
  assert.equal(status.destination.state, "not_configured");
  assert.equal(status.ledger.present, false);
});

// ── exists vs verified ────────────────────────────────────────────────────

test("backup status: a successful backup exists but is not verified without a restore test", () => {
  const status = buildBackupStatus({ records: [completed()], now: NOW });

  assert.equal(status.lastSuccess.id, "backup-2026-10-26");
  assert.equal(status.size.bytes, 5_242_880);
  assert.equal(status.size.human, "5 MiB");
  assert.equal(status.age.hours, 1);
  assert.equal(status.age.stale, false);

  assert.equal(status.verified, false, "existence must not be reported as verification");
  assert.equal(status.evidence, "metadata-only");
  assert.ok(codes(status).includes("NO_RESTORE_TEST"));
});

test("backup status: a restore test of the same artifact makes it verified", () => {
  const status = buildBackupStatus({ records: [completed(), restoreVerified()], now: NOW });

  assert.equal(status.verified, true);
  assert.equal(status.evidence, "restore-verified");
  assert.equal(status.ok, true, "no critical warnings in a verified, fresh, off-VM state");
  assert.equal(status.restoreTest.ok, true);
  assert.equal(status.restoreTest.tablesChecked, 19);
  assert.equal(status.restoreTest.mismatches, 0);
  assert.equal(hasCritical(status), false);
});

test("backup status: a restore test of a DIFFERENT backup does not verify the newest one", () => {
  const status = buildBackupStatus({
    records: [completed(), restoreVerified({ sha256: OTHER_SHA, backupId: "older" })],
    now: NOW,
  });

  assert.equal(status.verified, false);
  assert.ok(codes(status).includes("RESTORE_TEST_NOT_CURRENT"));
});

test("backup status: a restore into production is not a drill and does not count", () => {
  const status = buildBackupStatus({ records: [completed(), restoreVerified({ target: "production" })], now: NOW });

  assert.equal(status.verified, false);
  assert.ok(codes(status).includes("RESTORE_TEST_ON_PRODUCTION"));
  assert.equal(hasCritical(status), true);
  assert.ok(!SAFE_RESTORE_TARGETS.includes("production"));
});

test("backup status: mismatched row counts block verification", () => {
  const status = buildBackupStatus({ records: [completed(), restoreVerified({ mismatches: 3 })], now: NOW });

  assert.equal(status.verified, false);
  assert.ok(codes(status).includes("RESTORE_MISMATCH"));
});

test("backup status: a failed restore test is reported as failed", () => {
  const status = buildBackupStatus({
    records: [
      completed(),
      { event: "restore.failed", at: "2026-10-26T11:40:00.000Z", backupId: "backup-2026-10-26", code: "STATEMENT_FAILED" },
    ],
    now: NOW,
  });

  assert.equal(status.verified, false);
  assert.equal(status.restoreTest.ok, false);
  assert.equal(status.restoreTest.code, "STATEMENT_FAILED");
  assert.ok(codes(status).includes("RESTORE_TEST_FAILED"));
});

test("backup status: an old restore drill stops counting as current evidence", () => {
  const status = buildBackupStatus({
    records: [completed(), restoreVerified({ at: "2026-01-01T00:00:00.000Z" })],
    now: NOW,
  });

  assert.equal(status.verified, true, "the artifact was verified");
  assert.ok(codes(status).includes("RESTORE_TEST_STALE"));
  assert.equal(status.restoreTest.stale, true);
  assert.ok(status.restoreTest.ageDays > DEFAULT_POLICY.restoreTestStaleAfterDays);
});

// ── staleness, failure and retention ──────────────────────────────────────

test("backup status: a stale backup is critical", () => {
  const status = buildBackupStatus({ records: [completed({ at: "2026-10-23T00:00:00.000Z" })], now: NOW });

  assert.equal(status.age.stale, true);
  assert.ok(status.age.hours > DEFAULT_POLICY.staleAfterHours);
  assert.ok(codes(status).includes("STALE_BACKUP"));
  assert.equal(hasCritical(status), true);
});

test("backup status: a failure after the last success is critical", () => {
  const status = buildBackupStatus({
    records: [
      completed({ at: "2026-10-26T09:00:00.000Z" }),
      { event: "backup.failed", at: "2026-10-26T11:00:00.000Z", code: "UPLOAD_FAILED", message: "timeout" },
    ],
    now: NOW,
  });

  assert.equal(status.lastFailure.code, "UPLOAD_FAILED");
  assert.ok(codes(status).includes("LAST_BACKUP_FAILED"));
  assert.equal(hasCritical(status), true);
});

test("backup status: a failure before the last success is history, not an alarm", () => {
  const status = buildBackupStatus({
    records: [
      { event: "backup.failed", at: "2026-10-25T09:00:00.000Z", code: "UPLOAD_FAILED" },
      completed({ at: "2026-10-26T09:00:00.000Z" }),
    ],
    now: NOW,
  });

  assert.ok(status.lastFailure, "the failure is still shown");
  assert.ok(!codes(status).includes("LAST_BACKUP_FAILED"));
});

test("backup status: gaps longer than the cadence are surfaced", () => {
  const records = [
    completed({ at: "2026-10-26T09:00:00.000Z", id: "c" }),
    completed({ at: "2026-10-20T09:00:00.000Z", id: "b" }),
    completed({ at: "2026-10-19T09:00:00.000Z", id: "a" }),
  ];

  const status = buildBackupStatus({ records, now: NOW });

  assert.equal(status.retention.gaps.length, 1);
  assert.equal(status.retention.gaps[0].hours, 144);
  assert.ok(codes(status).includes("RETENTION_GAP"));
});

test("backup status: a single backup in a 30-day window is below policy", () => {
  const status = buildBackupStatus({ records: [completed()], now: NOW });

  assert.equal(status.retention.withinPolicy, false);
  assert.ok(codes(status).includes("RETENTION_BELOW_POLICY"));
});

test("backup status: an empty dump is flagged", () => {
  const status = buildBackupStatus({ records: [completed({ bytes: 0 })], now: NOW });
  assert.ok(codes(status).includes("BACKUP_SUSPICIOUSLY_SMALL"));
});

// ── destination ───────────────────────────────────────────────────────────

test("backup status: a backup with no destination is flagged as local-only", () => {
  const status = buildBackupStatus({ records: [completed({ destination: undefined })], now: NOW });

  assert.ok(codes(status).includes("LOCAL_ONLY"));
  assert.equal(hasCritical(status), true);
});

test("backup status: destination health comes from a probe when one is supplied", () => {
  const ok = buildBackupStatus({
    records: [completed()],
    now: NOW,
    destination: { id: "grynd-backups", kind: "oci-object-storage" },
    destinationProbe: { state: "ok", detail: "bucket reachable", checkedAt: NOW.toISOString() },
  });

  assert.equal(ok.destination.state, "ok");
  assert.ok(!codes(ok).includes("DESTINATION_UNREACHABLE"));

  const down = buildBackupStatus({
    records: [completed()],
    now: NOW,
    destination: { id: "grynd-backups", kind: "oci-object-storage" },
    destinationProbe: { state: "unreachable", detail: "403" },
  });

  assert.ok(codes(down).includes("DESTINATION_UNREACHABLE"));
  assert.equal(hasCritical(down), true);
});

test("backup status: a throwing probe is reported as unreachable, not swallowed", async () => {
  const { releaseLayout } = await makeRoot();
  const paths = backupPaths(releaseLayout);
  await writeLedger(paths, [completed()]);

  const status = await backupStatus({
    releaseLayout,
    now: NOW,
    destination: {
      id: "grynd-backups",
      kind: "oci-object-storage",
      check: async () => {
        throw new Error("network is unreachable");
      },
    },
  });

  assert.equal(status.destination.state, "unreachable");
  assert.match(status.destination.detail, /unreachable/);
});

// ── redaction and read-only behaviour ─────────────────────────────────────

test("backup status: a credential in a failure message is redacted", () => {
  const secret = "postgres://user:SUPERSECRET@db.example/grynd";
  const status = buildBackupStatus({
    records: [{ event: "backup.failed", at: "2026-10-26T11:00:00.000Z", code: "CONNECT_FAILED", message: `could not connect to ${secret}` }],
    now: NOW,
  });

  const serialized = JSON.stringify(status);
  assert.deepEqual(findLeakedSecrets(serialized, ["SUPERSECRET"]), []);
  assert.match(status.lastFailure.message, /\[redacted\]/);
});

test("backup status: reading status writes nothing", async () => {
  const { root, releaseLayout } = await makeRoot();
  const paths = backupPaths(releaseLayout);
  await writeLedger(paths, [completed(), restoreVerified()]);

  async function snapshot() {
    const found = [];
    async function walk(dir) {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        found.push(path.relative(root, full));
        if (entry.isDirectory()) await walk(full);
      }
    }
    await walk(root);
    return found.sort();
  }

  const before = await snapshot();
  await backupStatus({ releaseLayout, now: NOW });
  await backupStatus({ releaseLayout, now: NOW });
  const after = await snapshot();

  assert.deepEqual(after, before, "status must be read-only");
});

test("backup status: the ledger reader skips torn lines and unknown events", async () => {
  const { releaseLayout } = await makeRoot();
  const paths = backupPaths(releaseLayout);
  await fs.mkdir(path.dirname(paths.ledger), { recursive: true });
  await fs.writeFile(
    paths.ledger,
    [
      JSON.stringify(completed()),
      "{ this is not json",
      JSON.stringify({ event: "something.new", at: "2026-10-26T11:00:00.000Z" }),
      JSON.stringify({ event: "backup.completed", at: "not-a-date" }),
      JSON.stringify({ event: "backup.completed", at: "2026-10-26T11:30:00.000Z", id: "b2", bytes: 10, sha256: SHA }),
    ].join("\n"),
  );

  const { records, skipped } = await readBackupLedger({ paths });

  assert.equal(records.length, 2);
  assert.equal(skipped, 3);
  assert.equal(records[1].id, "b2");
});

test("backup status: byte sizes render usably", () => {
  assert.equal(humanBytes(0), "0 B");
  assert.equal(humanBytes(512), "512 B");
  assert.equal(humanBytes(1024), "1 KiB");
  assert.equal(humanBytes(5 * 1024 * 1024), "5 MiB");
  assert.equal(humanBytes(3 * 1024 ** 3), "3 GiB");
  assert.equal(humanBytes(1024 * 1024 * 1.5), "1.5 MiB");
  assert.equal(humanBytes(-1), null);
});

test("backup status: a custom policy changes the thresholds", () => {
  const status = buildBackupStatus({
    records: [completed({ at: "2026-10-26T06:00:00.000Z" })],
    now: NOW,
    policy: { ...DEFAULT_POLICY, staleAfterHours: 3 },
  });

  assert.equal(status.age.stale, true);
  assert.equal(status.policy.staleAfterHours, 3);
});
