// tests/tsx-loader-named-exports.test.mjs
//
// REGRESSION GUARD for the release pipeline outage of 2026-10-27.
//
// `npm test` runs every test file through `node --import tsx` because the tests
// import application modules that are TypeScript (`.ts`) or ESM-authored
// JavaScript (`.js`) inside a CommonJS package. With tsx 4.22.1 — the version
// `"tsx": "^4.19.3"` had drifted to in package-lock.json — the loader's ESM
// hooks served each of those modules to Node as `format: "commonjs"` together
// with a `data:text/javascript,...?filePath=...` responseURL, and Node could no
// longer recover their ES named exports. Every
//
//   import { thing } from "../src/lib/whatever";   // any local .js or .ts
//
// then threw
//
//   SyntaxError: The requested module '../src/lib/whatever' does not provide an
//   export named 'thing'
//
// which took out 22 of the 40 files in `npm test` on the `ubuntu-24.04-arm`
// release runner. It was reported as an arm64 problem, but it was not platform
// specific at all: the same failure reproduces on Windows with Node 22.23.3, and
// the same tree passes under Node 24 because that Node hands the module to its
// own loader instead. tsx 4.23.15 fixes the loader.
//
// So this guard exercises the real loader on real files in a child process: it
// fails in one readable place if a future tsx (or Node) again loses named
// exports, instead of as 22 file-level `not ok`s deep in the release log.
//
// Run it on its own with:
//   node --import tsx --test tests/tsx-loader-named-exports.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const FIXTURE = join("tests", "fixtures", "tsx-loader", "tsx-loader-fixture.mjs");

test("`node --import tsx` keeps the named exports of local .js and .ts modules", () => {
  // node:test sets NODE_TEST_CONTEXT in every test child process. Inheriting it
  // would make the fixture believe it is a nested run and skip its own tests,
  // so the guard would "pass" without exercising anything.
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;

  const run = spawnSync(
    process.execPath,
    ["--import", "tsx", "--test", "--test-reporter=tap", FIXTURE],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: childEnv,
      timeout: 120_000,
    },
  );

  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;

  if (run.error) {
    assert.fail(`could not start the loader fixture with ${process.execPath}: ${run.error.message}`);
  }

  // A loader that loses named exports prints the SyntaxError and exits non-zero,
  // so surface the child's own output to make the cause obvious.
  assert.equal(
    run.status,
    0,
    `\`node --import tsx\` could not load the fixture's named exports (exit ${run.status}).\n` +
      `The tsx loader or the Node version changed. Fixture: ${FIXTURE}\n\n${output}`,
  );

  // Guard against a "pass" that ran nothing: the fixture has exactly two tests.
  assert.match(output, /^# pass 2\b/m, `the fixture did not report 2 passing tests:\n\n${output}`);
  assert.match(output, /^# fail 0\b/m, `the fixture reported failures:\n\n${output}`);
});
