"use client";

import { useUser, useAuth } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { clearSessionArtifacts } from "../lib/security/sessionCleanup";
import { calculateAge, MINIMUM_AGE } from "../lib/ageVerification";

export function useAgeVerification() {
  const { user, isLoaded } = useUser();
  const { signOut } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!isLoaded || !user) return;

    const birthDate = user.publicMetadata?.birthDate;

    if (!birthDate) {
      router.push("/complete-profile");
      return;
    }

    const age = calculateAge(birthDate);

    if (age !== null && age < MINIMUM_AGE) {
      clearSessionArtifacts();
      signOut();
      router.push("/access-denied");
    }
  }, [user, isLoaded, router, signOut]);

  const verifiedAge = calculateAge(user?.publicMetadata?.birthDate ?? "");

  return {
    isVerified: verifiedAge !== null && verifiedAge >= MINIMUM_AGE,
    isLoaded,
  };
}
