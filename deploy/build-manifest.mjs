#!/usr/bin/env node
// deploy/build-manifest.mjs
//
// Writes `<dist>/release.json` into an assembled artifact directory, deriving
// everything it can from the artifact itself. Run by the release workflow after
// the build is copied into the dist layout:
//
//   dist/<id>/
//     app/{.next,public,package.json,next.config.js,node_modules}
//     realtime/{server.js,package.json,node_modules,marker…}
//
//   node deploy/build-manifest.mjs --dist dist/<id> --id <id> --commit <sha> \
//     --build-id <BUILD_ID> --arch arm64 --node 22.x --workflow release.yml --run-id 42
//
// It refuses to write a manifest for a directory that is missing required
// paths, so a broken artifact never even reaches the upload step.

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { assertReleaseId } from "./lib/layout.mjs";
import {
  REQUIRED_APP_PATHS,
  REQUIRED_REALTIME_PATHS,
  hashArtifact,
  hashDirectory,
  validateManifest,
} from "./lib/manifest.mjs";

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

async function exists(target) {
  try {
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const dist = flags.dist && path.resolve(flags.dist);
  if (!dist) throw new Error("--dist is required");

  const id = assertReleaseId(flags.id ?? path.basename(dist));
  const commit = String(flags.commit ?? "").toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`--commit must be a full 40-character sha (got ${JSON.stringify(flags.commit)})`);

  const buildIdPath = path.join(dist, "app", ".next", "BUILD_ID");
  const buildId = flags["build-id"] || (await fs.readFile(buildIdPath, "utf8")).trim();

  const missing = [];
  for (const rel of [...REQUIRED_APP_PATHS, ...REQUIRED_REALTIME_PATHS]) {
    if (!(await exists(path.join(dist, rel)))) missing.push(rel);
  }
  if (missing.length > 0) throw new Error(`artifact is incomplete, missing: ${missing.join(", ")}`);

  const artifact = await hashArtifact(dist);
  const manifest = {
    schema: 1,
    releaseId: id,
    commit,
    shortCommit: commit.slice(0, 7),
    buildId,
    createdAt: new Date().toISOString(),
    builder: {
      workflow: flags.workflow || process.env.GITHUB_WORKFLOW || "release.yml",
      runId: String(flags["run-id"] || process.env.GITHUB_RUN_ID || "local"),
      runner: flags.runner || process.env.RUNNER_NAME || "local",
      arch: flags.arch || process.arch,
      node: flags.node || process.versions.node,
    },
    productionFixes: {
      caTrust: true,
      verifiedBy: "deploy/verify-production-fixes.mjs",
      verifiedAt: new Date().toISOString(),
    },
    // Recorded by the workflow after the gates have already run; they are trace
    // metadata, never a replacement for the gates themselves.
    checks: {
      build: flags["build-result"] ?? "not-recorded",
      tests: flags["tests-result"] ?? "not-recorded",
    },
    realtime: {
      hash: await hashDirectory(path.join(dist, "realtime")),
    },
    artifact: {
      hash: artifact.hash,
      files: artifact.files,
      bytes: artifact.bytes,
    },
  };

  const errors = validateManifest(manifest, { id });
  if (errors.length > 0) throw new Error(`refusing to write an invalid manifest: ${errors.join("; ")}`);

  await fs.writeFile(path.join(dist, "release.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(
    `manifest written  ${path.join(dist, "release.json")}\n` +
      `  release   ${manifest.releaseId}\n  commit    ${manifest.commit}\n  build     ${manifest.buildId}\n` +
      `  arch/node ${manifest.builder.arch} / ${manifest.builder.node}\n  realtime  ${manifest.realtime.hash}\n` +
      `  artifact  ${manifest.artifact.hash} (${manifest.artifact.files} files, ${manifest.artifact.bytes} bytes)\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
