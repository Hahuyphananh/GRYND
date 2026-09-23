// src/lib/googleConsent.ts
//
// Pushes a Google Consent Mode v2 update from OUR banner's decision.
//
// components/ConsentModeDefault.tsx denies all four signals before any Google
// tag loads, so until something grants them the ad requests carry no
// advertising cookie and no personalisation. Two things can grant them, and
// this module is the second:
//
//   1. Google's certified CMP, for visitors in the EEA, the UK and Switzerland
//      — it pushes its own updates from the visitor's answers. This module
//      must stay out of the way there, which is why the banner only calls it
//      when the CMP is NOT the prompt (see lib/cmpOwnership.ts).
//   2. Our own banner, everywhere else. `accept` grants all four; `decline`
//      leaves them denied.
//
// Without this, Consent Mode defaults would apply worldwide and every visitor
// outside the EEA/UK/CH would be served limited, non-personalised ads even
// after accepting — a silent revenue leak with no visible symptom. Outside
// those regions Google does not require a CMP, but the visitor's own answer
// still has to be what decides.
//
// The update is idempotent, so pushing it again on a later visit (a returning
// visitor whose choice is already stored) is harmless.

/**
 * Grant or deny all four Consent Mode signals.
 *
 * Called with our banner's binary answer, so the four move together: the
 * banner offers a single accept/decline, and pretending to model finer
 * granularity here would misrepresent what the visitor actually agreed to.
 */
export function updateGoogleConsent(granted: boolean): void {
  if (typeof window === "undefined") return;

  const value = granted ? "granted" : "denied";
  const w = window as unknown as { dataLayer?: unknown[] };
  w.dataLayer = w.dataLayer || [];

  // Google's own pattern: a local `gtag` that forwards its arguments to the
  // shared dataLayer queue. Deliberately not a global — ConsentModeDefault
  // already defines the global one, and re-defining it here could race it.
  const gtag = (...args: unknown[]) => {
    w.dataLayer?.push(args);
  };

  gtag("consent", "update", {
    ad_storage: value,
    ad_user_data: value,
    ad_personalization: value,
    analytics_storage: value,
  });
}
