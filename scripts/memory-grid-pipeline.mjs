#!/usr/bin/env node
// scripts/memory-grid-pipeline.mjs
//
// `npm run pipeline:memory-grid` — every gate the Memory Grid package needs, in
// the order they have to pass, with the time each one took.
//
//   1. the unit suite: engine parity, the local controller, the UI markup, the
//      CTA on/off rendering and the bundle-isolation walk
//   2. the itch package: build with the CTA forced on, verify the build, zip it,
//      read the archive back
//   3. the archive verification: CRC-check every entry, prove what a portal
//      receives, extract it, and play a whole match in an offline Chrome
//
// A failing stage stops the run, so a red result can never be reported as a
// verified package. `-- --no-browser` passes through to stage 3 for a fast,
// static-only run.
//
// Nothing here uploads anything.

import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";

const ROOT = process.cwd();
const passthrough = process.argv.slice(2);

const STAGES = [
  {
    name: "unit tests",
    detail: "tests/memory-grid-standalone.test.mjs",
    args: ["--import", "tsx", "--test", "tests/memory-grid-standalone.test.mjs"],
  },
  {
    name: "package",
    detail: "build + zip + read-back",
    args: ["scripts/package-itch-memory-grid.mjs"],
  },
  {
    name: "verify",
    detail: "archive + offline full match",
    args: ["scripts/verify-itch-memory-grid.mjs", ...passthrough],
  },
];

const startedAt = performance.now();
const results = [];
let failed = false;

for (const [index, stage] of STAGES.entries()) {
  if (failed) {
    results.push({ ...stage, seconds: null, status: null, skipped: true });
    continue;
  }

  console.log(`\n━━━ ${index + 1}/${STAGES.length}  ${stage.name} — ${stage.detail} ━━━\n`);

  const stageStart = performance.now();
  const run = spawnSync(process.execPath, stage.args, { cwd: ROOT, stdio: "inherit" });
  const seconds = (performance.now() - stageStart) / 1000;

  if (run.error) {
    console.error(`\nFAIL  ${stage.name} could not start: ${run.error.message}`);
  }

  results.push({ ...stage, seconds, status: run.status ?? 1, skipped: false });
  if (run.status !== 0) failed = true;
}

const total = (performance.now() - startedAt) / 1000;
const time = (seconds) => (seconds === null ? "—" : `${seconds.toFixed(1)} s`);

console.log("\n━━━ summary ━━━\n");
const width = Math.max(...results.map((entry) => entry.name.length));
console.log(`  ${"stage".padEnd(width)}  ${"time".padStart(7)}  result`);
for (const entry of results) {
  const status = entry.skipped ? "skipped" : entry.status === 0 ? "pass" : "FAIL";
  console.log(`  ${entry.name.padEnd(width)}  ${time(entry.seconds).padStart(7)}  ${status}`);
}
console.log(`  ${"─".repeat(width + 22)}`);
console.log(`  ${"total".padEnd(width)}  ${time(total).padStart(7)}  ${failed ? "FAIL" : "pass"}`);

if (failed) {
  const skipped = results.filter((entry) => entry.skipped).map((entry) => entry.name);
  console.error(
    `\nFAILED — the package is not verified.` +
      (skipped.length ? `\nStopped before: ${skipped.join(", ")}.` : "") +
      "\nNothing has been uploaded.\n",
  );
  process.exit(1);
}

console.log(
  `\nPASS — tests green, archive verified, and the extracted copy played a full` +
    `\nmatch offline. dist/packages/memory-grid-itch.zip is ready to upload.` +
    `\nNothing has been uploaded.\n`,
);
