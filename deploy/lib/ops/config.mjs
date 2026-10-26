// deploy/lib/ops/config.mjs
//
// Configuration status, deliberately blind.
//
// The dashboard must be able to answer "is this host configured correctly?"
// without ever being able to answer "what is the value?". This module returns
// presence, permissions, key NAMES, and one boolean per key saying whether its
// value passes a coarse rule. It never returns a value, a prefix, a length or a
// hash of one — a hash of a low-entropy value is still a lookup table.
//
// The one place a value exists is inside `checkKeys`, which reads the file,
// evaluates each required key and returns nothing but verdicts. The parsed map
// is local to that function and never escapes; the returned object is built
// field by field, so there is no spreading of parsed state.
//
// Secret replacement is NOT implemented here. See ops-permissions.md §5 for what
// a reviewed version would require (reauthentication, atomic write, ownership
// preservation, validated activation, recoverable prior file) and why it is
// gated behind a separate design review.

import fs from "node:fs/promises";

import { envReport } from "../state.mjs";

/**
 * Coarse shape rules. Each answers "is this plausibly the right KIND of value",
 * which is enough to catch an empty file, a placeholder left in place, or a key
 * pasted into its neighbour's slot — without disclosing anything.
 */
const RULES = Object.freeze({
  "postgres-url": {
    why: "must start with postgres:// or postgresql:// and name a database",
    test: (value) => /^postgres(ql)?:\/\/.+/i.test(value),
  },
  "clerk-secret": { why: "must start with sk_", test: (value) => /^sk_/.test(value) },
  "clerk-publishable": { why: "must start with pk_", test: (value) => /^pk_/.test(value) },
  "http-url": { why: "must be an http(s) URL", test: (value) => /^https?:\/\//i.test(value) },
  "long-secret": { why: "must be at least 16 characters", test: (value) => value.length >= 16 },
  port: {
    why: "must be an integer between 1 and 65535",
    test: (value) => /^\d{1,5}$/.test(value) && Number(value) >= 1 && Number(value) <= 65535,
  },
  "non-empty": { why: "must not be empty", test: (value) => value.length > 0 },
});

/**
 * The keys each managed file must define, mirroring `.env.example` plus the
 * variables the realtime server reads (realtime-server/server.js). Names only:
 * this table is safe to render and is the dashboard's "required keys" list.
 */
export const REQUIRED_CONFIG = Object.freeze({
  "app.env": Object.freeze([
    { key: "DATABASE_URL", rule: "postgres-url" },
    { key: "CLERK_SECRET_KEY", rule: "clerk-secret" },
    { key: "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", rule: "clerk-publishable" },
    { key: "NEXT_PUBLIC_SOCKET_URL", rule: "http-url" },
    { key: "REALTIME_INTERNAL_URL", rule: "http-url" },
    { key: "REALTIME_INTERNAL_SECRET", rule: "long-secret" },
  ]),
  "realtime.env": Object.freeze([
    { key: "PORT", rule: "port" },
    { key: "CLERK_SECRET_KEY", rule: "clerk-secret" },
    { key: "REALTIME_INTERNAL_SECRET", rule: "long-secret" },
  ]),
});

/**
 * Parse a dotenv-style file. Handles comments, blank lines, `export `, CRLF and
 * quoted values. Malformed lines are counted, never echoed.
 */
export function parseEnvFile(text) {
  const map = new Map();
  let malformed = 0;

  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;

    const withoutExport = line.startsWith("export ") ? line.slice(7).trim() : line;
    const eq = withoutExport.indexOf("=");
    if (eq <= 0) {
      malformed += 1;
      continue;
    }

    const key = withoutExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      malformed += 1;
      continue;
    }

    let value = withoutExport.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    map.set(key, value);
  }

  return { map, malformed };
}

/**
 * Evaluate the required keys of one file.
 *
 * @returns {Promise<{ readable: boolean, malformedLines: number, keys: Array<object> }>}
 *   Verdicts only. The parsed values do not leave this function.
 */
async function checkKeys(file, requirements) {
  let text;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    return {
      readable: false,
      malformedLines: 0,
      keys: requirements.map(({ key, rule }) => ({
        key,
        rule,
        present: false,
        valid: false,
        reason: error.code === "ENOENT" ? "missing" : "unreadable",
      })),
    };
  }

  const { map, malformed } = parseEnvFile(text);
  const keys = requirements.map(({ key, rule }) => {
    if (!map.has(key)) return { key, rule, present: false, valid: false, reason: "missing" };
    const value = map.get(key);
    if (value.length === 0) return { key, rule, present: true, valid: false, reason: "empty" };
    const passes = RULES[rule]?.test(value) === true;
    return {
      key,
      rule,
      present: true,
      valid: passes,
      reason: passes ? null : "format",
    };
  });

  return { readable: true, malformedLines: malformed, keys };
}

/**
 * The redacted status view.
 *
 * `ok` is true only when every managed file is present, correctly permissioned,
 * outside a release, and every required key is present and well-formed.
 */
export async function configStatus({ layout, platform = process.platform } = {}) {
  const files = await envReport(layout, { platform });

  const reportFiles = [];
  let keysOk = 0;
  let keysTotal = 0;

  for (const file of files) {
    const requirements = REQUIRED_CONFIG[file.name] ?? [];
    const keysTotalForFile = requirements.length;

    let verdicts = {
      readable: false,
      malformedLines: 0,
      keys: requirements.map(({ key, rule }) => ({
        key,
        rule,
        present: false,
        valid: false,
        reason: "missing",
      })),
    };

    // Only read a file that exists and is non-empty; an unreadable file is a
    // finding, not an exception.
    if (file.present && file.bytes > 0) {
      verdicts = await checkKeys(
        file.path ?? layout.appEnv,
        requirements,
      );
    }

    let owner = null;
    if (file.present && platform !== "win32") {
      try {
        const stat = await fs.stat(file.path ?? layout.appEnv);
        owner = { uid: stat.uid, gid: stat.gid };
      } catch {
        owner = null;
      }
    }

    const validKeys = verdicts.keys.filter((entry) => entry.valid).length;
    keysOk += validKeys;
    keysTotal += keysTotalForFile;

    reportFiles.push({
      name: file.name,
      path: file.path,
      present: file.present,
      bytes: file.present ? file.bytes : 0,
      mode: file.mode ?? null,
      modeOk: Boolean(file.modeOk),
      owner,
      insideRelease: Boolean(file.insideRelease),
      readable: verdicts.readable,
      malformedLines: verdicts.malformedLines,
      keys: verdicts.keys,
      keysValid: validKeys,
      keysRequired: keysTotalForFile,
      ok:
        Boolean(file.present) &&
        file.bytes > 0 &&
        Boolean(file.modeOk) &&
        !file.insideRelease &&
        verdicts.readable &&
        verdicts.malformedLines === 0 &&
        validKeys === keysTotalForFile,
    });
  }

  return {
    ok: reportFiles.every((file) => file.ok),
    files: reportFiles,
    // The required-key list, by name: safe to render, useful for an operator
    // who is writing the file, and impossible to reconstruct a value from.
    requiredKeys: Object.fromEntries(
      Object.entries(REQUIRED_CONFIG).map(([name, entries]) => [
        name,
        entries.map(({ key, rule }) => ({ key, rule, why: RULES[rule]?.why ?? "" })),
      ]),
    ),
    summary: {
      files: reportFiles.length,
      filesOk: reportFiles.filter((file) => file.ok).length,
      keys: keysTotal,
      keysOk,
      keysMissing: reportFiles.flatMap((file) => file.keys).filter((key) => !key.present).length,
      keysInvalid: reportFiles.flatMap((file) => file.keys).filter((key) => key.present && !key.valid).length,
    },
    disclosure: "Values are never read into this view. Only presence, permissions and per-key format verdicts are reported.",
  };
}
