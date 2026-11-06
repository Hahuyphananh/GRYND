// src/app/api/platform/session/end/route.ts
//
// POST /api/platform/session/end — revoke an embed session.
//
// Called when the platform closes the game (or the player exits). Revocation is
// idempotent and takes effect on the next validation, which is why the embed
// client stops polling as soon as the platform sends `grynd:exit`.
//
// The caller must present the session token itself; there is no way to revoke a
// session by platform id or guest id.

import { NextResponse } from "next/server";

import { endPlatformSession } from "../../../../../lib/platform/session";
import { consumeRateLimit } from "../../../../../lib/security/rateLimit";

export const dynamic = "force-dynamic";

const END_RATE_LIMIT = { windowMs: 60 * 1000, max: 60 } as const;

function clientIp(req: Request): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown"
  );
}

function json(body: unknown, status: number, extraHeaders: Record<string, string> = {}) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store", ...extraHeaders },
  });
}

export async function POST(req: Request) {
  const limit = await consumeRateLimit(`platform-end:${clientIp(req)}`, END_RATE_LIMIT);
  if (!limit.allowed) {
    return json({ success: false, code: "rate_limited" }, 429);
  }

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const rawAuth = req.headers.get("authorization") || "";
  const bearer = rawAuth.startsWith("Bearer ")
    ? rawAuth.slice("Bearer ".length).trim()
    : "";
  const token =
    bearer || (body && typeof body.token === "string" ? body.token.trim() : "");

  if (!token) {
    return json(
      { success: false, code: "session_required", error: "Missing session token." },
      401,
    );
  }

  try {
    const revoked = await endPlatformSession(token);
    // An unknown/expired token is reported as already ended: revocation must be
    // safe for a platform that retries on network failure.
    return json({ success: true, data: { ended: true, revoked } }, 200);
  } catch (error) {
    console.error(
      "[platform/session/end] revoke failed",
      error instanceof Error ? error.message : error,
    );
    return json({ success: false, code: "revoke_failed" }, 500);
  }
}
