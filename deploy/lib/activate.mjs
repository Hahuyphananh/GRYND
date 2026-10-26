// deploy/lib/activate.mjs
//
// Activation is a fixed sequence, and every step after the first write is
// recorded in state/audit.jsonl whether it succeeds or not:
//
//   validate target → swap `current` → restart units → health gate
//     ├─ pass  → mark verified, move `previous`, write active.json
//     └─ fail  → swap back, restart, health-check the revert, record failure
//
// Rollback is the same sequence with extra preconditions: a previously
// verified release, an explicit `--confirm <same id>` and a non-empty reason.
// Nothing here touches database migrations (see deploy/README.md).

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { DeployError, assertReleaseId, layout as makeLayout, releaseRoot } from "./layout.mjs";
import { readManifest } from "./manifest.mjs";
import { assertReleaseUsable } from "./inspect.mjs";
import { readPointer, swapPointer } from "./pointer.mjs";
import {
  appendAudit,
  assertEnvironmentReady,
  ensureLayout,
  markVerified,
  readActive,
  readVerified,
  unmarkVerified,
  writeActive,
} from "./state.mjs";
import { defaultHealthTargets, runHealthGate, summarizeHealth } from "./health.mjs";
import { createDryRunController } from "./services.mjs";

async function removePointer(root, name) {
  try {
    await fs.unlink(path.join(root, name));
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Put `current` back on the previous release and re-check it.
 * Never throws: a failed revert is an outcome to report, not an exception to
 * hide the health failure behind.
 */
async function revertToPrevious({
  l,
  root,
  previousId,
  controller,
  healthTargets,
  healthOptions,
  platforms,
  restartRealtime,
}) {
  const result = { attemptedAt: new Date().toISOString(), target: previousId, swapped: false, restarted: false, health: null, error: null };
  try {
    if (previousId) {
      await swapPointer(root, "current", l.releaseDir(previousId), platforms);
    } else {
      // Nothing to fall back to: removing the pointer leaves the units without
      // a WorkingDirectory, i.e. down, which is the honest state. The audit
      // record says so.
      await removePointer(root, "current");
    }
    result.swapped = true;
    await controller.restart({ restartRealtime, releaseId: previousId });
    result.restarted = true;
    const gate = await runHealthGate({ targets: healthTargets, ...healthOptions });
    result.health = summarizeHealth(gate);
  } catch (error) {
    result.error = error.message;
  }
  return result;
}

/**
 * Activate an installed release.
 *
 * @param {object} options
 * @param {string} options.id release id (validated; never a path)
 * @param {string} options.actor who asked
 * @param {string} [options.reason]
 * @param {"deploy"|"rollback"} [options.kind]
 * @param {string|null} [options.confirm] must equal `id` for a rollback
 * @param {{restart: Function}} [options.controller]
 * @param {object} [options.healthOptions] attempts/intervalMs/appPort/realtimePort
 */
export async function activateRelease({
  root = releaseRoot(),
  id,
  actor = "unknown",
  reason = "",
  kind = "deploy",
  confirm = null,
  skipIfActive = false,
  controller = createDryRunController(),
  healthOptions = {},
  arch = process.arch,
  node = process.versions.node,
  platforms = {},
  clock = () => new Date(),
} = {}) {
  const l = makeLayout(root);
  const attemptId = randomUUID();
  const startedAt = clock().toISOString();

  // Malformed ids are refused before anything is written: they are not a
  // deployment attempt, they are a caller bug or an injection attempt.
  assertReleaseId(id);
  if (!["deploy", "rollback"].includes(kind)) {
    throw new DeployError(`Unknown activation kind ${kind}`, "INVALID_KIND");
  }

  await ensureLayout(l);

  const record = {
    attemptId,
    kind,
    releaseId: id,
    actor,
    reason,
    startedAt,
  };

  // ── Rollback preconditions ───────────────────────────────────────────────
  // Checked and recorded before the pointer moves, so a refused rollback is
  // still part of the history.
  if (kind === "rollback") {
    if (!String(reason).trim()) {
      await appendAudit(l, { event: "activation", ...record, outcome: "rejected", rejection: "reason required for rollback" });
      throw new DeployError("A rollback requires a non-empty --reason", "REASON_REQUIRED", { id });
    }
    if (confirm !== id) {
      await appendAudit(l, {
        event: "activation",
        ...record,
        outcome: "rejected",
        rejection: "confirmation mismatch",
        confirm: confirm === null ? null : String(confirm).slice(0, 64),
      });
      throw new DeployError(`A rollback must be confirmed with --confirm ${id} (received ${JSON.stringify(confirm)})`, "CONFIRMATION_REQUIRED", { id });
    }
  }

  const current = await readPointer(root, "current", platforms);
  const previousId = current && !current.broken ? current.id : null;
  const previousManifest = previousId
    ? await readManifest(l.releaseDir(previousId)).catch(() => null)
    : null;

  // ── Target validation ────────────────────────────────────────────────────
  let verifiedTarget;
  try {
    verifiedTarget = await assertReleaseUsable(l, id, { arch, node });
  } catch (error) {
    await appendAudit(l, {
      event: "activation",
      ...record,
      previousReleaseId: previousId,
      targetSha: null,
      previousSha: previousManifest?.commit ?? null,
      outcome: "rejected",
      rejection: error.code || "RELEASE_UNUSABLE",
      details: error.details?.errors ?? [],
    });
    throw error;
  }
  const manifest = verifiedTarget.manifest;

  // CI is idempotent: a retried workflow run for the release that is already
  // live must not bounce production again. The pointer, the active record and
  // its recorded health must all agree before this is allowed to skip.
  if (skipIfActive === true && kind === "deploy") {
    const activeRecord = await readActive(l).catch(() => null);
    if (
      current &&
      !current.broken &&
      current.id === id &&
      activeRecord?.releaseId === id &&
      activeRecord?.commit === manifest.commit &&
      activeRecord?.health?.ok === true
    ) {
      await appendAudit(l, {
        ...record,
        targetSha: manifest.commit,
        targetBuildId: manifest.buildId,
        previousReleaseId: previousId,
        outcome: "skipped",
        skipReason: "already active",
        completedAt: clock().toISOString(),
      });
      return {
        ok: true,
        skipped: true,
        skipReason: "already active",
        attemptId,
        releaseId: id,
        previousReleaseId: previousId,
        active: activeRecord,
        health: activeRecord.health,
        envFiles: [],
      };
    }
  }

  if (kind === "rollback") {
    const verified = await readVerified(l);
    if (!verified.has(id)) {
      await appendAudit(l, {
        event: "activation",
        ...record,
        targetSha: manifest.commit,
        previousReleaseId: previousId,
        previousSha: previousManifest?.commit ?? null,
        outcome: "rejected",
        rejection: "release has never passed the health gate",
      });
      throw new DeployError(`Release ${id} has never passed the health gate on this host; it is not a valid rollback target`, "NOT_VERIFIED", { id });
    }
    if (previousId === id) {
      await appendAudit(l, {
        event: "activation",
        ...record,
        targetSha: manifest.commit,
        previousReleaseId: previousId,
        previousSha: previousManifest?.commit ?? null,
        outcome: "rejected",
        rejection: "release is already active",
      });
      throw new DeployError(`Release ${id} is already active`, "ALREADY_ACTIVE", { id });
    }
  }

  // ── Service control must exist BEFORE anything moves ─────────────────────
  // A host that cannot restart the units cannot validate a new release: the
  // health gate would probe the OLD processes and prove nothing. Refuse here,
  // with the pointer untouched.
  try {
    await controller.assertReady?.();
  } catch (error) {
    await appendAudit(l, {
      event: "activation",
      ...record,
      targetSha: manifest.commit,
      targetBuildId: manifest.buildId,
      previousReleaseId: previousId,
      previousSha: previousManifest?.commit ?? null,
      outcome: "rejected",
      rejection: error.code ?? "SERVICE_CONTROL_UNAVAILABLE",
      error: error.message,
    });
    throw error;
  }

  // The environment files are checked (existence, mode, location) — never read.
  const envFiles = await assertEnvironmentReady(l);

  const restartRealtime = !(
    previousManifest?.realtime?.hash &&
    previousManifest.realtime.hash === manifest.realtime.hash
  );

  const healthTargets = defaultHealthTargets(healthOptions);
  const healthConfig = {
    attempts: healthOptions.attempts ?? 12,
    intervalMs: healthOptions.intervalMs ?? 750,
    timeoutMs: healthOptions.timeoutMs ?? 2_000,
    ...(healthOptions.probe ? { probe: healthOptions.probe } : {}),
    ...(healthOptions.sleep ? { sleep: healthOptions.sleep } : {}),
  };

  const auditBase = {
    event: "activation",
    ...record,
    targetSha: manifest.commit,
    targetBuildId: manifest.buildId,
    previousReleaseId: previousId,
    previousSha: previousManifest?.commit ?? null,
    actor,
    reason,
    restartRealtime,
  };

  // ── Swap ─────────────────────────────────────────────────────────────────
  let swap;
  try {
    swap = await swapPointer(root, "current", l.releaseDir(id), platforms);
  } catch (error) {
    await appendAudit(l, {
      ...auditBase,
      outcome: "failed",
      stage: "pointer-swap",
      error: error.message,
      completedAt: clock().toISOString(),
    });
    throw new DeployError(`Could not move the current pointer: ${error.message}`, "POINTER_SWAP_FAILED", { id });
  }

  // ── Restart ──────────────────────────────────────────────────────────────
  try {
    await controller.restart({ restartRealtime, releaseId: id });
  } catch (error) {
    const revert = await revertToPrevious({
      l,
      root,
      previousId,
      controller,
      healthTargets,
      healthOptions: healthConfig,
      platforms,
      restartRealtime: true,
    });
    await appendAudit(l, {
      ...auditBase,
      outcome: "failed",
      stage: "service-restart",
      error: error.message,
      pointerAtomic: swap.atomic,
      revert,
      completedAt: clock().toISOString(),
    });
    return {
      ok: false,
      stage: "service-restart",
      attempts: attemptId,
      releaseId: id,
      previousReleaseId: previousId,
      error: error.message,
      revert,
      envFiles,
    };
  }

  // ── Health gate ──────────────────────────────────────────────────────────
  const gate = await runHealthGate({ targets: healthTargets, ...healthConfig });
  const health = summarizeHealth(gate);

  if (!gate.ok) {
    await unmarkVerified(l, id);
    const revert = await revertToPrevious({
      l,
      root,
      previousId,
      controller,
      healthTargets,
      healthOptions: healthConfig,
      platforms,
      restartRealtime: true,
    });
    const audit = await appendAudit(l, {
      ...auditBase,
      outcome: "failed",
      stage: "health",
      health,
      pointerAtomic: swap.atomic,
      revert,
      completedAt: clock().toISOString(),
    });
    return {
      ok: false,
      stage: "health",
      attemptId,
      releaseId: id,
      previousReleaseId: previousId,
      health,
      revert,
      audit,
      envFiles,
    };
  }

  // ── Commit the activation ────────────────────────────────────────────────
  const activatedAt = clock().toISOString();
  await markVerified(l, id);
  let previousPointer = null;
  if (previousId && previousId !== id) {
    previousPointer = await swapPointer(root, "previous", l.releaseDir(previousId), platforms).catch((error) => ({
      error: error.message,
    }));
  }

  const active = {
    releaseId: id,
    commit: manifest.commit,
    buildId: manifest.buildId,
    activatedAt,
    kind,
    actor,
    reason,
    attemptId,
    previousReleaseId: previousId,
    previousCommit: previousManifest?.commit ?? null,
    restartRealtime,
    health,
    pointer: { atomic: swap.atomic, strategy: swap.strategy },
    envFiles: envFiles.map(({ name, path: file, bytes, mode, ok }) => ({ name, path: file, bytes, mode, ok })),
  };
  await writeActive(l, active);

  const audit = await appendAudit(l, {
    ...auditBase,
    outcome: "ok",
    health,
    pointerAtomic: swap.atomic,
    completedAt: activatedAt,
  });

  return {
    ok: true,
    attemptId,
    releaseId: id,
    previousReleaseId: previousId,
    active,
    health,
    audit,
    previousPointer,
    envFiles,
  };
}

/** Rollback is activation with the stricter contract; kept separate for the CLI and for readers. */
export async function rollbackRelease(options = {}) {
  return activateRelease({ ...options, kind: "rollback" });
}

/** Convenience for `status`: what is active right now, by pointer. */
export async function currentRelease({ root = releaseRoot(), platforms = {} } = {}) {
  const l = makeLayout(root);
  const pointer = await readPointer(root, "current", platforms);
  const active = await readActive(l).catch(() => null);
  const verified = await readVerified(l).catch(() => new Set());
  return { pointer, active, verified };
}
