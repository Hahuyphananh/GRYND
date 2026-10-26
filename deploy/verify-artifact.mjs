#!/usr/bin/env node
// deploy/verify-artifact.mjs
//
// Gate #3 of the release workflow: the assembled artifact must be complete,
// self-consistent and free of secrets before it is uploaded. It applies the
// same checks the host will apply at install time, so a failing artifact is
// never shipped.
//
//   node deploy/verify-artifact.mjs --dist dist/<id> --arch arm64 --node 22.11.0

import path from "node:path";
import process from "node:process";

import { inspectRelease } from "./lib/inspect.mjs";

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

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const dist = flags.dist && path.resolve(flags.dist);
  if (!dist) throw new Error("--dist is required");

  const report = await inspectRelease(dist, {
    id: path.basename(dist),
    arch: flags.arch || process.arch,
    node: flags.node || process.versions.node,
  });

  if (flags.json === "true" || flags.json === true) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`artifact  ${dist}\n`);
    process.stdout.write(`  manifest  ${report.manifest ? "ok" : "INVALID"}\n`);
    process.stdout.write(`  build     ${report.buildId ?? "?"}\n`);
    process.stdout.write(`  arch/node ${report.manifest?.builder?.arch ?? "?"} / ${report.manifest?.builder?.node ?? "?"}\n`);
    process.stdout.write(`  artifact  ${report.artifactHash ?? "?"}\n`);
    process.stdout.write(`  realtime  ${report.realtimeHash ?? "?"}\n`);
    for (const warning of report.warnings) process.stdout.write(`  warn      ${warning}\n`);
    for (const error of report.errors) process.stdout.write(`  FAIL      ${error}\n`);
  }

  if (!report.ok) {
    process.stderr.write("\nArtifact rejected; refusing to upload or deploy it.\n");
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
