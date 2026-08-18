/**
 * Security — payment webhook signature verification.
 *
 * Pure-function tests for `src/lib/security/paymentWebhook.js`, the
 * HMAC-SHA256 verification used by POST /api/webhooks/payments.
 * The contract under test:
 *   * the signature is a hex HMAC-SHA256 of the RAW body keyed with
 *     PAYMENT_WEBHOOK_SECRET (constant-time compare);
 *   * a wrong secret, tampered body, or missing/malformed header is
 *     rejected;
 *   * the timestamp header bounds replays to a short window (fresh
 *     passes; future / stale / garbage fails).
 *
 * Run: node --test tests/payment-webhook.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  REPLAY_WINDOW_SECONDS,
  signPaymentWebhook,
  verifyPaymentSignature,
  verifyWebhookTimestamp,
} from "../src/lib/security/paymentWebhook.js";

const SECRET = "test-webhook-secret-0123456789";
const BODY = JSON.stringify({
  event: "payment.completed",
  userId: "user_2abcdef123",
  amount: 25,
  transactionId: "txn_1234567890",
});

test("a correctly signed request verifies", () => {
  const sig = signPaymentWebhook(BODY, SECRET);
  assert.equal(verifyPaymentSignature(BODY, sig, SECRET), true);
});

test("tampering with the body invalidates the signature", () => {
  const sig = signPaymentWebhook(BODY, SECRET);
  const tampered = BODY.replace("25", "2500");
  assert.equal(verifyPaymentSignature(tampered, sig, SECRET), false);
});

test("a wrong secret can never forge a valid signature", () => {
  const sig = signPaymentWebhook(BODY, "attacker-secret");
  assert.equal(verifyPaymentSignature(BODY, sig, SECRET), false);
});

test("missing / malformed signature headers are rejected", () => {
  assert.equal(verifyPaymentSignature(BODY, null, SECRET), false);
  assert.equal(verifyPaymentSignature(BODY, undefined, SECRET), false);
  assert.equal(verifyPaymentSignature(BODY, "", SECRET), false);
  assert.equal(verifyPaymentSignature(BODY, "   ", SECRET), false);
  // Wrong-length header (e.g. 12 hex chars vs 64).
  assert.equal(verifyPaymentSignature(BODY, "aabbccddeeff", SECRET), false);
});

test("empty / non-string inputs never throw and always fail", () => {
  assert.equal(verifyPaymentSignature("", signPaymentWebhook("", SECRET), SECRET), false);
  assert.equal(verifyPaymentSignature(null, "x".repeat(64), SECRET), false);
  assert.equal(verifyPaymentSignature(BODY, "x".repeat(64), ""), false);
  assert.equal(verifyPaymentSignature(BODY, "x".repeat(64), null), false);
});

test("signatures are deterministic hex digests", () => {
  const sig = signPaymentWebhook(BODY, SECRET);
  assert.match(sig, /^[0-9a-f]{64}$/);
  assert.equal(signPaymentWebhook(BODY, SECRET), sig);
  // Different secret → different signature.
  assert.notEqual(signPaymentWebhook(BODY, "another-secret-123"), sig);
});

test("timestamp window: fresh events pass, stale/future/garbage fail", () => {
  const now = 1_700_000_000;
  assert.equal(verifyWebhookTimestamp(String(now), now), true);
  assert.equal(
    verifyWebhookTimestamp(String(now - REPLAY_WINDOW_SECONDS), now),
    true,
    "exactly at the window edge is still accepted",
  );
  assert.equal(
    verifyWebhookTimestamp(String(now - REPLAY_WINDOW_SECONDS - 1), now),
    false,
    "older than the window is replayed",
  );
  assert.equal(verifyWebhookTimestamp(String(now + 10), now), false, "future is rejected");
  assert.equal(verifyWebhookTimestamp("not-a-number", now), false);
  assert.equal(verifyWebhookTimestamp(null, now), false);
  assert.equal(verifyWebhookTimestamp(undefined, now), false);
  assert.equal(verifyWebhookTimestamp("", now), false);
});
