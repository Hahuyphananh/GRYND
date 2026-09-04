"use client";

import posthog from "posthog-js";
import { PostHogProvider as PHProvider } from "posthog-js/react";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, Suspense } from "react";
import { getCookieConsent } from "../lib/cookieConsent";

// Initialize PostHog at module level so the client is ready before React renders.
// This avoids the race condition where children mount with an uninitialized client.
//
// api_host strategy:
// - Production uses a path-based api_host (/ingest) so ad-blockers and privacy
//   tools can't block analytics requests. Next.js rewrites in next.config.js
//   proxy /ingest/* → the PostHog host transparently.
// - Development talks to the PostHog host directly instead of through the dev
//   server: the /ingest proxy bakes external DNS resolution into every
//   analytics asset load, so a machine that can't resolve the PostHog host
//   spams "Failed to proxy ..." errors into the dev server logs. Direct calls
//   fail silently in the browser instead. Analytics is a fire-and-forget
//   best-effort path either way.
if (typeof window !== "undefined" && process.env.NEXT_PUBLIC_POSTHOG_KEY) {
  posthog.init(process.env.NEXT_PUBLIC_POSTHOG_KEY, {
    api_host:
      process.env.NODE_ENV === "development"
        ? process.env.NEXT_PUBLIC_POSTHOG_HOST || "https://app.posthog.com"
        : "/ingest",
    person_profiles: "identified_only",
    capture_pageview: false,
  });
  // Analytics stay off until the visitor accepts the cookie-consent banner
  // (Law 25 / GDPR best practice). Accepting later calls opt_in_capturing().
  if (getCookieConsent() !== "accepted") {
    posthog.opt_out_capturing();
  }
}

function PostHogPageView() {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    if (pathname && posthog) {
      let url = window.origin + pathname;
      const search = searchParams.toString();
      if (search) url += `?${search}`;
      posthog.capture("$pageview", { $current_url: url });
    }
  }, [pathname, searchParams]);

  return null;
}

export function PostHogProvider({ children }: { children: React.ReactNode }) {
  // Skip provider entirely when PostHog isn't configured — avoids mounting
  // an uninitialized client that would silently swallow all events.
  if (!process.env.NEXT_PUBLIC_POSTHOG_KEY) return <>{children}</>;

  return (
    <PHProvider client={posthog}>
      <Suspense fallback={null}>
        <PostHogPageView />
      </Suspense>
      {children}
    </PHProvider>
  );
}
