// deploy/lib/state.mjs
//
// The record of what is deployed, what is known good, and what happened.
//
//   state/active.json    the active release + the health results that let it in
//   state/verified.json  release ids that passed the health gate at least once
//   state/audit.jsonl    append-only history: install, activation, revert, prune
//
// Nothing written here may contain an environment VALUE. Env files are only
// ever stat()'d (see envReport), never read.

import fs from "node:fs/promises";
import path from "node:path";

import { DeployError, isInside } from "./layout.mjs";

async function ensureDir(dir, mode = 0o755) {
  await fs.mkdir(dir, { recursive: true, mode });
}

/** Create the layout skeleton. Idempotent; never touches existing content. */
export async function ensureLayout(layout) {
  await Promise.all([
    ensureDir(layout.releases),
    ensureDir(layout.incoming),
    ensureDir(layout.state),
    ensureDir(layout.shared),
    ensureDir(layout.env, 0o750),
  ]);
}

async function readJsonOrNull(file) {
  let text;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch {
    // A truncated state file must be recoverable: the pointers on disk are the
    // source of truth, this file is a description of them.
    return null;
  }
}

async function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o644 });
  await fs.rename(tmp, file);
}

/** The active-release record, or null before the first activation. */
export async function readActive(layout) {
  return readJsonOrNull(layout.activeState);
}

export async function writeActive(layout, record) {
  await writeJsonAtomic(layout.activeState, record);
}

/** Release ids that have passed the health gate on this host. */
export async function readVerified(layout) {
  const value = await readJsonOrNull(layout.verifiedState);
  const ids = Array.isArray(value?.ids) ? value.ids : [];
  return new Set(ids.filter((id) => typeof id === "string"));
}

export async function markVerified(layout, id) {
  const ids = await readVerified(layout);
  if (!ids.has(id)) {
    ids.add(id);
    await writeJsonAtomic(layout.verifiedState, { ids: [...ids].sort() });
  }
  return ids;
}

export async function unmarkVerified(layout, id) {
  const ids = await readVerified(layout);
  if (ids.delete(id)) await writeJsonAtomic(layout.verifiedState, { ids: [...ids].sort() });
  return ids;
}

/**
 * Append one audit record. Append-only (O_APPEND on POSIX) so concurrent
 * attempts cannot rewrite history; each line is a complete JSON object.
 */
export async function appendAudit(layout, record) {
  const entry = { at: new Date().toISOString(), ...record };
  await fs.appendFile(layout.auditLog, `${JSON.stringify(entry)}\n`, { mode: 0o640 });
  return entry;
}

export async function readAudit(layout, { limit = 50 } = {}) {
  let text;
  try {
    text = await fs.readFile(layout.auditLog, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const lines = text.split("\n").filter(Boolean);
  const tail = limit > 0 ? lines.slice(-limit) : lines;
  return tail.flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

/**
 * Report the managed environment files WITHOUT reading them. Enough to prove
 * the file exists, is not world-readable and is not accidentally inside a
 * release; never enough to leak a secret.
 */
export async function envReport(layout, { platform = process.platform } = {}) {
  const files = [
    { name: "app.env", file: layout.appEnv },
    { name: "realtime.env", file: layout.realtimeEnv },
  ];

  const results = [];
  for (const { name, file } of files) {
    let stat;
    try {
      stat = await fs.stat(file);
    } catch (error) {
      results.push({ name, path: file, present: false, reason: error.code });
      continue;
    }
    const mode = platform === "win32" ? null : `0${(stat.mode & 0o777).toString(8)}`;
    const modeOk = platform === "win32" ? true : (stat.mode & 0o077) === 0; // no group/other access
    const insideRelease = isInside(layout.releases, file);
    results.push({
      name,
      path: file,
      present: true,
      bytes: stat.size,
      mode,
      modeOk,
      insideRelease,
      ok: stat.size > 0 && modeOk && !insideRelease,
    });
  }
  return results;
}

/** Fail activation if the environment files are missing, readable, or misplaced. */
export async function assertEnvironmentReady(layout) {
  const report = await envReport(layout);
  const problems = [];
  for (const entry of report) {
    if (!entry.present) problems.push(`${entry.name} is missing (${entry.path})`);
    else if (entry.bytes === 0) problems.push(`${entry.name} is empty`);
    else if (!entry.modeOk) problems.push(`${entry.name} has mode ${entry.mode}; expected 0600`);
    else if (entry.insideRelease) problems.push(`${entry.name} must not live inside releases/`);
  }
  if (problems.length > 0) {
    throw new DeployError(`Environment is not ready: ${problems.join("; ")}`, "ENV_NOT_READY", { report });
  }
  return report;
}

/** Directory listing of installed releases, newest last. */
export async function listReleaseDirs(layout) {
  let entries;
  try {
    entries = await fs.readdir(layout.releases, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => ({ id: entry.name, dir: path.join(layout.releases, entry.name) }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
