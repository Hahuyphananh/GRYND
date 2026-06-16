"use client";

import { ClerkProvider } from "@clerk/nextjs";
// @ts-expect-error - @clerk/ui package.json has "type":"module", but Next.js bundler handles ESM interop
import { ui } from "@clerk/ui";
import { useState, useEffect } from "react";
import { LanguageProvider } from "../context/LanguageContext";
import { ThemeProvider } from "../context/ThemeContext";
import { SocketProvider } from "../context/SocketProvider";
import PresenceHeartbeat from "../components/PresenceHeartbeat";
import RouteTransition from "../components/RouteTransition";
import { PostHogProvider } from "../components/PostHogProvider";
import { PostHogIdentify } from "../components/PostHogIdentify";

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
  const clerkProps = publishableKey ? { publishableKey } : {};

  return (
    <PostHogProvider>
      <ClerkProvider {...clerkProps} ui={ui}>
        <PostHogIdentify />
        <AppProviders>{children}</AppProviders>
      </ClerkProvider>
    </PostHogProvider>
  );
}
