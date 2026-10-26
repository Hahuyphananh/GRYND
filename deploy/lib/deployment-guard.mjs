// deploy/lib/deployment-guard.mjs
//
// GitHub concurrency serialises deploy jobs, but it cannot by itself stop an
// older queued run from activating after a newer one. This guard is the second
// check, run immediately before activation:
//
//   1. does the target commit still belong to main?
//   2. is the active release newer than the target?
//
// A push-triggered run may deploy only when the target IS main and is not older
// than the active release. A manual recovery run may bypass that ordering only
// with an explicit, environment-approved `allow_out_of_order` input.
//
// Compare statuses are GitHub's `compare base...head` values:
//   identical  head == base
//   ahead      head has commits base does not (head is newer)
//   behind     base has commits head does not (head is older)
//   diverged   both have unique commits
//   unavailable the API could not answer

export const COMPARE_STATUSES = ["identical", "ahead", "behind", "diverged", "unavailable"];

function isStatus(value) {
  return COMPARE_STATUSES.includes(value);
}

/**
 * @param {object} input
 * @param {"push"|"workflow_dispatch"} input.event
 * @param {string} [input.branch] ref being deployed, e.g. refs/heads/main
 * @param {string} input.targetToMain compare <target>...main; may be empty when no active release
 * @param {string} [input.targetToActive] compare <target>...<active>; empty when no active release
 * @param {boolean} [input.allowOutOfOrder]
 * @returns {{ proceed: boolean, code: string, reason: string }}
 */
export function evaluateDeploymentGuard({
  event = "push",
  branch = "refs/heads/main",
  targetToMain,
  targetToActive = "",
  allowOutOfOrder = false,
} = {}) {
  const manual = event === "workflow_dispatch";
  const override = manual && allowOutOfOrder === true;

  if (branch !== "refs/heads/main") {
    return { proceed: false, code: "NOT_MAIN", reason: "releases may only deploy from refs/heads/main" };
  }
  if (!isStatus(targetToMain)) {
    return {
      proceed: false,
      code: "MAIN_UNKNOWN",
      reason: `the target's position on main could not be verified (${JSON.stringify(targetToMain)})`,
    };
  }

  if (targetToMain !== "identical") {
    if (!override) {
      return {
        proceed: false,
        code: "STALE",
        reason:
          targetToMain === "ahead"
            ? "main has newer commits; this run is stale"
            : "the target commit is not the head of main",
      };
    }
  }

  if (targetToActive) {
    if (!isStatus(targetToActive)) {
      return {
        proceed: false,
        code: "ACTIVE_UNKNOWN",
        reason: `the active release's position relative to the target could not be verified (${JSON.stringify(targetToActive)})`,
      };
    }
    if (targetToActive === "ahead" || targetToActive === "diverged") {
      if (!override) {
        return {
          proceed: false,
          code: "OLDER_THAN_ACTIVE",
          reason:
            targetToActive === "ahead"
              ? "the active release contains newer commits; refusing to overwrite it"
              : "the target and the active release have diverged",
        };
      }
    }
    if (targetToActive === "identical") {
      return {
        proceed: true,
        code: "ALREADY_ACTIVE",
        reason: "this commit is already the active release; activation will be skipped",
      };
    }
  }

  if (override && targetToMain !== "identical") {
    return {
      proceed: true,
      code: "OUT_OF_ORDER",
      reason: "manual out-of-order deployment explicitly approved",
    };
  }

  return {
    proceed: true,
    code: targetToMain === "identical" ? "CURRENT" : "MANUAL",
    reason: "target is deployable",
  };
}
