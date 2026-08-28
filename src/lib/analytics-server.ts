// Server-side PostHog helper for API-route event capture (reviews funnel).
// Client-side events (pageviews, sign_up_completed, first_game_started)
// go through posthog-js; server events need the posthog-node SDK.

import { PostHog } from "posthog-node";

let client: PostHog | null = null;

function getPostHog(): PostHog | null {
  const apiKey = process.env.POSTHOG_API_KEY || process.env.NEXT_PUBLIC_POSTHOG_KEY;
  if (!apiKey) return null;
  if (!client) {
    client = new PostHog(apiKey, {
      host: process.env.NEXT_PUBLIC_POSTHOG_HOST || "https://us.i.posthog.com",
    });
  }
  return client;
}

export interface ServerAnalyticsEvent {
  event: string;
  distinctId: string;
  properties?: Record<string, unknown>;
}

/**
 * Best-effort server event capture. Never throws — analytics must not
 * break an API response.
 */
export function captureServerEvent({ event, distinctId, properties }: ServerAnalyticsEvent): void {
  try {
    const ph = getPostHog();
    if (!ph) return;
    ph.capture({ distinctId, event, properties });
    // Flush is a no-op when batching is disabled; this keeps the capture
    // promise from being dropped on serverless exit.
    ph.flush().catch(() => {});
  } catch (err) {
    console.warn(`[analytics-server] capture failed for ${event}:`, err);
  }
}
