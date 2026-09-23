"use client";

import { useEffect } from "react";
import { CMP_NOT_APPLICABLE_EVENT, setCookieConsent } from "../lib/cookieConsent";
import { setCmpOwnsConsent } from "../lib/cmpOwnership";

/** The subset of the IAB TCF v2 `TCData` object this bridge reads. */
type TcfData = {
  gdprApplies?: boolean;
  eventStatus?: string;
  purpose?: { consents?: Record<string, boolean> };
};

type TcfApi = (
  command: string,
  version: number,
  callback: (data: TcfData, success: boolean) => void,
) => void;

/**
 * TCF purpose 1 — "Store and/or access information on a device".
 *
 * This is the one purpose that maps onto our binary consent record ("may we
 * use device storage for our own tools"), which is what GoogleAnalytics,
 * PostHogProvider, instrumentation-client (Sentry) and StickyMobileCta all
 * read. Ad personalisation is NOT decided here — Google's CMP feeds that
 * straight into Consent Mode and the TCF string our ad partners read.
 */
const PURPOSE_DEVICE_STORAGE = 1;

/** How long to wait for the CMP to define `__tcfapi`, in 250 ms ticks. */
const MAX_TICKS = 40;

/**
 * Mirrors Google's CMP decision into our own consent record, for visitors in
 * the EEA, the UK and Switzerland.
 *
 * Those visitors never see our banner (Google's CMP prompts them instead), so
 * without this bridge `grynd_cookie_consent` would stay null forever and every
 * consumer listed above would treat a consenting visitor as an anonymous one —
 * a silent hole in analytics for exactly the region the CMP was added for.
 *
 * `enabled` is decided on the server from the request's country header
 * (lib/consentRegions.ts); everywhere else this component renders nothing and
 * the banner remains the single prompt.
 *
 * Consent is never granted speculatively: the record is only written once the
 * CMP reports a settled decision (`tcloaded` — restored from a previous visit,
 * or `useractioncomplete` — the visitor just answered).
 */
export default function CmpConsentBridge({ enabled }: { enabled: boolean }) {
  useEffect(() => {
    if (!enabled) return;

    // Record where the footer's "Manage cookies" link has to send the visitor
    // to change their mind (lib/cmpOwnership.ts).
    setCmpOwnsConsent(true);

    // The TCF API has no "removeEventListener", so a settled listener is
    // neutralised through `cancelled` instead of being torn down.
    let cancelled = false;
    let timer: number | undefined;

    const apply = (data: TcfData) => {
      if (cancelled) return;

      // The CMP says its regulations do not apply here after all. Its message
      // will never render, so hand the prompt back to our banner rather than
      // leaving the visitor unprompted.
      if (data.gdprApplies === false) {
        window.dispatchEvent(new Event(CMP_NOT_APPLICABLE_EVENT));
        return;
      }

      const settled =
        data.eventStatus === "tcloaded" || data.eventStatus === "useractioncomplete";
      if (!settled) return;

      const granted = data.purpose?.consents?.[String(PURPOSE_DEVICE_STORAGE)] === true;
      setCookieConsent(granted ? "accepted" : "declined");
    };

    // `__tcfapi` is injected by the CMP, which itself arrives with the AdSense
    // tag — so it is never there on first paint. Poll briefly instead of
    // assuming a load order we do not control.
    let ticks = 0;
    timer = window.setInterval(() => {
      ticks += 1;
      const api = (window as unknown as { __tcfapi?: TcfApi }).__tcfapi;
      if (typeof api === "function") {
        if (timer !== undefined) window.clearInterval(timer);
        timer = undefined;
        api("addEventListener", 2, (data, success) => {
          if (success) apply(data);
        });
      } else if (ticks >= MAX_TICKS) {
        if (timer !== undefined) window.clearInterval(timer);
        timer = undefined;
      }
    }, 250);

    return () => {
      cancelled = true;
      setCmpOwnsConsent(false);
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [enabled]);

  return null;
}
