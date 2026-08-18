// src/lib/security/paymentWebhook.js
//
// Pure crypto helpers for the signature-verified payment webhook
// (POST /api/webhooks/payments). Kept in a tiny module (instead of
// inline in the route) so the verification logic is unit-testable in
// isolation — the same pattern as the memory-grid engine tests.
//
// Scheme: HMAC-SHA256 over the RAW request body, keyed with
// PAYMENT_WEBHOOK_SECRET, transmitted as hex in the
// `x-payment-signature` header. A `x-payment-timestamp` header (Unix
// seconds) bounds replays to a short window.

import crypto from "crypto";

/** Replay window: a webhook event older than this is rejected. */
export const REPLAY_WINDOW_SECONDS = 5 * 60;

/** HMAC-SHA256 hex digest of the raw body (used to sign + verify). */
export function signPaymentWebhook(rawBody, secret) {
  return crypto
    .createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("hex");
}

/**
 * Constant-time verification of the `x-payment-signature` header
 * against the raw body. Returns false for missing/malformed headers
 * or mismatched digests — never throws.
 */
export function verifyPaymentSignature(rawBody, signatureHeader, secret) {
  if (!rawBody || typeof rawBody !== "string") return false;
  if (!secret || typeof secret !== "string" || secret.length === 0) {
    return false;
  }
  if (typeof signatureHeader !== "string" || !signatureHeader.trim()) {
    return false;
  }
  const expected = signPaymentWebhook(rawBody, secret);
  const provided = signatureHeader.trim();
  if (provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(
    Buffer.from(expected, "utf8"),
    Buffer.from(provided, "utf8"),
  );
}

/**
 * Validate the `x-payment-timestamp` header (Unix seconds). Accepts
 * events within REPLAY_WINDOW_SECONDS of `nowSeconds` (injectable for
 * tests) and rejects anything from the future or older than the
 * window.
 */
export function verifyWebhookTimestamp(
  timestampHeader,
  nowSeconds = Math.floor(Date.now() / 1000),
) {
  const ts = Number(timestampHeader);
  if (!Number.isFinite(ts)) return false;
  const age = nowSeconds - ts;
  return age >= 0 && age <= REPLAY_WINDOW_SECONDS;
}
