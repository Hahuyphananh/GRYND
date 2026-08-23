// This file configures the initialization of Sentry on the client.
// The added config here will be used whenever a users loads a page in their browser.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";
import { getCookieConsent } from "./lib/cookieConsent";

// Sentry must not capture anything until the visitor accepts the
// cookie-consent banner (same gate PostHog uses). `beforeSend` runs for
// every event — including session-replay events — so returning null
// blocks all delivery while consent is missing or declined.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/configuration/filtering/
const hasAnalyticsConsent = () => getCookieConsent() === "accepted";

Sentry.init({
  dsn: "https://4c4bf15252867e3e45a423dbd691ad49@o4511487520538624.ingest.us.sentry.io/4511487533318144",

  // Only attach the replay integration once the visitor has already
  // accepted — avoids starting a session that would immediately be
  // dropped by the consent gate below.
  integrations: hasAnalyticsConsent() ? [Sentry.replayIntegration()] : [],

  // Define how likely traces are sampled. Adjust this value in production, or use tracesSampler for greater control.
  tracesSampleRate: 1,
  // Enable logs to be sent to Sentry
  enableLogs: true,

  // Define how likely Replay events are sampled.
  // This sets the sample rate to be 10%. You may want this to be 100% while
  // in development and sample at a lower rate in production
  replaysSessionSampleRate: 0.1,

  // Define how likely Replay events are sampled when an error occurs.
  replaysOnErrorSampleRate: 1.0,

  // Send user PII only after the visitor opts in to analytics.
  // https://docs.sentry.io/platforms/javascript/guides/nextjs/configuration/options/#sendDefaultPii
  sendDefaultPii: hasAnalyticsConsent(),

  beforeSend(event) {
    // Also blocks replay/performance payloads, which flow through the
    // same event pipeline.
    return hasAnalyticsConsent() ? event : null;
  },
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
