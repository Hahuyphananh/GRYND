// tests/mfa-attempt-scope.test.mjs
//
// SCOPE ISOLATION for the durable MFA attempt limiter.
//
// The user-level factor (/api/user/security/mfa/verify) now uses the same
// limiter as the admin gate. The keys must therefore be separate: an admin is
// also a regular user, and without a scope a signed-in admin could burn their
// own admin lockout — or clear it — by guessing at the user-level factor. The
// reverse would let a locked-out user lock the admin gate by accident.
//
// Run with: node --import tsx --test tests/mfa-attempt-scope.test.mjs

import test from "node:test";
import assert from "node:assert/strict";

const {
  checkVerifyAttemptLimit,
  recordVerifyFailure,
  clearVerifyAttempts,
  checkSendAttemptLimit,
  recordSendAttempt,
} = await import("../src/lib/security/mfaAttemptLimit.ts");

const USER = "user_scope_isolation";

test("a user-scope lockout never blocks the admin gate for the same id", async () => {
  for (let i = 0; i < 5; i += 1) {
    await recordVerifyFailure(USER, "user");
  }

  assert.equal((await checkVerifyAttemptLimit(USER, "user")).allowed, false);
  assert.equal((await checkVerifyAttemptLimit(USER, "admin")).allowed, true);
});

test("the default scope is admin, so existing callers keep their budget", async () => {
  const id = "user_default_scope";

  for (let i = 0; i < 5; i += 1) {
    await recordVerifyFailure(id);
  }

  assert.equal((await checkVerifyAttemptLimit(id)).allowed, false);
  assert.equal((await checkVerifyAttemptLimit(id, "user")).allowed, true);
});

test("clearing one scope leaves the other intact", async () => {
  const id = "user_clear_one_scope";

  for (let i = 0; i < 5; i += 1) {
    await recordVerifyFailure(id, "user");
    await recordVerifyFailure(id, "admin");
  }

  await clearVerifyAttempts(id, "user");

  assert.equal((await checkVerifyAttemptLimit(id, "user")).allowed, true);
  assert.equal((await checkVerifyAttemptLimit(id, "admin")).allowed, false);
});

test("the OTP send budget is scoped too", async () => {
  const id = "user_send_scope";

  for (let i = 0; i < 3; i += 1) {
    await recordSendAttempt(id, "user");
  }

  assert.equal((await checkSendAttemptLimit(id, "user")).allowed, false);
  assert.equal((await checkSendAttemptLimit(id, "admin")).allowed, true);
});
