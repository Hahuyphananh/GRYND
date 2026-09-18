"use client";

import { useUser } from "@clerk/nextjs";
import { calculateAge, MINIMUM_AGE } from "../lib/ageVerification";

/**
 * Client-side age pre-check.
 *
 * IMPORTANT: age is AUTHORITATIVE on the server, not here. The server writes
 * `users.age` (via /api/update-birthdate) and enforces it in two places:
 *   - page navigations: src/proxy.ts redirects no-age -> /complete-profile and
 *     under-18 -> /access-denied;
 *   - game/wagering APIs: src/lib/auth/requireAgeVerified.ts rejects with
 *     403 unless the DB age is >= 18.
 *
 * Clerk's `publicMetadata.birthDate` is written best-effort by
 * /api/update-birthdate and can therefore be missing or stale (e.g. the Clerk
 * write failed, or the user changed their DOB). This hook must NEVER treat
 * that as definitive proof that an account has no verified age, and must NEVER
 * sign the user out or clear their session because of it — doing so revoked a
 * valid Clerk session and produced 401s on authenticated requests. It is a
 * read-only convenience for UI that wants to know whether an age is already
 * on file; enforcement is left entirely to the server.
 */
export function useAgeVerification() {
  const { user, isLoaded } = useUser();

  const verifiedAge = calculateAge(user?.publicMetadata?.birthDate ?? "");

  return {
    // Positive-only: true when the metadata yields a valid 18+ age. A missing
    // or unparseable value is "unknown", not "unverified".
    isVerified: verifiedAge !== null && verifiedAge >= MINIMUM_AGE,
    isLoaded,
  };
}
