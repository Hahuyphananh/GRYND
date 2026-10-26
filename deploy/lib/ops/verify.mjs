// deploy/lib/ops/verify.mjs
//
// After an action, prove what actually happened. Two independent facts:
//
//   unit state   `systemctl is-active <unit>` — did the unit come back?
//   health       the same loopback gate activation uses (/api/health with
//                db=ok, or the realtime /health) — is it actually serving?
//
// A restart that returns 0 is not a success. `systemctl restart` on a unit that
// immediately crash-loops exits 0 and leaves a `failed` unit; only the check
// afterwards distinguishes those. Reporting is therefore always the pair, and
// `ok` requires both.
//
// Reading unit state needs no privilege — `is-active` is world-readable — so
// this module never invokes sudo.

import { execFile } from "node:child_process";

import { defaultHealthTargets, runHealthGate } from "../health.mjs";
import { SYSTEMCTL_PATH } from "./allowlist.mjs";

/** States `systemctl is-active` can report that are worth naming. */
const KNOWN_STATES = new Set([
  "active",
  "activating",
  "deactivating",
  "failed",
  "inactive",
  "reloading",
  "unknown",
]);

/**
 * Read one unit's state. Never throws: a failure to read is reported as a state.
 */
export function createSystemctlReader({ exec = execFile, systemctl = SYSTEMCTL_PATH } = {}) {
  return {
    /** @returns {Promise<{ unit: string, state: string, active: boolean, error: string | null }>} */
    async state(unit) {
      return new Promise((resolve) => {
        exec(systemctl, ["is-active", unit], { timeout: 5_000, windowsHide: true }, (error, stdout) => {
          const reported = String(stdout ?? "")
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)[0] ?? "";

          if (reported && KNOWN_STATES.has(reported)) {
            resolve({
              unit,
              state: reported,
              active: reported === "active",
              error: reported === "unknown" ? "systemctl did not report a state" : null,
            });
            return;
          }

          // No usable stdout: report the failure rather than guessing "active".
          resolve({
            unit,
            state: "unknown",
            active: false,
            error: error ? `could not read unit state (${error.code ?? error.message})` : "no unit state reported",
          });
        });
      });
    },
  };
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll the restarted unit until it is active, then read both units and run the
 * health gate for the affected service.
 *
 * @param {object} input
 * @param {import("./allowlist.mjs").Operation} input.operation
 * @param {{ state: (unit: string) => Promise<object> }} input.reader
 * @param {(input: object) => Promise<object>} [input.healthGate]
 */
export async function verifyOperation({
  operation,
  units,
  reader,
  healthGate = runHealthGate,
  appPort = 3000,
  realtimePort = 3001,
  pollAttempts = 6,
  pollIntervalMs = 500,
  sleep = defaultSleep,
  now = () => Date.now(),
} = {}) {
  const startedAt = now();

  let target = await reader.state(operation.unit);
  for (let attempt = 1; attempt < pollAttempts && !target.active; attempt += 1) {
    await sleep(pollIntervalMs);
    target = await reader.state(operation.unit);
  }

  // Report BOTH units: an operator needs to see that restarting one did not
  // disturb the other, and a silent second failure is worse than a slow answer.
  // Only the restarted unit uses the polled result; the other is read fresh.
  const normalized = [];
  for (const [role, unit] of Object.entries(units)) {
    const observed = unit === operation.unit ? target : await reader.state(unit);
    normalized.push({
      role,
      unit: observed.unit ?? unit,
      state: observed.state,
      active: Boolean(observed.active),
      error: observed.error ?? null,
    });
  }

  const healthTarget = defaultHealthTargets({ appPort, realtimePort, includeRealtime: true }).find(
    (entry) => entry.name === operation.health,
  );
  if (!healthTarget) {
    throw new Error(`No health target is defined for ${operation.health}`);
  }

  const gate = await healthGate({ targets: [healthTarget] });
  const service = normalized.find((entry) => entry.unit === operation.unit);
  const ok = Boolean(service?.active) && Boolean(gate?.ok);

  return {
    ok,
    unit: service ?? null,
    units: normalized,
    health: {
      ok: Boolean(gate?.ok),
      attempts: gate?.attempts ?? 0,
      checks: (gate?.results ?? []).map((result) => ({
        name: result.name,
        ok: result.ok,
        status: result.status,
        ms: result.ms,
        error: result.error ?? null,
      })),
    },
    elapsedMs: now() - startedAt,
  };
}
