// deploy/staging/build-fixture.mjs
//
// Builds a complete, verifiable release tree in `<root>/incoming/<id>` — the same
// shape the real workflow uploads, with every path REQUIRED_* insists on.
// Used only by the staging simulation.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { makeReleaseId } from "../lib/layout.mjs";
import { hashArtifact, hashDirectory } from "../lib/manifest.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_APP = path.join(HERE, "fixture", "app", "server.mjs");
const FIXTURE_REALTIME = path.join(HERE, "fixture", "realtime", "server.js");

async function write(file, contents) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, contents);
}

/**
 * @param {object} options
 * @param {string} options.incomingDir `<root>/incoming/<id>`
 * @param {string} options.id release id
 * @param {string} [options.commit] full sha (defaults to a derived one)
 * @param {string} [options.buildId]
 * @param {"ok"|"unhealthy"} [options.variant]
 */
export async function buildFixtureRelease({
  incomingDir,
  id,
  commit,
  buildId,
  variant = "ok",
  createdAt = new Date().toISOString(),
} = {}) {
  const short = id.slice(id.indexOf("-") + 1);
  const fullCommit = commit ?? `${short}${"0".repeat(40 - short.length)}`;
  const resolvedBuildId = buildId ?? `fixture-build-${id}`;

  // app/
  await write(path.join(incomingDir, "app", ".next", "BUILD_ID"), `${resolvedBuildId}\n`);
  await write(path.join(incomingDir, "app", ".next", "static", `asset-${resolvedBuildId}.txt`), `static asset for ${resolvedBuildId}\n`);
  await write(path.join(incomingDir, "app", "public", "index.txt"), "public dir\n");
  await write(path.join(incomingDir, "app", "package.json"), JSON.stringify({ name: "fixture-app", private: true, version: "1.0.0" }, null, 2));
  await write(path.join(incomingDir, "app", "next.config.js"), "module.exports = {};\n");
  await write(path.join(incomingDir, "app", "node_modules", "next", "package.json"), JSON.stringify({ name: "next", version: "16.0.0-fixture" }, null, 2));
  await write(path.join(incomingDir, "app", "health-mode.txt"), `${variant === "unhealthy" ? "fail" : "ok"}\n`);
  await fs.copyFile(FIXTURE_APP, path.join(incomingDir, "app", "server.mjs"));

  // realtime/
  await write(path.join(incomingDir, "realtime", "package.json"), JSON.stringify({ name: "casino-realtime-server", version: "1.0.0-fixture" }, null, 2));
  await write(path.join(incomingDir, "realtime", "node_modules", "express", "package.json"), JSON.stringify({ name: "express", version: "5.2.1-fixture" }));
  await write(path.join(incomingDir, "realtime", "node_modules", "socket.io", "package.json"), JSON.stringify({ name: "socket.io", version: "4.8.1-fixture" }));
  await write(path.join(incomingDir, "realtime", "marker.txt"), `${id}\n`);
  await fs.copyFile(FIXTURE_REALTIME, path.join(incomingDir, "realtime", "server.js"));

  const realtimeHash = await hashDirectory(path.join(incomingDir, "realtime"));
  const artifact = await hashArtifact(incomingDir);

  const manifest = {
    schema: 1,
    releaseId: id,
    commit: fullCommit,
    shortCommit: short,
    buildId: resolvedBuildId,
    createdAt,
    builder: {
      workflow: "staging-simulation",
      runId: "local",
      runner: "local",
      arch: process.arch,
      node: process.versions.node,
    },
    productionFixes: { caTrust: true, verifiedBy: "deploy/staging/build-fixture.mjs" },
    checks: { build: "passed", tests: "passed" },
    realtime: { hash: realtimeHash },
    artifact: { hash: artifact.hash, files: artifact.files, bytes: artifact.bytes },
  };

  await write(path.join(incomingDir, "release.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  return { id, dir: incomingDir, manifest, buildId: resolvedBuildId, commit: fullCommit, realtimeHash };
}

/** Convenience: id derived from a fixed timestamp so the simulation is readable. */
export function fixtureId({ at, sha }) {
  return makeReleaseId({ date: new Date(at), commit: sha });
}
