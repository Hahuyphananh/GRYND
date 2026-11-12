/**
 * scripts/proof-pro-entitlement.mts
 *
 * End-to-end proof of the PAID → PRO chain, without charging a card.
 *
 * What it exercises for real:
 *   * the actual webhook handler (`POST src/app/api/webhooks/stripe/route.ts`),
 *   * real Stripe signature verification (`STRIPE_WEBHOOK_SECRET`),
 *   * the real database writes (subscription row),
 *   * the real entitlement read the membership API and every badge use
 *     (`findActiveSubscription` / `getMembershipTier`).
 *
 * What it deliberately does NOT do: create a Checkout Session or move money.
 * It delivers the same signed events Stripe would deliver after a payment.
 *
 * SAFETY: it only ever writes rows for a synthetic `user_proof_<timestamp>`
 * clerk id, never touches `users`, and deletes every row it created in a
 * `finally` block. Because it writes to whatever `DATABASE_URL` points at, it
 * refuses to run without an explicit acknowledgement:
 *
 *   DATABASE_SSL_CA_PATH=/path/to/db-ca.pem \
 *   PROOF_ALLOW_PROD_WRITE=1 \
 *     npx tsx scripts/proof-pro-entitlement.mts
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { db } from "../src/db/client";
import { tokenSubscriptions } from "../src/db/schema";
import { getStripe } from "../src/lib/stripe";
import {
  findActiveSubscription,
  getMembershipTier,
} from "../src/lib/stripe/subscriptions";
import { POST as stripeWebhook } from "../src/app/api/webhooks/stripe/route";

if (process.env.PROOF_ALLOW_PROD_WRITE !== "1") {
  console.error(
    "Refusing to run: this proof writes and deletes subscription rows in the database " +
      "DATABASE_URL points at. Re-run with PROOF_ALLOW_PROD_WRITE=1 to acknowledge.",
  );
  process.exit(2);
}

const secret = process.env.STRIPE_WEBHOOK_SECRET;
if (!secret) {
  console.error("STRIPE_WEBHOOK_SECRET is not configured");
  process.exit(2);
}

const clerkId = `user_proof_${Date.now()}`;
const subscriptionId = `sub_proof_${Date.now()}`;
const customerId = `cus_proof_${Date.now()}`;
const stripe = getStripe();

let eventSeq = 0;

/** Deliver one signed event to the REAL webhook handler. */
async function deliver(type: string, object: Record<string, unknown>) {
  const payload = JSON.stringify({
    id: `evt_proof_${Date.now()}_${(eventSeq += 1)}`,
    object: "event",
    api_version: "2026-08-26.dahlia",
    created: Math.floor(Date.now() / 1000),
    type,
    data: { object },
  });
  const signature = stripe.webhooks.generateTestHeaderString({
    payload,
    secret,
  });
  const response = await stripeWebhook(
    new Request("http://localhost/api/webhooks/stripe", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "stripe-signature": signature,
      },
      body: payload,
    }),
  );
  const body = (await response.json().catch(() => null)) as unknown;
  return { status: response.status, body };
}

const session = {
  id: `cs_proof_${Date.now()}`,
  object: "checkout.session",
  mode: "subscription",
  payment_status: "paid",
  status: "complete",
  customer: customerId,
  subscription: subscriptionId,
  amount_total: 999,
  currency: "cad",
  metadata: { clerkId, planKey: "grynd-pro", billingInterval: "monthly" },
};

const nowSeconds = Math.floor(Date.now() / 1000);
const subscription = {
  id: subscriptionId,
  object: "subscription",
  status: "active",
  customer: customerId,
  current_period_start: nowSeconds,
  current_period_end: nowSeconds + 30 * 24 * 3600,
  items: { data: [{ price: { id: "price_proof_monthly" } }] },
  metadata: { clerkId, planKey: "grynd-pro", billingInterval: "monthly" },
};

let failures = 0;
const check = async (name: string, fn: () => Promise<void>) => {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL  ${name}\n      ${(error as Error).message}`);
  }
};

try {
  await db
    .delete(tokenSubscriptions)
    .where(eq(tokenSubscriptions.clerkId, clerkId));

  await check("a signed checkout.session.completed is accepted (200)", async () => {
    const result = await deliver("checkout.session.completed", session);
    assert.equal(result.status, 200, `webhook returned ${result.status}`);
    assert.deepEqual(result.body, { received: true });
  });

  await check("the paying user now has an active subscription row", async () => {
    const row = await findActiveSubscription(clerkId);
    assert.ok(row, "no subscription row was recorded");
    assert.equal(row.clerkId, clerkId);
    assert.equal(row.planKey, "grynd-pro");
    assert.equal(row.status, "active");
  });

  await check("the paying user resolves to GRYND PRO", async () => {
    assert.equal(await getMembershipTier(clerkId), "pro");
  });

  await check("customer.subscription.created keeps the row in sync", async () => {
    const result = await deliver("customer.subscription.created", subscription);
    assert.equal(result.status, 200);
    const row = await findActiveSubscription(clerkId);
    assert.ok(row);
    assert.equal(row.status, "active");
    assert.equal(row.billingInterval, "monthly");
    assert.equal(row.stripeSubscriptionId, subscriptionId);
    assert.equal(await getMembershipTier(clerkId), "pro");
  });

  await check("a paid invoice is acknowledged without granting tokens", async () => {
    const result = await deliver("invoice.paid", {
      id: `in_proof_${Date.now()}`,
      object: "invoice",
      subscription: subscriptionId,
      amount_paid: 999,
    });
    assert.equal(result.status, 200);
    assert.equal(await getMembershipTier(clerkId), "pro");
  });

  await check("a forged signature is rejected before any state changes", async () => {
    const payload = JSON.stringify({
      id: "evt_forged",
      object: "event",
      type: "customer.subscription.deleted",
      data: { object: subscription },
    });
    const response = await stripeWebhook(
      new Request("http://localhost/api/webhooks/stripe", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "stripe-signature": "t=1,v1=deadbeef",
        },
        body: payload,
      }),
    );
    assert.equal(response.status, 400);
    assert.equal(await getMembershipTier(clerkId), "pro", "a forged event changed entitlement");
  });

  await check("cancellation drops the user back to free", async () => {
    const result = await deliver("customer.subscription.deleted", {
      ...subscription,
      status: "canceled",
    });
    assert.equal(result.status, 200);
    assert.equal(await findActiveSubscription(clerkId), null);
    assert.equal(await getMembershipTier(clerkId), "free");
  });
} finally {
  const removed = await db
    .delete(tokenSubscriptions)
    .where(eq(tokenSubscriptions.clerkId, clerkId))
    .returning({ id: tokenSubscriptions.id });
  console.log(`CLEANUP removed ${removed.length} proof subscription row(s)`);
}

console.log(failures === 0 ? "PROOF PASSED" : `PROOF FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
