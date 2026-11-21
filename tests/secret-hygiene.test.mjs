// tests/secret-hygiene.test.mjs
//
// A committed secret cannot be un-leaked by deleting the file: it stays in the
// git history forever. `realtime-server/.env` was committed once (a real Clerk
// secret key and the realtime internal secret), and removing it in a later
// commit did not remove it from clones, forks or backups. Rotation is the only
// real fix; this guard stops the same class of mistake from coming back.
//
// What it enforces, against the INDEX (git ls-files), not the working tree:
//   1. no real env file is tracked — only `*.example` / `*.sample` / `*.template`
//      placeholders may be;
//   2. no tracked text file contains a live-looking Stripe / Resend / AWS /
//      database credential or a PEM private key;
//   3. the .gitignore rules that closed the original hole (every real env file
//      and every PEM is ignored, placeholders stay committable) are still there.
//
// The test never contains a credential itself: each pattern's source cannot
// match its own regex text, and only file PATHS are printed on failure.
//
// Run: node --test tests/secret-hygiene.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const trackedFiles = () =>
  execFileSync("git", ["ls-files"], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);

/** Placeholder suffixes that mark an env file as safe to commit. */
const PLACEHOLDER_ENV = /\.(example|sample|template)$/;

/** Files too large or too noisy to scan; none may hold a real credential. */
const SKIP_SCAN = new Set(["package-lock.json"]);

/**
 * Test fixtures deliberately contain fake database URLs
 * (`postgres://user:pass@db.example`). The high-entropy patterns above still
 * scan them; only the URL heuristic is skipped here.
 */
const isTestFixture = (path) =>
  path.startsWith("tests/") ||
  path.startsWith("deploy/tests/") ||
  path.startsWith("qa/");

/**
 * Credential shapes that must never be committed. Passwords inside a Postgres
 * URL are matched separately so documentation placeholders
 * (`postgres://user:password@host`) do not trip the guard.
 */
const CREDENTIAL_PATTERNS = [
  { name: "Stripe secret key", re: /\bsk_(?:live|test)_[A-Za-z0-9]{20,}/ },
  { name: "Stripe webhook secret", re: /\bwhsec_[A-Za-z0-9]{20,}/ },
  { name: "Resend API key", re: /\bre_[A-Za-z0-9]{20,}/ },
  { name: "AWS access key id", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "PEM private key", re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
];

const POSTGRES_URL_WITH_PASSWORD =
  /postgres(?:ql)?:\/\/[^\s"'`/:]+:([^\s"'`@/]+)@/g;

/** Passwords that are obviously documentation, not a credential. */
const PLACEHOLDER_PASSWORD =
  /^(?:pass|passwd|password|secret|changeme|your[-_]?(?:password|pass|db[-_]?pass|secret)|<[^>]+>|\$\{[^}]+\})/i;

/** Read a tracked file as text, or null when it is binary / unreadable. */
function readText(path) {
  try {
    const buffer = readFileSync(path);
    // A NUL byte in the first 8 KiB is the usual binary heuristic.
    if (buffer.subarray(0, 8192).includes(0)) return null;
    return buffer.toString("utf8");
  } catch {
    return null;
  }
}

test("no real env file is tracked — only documented placeholders", () => {
  const offenders = trackedFiles().filter((path) => {
    const isEnv = /(^|\/)\.env(\.[^/]*)?$/.test(path);
    return isEnv && !PLACEHOLDER_ENV.test(path);
  });

  assert.deepEqual(
    offenders,
    [],
    `real env files must never be committed: ${offenders.join(", ")}. ` +
      "The values are in the history and must be rotated, not just deleted.",
  );

  // The files that actually leaked must stay untracked.
  const tracked = new Set(trackedFiles());
  for (const path of ["realtime-server/.env", ".env", ".env.local"]) {
    assert.equal(tracked.has(path), false, `${path} must not be tracked`);
  }
});

test("no tracked file carries a live-looking credential", () => {
  const findings = [];

  for (const path of trackedFiles()) {
    if (SKIP_SCAN.has(path)) continue;
    const text = readText(path);
    if (!text) continue;

    for (const { name, re } of CREDENTIAL_PATTERNS) {
      if (re.test(text)) findings.push(`${path}: ${name}`);
    }

    for (const match of text.matchAll(POSTGRES_URL_WITH_PASSWORD)) {
      // Fixture URLs are fake by construction; the patterns above still apply.
      if (isTestFixture(path)) break;
      const password = match[1];
      if (password.length < 8) continue;
      if (PLACEHOLDER_PASSWORD.test(password)) continue;
      findings.push(`${path}: Postgres URL with a password`);
      break;
    }
  }

  assert.deepEqual(
    findings,
    [],
    "a committed credential is permanent — keep it in the server env only:\n" +
      findings.join("\n"),
  );
});

test("the ignore rules still block env files, key material and PEMs", () => {
  const ignore = readFileSync(".gitignore", "utf8");

  for (const rule of ["**/.env", "**/.env.*", "**/*.pem", "**/*.p12", "**/*.pfx"]) {
    assert.ok(
      ignore.split(/\r?\n/).includes(rule),
      `.gitignore must keep the "${rule}" rule`,
    );
  }

  // …while documented placeholders stay committable.
  assert.ok(
    ignore.split(/\r?\n/).includes("!**/.env.example"),
    ".gitignore must keep env placeholders committable",
  );
  assert.ok(
    ignore.split(/\r?\n/).includes("!**/.env.*.example"),
    ".gitignore must keep namespaced env placeholders committable",
  );
});
