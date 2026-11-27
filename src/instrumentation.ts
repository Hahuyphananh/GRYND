import * as Sentry from "@sentry/nextjs";

import {
  assertProductionSecrets,
  productionWarnings,
} from "./lib/security/startupChecks";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Required-secret boot check, BEFORE Sentry and before any request is
    // served. A production process missing CLERK_SECRET_KEY, DATABASE_URL or a
    // session-signing secret refuses to start: without them the proxy serves
    // unauthenticated traffic and every self-hosted cookie falls back to a
    // public signing constant. No-ops during `next build` and in development.
    assertProductionSecrets();

    // Degraded-but-alive conditions (a per-instance rate limiter, for one) are
    // logged loudly rather than thrown: refusing to serve over them would trade
    // a weakened control for an outage.
    for (const warning of productionWarnings()) {
      console.warn(`[startup] ${warning}`);
    }

    // @ts-ignore TS cannot resolve this runtime-only module
    await import("../sentry.server.config");
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    // @ts-ignore TS cannot resolve this runtime-only module
    await import("../sentry.edge.config");
  }
}

export const onRequestError = Sentry.captureRequestError;
