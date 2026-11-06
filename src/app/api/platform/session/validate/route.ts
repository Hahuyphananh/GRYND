// src/app/api/platform/session/validate/route.ts
//
// POST /api/platform/session/validate — public validation of an embed session.
//
// The embedded client and the platform page can use this to learn whether a
// session is still usable. It returns metadata ONLY (platform, game, expiry); it
// never returns the guest id, never issues a new token and never upgrades the
// session to an account.
//
// The token may be sent as `Authorization: Bearer …` or as `{ token }` in the
// body. Both are validated by hash against the stored row, with expiry and
// revocation enforced server-side.

import { NextResponse } from "next/server";

import {
  normalizePlatformOrigin,
} from "../../../../../lib/platform/config";
import { validatePlatformToken } from "../../../../../lib/platform/session";
import { consumeRateLimit } from "../../../../../lib/security/rateLimit";

export const dynamic = "force-dynamic";

const VALIDATE_RATE_LIMIT = { windowMs: 60 * 1000, max: 120 } as const;

function json(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function clientIp(req: Request): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown"
  );
}

export async function POST(req: Request) {
  const limit = await consumeRateLimit(
    `platform-validate:${clientIp(req)}`,
    VALIDATE_RATE_LIMIT,
  );
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

  const record = await validatePlatformToken(token, {
    platform: typeof body?.platform === "string" ? body.platform : undefined,
    gameKey: typeof body?.gameKey === "string" ? body.gameKey : undefined,
  });

  if (!record) {
    return json(
      { success: false, code: "invalid_session", error: "Session is invalid or expired." },
      401,
    );
  }

  // If the caller supplies an origin, it must be the configured one. This is an
  // extra assertion for platform-side checks, not the security boundary: the
  // stored row already pins the origin.
  if (body?.origin !== undefined) {
    const origin = normalizePlatformOrigin(body.origin);
    if (!origin || origin !== record.platformOrigin) {
      return json(
        { success: false, code: "origin_not_authorized", error: "Origin is not authorized." },
        403,
      );
    }
  }

  return json(
    {
      success: true,
      data: {
        valid: true,
        platform: record.platform,
        gameKey: record.gameKey,
        origin: record.platformOrigin,
        expiresAt: record.expiresAt.toISOString(),
      },
    },
    200,
  );
}
