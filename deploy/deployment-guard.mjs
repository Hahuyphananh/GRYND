#!/usr/bin/env node
// deploy/deployment-guard.mjs
//
// Turns GitHub compare statuses into a deployment decision. Used by the release
// workflow both before approval (preflight) and immediately before activation.
//
//   node deploy/deployment-guard.mjs \
//     --event=push --branch=refs/heads/main \
//     --target-to-main=identical --target-to-active=behind
//
// Prints { proceed, code, reason } and exits 0; invalid input exits 2.

import process from "node:process";

import { evaluateDeploymentGuard } from "./lib/deployment-guard.mjs";

function parseFlags(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq !== -1) flags[arg.slice(2, eq)] = arg.slice(eq + 1);
    else {
      flags[arg.slice(2)] = argv[index + 1];
      index += 1;
    }
  }
  return flags;
}

const flags = parseFlags(process.argv.slice(2));
const event = flags.event ?? "push";
if (event !== "push" && event !== "workflow_dispatch") {
  process.stdout.write(`${JSON.stringify({ proceed: false, code: "INVALID_EVENT", reason: "unknown event" })}\n`);
  process.exitCode = 2;
} else {
  const decision = evaluateDeploymentGuard({
    event,
    branch: flags.branch ?? "refs/heads/main",
    targetToMain: flags["target-to-main"] ?? "",
    targetToActive: flags["target-to-active"] ?? "",
    allowOutOfOrder: flags["allow-out-of-order"] === "true",
  });
  process.stdout.write(`${JSON.stringify(decision)}\n`);
}
