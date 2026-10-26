// deploy/lib/install.mjs
//
// Moving a verified artifact into place, retention, and the status report.
//
// Installs are `rename(2)` from incoming/ into releases/: same filesystem, so
// the release appears whole or not at all, and an existing release id is never
// overwritten (a rebuild of the same commit must produce a new id).

import fs from "node:fs/promises";

import { DeployError, assertReleaseId, layout as makeLayout, releaseRoot } from "./layout.mjs";
import { inspectRelease } from "./inspect.mjs";
import { readPointer } from "./pointer.mjs";
import { appendAudit, ensureLayout, envReport, listReleaseDirs, readActive, readAudit, readVerified, unmarkVerified } from "./state.mjs";
import { readManifest } from "./manifest.mjs";

async function exists(target) {
  try {
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Verify `<root>/incoming/<id>` and move it to `<root>/releases/<id>`.
 */
export async function installRelease({
  root = releaseRoot(),
  id,
  actor = "unknown",
  arch = process.arch,
  node = process.versions.node,
} = {}) {
  assertReleaseId(id);
  const l = makeLayout(root);
  await ensureLayout(l);

  const incoming = l.incomingDir(id);
  const target = l.releaseDir(id);

  // Never overwrite: an existing release directory is immutable by contract.
  // Checked before the upload, so a repeated install reports the real reason.
  if (await exists(target)) {
    await appendAudit(l, { event: "install", releaseId: id, actor, outcome: "rejected", rejection: "release id already installed" });
    throw new DeployError(`Release ${id} is already installed; releases are immutable`, "ALREADY_INSTALLED", { id });
  }

  if (!(await exists(incoming))) {
    throw new DeployError(
      `No uploaded release at ${incoming}. Upload the artifact there first (the workflow rsyncs incoming/<id>/).`,
      "NOT_UPLOADED",
      { id },
    );
  }

  const report = await inspectRelease(incoming, { id, arch, node });
  if (!report.ok) {
    await appendAudit(l, {
      event: "install",
      releaseId: id,
      actor,
      outcome: "rejected",
      rejection: "verification failed",
      errors: report.errors,
    });
    throw new DeployError(`Uploaded artifact failed verification:\n  - ${report.errors.join("\n  - ")}`, "RELEASE_UNUSABLE", {
      id,
      errors: report.errors,
    });
  }

  await fs.rename(incoming, target);

  const audit = await appendAudit(l, {
    event: "install",
    releaseId: id,
    actor,
    outcome: "ok",
    commit: report.manifest.commit,
    buildId: report.buildId,
    realtimeHash: report.realtimeHash,
    arch: report.manifest.builder?.arch ?? null,
    node: report.manifest.builder?.node ?? null,
  });

  return { ok: true, id, dir: target, manifest: report.manifest, buildId: report.buildId, audit };
}

/**
 * Delete old releases. The active release, the previous release and anything
 * the pointer still resolves to are never touched, and at least `keep`
 * releases are retained.
 */
export async function pruneReleases({ root = releaseRoot(), keep = 3, actor = "unknown", dryRun = false } = {}) {
  const l = makeLayout(root);
  await ensureLayout(l);
  const releases = await listReleaseDirs(l);
  const active = await readActive(l).catch(() => null);
  const current = await readPointer(root, "current");
  const previous = await readPointer(root, "previous");

  const protectedIds = new Set([active?.releaseId, current?.id, previous?.id, active?.previousReleaseId].filter(Boolean));
  const effectiveKeep = Math.max(3, Number(keep) || 3);

  const removable = releases.filter(({ id }) => {
    if (protectedIds.has(id)) return false;
    const index = releases.findIndex((entry) => entry.id === id);
    return releases.length - index > effectiveKeep;
  });

  const removed = [];
  for (const entry of removable) {
    if (dryRun) {
      removed.push(entry.id);
      continue;
    }
    await fs.rm(entry.dir, { recursive: true, force: true });
    await unmarkVerified(l, entry.id);
    await appendAudit(l, { event: "prune", releaseId: entry.id, actor, outcome: "ok", keep: effectiveKeep });
    removed.push(entry.id);
  }

  return { keep: effectiveKeep, removed, protected: [...protectedIds], total: releases.length };
}

/** Everything an operator needs to answer "what is running, and is it sane?". */
export async function statusReport({ root = releaseRoot(), auditLimit = 10 } = {}) {
  const l = makeLayout(root);
  const [current, previous, active, verified, releases, envFiles, audit] = await Promise.all([
    readPointer(root, "current"),
    readPointer(root, "previous"),
    readActive(l).catch(() => null),
    readVerified(l).catch(() => new Set()),
    listReleaseDirs(l),
    envReport(l),
    readAudit(l, { limit: auditLimit }).catch(() => []),
  ]);

  const summaries = [];
  for (const entry of releases) {
    let manifest = null;
    let error = null;
    try {
      manifest = await readManifest(entry.dir, { id: entry.id });
    } catch (caught) {
      error = caught.message;
    }
    summaries.push({
      id: entry.id,
      commit: manifest?.commit ?? null,
      buildId: manifest?.buildId ?? null,
      createdAt: manifest?.createdAt ?? null,
      verified: verified.has(entry.id),
      error,
    });
  }

  return { root, current, previous, active, verified: [...verified], releases: summaries, envFiles, audit };
}
