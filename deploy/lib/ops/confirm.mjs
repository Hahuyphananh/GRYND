// deploy/lib/ops/confirm.mjs
//
// Confirmation for a privileged action, in two steps that cannot be collapsed:
//
//   plan   read-only. Returns the exact unit, the exact action, the impact and
//          a signed token with a short expiry. Nothing is executed.
//   apply  requires that token, the exact confirmation phrase, an authenticated
//          actor and a reason. Each is checked on the server.
//
// The token is an HMAC over {operation, actor, nonce, iat, exp}. That binds it
// to one operation and one actor — a token minted for the realtime restart
// cannot restart the app, and one issued to operator A cannot be redeemed by
// operator B. It is single-use: the nonce is appended to a consumed list before
// the command runs, so a crash cannot resurrect a spent token.
//
// There is no session or cookie anywhere in this path, so there is no CSRF
// token to steal: the confirmation materials are per-request, unforgeable
// without the HMAC key, and expire in two minutes.

import crypto from "node:crypto";
import fs from "node:fs/promises";

import { DeployError } from "../layout.mjs";

/** Two minutes: long enough to read the impact text, short enough to be stale. */
export const DEFAULT_TTL_MS = 120_000;

/** A key shorter than this is treated as "not configured". */
export const MIN_SECRET_LENGTH = 32;

/** How many spent nonces are retained (well beyond the token lifetime). */
const CONSUMED_RETAIN = 2_000;

/**
 * Resolve the HMAC key: an explicit env secret, else a generated 0600 file.
 * The file keeps the key on the box rather than in the dashboard's environment,
 * which is the smaller blast radius if the dashboard's env is ever dumped.
 */
export async function loadTokenSecret({ paths, env = process.env } = {}) {
  const fromEnv = env.GRYND_OPS_TOKEN_SECRET;
  if (typeof fromEnv === "string" && fromEnv.length > 0) {
    if (fromEnv.length < MIN_SECRET_LENGTH) {
      throw new DeployError(
        `GRYND_OPS_TOKEN_SECRET must be at least ${MIN_SECRET_LENGTH} characters`,
        "TOKEN_SECRET_WEAK",
      );
    }
    return Buffer.from(fromEnv, "utf8");
  }

  try {
    const existing = await fs.readFile(paths.tokenKey, "utf8");
    const trimmed = existing.trim();
    if (trimmed.length >= MIN_SECRET_LENGTH) return Buffer.from(trimmed, "utf8");
    // A truncated or empty key file is a real fault, not something to paper over.
    throw new DeployError(
      `Token key at ${paths.tokenKey} is too short; delete it to regenerate`,
      "TOKEN_SECRET_WEAK",
    );
  } catch (error) {
    if (error instanceof DeployError) throw error;
    if (error.code !== "ENOENT") throw error;
  }

  await fs.mkdir(paths.stateOps, { recursive: true, mode: 0o700 });
  const generated = crypto.randomBytes(32).toString("hex");
  // "wx" so two concurrent first-runs cannot overwrite each other's key.
  try {
    await fs.writeFile(paths.tokenKey, `${generated}\n`, { mode: 0o600, flag: "wx" });
    return Buffer.from(generated, "utf8");
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const existing = (await fs.readFile(paths.tokenKey, "utf8")).trim();
    if (existing.length < MIN_SECRET_LENGTH) {
      throw new DeployError(`Token key at ${paths.tokenKey} is unusable`, "TOKEN_SECRET_WEAK");
    }
    return Buffer.from(existing, "utf8");
  }
}

function sign(payloadB64, secret) {
  return crypto.createHmac("sha256", secret).update(payloadB64).digest();
}

function toBase64Url(buffer) {
  return Buffer.from(buffer).toString("base64url");
}

/** Stable identity for an audit line: proves which plan was redeemed, not the token. */
export function tokenFingerprint(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex").slice(0, 16);
}

/**
 * Mint a token for one operation and one actor.
 *
 * @param {{ operation: { id: string }, actor: string, secret: Buffer, now?: Date, ttlMs?: number }} input
 */
export function issueToken({ operation, actor, secret, now = new Date(), ttlMs = DEFAULT_TTL_MS }) {
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    throw new DeployError("Refusing to sign a plan token with a weak key", "TOKEN_SECRET_WEAK");
  }
  if (typeof actor !== "string" || actor.trim().length === 0) {
    throw new DeployError("A plan needs an authenticated actor", "ACTOR_REQUIRED");
  }
  if (!Number.isInteger(ttlMs) || ttlMs <= 0 || ttlMs > 15 * 60_000) {
    throw new DeployError("ttlMs must be a positive integer under 15 minutes", "INVALID_TTL");
  }

  const issuedAt = now.getTime();
  const payload = {
    v: 1,
    op: operation.id,
    actor,
    nonce: crypto.randomBytes(16).toString("hex"),
    iat: issuedAt,
    exp: issuedAt + ttlMs,
  };
  const payloadB64 = toBase64Url(JSON.stringify(payload));
  const token = `${payloadB64}.${toBase64Url(sign(payloadB64, secret))}`;
  return {
    token,
    nonce: payload.nonce,
    issuedAt: new Date(issuedAt).toISOString(),
    expiresAt: new Date(payload.exp).toISOString(),
    ttlMs,
  };
}

/**
 * Verify a token for this operation and actor. Every failure has its own code
 * so an operator can tell "expired" from "wrong operation" from "replayed".
 */
export function verifyToken({ token, operation, actor, secret, now = new Date(), consumed = new Set() }) {
  const invalid = (message, code = "TOKEN_INVALID") => new DeployError(message, code);

  if (typeof token !== "string" || token.length === 0 || token.length > 512) {
    throw invalid("A plan token is required");
  }
  const parts = token.split(".");
  if (parts.length !== 2 || parts[0].length === 0 || parts[1].length === 0) {
    throw invalid("Malformed plan token");
  }

  const [payloadB64, macB64] = parts;
  let suppliedMac;
  try {
    suppliedMac = Buffer.from(macB64, "base64url");
  } catch {
    throw invalid("Malformed plan token");
  }
  const expectedMac = sign(payloadB64, secret);
  if (suppliedMac.length !== expectedMac.length || !crypto.timingSafeEqual(suppliedMac, expectedMac)) {
    throw invalid("Plan token signature does not verify");
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    throw invalid("Plan token payload is not readable");
  }
  if (!payload || typeof payload !== "object" || payload.v !== 1) {
    throw invalid("Unsupported plan token version");
  }
  if (typeof payload.nonce !== "string" || !/^[0-9a-f]{32}$/.test(payload.nonce)) {
    throw invalid("Plan token has no usable nonce");
  }
  if (typeof payload.exp !== "number" || typeof payload.iat !== "number") {
    throw invalid("Plan token has no expiry");
  }

  if (now.getTime() > payload.exp) {
    throw invalid("Plan token has expired; request a new plan", "TOKEN_EXPIRED");
  }
  if (payload.op !== operation.id) {
    throw invalid(
      `Plan token was issued for ${JSON.stringify(payload.op)}, not ${JSON.stringify(operation.id)}`,
      "TOKEN_WRONG_OPERATION",
    );
  }
  if (payload.actor !== actor) {
    throw invalid("Plan token was issued to a different actor", "TOKEN_WRONG_ACTOR");
  }
  if (consumed.has(payload.nonce)) {
    throw invalid("Plan token has already been used", "TOKEN_REPLAYED");
  }

  return payload;
}

/** Nonces already spent. Bounded read so a corrupt file cannot exhaust memory. */
export async function readConsumed(paths) {
  let text;
  try {
    text = await fs.readFile(paths.consumed, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return new Set();
    throw error;
  }
  const lines = text.split("\n").filter(Boolean).slice(-CONSUMED_RETAIN);
  const nonces = new Set();
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (typeof entry?.nonce === "string") nonces.add(entry.nonce);
    } catch {
      // A torn line is skipped, not fatal: the token still has to verify.
    }
  }
  return nonces;
}

/**
 * Spend a nonce. Called BEFORE the command runs so a crash mid-restart cannot
 * leave a usable token behind.
 */
export async function consumeNonce({ paths, nonce, operation, actor, now = new Date() }) {
  await fs.mkdir(paths.stateOps, { recursive: true, mode: 0o700 });
  await fs.appendFile(
    paths.consumed,
    `${JSON.stringify({ nonce, operation, actor, at: now.toISOString() })}\n`,
    { mode: 0o600 },
  );
}

/** Rewrite the consumed list to its retained tail. Explicit, never automatic. */
export async function pruneConsumed({ paths }) {
  let text;
  try {
    text = await fs.readFile(paths.consumed, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }
  const lines = text.split("\n").filter(Boolean);
  if (lines.length <= CONSUMED_RETAIN) return lines.length;
  const kept = lines.slice(-CONSUMED_RETAIN);
  const tmp = `${paths.consumed}.tmp-${process.pid}`;
  await fs.writeFile(tmp, `${kept.join("\n")}\n`, { mode: 0o600 });
  await fs.rename(tmp, paths.consumed);
  return kept.length;
}
