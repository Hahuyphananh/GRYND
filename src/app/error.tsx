"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";
import ErrorState from "../components/states/ErrorState";

/**
 * Route-level error boundary.
 *
 * Without this file an uncaught render/data error inside any route segment
 * produced Next's bare default screen. This catches it once for every screen
 * in the app and renders the same error state the data components use: what
 * failed, and a retry that re-renders the segment (`reset`).
 *
 * It cannot call `useTranslation` directly — but it renders inside the root
 * layout, so the app's LanguageProvider is still mounted above it and
 * <ErrorState> is free to translate.
 */
export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <div className="flex min-h-[70vh] w-full items-center justify-center px-4 py-16">
      <div className="w-full max-w-lg">
        <ErrorState
          title="This screen hit a problem"
          description={
            <>
              We couldn&apos;t finish loading this page. It&apos;s usually
              temporary — retrying re-renders the screen.
              {error?.digest && (
                <span className="mt-2 block text-xs text-red-200/60">
                  Reference: {error.digest}
                </span>
              )}
            </>
          }
          onRetry={reset}
          homeHref="/"
        />
      </div>
    </div>
  );
}
