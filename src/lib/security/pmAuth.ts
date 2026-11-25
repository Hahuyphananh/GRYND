// src/lib/security/pmAuth.ts
//
// Guard for the internal PM (product-metrics) endpoints. Both expose data that
// must never be public: /api/pm/errors returns recent error_logs rows (stack
// traces, request context) and /api/pm/analytics sweeps every game table.
//
// FAIL CLOSED. The previous inline check compared the Authorization header to
// "Bearer " + process.env.PM_API_KEY, so with the variable unset it
// authenticated the literal string "Bearer undefined" on any deployment that
// simply forgot the env var. An unconfigured deployment now refuses every
// request instead.

import { NextResponse } from "next/server";

import { readBearerToken, timingSafeEqualString } from "./bearerToken";

export function verifyPmRequest(request: Request): Response | null {
  const expected = process.env.PM_API_KEY?.trim();
  if (!expected) {
    console.error("[pmAuth] PM_API_KEY is not configured; refusing the request.");
    return NextResponse.json(
      { error: "PM authentication is not configured" },
      { status: 503 },
    );
  }

  const presented = readBearerToken(request.headers.get("authorization"));
  if (!presented || !timingSafeEqualString(presented, expected)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return null;
}
