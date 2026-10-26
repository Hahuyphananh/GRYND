#!/usr/bin/env node
// deploy/verify-production-fixes.mjs
//
// Gate #1 of the release workflow: the commit must contain the reviewed
// production fixes, because a release built from a tree without them is not the
// thing that currently runs (or would run unsafely).
//
// The policy lives in deploy/production-fixes.json and is checked against the
// checked-out tree. Nothing here reads the production VM.
//
//   node deploy/verify-production-fixes.mjs
//   node deploy/verify-production-fixes.mjs --json

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");

/**
 * Evaluate the policy against a set of file contents.
 *
 * @param {object} policy parsed production-fixes.json
 * @param {(relPath: string) => string|null} readFile contents, or null when absent
 * @returns {{ ok: boolean, results: Array<{id: string, file: string, ok: boolean, problems: string[]}> }}
 */
export function verifyProductionFixes(policy, readFile) {
  const results = [];

  for (const fix of policy.fixes ?? []) {
    const problems = [];
    for (const file of [fix.file, ...(fix.alsoRequires ?? [])]) {
      const contents = readFile(file);
      if (contents === null) {
        problems.push(`${file} is missing`);
        continue;
      }
      for (const pattern of fix.mustNotMatch ?? []) {
        if (new RegExp(pattern, "m").test(contents)) {
          problems.push(`${file} matches forbidden /${pattern}/ — ${fix.title}`);
        }
      }
      for (const pattern of fix.mustMatch ?? []) {
        if (!new RegExp(pattern, "m").test(contents)) {
          problems.push(`${file} does not match required /${pattern}/ — ${fix.title}`);
        }
      }
    }
    results.push({ id: fix.id, file: fix.file, ok: problems.length === 0, problems });
  }

  return { ok: results.every((result) => result.ok), results };
}

function main() {
  const policy = JSON.parse(fs.readFileSync(path.join(HERE, "production-fixes.json"), "utf8"));
  const cache = new Map();

  const readFile = (relPath) => {
    if (!cache.has(relPath)) {
      try {
        cache.set(relPath, fs.readFileSync(path.join(REPO_ROOT, relPath), "utf8"));
      } catch {
        cache.set(relPath, null);
      }
    }
    return cache.get(relPath);
  };

  const { ok, results } = verifyProductionFixes(policy, readFile);

  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify({ ok, results }, null, 2)}\n`);
  } else {
    for (const result of results) {
      process.stdout.write(`${result.ok ? "ok  " : "FAIL"}  ${result.id}  (${result.file})\n`);
      for (const problem of result.problems) process.stdout.write(`        ${problem}\n`);
    }
  }

  if (!ok) {
    process.stderr.write(
      "\nRelease blocked: the commit does not contain every reviewed production fix.\n" +
        "Commit the fix (and update deploy/production-fixes.json in the same commit if the\n" +
        "reviewed form changed) before building a release.\n",
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  }
}
