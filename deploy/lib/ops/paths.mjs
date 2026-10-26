// deploy/lib/ops/paths.mjs
//
// Where the operations runtime keeps its own state, derived from the release
// root so staging and tests use a temporary directory and nothing hard-codes
// /home/ubuntu.
//
//   <root>/state/ops/
//     token.key        HMAC key for plan tokens (0600, generated once)
//     consumed.jsonl   nonces already spent (single-use enforcement)
//     audit.jsonl      hash-chained operations audit
//     audit.head.json  last entry's seq/hash, so the chain survives a restart
//     audit.lock       writer lock
//
// Deliberately separate from <root>/state/audit.jsonl, which the release tool
// owns: two writers on one append-only file would fork its history.

import path from "node:path";

import { isInside } from "../layout.mjs";

/** Ops paths under an existing release layout. */
export function opsPaths(releaseLayout) {
  const dir = path.join(releaseLayout.state, "ops");
  if (!isInside(releaseLayout.root, dir)) {
    throw new Error(`ops state directory escaped the release root: ${dir}`);
  }
  return {
    root: releaseLayout.root,
    stateOps: dir,
    tokenKey: path.join(dir, "token.key"),
    consumed: path.join(dir, "consumed.jsonl"),
    auditLog: path.join(dir, "audit.jsonl"),
    auditHead: path.join(dir, "audit.head.json"),
    auditLock: path.join(dir, "audit.lock"),
  };
}

/**
 * Archive file for a rotated audit segment. The sequence number is part of the
 * name so two rotations inside the same second cannot collide and overwrite an
 * earlier segment.
 */
export function auditArchivePath(paths, stamp, seq) {
  return path.join(paths.stateOps, `audit-${stamp}-${String(seq).padStart(8, "0")}.jsonl`);
}
