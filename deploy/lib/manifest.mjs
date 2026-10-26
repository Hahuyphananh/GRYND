// deploy/lib/manifest.mjs
//
// `release.json` is written by the build workflow and re-validated on the host
// that installs the release. It is the only description of a release the tool
// trusts, and the tool re-derives everything it can (hashes, BUILD_ID, arch)
// instead of believing it.

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { DeployError, RELEASE_ID_RE } from "./layout.mjs";

export const MANIFEST_SCHEMA = 1;

/** Files a release must contain to be startable. Relative to the release dir. */
export const REQUIRED_APP_PATHS = [
  "app/.next/BUILD_ID",
  "app/.next/static",
  "app/public",
  "app/package.json",
  "app/next.config.js",
  "app/node_modules/next/package.json",
];

export const REQUIRED_REALTIME_PATHS = [
  "realtime/server.js",
  "realtime/package.json",
  "realtime/node_modules/express/package.json",
  "realtime/node_modules/socket.io/package.json",
];

const SHA_RE = /^[0-9a-f]{40}$/;
const SHORT_SHA_RE = /^[0-9a-f]{7,40}$/;
const HASH_RE = /^sha256:[0-9a-f]{64}$/;
const SEMVER_RE = /^\d+\.\d+\.\d+/;

/**
 * Validate a parsed manifest. Returns a list of human-readable problems; an
 * empty list means the manifest is structurally sound AND describes `id`.
 */
export function validateManifest(manifest, { id } = {}) {
  const errors = [];
  const need = (ok, message) => {
    if (!ok) errors.push(message);
  };

  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return ["release.json is not an object"];
  }

  need(manifest.schema === MANIFEST_SCHEMA, `schema must be ${MANIFEST_SCHEMA}`);
  need(typeof manifest.releaseId === "string" && RELEASE_ID_RE.test(manifest.releaseId), "releaseId is not a valid release id");
  if (id) need(manifest.releaseId === id, `releaseId ${JSON.stringify(manifest.releaseId)} does not match directory ${id}`);
  need(typeof manifest.commit === "string" && SHA_RE.test(manifest.commit), "commit must be a full 40-character sha");
  need(typeof manifest.shortCommit === "string" && SHORT_SHA_RE.test(manifest.shortCommit), "shortCommit must be 7-40 hex characters");
  if (typeof manifest.commit === "string" && typeof manifest.shortCommit === "string") {
    need(manifest.commit.startsWith(manifest.shortCommit), "shortCommit must be a prefix of commit");
  }
  need(typeof manifest.buildId === "string" && manifest.buildId.length > 0 && manifest.buildId.length <= 128, "buildId is missing or too long");
  need(typeof manifest.createdAt === "string" && !Number.isNaN(Date.parse(manifest.createdAt)), "createdAt must be an ISO timestamp");

  const builder = manifest.builder;
  need(!!builder && typeof builder === "object", "builder is missing");
  if (builder && typeof builder === "object") {
    need(typeof builder.workflow === "string" && builder.workflow.length > 0, "builder.workflow is missing");
    need(["arm64", "x64"].includes(builder.arch), `builder.arch must be arm64 or x64 (got ${JSON.stringify(builder.arch)})`);
    need(typeof builder.node === "string" && SEMVER_RE.test(builder.node), "builder.node is missing");
  }

  const fixes = manifest.productionFixes;
  need(!!fixes && typeof fixes === "object", "productionFixes is missing");
  if (fixes && typeof fixes === "object") {
    need(fixes.caTrust === true, "productionFixes.caTrust must be true (the reviewed production CA fix is required)");
  }

  const realtime = manifest.realtime;
  need(!!realtime && typeof realtime === "object", "realtime is missing");
  if (realtime && typeof realtime === "object") {
    need(typeof realtime.hash === "string" && HASH_RE.test(realtime.hash), "realtime.hash must be sha256:<hex>");
  }

  // The whole-artifact checksum, re-derived on the host at install and again at
  // activation. It excludes only the manifest itself and the runtime cache.
  const artifact = manifest.artifact;
  need(!!artifact && typeof artifact === "object", "artifact checksum is missing");
  if (artifact && typeof artifact === "object") {
    need(typeof artifact.hash === "string" && HASH_RE.test(artifact.hash), "artifact.hash must be sha256:<hex>");
    need(Number.isInteger(artifact.files) && artifact.files >= 1, "artifact.files must be a positive integer");
    need(Number.isInteger(artifact.bytes) && artifact.bytes >= 0, "artifact.bytes must be a non-negative integer");
  }

  // Build/test outcomes are metadata from the pipeline, not a substitute for
  // the workflow gates. They are recorded so a release can be traced back to
  // the run that produced it.
  const checks = manifest.checks;
  need(!!checks && typeof checks === "object", "checks are missing");
  if (checks && typeof checks === "object") {
    for (const key of ["build", "tests"]) {
      need(
        ["passed", "failed", "not-recorded"].includes(checks[key]),
        `checks.${key} must be passed, failed or not-recorded`,
      );
    }
  }

  return errors;
}

export async function readJson(file, { code = "UNREADABLE" } = {}) {
  let text;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    throw new DeployError(`Cannot read ${file}: ${error.code || error.message}`, code, { file });
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new DeployError(`Cannot parse JSON in ${file}`, "INVALID_MANIFEST", { file });
  }
}

/** Read and validate `<dir>/release.json`. */
export async function readManifest(dir, { id } = {}) {
  const manifest = await readJson(path.join(dir, "release.json"), { code: "MISSING_MANIFEST" });
  const errors = validateManifest(manifest, { id });
  if (errors.length > 0) {
    throw new DeployError(`Invalid release.json in ${dir}: ${errors.join("; ")}`, "INVALID_MANIFEST", { errors });
  }
  return manifest;
}

async function pathExists(target) {
  try {
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check that a release directory contains everything needed to start, and that
 * its `.next/BUILD_ID` agrees with the manifest. Never follows into
 * `node_modules` beyond the two entry points above.
 */
export async function checkCompleteness(dir, manifest) {
  const missing = [];
  for (const rel of [...REQUIRED_APP_PATHS, ...REQUIRED_REALTIME_PATHS]) {
    if (!(await pathExists(path.join(dir, rel)))) missing.push(rel);
  }
  const errors = [];
  if (missing.length > 0) errors.push(`missing: ${missing.join(", ")}`);

  let buildId = null;
  try {
    buildId = (await fs.readFile(path.join(dir, "app", ".next", "BUILD_ID"), "utf8")).trim();
  } catch {
    // already reported as missing above
  }
  if (buildId && manifest && typeof manifest.buildId === "string" && buildId !== manifest.buildId) {
    errors.push(`app/.next/BUILD_ID (${buildId}) does not match manifest buildId (${manifest.buildId})`);
  }

  return { ok: errors.length === 0, errors, missing, buildId };
}

/**
 * Paths that change after install and therefore cannot be part of the
 * immutable artifact checksum:
 *
 *   release.json      the manifest itself (it records the checksum)
 *   app/.next/cache   ISR / image cache written by the running app
 *
 * Everything else — including every dependency file — is covered, so a
 * corrupted or half-transferred upload is caught before activation and again
 * when a rollback target is re-verified.
 */
export function isMutableArtifactPath(relPath) {
  return relPath === "release.json" || relPath === "app/.next/cache" || relPath.startsWith("app/.next/cache/");
}

/** Stable sha256 over a tree (paths + contents, sorted), with a skip predicate. */
export async function hashTree(dir, { skip = () => false } = {}) {
  const hash = createHash("sha256");
  let files = 0;
  let bytes = 0;

  async function walk(current, rel) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (skip(relPath)) continue;
      if (entry.isDirectory()) {
        hash.update(`d:${relPath}\n`);
        await walk(abs, relPath);
      } else if (entry.isSymbolicLink()) {
        hash.update(`l:${relPath}:${await fs.readlink(abs)}\n`);
      } else if (entry.isFile()) {
        const contents = await fs.readFile(abs);
        hash.update(`f:${relPath}\n`);
        hash.update(contents);
        files += 1;
        bytes += contents.length;
      }
    }
  }

  await walk(dir, "");
  return { hash: `sha256:${hash.digest("hex")}`, files, bytes };
}

/** Stable sha256 over a directory (used for the realtime tree). */
export async function hashDirectory(dir) {
  return (await hashTree(dir)).hash;
}

/** The immutable checksum of a complete release tree. */
export async function hashArtifact(dir) {
  return hashTree(dir, { skip: isMutableArtifactPath });
}

/** Refuse a release built elsewhere for another CPU or another Node major. */
export function checkRuntimeCompatibility(manifest, { arch = process.arch, node = process.versions.node } = {}) {
  const errors = [];
  const builtArch = manifest?.builder?.arch;
  if (builtArch && builtArch !== arch) {
    errors.push(`release was built for ${builtArch} but this host is ${arch}`);
  }
  const builtNode = String(manifest?.builder?.node || "");
  const builtMajor = builtNode.split(".")[0];
  const hostMajor = String(node).split(".")[0];
  if (builtMajor && hostMajor && builtMajor !== hostMajor) {
    errors.push(`release was built on Node ${builtMajor}.x but this host runs ${hostMajor}.x`);
  }
  return { ok: errors.length === 0, errors, hostArch: arch, hostNode: node, builtArch, builtNode };
}
