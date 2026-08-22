// src/lib/auth/adminMfa.ts
// Self-hosted admin second-factor verification marker.
//
// Clerk's built-in MFA is a paid feature, so the admin gate uses a signed,
// HttpOnly cookie that we issue ourselves after the user passes one of the
// three second factors (email code, authenticator app, or passphrase). The
// cookie lasts 24 hours — the same window Clerk's `hasRecentMfa` enforced.
//
// Signing uses the Web Crypto API (not Node's `crypto` module) so the same
// code runs both in the Edge middleware and in Node route handlers.

import { hasRecentMfa } from "./requireMfa";

export const ADMIN_MFA_COOKIE = "admin_mfa";
export const ADMIN_MFA_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const ADMIN_MFA_MAX_AGE_SECONDS = Math.floor(ADMIN_MFA_MAX_AGE_MS / 1000);

type FactorVerificationAge = [number, number] | null;

function getSecret(): string {
  return (
    process.env.GAME_SESSION_SECRET ||
    process.env.NEXTAUTH_SECRET ||
    process.env.CLERK_SECRET_KEY ||
    "development-only-insecure-secret"
  );
}

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str: string): Uint8Array {
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function getKey(): Promise<CryptoKey> {
  const secret = getSecret();
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function sign(payload: string): Promise<string> {
  const key = await getKey();
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return b64urlEncode(new Uint8Array(sig));
}

export async function issueAdminMfaToken(userId: string): Promise<string> {
  const payload = b64urlEncode(
    new TextEncoder().encode(
      JSON.stringify({ sub: userId, exp: Date.now() + ADMIN_MFA_MAX_AGE_MS }),
    ),
  );
  return `${payload}.${await sign(payload)}`;
}

export async function verifyAdminMfaToken(
  token: string | undefined,
  userId: string,
): Promise<boolean> {
  if (!token || typeof token !== "string" || !token.includes(".")) return false;

  const [payload, signature] = token.split(".");
  if (!payload || !signature) return false;

  const key = await getKey();
  const sigBytes = b64urlDecode(signature);
  const expected = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)),
  );
  if (sigBytes.length !== expected.length) return false;

  let diff = 0;
  for (let i = 0; i < sigBytes.length; i++) diff |= sigBytes[i] ^ expected[i];
  if (diff !== 0) return false;

  try {
    const data = JSON.parse(new TextDecoder().decode(b64urlDecode(payload)));
    if (!data || data.sub !== userId) return false;
    const exp = Number(data.exp);
    return Number.isFinite(exp) && exp > Date.now();
  } catch {
    return false;
  }
}

/**
 * True when the admin session satisfies the second-factor requirement via
 * either Clerk's native MFA (if enabled) or our self-hosted cookie.
 */
export async function isSecondFactorSatisfied(
  factorVerificationAge: FactorVerificationAge,
  token: string | undefined,
  userId: string,
): Promise<boolean> {
  return hasRecentMfa(factorVerificationAge) || (await verifyAdminMfaToken(token, userId));
}
