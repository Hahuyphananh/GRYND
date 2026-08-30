// src/app/api/webhooks/payments/route.js
//
// POST — the ONLY way purchased tokens enter a user's balance.
//
// Security model (never trust the client):
//   * The web app's client-facing endpoints (/api/tokens/add-funds and
//     /api/reset-user-tokens) can NO LONGER credit or set a balance.
//     Balances only move server-side: game outcomes (wins/refunds),
//     claim-login-reward, referral bonuses — and this webhook for
//     purchased tokens.
//   * The payment provider (or an adapter in front of it) must POST a
//     signed envelope here:
//         { event: "payment.completed", userId, amount, transactionId }
//     with headers:
//         x-payment-signature: HMAC-SHA256 hex of the RAW request body
//                              keyed with PAYMENT_WEBHOOK_SECRET
//         x-payment-timestamp: Unix seconds (replay window: 5 min)
//   * The signature is verified with crypto.timingSafeEqual over the
//     exact raw body. A mismatched or missing signature returns 401
//     and never touches the balance.
//   * transactionId drives idempotency (Upstash when configured,
//     in-memory fallback) so a provider retry can never double-credit.
//   * The credit is atomic: `UPDATE ... SET balance = balance + X`.
//
// Integration note: wire your payment provider's "payment succeeded"
// event into this endpoint. If the provider signs its own webhooks
// (e.g. Stripe's stripe-signature), verify with the provider's SDK in
// a thin adapter, then forward the normalized envelope here signed
// with PAYMENT_WEBHOOK_SECRET — or configure the provider to send
// this exact signed envelope directly.

import { NextResponse } from "next/server";
import { auditLog } from "../../../../lib/security/auditLog";
import { logError } from "../../../../lib/logError";
import { claimIdempotency } from "../../../../lib/security/idempotency";
import { creditUserBalance } from "../../../../lib/tokens/creditTokens";
import {
  verifyPaymentSignature,
  verifyWebhookTimestamp,
} from "../../../../lib/security/paymentWebhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MIN_AMOUNT = 0.01;
const MAX_AMOUNT = 100000;

function getSecret() {
  const secret = process.env.PAYMENT_WEBHOOK_SECRET;
  if (!secret || secret.length < 16) return null;
  return secret;
}

export async function POST(req) {
  try {
    return await handlePaymentWebhook(req);
  } catch (error) {
    await logError({
      errorType: "payment_webhook_error",
      errorMessage: error instanceof Error ? error.message : "Payment webhook failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/webhooks/payments",
      metadata: { operation: "payment.completed" },
    });
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}

async function handlePaymentWebhook(req) {
  const secret = getSecret();
  if (!secret) {
    // Refuse to process when the signing secret isn't configured —
    // a misconfigured webhook must fail closed, never credit blindly.
    console.error("[webhooks/payments] PAYMENT_WEBHOOK_SECRET is not configured");
    return NextResponse.json(
      { success: false, error: "Webhook not configured" },
      { status: 503 },
    );
  }

  const rawBody = await req.text().catch(() => "");
  if (!rawBody) {
    return NextResponse.json(
      { success: false, error: "Empty body" },
      { status: 400 },
    );
  }

  // 1) Signature + replay verification (fail closed).
  if (!verifyPaymentSignature(rawBody, req.headers.get("x-payment-signature"), secret)) {
    auditLog("webhook_payment_bad_signature", {});
    return NextResponse.json(
      { success: false, error: "Invalid signature" },
      { status: 401 },
    );
  }
  if (!verifyWebhookTimestamp(req.headers.get("x-payment-timestamp"))) {
    auditLog("webhook_payment_stale_timestamp", {});
    return NextResponse.json(
      { success: false, error: "Stale or missing timestamp" },
      { status: 401 },
    );
  }

  // 2) Parse + validate the envelope.
  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid JSON" },
      { status: 400 },
    );
  }

  const { event, userId, amount, transactionId } = body || {};
  if (event !== "payment.completed") {
    // Unknown events are acknowledged but never credited.
    return NextResponse.json({ success: true, ignored: event ?? null });
  }
  if (typeof userId !== "string" || userId.length < 4 || userId.length > 255) {
    return NextResponse.json(
      { success: false, error: "Invalid userId" },
      { status: 400 },
    );
  }
  const amountNum = Number(amount);
  if (!Number.isFinite(amountNum) || amountNum < MIN_AMOUNT || amountNum > MAX_AMOUNT) {
    return NextResponse.json(
      { success: false, error: "Invalid amount" },
      { status: 400 },
    );
  }
  if (typeof transactionId !== "string" || transactionId.length < 8 || transactionId.length > 128) {
    return NextResponse.json(
      { success: false, error: "Invalid transactionId" },
      { status: 400 },
    );
  }

  // 3) Idempotency — a provider retry for the same transaction can
  //    never double-credit (Upstash when configured, in-memory else).
  const idem = await claimIdempotency(
    req,
    "webhook:payments",
    10 * 60,
    `payment:${transactionId}`,
  );
  if (idem.enforced && !idem.allowed) {
    return NextResponse.json({ success: true, duplicate: true });
  }

  // 4) Atomic credit through the SHARED authority (server-side only,
  //    amount validated above). Single place tokens enter a balance.
  const newBalance = await creditUserBalance(userId, amountNum);

  if (newBalance === null) {
    auditLog("webhook_payment_user_not_found", {
      userId,
      transactionId,
      amount: amountNum,
    });
    return NextResponse.json(
      { success: false, error: "User not found" },
      { status: 404 },
    );
  }

  auditLog("webhook_payment_completed", {
    userId,
    amount: amountNum,
    transactionId,
    newBalance,
  });

  return NextResponse.json({ success: true, newBalance });
}
