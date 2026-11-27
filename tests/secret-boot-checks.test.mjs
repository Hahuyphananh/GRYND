// tests/secret-boot-checks.test.mjs
//
// The self-hosted signatures (admin/user MFA, guest session, unsubscribe)
// used to fall back to a public literal when no secret was configured. In
// production that is a forgery primitive, so the rule now is: resolve a real
// secret or refuse. These tests pin the three states that matter —
// production (throws), development (warns, uses the fallback), and
// `next build` (must not need runtime secrets).
//
// Run with: node --import tsx --test tests/secret-boot-checks.test.mjs

import test from "node:test";
import assert from "node:assert/strict";

import {
  INSECURE_FALLBACK_SECRET,
  requireSecret,
} from "../src/lib/security/requireSecret.ts";
import {
  assertProductionSecrets,
  productionSecretChecks,
  productionWarnings,
} from "../src/lib/security/startupChecks.ts";

const SECRETS = ["GAME_SESSION_SECRET", "NEXTAUTH_SECRET", "CLERK_SECRET_KEY"];

test("production never falls back to the public development secret", () => {
  assert.throws(
    () => requireSecret(SECRETS, "Test signing", { NODE_ENV: "production" }),
    /no signing secret configured/,
  );

  // A value that IS the fallback is treated as unset.
  assert.throws(() =>
    requireSecret(SECRETS, "Test signing", {
      NODE_ENV: "production",
      GAME_SESSION_SECRET: INSECURE_FALLBACK_SECRET,
    }),
  );
});

test("production uses the first configured secret in the chain", () => {
  assert.equal(
    requireSecret(SECRETS, "Test signing", {
      NODE_ENV: "production",
      GAME_SESSION_SECRET: "  ",
      NEXTAUTH_SECRET: "real-secret",
    }),
    "real-secret",
  );
});

test("development keeps the fallback so local work needs no secrets", () => {
  assert.equal(
    requireSecret(SECRETS, "Test signing", { NODE_ENV: "development" }),
    INSECURE_FALLBACK_SECRET,
  );
});

test("a build is not a production runtime", () => {
  const buildEnv = {
    NODE_ENV: "production",
    NEXT_PHASE: "phase-production-build",
  };

  assert.deepEqual(productionSecretChecks(buildEnv), []);
  assert.doesNotThrow(() => assertProductionSecrets(buildEnv));
  assert.equal(
    requireSecret(SECRETS, "Test signing", buildEnv),
    INSECURE_FALLBACK_SECRET,
  );
});

test("a missing shared rate-limit store is a warning, not a boot failure", () => {
  assert.deepEqual(productionWarnings({ NODE_ENV: "development" }), []);

  const withoutRedis = productionWarnings({
    NODE_ENV: "production",
    GAME_SESSION_SECRET: "signing-secret",
    CLERK_SECRET_KEY: "sk_test_placeholder",
    DATABASE_URL: "postgres://user:pass@host/db",
  });
  assert.equal(withoutRedis.length, 1);
  assert.match(withoutRedis[0], /rate limiting has no shared store/);

  // A warning must never stop the server.
  assert.doesNotThrow(() =>
    assertProductionSecrets({
      NODE_ENV: "production",
      GAME_SESSION_SECRET: "signing-secret",
      CLERK_SECRET_KEY: "sk_test_placeholder",
      DATABASE_URL: "postgres://user:pass@host/db",
    }),
  );

  assert.deepEqual(
    productionWarnings({
      NODE_ENV: "production",
      UPSTASH_REDIS_REST_URL: "https://redis.example",
      UPSTASH_REDIS_REST_TOKEN: "placeholder",
    }),
    [],
  );
});

test("the boot check names missing secrets and never prints values", () => {
  assert.deepEqual(productionSecretChecks({ NODE_ENV: "development" }), []);

  const production = productionSecretChecks({ NODE_ENV: "production" });
  assert.deepEqual(
    production.map((check) => check.name).sort(),
    ["clerk-secret-key", "database-url", "session-signing-secret"],
  );
  assert.ok(production.every((check) => check.ok === false));

  assert.throws(
    () => assertProductionSecrets({ NODE_ENV: "production" }),
    (error) => {
      for (const name of [
        "session-signing-secret",
        "clerk-secret-key",
        "database-url",
      ]) {
        assert.ok(error.message.includes(name), `message must name ${name}`);
      }
      return true;
    },
  );

  // Fully configured production passes.
  assert.doesNotThrow(() =>
    assertProductionSecrets({
      NODE_ENV: "production",
      GAME_SESSION_SECRET: "signing-secret",
      CLERK_SECRET_KEY: "sk_test_placeholder",
      DATABASE_URL: "postgres://user:pass@host/db",
    }),
  );
});
