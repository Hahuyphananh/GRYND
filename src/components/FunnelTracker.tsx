"use client";

import { useEffect, useRef } from "react";
import posthog from "posthog-js";
import { useUser } from "@clerk/nextjs";
import {
  gameNameFromEvent,
  getAcquisitionParams,
  isGameStartEvent,
} from "../lib/analytics";

/**
 * Marketing funnel tracking, wired once here so game pages stay untouched.
 *
 * 1. On first identified pageview, UTM / acquisition params are persisted
 *    as person properties (utm_source, utm_medium, utm_campaign, ...) so
 *    every later event is attributable to the acquisition channel.
 * 2. PostHog's `eventCaptured` hook watches for the first `*_game_started`
 *    event and records `first_game_played` + `first_game_played_at` on the
 *    person profile — the top of the signup → first-game funnel.
 *
 * Rendering nothing; purely a side-effect component.
 */
export function FunnelTracker() {
  const { isLoaded, isSignedIn, user } = useUser();
  const registered = useRef(false);

  useEffect(() => {
    if (!process.env.NEXT_PUBLIC_POSTHOG_KEY) return;
    if (!isLoaded || !isSignedIn || !user) return;

    // Persist acquisition params once per user session.
    const params = getAcquisitionParams();
    if (Object.keys(params).length > 0) {
      posthog.people.set(params);
      posthog.register(params);
    }

    if (registered.current) return;
    registered.current = true;

    const handler = (event: { event: string; properties?: Record<string, unknown> }) => {
      try {
        if (!isGameStartEvent(event.event)) return;
        // Only record the very first game ever played for this person.
        if (posthog.get_property("first_game_played")) return;

        const now = new Date().toISOString();
        posthog.people.set({
          first_game_played: gameNameFromEvent(event.event),
          first_game_played_at: now,
        });
        posthog.capture("first_game_started", {
          game: gameNameFromEvent(event.event),
          ...getAcquisitionParams(),
        });
      } catch (err) {
        // Never let analytics break gameplay.
        console.warn("[funnel] first-game tracking failed:", err);
      }
    };

    // Note: posthog.on() has no matching off() in this SDK version — the
    // component mounts once at app root and never unmounts, so there's no
    // leak. The `registered` ref keeps the handler single-fire anyway.
    posthog.on("eventCaptured", handler);
  }, [isLoaded, isSignedIn, user]);

  return null;
}
