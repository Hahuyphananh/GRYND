// deploy/lib/layout.mjs
//
// The on-disk contract for a versioned GRYND deployment.
//
//   <root>/releases/<id>/            immutable release directories
//   <root>/incoming/<id>/            where CI uploads; renamed into releases/ only after verification
//   <root>/env/{app,realtime}.env    the managed environment files (never inside a release)
//   <root>/current -> releases/<id>  the atomic pointer both systemd units start from
//   <root>/previous -> releases/<id> the last-known-good release
//   <root>/state/{active.json,verified.json,audit.jsonl}
//   <root>/shared/                   reserved for state that must outlive a release
//
// Nothing here accepts a caller-supplied path: every operation is built from
// this module's constants plus a release id that has been validated.

import path from "node:path";

/** `<UTC yyyymmddThhmmssZ>-<commit>`, e.g. `20261025T143012Z-3f9c2ab`. */
export const RELEASE_ID_RE = /^(\d{8}T\d{6}Z)-([0-9a-f]{7,40})$/;

/** Default production root. Overridable with GRYND_RELEASE_ROOT (staging/tests). */
export const DEFAULT_ROOT = "/home/ubuntu/grynd";

export class DeployError extends Error {
  /**
   * @param {string} message
   * @param {string} code machine-readable reason (`INVALID_ID`, `NOT_INSTALLED`, …)
   * @param {Record<string, unknown>} [details]
   */
  constructor(message, code, details = {}) {
    super(message);
    this.name = "DeployError";
    this.code = code;
    this.details = details;
  }
}

/** Resolve the release root, refusing a relative or non-absolute override. */
export function releaseRoot(env = process.env) {
  const raw = env.GRYND_RELEASE_ROOT || DEFAULT_ROOT;
  if (!path.isAbsolute(raw)) {
    throw new DeployError(
      `GRYND_RELEASE_ROOT must be an absolute path (got ${JSON.stringify(raw)})`,
      "INVALID_ROOT",
    );
  }
  return path.resolve(raw);
}

/** Every path the deploy tool is allowed to touch, derived from one root. */
export function layout(root) {
  const releases = path.join(root, "releases");
  const incoming = path.join(root, "incoming");
  const env = path.join(root, "env");
  const state = path.join(root, "state");
  return {
    root,
    releases,
    incoming,
    env,
    state,
    shared: path.join(root, "shared"),
    current: path.join(root, "current"),
    previous: path.join(root, "previous"),
    appEnv: path.join(env, "app.env"),
    realtimeEnv: path.join(env, "realtime.env"),
    activeState: path.join(state, "active.json"),
    verifiedState: path.join(state, "verified.json"),
    auditLog: path.join(state, "audit.jsonl"),
    deploymentsState: path.join(state, "deployments.json"),
    releaseDir: (id) => path.join(releases, id),
    incomingDir: (id) => path.join(incoming, id),
    manifestPath: (id) => path.join(releases, id, "release.json"),
    incomingManifestPath: (id) => path.join(incoming, id, "release.json"),
  };
}

/**
 * Throws unless `id` is a well-formed release id. This is the ONLY way an id
 * enters the system, so `..`, absolute paths, drive letters and separators are
 * rejected before any path is built from it.
 */
export function assertReleaseId(id) {
  if (typeof id !== "string" || !RELEASE_ID_RE.test(id)) {
    throw new DeployError(
      `Invalid release id ${JSON.stringify(id)} — expected <UTC timestamp>-<commit>, e.g. 20261025T143012Z-3f9c2ab`,
      "INVALID_ID",
      { id },
    );
  }
  // The regex already excludes separators, but keep the belt: a resolved path
  // must stay a direct child of releases/.
  if (id.includes("/") || id.includes("\\") || id === "." || id === "..") {
    throw new DeployError(`Invalid release id ${JSON.stringify(id)}`, "INVALID_ID", { id });
  }
  return id;
}

/** Derive a release id from a timestamp and a commit sha. */
export function makeReleaseId({ date = new Date(), commit } = {}) {
  const sha = String(commit || "").toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(sha)) {
    throw new DeployError(`Cannot build a release id from commit ${JSON.stringify(commit)}`, "INVALID_COMMIT");
  }
  const iso = date.toISOString(); // 2026-10-25T14:30:12.345Z
  const stamp = `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
  return `${stamp}-${sha.slice(0, 7)}`;
}

/** True when `child` is `parent` itself or lives underneath it. */
export function isInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Sorting key: release ids are lexicographically chronological. */
export function byReleaseId(a, b) {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
