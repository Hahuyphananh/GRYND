/**
 * coin-refunds.test.mjs
 *
 * Guards the refund reversal path (src/lib/tokens/coinRefunds.ts) and its
 * wiring in the Stripe webhook.
 *
 * TWO LAYERS:
 *   * BEHAVIOUR — `planCoinRefund` and `revokeCoinsForRefund` are exercised for
 *     real. The transaction runner is injectable, so a fake executor models the
 *     order row, the purchase/refund ledger rows and the wallet debit without a
 *     database. That covers a full refund, partial refunds accumulating, a
 *     replayed event, an unfulfilled order, a currency mismatch, an unknown
 *     PaymentIntent and a wallet that cannot cover the reversal.
 *   * SOURCE — the webhook's routing is pinned: `charge.refunded` reverses,
 *     `charge.dispute.created` stays audit-only.
 *
 * Run: node --import tsx --test tests/coin-refunds.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { planCoinRefund, revokeCoinsForRefund } from "../src/lib/tokens/coinRefunds.ts";
import { PURCHASE_REFERENCE_TYPE } from "../src/lib/tokens/coinFulfillment.ts";
import {
  stripeCheckoutSessions,
  tokenTransactions,
  users,
} from "../src/db/schema.ts";

const read = (path) => fs.readFileSync(path, "utf8");
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const WEBHOOK = read("src/app/api/webhooks/stripe/route.ts");
const WEBHOOK_CODE = stripComments(WEBHOOK);

// ── Fixtures ───────────────────────────────────────────────────────────────

const ORDER = {
  sessionId: "cs_test_coin_123",
  clerkId: "user_2buyer",
  packageKey: "medium",
  sessionMode: "payment",
  tokenAmount: 23000,
  amountCents: 1999,
  currency: "usd",
  fulfilled: true,
};

const FULL_REFUND = {
  id: "ch_test_123",
  payment_intent: "pi_test_123",
  amount: 1999,
  amount_refunded: 1999,
  currency: "usd",
  refunded: true,
};

// ── Fake transaction executor ──────────────────────────────────────────────
//
// Models exactly the queries the module makes: a SELECT … FOR UPDATE on
// stripe_checkout_sessions, a SELECT on token_transactions, a conditional
// UPDATE on users (the `balance >= coins` guard decides whether it matches) and
// the INSERT of the refund entry.

function createExecutor({
  order = ORDER,
  ledger = [],
  wallet = 42000,
  chargeAmount,
  refundedAmount,
} = {}) {
  const state = {
    order: order ? { ...order } : null,
    ledger: [...ledger],
    wallet,
    locks: 0,
    debits: [],
    inserts: [],
    matchedDebit: null,
  };

  // What the wallet update sees: the coins are in the SET expression.
  function resolveCall(call) {
    const { op, table, payload } = call;

    if (op === "select" && table === stripeCheckoutSessions) {
      return state.order ? [{ ...state.order }] : [];
    }
    if (op === "select" && table === tokenTransactions) {
      return state.ledger.map((entry) => ({ amount: entry.amount, type: entry.type }));
    }
    if (op === "select" && table === users) {
      // The wallet read that precedes the debit (locked by the module).
      return [{ balance: state.wallet.toFixed(2) }];
    }
    if (op === "update" && table === users) {
      // The module writes the ABSOLUTE remaining balance, so the amount it
      // decided to take is visible as the difference.
      const remaining = Number(payload?.balance);
      const taken = Number((state.wallet - remaining).toFixed(2));
      state.debits.push(taken);
      state.matchedDebit = taken;
      state.wallet = remaining;
      return [];
    }
    if (op === "insert" && table === tokenTransactions) {
      state.inserts.push(payload);
      state.ledger.push(payload);
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

// ── 1. The decision ────────────────────────────────────────────────────────

test("a full refund reverses the whole award", () => {
  const decision = planCoinRefund(FULL_REFUND, ORDER, 0);

  assert.equal(decision.ok, true);
  assert.equal(decision.status, "revoked");
  assert.equal(decision.coinsToRevoke, 23000);
  assert.equal(decision.totalReverseTarget, 23000);
});

test("a partial refund reverses the same fraction of the coins", () => {
  const decision = planCoinRefund(
    { ...FULL_REFUND, amount_refunded: 500, refunded: false },
    ORDER,
    0,
  );

  assert.equal(decision.ok, true);
  // 23000 × 500 ÷ 1999 = 5752.8…
  assert.equal(decision.coinsToRevoke, 5752);
});

test("successive partial refunds add up to exactly one order", () => {
  const third = Math.round(1999 / 3);

  const first = planCoinRefund(
    { ...FULL_REFUND, amount_refunded: third, refunded: false },
    ORDER,
    0,
  );
  assert.equal(first.ok, true);

  const second = planCoinRefund(
    { ...FULL_REFUND, amount_refunded: third * 2, refunded: false },
    ORDER,
    first.coinsToRevoke,
  );
  assert.equal(second.ok, true);

  const reversedSoFar = first.coinsToRevoke + second.coinsToRevoke;
  const thirdPass = planCoinRefund(FULL_REFUND, ORDER, reversedSoFar);
  assert.equal(thirdPass.ok, true);

  const total = reversedSoFar + thirdPass.coinsToRevoke;
  assert.equal(total, 23000, "the refunds must clear the order, never exceed it");

  const replay = planCoinRefund(FULL_REFUND, ORDER, total);
  assert.equal(replay.status, "already_reversed");
});

test("a replayed refund reverses nothing", () => {
  const decision = planCoinRefund(FULL_REFUND, ORDER, 23000);

  assert.equal(decision.ok, false);
  assert.equal(decision.status, "already_reversed");
});

test("an over-reported refund can never exceed the award", () => {
  const decision = planCoinRefund({ ...FULL_REFUND, amount_refunded: 999999 }, ORDER, 0);

  assert.equal(decision.ok, true);
  assert.equal(decision.coinsToRevoke, 23000);
});

test("orders that never paid out are not reversed", () => {
  const unfulfilled = planCoinRefund(FULL_REFUND, { ...ORDER, fulfilled: false }, 0);
  assert.equal(unfulfilled.status, "not_fulfilled");

  const subscription = planCoinRefund(FULL_REFUND, { ...ORDER, sessionMode: "subscription" }, 0);
  assert.equal(subscription.status, "mismatch");

  const unknown = planCoinRefund(FULL_REFUND, null, 0);
  assert.equal(unknown.status, "unknown_purchase");

  const noIntent = planCoinRefund({ ...FULL_REFUND, payment_intent: null }, ORDER, 0);
  assert.equal(noIntent.status, "mismatch");
});

test("an amount refunded of zero reverses nothing", () => {
  for (const amount_refunded of [0, null, undefined, Number.NaN]) {
    const decision = planCoinRefund({ ...FULL_REFUND, amount_refunded }, ORDER, 0);
    assert.equal(decision.ok, false);
    assert.equal(decision.status, "not_refunded");
  }
});

test("a currency mismatch reverses nothing", () => {
  const decision = planCoinRefund({ ...FULL_REFUND, currency: "eur" }, ORDER, 0);
  assert.equal(decision.status, "mismatch");
});

// ── 2. The transaction ─────────────────────────────────────────────────────

test("a refund debits the wallet and writes one reversal entry", async () => {
  const { executor, state } = createExecutor();

  const outcome = await revokeCoinsForRefund(FULL_REFUND, executor);

  assert.equal(outcome.status, "revoked");
  assert.equal(outcome.clerkId, "user_2buyer");
  assert.equal(outcome.coins, 23000);
  assert.equal(outcome.balance, 19000);

  // The order row and then the buyer's wallet are both locked, so the decision
  // and the debit cannot interleave with another delivery.
  assert.equal(state.locks, 2);
  assert.deepEqual(state.debits, [23000]);

  const entry = state.inserts[0];
  assert.equal(entry.type, "refund");
  assert.equal(entry.amount, -23000);
  assert.equal(entry.clerkId, "user_2buyer");
  assert.equal(entry.referenceType, PURCHASE_REFERENCE_TYPE);
  assert.equal(entry.referenceId, "cs_test_coin_123");
  assert.match(entry.note, /medium/);
});

test("a replayed refund event takes nothing and writes nothing", async () => {
  const { executor, state } = createExecutor({
    ledger: [{ type: "purchase", amount: 23000 }, { type: "refund", amount: -23000 }],
  });

  const outcome = await revokeCoinsForRefund(FULL_REFUND, executor);

  assert.equal(outcome.status, "already_reversed");
  assert.equal(state.debits.length, 0);
  assert.equal(state.inserts.length, 0);
});

test("a partial refund only takes the delta beyond earlier refunds", async () => {
  // 1/3 refunded first (6668 coins), then the rest of the money.
  const { executor, state } = createExecutor({
    ledger: [{ type: "purchase", amount: 23000 }, { type: "refund", amount: -6668 }],
  });

  const outcome = await revokeCoinsForRefund(FULL_REFUND, executor);

  assert.equal(outcome.status, "revoked");
  assert.equal(outcome.coins, 23000 - 6668);
  assert.deepEqual(state.debits, [16332]);
});

test("a wallet that cannot cover the reversal is left untouched", async () => {
  const { executor, state } = createExecutor({ wallet: 1000 });

  const outcome = await revokeCoinsForRefund(FULL_REFUND, executor);

  assert.equal(outcome.status, "insufficient_balance");
  assert.equal(state.wallet, 1000, "balance is never driven negative");
  assert.equal(state.inserts.length, 0, "no reversal is recorded against money not taken");
  assert.match(outcome.reason, /manual reconciliation/);
});

test("a charge with no matching order affects no wallet", async () => {
  const { executor, state } = createExecutor({ order: null });

  const outcome = await revokeCoinsForRefund(
    { ...FULL_REFUND, payment_intent: "pi_someone_else" },
    executor,
  );

  assert.equal(outcome.status, "unknown_purchase");
  assert.equal(state.debits.length, 0);
  assert.equal(state.inserts.length, 0);
});

// ── 3. Webhook wiring ──────────────────────────────────────────────────────

test("the webhook reverses coins on charge.refunded", () => {
  const branch = WEBHOOK_CODE.slice(
    WEBHOOK_CODE.indexOf('case "charge.refunded"'),
    WEBHOOK_CODE.indexOf('case "charge.dispute.created"'),
  );

  assert.match(branch, /await revokeCoinsForRefund\(charge\)/);
  assert.match(branch, /stripe_charge_refunded/);
  assert.match(branch, /revokedCoins/);
  assert.match(branch, /coins_revoked/);
});

test("a dispute stays audited and never moves a balance", () => {
  const branch = WEBHOOK_CODE.slice(
    WEBHOOK_CODE.indexOf('case "charge.dispute.created"'),
    WEBHOOK_CODE.indexOf("default:"),
  );

  assert.match(branch, /stripe_charge_dispute_opened/);
  assert.doesNotMatch(branch, /revokeCoinsForRefund|creditUserBalance|fulfillCoinCheckoutSession/);
});

test("reversal runs only behind a verified signature", () => {
  const verifyAt = WEBHOOK_CODE.indexOf("constructEvent");
  const refundAt = WEBHOOK_CODE.indexOf("await revokeCoinsForRefund(");
  assert.ok(verifyAt > 0 && refundAt > verifyAt, "signature verification must come first");
});
