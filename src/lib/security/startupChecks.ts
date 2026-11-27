// src/lib/security/startupChecks.ts
//
// BOOT-TIME secret checks, run from `src/instrumentation.ts` before the server
// accepts a request.
//
// The point is to turn "silently degraded security" into "refuses to start".
// The specific failure this exists for: with GAME_SESSION_SECRET (and the
// NEXTAUTH_SECRET / CLERK_SECRET_KEY fallbacks) unset, every self-hosted
// cookie signature used the public development constant, so an attacker could
// forge an admin_mfa cookie. Nothing about the running app looked wrong — it
// served normally, and the forgery was invisible.
//
// Only secrets whose absence silently weakens security are checked. Optional
// integrations (Redis, Resend, Stripe, realtime relay) keep their own
// availability reporting and are not boot failures.

import { INSECURE_FALLBACK_SECRET } from "./requireSecret";

export type StartupCheck = {
  /** Stable identifier, safe to log. */
  name: string;
  ok: boolean;
  /** What to set, never a value. */
  detail: string;
};

const SIGNING_SECRETS = [
  "GAME_SESSION_SECRET",
  "NEXTAUTH_SECRET",
  "CLERK_SECRET_KEY",
] as const;

function configured(env: NodeJS.ProcessEnv, name: string): boolean {
  const value = env[name]?.trim();
  return Boolean(value) && value !== INSECURE_FALLBACK_SECRET;
}

/**
 * The checks that apply to this process. Empty outside a production runtime
 * (development, tests, and `next build`, which must not need runtime secrets).
 */
export function productionSecretChecks(
  env: NodeJS.ProcessEnv = process.env,
): StartupCheck[] {
  if (env.NODE_ENV !== "production" || env.NEXT_PHASE === "phase-production-build") {
    return [];
  }

  return [
    {
      name: "session-signing-secret",
      ok: SIGNING_SECRETS.some((name) => configured(env, name)),
      detail: `set one of ${SIGNING_SECRETS.join(", ")} — it signs the MFA, guest and unsubscribe cookies`,
    },
    {
      name: "clerk-secret-key",
      ok: configured(env, "CLERK_SECRET_KEY"),
      detail:
        "set CLERK_SECRET_KEY — without it the proxy serves every request unauthenticated",
    },
    {
      name: "database-url",
      ok: Boolean(env.DATABASE_URL?.trim()),
      detail: "set DATABASE_URL — every authenticated route needs the database",
    },
  ];
}

/**
 * Production conditions that weaken security but must NOT stop the server.
 *
 * Logged at boot so they surface in a deploy log instead of being discovered
 * in an incident review.
 */
export function productionWarnings(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (env.NODE_ENV !== "production" || env.NEXT_PHASE === "phase-production-build") {
    return [];
  }

  const warnings: string[] = [];

  const redisUrl = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL;
  const redisToken = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN;
  if (!redisUrl?.trim() || !redisToken?.trim()) {
    warnings.push(
      "rate limiting has no shared store (set UPSTASH_REDIS_REST_URL/TOKEN or " +
        "KV_REST_API_URL/TOKEN): every per-IP and per-user budget is held in one " +
        "process, so N instances multiply each limit by N and a restart resets it",
    );
  }

  return warnings;
}

/**
 * Throw when a production process is missing a required secret.
 *
 * The error message names the variable and never a value, so it is safe to
 * appear in a deploy log.
 */
export function assertProductionSecrets(env: NodeJS.ProcessEnv = process.env): void {
  const failing = productionSecretChecks(env).filter((check) => !check.ok);
  if (failing.length === 0) return;

  const message =
    "[startup] refusing to serve in production without required secrets:\n" +
    failing.map((check) => `  - ${check.name}: ${check.detail}`).join("\n");

  console.error(message);
  throw new Error(message);
}
