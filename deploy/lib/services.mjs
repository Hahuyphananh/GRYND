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
import path from "node:path";

import { DeployError } from "./layout.mjs";

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
} = {}) {
  return {
    name: "systemd",
    async assertReady() {
      if (!allow) {
        throw new DeployError(
          "GRYND_ALLOW_SERVICE_RESTART is not 1; refusing to activate. This flag exists so an accidental activation cannot bounce production.",
          "SERVICE_CONTROL_DISABLED",
        );
      }
    },
    async restart({ restartRealtime = true } = {}) {
      if (!allow) {
        throw new DeployError(
          "GRYND_ALLOW_SERVICE_RESTART is not 1; refusing to restart units. This flag exists so an accidental activation cannot bounce production.",
          "SERVICE_CONTROL_DISABLED",
        );
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
