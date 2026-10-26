// deploy/lib/ops/audit.mjs
//
// A tamper-EVIDENT operations audit. Every entry is hash-chained to the one
// before it, so removing, reordering or editing a line breaks the chain and
// `verifyAudit` says exactly where.
//
// What this buys, and what it does not:
//
//   it does     make silent modification detectable; make truncation of the
//               tail detectable once a later entry has chained past it
//   it does not prevent a writer with the file's permissions from replacing the
//               whole file with a freshly-mined chain (they hold the key-less
//               hash function, so nothing stops that)
//
// Prevention comes from POSIX ownership and mode (0700 dir, 0640 files, owned
// by the dashboard account, not writable by the app's account) and optionally
// from `chattr +a`, which needs root and is documented rather than assumed. The
// chain is the second half: it catches the case where someone had access.
//
// Retention is bounded by rotating whole segments: 10k entries per segment, two
// archives kept, so the file cannot grow without limit. Rotation is recorded by
// chain continuity — the first entry of a new segment chains from the last hash
// of the old one — not by a marker that could be forged.

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { DeployError } from "../layout.mjs";
import { readAudit as readReleaseAudit } from "../state.mjs";
import { auditArchivePath } from "./paths.mjs";
import { redact } from "./redact.mjs";

/** The `prevHash` of the first entry ever written. */
export const GENESIS_HASH = "0".repeat(64);

export const DEFAULT_MAX_ENTRIES = 10_000;
export const MAX_ARCHIVES = 2;

/**
 * Events the dashboard may append through the broker. Login and authorization
 * outcomes happen in the dashboard's own process, so it must be able to record
 * them — but only these three, with no privileged effect.
 */
export const INGESTIBLE_EVENTS = Object.freeze(["login.success", "login.failure", "auth.denied"]);

/** Events the runtime writes itself. Kept here so the vocabulary is one list. */
export const RUNTIME_EVENTS = Object.freeze([
  "ops.plan",
  "ops.denied",
  "service.action.start",
  "service.action.result",
  "config.read",
  "config.change.denied",
]);

const MAX_DETAIL_BYTES = 4_096;

/** Stable JSON so a hash does not depend on key insertion order. */
function canonical(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return "null";
}

function bodyOf(entry) {
  return {
    seq: entry.seq,
    at: entry.at,
    event: entry.event,
    actor: entry.actor,
    detail: entry.detail,
    prevHash: entry.prevHash,
  };
}

export function hashEntry(entry) {
  return crypto.createHash("sha256").update(canonical(bodyOf(entry))).digest("hex");
}

/**
 * A single-writer lock. Two concurrent broker process could otherwise both read
 * the same head and mint the same seq, forking the chain.
 */
async function withLock(lockPath, fn, { retries = 100, waitMs = 20, staleMs = 15_000 } = {}) {
  await fs.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < retries; attempt += 1) {
    let handle = null;
    try {
      handle = await fs.open(lockPath, "wx", 0o600);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        const stat = await fs.stat(lockPath);
        if (Date.now() - stat.mtimeMs > staleMs) {
          await fs.unlink(lockPath).catch(() => {});
          continue;
        }
      } catch {
        // The holder released it between the open and the stat; retry now.
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      continue;
    }
    try {
      return await fn();
    } finally {
      await handle.close().catch(() => {});
      await fs.unlink(lockPath).catch(() => {});
    }
  }
  throw new DeployError("Timed out waiting for the audit log lock", "AUDIT_LOCK_TIMEOUT");
}

async function readHead(paths) {
  try {
    const parsed = JSON.parse(await fs.readFile(paths.auditHead, "utf8"));
    if (
      parsed &&
      Number.isInteger(parsed.seq) &&
      parsed.seq >= 0 &&
      typeof parsed.hash === "string" &&
      /^[0-9a-f]{64}$/.test(parsed.hash)
    ) {
      return {
        seq: parsed.seq,
        hash: parsed.hash,
        at: typeof parsed.at === "string" ? parsed.at : null,
        entriesInSegment: Number.isInteger(parsed.entriesInSegment) ? parsed.entriesInSegment : 0,
      };
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      // A corrupt head is recoverable: derive it from the log instead.
    }
  }

  const entries = await readSegment(paths.auditLog);
  const last = entries[entries.length - 1];
  return last
    ? { seq: last.seq, hash: last.hash, at: last.at, entriesInSegment: entries.length }
    : { seq: 0, hash: GENESIS_HASH, at: null, entriesInSegment: 0 };
}

async function writeHead(paths, head) {
  const tmp = `${paths.auditHead}.tmp-${process.pid}`;
  await fs.writeFile(tmp, `${JSON.stringify(head, null, 2)}\n`, { mode: 0o640 });
  await fs.rename(tmp, paths.auditHead);
}

/** Parse one segment, dropping torn lines rather than failing the whole read. */
async function readSegment(file) {
  let text;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const entries = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line);
      if (entry && Number.isInteger(entry.seq) && typeof entry.event === "string") entries.push(entry);
    } catch {
      // A partially written line is skipped. verifyAudit reports the gap.
    }
  }
  return entries;
}

/** Every segment, ordered oldest-first by sequence. */
export async function readAllEntries(paths) {
  let names = [];
  try {
    names = await fs.readdir(paths.stateOps);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const archives = names
    .filter((name) => /^audit-.*\.jsonl$/.test(name))
    .sort()
    .map((name) => path.join(paths.stateOps, name));
  const segments = [paths.auditLog, ...archives].filter(Boolean);
  const all = [];
  for (const file of segments) all.push(...(await readSegment(file)));
  return all.sort((a, b) => a.seq - b.seq);
}

/**
 * Append one entry. `detail` is redacted before it is hashed, so a secret
 * cannot enter the log and then be "hidden" by a later filter.
 */
export async function appendAudit({
  paths,
  event,
  actor,
  detail = null,
  now = new Date(),
  maxEntries = DEFAULT_MAX_ENTRIES,
  maxArchives = MAX_ARCHIVES,
} = {}) {
  if (typeof event !== "string" || !/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/.test(event)) {
    throw new DeployError(`Invalid audit event name ${JSON.stringify(event)}`, "INVALID_AUDIT_EVENT");
  }
  if (typeof actor !== "string" || actor.trim().length === 0) {
    throw new DeployError("An audit entry needs an actor", "ACTOR_REQUIRED");
  }

  let safeDetail = redact(detail ?? null);
  if (Buffer.byteLength(JSON.stringify(safeDetail), "utf8") > MAX_DETAIL_BYTES) {
    safeDetail = { dropped: "detail exceeded the size limit" };
  }

  return withLock(paths.auditLock, async () => {
    await fs.mkdir(paths.stateOps, { recursive: true, mode: 0o700 });
    const head = await readHead(paths);
    const entry = {
      seq: head.seq + 1,
      at: now.toISOString(),
      event,
      actor,
      detail: safeDetail,
      prevHash: head.hash,
    };
    entry.hash = hashEntry(entry);

    await fs.appendFile(paths.auditLog, `${JSON.stringify(entry)}\n`, { mode: 0o640 });

    let entriesInSegment = head.entriesInSegment + 1;
    let nextHead = { seq: entry.seq, hash: entry.hash, at: entry.at, entriesInSegment };

    if (maxEntries > 0 && entriesInSegment >= maxEntries) {
      entriesInSegment = await rotate(paths, entry, maxArchives);
      nextHead = { ...nextHead, entriesInSegment };
    }

    await writeHead(paths, nextHead);
    return entry;
  });
}

/**
 * Move the current segment aside and start a new one. The new segment's first
 * entry chains from `lastEntry.hash` (via the head file), so the chain stays
 * continuous across the boundary.
 */
async function rotate(paths, lastEntry, maxArchives) {
  const stamp = (lastEntry.at || new Date().toISOString()).replace(/[:.]/g, "-");
  const archive = auditArchivePath(paths, stamp, lastEntry.seq);
  try {
    await fs.rename(paths.auditLog, archive);
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }

  // Keep only the newest `maxArchives`; retention is bounded on purpose.
  let names = [];
  try {
    names = await fs.readdir(paths.stateOps);
  } catch {
    return 0;
  }
  const archives = names.filter((name) => /^audit-.*\.jsonl$/.test(name)).sort();
  const excess = archives.slice(0, Math.max(0, archives.length - maxArchives));
  for (const name of excess) await fs.unlink(path.join(paths.stateOps, name)).catch(() => {});

  return 0;
}

/**
 * Recompute the chain. Returns the first broken link rather than a boolean, so
 * the report can say which entry and why.
 *
 * Retention prunes the oldest segments, so a log older than the retention window
 * cannot be verified back to genesis. That is stated rather than hidden: the
 * `pruned` flag and `firstSeq` say where verification starts, and the chain is
 * checked from there. Reporting `ok: false` on a legitimately trimmed log would
 * train an operator to ignore the alarm, which is worse than a bounded check.
 */
export async function verifyAudit({ paths } = {}) {
  const entries = await readAllEntries(paths);
  if (entries.length === 0) {
    return {
      ok: true,
      entries: 0,
      firstSeq: null,
      lastSeq: null,
      pruned: false,
      brokenAt: null,
      reason: null,
    };
  }

  const first = entries[0];
  const pruned = first.seq > 1;
  // On a pruned log, the oldest surviving entry's own prevHash is the anchor.
  let prevHash = pruned ? first.prevHash : GENESIS_HASH;
  let prevSeq = first.seq - 1;

  for (const entry of entries) {
    if (entry.seq !== prevSeq + 1) {
      return {
        ok: false,
        entries: entries.length,
        firstSeq: first.seq,
        lastSeq: entries[entries.length - 1].seq,
        pruned,
        brokenAt: entry.seq,
        reason: `sequence gap: expected ${prevSeq + 1}, found ${entry.seq}`,
      };
    }
    if (entry.prevHash !== prevHash) {
      return {
        ok: false,
        entries: entries.length,
        firstSeq: first.seq,
        lastSeq: entries[entries.length - 1].seq,
        pruned,
        brokenAt: entry.seq,
        reason: "prevHash does not match the preceding entry",
      };
    }
    const expected = hashEntry(entry);
    if (expected !== entry.hash) {
      return {
        ok: false,
        entries: entries.length,
        firstSeq: first.seq,
        lastSeq: entries[entries.length - 1].seq,
        pruned,
        brokenAt: entry.seq,
        reason: "entry hash does not match its content",
      };
    }
    prevHash = entry.hash;
    prevSeq = entry.seq;
  }

  return {
    ok: true,
    entries: entries.length,
    firstSeq: first.seq,
    lastSeq: entries[entries.length - 1].seq,
    pruned,
    brokenAt: null,
    reason: null,
  };
}

/**
 * The merged read view: operations audit plus the release tool's audit, newest
 * last. Read-only, and redacted again on the way out because the release log is
 * written by a different process with different guarantees.
 */
export async function listAudit({ paths, releaseLayout, limit = 50 } = {}) {
  const capped = Math.min(Math.max(Number(limit) || 50, 1), 500);
  const opsEntries = (await readAllEntries(paths)).slice(-capped).map((entry) => ({
    source: "ops",
    ...entry,
  }));

  const releaseEntries = releaseLayout
    ? (await readReleaseAudit(releaseLayout, { limit: capped })).map((entry) => ({
        source: "release",
        ...entry,
      }))
    : [];

  const merged = [...opsEntries, ...releaseEntries].sort((a, b) =>
    String(a.at ?? "").localeCompare(String(b.at ?? "")),
  );
  return merged.slice(-capped).map((entry) => redact(entry));
}

/** Append a dashboard-side auth outcome. Only the three whitelisted events. */
export async function appendIngestedEvent({ paths, event, actor, detail, now = new Date() }) {
  if (!INGESTIBLE_EVENTS.includes(event)) {
    throw new DeployError(
      `Event ${JSON.stringify(event)} may not be appended by the dashboard. Allowed: ${INGESTIBLE_EVENTS.join(", ")}`,
      "EVENT_NOT_INGESTIBLE",
      { event },
    );
  }
  return appendAudit({ paths, event, actor, detail, now });
}
