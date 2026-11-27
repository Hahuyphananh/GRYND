// deploy/lib/services.mjs
//
// How a release gets picked up by the running processes.
//
// Three controllers exist:
//
//   dry-run   the default. It cannot restart anything, so it refuses to
//             activate. This is what the repository ships with until the
//             units, the sudoers rule and the migration have been approved.
//   local     staging only. Starts the fixture servers with their cwd inside
//             `<root>/current/...` so the pointer is exercised for real.
//   systemd   the production controller. Restarts the two units with a scoped,
//             passwordless `sudo systemctl restart`. Requires BOTH an explicit
//             --allow-systemd flag and GRYND_ALLOW_SERVICE_RESTART=1, and the
//             sudoers line documented in deploy/README.md. Neither is
//             installed by this phase.

import { spawn as spawnProcess, execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { DeployError } from "./layout.mjs";

// ── Blue/green slots ────────────────────────────────────────────────────────
//
// A plain `systemctl restart` stops the only process and starts it again, so
// nginx has no upstream for a few seconds: clients see 502. That is what every
// deploy did on 2026-11-27.
//
// Two units, one per slot, each pinned to its OWN slot symlink
// (`slots/a` → a release directory) and its own port remove the gap:
//
//   1. point the idle slot at the release being activated (`current` was
//      already swapped by activate.mjs, but the slot link is what the unit
//      resolves);
//   2. start that slot and wait for its own /api/health;
//   3. rewrite the one `server` line inside the nginx upstream and reload —
//      nginx reload is graceful, so in-flight requests finish on the old
//      workers;
//   4. stop the previous slot.
//
// A failure before step 3 leaves the old slot serving; a failure after it is
// still serving from the new one. There is never a moment with no upstream.

export const SLOT_UNITS = Object.freeze({ a: "grynd-app-a.service", b: "grynd-app-b.service" });
export const SLOT_PORTS = Object.freeze({ a: 3000, b: 3002 });

function execChecked(exec, command, args, { timeout = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    exec(command, args, { timeout }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${command} ${args.join(" ")} failed: ${error.message} ${String(stderr || "").slice(0, 300)}`));
        return;
      }
      resolve(stdout);
    });
  });
}

async function waitForSlotHealth(port, { attempts = 40, intervalMs = 500, fetchImpl = fetch } = {}) {
  const url = `http://127.0.0.1:${port}/api/health`;
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(2_000), cache: "no-store" });
      if (response.ok) {
        const body = await response.json().catch(() => null);
        if (body?.ok === true) return body;
        lastError = new Error(`health answered ${JSON.stringify(body)}`);
      } else {
        lastError = new Error(`health answered HTTP ${response.status}`);
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new DeployError(`slot on port ${port} never became healthy: ${lastError?.message ?? "no response"}`, "SLOT_HEALTH_FAILED", { port });
}

/** A controller that cannot restart — activation is refused, not faked. */
export function createDryRunController() {
  const unavailable = () =>
    new DeployError(
        "No service controller is enabled: this host cannot restart grynd-app.service / grynd-realtime.service. " +
          "Activation would swap the pointer and health-check the OLD processes, which proves nothing. " +
          "Install the units and the scoped sudoers rule, then run with --controller=systemd --allow-systemd " +
          "and GRYND_ALLOW_SERVICE_RESTART=1 (see deploy/README.md).",
        "SERVICE_CONTROL_UNAVAILABLE",
      );

  return {
    name: "dry-run",
    // Consulted BEFORE the pointer moves, so a host that cannot restart
    // services refuses activation without changing anything.
    async assertReady() {
      throw unavailable();
    },
    async restart() {
      throw unavailable();
    },
    async stop() {},
  };
}

/**
 * Staging controller: runs real child processes whose cwd is resolved through
 * `<root>/current`. Restarting after a pointer swap is what makes the fixture
 * serve the new release, exactly like systemd would.
 */
export function createLocalController({
  root,
  app = { command: process.execPath, args: ["app/server.mjs"], cwd: "current/app" },
  realtime = { command: process.execPath, args: ["server.js"], cwd: "current/realtime" },
  env = {},
  spawn = spawnProcess,
  logs = [],
} = {}) {
  /** @type {import("node:child_process").ChildProcess[]} */
  let children = [];

  function capture(child, label) {
    for (const stream of [child.stdout, child.stderr]) {
      stream?.on("data", (chunk) => {
        const line = String(chunk).trim();
        if (line) logs.push({ label, line: line.slice(0, 400) });
        if (logs.length > 200) logs.shift();
      });
    }
  }

  async function stop() {
    const current = children;
    children = [];
    await Promise.all(
      current.map(
        (child) =>
          new Promise((resolve) => {
            if (child.exitCode !== null) return resolve();
            const timer = setTimeout(() => {
              child.kill("SIGKILL");
              resolve();
            }, 2_000);
            child.once("exit", () => {
              clearTimeout(timer);
              resolve();
            });
            child.kill("SIGTERM");
          }),
      ),
    );
  }

  function start(spec, label) {
    const cwd = path.join(root, spec.cwd);
    const child = spawn(spec.command, spec.args, {
      cwd,
      env: { ...process.env, ...env, ...spec.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.on("error", (error) => logs.push({ label, line: `spawn error: ${error.message}` }));
    capture(child, label);
    children.push(child);
    return child;
  }

  return {
    name: "local",
    async assertReady() {},
    async restart({ restartRealtime = true } = {}) {
      await stop();
      start(app, "app");
      if (restartRealtime) start(realtime, "realtime");
    },
    async stop() {
      await stop();
    },
    get logs() {
      return logs;
    },
  };
}

/**
 * Production controller. Deliberately inert unless the operator opts in twice.
 * Never called by this phase: no unit, no sudoers rule, no approval.
 */
export function createSystemdController({
  units = ["grynd-app.service", "grynd-realtime.service"],
  restartCommand = ["sudo", "-n", "systemctl", "restart"],
  exec = execFile,
  allow = process.env.GRYND_ALLOW_SERVICE_RESTART === "1",
  root = process.env.GRYND_ROOT || "/home/ubuntu/grynd",
  // Blue/green is used only when the slots exist (installed by deploy/README
  // step 3). Without them the controller keeps the old restart behaviour, so a
  // half-migrated host still deploys.
  slots = true,
  slotUnits = SLOT_UNITS,
  slotPorts = SLOT_PORTS,
  // A directory the deploy user owns, included by nginx's upstream block, so a
  // one-line switch never needs root to write a config file. Must be readable by
  // the nginx master (root): 750 grynd-deploy:root.
  upstreamFile = process.env.GRYND_NGINX_UPSTREAM_FILE || "/etc/nginx/grynd/upstream-server.conf",
  health = waitForSlotHealth,
} = {}) {
  const stateFile = path.join(root, "state", "app-slot");
  const slotRoot = path.join(root, "slots");

  async function readSlot() {
    const raw = await fs.readFile(stateFile, "utf8").catch(() => "");
    return raw.trim() === "b" ? "b" : "a";
  }

  async function slotsInstalled() {
    if (!slots) return false;
    for (const slot of ["a", "b"]) {
      const stat = await fs.lstat(path.join(slotRoot, slot)).catch(() => null);
      if (!stat?.isSymbolicLink()) return false;
    }
    return true;
  }

  /** Point one slot at a release directory, atomically. */
  async function pointSlot(slot, releaseDir) {
    const link = path.join(slotRoot, slot);
    const tmp = path.join(slotRoot, `.${slot}.tmp-${process.pid}-${Date.now().toString(36)}`);
    await fs.symlink(releaseDir, tmp, process.platform === "win32" ? "junction" : "dir");
    try {
      await fs.rename(tmp, link);
      return;
    } catch (error) {
      // Windows cannot replace an existing junction with rename (production is
      // Linux, where this is one atomic swap). Staging/tests only.
      if (process.platform !== "win32" || !["EPERM", "EEXIST", "EACCES"].includes(error.code)) {
        await fs.rm(tmp, { force: true }).catch(() => {});
        throw error;
      }
    }
    await fs.rm(link, { force: true }).catch(() => {});
    await fs.rename(tmp, link);
  }

  async function switchUpstream(port) {
    const tmp = path.join(path.dirname(upstreamFile), `.upstream-${process.pid}-${Date.now().toString(36)}.tmp`);
    await fs.writeFile(tmp, `server 127.0.0.1:${port};\n`, { mode: 0o644 });
    try {
      await fs.rename(tmp, upstreamFile);
    } catch (error) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw error;
    }
    await execChecked(exec, "sudo", ["-n", "/usr/sbin/nginx", "-t"]);
    await execChecked(exec, "sudo", ["-n", "/usr/bin/systemctl", "reload", "nginx"]);
  }

  async function activateSlot({ releaseId, active, releaseDir }) {
    const next = active === "a" ? "b" : "a";
    const previousLink = await fs.readlink(path.join(slotRoot, active)).catch(() => null);
    const nextUnit = slotUnits[next];
    const previousUnit = slotUnits[active];
    const nextPort = slotPorts[next];

    console.log(`[activate] slot ${next} ← ${releaseId} (http://127.0.0.1:${nextPort})`);
    await pointSlot(next, releaseDir);

    try {
      await execChecked(exec, "sudo", ["-n", "systemctl", "start", nextUnit]);
      await health(nextPort);
      await switchUpstream(nextPort);
    } catch (error) {
      // Nothing has switched yet (nginx still names the old port): clean up the
      // standby and let the caller revert the pointer.
      await execChecked(exec, "sudo", ["-n", "systemctl", "stop", nextUnit]).catch(() => {});
      if (previousLink) await pointSlot(next, previousLink).catch(() => {});
      throw new DeployError(`blue/green activation of ${releaseId} failed: ${error.message}`, "SLOT_ACTIVATION_FAILED", { releaseId });
    }

    // The new slot is serving. Stopping the old one is cleanup, not cutover.
    await execChecked(exec, "sudo", ["-n", "systemctl", "stop", previousUnit]).catch((error) => {
      console.warn(`[activate] could not stop ${previousUnit} (new slot is serving): ${error.message}`);
    });
    await fs.mkdir(path.join(root, "state"), { recursive: true });
    await fs.writeFile(stateFile, `${next}\n`, { mode: 0o644 });
    console.log(`[activate] slot ${next} serving; ${active} stopped`);
  }

  return {
    name: "systemd",
    /**
     * The loopback port that is serving right now, when slots are installed.
     * The health gate must probe THIS port: after a switch the app no longer
     * listens on 3000, and probing the fixed default made every successful
     * switch look like a failed activation.
     */
    async servingPort() {
      if (!(await slotsInstalled())) return null;
      return slotPorts[await readSlot()] ?? null;
    },
    async assertReady() {
      if (!allow) {
        throw new DeployError(
          "GRYND_ALLOW_SERVICE_RESTART is not 1; refusing to activate. This flag exists so an accidental activation cannot bounce production.",
          "SERVICE_CONTROL_DISABLED",
        );
      }
    },
    async restart({ restartRealtime = true, releaseId } = {}) {
      if (!allow) {
        throw new DeployError(
          "GRYND_ALLOW_SERVICE_RESTART is not 1; refusing to restart units. This flag exists so an accidental activation cannot bounce production.",
          "SERVICE_CONTROL_DISABLED",
        );
      }

      // Blue/green when the slots and the release are available.
      if (releaseId && (await slotsInstalled())) {
        const active = await readSlot();
        const releaseDir = path.join(root, "releases", releaseId);
        const stat = await fs.stat(releaseDir).catch(() => null);
        if (!stat?.isDirectory()) {
          throw new DeployError(`release directory ${releaseDir} does not exist`, "RELEASE_MISSING", { releaseId });
        }
        await activateSlot({ releaseId, active, releaseDir });
        if (restartRealtime) {
          await execChecked(exec, "sudo", ["-n", "systemctl", "restart", units[1] ?? "grynd-realtime.service"]);
        }
        return;
      }

      const targets = restartRealtime ? units : [units[0]];
      for (const unit of targets) {
        await new Promise((resolve, reject) => {
          exec(restartCommand[0], [...restartCommand.slice(1), unit], { timeout: 30_000 }, (error, stdout, stderr) => {
            if (error) {
              reject(
                new DeployError(`systemctl restart ${unit} failed: ${error.message}`, "SERVICE_RESTART_FAILED", {
                  unit,
                  stderr: String(stderr || "").slice(0, 500),
                }),
              );
              return;
            }
            resolve(stdout);
          });
        });
      }
    },
    async stop() {},
  };
}
