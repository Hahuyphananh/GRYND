// deploy/lib/pointer.mjs
//
// The `current` pointer. Two properties matter, and both are covered by
// deploy/tests/pointer.test.mjs:
//
//   1. A reader sees either the old release or the new one, never a partial
//      state. On POSIX that is `symlink(2)` to a temp name followed by
//      `rename(2)` over `current` — one atomic inode swap.
//   2. It is a *directory* link, so systemd's `WorkingDirectory=` and
//      `next start`'s cwd both resolve through it at process start. A running
//      process keeps the directory it resolved, which is why activation swaps
//      the pointer BEFORE restarting the units.
//
// Windows is a staging-only convenience: `rename` over an existing junction
// fails with EPERM, so the swap falls back to unlink+rename and is reported as
// non-atomic. Production never runs that branch.

import fs from "node:fs/promises";
import path from "node:path";

export const POINTER_NAMES = ["current", "previous"];

function linkType(platform) {
  return platform === "win32" ? "junction" : "dir";
}

/**
 * Read a pointer without following it into user space.
 *
 * Returns null when the pointer does not exist, `{ broken: true }` when it
 * points at a release that is gone (a state the tool must be able to report
 * and repair), or `{ id, target }` when it resolves.
 */
export async function readPointer(root, name = "current", { platform = process.platform } = {}) {
  if (!POINTER_NAMES.includes(name)) throw new Error(`unknown pointer ${name}`);
  const link = path.join(root, name);

  let stat;
  try {
    stat = await fs.lstat(link);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }

  // A real directory where a link belongs means someone created the release
  // in place; refuse to guess rather than serve a stale tree.
  if (!stat.isSymbolicLink()) {
    return { name, link, broken: true, reason: "not a symlink or junction", id: null, target: null, platform };
  }

  let target;
  try {
    target = await fs.realpath(link);
  } catch (error) {
    const raw = await fs.readlink(link).catch(() => null);
    return { name, link, broken: true, reason: `dangling pointer (${error.code})`, id: raw ? path.basename(raw) : null, target: raw, platform };
  }

  return { name, link, broken: false, id: path.basename(target), target, platform };
}

/**
 * Point `name` at `targetDir`, atomically where the platform allows it.
 *
 * @returns {{ name: string, id: string, link: string, target: string, atomic: boolean, strategy: string }}
 */
export async function swapPointer(root, name, targetDir, { platform = process.platform } = {}) {
  if (!POINTER_NAMES.includes(name)) throw new Error(`unknown pointer ${name}`);

  const link = path.join(root, name);
  const type = linkType(platform);
  const id = path.basename(targetDir);
  const tmp = path.join(root, `.${name}.tmp-${process.pid}-${Date.now().toString(36)}`);

  await fs.symlink(targetDir, tmp, type);

  try {
    await fs.rename(tmp, link);
    return { name, id, link, target: targetDir, atomic: true, strategy: `${type}+rename` };
  } catch (error) {
    // POSIX: rename(2) replaces the existing link atomically, so a failure here
    // is real. Windows: an existing junction cannot be replaced by rename —
    // fall back to move-aside, which is NOT atomic and is recorded as such.
    const canFallback = platform === "win32" && ["EPERM", "EEXIST", "ENOTEMPTY", "EACCES"].includes(error.code);
    if (!canFallback) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw error;
    }

    const aside = path.join(root, `.${name}.old-${process.pid}-${Date.now().toString(36)}`);
    let moved = false;
    try {
      await fs.rename(link, aside);
      moved = true;
    } catch (moveError) {
      if (moveError.code !== "ENOENT") {
        await fs.rm(tmp, { force: true }).catch(() => {});
        throw moveError;
      }
    }
    try {
      await fs.rename(tmp, link);
    } catch (renameError) {
      if (moved) await fs.rename(aside, link).catch(() => {});
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw renameError;
    }
    if (moved) await fs.rm(aside, { recursive: true, force: true }).catch(() => {});
    return { name, id, link, target: targetDir, atomic: false, strategy: `${type}+unlink+rename` };
  }
}
