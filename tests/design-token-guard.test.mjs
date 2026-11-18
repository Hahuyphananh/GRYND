/**
 * design-token-guard.test.mjs
 *
 * Phase 0's gate, pinned. A guard only earns its keep if it does both things:
 * passes on today's tree, and fails the moment a new arbitrary colour appears.
 * A guard that only does the first is decoration, so the failure path is tested
 * in a scoped sandbox rather than asserted in a comment.
 *
 * Run: node --test tests/design-token-guard.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

const SCRIPT = resolve("scripts/check-design-tokens.mjs");

const run = (args = []) =>
  execFileSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

const scoped = (root, baseline) =>
  spawnSync(process.execPath, [SCRIPT, "--root", root, "--baseline", baseline], {
    encoding: "utf8",
  });

test("the current tree passes the guard", () => {
  const out = run();
  assert.match(out, /design-token guard: ok/);
});

test("the baseline exists and records real files", () => {
  assert.ok(
    existsSync("qa/design-token-baseline.json"),
    "the baseline must be committed, not generated at check time",
  );
  const baseline = JSON.parse(readFileSync("qa/design-token-baseline.json", "utf8"));
  const files = Object.keys(baseline.files ?? {});
  assert.ok(files.length > 10, "expected the baseline to cover the app");
  assert.equal(
    files.includes("src/app/globals.css"),
    false,
    "globals.css owns colour and must stay exempt",
  );
});

test("the guard fails on a new arbitrary colour, and accepts it once baselined", () => {
  const dir = mkdtempSync(join(tmpdir(), "grynd-guard-"));
  try {
    const src = join(dir, "src");
    mkdirSync(src, { recursive: true });
    const probe = join(src, "Probe.tsx");
    writeFileSync(
      probe,
      'export default function Probe() { return <p className="text-[#ff00ff]" />; }\n',
    );
    const baseline = join(dir, "baseline.json");

    // Empty baseline: the file is new and carries colour → must fail.
    writeFileSync(baseline, JSON.stringify({ files: {} }));
    const failed = scoped(src, baseline);
    assert.equal(failed.status, 1, "a new hex literal must fail the guard");
    assert.match(failed.stderr, /new file with 1 arbitrary colour/);

    // Baselined at its current count → passes.
    writeFileSync(baseline, JSON.stringify({ files: { [probeKey(dir)]: 1 } }));
    const passed = scoped(src, baseline);
    assert.equal(passed.status, 0, "an unchanged count must pass");

    // Baselined lower than reality → fails as an increase.
    writeFileSync(baseline, JSON.stringify({ files: { [probeKey(dir)]: 0 } }));
    const regressed = scoped(src, baseline);
    assert.equal(regressed.status, 1, "an increased count must fail");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** The key the guard derives for the probe, i.e. its path relative to cwd. */
function probeKey(dir) {
  return relative(resolve("."), resolve(dir, "src/Probe.tsx")).split(sep).join("/");
}
