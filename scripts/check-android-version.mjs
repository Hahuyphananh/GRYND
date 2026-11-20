#!/usr/bin/env node
/**
 * scripts/check-android-version.mjs
 *
 * Guards the one Android number Google Play never forgives: `versionCode`.
 *
 * Play refuses an upload that reuses or lowers a versionCode, for every track,
 * permanently — including codes burned by a rejected or rolled-back release.
 * The failure is not visible until someone is uploading a bundle to production,
 * which is the worst possible moment to discover it. So the comparison happens
 * in review instead:
 *
 *   * pull requests touching android/ run this against the PR's base branch;
 *   * the release workflow runs it against the previous `android-v*` tag.
 *
 * `versionName` is NOT checked. It is cosmetic ("1.4.0", "1.4.0-rc2" and
 * "banana" are all legal), so requiring it to change would be noise.
 *
 * USAGE
 *   node scripts/check-android-version.mjs --base origin/main
 *   node scripts/check-android-version.mjs --since-last-tag android-v
 *   node scripts/check-android-version.mjs --print
 *
 * Exit 0 when the bump is legal or there is nothing to compare against (a
 * first release has no predecessor), 1 when it is not.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const GRADLE_FILE = "android/app/build.gradle";

/**
 * Read versionCode / versionName out of android/app/build.gradle.
 *
 * Deliberately a parse of the single `defaultConfig` block rather than a
 * `gradle properties` call: this runs in a 5-second PR check with no JDK, and
 * the values are two literal lines.
 */
export function parseAndroidVersion(source) {
  const code = source.match(/^\s*versionCode\s+(\d+)\s*$/m);
  const name = source.match(/^\s*versionName\s+"([^"]*)"/m);
  if (!code) {
    throw new Error(`no "versionCode <number>" line found in ${GRADLE_FILE}`);
  }
  if (!name) {
    throw new Error(`no "versionName \\"...\\"" line found in ${GRADLE_FILE}`);
  }
  return { versionCode: Number(code[1]), versionName: name[1] };
}

/**
 * Decide whether `head` may be uploaded after `base`.
 *
 * `base === null` means there is no previous release (first upload, or no tag
 * yet), which is always allowed — requiring a bump would make the first
 * Android release impossible to ship.
 */
export function evaluateBump(base, head) {
  if (!base) {
    return { ok: true, reason: "no previous release to compare against" };
  }
  if (head.versionCode > base.versionCode) {
    return { ok: true, reason: `versionCode ${base.versionCode} → ${head.versionCode}` };
  }
  if (head.versionCode === base.versionCode) {
    return {
      ok: false,
      reason: `versionCode is still ${head.versionCode} — Play rejects a reused code on every track, forever`,
    };
  }
  return {
    ok: false,
    reason: `versionCode went backwards: ${base.versionCode} → ${head.versionCode} — Play refuses a lower code`,
  };
}

/** Highest `android-v*` tag, or null when the repository has none. */
export function latestAndroidTag(prefix = "android-v") {
  try {
    const out = execFileSync("git", ["tag", "--list", `${prefix}*`, "--sort=-v:refname"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out ? out.split("\n")[0] : null;
  } catch {
    return null;
  }
}

/** The committed version at a git ref, so a PR is compared to base, not HEAD. */
export function versionAtRef(ref, file = GRADLE_FILE) {
  const source = execFileSync("git", ["show", `${ref}:${file}`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return parseAndroidVersion(source);
}

function main(argv) {
  const arg = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : null;
  };

  const file = arg("--file") || GRADLE_FILE;
  const baseRef = arg("--base");
  const sinceTag = arg("--since-last-tag");

  const head = parseAndroidVersion(readFileSync(file, "utf8"));

  if (argv.includes("--print")) {
    console.log(`${head.versionName} (versionCode ${head.versionCode})`);
    return;
  }

  let base = null;
  let label = "";
  if (baseRef) {
    base = versionAtRef(baseRef, file);
    label = baseRef;
  } else if (sinceTag) {
    const tag = latestAndroidTag(sinceTag);
    if (tag) {
      base = versionAtRef(tag, file);
      label = tag;
    }
  }

  const verdict = evaluateBump(base, head);

  if (verdict.ok) {
    const against = base ? ` against ${label} (${base.versionCode})` : "";
    console.log(`✔ versionCode ${head.versionCode}${against} — ${verdict.reason}`);
    return;
  }

  console.error(`::error::${verdict.reason}`);
  console.error(
    "Bump `versionCode` in android/app/build.gradle before this ships. " +
      "A rejected or rolled-back upload consumes its code too, so the number only ever moves forward."
  );
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
