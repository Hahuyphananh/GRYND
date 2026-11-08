// src/app/api/admin/deploy-latest/route.ts
//
// POST → ask GitHub Actions to build and deploy the newest commit of an
// allowlisted branch (`main` or `solitaire-first`).
//
// The middleware already gates /api/admin on Clerk auth, the admin badge and a
// recent second factor. This handler re-checks auth + admin itself so a
// middleware regression cannot expose a production deploy.
//
// The branch arrives from the browser, so it is UNTRUSTED: it is validated here
// against the same allowlist the dispatch library and the workflow use, and an
// unknown value is rejected with 400 before any GitHub call. `deployLatest`
// validates again — a caller cannot widen the allowlist by skipping this route.
//
// The response never carries the GitHub token, the repository's visibility or
// any request/response body from GitHub — only a branch, a commit, a short
// commit, a public GitHub URL and an error code the dashboard can explain.

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";

import { getOperationsSnapshot } from "../../../../lib/admin/operations";
import {
  DEFAULT_DEPLOY_BRANCH,
  DEPLOY_BRANCHES,
  DeployError,
  deployLatest,
  isDeployBranch,
} from "../../../../lib/admin/deployLatest";
import { isAdmin } from "../../../../lib/auth/isAdmin";
import { adminAuditLog } from "../../../../lib/security/adminAuditLog";

export const runtime = "nodejs";

const STATUS_BY_CODE: Record<string, number> = {
  "not-configured": 503,
  "branch-not-allowed": 400,
  "github-auth": 502,
  "github-not-found": 502,
  "github-unavailable": 502,
  "dispatch-rejected": 502,
};

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  if (!(await isAdmin(userId))) {
    return NextResponse.json({ success: false, error: "Forbidden. Admin access required" }, { status: 403 });
  }

  // A free-text reason is optional and bounded; it is written into workflow run
  // metadata, so it must never carry a token or a database URL.
  let reason = "Admin operations dashboard";
  // The production target by default; the client must name a branch explicitly
  // to deploy anything else.
  let branch: unknown = DEFAULT_DEPLOY_BRANCH;
  try {
    const body = await req.json();
    if (body && typeof body.reason === "string") {
      const cleaned = body.reason.replace(/\s+/g, " ").trim().slice(0, 120);
      if (cleaned) reason = cleaned;
    }
    if (body && body.branch !== undefined) branch = body.branch;
  } catch {
    // No body is the normal case.
  }

  if (!isDeployBranch(branch)) {
    return NextResponse.json(
      {
        success: false,
        status: "branch-not-allowed",
        error: `branch must be one of ${DEPLOY_BRANCHES.join(", ")}`,
      },
      { status: 400 },
    );
  }

  try {
    // What is live right now, from the same reader the page uses. A deploy of a
    // commit that is already serving traffic is a no-op, not an error.
    const snapshot = await getOperationsSnapshot();
    const liveCommit = snapshot.live?.commit ?? null;

    const outcome = await deployLatest({ liveCommit, branch, reason });

    if (outcome.status === "dispatched") {
      adminAuditLog("admin_deploy_dispatch", {
        clerkId: userId,
        details: { branch: outcome.branch, commit: outcome.commit, reason },
      }).catch(() => {});
      return NextResponse.json({ success: true, ...outcome }, { status: 202 });
    }

    return NextResponse.json({ success: true, ...outcome }, { status: 200 });
  } catch (error) {
    if (error instanceof DeployError) {
      return NextResponse.json(
        { success: false, status: error.code, error: error.message },
        { status: STATUS_BY_CODE[error.code] ?? 502 },
      );
    }
    console.error("[admin:deploy-latest] Error:", error);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}
