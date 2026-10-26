// src/lib/admin/mfaDiagnostics.ts
//
// Why the admin second factor is or is not available on this host.
//
// After the move to a new VM, every MFA factor can silently become unavailable
// because each one is gated on an environment variable that was never carried
// over. Worse, /api/admin/mfa/status used to hardcode `email: true`, so the UI
// promised a factor that could not work. This module reports PRESENCE ONLY:
// booleans, enums and variable NAMES. It never returns a value, a prefix or a
// length, because the page that renders it is admin-reachable but public-facing.
//
// Pure and injectable so it can be unit-tested without touching process.env.

export type FactorStatus = {
  configured: boolean;
  /** The environment variables this factor needs, by name. */
  variables: string[];
  reason: string | null;
};

export type MfaDiagnostics = {
  factors: {
    email: FactorStatus;
    totp: FactorStatus;
    passphrase: FactorStatus;
  };
  anyConfigured: boolean;
  /** Where the admin_mfa cookie's HMAC key comes from. */
  sessionSecret: {
    source: "env" | "clerk-fallback" | "insecure-fallback";
    secure: boolean;
    reason: string | null;
  };
  /** OTP codes are only durable across instances when Redis is configured. */
  otpStore: {
    kind: "redis" | "memory";
    reason: string | null;
  };
  warnings: Array<{ code: string; severity: "critical" | "warning" | "info"; message: string }>;
};

function present(env: NodeJS.ProcessEnv, name: string): boolean {
  const value = env[name];
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Mirror `getSecret()` in src/lib/auth/adminMfa.ts. If that order changes, this
 * must change with it — a mismatch here would misreport the security posture.
 */
export function sessionSecretSource(env: NodeJS.ProcessEnv): MfaDiagnostics["sessionSecret"] {
  if (present(env, "GAME_SESSION_SECRET")) {
    return { source: "env", secure: true, reason: null };
  }
  if (present(env, "NEXTAUTH_SECRET")) {
    return { source: "env", secure: true, reason: null };
  }
  if (present(env, "CLERK_SECRET_KEY")) {
    return {
      source: "clerk-fallback",
      secure: true,
      reason:
        "Falling back to CLERK_SECRET_KEY. Works, but rotating the Clerk key invalidates every admin MFA cookie.",
    };
  }
  return {
    source: "insecure-fallback",
    secure: false,
    reason: "No signing secret is configured; the MFA cookie is signed with a hard-coded development value.",
  };
}

export function buildMfaDiagnostics(env: NodeJS.ProcessEnv = process.env): MfaDiagnostics {
  const resend = present(env, "RESEND_API_KEY");
  const smtp = present(env, "SMTP_HOST");
  const emailConfigured = resend || smtp;

  const totpSecret = present(env, "ADMIN_TOTP_SECRET");
  const passphrase = present(env, "ADMIN_MFA_PASSPHRASE");

  const redis =
    present(env, "UPSTASH_REDIS_REST_URL") && present(env, "UPSTASH_REDIS_REST_TOKEN");

  const factors = {
    email: {
      configured: emailConfigured,
      variables: ["RESEND_API_KEY", "RESEND_FROM_EMAIL", "SMTP_HOST", "SMTP_USER", "SMTP_PASS", "SMTP_FROM"],
      reason: emailConfigured
        ? null
        : "No mail provider is configured: set RESEND_API_KEY (or SMTP_HOST with SMTP_USER/SMTP_PASS).",
    },
    totp: {
      configured: totpSecret,
      variables: ["ADMIN_TOTP_SECRET"],
      reason: totpSecret ? null : "ADMIN_TOTP_SECRET is not set, so the authenticator app cannot be used.",
    },
    passphrase: {
      configured: passphrase,
      variables: ["ADMIN_MFA_PASSPHRASE"],
      reason: passphrase ? null : "ADMIN_MFA_PASSPHRASE is not set, so the passphrase factor cannot be used.",
    },
  };

  const warnings: MfaDiagnostics["warnings"] = [];

  if (!emailConfigured && !totpSecret && !passphrase) {
    warnings.push({
      code: "NO_MFA_FACTOR",
      severity: "critical",
      message:
        "No admin second factor is configured on this host. Admin access will be refused until one of the variables above is set.",
    });
  } else {
    if (!emailConfigured) {
      warnings.push({
        code: "EMAIL_FACTOR_DISABLED",
        severity: "warning",
        message: "The email code factor is unavailable, so only the configured alternative can be used.",
      });
    }
    if (!totpSecret && !passphrase) {
      warnings.push({
        code: "SINGLE_FACTOR_PATH",
        severity: "warning",
        message: "Email is the only available factor. If mail delivery breaks, admin access breaks with it.",
      });
    }
  }

  if (!redis) {
    warnings.push({
      code: "OTP_STORE_IN_MEMORY",
      severity: "warning",
      message:
        "Email codes are stored in process memory because Redis is not configured. Two app instances, or a restart between sending and verifying, will invalidate the code.",
    });
  }

  const secret = sessionSecretSource(env);
  if (!secret.secure) {
    warnings.push({ code: "MFA_SECRET_INSECURE", severity: "critical", message: secret.reason ?? "Insecure signing secret." });
  } else if (secret.source === "clerk-fallback") {
    warnings.push({ code: "MFA_SECRET_FALLBACK", severity: "info", message: secret.reason ?? "" });
  }

  return {
    factors,
    anyConfigured: emailConfigured || totpSecret || passphrase,
    sessionSecret: secret,
    otpStore: redis
      ? { kind: "redis", reason: null }
      : { kind: "memory", reason: "UPSTASH_REDIS_REST_URL/TOKEN not set; codes live in one process only." },
    warnings,
  };
}

/** The variables an operator must carry over on a new host. Names only. */
export function requiredMfaVariables(): string[] {
  return [
    "GAME_SESSION_SECRET",
    "ADMIN_MFA_PASSPHRASE",
    "ADMIN_TOTP_SECRET",
    "RESEND_API_KEY",
    "RESEND_FROM_EMAIL",
    "UPSTASH_REDIS_REST_URL",
    "UPSTASH_REDIS_REST_TOKEN",
  ];
}
