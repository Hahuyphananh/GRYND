// src/lib/platform/session.ts
//
// SERVER-side external platform sessions (Phase 5).
//
// ── DESIGN ───────────────────────────────────────────────────────────────
//
//   platform backend ──(Bearer platform secret, server-to-server)──▶
//     POST /api/platform/session  →  { sessionToken, embedPath, expiresAt }
//   platform page ──<iframe src="/embed/<platform>/<game>?session=…">──▶
//   embed client ──(Authorization: Bearer <sessionToken>)──▶ scoped APIs
//
// Tokens are opaque, 32 random bytes, stored only as SHA-256. A row is scoped to
// ONE platform, ONE supported game and ONE exact https origin, and carries a
// server-minted `guest_<32 hex>` identity. There is no user id anywhere in this
// flow: an external session can never become or act as a Clerk account.
//
// ── WHAT A TOKEN CAN DO ──────────────────────────────────────────────────
//
// Only the practice APIs of its `game_key`, and only when those routes
// explicitly opt in via `requirePracticePlayer({ platformGame })`. The gateway
// reads the bearer from the incoming request headers; a token for Tic-Tac-Toe is
// rejected by any other game. Guest PvP, matchmaking, account, wallet, claim and
// admin APIs never accept platform tokens.
//
// ── REPLAY / EXPIRY ──────────────────────────────────────────────────────
//
// Sessions live 15 minutes, are rejected after `expires_at`, and can be revoked
// with `ended_at`. The token is a bearer credential by design (the embed must
// make many API calls); it is delivered only into the iframe and is bound to the
// platform origin, so a leaked token is useless outside that frame. The raw
// token is never persisted, never logged and never returned by validate.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { headers } from "next/headers";
import { eq } from "drizzle-orm";

import { db } from "../../db/client";
import { platformSessions } from "../../db/schema";
import { getPlatformConfig, isPlatformGameKey } from "./config";

/** Short by design: a platform can mint a new session when this one expires. */
export const PLATFORM_SESSION_TTL_MS = 15 * 60 * 1000;

/** Tokens are 32 random bytes base64url — never a guessable id. */
const TOKEN_BYTES = 32;

export type PlatformSessionRecord = {
  tokenHash: string;
  platform: string;
  gameKey: string;
  platformOrigin: string;
  guestId: string;
  createdAt: Date;
  expiresAt: Date;
  endedAt: Date | null;
};

export function hashPlatformToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Constant-time comparison of a presented platform secret. */
export function secretMatches(expected: string, presented: string): boolean {
  if (!expected || !presented) return false;
  const a = createHash("sha256").update(expected, "utf8").digest();
  const b = createHash("sha256").update(presented, "utf8").digest();
  return timingSafeEqual(a, b);
}

/** A server-minted guest identity for an external session. */
export function mintPlatformGuestId(): string {
  return `guest_${randomBytes(16).toString("hex")}`;
}

export type CreatedPlatformSession = {
  sessionToken: string;
  platform: string;
  gameKey: string;
  platformOrigin: string;
  guestId: string;
  createdAt: Date;
  expiresAt: Date;
};

/**
 * Mint a session for an allowlisted platform + supported game + exact origin.
 * Throws on invalid configuration; the route validates first and returns 4xx.
 */
export async function createPlatformSession(input: {
  platform: string;
  gameKey: string;
  origin: string;
  now?: Date;
}): Promise<CreatedPlatformSession> {
  const config = getPlatformConfig(input.platform);
  if (!config) throw new Error("platform_not_configured");
  if (!isPlatformGameKey(input.gameKey)) throw new Error("game_not_supported");
  if (input.origin !== config.origin) throw new Error("origin_not_authorized");

  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + PLATFORM_SESSION_TTL_MS);
  const sessionToken = randomBytes(TOKEN_BYTES).toString("base64url");
  const guestId = mintPlatformGuestId();

  await db.insert(platformSessions).values({
    tokenHash: hashPlatformToken(sessionToken),
    platform: config.platform,
    gameKey: input.gameKey,
    platformOrigin: config.origin,
    guestId,
    createdAt: now,
    expiresAt,
    endedAt: null,
  });

  return {
    sessionToken,
    platform: config.platform,
    gameKey: input.gameKey,
    platformOrigin: config.origin,
    guestId,
    createdAt: now,
    expiresAt,
  };
}

/**
 * Validate an opaque token. Returns null for unknown, ended or expired tokens,
 * and for a token presented for a different platform/game than it was minted
 * for. `now` is injectable for tests only.
 */
export async function validatePlatformToken(
  token: unknown,
  options: { platform?: string; gameKey?: string; now?: Date } = {},
): Promise<PlatformSessionRecord | null> {
  if (typeof token !== "string" || token.length < 32 || token.length > 128) return null;

  const [row] = await db
    .select()
    .from(platformSessions)
    .where(eq(platformSessions.tokenHash, hashPlatformToken(token)))
    .limit(1);

  if (!row) return null;
  if (row.endedAt) return null;

  const now = options.now ?? new Date();
  if (!(row.expiresAt instanceof Date) || row.expiresAt.getTime() <= now.getTime()) {
    return null;
  }
  if (options.platform && row.platform !== options.platform) return null;
  if (options.gameKey && row.gameKey !== options.gameKey) return null;

  return {
    tokenHash: String(row.tokenHash),
    platform: String(row.platform),
    gameKey: String(row.gameKey),
    platformOrigin: String(row.platformOrigin),
    guestId: String(row.guestId),
    createdAt: row.createdAt as Date,
    expiresAt: row.expiresAt as Date,
    endedAt: (row.endedAt as Date | null) ?? null,
  };
}

/** Revoke a session. Idempotent: revoking an unknown/ended token returns false. */
export async function endPlatformSession(token: unknown): Promise<boolean> {
  if (typeof token !== "string" || token.length < 32) return false;
  const [updated] = await db
    .update(platformSessions)
    .set({ endedAt: new Date() })
    .where(eq(platformSessions.tokenHash, hashPlatformToken(token)))
    .returning({ tokenHash: platformSessions.tokenHash });

  return Boolean(updated);
}

/**
 * Resolve the platform guest identity for a practice route.
 *
 * Returns null when there is no bearer token, the token is invalid/expired/
 * revoked, or it was minted for a different game. This is the ONLY way a caller
 * outside the session chain can obtain a guest identity.
 */
export async function readPlatformGuest(
  expectedGameKey: string,
): Promise<{ guestId: string; platform: string; gameKey: string } | null> {
  if (!isPlatformGameKey(expectedGameKey)) return null;

  let bearer = "";
  try {
    const store = await headers();
    const raw = store.get("authorization") || "";
    bearer = raw.startsWith("Bearer ") ? raw.slice("Bearer ".length).trim() : "";
  } catch {
    return null;
  }
  if (!bearer) return null;

  const record = await validatePlatformToken(bearer, { gameKey: expectedGameKey });
  if (!record) return null;

  return {
    guestId: record.guestId,
    platform: record.platform,
    gameKey: record.gameKey,
  };
}
