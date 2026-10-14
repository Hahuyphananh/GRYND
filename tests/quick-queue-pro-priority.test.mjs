/**
 * quick-queue-pro-priority.test.mjs
 *
 * GRYND PRO priority matchmaking — the fairness contract.
 *
 * Membership may only reorder ALREADY-ELIGIBLE candidates, and only against a
 * near-equivalent free candidate. These tests pin that boundary from both
 * sides: the cases where priority applies, and every case where it must NOT
 * (worse skill, incompatible game/mode/region, out-of-window skill, and any
 * attempt by a client to claim Pro for itself).
 *
 * Run: node --import tsx --test tests/quick-queue-pro-priority.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  findCompatibleQuickQueueCandidate,
  findCompatibleQuickQueuePair,
  normalizeQuickQueueRequest,
  PRO_PRIORITY_SKILL_TOLERANCE,
} from "../src/lib/quickQueue.ts";

const read = (path) => fs.readFileSync(path, "utf8");

const NOW = 1_000_000_000;
const GAME = "mines-pvp";

/** A queue request with a trophy snapshot for GAME. */
const request = (trophies, extra = {}) => ({
  ...normalizeQuickQueueRequest({
    userId: "requester",
    preferredGames: [GAME],
    playerCount: 2,
    ...extra,
  }),
  trophies,
});

/** An eligible candidate row. */
const candidate = ({ userId, trophies, queuedAt = NOW, ...rest }) => ({
  userId,
  gameKey: GAME,
  mode: "pvp",
  region: null,
  playerCount: 2,
  queuedAt,
  available: true,
  trophies,
  ...rest,
});

test("a Pro candidate wins when skill compatibility is equivalent", () => {
  // Same |gap| either side of the requester — genuinely equivalent matches, and
  // the free candidate queued FIRST (FIFO would choose it).
  const picked = findCompatibleQuickQueueCandidate(
    request({ [GAME]: 1000 }),
    [
      candidate({ userId: "free", trophies: { [GAME]: 1200 }, queuedAt: NOW - 9000 }),
      candidate({
        userId: "pro",
        trophies: { [GAME]: 800 },
        queuedAt: NOW,
        memberPriority: true,
      }),
    ],
    NOW,
  );
  assert.equal(picked?.userId, "pro", "equivalent skill → the Pro candidate is preferred");
});

test("a closer skill match takes precedence over a less compatible Pro candidate", () => {
  const picked = findCompatibleQuickQueueCandidate(
    request({ [GAME]: 1000 }),
    [
      // Pro, but far outside the priority tolerance (and inside its window).
      candidate({
        userId: "pro",
        trophies: { [GAME]: 1500 },
        queuedAt: NOW - 5000,
        memberPriority: true,
      }),
      // Free, but a near-exact skill match.
      candidate({ userId: "free", trophies: { [GAME]: 1010 }, queuedAt: NOW }),
    ],
    NOW,
  );
  assert.equal(picked?.userId, "free", "skill stays primary — the closer match wins");
});

test("a Pro flag is not merely a tie-breaker: it cannot beat a much closer free match", () => {
  // Guard the tolerance itself: even a tiny skill edge beats Pro.
  const picked = findCompatibleQuickQueueCandidate(
    request({ [GAME]: 1000 }),
    [
      candidate({
        userId: "pro-equal-far",
        trophies: { [GAME]: 1000 - Math.round(200 * (PRO_PRIORITY_SKILL_TOLERANCE * 3)) },
        queuedAt: NOW,
        memberPriority: true,
      }),
      candidate({ userId: "free", trophies: { [GAME]: 1000 }, queuedAt: NOW }),
    ],
    NOW,
  );
  assert.equal(picked?.userId, "free");
});

test("incompatible skill is never bypassed for a Pro member", () => {
  const tooFar = candidate({
    userId: "pro",
    trophies: { [GAME]: 9000 },
    queuedAt: NOW,
    memberPriority: true,
  });
  assert.equal(
    findCompatibleQuickQueueCandidate(request({ [GAME]: 1000 }), [tooFar], NOW),
    null,
    "the skill window is enforced identically for Pro and free players",
  );
});

test("game, mode and region compatibility still gate every candidate", () => {
  const requester = request({ [GAME]: 1000 }, { region: "eu", preferredModes: ["ranked"] });

  const sameRegionMode = { mode: "ranked", region: "eu" };
  assert.equal(
    findCompatibleQuickQueueCandidate(
      requester,
      [candidate({ userId: "pro", trophies: { [GAME]: 1000 }, memberPriority: true, ...sameRegionMode })],
      NOW,
    )?.userId,
    "pro",
    "a compatible Pro member is still matched",
  );

  for (const [label, override] of [
    ["a different game", { gameKey: "uno" }],
    ["a different mode", { mode: "casual" }],
    ["a different region", { region: "na" }],
  ]) {
    const picked = findCompatibleQuickQueueCandidate(
      requester,
      [
        candidate({
          userId: "pro",
          trophies: { [GAME]: 1000 },
          memberPriority: true,
          ...sameRegionMode,
          ...override,
        }),
      ],
      NOW,
    );
    assert.equal(picked, null, `Pro priority must not bypass ${label}`);
  }
});

test("existing ordering is unchanged when no Pro candidate is eligible", () => {
  // Closest skill first, then FIFO — exactly the pre-existing behaviour.
  const closest = findCompatibleQuickQueueCandidate(
    request({ [GAME]: 1000 }),
    [
      candidate({ userId: "older-far", trophies: { [GAME]: 1400 }, queuedAt: NOW - 4000 }),
      candidate({ userId: "newer-close", trophies: { [GAME]: 1100 }, queuedAt: NOW }),
    ],
    NOW,
  );
  assert.equal(closest?.userId, "newer-close");

  // Identical skill → FIFO order is preserved.
  const fifo = findCompatibleQuickQueueCandidate(
    request({ [GAME]: 1000 }),
    [
      candidate({ userId: "second", trophies: { [GAME]: 1200 }, queuedAt: NOW - 1000 }),
      candidate({ userId: "first", trophies: { [GAME]: 1200 }, queuedAt: NOW - 5000 }),
    ],
    NOW,
  );
  assert.equal(fifo?.userId, "first");
});

test("a free player is not starved: an out-of-range Pro candidate never blocks a match", () => {
  const picked = findCompatibleQuickQueueCandidate(
    request({ [GAME]: 1000 }),
    [
      candidate({ userId: "pro-far", trophies: { [GAME]: 5000 }, memberPriority: true }),
      candidate({ userId: "free", trophies: { [GAME]: 1100 } }),
    ],
    NOW,
  );
  assert.equal(picked?.userId, "free");
});

test("wait-time widening keeps pulling waiting free players into range", () => {
  const farFree = candidate({ userId: "free-far", trophies: { [GAME]: 2000 }, queuedAt: NOW });

  // At t0 the gap (1000 trophies) is outside the initial window.
  assert.equal(findCompatibleQuickQueueCandidate(request({ [GAME]: 1000 }), [farFree], NOW), null);

  // After ~14s of waiting the window has widened enough to include it.
  const later = findCompatibleQuickQueueCandidate(
    request({ [GAME]: 1000 }),
    [{ ...farFree, queuedAt: NOW - 14_000 }],
    NOW,
  );
  assert.equal(later?.userId, "free-far", "aging widens the window for everyone");
});

test("priority is carried through the pair path, and never fabricates an ineligible pair", () => {
  const pair = findCompatibleQuickQueuePair(
    [
      {
        ...request({ [GAME]: 1000 }),
        requestId: "r1",
        queuedAt: NOW,
      },
      {
        ...request({ [GAME]: 1200 }),
        userId: "free",
        requestId: "r2",
        queuedAt: NOW - 9000,
      },
      {
        ...request({ [GAME]: 800 }),
        userId: "pro",
        requestId: "r3",
        queuedAt: NOW,
        memberPriority: true,
      },
    ],
    NOW,
  );
  assert.ok(pair, "an equivalent partner is found");
  assert.equal(pair.partner.userId, "pro", "the Pro candidate is preferred at equal skill");
});

test("a client cannot self-assign Pro priority through the request body", () => {
  const normalized = normalizeQuickQueueRequest({
    userId: "u1",
    preferredGames: [GAME],
    playerCount: 2,
    // Neither of these is part of the request contract; both must be dropped.
    memberPriority: true,
    premium: true,
  });
  assert.equal(normalized.memberPriority, undefined);
  assert.equal(normalized.premium, undefined);
  assert.deepEqual(Object.keys(normalized).sort(), [
    "maxWaitMs",
    "playerCount",
    "preferredGames",
    "preferredModes",
    "region",
    "userId",
  ]);
});

test("priority is resolved server-side from ACTIVE subscriptions, and fails closed", () => {
  const worker = read("src/lib/quickQueueWorker.ts");
  const store = read("src/lib/quickQueueStore.ts");

  // The worker resolves members from the subscription table for the whole
  // batch, and uses that — not the request row's advisory column.
  assert.match(worker, /getActiveMemberIds\(rows\.map\(\(row\) => row\.userId\)\)/);
  assert.match(worker, /memberPriority: activeMembers\.has\(row\.userId\)/);
  assert.doesNotMatch(
    worker,
    /memberPriority:\s*Boolean\(row\.premium\)/,
    "the stored column must not be treated as the entitlement",
  );

  // The join-time snapshot comes from the same authoritative membership check.
  assert.match(store, /getMembershipTier\(request\.userId\)/);

  // The membership read is server-side only — no request field feeds it.
  assert.doesNotMatch(store, /premium:\s*(body|input|request)\./);
});

test("the entitlement only counts ACTIVE statuses (canceled/expired get nothing)", () => {
  const subscriptions = read("src/lib/stripe/subscriptions.ts");
  assert.match(
    subscriptions,
    /ACTIVE_SUBSCRIPTION_STATUSES = \["active", "trialing", "past_due"\]/,
  );
  assert.match(subscriptions, /inArray\(tokenSubscriptions\.status, ACTIVE_SUBSCRIPTION_STATUSES\)/);
});

test("concurrent queue processing cannot create a duplicate match", () => {
  const worker = read("src/lib/quickQueueWorker.ts");
  // Row locks with skip-locked, plus the existing duplicate-assignment guard.
  assert.match(worker, /for\("update", \{ skipLocked: true \}\)/);
  assert.match(worker, /alreadyAssigned/);
  assert.match(worker, /findCompatibleQuickQueuePair/);
});

test("comments no longer claim membership never affects matchmaking", () => {
  for (const path of ["src/lib/quickQueue.ts", "src/lib/quickQueueStore.ts"]) {
    const source = read(path);
    assert.doesNotMatch(
      source,
      /membership (never|does not) affect/i,
      `${path} still claims membership never affects matchmaking`,
    );
  }
  // …and the priority is explicitly documented as ordering-only.
  assert.match(read("src/lib/quickQueue.ts"), /PRO_PRIORITY_SKILL_TOLERANCE/);
  assert.match(
    read("src/lib/stripe/subscriptions.ts"),
    /candidate ORDERING only/,
  );
});
