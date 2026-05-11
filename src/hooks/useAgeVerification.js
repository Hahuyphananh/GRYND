"use client";

import { useUser, useAuth } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

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

    const age = Math.floor(
      (Date.now() - new Date(birthDate).getTime()) /
        (365.25 * 24 * 60 * 60 * 1000),
    );

    if (age < 18) {
      signOut();
      router.push("/access-denied");
    }
  }, [user, isLoaded, router, signOut]);

  return {
    isVerified:
      user?.publicMetadata?.birthDate &&
      Math.floor(
        (Date.now() - new Date(user.publicMetadata.birthDate).getTime()) /
          (365.25 * 24 * 60 * 60 * 1000),
      ) >= 18,
    isLoaded,
  };
}
