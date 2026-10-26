// deploy/lib/inspect.mjs
//
// Verification of a release tree, used both before an artifact is allowed into
// releases/ and again before activation. Everything is re-derived locally:
// the manifest is never trusted on its own.

import fs from "node:fs/promises";
import path from "node:path";

import { DeployError, assertReleaseId, isInside } from "./layout.mjs";
import {
  checkCompleteness,
  checkRuntimeCompatibility,
  hashArtifact,
  hashDirectory,
  readManifest,
} from "./manifest.mjs";

/** Files that must never ship inside a release. */
const FORBIDDEN_NAMES = [".env", ".env.local", ".env.production", ".env.development", ".env.test"];

async function walk(top, { skip = new Set(["node_modules", ".git"]), maxDepth = 4 } = {}) {
  const found = [];

  async function visit(dir, rel, depth) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (skip.has(entry.name)) continue;
        await visit(path.join(dir, entry.name), relPath, depth + 1);
      } else if (entry.isSymbolicLink()) {
        found.push({ relPath, kind: "link" });
      } else if (entry.isFile()) {
        found.push({ relPath, kind: "file" });
      }
    }
  }

  await visit(top, "", 0);
  return found;
}

/**
 * Full verification of a release directory.
 *
 * @returns {Promise<{
 *   ok: boolean, errors: string[], warnings: string[],
 *   manifest: object|null, buildId: string|null,
 *   runtime: object|null, realtimeHash: string|null,
 *   envFiles: string[], nestedReleaseDirs: string[]
 * }>}
 */
export async function inspectRelease(dir, { id, arch = process.arch, node = process.versions.node } = {}) {
  const errors = [];
  const warnings = [];
  let manifest = null;
  let completeness = { ok: false, errors: ["not checked"], buildId: null };
  let runtime = null;

  try {
    manifest = await readManifest(dir, { id });
  } catch (error) {
    errors.push(error.message);
    return { ok: false, errors, warnings, manifest: null, buildId: null, runtime: null, realtimeHash: null, artifactHash: null, envFiles: [], nestedReleaseDirs: [] };
  }

  completeness = await checkCompleteness(dir, manifest);
  errors.push(...completeness.errors);

  runtime = checkRuntimeCompatibility(manifest, { arch, node });
  errors.push(...runtime.errors);

  // Re-hash the realtime tree: the manifest's hash is a claim, this is proof.
  let realtimeHash = null;
  try {
    realtimeHash = await hashDirectory(path.join(dir, "realtime"));
    if (realtimeHash !== manifest.realtime?.hash) {
      errors.push(`realtime tree hash ${realtimeHash} does not match manifest ${manifest.realtime?.hash}`);
    }
  } catch (error) {
    errors.push(`cannot hash realtime tree: ${error.code || error.message}`);
  }

  // The whole-artifact checksum covers the app, its dependencies and static
  // assets. Without it, a corrupt upload could pass on BUILD_ID + realtime hash
  // alone while serving broken JavaScript.
  let artifactHash = null;
  try {
    const artifact = await hashArtifact(dir);
    artifactHash = artifact.hash;
    if (artifactHash !== manifest.artifact?.hash) {
      errors.push(`artifact checksum ${artifactHash} does not match manifest ${manifest.artifact?.hash}`);
    }
    if (Number.isInteger(manifest.artifact?.files) && artifact.files !== manifest.artifact.files) {
      errors.push(`artifact contains ${artifact.files} files but the manifest records ${manifest.artifact.files}`);
    }
    if (Number.isInteger(manifest.artifact?.bytes) && artifact.bytes !== manifest.artifact.bytes) {
      errors.push(`artifact is ${artifact.bytes} bytes but the manifest records ${manifest.artifact.bytes}`);
    }
  } catch (error) {
    errors.push(`cannot hash the artifact: ${error.code || error.message}`);
  }

  // Secrets and stray state must not be packaged.
  const files = await walk(dir);
  const envFiles = files.filter(({ relPath }) => FORBIDDEN_NAMES.some((name) => relPath.split("/").pop() === name)).map(({ relPath }) => relPath);
  if (envFiles.length > 0) errors.push(`release contains environment files: ${envFiles.join(", ")}`);

  const keys = files.filter(({ relPath }) => /\.(pem|key|p12|pfx)$/i.test(relPath)).map(({ relPath }) => relPath);
  if (keys.length > 0) {
    errors.push(`release contains certificate/key material (${keys.join(", ")}); the CA bundle and any key must live in <root>/env/, not in a release`);
  }

  // Directories are not part of `files` (that walk only records files and
  // links), so this one is checked explicitly.
  const standalone = path.join(dir, "app", ".next", "standalone");
  let standalonePresent = true;
  try {
    await fs.lstat(standalone);
  } catch {
    standalonePresent = false;
  }
  if (standalonePresent) {
    errors.push("app/.next/standalone is present but this deployment runs `next start`; build without standalone output");
  }
  const nestedReleaseDirs = standalonePresent ? ["app/.next/standalone"] : [];

  if (manifest.productionFixes?.caTrust !== true) {
    errors.push("manifest does not assert the reviewed production CA fix (productionFixes.caTrust)");
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    manifest,
    buildId: completeness.buildId,
    runtime,
    realtimeHash,
    artifactHash,
    envFiles,
    nestedReleaseDirs,
  };
}

/** Verify an installed release and throw on any problem. */
export async function assertReleaseUsable(layout, id, options = {}) {
  // Validated here too: this function is reachable from the CLI's `verify`
  // before any other check, and a path is never an acceptable id.
  assertReleaseId(id);
  const dir = layout.releaseDir(id);
  let stat;
  try {
    stat = await fs.lstat(dir);
  } catch {
    throw new DeployError(`Release ${id} is not installed under ${layout.releases}`, "NOT_INSTALLED", { id });
  }
  if (!stat.isDirectory()) {
    throw new DeployError(`${dir} is not a directory`, "NOT_INSTALLED", { id });
  }
  if (!isInside(layout.releases, dir)) {
    throw new DeployError(`Resolved release path escapes ${layout.releases}`, "INVALID_ID", { id });
  }

  const report = await inspectRelease(dir, { id, ...options });
  if (!report.ok) {
    throw new DeployError(`Release ${id} failed verification:\n  - ${report.errors.join("\n  - ")}`, "RELEASE_UNUSABLE", {
      id,
      errors: report.errors,
      report,
    });
  }
  return report;
}
