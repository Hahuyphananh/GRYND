// src/app/api/tokens/add-funds/route.js
//
// POST — SECURITY HARDENED: direct client-driven fund additions are
// DISABLED. Previously this endpoint credited the caller's balance
// from a plain authenticated request (an attacker could mint tokens
// with no payment at all).
//
// Tokens can only ever enter a user's balance server-side:
//   * game wins / refunds (server-authoritative game stores),
//   * claim-login-reward (daily reward with cooldown + idempotency),
//   * referral bonuses (server constants),
//   * purchased tokens via the signature-verified payment webhook
//     (POST /api/webhooks/payments — HMAC-verified against
//     PAYMENT_WEBHOOK_SECRET, idempotent per transaction).
//
// This endpoint now only exists so legacy clients get a clear,
// explicit error instead of silently failing — it never mutates a
// balance.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { auditLog } from "../../../../lib/security/auditLog";

export async function POST() {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

  auditLog("tokens_add_funds_blocked", { userId });

  return NextResponse.json(
    {
      success: false,
      error:
        "Direct fund additions are disabled. Token credits are only applied " +
        "via verified payment webhooks.",
    },
    { status: 403 },
  );
}
