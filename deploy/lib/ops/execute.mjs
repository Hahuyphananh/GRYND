// deploy/lib/ops/execute.mjs
//
// The privileged path, in one place, in a fixed order. Nothing here is
// reachable from a request field except an operation ID, a token, a phrase, an
// actor and a reason — and each is validated on the server before the next
// check runs.
//
//   allowlist → enabled gate → actor → reason → confirmation phrase → token
//   → argv identity → binary identity → spend nonce → audit start → run
//   → verify → audit result
//
// Two behaviours are deliberate and worth stating:
//
//   fail closed on audit  If the "action starting" record cannot be written,
//                         the command does not run. An unlogged privileged
//                         action is the exact failure the log exists to prevent.
//
//   no automatic recovery  A failed or unhealthy outcome is reported, not
//                         retried and not "fixed" by another restart. Restarting
//                         because a metric is unhealthy turns a small incident
//                         into a loop nobody is watching.

import fs from "node:fs/promises";
import { execFile } from "node:child_process";

import { DeployError, layout as buildLayout, releaseRoot } from "../layout.mjs";
import { readActive } from "../state.mjs";
import {
  EXCLUDED_ACTIONS,
  MANAGED_UNITS,
  OPERATION_IDS,
  OPERATIONS,
  assertArgv,
  getOperation,
} from "./allowlist.mjs";
import {
  DEFAULT_TTL_MS,
  consumeNonce,
  issueToken,
  loadTokenSecret,
  readConsumed,
  tokenFingerprint,
  verifyToken,
} from "./confirm.mjs";
import { appendAudit, appendIngestedEvent, listAudit, verifyAudit } from "./audit.mjs";
import { backupStatus } from "../backup/status.mjs";
import { configStatus } from "./config.mjs";
import { opsPaths } from "./paths.mjs";
import { redact, redactString } from "./redact.mjs";
import { createSystemctlReader, verifyOperation } from "./verify.mjs";

export const REASON_MAX = 200;
export const REASON_MIN = 3;
export const ACTOR_MAX = 100;

/** Replace control characters without tripping `no-control-regex`. */
function stripControl(value) {
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0);
    out += code < 0x20 || code === 0x7f ? " " : char;
  }
  return out;
}

/** Collapse whitespace, strip control characters, bound the length. */
export function normalizeText(value, max) {
  if (typeof value !== "string") return "";
  return stripControl(value).replace(/\s+/g, " ").trim().slice(0, max);
}

/** Comparison form of a confirmation phrase: case- and whitespace-insensitive. */
export function normalizePhrase(value) {
  return normalizeText(value, 200).toLowerCase();
}

/**
 * The real runner. `execFile` with a fixed argv — never a shell, never a string
 * built from input. A timeout kills the child and is reported as `timedOut`
 * rather than as a failure of the service.
 */
export function createExecRunner({ exec = execFile } = {}) {
  return function run(argv, { timeoutMs = 30_000, maxBytes = 4_096 } = {}) {
    return new Promise((resolve) => {
      const startedAt = Date.now();
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      try {
        exec(
          argv[0],
          argv.slice(1),
          { timeout: timeoutMs, killSignal: "SIGTERM", windowsHide: true, maxBuffer: 1024 * 1024 },
          (error, stdout, stderr) => {
            finish({
              ok: !error,
              exitCode: typeof error?.code === "number" ? error.code : null,
              signal: error?.signal ?? null,
              timedOut: Boolean(error?.killed),
              ms: Date.now() - startedAt,
              stdout: String(stdout ?? "").slice(0, maxBytes),
              stderr: String(stderr ?? "").slice(0, maxBytes),
            });
          },
        );
      } catch (error) {
        finish({
          ok: false,
          exitCode: null,
          signal: null,
          timedOut: false,
          ms: Date.now() - startedAt,
          stdout: "",
          stderr: redactString(String(error?.message ?? "spawn failed")),
        });
      }
    });
  };
}

/**
 * Prove the binaries are the allowlisted ones and not a symlink swapped in
 * afterwards. `sudo` is the interesting case: if an attacker controls the
 * earlier PATH entry they can replace it, so the absolute path is resolved and
 * compared rather than trusted.
 */
export async function preflightBinaries(argv, { realpath = fs.realpath } = {}) {
  for (const candidate of [argv[0], argv[2]]) {
    if (typeof candidate !== "string" || !candidate.startsWith("/")) {
      throw new DeployError(`Allowlisted binary is not an absolute path: ${JSON.stringify(candidate)}`, "BINARY_MISMATCH");
    }
    let resolved;
    try {
      resolved = await realpath(candidate);
    } catch (error) {
      throw new DeployError(
        `Required binary ${candidate} is not available on this host`,
        "BINARY_MISSING",
        { candidate, code: error.code ?? null },
      );
    }
    if (resolved !== candidate) {
      throw new DeployError(
        `${candidate} resolves to ${resolved}; refusing to run it`,
        "BINARY_MISMATCH",
        { candidate, resolved },
      );
    }
  }
  return { ok: true };
}

/**
 * Build a runtime bound to one release root.
 *
 * Every dependency that shells out, probes or reads time is injectable, so the
 * test suite drives the real gates without touching a unit, a port or a
 * production file.
 */
export function createOpsRuntime({
  root = releaseRoot(),
  releaseLayout = buildLayout(root),
  paths = opsPaths(releaseLayout),
  env = process.env,
  now = () => new Date(),
  run = createExecRunner(),
  reader = createSystemctlReader(),
  healthGate,
  appPort,
  realtimePort,
  ttlMs = DEFAULT_TTL_MS,
  secret = null,
  preflight = preflightBinaries,
  auditWriter = appendAudit,
  pollAttempts = 6,
  pollIntervalMs = 500,
  backupDestination = null,
  backupPolicy,
} = {}) {
  const enabled = () => env.GRYND_OPS_ENABLED === "1";

  async function writeAudit(event, actor, detail) {
    return auditWriter({ paths, event, actor: actor || "unknown", detail, now: now() });
  }

  /**
   * Record a refusal, then build the error to throw. An audit failure must not
   * hide the refusal itself, so it is swallowed here and the refusal wins.
   */
  async function denial({ operationId, actor, code, message, details = {} }) {
    try {
      await writeAudit("ops.denied", actor || "unknown", {
        operation: operationId ?? null,
        code,
        ...details,
      });
    } catch {
      // See above: the refusal is the important part.
    }
    return new DeployError(message, code, redact(details));
  }

  async function resolveSecret() {
    return secret ?? loadTokenSecret({ paths, env });
  }

  /** Read-only plan. Mints the confirmation token; nothing is executed. */
  async function plan(operationId, { actor } = {}) {
    const safeActor = normalizeText(actor, ACTOR_MAX);

    let operation;
    try {
      operation = getOperation(operationId);
    } catch (error) {
      throw await denial({ operationId, actor: safeActor, code: "UNKNOWN_OPERATION", message: error.message });
    }
    if (safeActor.length === 0) {
      throw await denial({
        operationId,
        actor: "",
        code: "ACTOR_REQUIRED",
        message: "A plan needs an authenticated actor. The dashboard must pass the session identity, never a request field.",
      });
    }

    const secretBuffer = await resolveSecret();
    const issued = issueToken({ operation, actor: safeActor, secret: secretBuffer, now: now(), ttlMs });
    const fingerprint = tokenFingerprint(issued.token);

    await writeAudit("ops.plan", safeActor, {
      operation: operation.id,
      unit: operation.unit,
      action: operation.action,
      tokenFingerprint: fingerprint,
      expiresAt: issued.expiresAt,
      executionEnabled: enabled(),
    });

    return {
      ok: true,
      operation: operation.id,
      unit: operation.unit,
      action: operation.action,
      label: operation.label,
      impact: operation.impact,
      confirmPhrase: operation.confirmPhrase,
      // The one place a token enters a response. Constructed field by field, so
      // no redaction rule applied to logged data can hide it here.
      token: issued.token,
      issuedAt: issued.issuedAt,
      expiresAt: issued.expiresAt,
      ttlMs: issued.ttlMs,
      tokenFingerprint: fingerprint,
      timeoutMs: operation.timeoutMs,
      executionEnabled: enabled(),
      verification: { unit: operation.unit, health: operation.health },
      note: enabled()
        ? null
        : "Execution is disabled on this host. This plan cannot be applied until an operator enables it.",
    };
  }

  /** Apply a plan. Every gate is re-checked; nothing from the plan is trusted. */
  async function apply({ operationId, token, confirm, actor, reason } = {}) {
    const safeActor = normalizeText(actor, ACTOR_MAX);

    let operation;
    try {
      operation = getOperation(operationId);
    } catch (error) {
      throw await denial({ operationId, actor: safeActor, code: "UNKNOWN_OPERATION", message: error.message });
    }

    if (!enabled()) {
      throw await denial({
        operationId: operation.id,
        actor: safeActor,
        code: "OPS_DISABLED",
        message:
          "Service actions are disabled on this host: GRYND_OPS_ENABLED is not 1. " +
          "This is the shipped default; enablement is a separate, reviewed change.",
      });
    }

    if (safeActor.length === 0) {
      throw await denial({
        operationId: operation.id,
        actor: "",
        code: "ACTOR_REQUIRED",
        message: "An authenticated actor is required. The dashboard must pass the session identity, never a request field.",
      });
    }

    const safeReason = normalizeText(reason, REASON_MAX);
    if (safeReason.length < REASON_MIN) {
      throw await denial({
        operationId: operation.id,
        actor: safeActor,
        code: "REASON_REQUIRED",
        message: `A reason of at least ${REASON_MIN} characters is required and is recorded in the audit log.`,
      });
    }

    if (normalizePhrase(confirm) !== normalizePhrase(operation.confirmPhrase)) {
      throw await denial({
        operationId: operation.id,
        actor: safeActor,
        code: "CONFIRMATION_MISMATCH",
        message: `Confirmation did not match. Type exactly: ${operation.confirmPhrase}`,
      });
    }

    const secretBuffer = await resolveSecret();
    const consumed = await readConsumed(paths);
    let payload;
    try {
      payload = verifyToken({
        token,
        operation,
        actor: safeActor,
        secret: secretBuffer,
        now: now(),
        consumed,
      });
    } catch (error) {
      throw await denial({
        operationId: operation.id,
        actor: safeActor,
        code: error.code ?? "TOKEN_INVALID",
        message: error.message,
      });
    }

    // Re-check the argument vector immediately before it is used. Two checks:
    // an identity check proves this is still the frozen catalogue array (not a
    // copy someone mutated), and the deep comparison proves its contents.
    if (operation.argv !== OPERATIONS[operation.id]?.argv) {
      throw await denial({
        operationId: operation.id,
        actor: safeActor,
        code: "ARGV_MISMATCH",
        message: "The operation's argv is not the frozen allowlisted array.",
      });
    }
    try {
      assertArgv(operation, operation.argv);
    } catch (error) {
      throw await denial({
        operationId: operation.id,
        actor: safeActor,
        code: error.code ?? "ARGV_MISMATCH",
        message: error.message,
      });
    }

    try {
      await preflight(operation.argv);
    } catch (error) {
      throw await denial({
        operationId: operation.id,
        actor: safeActor,
        code: error.code ?? "PREFLIGHT_FAILED",
        message: error.message,
      });
    }

    // Spend the nonce BEFORE the command: a crash mid-restart must not leave a
    // reusable token behind.
    await consumeNonce({ paths, nonce: payload.nonce, operation: operation.id, actor: safeActor, now: now() });

    // Fail closed: no unlogged privileged action.
    try {
      await writeAudit("service.action.start", safeActor, {
        operation: operation.id,
        unit: operation.unit,
        action: operation.action,
        reason: safeReason,
        tokenFingerprint: tokenFingerprint(token),
        argv: [...operation.argv],
      });
    } catch (error) {
      throw new DeployError(
        `Refusing to run ${operation.id}: the audit entry could not be written (${redactString(error.message)})`,
        "AUDIT_UNAVAILABLE",
      );
    }

    const startedAt = now();
    const command = await run([...operation.argv], { timeoutMs: operation.timeoutMs });
    const safeCommand = {
      ok: Boolean(command.ok),
      exitCode: command.exitCode ?? null,
      signal: command.signal ?? null,
      timedOut: Boolean(command.timedOut),
      ms: command.ms ?? null,
      stdout: redactString(String(command.stdout ?? "")),
      stderr: redactString(String(command.stderr ?? "")),
    };

    // Verification runs whatever the command reported. A timeout does not mean
    // the restart did not happen, so the observed state is always read.
    const verification = await verifyOperation({
      operation,
      units: MANAGED_UNITS,
      reader,
      healthGate,
      appPort,
      realtimePort,
      pollAttempts,
      pollIntervalMs,
    });

    const finishedAt = now();
    const durationMs = Math.max(0, finishedAt.getTime() - startedAt.getTime());

    let outcome;
    if (safeCommand.ok && verification.ok) outcome = "verified";
    else if (safeCommand.timedOut) outcome = "timed_out";
    else if (!safeCommand.ok) outcome = "command_failed";
    else outcome = "verification_failed";

    const messages = {
      verified: `${operation.label} completed and was verified: ${operation.unit} is active and its health gate passed.`,
      timed_out: `The restart command did not finish within ${operation.timeoutMs}ms and was killed. The unit state and health were still checked and are reported below — this is NOT a confirmed restart.`,
      command_failed: `The restart command failed${
        safeCommand.exitCode === null ? "" : ` (exit ${safeCommand.exitCode})`
      }. ${operation.unit} was not confirmed restarted; the observed state is reported below.`,
      verification_failed:
        "The restart command reported success but verification failed: the unit is not active, or its health gate did not pass. Do not treat this as a successful restart.",
    };

    let resultEntry = null;
    let auditError = null;
    try {
      resultEntry = await writeAudit("service.action.result", safeActor, {
        operation: operation.id,
        unit: operation.unit,
        action: operation.action,
        reason: safeReason,
        outcome,
        verified: verification.ok,
        command: safeCommand,
        verification,
        durationMs,
      });
    } catch (error) {
      // The action already happened; say so rather than pretend it is recorded.
      auditError = redactString(error.message);
    }

    return {
      ok: outcome === "verified",
      outcome,
      operation: operation.id,
      unit: operation.unit,
      action: operation.action,
      actor: safeActor,
      reason: safeReason,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs,
      command: safeCommand,
      verification,
      audit: resultEntry ? { seq: resultEntry.seq, hash: resultEntry.hash } : null,
      message: auditError ? `${messages[outcome]} (WARNING: the result could not be written to the audit log: ${auditError})` : messages[outcome],
    };
  }

  /** Read-only overview for the dashboard landing page. */
  async function status() {
    const active = await readActive(releaseLayout).catch(() => null);

    const units = {};
    for (const [role, unit] of Object.entries(MANAGED_UNITS)) {
      const observed = await reader.state(unit);
      units[role] = {
        unit: observed.unit ?? unit,
        state: observed.state,
        active: Boolean(observed.active),
        error: observed.error ?? null,
      };
    }

    const config = await configStatus({ layout: releaseLayout });

    return {
      ok: true,
      enabled: enabled(),
      root: releaseLayout.root,
      activeRelease: active
        ? {
            releaseId: active.releaseId ?? null,
            commit: active.commit ?? null,
            activatedAt: active.activatedAt ?? active.at ?? null,
          }
        : null,
      units,
      config: { ok: config.ok, summary: config.summary },
      operations: OPERATION_IDS.map((id) => ({
        id,
        unit: OPERATIONS[id].unit,
        action: OPERATIONS[id].action,
        label: OPERATIONS[id].label,
      })),
      excluded: EXCLUDED_ACTIONS,
      actionsEnabled: enabled(),
    };
  }

  /** Configuration status. Reads env files; returns verdicts, never values. */
  async function config() {
    const report = await configStatus({ layout: releaseLayout });
    try {
      await writeAudit("config.read", "dashboard", { files: report.files.map((file) => file.name) });
    } catch {
      // A read that cannot be logged is still a read; the report stands.
    }
    return report;
  }

  /**
   * Configuration WRITES are not implemented. The attempt is recorded so a
   * probe shows up in the audit log, and the refusal explains the gate.
   */
  async function refuseConfigChange({ actor } = {}) {
    const safeActor = normalizeText(actor, ACTOR_MAX) || "unknown";
    try {
      await writeAudit("config.change.denied", safeActor, { code: "NOT_IMPLEMENTED" });
    } catch {
      // The refusal still stands.
    }
    throw new DeployError(
      "Configuration values are not editable through this interface. Secret replacement requires a " +
        "separate design review covering format, ownership, rollback and restart behaviour " +
        "(see deploy/ops-permissions.md §5).",
      "NOT_IMPLEMENTED",
    );
  }

  /**
   * Backup readiness. Read-only and safe to call on a host where nothing is
   * enabled: it reads one local ledger, never the database, and never a secret.
   */
  async function backup() {
    return backupStatus({
      releaseLayout,
      now: now(),
      destination: backupDestination,
      ...(backupPolicy ? { policy: backupPolicy } : {}),
    });
  }

  async function auditTail({ limit = 50 } = {}) {
    return listAudit({ paths, releaseLayout, limit });
  }

  async function auditCheck() {
    return verifyAudit({ paths });
  }

  async function ingestAuthEvent({ event, actor, detail } = {}) {
    return appendIngestedEvent({
      paths,
      event,
      actor: normalizeText(actor, ACTOR_MAX) || "unknown",
      detail,
      now: now(),
    });
  }

  return {
    root: releaseLayout.root,
    paths,
    enabled,
    plan,
    apply,
    status,
    config,
    backup,
    refuseConfigChange,
    auditTail,
    auditCheck,
    ingestAuthEvent,
  };
}
