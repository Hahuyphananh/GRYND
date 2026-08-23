"use client";

import { ClerkProvider } from "@clerk/nextjs";
import { useState, useEffect } from "react";
import { LanguageProvider } from "../context/LanguageContext";
import { ThemeProvider } from "../context/ThemeContext";
import { SocketProvider } from "../context/SocketProvider";
import PresenceHeartbeat from "../components/PresenceHeartbeat";
import RouteTransition from "../components/RouteTransition";
import { PostHogProvider } from "../components/PostHogProvider";
import { PostHogIdentify } from "../components/PostHogIdentify";
import { FunnelTracker } from "../components/FunnelTracker";

function AppProviders({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) return null; // or a loader

  return (
    <ThemeProvider>
      <LanguageProvider>
        <SocketProvider>
          <PresenceHeartbeat />
          <RouteTransition>{children}</RouteTransition>
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
