// src/lib/auth/requireMfa.ts
//
// MFA (multi-factor authentication) enforcement helper for admin surfaces.
//
// Clerk embeds factor-verification ages in the session token and exposes
// them on the auth object as `factorVerificationAge: [firstFactorAge,
// secondFactorAge]`, where each value is the number of MINUTES since that
// factor was last verified during this session (-1 = never verified).
//
// The admin gate requires a SECOND factor to have been verified recently,
// so a stolen password alone can never reach the dashboard. `auth()` from
// @clerk/nextjs/server returns this field on signed-in sessions.

/** How recently (in minutes) the second factor must have been verified. */
export const ADMIN_MFA_MAX_AGE_MINUTES = 24 * 60; // 24 hours

type FactorVerificationAge = [number, number] | null;

/**
 * True when the current session verified a second factor (MFA) within
 * ADMIN_MFA_MAX_AGE_MINUTES. -1, null, or missing claims all fail closed.
 */
export function hasRecentMfa(factorVerificationAge: FactorVerificationAge): boolean {
  if (!Array.isArray(factorVerificationAge) || factorVerificationAge.length !== 2) {
    return false;
  }
  const secondFactorAge = factorVerificationAge[1];
  return (
    typeof secondFactorAge === "number" &&
    Number.isFinite(secondFactorAge) &&
    secondFactorAge >= 0 &&
    secondFactorAge <= ADMIN_MFA_MAX_AGE_MINUTES
  );
}
