"use client";

import posthog from "posthog-js";
import { useUser } from "@clerk/nextjs";
import { useEffect, useRef } from "react";

/**
 * Identifies the current Clerk user in PostHog so all subsequent
 * events (game_started, game_ended, etc.) are tied to a real user
 * profile instead of being anonymous.
 *
 * - On sign-in  → posthog.identify(userId, { name, email })
 * - On sign-out → posthog.reset()
 */
export function PostHogIdentify() {
  const { isSignedIn, user } = useUser();
  const lastIdentifiedId = useRef<string | null>(null);

  useEffect(() => {
    // PostHog not configured — nothing to do
    if (!process.env.NEXT_PUBLIC_POSTHOG_KEY) return;

    if (isSignedIn && user) {
      // Avoid re-identifying the same user on every re-render
      if (lastIdentifiedId.current === user.id) return;

      const email =
        user.primaryEmailAddress?.emailAddress ??
        user.emailAddresses?.[0]?.emailAddress ??
        undefined;

      posthog.identify(user.id, {
        name: user.fullName ?? undefined,
        email,
      });

      lastIdentifiedId.current = user.id;
    } else if (!isSignedIn && lastIdentifiedId.current !== null) {
      // User explicitly signed out — reset to anonymous
      posthog.reset();
      lastIdentifiedId.current = null;
    }
  }, [isSignedIn, user]);

  return null;
}
