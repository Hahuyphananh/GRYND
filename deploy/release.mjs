#!/usr/bin/env node
// deploy/release.mjs
//
// The operator CLI for versioned GRYND releases. Zero dependencies, exit codes
// that a shell can branch on, and no way to name a release by filesystem path.
//
//   node deploy/release.mjs status
//   node deploy/release.mjs verify  20261025T143012Z-3f9c2ab
//   node deploy/release.mjs install 20261025T143012Z-3f9c2ab
//   node deploy/release.mjs activate 20261025T143012Z-3f9c2ab --actor=ops --reason="deploy"
//   node deploy/release.mjs rollback 20261024T090000Z-1a2b3c4 --confirm 20261024T090000Z-1a2b3c4 --reason="5xx spike"
//   node deploy/release.mjs prune --keep=3
//   node deploy/release.mjs env
//   node deploy/release.mjs audit --limit=20
//
// Exit codes: 0 success, 1 activation/health failure, 2 refused (validation,
// permissions, confirmation, unavailable controller).

import path from "node:path";
import process from "node:process";

import { DeployError, layout as makeLayout, releaseRoot } from "./lib/layout.mjs";
import { statusReport, installRelease, pruneReleases } from "./lib/install.mjs";
import { activateRelease, rollbackRelease } from "./lib/activate.mjs";
import { assertReleaseUsable } from "./lib/inspect.mjs";
import { createDryRunController, createSystemdController } from "./lib/services.mjs";
import { envReport, readAudit } from "./lib/state.mjs";

const USAGE = `grynd release tool

  status                              what is active, installed and verified
  verify <id>                         validate an installed release
  install <id>                        move incoming/<id> into releases/<id>
  activate <id> [--confirm <id>]      swap current, restart, health-gate
                                        --skip-if-active is a no-op when already live
  rollback <id> --confirm <id> --reason <text>
  prune [--keep 3]                    delete old releases (never active/previous)
  env                                 report managed env files (no values)
  audit [--limit 20]                  append-only activation history

Options: --root <dir>  --actor <name>  --reason <text>  --json  --dry-run
         --controller dry-run|systemd   --allow-systemd
         --app-port 3000  --realtime-port 3001  --attempts 12  --interval-ms 750

Environment: GRYND_RELEASE_ROOT (default /home/ubuntu/grynd)
             GRYND_ALLOW_SERVICE_RESTART=1 (required by the systemd controller)
`;

const REFUSAL_CODES = new Set([
  "INVALID_ID",
  "INVALID_ROOT",
  "INVALID_MANIFEST",
  "INVALID_COMMIT",
  "INVALID_KIND",
  "NOT_INSTALLED",
  "NOT_UPLOADED",
  "NOT_VERIFIED",
  "ALREADY_ACTIVE",
  "ALREADY_INSTALLED",
  "RELEASE_UNUSABLE",
  "MISSING_MANIFEST",
  "CONFIRMATION_REQUIRED",
  "REASON_REQUIRED",
  "SERVICE_CONTROL_UNAVAILABLE",
  "SERVICE_CONTROL_DISABLED",
  "CONTROLLER_NOT_ALLOWED",
  "ENV_NOT_READY",
]);

function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      positional.push(...args.slice(index + 1));
      break;
    }
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
    const next = args[index + 1];
    if (next && !next.startsWith("--")) {
      flags[body] = next;
      index += 1;
    } else {
      flags[body] = true;
    }
  }
  return { flags, positional };
}

function selectController(flags) {
  const kind = flags.controller || "dry-run";
  if (kind === "dry-run") return createDryRunController();
  if (kind === "systemd") {
    if (flags["allow-systemd"] !== true) {
      throw new DeployError(
        "--controller=systemd additionally requires --allow-systemd. Activation restarts production units; it is never implied by another flag.",
        "CONTROLLER_NOT_ALLOWED",
      );
    }
    return createSystemdController();
  }
  throw new DeployError(`Unknown --controller=${kind} (expected dry-run or systemd)`, "CONTROLLER_NOT_ALLOWED");
}

function healthOptionsFromFlags(flags) {
  const options = {};
  if (flags["app-port"]) options.appPort = Number(flags["app-port"]);
  if (flags["realtime-port"]) options.realtimePort = Number(flags["realtime-port"]);
  if (flags.attempts) options.attempts = Number(flags.attempts);
  if (flags["interval-ms"]) options.intervalMs = Number(flags["interval-ms"]);
  for (const [key, value] of Object.entries(options)) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new DeployError(`--${key} must be a positive number`, "INVALID_FLAG", { key });
    }
  }
  return options;
}

/** `--root` is a local operator convenience; it must still be absolute. */
function resolveRootFlag(value) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new DeployError(`--root must be an absolute path (got ${JSON.stringify(value)})`, "INVALID_ROOT");
  }
  return path.resolve(value);
}

/** A failed activation/rollback is reported in full: stage, checks, revert outcome. */
function printFailure(action, result) {
  const lines = [];
  lines.push(`✗ ${action} FAILED  ${result.releaseId}  (stage: ${result.stage || "unknown"})`);
  if (result.error) lines.push(`  error     ${result.error}`);
  if (result.health) {
    for (const check of result.health.checks || []) {
      lines.push(`  health    ${check.name}: ${check.ok ? "ok" : `FAILED (${check.error ?? check.status})`}`);
    }
  }
  if (result.revert) {
    const target = result.revert.target || "(no previous release)";
    const state = result.revert.error
      ? `REVERT FAILED: ${result.revert.error}`
      : result.revert.health?.ok
        ? "revert verified healthy"
        : "revert health gate FAILED";
    lines.push(`  revert    ${target}: ${state}`);
    if (!result.revert.error && result.revert.health?.ok === false) {
      lines.push(`  action    current is NOT verified healthy — investigate before retrying`);
    }
  }
  lines.push(`  audit     state/audit.jsonl  attempt ${result.attemptId || "?"}`);
  process.stderr.write(`${lines.join("\n")}\n`);
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printStatus(report) {
  const lines = [];
  lines.push(`root      ${report.root}`);
  const currentLabel = report.current?.broken
    ? `BROKEN (${report.current.reason})`
    : report.current?.id || "(none)";
  lines.push(`current   ${currentLabel}`);
  lines.push(`previous  ${report.previous?.id || "(none)"}`);
  lines.push(`active    ${report.active ? `${report.active.releaseId} @ ${report.active.activatedAt} (${report.active.kind} by ${report.active.actor})` : "(no activation record)"}`);
  if (report.active?.health) {
    const checks = (report.active.health.checks || []).map((check) => `${check.name}:${check.ok ? "ok" : "fail"}(${check.status ?? check.error})`).join(" ");
    lines.push(`health    ${checks || "(none)"}`);
  }
  lines.push("");
  lines.push("releases");
  if (report.releases.length === 0) lines.push("  (none)");
  for (const release of report.releases) {
    const marks = [release.verified ? "verified" : "unverified"];
    if (release.id === report.current?.id) marks.push("current");
    if (release.id === report.previous?.id) marks.push("previous");
    lines.push(`  ${release.id}  ${release.commit?.slice(0, 7) ?? "?"}  build ${release.buildId ?? "?"}  [${marks.join(", ")}]`);
  }
  lines.push("");
  lines.push("env files (never printed)");
  for (const entry of report.envFiles) {
    lines.push(
      entry.present
        ? `  ${entry.name}  ${entry.bytes} bytes  mode ${entry.mode ?? "n/a (windows)"}  ${entry.ok ? "ok" : "CHECK"}`
        : `  ${entry.name}  MISSING`,
    );
  }
  if (report.audit.length > 0) {
    lines.push("");
    lines.push("recent activity");
    for (const entry of report.audit) {
      lines.push(`  ${entry.at}  ${entry.event}  ${entry.releaseId ?? "-"}  ${entry.outcome}${entry.stage ? ` (${entry.stage})` : ""}`);
    }
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

async function main(argv) {
  const [command, ...rest] = argv;
  const { flags, positional } = parseFlags(rest);
  const json = flags.json === true;
  const dryRun = flags["dry-run"] === true;

  if (!command || command === "help" || flags.help === true) {
    process.stdout.write(USAGE);
    return 0;
  }

  const root = flags.root ? resolveRootFlag(flags.root) : releaseRoot();
  const l = makeLayout(root);
  const actor = flags.actor || process.env.USER || process.env.LOGNAME || "unknown";
  const id = positional[0];

  switch (command) {
    case "status": {
      const report = await statusReport({ root });
      if (json) printJson(report);
      else printStatus(report);
      return 0;
    }
    case "verify": {
      const report = await assertReleaseUsable(l, id);
      if (json) printJson({ ok: true, id, commit: report.manifest.commit, buildId: report.buildId, realtimeHash: report.realtimeHash, arch: report.manifest.builder?.arch, node: report.manifest.builder?.node });
      else process.stdout.write(`ok  ${id}  commit ${report.manifest.commit}  build ${report.buildId}  arch ${report.manifest.builder?.arch}  node ${report.manifest.builder?.node}\n`);
      return 0;
    }
    case "install": {
      const result = await installRelease({ root, id, actor });
      if (json) printJson(result);
      else process.stdout.write(`installed  ${result.id}  commit ${result.manifest.commit}  build ${result.buildId}\n`);
      return 0;
    }
    case "activate": {
      const result = await activateRelease({
        root,
        id,
        actor,
        reason: flags.reason || "",
        kind: "deploy",
        skipIfActive: flags["skip-if-active"] === true,
        controller: selectController(flags),
        healthOptions: healthOptionsFromFlags(flags),
      });
      if (json) printJson(result);
      else if (result.ok && result.skipped) {
        process.stdout.write(`already active  ${result.releaseId}  (${result.skipReason})\n`);
      } else if (result.ok) {
        process.stdout.write(
          `activated  ${result.releaseId}${result.previousReleaseId ? ` (from ${result.previousReleaseId})` : ""}\n` +
            `health     ${result.health.checks.map((c) => `${c.name}:${c.status}`).join(" ")}  pointer ${result.active.pointer.strategy}\n`,
        );
      } else {
        printFailure("activation", result);
      }
      return result.ok ? 0 : 1;
    }
    case "rollback": {
      const result = await rollbackRelease({
        root,
        id,
        actor,
        reason: flags.reason || "",
        confirm: flags.confirm === true ? null : flags.confirm ?? null,
        controller: selectController(flags),
        healthOptions: healthOptionsFromFlags(flags),
      });
      if (json) printJson(result);
      else if (result.ok) {
        process.stdout.write(
          `rolled back  ${result.previousReleaseId ?? "(none)"} -> ${result.releaseId}\n` +
            `health       ${result.health.checks.map((c) => `${c.name}:${c.status}`).join(" ")}\n`,
        );
      } else {
        printFailure("rollback", result);
      }
      return result.ok ? 0 : 1;
    }
    case "prune": {
      const result = await pruneReleases({ root, keep: Number(flags.keep || 3), actor, dryRun });
      if (json) printJson(result);
      else {
        process.stdout.write(
          `${dryRun ? "would remove" : "removed"}  ${result.removed.length === 0 ? "(nothing)" : result.removed.join(", ")}\n` +
            `kept       ${result.total - result.removed.length} of ${result.total} (keep >= ${result.keep}, protected: ${result.protected.join(", ") || "none"})\n`,
        );
      }
      return 0;
    }
    case "env": {
      const report = await envReport(l);
      if (json) printJson(report);
      else {
        for (const entry of report) {
          process.stdout.write(
            entry.present
              ? `${entry.name}  ${entry.bytes} bytes  mode ${entry.mode ?? "n/a (windows)"}  ${entry.ok ? "ok" : "CHECK"}  ${entry.path}\n`
              : `${entry.name}  MISSING  ${entry.path}\n`,
          );
        }
      }
      return report.every((entry) => entry.ok) ? 0 : 1;
    }
    case "audit": {
      const limit = Number(flags.limit || 20);
      const entries = await readAudit(l, { limit });
      if (json) printJson(entries);
      else if (entries.length === 0) process.stdout.write("(no audit entries)\n");
      else for (const entry of entries) process.stdout.write(`${JSON.stringify(entry)}\n`);
      return 0;
    }
    default: {
      process.stderr.write(`Unknown command ${JSON.stringify(command)}\n\n${USAGE}`);
      return 2;
    }
  }
}

try {
  const code = await main(process.argv.slice(2));
  process.exitCode = code;
} catch (error) {
  const code = error instanceof DeployError ? error.code : null;
  if (process.argv.includes("--json")) {
    printJson({ ok: false, code, error: error.message, details: error.details ?? null });
  } else {
    process.stderr.write(`✗ ${error.message}\n`);
  }
  if (code && REFUSAL_CODES.has(code)) process.exitCode = 2;
  else if (code === "HEALTH_GATE_FAILED") process.exitCode = 1;
  else process.exitCode = 2;
}
