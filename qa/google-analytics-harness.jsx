// qa/google-analytics-harness.jsx
//
// Mounts the REAL `src/components/GoogleAnalytics.tsx` (and the real
// `src/lib/cookieConsent.ts`) into a bare page so the tag's actual behaviour —
// not just its source text — can be driven in a browser by
// qa/google-analytics-check.mjs:
//
//   * nothing is requested, and nothing is in the DOM, until the visitor
//     accepts the cookie banner;
//   * accepting loads gtag.js exactly once and runs the snippet's
//     `gtag('js', …)` / `gtag('config', 'G-PFN3BBLC0E')`;
//   * withdrawing consent flips GA's `ga-disable-<ID>` kill switch so the tag
//     stops collecting without a reload;
//   * flipping consent back and forth never double-loads the loader.
//
// `window.__ga` is the whole control surface the check uses.

import React from "react";
import { createRoot } from "react-dom/client";
import GoogleAnalytics, { GA_MEASUREMENT_ID } from "../src/components/GoogleAnalytics";
import { getCookieConsent, setCookieConsent } from "../src/lib/cookieConsent";

const state = {
  measurementId: GA_MEASUREMENT_ID,
  errors: [],
  accept: () => setCookieConsent("accepted"),
  decline: () => setCookieConsent("declined"),
  consent: () => getCookieConsent(),
  /** The GA loader tags currently in the DOM. */
  scriptTags: () =>
    [...document.querySelectorAll("script[src]")]
      .map((s) => s.getAttribute("src"))
      .filter((src) => src && src.includes("googletagmanager")),
  /** Every loader filename seen by the stub, in order. */
  loads: [],
  /** The gtag() calls the inline snippet queued, as plain arrays of strings. */
  dataLayer: () =>
    (window.dataLayer || []).map((entry) => Array.from(entry).map((v) => (v instanceof Date ? "date" : String(v)))),
  /** GA's documented kill switch for this property. */
  disabled: () => Boolean(window[`ga-disable-${GA_MEASUREMENT_ID}`]),
};
window.__ga = state;

window.addEventListener("error", (e) => state.errors.push(String(e.message || e)));
window.addEventListener("unhandledrejection", (e) => state.errors.push("rejection: " + String(e.reason)));

createRoot(document.getElementById("root")).render(<GoogleAnalytics />);
