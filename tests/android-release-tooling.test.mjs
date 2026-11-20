/**
 * android-release-tooling.test.mjs
 *
 * Guards the three pieces of Android release plumbing added outside Gradle:
 *
 *   1. scripts/check-android-version.mjs — the versionCode bump rule. Play
 *      refuses a reused or lowered code forever, so the comparison must be
 *      right in both directions.
 *   2. scripts/publish-play-internal.mjs — the Play Developer API payloads and
 *      the RS256 assertion. A wrong `aud`/`scope` is a confusing 400 at publish
 *      time; a wrong track body silently ships nothing.
 *   3. the workflow + dependabot contracts that tie them together: publishing is
 *      opt-in and environment-gated, secrets are passed via env and never
 *      interpolated into a shell command, and the Gradle ecosystem is
 *      configured for android/.
 *
 * Run:  npm run test:android-release
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createVerify, generateKeyPairSync } from "node:crypto";

import {
  GRADLE_FILE,
  evaluateBump,
  parseAndroidVersion,
} from "../scripts/check-android-version.mjs";
import {
  base64url,
  buildAssertionClaims,
  buildTrackBody,
  signAssertion,
} from "../scripts/publish-play-internal.mjs";

const read = (rel) => readFileSync(rel, "utf8");
const RELEASE_WORKFLOW = read(".github/workflows/android-release.yml");
const GUARD_WORKFLOW = read(".github/workflows/android-version-guard.yml");
const DEPENDABOT = read(".github/dependabot.yml");

// ── 1. versionCode guard ──────────────────────────────────────────────────

test("the committed build.gradle parses to a real versionCode and versionName", () => {
  const version = parseAndroidVersion(read(GRADLE_FILE));
  assert.equal(typeof version.versionCode, "number");
  assert.ok(version.versionCode >= 1, "versionCode must be a positive integer");
  assert.equal(typeof version.versionName, "string");
  assert.ok(version.versionName.length > 0);
});

test("a re-used or lowered versionCode is refused, a higher one passes", () => {
  const base = { versionCode: 7, versionName: "1.7.0" };

  assert.equal(evaluateBump(base, { versionCode: 8, versionName: "x" }).ok, true);
  assert.equal(evaluateBump(base, { versionCode: 70, versionName: "x" }).ok, true);

  const reused = evaluateBump(base, { versionCode: 7, versionName: "1.7.1" });
  assert.equal(reused.ok, false, "the same versionCode must fail — Play rejects it");
  assert.match(reused.reason, /still 7/);

  const lowered = evaluateBump(base, { versionCode: 6, versionName: "1.7.0" });
  assert.equal(lowered.ok, false, "a lower versionCode must fail");
  assert.match(lowered.reason, /backwards/);
});

test("the first Android release is allowed — there is no base to beat", () => {
  const verdict = evaluateBump(null, { versionCode: 1, versionName: "1.0" });
  assert.equal(verdict.ok, true);
});

test("the parse is a single literal line, not a Gradle evaluation", () => {
  const source = read("scripts/check-android-version.mjs");
  // The PR check runs without a JDK; invoking Gradle there would make the guard
  // depend on the toolchain it is meant to protect.
  assert.doesNotMatch(source, /execFileSync\("(\.\/)?gradlew?"/);
  assert.match(source, /git", \["show"/);
});

// ── 2. Play publisher ─────────────────────────────────────────────────────

test("base64url output is URL-safe and unpadded", () => {
  const encoded = base64url(Buffer.from([0xff, 0xfe, 0xfd, 0x00, 0x10]));
  assert.doesNotMatch(encoded, /[+/=]/);
});

test("the assertion claims name the Play scope and the token endpoint", () => {
  const claims = buildAssertionClaims({
    clientEmail: "sa@proj.iam.gserviceaccount.com",
    now: 1000,
  });
  assert.equal(claims.iss, "sa@proj.iam.gserviceaccount.com");
  assert.equal(claims.aud, "https://oauth2.googleapis.com/token");
  assert.equal(claims.scope, "https://www.googleapis.com/auth/androidpublisher");
  assert.equal(claims.iat, 1000);
  assert.ok(claims.exp > claims.iat, "the assertion must expire in the future");
});

test("the assertion is a verifiable RS256 JWT", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwt = signAssertion({
    clientEmail: "sa@proj.iam.gserviceaccount.com",
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }),
    now: 1_700_000_000,
  });

  const [header, claims, signature] = jwt.split(".");
  assert.equal(jwt.split(".").length, 3);
  assert.equal(JSON.parse(Buffer.from(header, "base64url").toString()).alg, "RS256");

  const verified = createVerify("RSA-SHA256")
    .update(`${header}.${claims}`)
    .verify(publicKey, Buffer.from(signature, "base64url"));
  assert.equal(verified, true, "the JWT signature must verify against the public key");
});

test("the track body stringifies versionCodes and completes the release", () => {
  const body = buildTrackBody({
    track: "internal",
    versionCodes: [42],
    notes: "  What's new  ",
  });

  assert.equal(body.track, "internal");
  assert.equal(body.releases.length, 1);
  const [release] = body.releases;
  assert.equal(release.status, "completed");
  assert.deepEqual(release.versionCodes, ["42"], "the API expects strings, not numbers");
  assert.deepEqual(release.releaseNotes, [{ language: "en-US", text: "What's new" }]);
});

test("a long note is truncated to Play's limit instead of failing the publish", () => {
  const body = buildTrackBody({
    track: "internal",
    versionCodes: ["1"],
    notes: "x".repeat(900),
  });
  assert.equal(body.releases[0].releaseNotes[0].text.length, 500);
});

test("an empty note is omitted rather than sent as an empty array entry", () => {
  const body = buildTrackBody({ track: "internal", versionCodes: ["1"], notes: "   " });
  assert.equal(body.releases[0].releaseNotes, undefined);
});

test("a malformed versionCode or track is refused before any network call", () => {
  assert.throws(() => buildTrackBody({ track: "internal", versionCodes: [] }), /at least one/);
  assert.throws(() => buildTrackBody({ track: "internal", versionCodes: ["latest"] }), /numeric/);
  assert.throws(() => buildTrackBody({ track: "", versionCodes: ["1"] }), /track/);
});

test("the publisher defaults to internal testing and never promotes to production", () => {
  const source = read("scripts/publish-play-internal.mjs");
  assert.match(source, /--track.*\|\| "internal"/, "the default track must be internal");
  assert.doesNotMatch(source, /"production"/, "production promotion is a human decision");
  assert.match(source, /edits\/\$\{editId\}:commit/, "it must commit an edit transactionally");
  assert.match(source, /method: "DELETE"/, "a failed publish must delete its open edit");
});

// ── 3. Workflow + dependabot contracts ────────────────────────────────────

test("publishing is opt-in and gated by the environment", () => {
  assert.match(RELEASE_WORKFLOW, /environment: android-play/);
  assert.match(RELEASE_WORKFLOW, /vars\.PLAY_PUBLISH_ENABLED == 'true'/);
  assert.match(
    RELEASE_WORKFLOW,
    /publish:\n\s+description:/,
    "dispatch must expose a publish input"
  );
  assert.match(RELEASE_WORKFLOW, /--track internal/);
  assert.match(RELEASE_WORKFLOW, /scripts\/publish-play-internal\.mjs/);
});

test("the release job checks versionCode against the previous tag before building", () => {
  assert.match(RELEASE_WORKFLOW, /--since-last-tag android-v/);
  // Full history is required for tags to exist in the clone.
  assert.match(RELEASE_WORKFLOW, /fetch-depth: 0/);
  const guardIndex = RELEASE_WORKFLOW.indexOf("--since-last-tag android-v");
  const buildIndex = RELEASE_WORKFLOW.indexOf("bundleRelease");
  assert.ok(
    guardIndex < buildIndex,
    "the version check must run before the 45-minute build, not after it"
  );
});

test("no secret is interpolated into a shell command", () => {
  // Secrets arrive through `env:` and are read by Node/bash at runtime. A
  // `${{ secrets.X }}` inside a run block would be expanded into the script
  // text, where a quote or backtick in the value becomes executable syntax.
  const runBlocks = [...RELEASE_WORKFLOW.matchAll(/run: \|([\s\S]*?)(?=\n {6}- |\n {2}[a-z]|$)/g)];
  assert.ok(runBlocks.length > 0, "expected to find run blocks");
  for (const [index, match] of runBlocks.entries()) {
    assert.doesNotMatch(
      match[1],
      /\$\{\{\s*secrets\./,
      `run block #${index + 1} interpolates a secret directly`
    );
  }
  assert.match(
    RELEASE_WORKFLOW,
    /PLAY_SERVICE_ACCOUNT_JSON: \$\{\{ secrets\.PLAY_SERVICE_ACCOUNT_JSON \}\}/
  );
});

test("the PR guard runs on android changes and compares against the base branch", () => {
  assert.match(GUARD_WORKFLOW, /pull_request:/);
  assert.match(GUARD_WORKFLOW, /"android\/\*\*"/);
  assert.match(GUARD_WORKFLOW, /--base "origin\/\$BASE_REF"/);
  assert.match(GUARD_WORKFLOW, /BASE_REF: \$\{\{ github\.base_ref \}\}/);
  assert.match(GUARD_WORKFLOW, /fetch-depth: 0/);
});

test("dependabot keeps the Gradle project current", () => {
  assert.match(DEPENDABOT, /package-ecosystem: gradle/);
  assert.match(DEPENDABOT, /directory: "\/android"/);
  assert.match(DEPENDABOT, /gradle-minor-patch/);
  assert.match(DEPENDABOT, /gradle-major/);
  assert.match(DEPENDABOT, /gradle-security/);
});

test("a downloaded service-account key cannot be committed", () => {
  assert.match(read(".gitignore"), /\*\*\/serviceAccount\*\.json/);
});

test("the release job compiles with the JDK level the project requires", () => {
  // Capacitor 8 generates capacitor.build.gradle with VERSION_21. A runner on
  // JDK 17 fails with "invalid source release: 21" several minutes into the
  // job, so the two numbers are pinned together here instead.
  const projectJava = read("android/app/capacitor.build.gradle").match(/VERSION_(\d+)/)?.[1];
  assert.ok(projectJava, "capacitor.build.gradle must declare a Java source level");
  const ciJava = RELEASE_WORKFLOW.match(/java-version: "(\d+)"/)?.[1];
  assert.equal(
    ciJava,
    projectJava,
    `the release workflow sets up JDK ${ciJava} but the project compiles at ${projectJava}`
  );
  assert.match(RELEASE_WORKFLOW, /distribution: temurin/);
});
