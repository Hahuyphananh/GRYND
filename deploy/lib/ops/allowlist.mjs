// deploy/lib/ops/allowlist.mjs
//
// THE catalogue. There is no other way to reach a privileged command: the
// executor looks an operation up by this exact id, then re-checks that the argv
// it is about to run is deep-equal to the frozen array below. Nothing is
// assembled from request input — no unit name, no flag, no path and no reason
// string ever reaches an argument vector.
//
// Two operations exist in this version, both `systemctl restart` on a fixed
// unit. Everything else an operator might reach for is listed in
// EXCLUDED_ACTIONS with the reason it is absent, so the boundary is stated
// rather than implied.
//
// `nginx -s reload` is deliberately NOT here. It is only safe behind a
// separately approved configuration change that has passed `nginx -t`, and
// neither that approval record nor a sudoers rule for nginx exists in this
// architecture today. Shipping the button without the gate would be the
// insecure half of the feature; see ops-permissions.md §4.

import { DeployError } from "../layout.mjs";

/** Absolute paths, verified at preflight. `sudo -n` fails rather than prompting. */
export const SUDO_PATH = "/usr/bin/sudo";
export const SYSTEMCTL_PATH = "/usr/bin/systemctl";

/** The only units this runtime may read state for or restart. */
export const MANAGED_UNITS = Object.freeze({
  app: "grynd-app.service",
  realtime: "grynd-realtime.service",
});

const UNITS = MANAGED_UNITS;

/** The exact argv for one restart. Deep-frozen; never mutated, never built. */
function restartArgv(unit) {
  return Object.freeze([SUDO_PATH, "-n", SYSTEMCTL_PATH, "restart", unit]);
}

/**
 * @typedef {object} Operation
 * @property {string} id            the only accepted identifier
 * @property {string} unit          systemd unit acted on
 * @property {"restart"} action     the verb, fixed
 * @property {string} label         shown on the confirmation card
 * @property {string} impact        shown on the confirmation card
 * @property {string} confirmPhrase typed verbatim to confirm
 * @property {readonly string[]} argv  the exact, frozen argument vector
 * @property {number} timeoutMs     hard limit for the command itself
 * @property {"app"|"realtime"} health  which health gate proves the result
 */

/** @type {Readonly<Record<string, Operation>>} */
export const OPERATIONS = Object.freeze({
  "restart.app": Object.freeze({
    id: "restart.app",
    unit: UNITS.app,
    action: "restart",
    label: "Restart grynd-app.service",
    impact:
      "The Next.js application stops accepting requests for a few seconds. In-flight " +
      "requests fail and the site returns connection errors until the process is " +
      "listening again. WebSocket clients are served by grynd-realtime and are not " +
      "dropped by this action. No release is changed: the active release keeps serving.",
    confirmPhrase: `restart ${UNITS.app}`,
    argv: restartArgv(UNITS.app),
    timeoutMs: 30_000,
    health: "app",
  }),
  "restart.realtime": Object.freeze({
    id: "restart.realtime",
    unit: UNITS.realtime,
    action: "restart",
    label: "Restart grynd-realtime.service",
    impact:
      "Every connected WebSocket is dropped. Clients reconnect with backoff, but " +
      "in-progress realtime rounds are interrupted and any in-memory room state is " +
      "lost. The Next.js app keeps serving HTTP; database-backed data is unaffected.",
    confirmPhrase: `restart ${UNITS.realtime}`,
    argv: restartArgv(UNITS.realtime),
    timeoutMs: 30_000,
    health: "realtime",
  }),
});

/** Every operation id, for the dashboard's fixed menu. */
export const OPERATION_IDS = Object.freeze(Object.keys(OPERATIONS).sort());

/**
 * Things the dashboard cannot do, and why. Rendered in the permissions matrix
 * and asserted by the test suite so this list cannot drift away from the code.
 */
export const EXCLUDED_ACTIONS = Object.freeze([
  { id: "service.stop", why: "Stopping a unit is an outage with no recovery path from the dashboard." },
  { id: "service.start", why: "Start is only meaningful after a stop, which is not offered." },
  { id: "nginx.reload", why: "Requires a separately approved config change and an `nginx -t` gate that do not exist yet." },
  { id: "vm.reboot", why: "Takes the host, the tunnel and the dashboard down with it." },
  { id: "firewall.*", why: "Could lock out SSH, which is the only way back in." },
  { id: "exec", why: "Arbitrary command execution is the thing this design exists to avoid." },
  { id: "sudo", why: "The sudoers rule is scoped to two exact commands; no general privilege is granted." },
  { id: "config.write", why: "Secret replacement is explicitly deferred pending separate design review." },
  { id: "file.edit", why: "Arbitrary file editing would bypass validation and ownership rules." },
  { id: "release.activate", why: "Activation stays with deploy/release.mjs, which requires --confirm <id> and a reason." },
  { id: "release.rollback", why: "Rollback stays with deploy/release.mjs, which requires --confirm <id> and a reason." },
]);

/** Resolve an operation id strictly. No fuzzy match, no aliasing, no defaults. */
export function getOperation(operationId) {
  if (typeof operationId !== "string") {
    throw new DeployError("Operation id must be a string", "UNKNOWN_OPERATION", { operationId });
  }
  if (!Object.prototype.hasOwnProperty.call(OPERATIONS, operationId)) {
    throw new DeployError(
      `Operation ${JSON.stringify(operationId)} is not allowlisted. Known operations: ${OPERATION_IDS.join(", ")}`,
      "UNKNOWN_OPERATION",
      { operationId },
    );
  }
  return OPERATIONS[operationId];
}

/** Deep comparison used to re-check the argv before spawning anything. */
export function sameArgv(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((part, index) => part === b[index]);
}

/**
 * Refuse any argv that is not the frozen allowlisted one. This is the last
 * gate before a child process exists, so it re-compares rather than trusting
 * the caller that derived the argv from this same module.
 */
export function assertArgv(operation, argv) {
  if (!sameArgv(argv, operation.argv)) {
    throw new DeployError(
      `Refusing to run an argv that is not the allowlisted one for ${operation.id}`,
      "ARGV_MISMATCH",
      { operation: operation.id, argv, expected: operation.argv },
    );
  }
  return argv;
}
