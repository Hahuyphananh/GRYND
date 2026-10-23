/**
 * coin-fulfilment.test.mjs
 *
 * Guards one-time coin fulfilment (src/lib/tokens/coinFulfillment.ts) and its
 * wiring in the Stripe webhook.
 *
 * TWO LAYERS:
 *   * BEHAVIOUR — `planCoinFulfillment` and `fulfillCoinCheckoutSession` are
 *     exercised for real. The transaction runner is injectable, so a small fake
 *     executor models the ledger row, the wallet credit and the purchase entry
 *     without a database. That covers success, duplicate delivery, replay after
 *     fulfilment, unpaid sessions, and every mismatch.
 *   * SOURCE — the webhook's event routing, signature verification and
 *     subscription/invoice behaviour are pinned from source, because they need
 *     Clerk/Stripe internals (the same approach as upgrade-pro-contract).
 *
 * Run: node --import tsx --test tests/coin-fulfilment.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  PURCHASE_REFERENCE_TYPE,
  fulfillCoinCheckoutSession,
  planCoinFulfillment,
} from "../src/lib/tokens/coinFulfillment.ts";
import {
  stripeCheckoutSessions,
  tokenTransactions,
  users,
} from "../src/db/schema.ts";

const read = (path) => fs.readFileSync(path, "utf8");
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const WEBHOOK = read("src/app/api/webhooks/stripe/route.ts");
const MODULE = read("src/lib/tokens/coinFulfillment.ts");
const MODULE_CODE = stripComments(MODULE);
const SESSION_STATUS = read("src/app/api/stripe/session-status/route.ts");
const SHOP_UI = read("src/components/CoinShopOffers.tsx");
const WAGER = read("src/lib/tokens/wager.ts");

// ── Fixtures ───────────────────────────────────────────────────────────────

const LEDGER_ROW = {
  sessionId: "cs_test_coin_123",
  clerkId: "user_2buyer",
  packageKey: "medium",
  sessionMode: "payment",
  tokenAmount: 23000,
  amountCents: 1999,
  currency: "usd",
  paymentStatus: "open",
  fulfilled: false,
};

const PAID_SESSION = {
  id: "cs_test_coin_123",
  mode: "payment",
  payment_status: "paid",
  amount_total: 1999,
  currency: "usd",
  payment_intent: "pi_test_123",
  customer: "cus_test_123",
  metadata: { clerkId: "user_2buyer", packageKey: "medium", coins: "23000" },
};

// ── Fake transaction executor ──────────────────────────────────────────────
//
// Models exactly the queries the module makes: a SELECT … FOR UPDATE on
// stripe_checkout_sessions, a SELECT on token_transactions, an UPDATE on both
// tables, and the INSERT of the purchase entry. `creditUserBalance` performs
// its own UPDATE on `users`, which is recorded as a credit.

function createExecutor({ row = LEDGER_ROW, purchaseRows = [], wallet = 42000 } = {}) {
  const state = {
    row: row ? { ...row } : null,
    purchaseRows: [...purchaseRows],
    wallet,
    locks: 0,
    credits: 0,
    inserts: [],
    updates: [],
  };

  function resolveCall(call) {
    const { op, table, payload } = call;

    if (op === "select" && table === stripeCheckoutSessions) {
      return state.row ? [{ ...state.row }] : [];
    }
    if (op === "select" && table === tokenTransactions) {
      return state.purchaseRows;
    }
    if (op === "update" && table === stripeCheckoutSessions) {
      state.updates.push(payload);
      state.row = { ...(state.row ?? {}), ...payload };
      return [];
    }
    if (op === "update" && table === users) {
      state.credits += 1;
      return [{ balance: state.wallet }];
    }
    if (op === "insert" && table === tokenTransactions) {
      state.inserts.push(payload);
      state.purchaseRows.push({ id: state.purchaseRows.length + 1 });
      return [];
    }
    return [];
  }

  function builder(op, table) {
    const call = { op, table, payload: null };
    const b = {
      from(t) {
        call.table = t;
        return b;
      },
      where() {
        return b;
      },
      for(mode) {
        if (mode === "update") state.locks += 1;
        return b;
      },
      limit() {
        return b;
      },
      set(v) {
        call.payload = v;
        return b;
      },
      values(v) {
        call.payload = v;
        return b;
      },
      returning() {
        return b;
      },
      then(resolve, reject) {
        return Promise.resolve(resolveCall(call)).then(resolve, reject);
      },
      catch(reject) {
        return Promise.resolve(resolveCall(call)).catch(reject);
      },
      finally(fn) {
        return Promise.resolve(resolveCall(call)).finally(fn);
      },
    };
    return b;
  }

  const tx = {
    select: () => builder("select", null),
    update: (table) => builder("update", table),
    insert: (table) => builder("insert", table),
  };

  return {
    state,
    executor: { transaction: (fn) => fn(tx) },
  };
}

// ── 1. Successful purchase ─────────────────────────────────────────────────

test("a paid, matching session credits the wallet exactly once", async () => {
  const { executor, state } = createExecutor();

  const outcome = await fulfillCoinCheckoutSession(PAID_SESSION, executor);

  assert.equal(outcome.status, "credited");
  assert.equal(outcome.clerkId, "user_2buyer");
  assert.equal(outcome.coins, 23000);
  assert.equal(outcome.balance, 42000);
  assert.equal(outcome.amountCents, 1999);
  assert.equal(outcome.currency, "usd");

  // The row was LOCKED, then credited + marked fulfilled.
  assert.equal(state.locks, 1);
  assert.equal(state.credits, 1);
  assert.equal(state.inserts.length, 1);
  assert.deepEqual(state.updates.at(-1)?.fulfilled, true);
  assert.equal(state.updates.at(-1)?.paymentStatus, "paid");
  assert.equal(state.updates.at(-1)?.paymentIntentId, "pi_test_123");
  assert.equal(state.updates.at(-1)?.customerId, "cus_test_123");
});

test("the purchase entry records the session id and the ledger amount", async () => {
  const { executor, state } = createExecutor();

  await fulfillCoinCheckoutSession(PAID_SESSION, executor);

  const entry = state.inserts[0];
  assert.equal(entry.type, "purchase");
  assert.equal(entry.clerkId, "user_2buyer");
  assert.equal(entry.amount, 23000);
  assert.equal(entry.referenceType, PURCHASE_REFERENCE_TYPE);
  assert.equal(entry.referenceId, "cs_test_coin_123");
  assert.match(entry.note, /medium/);
});

// ── 2. Unpaid / failed / delayed ───────────────────────────────────────────

test("an unpaid session credits nothing", async () => {
  const { executor, state } = createExecutor();

  const outcome = await fulfillCoinCheckoutSession(
    { ...PAID_SESSION, payment_status: "unpaid" },
    executor,
  );

  assert.equal(outcome.status, "not_paid");
  assert.equal(state.credits, 0);
  assert.equal(state.inserts.length, 0);
  assert.equal(state.updates.length, 0);
});

test("a session without a confirmed payment status credits nothing", async () => {
  for (const payment_status of [undefined, null, "no_payment_required", "failed", "canceled"]) {
    const decision = planCoinFulfillment(
      { ...PAID_SESSION, payment_status },
      LEDGER_ROW,
    );
    assert.equal(decision.ok, false, `${payment_status} must not be creditable`);
    assert.equal(decision.status, "not_paid");
  }
});

test("a failed async payment never reaches fulfilment in the webhook", () => {
  const branch = WEBHOOK.slice(
    WEBHOOK.indexOf('case "checkout.session.async_payment_failed"'),
    WEBHOOK.indexOf('case "invoice.paid"'),
  );
  assert.match(branch, /updateStatus\(session\.id, "failed"\)/);
  assert.doesNotMatch(branch, /fulfillCoinCheckoutSession/);
});

// ── 3. Duplicate delivery / replay ─────────────────────────────────────────

test("a duplicate webhook for an already-fulfilled order credits nothing", async () => {
  const { executor, state } = createExecutor({
    row: { ...LEDGER_ROW, fulfilled: true, paymentStatus: "paid" },
  });

  const outcome = await fulfillCoinCheckoutSession(PAID_SESSION, executor);

  assert.equal(outcome.status, "already_fulfilled");
  assert.equal(state.credits, 0);
  assert.equal(state.inserts.length, 0);
  assert.equal(state.updates.length, 0);
});

test("delivering the same paid event twice credits once", async () => {
  const { executor, state } = createExecutor();

  const first = await fulfillCoinCheckoutSession(PAID_SESSION, executor);
  const second = await fulfillCoinCheckoutSession(PAID_SESSION, executor);

  assert.equal(first.status, "credited");
  assert.equal(second.status, "already_fulfilled");
  assert.equal(state.credits, 1, "the wallet is credited exactly once");
  assert.equal(state.inserts.length, 1, "exactly one purchase entry");
});

test("a purchase entry without the fulfilled flag is closed, not credited again", async () => {
  // Models an attempt that wrote the ledger but rolled back the flag.
  const { executor, state } = createExecutor({
    purchaseRows: [{ id: 1 }],
  });

  const outcome = await fulfillCoinCheckoutSession(PAID_SESSION, executor);

  assert.equal(outcome.status, "already_fulfilled");
  assert.equal(state.credits, 0);
  assert.equal(state.inserts.length, 0);
  assert.equal(state.updates.at(-1)?.fulfilled, true);
});

test("fulfilment serialises on the ledger row before crediting", () => {
  // The lock and the credit live in the transaction body; the fulfilled check
  // lives in the pure decision it calls, so the order to prove is
  // lock → decide → credit.
  const body = MODULE_CODE.slice(
    MODULE_CODE.indexOf("export async function fulfillCoinCheckoutSession"),
  );
  const lockIndex = body.indexOf('.for("update")');
  const decideIndex = body.indexOf("planCoinFulfillment(");
  const creditIndex = body.indexOf("creditUserBalance(");

  assert.ok(lockIndex > 0, "the ledger row must be locked FOR UPDATE");
  assert.ok(decideIndex > lockIndex, "the decision must follow the lock");
  assert.ok(creditIndex > decideIndex, "the credit must follow the fulfilled check");
  assert.match(MODULE_CODE, /row\.fulfilled === true/);
  assert.equal(
    (MODULE_CODE.match(/tx\.insert\(tokenTransactions\)/g) ?? []).length,
    1,
    "exactly one purchase entry is written",
  );
});

// ── 4. Mismatches: never trust the payload ─────────────────────────────────

test("a mismatched price credits nothing", async () => {
  const { executor, state } = createExecutor();

  const outcome = await fulfillCoinCheckoutSession(
    { ...PAID_SESSION, amount_total: 1 },
    executor,
  );

  assert.equal(outcome.status, "mismatch");
  assert.match(outcome.reason, /amount/);
  assert.equal(state.credits, 0);
  assert.equal(state.inserts.length, 0);
});

test("a mismatched user credits nobody", async () => {
  const { executor, state } = createExecutor();

  const outcome = await fulfillCoinCheckoutSession(
    { ...PAID_SESSION, metadata: { ...PAID_SESSION.metadata, clerkId: "user_attacker" } },
    executor,
  );

  assert.equal(outcome.status, "mismatch");
  assert.match(outcome.reason, /user/);
  assert.equal(state.credits, 0);
});

test("a mismatched coin award in the payload is refused", async () => {
  const { executor, state } = createExecutor();

  const outcome = await fulfillCoinCheckoutSession(
    { ...PAID_SESSION, metadata: { ...PAID_SESSION.metadata, coins: "999999" } },
    executor,
  );

  assert.equal(outcome.status, "mismatch");
  assert.match(outcome.reason, /coin award/);
  assert.equal(state.credits, 0);
});

test("the award comes from the ledger row, never from metadata", async () => {
  // The row says 23,000 and the payload agrees — the credit is 23,000 even
  // though the package's current catalog value could be anything else.
  const { executor, state } = createExecutor({
    row: { ...LEDGER_ROW, tokenAmount: 5000 },
  });

  const outcome = await fulfillCoinCheckoutSession(
    { ...PAID_SESSION, metadata: { ...PAID_SESSION.metadata, coins: "5000" } },
    executor,
  );

  assert.equal(outcome.status, "credited");
  assert.equal(outcome.coins, 5000);
  assert.equal(state.inserts[0].amount, 5000);
});

test("a mismatched package or currency credits nothing", async () => {
  const pack = planCoinFulfillment(
    { ...PAID_SESSION, metadata: { ...PAID_SESSION.metadata, packageKey: "mega" } },
    LEDGER_ROW,
  );
  assert.equal(pack.status, "mismatch");
  assert.match(pack.reason, /package/);

  const currency = planCoinFulfillment({ ...PAID_SESSION, currency: "cad" }, LEDGER_ROW);
  assert.equal(currency.status, "mismatch");
  assert.match(currency.reason, /currency/);
});

test("an unknown session is never credited", async () => {
  const { executor, state } = createExecutor({ row: null });

  const outcome = await fulfillCoinCheckoutSession(PAID_SESSION, executor);

  assert.equal(outcome.status, "unknown_session");
  assert.equal(state.credits, 0);
  assert.equal(state.inserts.length, 0);
});

test("a subscription session never credits coins", async () => {
  const { executor, state } = createExecutor({
    row: { ...LEDGER_ROW, sessionMode: "subscription" },
  });

  const outcome = await fulfillCoinCheckoutSession(
    { ...PAID_SESSION, mode: "subscription" },
    executor,
  );

  assert.equal(outcome.status, "mismatch");
  assert.equal(state.credits, 0);
});

test("an invalid ledger coin amount is refused", async () => {
  for (const tokenAmount of [0, -5000, 12.5]) {
    const decision = planCoinFulfillment(PAID_SESSION, {
      ...LEDGER_ROW,
      tokenAmount,
    });
    assert.equal(decision.ok, false);
    assert.match(decision.reason, /coin amount/);
  }
});

// ── 5. Webhook wiring preserved ────────────────────────────────────────────

test("signature verification still uses the raw body and the secret", () => {
  assert.match(WEBHOOK, /const rawBody = await req\.text\(\)/);
  assert.match(WEBHOOK, /const signature = req\.headers\.get\("stripe-signature"\)/);
  assert.match(WEBHOOK, /constructEvent\(rawBody, signature, secret\)/);
  assert.match(WEBHOOK, /getStripeWebhookSecret\(\)/);
  assert.match(WEBHOOK, /status: 400/);
});

test("subscription and invoice behaviour is unchanged", () => {
  // The subscription branch is still the one that records the membership, and
  // it runs BEFORE any coin fulfilment.
  const subscriptionIndex = WEBHOOK.indexOf("recordSubscriptionFromCheckout(session)");
  const fulfilIndex = WEBHOOK.indexOf("fulfillCoinCheckoutSession(session)");
  assert.ok(subscriptionIndex > 0 && fulfilIndex > subscriptionIndex);

  for (const handler of [
    'case "customer.subscription.created"',
    'case "customer.subscription.updated"',
    'case "customer.subscription.deleted"',
    'case "invoice.payment_failed"',
  ]) {
    assert.ok(WEBHOOK.includes(handler), `${handler} must stay handled`);
  }
  // invoice.paid is still audit-only.
  const invoicePaid = WEBHOOK.slice(
    WEBHOOK.indexOf('case "invoice.paid"'),
    WEBHOOK.indexOf('case "invoice.payment_failed"'),
  );
  assert.doesNotMatch(invoicePaid, /creditUserBalance|fulfillCoinCheckoutSession/);

  // Fulfilment never touches the subscription tables.
  assert.doesNotMatch(MODULE_CODE, /tokenSubscriptions|tokenSubscriptionPlans/);
});

test("only the webhook credits: no success page or status poll can", () => {
  assert.doesNotMatch(
    SESSION_STATUS,
    /creditUserBalance|tokenTransactions|fulfillCoinCheckoutSession|fulfilled: true/,
  );
  // The shop UI may READ a `fulfilled` flag from the status endpoint, but it
  // never credits: no balance helper, no ledger write, no wallet arithmetic.
  assert.doesNotMatch(SHOP_UI, /creditUserBalance|tokenTransactions|users\.balance/);
  // The purchase ledger has exactly one writer.
  const callers = fs
    .readdirSync("src", { recursive: true })
    .map((name) => String(name).replace(/\\/g, "/"))
    .filter((name) => /\.(ts|tsx|js|jsx)$/.test(name))
    .filter((name) => read(`src/${name}`).includes("creditUserBalance("))
    .sort();
  assert.deepEqual(
    callers,
    ["lib/tokens/coinFulfillment.ts", "lib/tokens/creditTokens.ts"],
    "creditUserBalance must only be called from fulfilment (and defined in its module)",
  );
});

test("balance and ledger mechanics are reused, not reimplemented", () => {
  assert.match(MODULE, /import \{ creditUserBalance \} from "\.\/creditTokens"/);
  assert.match(MODULE, /creditUserBalance\(clerkId, coins, tx\)/);
  // No direct balance arithmetic in the new path: the shared helper owns it.
  assert.doesNotMatch(MODULE_CODE, /users\.balance|balance: sql|peakBalance/);
  assert.doesNotMatch(MODULE_CODE, /\bMath\.min\(|\bMath\.max\(/);
});

test("no wallet ceiling, wager limit or payout cap is touched", () => {
  assert.doesNotMatch(MODULE_CODE, /MAX_WIN_PER_MATCH|GLOBAL_MAX_BET|HIGH_VARIANCE_MAX_BET/);
  // The wager layer keeps its guards.
  assert.match(WAGER, /balance < amount/);
  assert.match(WAGER, /MAX_WIN_PER_MATCH/);
  assert.match(WAGER, /balance: sql`\$\{users\.balance\} - \$\{amount\}`/);
});

// ── 6. Refunds and disputes ────────────────────────────────────────────────

test("refund and dispute events are audited, not auto-reversed", () => {
  assert.ok(WEBHOOK.includes('case "charge.refunded"'));
  assert.ok(WEBHOOK.includes('case "charge.dispute.created"'));
  assert.match(WEBHOOK, /stripe_charge_refunded/);
  assert.match(WEBHOOK, /stripe_charge_dispute_opened/);
  assert.match(WEBHOOK, /manual_coin_reconciliation_required/);

  const auditBlock = WEBHOOK.slice(
    WEBHOOK.indexOf('case "charge.refunded"'),
    WEBHOOK.indexOf("default:"),
  );
  assert.doesNotMatch(auditBlock, /creditUserBalance|fulfillCoinCheckoutSession/);
  assert.doesNotMatch(auditBlock, /tokenTransactions/);

  // The reconciliation trail: the session row keeps the PaymentIntent id.
  assert.match(MODULE_CODE, /paymentIntentId/);
  assert.match(MODULE_CODE, /customerId/);
});

test("audit payloads carry no secrets or card data", () => {
  const auditCalls = WEBHOOK.match(/auditLog\([\s\S]*?\);/g) ?? [];
  for (const call of auditCalls) {
    for (const forbidden of [
      "card",
      "number",
      "cvc",
      "secret",
      "client_secret",
      "stripe_signature",
      "payment_method_details",
    ]) {
      assert.ok(
        !new RegExp(`\\b${forbidden}\\b`, "i").test(call),
        `audit payload must not contain ${forbidden}: ${call.slice(0, 80)}`,
      );
    }
  }
});
