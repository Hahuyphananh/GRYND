// src/app/api/platform/session/route.ts
//
// POST /api/platform/session — SERVER-TO-SERVER session mint (Phase 5).
//
// The platform's backend calls this with `Authorization: Bearer <platform
// secret>` (the secret lives only in server env, never in the iframe). The body
// names the platform, the supported game and the exact origin that will frame
// the game. The response contains the opaque short-lived session token and the
// embed path the platform should load in its iframe.
//
// FAIL CLOSED: unknown platform, unconfigured secret, wrong secret, origin not
// on the allowlist, or unsupported game all produce a 4xx and no session.

import { NextResponse } from "next/server";

import {
  getPlatformConfig,
  isPlatformGameKey,
  normalizePlatformOrigin,
} from "../../../../lib/platform/config";
import {
  createPlatformSession,
  secretMatches,
} from "../../../../lib/platform/session";
import { consumeRateLimit } from "../../../../lib/security/rateLimit";

export const dynamic = "force-dynamic";

const MINT_RATE_LIMIT = { windowMs: 60 * 1000, max: 30 } as const;

function clientIp(req: Request): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown"
  );
}

function json(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function POST(req: Request) {
  const limit = await consumeRateLimit(`platform-mint:${clientIp(req)}`, MINT_RATE_LIMIT);
  if (!limit.allowed) {
    return json(
      { success: false, code: "rate_limited", error: "Too many session requests." },
      429,
    );
  }

  const rawAuth = req.headers.get("authorization") || "";
  const presented = rawAuth.startsWith("Bearer ")
    ? rawAuth.slice("Bearer ".length).trim()
    : "";

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") {
    return json({ success: false, code: "invalid_body", error: "Expected JSON body." }, 400);
  }

  const platform = typeof body.platform === "string" ? body.platform : "";
  const gameKey = typeof body.gameKey === "string" ? body.gameKey : "";
  const origin = normalizePlatformOrigin(body.origin);

  const config = getPlatformConfig(platform);
  if (!config) {
    // One response for "unknown platform" and "no secret configured" so the
    // endpoint does not enumerate configured integrations.
    return json(
      { success: false, code: "platform_not_authorized", error: "Platform is not authorized." },
      403,
    );
  }

  if (!secretMatches(config.secret, presented)) {
    return json({ success: false, code: "invalid_secret", error: "Invalid credentials." }, 401);
  }

  if (!origin || origin !== config.origin) {
    return json(
      { success: false, code: "origin_not_authorized", error: "Origin is not authorized." },
      403,
    );
  }

  if (!isPlatformGameKey(gameKey)) {
    return json(
      { success: false, code: "game_not_supported", error: "This game cannot be embedded." },
      400,
    );
  }

  try {
    const session = await createPlatformSession({
      platform: config.platform,
      gameKey,
      origin,
    });

    return json(
      {
        success: true,
        data: {
          sessionToken: session.sessionToken,
          expiresAt: session.expiresAt.toISOString(),
          platform: session.platform,
          gameKey: session.gameKey,
          origin: session.platformOrigin,
          // The token travels in the iframe URL as well as in the Authorization
          // header, so it must never be cached or logged.
          embedPath: `/embed/${session.platform}/${session.gameKey}?session=${encodeURIComponent(
            session.sessionToken,
          )}`,
        },
      },
      201,
    );
  } catch (error) {
    console.error(
      "[platform/session] mint failed",
      error instanceof Error ? error.message : error,
    );
    return json(
      { success: false, code: "session_failed", error: "Unable to create a session." },
      500,
    );
  }
}
