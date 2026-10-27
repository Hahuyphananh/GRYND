/**
 * deploy/tests/policy.test.mjs — the promises that are enforced outside the
 * runtime: the production-fix gate, the shape of the release workflow, and the
 * systemd units this layout depends on.
 *
 * Run: node --test deploy/tests/
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { verifyProductionFixes } from "../verify-production-fixes.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEPLOY = path.resolve(HERE, "..");
const REPO = path.resolve(DEPLOY, "..");

const policy = JSON.parse(fs.readFileSync(path.join(DEPLOY, "production-fixes.json"), "utf8"));

// No YAML dependency: the workflow is a fixed file, so its guarantees are pinned
// with targeted text checks against the build and deploy sections.
const workflowSource = fs.readFileSync(path.join(REPO, ".github", "workflows", "release.yml"), "utf8");
const [buildSection, deploySection = ""] = workflowSource.split(/^ {2}deploy:/m);

// ── production fixes ──────────────────────────────────────────────────────

test("production fixes: the insecure CA fallback is rejected", () => {
  const unpatched = `ssl: isLocal ? undefined : { rejectUnauthorized: false },`;
  const { ok, results } = verifyProductionFixes(policy, (file) =>
    file === "src/db/pool.ts" ? unpatched : '"lockfileVersion": 3',
  );
  assert.equal(ok, false);
  const caFix = results.find((result) => result.id === "prod-ca-trust");
  assert.equal(caFix.ok, false);
  assert.ok(caFix.problems.some((problem) => /rejectUnauthorized/.test(problem)));
});

test("production fixes: a committed CA patch satisfies the gate", () => {
  // Both the explicit and the shorthand form of a `ca` option must satisfy the
  // gate: the policy describes the requirement, not one patch's formatting.
  const forms = [
    `
    const ca = readFileSync(process.env.DATABASE_SSL_CA_PATH, "utf8");
    ssl: isLocal ? undefined : { ca: ca, rejectUnauthorized: true },`,
    `
    const ca = readFileSync(process.env.DATABASE_SSL_CA_PATH, "utf8");
    ssl: isLocal ? undefined : { ca, rejectUnauthorized: true },`,
  ];
  for (const patched of forms) {
    const { ok } = verifyProductionFixes(policy, (file) => (file === "src/db/pool.ts" ? patched : '"lockfileVersion": 3'));
    assert.equal(ok, true, `patched form was rejected:\n${patched}`);
  }
});

test("production fixes: the COMMITTED pool.ts satisfies the gate", () => {
  // Every case above uses a fixture. This one reads the real file, so reverting
  // the pool to an unverified TLS mode fails here as well as in the workflow —
  // the gate is only useful if the tree it guards passes it.
  const { ok, results } = verifyProductionFixes(policy, (file) =>
    fs.readFileSync(path.join(REPO, file), "utf8"),
  );
  const caFix = results.find((result) => result.id === "prod-ca-trust");
  assert.deepEqual(caFix.problems, [], "the committed src/db/pool.ts must not trip prod-ca-trust");
  assert.equal(ok, true, `the committed tree must pass its own gate: ${JSON.stringify(results)}`);
});

test("production fixes: a missing file, or a missing lockfile, fails the gate", () => {
  const missingPool = verifyProductionFixes(policy, (file) => (file === "src/db/pool.ts" ? null : '"lockfileVersion": 3'));
  assert.equal(missingPool.ok, false);
  assert.ok(missingPool.results[0].problems.some((problem) => /pool\.ts is missing/.test(problem)));

  const missingLock = verifyProductionFixes(policy, (file) => (file === "realtime-server/package-lock.json" ? null : 'const ca = 1;\n'));
  assert.equal(missingLock.ok, false);
  assert.ok(missingLock.results.some((result) => result.problems.some((problem) => /realtime-server\/package-lock\.json is missing/.test(problem))));
});

test("production fixes: the policy file describes the CA fix, not a placeholder", () => {
  const caFix = policy.fixes.find((fix) => fix.id === "prod-ca-trust");
  assert.ok(caFix, "prod-ca-trust must exist");
  assert.equal(caFix.file, "src/db/pool.ts");
  assert.ok(caFix.mustNotMatch.length > 0, "the gate must forbid the insecure form");
  assert.ok(caFix.mustMatch.length > 0, "the gate must require an explicit CA");
  assert.ok(caFix.reason.length > 40, "the reason is what the operator sees when the job fails");
});

// ── workflow ──────────────────────────────────────────────────────────────

test("workflow: there is an approval-gated deploy job, and the build section is separate", () => {
  assert.ok(deploySection.length > 0, "a deploy job must exist");
  assert.match(deploySection, /environment: production/, "deployment must sit behind the production environment");
  assert.match(deploySection, /concurrency:/, "deployments must be serialised");
  assert.match(deploySection, /group: grynd-production-deploy/, "one activation group");
  assert.match(deploySection, /cancel-in-progress: false/);
  assert.match(workflowSource, /needs: \[build, preflight\]/, "deploy must depend on the build and the stale check");
  assert.match(workflowSource, /GRYND_DEPLOY_ENABLED == 'true'/, "push deployment must be explicitly enabled");
  assert.match(workflowSource, /inputs\.deploy == true/, "manual deployment must be explicit");
  assert.match(workflowSource, /push:\s*\n\s*branches: \[main\]/, "push trigger must be main");
});

test("workflow: stale and out-of-order deployment is guarded twice", () => {
  assert.match(workflowSource, /deploy\/deployment-guard\.mjs/, "the guard decision script must be used");
  assert.match(workflowSource, /compare\/\$TARGET\.\.\.main/, "preflight must compare against main");
  assert.match(workflowSource, /compare\/\$COMMIT\.\.\.main/, "the deploy job must re-check main");
  assert.match(workflowSource, /compare\/\$COMMIT\.\.\.\$ACTIVE_COMMIT/, "the deploy job must compare against the active release");
  assert.match(workflowSource, /allow_out_of_order/, "manual recovery must be an explicit input");
});

test("workflow: the deploy job pins SSH host keys and keeps secrets out of build", () => {
  const buildJob = workflowSource.split(/^ {2}build:/m)[1].split(/^ {2}preflight:/m)[0];
  assert.match(deploySection, /StrictHostKeyChecking=yes/);
  assert.match(deploySection, /UserKnownHostsFile/);
  assert.ok(!/-o StrictHostKeyChecking=no/.test(workflowSource), "host-key checking must not be disabled");
  assert.ok(!/^\s*ssh-keyscan/m.test(workflowSource), "host keys must be pinned, not scanned");
  assert.ok(!/DEPLOY_SSH_KEY/.test(buildJob), "build job must not receive the deploy key");
  assert.ok(!/DEPLOY_KNOWN_HOSTS/.test(buildJob), "build job must not receive host keys");
  assert.match(workflowSource, /printf '%s\\n' "\$SSH_KEY"/);
  assert.ok(!/echo[^\n]*\$\{?(SSH_KEY|KNOWN_HOSTS)\}?/.test(workflowSource), "secrets must never be echoed");
});

test("workflow: release inputs are never interpolated into shell command text", () => {
  // The reason, ref, actor and run metadata are passed through env + JSON,
  // never as ${{ ... }} inside a run.
  assert.match(workflowSource, /REASON: \$\{\{ steps\.meta\.outputs\.reason \}\}/);
  for (const forbidden of [
    /--reason="\$\{\{/,
    /--branch="\$\{\{/,
    /--requested-by="\$\{\{/,
    /--event="\$\{\{/,
  ]) {
    assert.ok(!forbidden.test(workflowSource), `untrusted value in a shell command: ${forbidden}`);
  }
  assert.ok(!/run:.*\$\{\{ inputs\.reason \}\}/.test(workflowSource));
  assert.match(workflowSource, /GITHUB_REF: \$\{\{ github\.ref \}\}/);
  assert.match(workflowSource, /REQUESTED_BY: \$\{\{ github\.actor \}\}/);
});

test("workflow: no job downgrades a failure", () => {
  // Comments may mention the phrase; only a real YAML key matters.
  assert.ok(!/^\s*continue-on-error:/m.test(workflowSource), "the release workflow must never downgrade a failure");
  assert.match(buildSection, /shell: bash/);
  assert.match(buildSection, /set -euo pipefail/);
});

test("workflow: build job runs the required gates in order", () => {
  for (const required of [
    /node deploy\/verify-production-fixes\.mjs/,
    /^\s*npm ci$/m,
    /^\s*run: npm run lint:release$/m,
    /^\s*run: npm run typecheck$/m,
    /^\s*run: npm test$/m,
    /^\s*npm run build$/m,
    /node deploy\/verify-artifact\.mjs/,
    /actions\/upload-artifact@v4/,
    /node --test deploy\/tests\/\*\.test\.mjs/,
  ]) {
    assert.match(buildSection, required, `missing build step: ${required}`);
  }
  const order = [
    "verify-production-fixes.mjs",
    "npm ci",
    "npm run lint:release",
    "npm run typecheck",
    "npm test",
    "npm run build",
    "verify-artifact.mjs",
    "upload-artifact@v4",
  ].map((step) => buildSection.indexOf(step));
  assert.ok(order.every((index) => index >= 0), "all gates must be present");
  assert.deepEqual([...order].sort((a, b) => a - b), order, "gates must run in the listed order");
});

test("workflow: only main push or an explicit dispatch can deploy", () => {
  assert.ok(!/^\s*pull_request:/m.test(workflowSource), "pull requests must never deploy");
  assert.match(workflowSource, /^permissions:\n {2}contents: read$/m, "the workflow token must be read-only");
  assert.match(deploySection, /permissions:\n {6}contents: read/);
  assert.match(workflowSource, /environment: production/);
});

test("workflow: the deploy account is dedicated and never gets root shell", () => {
  assert.match(deploySection, /DEPLOY_USER \|\| 'grynd-deploy'/);
  assert.ok(!/\bubuntu@\$\{?DEPLOY_HOST/.test(workflowSource), "never SSH as the interactive administrator");
  assert.ok(!/\bsudo\b/.test(workflowSource), "privileged operations belong to the reviewed host runner, not the workflow");
  assert.match(
    fs.readFileSync(path.join(DEPLOY, "lib", "services.mjs"), "utf8"),
    /sudo", "-n", "systemctl", "restart"/,
    "the host runner's privilege is one scoped systemctl restart",
  );
});

test("workflow: the artifact checksum is verified before and after transfer", () => {
  const matches = workflowSource.match(/verify-artifact\.mjs/g) ?? [];
  assert.ok(matches.length >= 2, `expected at least two checksum checks, found ${matches.length}`);
  assert.match(workflowSource, /actions\/download-artifact@v4/);
});

test("workflow: the artifact is built for the production architecture, not the runner's default", () => {
  assert.match(buildSection, /runs-on: \$\{\{ vars\.RELEASE_RUNNER/);
  assert.match(buildSection, /EXPECTED_ARCH: \$\{\{ vars\.RELEASE_ARCH/);
  assert.match(buildSection, /process\.arch/);
  assert.match(buildSection, /--arch "\$EXPECTED_ARCH"/);
});

test("workflow: deployment uploads only into incoming/ and activates through the fixed host runner", () => {
  const script = deploySection;
  assert.match(script, /incoming\/\$RELEASE_ID/);
  assert.match(script, /ci-deploy\.mjs/);
  assert.match(script, /GRYND_ALLOW_SERVICE_RESTART=1/);
  assert.match(script, /deploy-result\.json/);
  // Never writes straight into releases/: install/ is the only mover.
  assert.ok(!/rsync[^\n]*releases\//.test(script), "the deploy job must not rsync into releases/");
  // The host runner imports the reviewed release library, including the
  // systemd controller, rather than reimplementing activation in shell.
  const ciDeploy = fs.readFileSync(path.join(DEPLOY, "lib", "ci-deploy.mjs"), "utf8");
  assert.match(ciDeploy, /createSystemdController/);
  assert.match(ciDeploy, /installRelease/);
  assert.match(ciDeploy, /activateRelease/);
  assert.match(ciDeploy, /skipIfActive: true/);
});

test("workflow: deployment requires the artifact checksum before activation", () => {
  assert.match(deploySection, /verify-artifact\.mjs/);
  assert.match(workflowSource, /Verify the artifact after download/);
  assert.match(workflowSource, /download-artifact@v4/);
});

test("workflow: the dispatch defaults to building only", () => {
  assert.match(workflowSource, /deploy:\s*\n\s*description:[^\n]*\n\s*type: boolean\n\s*default: false/);
});

// ── systemd units ─────────────────────────────────────────────────────────

function parseUnit(file) {
  const sections = {};
  let current = null;
  for (const raw of fs.readFileSync(path.join(DEPLOY, "systemd", file), "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const header = /^\[(.+)]$/.exec(line);
    if (header) {
      current = header[1];
      sections[current] ??= [];
      continue;
    }
    if (current) sections[current].push(line);
  }
  return sections;
}

function directive(sections, section, name) {
  return (sections[section] ?? [])
    .filter((line) => line.startsWith(`${name}=`))
    .map((line) => line.slice(name.length + 1));
}

const ROOT = "/home/ubuntu/grynd";

test("units: both services start from the current pointer, never from a release directory", () => {
  for (const [file, sub] of [
    ["grynd-app.service", "app"],
    ["grynd-realtime.service", "realtime"],
  ]) {
    const unit = parseUnit(file);
    assert.deepEqual(directive(unit, "Service", "WorkingDirectory"), [`${ROOT}/current/${sub}`]);
    const exec = directive(unit, "Service", "ExecStart").join(" ");
    assert.match(exec, new RegExp(`${ROOT}/current/${sub}/`));
    assert.ok(!exec.includes("/releases/"), `${file} must not name a release directory`);
    assert.deepEqual(directive(unit, "Unit", "ConditionPathExists"), [`${ROOT}/current`]);
    assert.deepEqual(directive(unit, "Service", "Restart"), ["always"], `${file} must come back after a crash`);
  }

  const appExec = directive(parseUnit("grynd-app.service"), "Service", "ExecStart").join(" ");
  assert.match(appExec, /current\/app\/node_modules\/next\/dist\/bin\/next start/, "one process, no npm wrapper");

  const realtimeExec = directive(parseUnit("grynd-realtime.service"), "Service", "ExecStart").join(" ");
  assert.match(realtimeExec, /current\/realtime\/server\.js$/);
});

test("units: environment files live outside releases/ and match the layout", () => {
  const app = parseUnit("grynd-app.service");
  const realtime = parseUnit("grynd-realtime.service");

  assert.deepEqual(directive(app, "Service", "EnvironmentFile"), [`${ROOT}/env/app.env`]);
  assert.deepEqual(directive(realtime, "Service", "EnvironmentFile"), [`${ROOT}/env/realtime.env`]);

  for (const unit of [app, realtime]) {
    for (const file of directive(unit, "Service", "EnvironmentFile")) {
      assert.ok(!file.includes("/releases/"), "env must never live inside a release");
    }
  }

  // The realtime server calls dotenv.config(); the release must not ship a .env,
  // which is what the install-time check enforces.
  assert.ok(
    fs.readFileSync(path.join(REPO, "realtime-server", "server.js"), "utf8").includes('require("dotenv").config()'),
    "realtime still loads dotenv from cwd — which is why env comes from systemd",
  );
});

test("units: both are bound to loopback ports the health gate probes", () => {
  const app = parseUnit("grynd-app.service");
  const realtime = parseUnit("grynd-realtime.service");
  assert.match(directive(app, "Service", "ExecStart").join(" "), /-p 3000 -H 127\.0\.0\.1/);
  assert.deepEqual(directive(realtime, "Service", "Environment").filter((line) => line.startsWith("PORT=")), ["PORT=3001"]);
});

test("tool: unit names used by the controller match the proposed units", () => {
  const services = fs.readFileSync(path.join(DEPLOY, "lib", "services.mjs"), "utf8");
  assert.match(services, /"grynd-app\.service", "grynd-realtime\.service"/);
});

// ── no browser surface, no migrations ─────────────────────────────────────

/**
 * Every `.mjs` file under a directory, recursively, relative to DEPLOY.
 * Recursive so a new subdirectory (for example lib/ops/) cannot silently drop
 * out of the invariants below.
 */
function sourceFiles(dir) {
  const found = [];
  for (const entry of fs.readdirSync(path.join(DEPLOY, dir), { withFileTypes: true })) {
    const relative = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(relative));
    else if (entry.name.endsWith(".mjs")) found.push(relative);
  }
  return found;
}

test("tool: there is no HTTP surface, so no release can be named by a request", () => {
  const files = ["release.mjs", "ops.mjs", ...sourceFiles("lib")];
  for (const file of files) {
    const source = fs.readFileSync(path.join(DEPLOY, file), "utf8");
    assert.ok(!/createServer\s*\(/.test(source), `${file} must not open a socket`);
    assert.ok(!/(require\(|from )["']express["']/.test(source), `${file} must not depend on a web framework`);
  }
});

test("tool: releases never run migrations", () => {
  const files = ["release.mjs", "ops.mjs", ...sourceFiles("lib"), "build-manifest.mjs", "verify-artifact.mjs"];
  for (const file of files) {
    const source = fs.readFileSync(path.join(DEPLOY, file), "utf8");
    assert.ok(!/db:migrate|drizzle-kit|migrate\.ts/.test(source), `${file} must not run database migrations`);
  }
});
