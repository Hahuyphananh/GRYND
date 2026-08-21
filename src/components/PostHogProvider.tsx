"use client";

import posthog from "posthog-js";
import { PostHogProvider as PHProvider } from "posthog-js/react";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, Suspense } from "react";
import { getCookieConsent } from "../lib/cookieConsent";

// Initialize PostHog at module level so the client is ready before React renders.
// This avoids the race condition where children mount with an uninitialized client.
//
// Use a path-based api_host (/ingest) instead of the external PostHog domain so
// ad-blockers and privacy tools don't block analytics requests. Next.js rewrites
// in next.config.js proxy /ingest/* → app.posthog.com/* transparently.
if (typeof window !== "undefined" && process.env.NEXT_PUBLIC_POSTHOG_KEY) {
  posthog.init(process.env.NEXT_PUBLIC_POSTHOG_KEY, {
    api_host: "/ingest",
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
