/**
 * cronAuth.ts
 *
 * Authentication guard for scheduled job endpoints. Vercel Cron Jobs can be
 * configured to include an `Authorization: Bearer <token>` header when
 * invoking scheduled routes. This module verifies that header against the
 * `CRON_SECRET` environment variable to prevent unauthenticated callers from
 * triggering global state-changing operations (weekly-reset, daily-reset,
 * retention sweeps).
 *
 * Usage:
 *   export async function GET(request: Request) {
 *     const authError = verifyCronRequest(request);
 *     if (authError) return authError;
 *     // ... perform scheduled work
 *   }
 *
 * Environment Setup:
 *   1. Generate a strong random secret (e.g., `openssl rand -base64 32`)
 *   2. Set CRON_SECRET in Vercel project settings → Environment Variables
 *   3. Configure your cron scheduler to send this secret in the
 *      Authorization header as "Bearer <CRON_SECRET>"
 *
 *   For Vercel Cron Jobs specifically:
 *   - Vercel does not automatically inject authentication headers
 *   - You must configure the Authorization header manually in vercel.json
 *     or use a custom deployment script to add the header
 *   - Alternatively, use a third-party cron service (e.g., cron-job.org,
 *     EasyCron) that supports custom headers
 *
 * Security:
 *   - Returns 401 if the Authorization header is missing or incorrect
 *   - Returns 401 if CRON_SECRET is not configured (fail-secure)
 *   - Constant-time comparison to prevent timing attacks
 *   - All cron job routes under /api/jobs/* should use this guard
 */

import { NextResponse } from "next/server";

/**
 * Verify that the request is an authenticated cron invocation.
 * Returns null if valid, or a 401 Response if authentication fails.
 */
export function verifyCronRequest(request: Request): Response | null {
  const cronSecret = process.env.CRON_SECRET;

  // Fail-secure: if CRON_SECRET is not configured, reject all requests
  if (!cronSecret) {
    console.error(
      "[cronAuth] CRON_SECRET environment variable is not configured. " +
        "Cron endpoints are disabled until this is set."
    );
    return NextResponse.json(
      { error: "Cron authentication is not configured" },
      { status: 401 }
    );
  }

  const authHeader = request.headers.get("authorization");
  if (!authHeader) {
    console.warn("[cronAuth] Missing Authorization header");
    return NextResponse.json(
      { error: "Unauthorized: missing authorization header" },
      { status: 401 }
    );
  }

  // Extract bearer token from "Bearer <token>" format
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    console.warn("[cronAuth] Invalid Authorization header format");
    return NextResponse.json(
      { error: "Unauthorized: invalid authorization format" },
      { status: 401 }
    );
  }

  const providedToken = match[1];

  // Constant-time comparison to prevent timing attacks
  if (!timingSafeEqual(providedToken, cronSecret)) {
    console.warn("[cronAuth] Invalid cron secret");
    return NextResponse.json(
      { error: "Unauthorized: invalid credentials" },
      { status: 401 }
    );
  }

  // Authentication successful
  return null;
}

/**
 * Constant-time string comparison to prevent timing attacks.
 * Returns true if the strings are equal, false otherwise.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return result === 0;
}
