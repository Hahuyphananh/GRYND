import crypto from "crypto";

let hasWarnedMissingSecret = false;

function getEffectiveSecret() {
  const configured =
    process.env.GAME_SESSION_SECRET ||
    process.env.NEXTAUTH_SECRET ||
    process.env.CLERK_SECRET_KEY;

  if (!configured) {
    if (!hasWarnedMissingSecret) {
      console.warn(
        "[serverSession] No session secret configured. Using development fallback secret.",
      );
      hasWarnedMissingSecret = true;
    }
    return "development-only-insecure-secret";
  }

  return configured;
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
