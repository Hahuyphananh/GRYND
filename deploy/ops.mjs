#!/usr/bin/env node
//
// deploy/ops.mjs — the only entry point to the restricted operations runtime.
//
// Two modes, one dispatch table:
//
//   human CLI   node deploy/ops.mjs status | config | plan <op> | apply <op> | audit
//   broker      node deploy/ops.mjs --stdin   ← one JSON request on stdin,
//                                              one JSON response on stdout
//
// There is no HTTP server, no socket and no long-lived process here. The private
// dashboard spawns this script per request and passes the authenticated actor
// as a field. That keeps the network surface at zero: nothing in this file can
// be reached without already holding local code execution as the dashboard
// account, and the sudoers rule grants exactly two commands.
//
// The dispatch table is frozen. An action that is not in it does not exist, and
// unknown request fields are refused rather than ignored, so a field cannot be
// smuggled past a handler that forgot to look at it.
//
// Exit codes mirror deploy/release.mjs: 0 success, 1 the operation failed,
// 2 refused (validation, confirmation, authorization, disabled).

import { DeployError } from "./lib/layout.mjs";
import { createOpsRuntime } from "./lib/ops/execute.mjs";

const MAX_REQUEST_BYTES = 8_192;

/** Allowed request fields per action. Anything else is a refusal. */
const SCHEMAS = Object.freeze({
  status: Object.freeze([]),
  "config.status": Object.freeze([]),
  "backup.status": Object.freeze([]),
  "ops.plan": Object.freeze(["operation", "actor"]),
  "ops.apply": Object.freeze(["operation", "token", "confirm", "actor", "reason"]),
  "audit.list": Object.freeze(["limit"]),
  "audit.verify": Object.freeze([]),
  "audit.append": Object.freeze(["event", "actor", "detail"]),
  "config.set": Object.freeze(["key", "actor"]),
});

const STRING_FIELDS = new Set(["operation", "token", "confirm", "actor", "reason", "event", "key"]);

const HELP = `GRYND restricted operations

  node deploy/ops.mjs status [--json]
      Units, active release and configuration summary. Read-only.

  node deploy/ops.mjs config [--json]
      Presence, permissions, required key names and per-key format verdicts.
      Never prints a value.

  node deploy/ops.mjs backup [--json]
      Backup readiness: last success/failure, size, age, retention, destination
      health and the most recent restore test. Distinguishes a backup that
      exists from one whose restore is verified. Read-only.

  node deploy/ops.mjs plan <operation> --actor <name>
      Show the exact unit, action and impact, and mint a two-minute token.
      Nothing is executed.

  node deploy/ops.mjs apply <operation> --token <token> --confirm "<phrase>" \\
        --reason "<why>" --actor <name> [--json]
      Execute an allowlisted operation. Requires the phrase shown by the plan.

  node deploy/ops.mjs audit [--limit <n>] [--json]
  node deploy/ops.mjs audit-verify [--json]

  node deploy/ops.mjs --stdin
      Read one JSON request from stdin, write one JSON response.

Operations: ${Object.keys(SCHEMAS)
  .filter((action) => action.startsWith("ops."))
  .join(", ")}

Service actions are disabled unless GRYND_OPS_ENABLED=1. The shipped default is
disabled; enabling is a separate, reviewed change (see deploy/ops-permissions.md).
`;

/** Longest-first so `--x` is not shadowed by a prefix. */
const ALLOWED_FLAGS = new Set(["help", "json", "stdin", "actor", "reason", "token", "confirm", "limit"]);

function parseFlags(argv) {
  const positional = [];
  const flags = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    if (eq !== -1) {
      flags[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      flags[body] = true;
      continue;
    }
    flags[body] = next;
    index += 1;
  }

  return { positional, flags };
}

function assertKnownFlags(flags) {
  const unknown = Object.keys(flags).filter((flag) => !ALLOWED_FLAGS.has(flag));
  if (unknown.length > 0) {
    throw new DeployError(
      `Unknown option(s): ${unknown.map((flag) => `--${flag}`).join(", ")}. Run with --help.`,
      "INVALID_REQUEST",
    );
  }
}

async function readStdin(limit = MAX_REQUEST_BYTES) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > limit) {
      throw new DeployError(`Request exceeds ${limit} bytes`, "REQUEST_TOO_LARGE");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseRequest(text) {
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new DeployError("Empty request", "INVALID_REQUEST");
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new DeployError("Request is not valid JSON", "INVALID_REQUEST");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new DeployError("Request must be a JSON object", "INVALID_REQUEST");
  }
  return parsed;
}

/** Strict per-action validation. Unknown fields are refused, not ignored. */
function validateRequest(action, request) {
  const allowed = SCHEMAS[action];
  if (!allowed) {
    throw new DeployError(`Unknown action ${JSON.stringify(action)}`, "UNKNOWN_ACTION");
  }

  const unknown = Object.keys(request).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new DeployError(
      `Unknown field(s) for ${action}: ${unknown.map((key) => JSON.stringify(key)).join(", ")}`,
      "INVALID_REQUEST",
    );
  }

  for (const key of allowed) {
    if (key === "limit") continue;
    const value = request[key];
    if (value === undefined) continue;
    if (STRING_FIELDS.has(key) && typeof value !== "string") {
      throw new DeployError(`Field ${JSON.stringify(key)} must be a string`, "INVALID_REQUEST");
    }
    if (key === "detail" && (value === null || typeof value !== "object" || Array.isArray(value))) {
      throw new DeployError('Field "detail" must be an object', "INVALID_REQUEST");
    }
  }

  if (request.limit !== undefined) {
    const limit = Number(request.limit);
    if (!Number.isFinite(limit) || limit < 1) {
      throw new DeployError('Field "limit" must be a positive number', "INVALID_REQUEST");
    }
  }

  return request;
}

async function dispatch(runtime, action, request) {
  switch (action) {
    case "status":
      return runtime.status();
    case "config.status":
      return runtime.config();
    case "backup.status":
      return runtime.backup();
    case "ops.plan":
      return runtime.plan(request.operation, { actor: request.actor });
    case "ops.apply":
      return runtime.apply({
        operationId: request.operation,
        token: request.token,
        confirm: request.confirm,
        actor: request.actor,
        reason: request.reason,
      });
    case "audit.list":
      return { ok: true, entries: await runtime.auditTail({ limit: Number(request.limit) || 50 }) };
    case "audit.verify":
      return runtime.auditCheck();
    case "audit.append":
      return {
        ok: true,
        entry: await runtime.ingestAuthEvent({
          event: request.event,
          actor: request.actor,
          detail: request.detail ?? null,
        }),
      };
    case "config.set":
      // Always refuses, always audited. Kept in the table so the refusal is a
      // real, recorded answer instead of a 404-shaped silence.
      return runtime.refuseConfigChange({ actor: request.actor });
    default:
      throw new DeployError(`Unknown action ${JSON.stringify(action)}`, "UNKNOWN_ACTION");
  }
}

function exitCodeFor(action, result) {
  if (action === "ops.apply") return result?.outcome === "verified" ? 0 : 1;
  if (action === "audit.verify") return result?.ok ? 0 : 1;
  return 0;
}

function renderHuman(action, result) {
  const lines = [];

  if (action === "status") {
    lines.push(`GRYND operations — root ${result.root}`);
    lines.push(`Service actions: ${result.enabled ? "ENABLED" : "disabled (GRYND_OPS_ENABLED is not 1)"}`);
    for (const unit of Object.values(result.units)) {
      lines.push(`  ${unit.unit}: ${unit.state}${unit.error ? ` (${unit.error})` : ""}`);
    }
    lines.push(
      `Active release: ${result.activeRelease?.releaseId ?? "not recorded"}${
        result.activeRelease?.commit ? ` (${result.activeRelease.commit})` : ""
      }`,
    );
    lines.push(`Configuration: ${result.config.ok ? "ok" : "attention needed"} (${result.config.summary.keysOk}/${result.config.summary.keys} keys valid)`);
    lines.push(`Allowed operations: ${result.operations.map((operation) => operation.id).join(", ")}`);
    return lines.join("\n");
  }

  if (action === "backup.status") {
    const last = result.lastSuccess
      ? `${result.lastSuccess.at} (${result.age?.hours ?? "?"}h ago, ${result.size?.human ?? "size unknown"})`
      : "NEVER";
    lines.push(`Backup evidence: ${result.evidence}${result.verified ? " (restore verified)" : " (NOT restore-verified)"}`);
    lines.push(`Last successful backup: ${last}`);
    lines.push(
      `Last failed backup:     ${result.lastFailure ? `${result.lastFailure.at} (${result.lastFailure.code})` : "none recorded"}`,
    );
    lines.push(`Destination:            ${result.destination.kind} — ${result.destination.state}`);
    lines.push(
      `Retention:              ${result.retention.backupsInWindow}/${result.retention.windowDays}d window, ${result.retention.gaps.length} gap(s)`,
    );
    lines.push(
      `Restore test:           ${
        result.restoreTest
          ? `${result.restoreTest.ok ? "passed" : "FAILED"} ${result.restoreTest.ageDays}d ago against ${result.restoreTest.target}`
          : "never run"
      }`,
    );
    if (result.warnings.length === 0) {
      lines.push("Warnings: none");
    } else {
      lines.push("Warnings:");
      for (const warning of result.warnings) lines.push(`  [${warning.severity}] ${warning.code} — ${warning.message}`);
    }
    return lines.join("\n");
  }

  if (action === "config.status") {
    lines.push(`Configuration: ${result.ok ? "ok" : "attention needed"}`);
    for (const file of result.files) {
      lines.push(
        `  ${file.name}: ${file.present ? "present" : "MISSING"}${
          file.present ? `, mode ${file.mode ?? "n/a"}, ${file.bytes} bytes` : ""
        }${file.modeOk ? "" : " (permissions too open)"}`,
      );
      for (const key of file.keys) {
        lines.push(`    ${key.valid ? "ok  " : "FAIL"} ${key.key}${key.reason ? ` — ${key.reason}` : ""}`);
      }
    }
    lines.push("Values are never displayed by this report.");
    return lines.join("\n");
  }

  if (action === "ops.plan") {
    lines.push(`Operation: ${result.label}`);
    lines.push(`  unit    ${result.unit}`);
    lines.push(`  action  ${result.action}`);
    lines.push(`  timeout ${result.timeoutMs}ms`);
    lines.push("");
    lines.push("Impact:");
    lines.push(`  ${result.impact}`);
    lines.push("");
    lines.push(`Confirm by typing: ${result.confirmPhrase}`);
    lines.push(`Token expires:    ${result.expiresAt}`);
    if (!result.executionEnabled) lines.push("");
    if (result.note) lines.push(`NOTE: ${result.note}`);
    return lines.join("\n");
  }

  if (action === "ops.apply") {
    lines.push(`Operation: ${result.operation} (${result.unit})`);
    lines.push(`Outcome:   ${result.outcome.toUpperCase()}`);
    lines.push(`Message:   ${result.message}`);
    lines.push(`Actor:     ${result.actor}`);
    lines.push(`Reason:    ${result.reason}`);
    lines.push(
      `Command:   ${result.command.ok ? "exit 0" : `exit ${result.command.exitCode ?? "n/a"}`}${
        result.command.timedOut ? " (TIMED OUT)" : ""
      } in ${result.command.ms ?? "?"}ms`,
    );
    for (const unit of result.verification.units) {
      lines.push(`  ${unit.unit}: ${unit.state}`);
    }
    for (const check of result.verification.health.checks) {
      lines.push(`  health ${check.name}: ${check.ok ? "ok" : "FAILED"}${check.error ? ` (${check.error})` : ""}`);
    }
    if (result.audit) lines.push(`Audit:     entry #${result.audit.seq}`);
    return lines.join("\n");
  }

  if (action === "audit.list") {
    if (result.entries.length === 0) return "No audit entries.";
    return result.entries
      .map((entry) => `${entry.at}  ${entry.source}  ${entry.event}  ${entry.actor}`)
      .join("\n");
  }

  if (action === "audit.verify") {
    return result.ok
      ? `Audit chain intact: ${result.entries} entries.`
      : `AUDIT CHAIN BROKEN at entry #${result.brokenAt}: ${result.reason}`;
  }

  return JSON.stringify(result, null, 2);
}

async function main() {
  const { positional, flags } = parseFlags(process.argv.slice(2));
  assertKnownFlags(flags);

  if (flags.help || positional[0] === "help") {
    process.stdout.write(HELP);
    return 0;
  }

  // Resolving the release root can fail (a relative GRYND_RELEASE_ROOT is
  // refused), so construction is inside the error path too.
  let runtime;
  try {
    runtime = createOpsRuntime();
  } catch (error) {
    return reportError(error, "init");
  }

  if (flags.stdin) {
    let action = "unknown";
    try {
      const text = await readStdin();
      const request = parseRequest(text);
      action = typeof request.action === "string" ? request.action : "unknown";
      const { action: _action, ...fields } = request;
      validateRequest(action, fields);
      const result = await dispatch(runtime, action, fields);
      process.stdout.write(`${JSON.stringify({ action, ok: true, result })}\n`);
      return exitCodeFor(action, result);
    } catch (error) {
      return reportError(error, action);
    }
  }

  const command = positional[0];
  const json = Boolean(flags.json);

  try {
    let action;
    let request;

    switch (command) {
      case "status":
        action = "status";
        request = {};
        break;
      case "config":
        action = "config.status";
        request = {};
        break;
      case "backup":
        action = "backup.status";
        request = {};
        break;
      case "plan":
        action = "ops.plan";
        request = { operation: positional[1], actor: flags.actor };
        break;
      case "apply":
        action = "ops.apply";
        request = {
          operation: positional[1],
          token: flags.token,
          confirm: flags.confirm,
          actor: flags.actor,
          reason: flags.reason,
        };
        break;
      case "audit":
        action = "audit.list";
        request = { limit: flags.limit };
        break;
      case "audit-verify":
        action = "audit.verify";
        request = {};
        break;
      default:
        process.stdout.write(HELP);
        return 2;
    }

    validateRequest(action, request);
    const result = await dispatch(runtime, action, request);

    if (json) {
      process.stdout.write(`${JSON.stringify({ action, ok: true, result })}\n`);
    } else {
      process.stdout.write(`${renderHuman(action, result)}\n`);
    }
    return exitCodeFor(action, result);
  } catch (error) {
    return reportError(error, command ?? "unknown");
  }
}

function reportError(error, action) {
  const refused = error instanceof DeployError;
  const payload = {
    action,
    ok: false,
    code: refused ? error.code : "INTERNAL",
    message: refused ? error.message : "An unexpected error occurred. The detail was not echoed.",
  };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  if (!refused) {
    process.stderr.write(`ops: ${error?.stack ?? error}\n`);
  }
  return refused ? 2 : 1;
}

const code = await main();
process.exitCode = typeof code === "number" ? code : 1;
