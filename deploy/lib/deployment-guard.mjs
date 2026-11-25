// deploy/lib/deployment-guard.mjs
//
// GitHub concurrency serialises deploy jobs, but it cannot by itself stop an
// older queued run from activating after a newer one. This guard is the second
// check, run immediately before activation:
//
//   1. is the ref being deployed on the allowlist, and may this event deploy it?
//   2. does the target commit still belong to the head of THAT branch?
//   3. is the active release newer than the target?
//
// `main` is the default branch and keeps its original behaviour: a push may
// deploy it when it is exactly the branch head, and a manual run may deploy it
// behind the production approval. `solitaire-first` is an explicitly approved
// production target: it can only be deployed by a manual dispatch (which sits
// behind the `grynd-production` required reviewers), never by a push, and only
// when the built commit IS that branch's head. The allowlist here is duplicated
// on purpose — it lives in the workflow and in the admin API as well, so a
// tampered client value cannot widen it.
//
// A manual recovery run may bypass the ordering rules only with an explicit,
// environment-approved `allow_out_of_order` input.
//
// Compare statuses are GitHub's `compare base...head` values:
//   identical  head == base
//   ahead      head has commits base does not (head is newer)
//   behind     base has commits head does not (head is older)
//   diverged   both have unique commits
//   unavailable the API could not answer

export const COMPARE_STATUSES = ["identical", "ahead", "behind", "diverged", "unavailable"];

/**
 * The branches the release system may ever deploy. This is an allowlist, not
 * user input: the workflow, this guard and the admin API all read it.
 */
export const DEPLOY_BRANCHES = ["main", "solitaire-first"];

/** The branch a push-triggered release may deploy. */
export const DEFAULT_DEPLOY_BRANCH = "main";

const BRANCH_RE = /^[A-Za-z0-9._/-]{1,100}$/;

function isStatus(value) {
  return COMPARE_STATUSES.includes(value);
}

/**
 * `refs/heads/solitaire-first` → `solitaire-first`. Returns null for anything
 * that is not a plain branch name (tags, `refs/pull/…`, a traversal attempt).
 */
export function branchNameFromRef(ref) {
  if (typeof ref !== "string") return null;
  const trimmed = ref.trim();
  const name = trimmed.startsWith("refs/heads/") ? trimmed.slice("refs/heads/".length) : trimmed;
  if (!BRANCH_RE.test(name)) return null;
  if (name.includes("..") || name.startsWith("/") || name.endsWith("/")) return null;
  return name;
}

/**
 * @param {object} input
 * @param {"push"|"workflow_dispatch"} input.event
 * @param {string} [input.branch] full ref being deployed, e.g. refs/heads/solitaire-first
 * @param {string} input.targetToHead compare <target>...<selected branch>; empty when active release absent
 * @param {string} [input.targetToActive] compare <target>...<active>; empty when no active release
 * @param {boolean} [input.allowOutOfOrder]
 * @returns {{ proceed: boolean, code: string, reason: string }}
 */
export function evaluateDeploymentGuard({
  event = "push",
  branch = "refs/heads/main",
  targetToHead,
  targetToActive = "",
  allowOutOfOrder = false,
} = {}) {
  if (event !== "push" && event !== "workflow_dispatch") {
    return { proceed: false, code: "INVALID_EVENT", reason: "unknown workflow event" };
  }

  const name = branchNameFromRef(branch);
  if (!name) {
    return { proceed: false, code: "INVALID_BRANCH", reason: "the ref being deployed is not a branch name" };
  }
  if (!DEPLOY_BRANCHES.includes(name)) {
    return {
      proceed: false,
      code: "BRANCH_NOT_ALLOWED",
      reason: `${name} is not on the deployment allowlist (${DEPLOY_BRANCHES.join(", ")})`,
    };
  }

  const manual = event === "workflow_dispatch";
  const override = manual && allowOutOfOrder === true;

  // A push is the automatic path: it belongs to the default branch only, exactly
  // as before. A non-default allowlisted branch needs a human dispatch (and the
  // production environment approval that comes with it).
  if (!manual && name !== DEFAULT_DEPLOY_BRANCH) {
    return {
      proceed: false,
      code: "PUSH_NOT_DEFAULT_BRANCH",
      reason: `a push-triggered release may only deploy ${DEFAULT_DEPLOY_BRANCH}`,
    };
  }

  if (!isStatus(targetToHead)) {
    return {
      proceed: false,
      code: "HEAD_UNKNOWN",
      reason: `the target's position on ${name} could not be verified (${JSON.stringify(targetToHead)})`,
    };
  }

  if (targetToHead !== "identical") {
    if (!override) {
      return {
        proceed: false,
        code: "STALE",
        reason:
          targetToHead === "ahead"
            ? `${name} has newer commits; this run is stale`
            : `the target commit is not the head of ${name}`,
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

  if (override && targetToHead !== "identical") {
    return {
      proceed: true,
      code: "OUT_OF_ORDER",
      reason: "manual out-of-order deployment explicitly approved",
    };
  }

  return {
    proceed: true,
    code: targetToHead === "identical" ? "CURRENT" : "MANUAL",
    reason: `target is deployable from ${name}`,
  };
}
