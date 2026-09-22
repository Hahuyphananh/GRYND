"use client";

import { ClerkProvider } from "@clerk/nextjs";
import { LanguageProvider } from "../context/LanguageContext";
import { ThemeProvider } from "../context/ThemeContext";
import { SocketProvider } from "../context/SocketProvider";
import PresenceHeartbeat from "../components/PresenceHeartbeat";
import RouteTransition from "../components/RouteTransition";
import { SWRProvider } from "../components/SWRProvider";
import OfflineBanner from "../components/states/OfflineBanner";
import { PostHogProvider } from "../components/PostHogProvider";
import { PostHogIdentify } from "../components/PostHogIdentify";
import { FunnelTracker } from "../components/FunnelTracker";

function AppProviders({ children }: { children: React.ReactNode }) {
  // NOTE: this used to be `if (!mounted) return null;` (set from a mount
  // effect). That single line kept EVERY page's content out of the
  // server-rendered HTML: crawlers and AI answer engines got a ~83KB shell
  // with 40 characters of text, no <h1>, and no copy to quote — even though a
  // visitor with JavaScript saw a full page. Nothing here needs the gate:
  // every provider below renders its children unconditionally and touches
  // browser APIs only inside effects (ThemeContext, LanguageContext,
  // SocketProvider, PresenceHeartbeat, RouteTransition), and Clerk's
  // ClerkProvider + useAuth are SSR-aware, so the server and the first client
  // render agree and hydration stays clean.
  return (
    <ThemeProvider>
      <LanguageProvider>
        <SocketProvider>
          {/* Global data layer: cache-first fetching with background
              revalidation, a persistent cache, and automatic revalidation
              when the device comes back online. */}
          <SWRProvider>
            <PresenceHeartbeat />
            {/* One connectivity notice for the whole app — every screen
                inherits the offline/online signal from here. */}
            <OfflineBanner />
            <RouteTransition>{children}</RouteTransition>
          </SWRProvider>
        </SocketProvider>
      </LanguageProvider>
    </ThemeProvider>
  );
}

export function Providers({ children }: { children: React.ReactNode }) {
  const publishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

  // `clerkJSVariant="headless"` removes Clerk's auto-preload of the
  // @clerk/ui browser bundle, which caused "preloaded but not used
  // within a few seconds" warnings on pages like /casino/coin-flip
  // that only use useUser()/useAuth() hooks. The UI bundle is still
  // fetched on-demand when a page renders a <SignIn /> or <SignUp />.
  return (
    <PostHogProvider>
      {/* `dynamic` defers Clerk's UI bundle load — disables the
          <link rel="preload"> and fixes the "preloaded but not used"
          warning on pages that only use useUser()/useAuth(). */}
      <ClerkProvider publishableKey={publishableKey} dynamic>
        <PostHogIdentify />
        <FunnelTracker />
        <AppProviders>{children}</AppProviders>
      </ClerkProvider>
    </PostHogProvider>
  );
}
