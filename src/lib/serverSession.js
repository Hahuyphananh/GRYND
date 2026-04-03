import crypto from "crypto";

const SECRET = process.env.GAME_SESSION_SECRET || "local-dev-session-secret-change-me";

function b64url(input) {
  return Buffer.from(input).toString("base64url");
}

function signValue(payload) {
  return crypto.createHmac("sha256", SECRET).update(payload).digest("base64url");
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
