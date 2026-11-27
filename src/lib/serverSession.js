import crypto from "crypto";

import { requireSecret } from "./security/requireSecret";

function getEffectiveSecret() {
  // No production fallback (see lib/security/requireSecret.ts): the literal
  // default was public source, so every signed session could be forged.
  return requireSecret(
    ["GAME_SESSION_SECRET", "NEXTAUTH_SECRET", "CLERK_SECRET_KEY"],
    "Server session signing",
  );
}

function b64url(input) {
  return Buffer.from(input).toString("base64url");
}

function signValue(payload) {
  const secret = getEffectiveSecret();
  return crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("base64url");
}

export function createSignedSession(data) {
  const payload = b64url(JSON.stringify(data));
  const signature = signValue(payload);
  return `${payload}.${signature}`;
}

export function verifySignedSession(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [payload, signature] = token.split(".");
  const expected = signValue(payload);

  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length) return null;
  if (!crypto.timingSafeEqual(sigBuf, expBuf)) return null;

  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}
