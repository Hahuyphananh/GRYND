"use client";

import { useUser } from "@clerk/nextjs";
import { calculateAge } from "../lib/ageVerification";

/**
 * Client-side age pre-check.
 *
 * THERE IS NO 18+ RULE ANY MORE. Age is still asked for and stored, so this hook
 * answers "does this account have a birthday on file?" and nothing more:
 *   - page navigations: src/proxy.ts sends a no-age navigation to
 *     /complete-profile (a prompt) and NEVER blocks an under-18 one;
 *   - game/wagering APIs: src/lib/auth/requireAgeVerified.ts only checks that
 *     the caller is signed in.
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
    // True when the metadata yields a parseable age — any age. A missing or
    // unparseable value is "unknown", not "unverified".
    isVerified: verifiedAge !== null,
    isLoaded,
  };
}
