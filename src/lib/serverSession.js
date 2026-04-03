import crypto from "crypto";

function getEffectiveSecret() {
  const configured = process.env.GAME_SESSION_SECRET;

  // Do not fail at module evaluation time (breaks builds on some platforms).
  // Fail only when session signing/verification is actually invoked at runtime.
  if (!configured) {
    if (process.env.NODE_ENV === "development") {
      return "development-only-insecure-secret";
    }
    throw new Error("GAME_SESSION_SECRET is required outside development.");
  }

  return configured;
}

function b64url(input) {
  return Buffer.from(input).toString("base64url");
}

function signValue(payload) {
  const secret = getEffectiveSecret();
  return crypto.createHmac("sha256", secret).update(payload).digest("base64url");
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
