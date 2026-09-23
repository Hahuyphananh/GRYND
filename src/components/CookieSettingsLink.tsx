"use client";

import { OPEN_CONSENT_BANNER_EVENT } from "../lib/cookieConsent";
import { cmpOwnsConsent } from "../lib/cmpOwnership";

/** The slice of Google's Privacy & messaging API this link uses. */
type GoogleFc = {
  callbackQueue?: Array<Record<string, () => void>>;
  showRevocationMessage?: () => void;
};

/**
 * "Manage cookies" — the withdrawal entrypoint required by GDPR art. 7(3):
 * withdrawing consent must be as easy as giving it. Without this, a visitor
 * who accepted has no way back except clearing site data by hand.
 *
 * It reopens whichever prompt owns the visitor (lib/cmpOwnership.ts):
 *
 *   - EEA/UK/Switzerland: Google's CMP. Google's docs are explicit that the
 *     ONLY supported way to call its API is through the callback queue
 *     (https://developers.google.com/funding-choices/fc-api-docs), so we push a
 *     `CONSENT_DATA_READY` job that runs `showRevocationMessage()` — "clears the
 *     consent record and reloads the googlefc script to show the consent
 *     message applicable to the user". Defining `window.googlefc` here is
 *     supported and expected; the key is already being used for exactly this
 *     kind of pre-load queueing.
 *   - Everyone else: our own banner, re-opened through the same window event
 *     the banner already listens for.
 *
 * The googlefc objects are created before the CMP loads on purpose — that is
 * how a queued call survives until the script arrives. If the CMP never loads
 * (a visitor outside its scope, or an ad blocker), the queued callback simply
 * never runs and nothing breaks.
 */
export default function CookieSettingsLink({ className }: { className?: string }) {
  const openSettings = () => {
    if (cmpOwnsConsent()) {
      const w = window as unknown as { googlefc?: GoogleFc };
      const googlefc = w.googlefc || {};
      googlefc.callbackQueue = googlefc.callbackQueue || [];
      googlefc.callbackQueue.push({
        CONSENT_DATA_READY: () => {
          googlefc.showRevocationMessage?.();
        },
      });
      w.googlefc = googlefc;
      return;
    }

    window.dispatchEvent(new Event(OPEN_CONSENT_BANNER_EVENT));
  };

  return (
    <button type="button" onClick={openSettings} className={className}>
      Manage cookies
    </button>
  );
}
