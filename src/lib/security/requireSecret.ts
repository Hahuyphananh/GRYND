// src/lib/security/requireSecret.ts
//
// THE ONE WAY A SIGNING SECRET IS RESOLVED.
//
// Every self-hosted signature in this app (the admin/user MFA cookies, the
// guest session cookie, email unsubscribe links, the legacy server session)
// used to fall back to the literal string "development-only-insecure-secret"
// when no secret was configured. In production that is not a degraded mode, it
// is a forgery primitive: the fallback is public source, so anyone could mint
// an `admin_mfa` cookie for any user id and walk through the admin gate, or
// forge an unsubscribe link for any account.
//
// So production never falls back. `requireSecret()` throws at the call site —
// fail closed — and `instrumentation.register()` checks the whole set at boot
// (see startupChecks.ts) so a deployment is refused loudly instead of serving
// unsigned authority.

export const INSECURE_FALLBACK_SECRET = "development-only-insecure-secret";

/**
 * `next build` evaluates modules with NODE_ENV=production but serves no
 * traffic. Throwing there would fail a CI build that legitimately has no
 * runtime secrets; the boot check and the call sites still refuse to SERVE
 * without them.
 */
function isBuildPhase(env: NodeJS.ProcessEnv): boolean {
  return env.NEXT_PHASE === "phase-production-build";
}

/** True when this process is a real production runtime (not a build). */
export function isProductionRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === "production" && !isBuildPhase(env);
}

const warned = new Set<string>();

/**
 * Resolve the first configured, non-placeholder secret from `names`.
 *
 * In production a missing secret is an error, never a fallback. Outside
 * production the development value is returned once with a warning, so local
 * work does not need every secret in `.env.local`.
 */
export function requireSecret(
  names: readonly string[],
  purpose: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value && value !== INSECURE_FALLBACK_SECRET) return value;
  }

  if (isProductionRuntime(env)) {
    throw new Error(
      `[security] ${purpose} has no signing secret configured. Set one of ` +
        `${names.join(", ")}. Refusing to sign with the public development ` +
        "fallback in production.",
    );
  }

  if (!warned.has(purpose)) {
    warned.add(purpose);
    console.warn(
      `[security] ${purpose}: no signing secret configured ` +
        `(${names.join(", ")}); using the development fallback. ` +
        "This is never acceptable in production.",
    );
  }

  return INSECURE_FALLBACK_SECRET;
}
