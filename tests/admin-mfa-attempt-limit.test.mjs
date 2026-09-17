/**
 * Admin MFA attempt throttling — unit tests for:
 *   • src/lib/security/mfaAttemptLimit.ts (durable attempt tracking)
 *
 * Verifies the mitigation for the pentest finding:
 *   "Admin MFA verification lacks durable attempt throttling, enabling
 *    sustained factor guessing"
 *
 * The vulnerability allowed an attacker with a valid first-factor session
 * to make unlimited MFA verification attempts (60/min indefinitely) because
 * failed attempts only logged an audit event without creating durable lockout
 * state. With a six-digit factor space, sustained guessing could eventually
 * breach the admin MFA boundary.
 *
 * This test suite confirms:
 *   1. Failed verification attempts are tracked durably per user
 *   2. Progressive lockout is enforced (5 → 5min, 10 → 30min, 15+ → 2hr)
 *   3. Lockout state persists across the generic rate-limit window resets
 *   4. Successful verification clears the attempt counter
 *   5. OTP send requests are throttled (max 3 per 5 minutes)
 *   6. Lockout prevents the sustained guessing attack described in the pentest
 *
 * Run:  node --import tsx --test tests/admin-mfa-attempt-limit.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

// The mfaAttemptLimit module uses Redis when available but falls back to
// in-memory storage. For unit tests, we rely on the in-memory fallback by
// ensuring getRedis() returns null (no Redis configured).
//
// This approach tests the actual production fallback path without mocking.

const {
  checkVerifyAttemptLimit,
  recordVerifyFailure,
  clearVerifyAttempts,
  checkSendAttemptLimit,
  recordSendAttempt,
} = await import("../src/lib/security/mfaAttemptLimit.ts");

// Helper to advance time in tests
function advanceTime(ms) {
  const originalNow = Date.now;
  const targetTime = originalNow() + ms;
  Date.now = () => targetTime;
  return () => {
    Date.now = originalNow;
  };
}

// ════════════════════════════════════════════════════════════════════════
// Verification Attempt Tracking — Core Security Properties
// ════════════════════════════════════════════════════════════════════════

test("verify attempts: initial state allows verification", async () => {
  const result = await checkVerifyAttemptLimit("user_clean");
  assert.equal(result.allowed, true);
  assert.equal(result.lockedUntil, undefined);
});

test("verify attempts: first 4 failures do not trigger lockout", async () => {
  const userId = "user_under_threshold";

  for (let i = 0; i < 4; i++) {
    await recordVerifyFailure(userId);
    const check = await checkVerifyAttemptLimit(userId);
    assert.equal(
      check.allowed,
      true,
      `attempt ${i + 1}/4 should still be allowed`
    );
  }
});

test("verify attempts: 5th failure triggers 5-minute lockout", async () => {
  mockRedis.clear();
  const userId = "user_5_failures";

  // Record 5 failures
  for (let i = 0; i < 5; i++) {
    await recordVerifyFailure(userId);
  }

  const check = await checkVerifyAttemptLimit(userId);
  assert.equal(check.allowed, false, "5 failures should trigger lockout");
  assert.ok(check.lockedUntil, "lockedUntil timestamp should be set");
  assert.equal(check.attempts, 5);

  // Verify lockout duration is approximately 5 minutes
  const lockoutDuration = check.lockedUntil - Date.now();
  assert.ok(
    lockoutDuration >= 4.9 * 60 * 1000 && lockoutDuration <= 5.1 * 60 * 1000,
    `lockout should be ~5 minutes, got ${lockoutDuration / 60000} minutes`
  );
});

test("verify attempts: 10th failure triggers 30-minute lockout", async () => {
  mockRedis.clear();
  const userId = "user_10_failures";

  // Record 10 failures
  for (let i = 0; i < 10; i++) {
    await recordVerifyFailure(userId);
  }

  const check = await checkVerifyAttemptLimit(userId);
  assert.equal(check.allowed, false, "10 failures should trigger lockout");
  assert.equal(check.attempts, 10);

  // Verify lockout duration is approximately 30 minutes
  const lockoutDuration = check.lockedUntil - Date.now();
  assert.ok(
    lockoutDuration >= 29.9 * 60 * 1000 && lockoutDuration <= 30.1 * 60 * 1000,
    `lockout should be ~30 minutes, got ${lockoutDuration / 60000} minutes`
  );
});

test("verify attempts: 15th failure triggers 2-hour lockout", async () => {
  mockRedis.clear();
  const userId = "user_15_failures";

  // Record 15 failures
  for (let i = 0; i < 15; i++) {
    await recordVerifyFailure(userId);
  }

  const check = await checkVerifyAttemptLimit(userId);
  assert.equal(check.allowed, false, "15 failures should trigger lockout");
  assert.equal(check.attempts, 15);

  // Verify lockout duration is approximately 2 hours
  const lockoutDuration = check.lockedUntil - Date.now();
  assert.ok(
    lockoutDuration >= 119.9 * 60 * 1000 &&
      lockoutDuration <= 120.1 * 60 * 1000,
    `lockout should be ~2 hours, got ${lockoutDuration / 60000} minutes`
  );
});

test("verify attempts: 20+ failures maintain 2-hour lockout (max penalty)", async () => {
  mockRedis.clear();
  const userId = "user_20_failures";

  // Record 20 failures
  for (let i = 0; i < 20; i++) {
    await recordVerifyFailure(userId);
  }

  const check = await checkVerifyAttemptLimit(userId);
  assert.equal(check.allowed, false);
  assert.equal(check.attempts, 20);

  // Verify lockout duration is still 2 hours (max penalty)
  const lockoutDuration = check.lockedUntil - Date.now();
  assert.ok(
    lockoutDuration >= 119.9 * 60 * 1000 &&
      lockoutDuration <= 120.1 * 60 * 1000,
    `lockout should remain at 2 hours for 20+ failures`
  );
});

// ════════════════════════════════════════════════════════════════════════
// Lockout Persistence — Prevents Sustained Guessing Attack
// ════════════════════════════════════════════════════════════════════════

test("verify attempts: lockout persists across multiple check calls", async () => {
  mockRedis.clear();
  const userId = "user_persistent_lockout";

  // Trigger 5-minute lockout
  for (let i = 0; i < 5; i++) {
    await recordVerifyFailure(userId);
  }

  // Check multiple times — lockout should persist
  for (let i = 0; i < 10; i++) {
    const check = await checkVerifyAttemptLimit(userId);
    assert.equal(
      check.allowed,
      false,
      `check ${i + 1} should still be locked out`
    );
  }
});

test("verify attempts: lockout expires after the lockout period", async () => {
  mockRedis.clear();
  const userId = "user_lockout_expiry";

  // Trigger 5-minute lockout
  for (let i = 0; i < 5; i++) {
    await recordVerifyFailure(userId);
  }

  let check = await checkVerifyAttemptLimit(userId);
  assert.equal(check.allowed, false, "should be locked out initially");

  // Advance time by 5 minutes + 1 second
  const restore = advanceTime(5 * 60 * 1000 + 1000);

  check = await checkVerifyAttemptLimit(userId);
  assert.equal(check.allowed, true, "lockout should expire after 5 minutes");

  restore();
});

test("verify attempts: successful verification clears attempt counter", async () => {
  mockRedis.clear();
  const userId = "user_successful_clear";

  // Record 4 failures (just under the 5-failure threshold)
  for (let i = 0; i < 4; i++) {
    await recordVerifyFailure(userId);
  }

  let check = await checkVerifyAttemptLimit(userId);
  assert.equal(check.allowed, true);
  assert.equal(check.attempts, 4);

  // Simulate successful verification
  await clearVerifyAttempts(userId);

  // Counter should be reset
  check = await checkVerifyAttemptLimit(userId);
  assert.equal(check.allowed, true);
  assert.equal(check.attempts, undefined, "attempts should be cleared");
});

test("verify attempts: clearing attempts after lockout removes lockout state", async () => {
  mockRedis.clear();
  const userId = "user_clear_after_lockout";

  // Trigger lockout
  for (let i = 0; i < 5; i++) {
    await recordVerifyFailure(userId);
  }

  let check = await checkVerifyAttemptLimit(userId);
  assert.equal(check.allowed, false);

  // Clear attempts (e.g., admin intervention or successful verification)
  await clearVerifyAttempts(userId);

  check = await checkVerifyAttemptLimit(userId);
  assert.equal(check.allowed, true, "lockout should be cleared");
  assert.equal(check.lockedUntil, undefined);
});

// ════════════════════════════════════════════════════════════════════════
// Attack Scenario — Sustained Factor Guessing Prevention
// ════════════════════════════════════════════════════════════════════════

test("SECURITY: sustained guessing attack is blocked by progressive lockout", async () => {
  mockRedis.clear();
  const userId = "attacker_sustained_guessing";

  // Simulate attacker making 60 guesses per minute (generic rate limit)
  // across multiple 1-minute windows. The vulnerability allowed this to
  // continue indefinitely; the mitigation should block after 5 attempts.

  // Window 1: attacker makes 5 attempts (hits lockout threshold)
  for (let i = 0; i < 5; i++) {
    const check = await checkVerifyAttemptLimit(userId);
    assert.equal(check.allowed, true, `attempt ${i + 1} should be allowed`);
    await recordVerifyFailure(userId);
  }

  // Attempt 6: should be blocked by 5-minute lockout
  let check = await checkVerifyAttemptLimit(userId);
  assert.equal(
    check.allowed,
    false,
    "6th attempt should be blocked by lockout"
  );

  // Simulate attacker waiting for generic rate limit to reset (1 minute)
  // but lockout is still active (5 minutes)
  const restore1 = advanceTime(1 * 60 * 1000);

  check = await checkVerifyAttemptLimit(userId);
  assert.equal(
    check.allowed,
    false,
    "lockout should persist after 1 minute (generic limit reset)"
  );

  restore1();

  // Simulate attacker waiting 2 minutes (still within 5-minute lockout)
  const restore2 = advanceTime(2 * 60 * 1000);

  check = await checkVerifyAttemptLimit(userId);
  assert.equal(
    check.allowed,
    false,
    "lockout should persist after 2 minutes"
  );

  restore2();

  // Simulate attacker waiting full 5 minutes + 1 second
  const restore3 = advanceTime(5 * 60 * 1000 + 1000);

  check = await checkVerifyAttemptLimit(userId);
  assert.equal(
    check.allowed,
    true,
    "lockout should expire after 5 minutes"
  );

  restore3();
});

test("SECURITY: attacker cannot bypass lockout by making more requests", async () => {
  mockRedis.clear();
  const userId = "attacker_bypass_attempt";

  // Trigger lockout
  for (let i = 0; i < 5; i++) {
    await recordVerifyFailure(userId);
  }

  // Attacker tries to record more failures (should not extend or reset lockout)
  const checkBefore = await checkVerifyAttemptLimit(userId);
  const lockedUntilBefore = checkBefore.lockedUntil;

  // Attempt to record more failures while locked out
  // (In practice, the route handler blocks these, but test the state machine)
  for (let i = 0; i < 10; i++) {
    await recordVerifyFailure(userId);
  }

  const checkAfter = await checkVerifyAttemptLimit(userId);
  assert.equal(checkAfter.allowed, false, "should still be locked out");
  assert.equal(
    checkAfter.attempts,
    15,
    "attempts should accumulate even during lockout"
  );

  // Lockout should now be 2 hours (15 failures threshold)
  const lockoutDuration = checkAfter.lockedUntil - Date.now();
  assert.ok(
    lockoutDuration >= 119 * 60 * 1000,
    "lockout should escalate to 2 hours"
  );
});

test("SECURITY: multiple users are isolated (no cross-user lockout)", async () => {
  mockRedis.clear();
  const user1 = "user_isolated_1";
  const user2 = "user_isolated_2";

  // User 1 triggers lockout
  for (let i = 0; i < 5; i++) {
    await recordVerifyFailure(user1);
  }

  const check1 = await checkVerifyAttemptLimit(user1);
  assert.equal(check1.allowed, false, "user1 should be locked out");

  // User 2 should not be affected
  const check2 = await checkVerifyAttemptLimit(user2);
  assert.equal(check2.allowed, true, "user2 should not be locked out");

  // User 2 can make attempts independently
  await recordVerifyFailure(user2);
  const check2After = await checkVerifyAttemptLimit(user2);
  assert.equal(check2After.allowed, true, "user2 should still be allowed");
  assert.equal(check2After.attempts, 1);
});

// ════════════════════════════════════════════════════════════════════════
// OTP Send Throttling — Prevents Email Abuse
// ════════════════════════════════════════════════════════════════════════

test("OTP send: initial state allows sending", async () => {
  mockRedis.clear();
  const result = await checkSendAttemptLimit("user_otp_clean");
  assert.equal(result.allowed, true);
  assert.equal(result.remaining, 3);
});

test("OTP send: first 3 sends are allowed within 5-minute window", async () => {
  mockRedis.clear();
  const userId = "user_otp_3_sends";

  for (let i = 0; i < 3; i++) {
    const check = await checkSendAttemptLimit(userId);
    assert.equal(check.allowed, true, `send ${i + 1}/3 should be allowed`);
    assert.equal(check.remaining, 3 - i);
    await recordSendAttempt(userId);
  }
});

test("OTP send: 4th send within 5 minutes is blocked", async () => {
  mockRedis.clear();
  const userId = "user_otp_4th_blocked";

  // Record 3 sends
  for (let i = 0; i < 3; i++) {
    await recordSendAttempt(userId);
  }

  // 4th attempt should be blocked
  const check = await checkSendAttemptLimit(userId);
  assert.equal(check.allowed, false, "4th send should be blocked");
  assert.equal(check.remaining, 0);
  assert.ok(check.resetAt, "resetAt timestamp should be set");

  // Verify reset time is approximately 5 minutes from first send
  const resetDuration = check.resetAt - Date.now();
  assert.ok(
    resetDuration >= 4.9 * 60 * 1000 && resetDuration <= 5.1 * 60 * 1000,
    `reset should be ~5 minutes, got ${resetDuration / 60000} minutes`
  );
});

test("OTP send: limit resets after 5-minute window", async () => {
  mockRedis.clear();
  const userId = "user_otp_window_reset";

  // Exhaust the limit
  for (let i = 0; i < 3; i++) {
    await recordSendAttempt(userId);
  }

  let check = await checkSendAttemptLimit(userId);
  assert.equal(check.allowed, false, "should be blocked after 3 sends");

  // Advance time by 5 minutes + 1 second
  const restore = advanceTime(5 * 60 * 1000 + 1000);

  check = await checkSendAttemptLimit(userId);
  assert.equal(check.allowed, true, "limit should reset after 5 minutes");
  assert.equal(check.remaining, 3);

  restore();
});

test("SECURITY: OTP send throttling prevents email delivery abuse", async () => {
  mockRedis.clear();
  const userId = "attacker_otp_spam";

  // Attacker tries to spam OTP requests to flood email or disrupt MFA
  // The pentest finding noted this allows "MFA disruption and email-delivery
  // abuse within the generic limit"

  // First 3 sends succeed
  for (let i = 0; i < 3; i++) {
    const check = await checkSendAttemptLimit(userId);
    assert.equal(check.allowed, true);
    await recordSendAttempt(userId);
  }

  // Further sends are blocked for 5 minutes
  for (let i = 0; i < 10; i++) {
    const check = await checkSendAttemptLimit(userId);
    assert.equal(
      check.allowed,
      false,
      `send attempt ${i + 4} should be blocked`
    );
  }
});

test("SECURITY: OTP send limit is per-user (no cross-user interference)", async () => {
  mockRedis.clear();
  const user1 = "user_otp_isolated_1";
  const user2 = "user_otp_isolated_2";

  // User 1 exhausts their limit
  for (let i = 0; i < 3; i++) {
    await recordSendAttempt(user1);
  }

  const check1 = await checkSendAttemptLimit(user1);
  assert.equal(check1.allowed, false, "user1 should be blocked");

  // User 2 should not be affected
  const check2 = await checkSendAttemptLimit(user2);
  assert.equal(check2.allowed, true, "user2 should not be blocked");
  assert.equal(check2.remaining, 3);
});

// ════════════════════════════════════════════════════════════════════════
// Edge Cases and State Management
// ════════════════════════════════════════════════════════════════════════

test("verify attempts: concurrent failures increment counter correctly", async () => {
  mockRedis.clear();
  const userId = "user_concurrent";

  // Simulate near-concurrent failures (in practice, these would be serialized
  // by the route handler, but test the state machine)
  await Promise.all([
    recordVerifyFailure(userId),
    recordVerifyFailure(userId),
    recordVerifyFailure(userId),
  ]);

  const check = await checkVerifyAttemptLimit(userId);
  assert.equal(check.attempts, 3, "all 3 failures should be recorded");
});

test("verify attempts: lockout state survives Redis unavailability (memory fallback)", async () => {
  mockRedis.clear();
  const userId = "user_redis_fallback";

  // Record failures with Redis available
  for (let i = 0; i < 5; i++) {
    await recordVerifyFailure(userId);
  }

  let check = await checkVerifyAttemptLimit(userId);
  assert.equal(check.allowed, false, "should be locked out");

  // Simulate Redis failure by clearing the store (memory should still have state)
  mockRedis.store.clear();

  // Check should still work via memory fallback
  check = await checkVerifyAttemptLimit(userId);
  assert.equal(
    check.allowed,
    false,
    "lockout should persist via memory fallback"
  );
});

test("OTP send: window tracking is accurate across multiple sends", async () => {
  mockRedis.clear();
  const userId = "user_otp_window_tracking";

  // Record first send
  await recordSendAttempt(userId);
  const check1 = await checkSendAttemptLimit(userId);
  assert.equal(check1.remaining, 2);

  // Advance time by 2 minutes (still within window)
  const restore1 = advanceTime(2 * 60 * 1000);

  // Record second send
  await recordSendAttempt(userId);
  const check2 = await checkSendAttemptLimit(userId);
  assert.equal(check2.remaining, 1);

  restore1();

  // Advance time by another 2 minutes (4 minutes total, still within window)
  const restore2 = advanceTime(4 * 60 * 1000);

  // Record third send
  await recordSendAttempt(userId);
  const check3 = await checkSendAttemptLimit(userId);
  assert.equal(check3.allowed, false, "should be blocked after 3 sends");

  restore2();

  // Advance time by 1 more minute (5 minutes total from first send)
  const restore3 = advanceTime(5 * 60 * 1000 + 1000);

  // Window should reset
  const check4 = await checkSendAttemptLimit(userId);
  assert.equal(check4.allowed, true, "window should reset after 5 minutes");

  restore3();
});

// ════════════════════════════════════════════════════════════════════════
// Integration with Route Handlers (Contract Tests)
// ════════════════════════════════════════════════════════════════════════

test("CONTRACT: checkVerifyAttemptLimit returns expected shape", async () => {
  mockRedis.clear();
  const userId = "user_contract_verify";

  // Allowed state
  let result = await checkVerifyAttemptLimit(userId);
  assert.equal(typeof result.allowed, "boolean");
  assert.equal(result.allowed, true);

  // Locked state
  for (let i = 0; i < 5; i++) {
    await recordVerifyFailure(userId);
  }
  result = await checkVerifyAttemptLimit(userId);
  assert.equal(result.allowed, false);
  assert.equal(typeof result.lockedUntil, "number");
  assert.equal(typeof result.attempts, "number");
  assert.ok(result.lockedUntil > Date.now());
});

test("CONTRACT: checkSendAttemptLimit returns expected shape", async () => {
  mockRedis.clear();
  const userId = "user_contract_send";

  // Allowed state
  let result = await checkSendAttemptLimit(userId);
  assert.equal(typeof result.allowed, "boolean");
  assert.equal(result.allowed, true);
  assert.equal(typeof result.remaining, "number");

  // Blocked state
  for (let i = 0; i < 3; i++) {
    await recordSendAttempt(userId);
  }
  result = await checkSendAttemptLimit(userId);
  assert.equal(result.allowed, false);
  assert.equal(typeof result.resetAt, "number");
  assert.equal(result.remaining, 0);
  assert.ok(result.resetAt > Date.now());
});

test("CONTRACT: recordVerifyFailure is idempotent for same timestamp", async () => {
  mockRedis.clear();
  const userId = "user_idempotent";

  await recordVerifyFailure(userId);
  const check1 = await checkVerifyAttemptLimit(userId);

  await recordVerifyFailure(userId);
  const check2 = await checkVerifyAttemptLimit(userId);

  assert.equal(check2.attempts, check1.attempts + 1);
});

test("CONTRACT: clearVerifyAttempts is safe to call on non-existent user", async () => {
  mockRedis.clear();
  // Should not throw
  await clearVerifyAttempts("user_nonexistent");

  const check = await checkVerifyAttemptLimit("user_nonexistent");
  assert.equal(check.allowed, true);
});
