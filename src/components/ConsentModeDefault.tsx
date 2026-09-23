/**
 * Google Consent Mode v2 — the "default" half, and the only place it lives.
 *
 * Declared as the first element of the root layout's <head>, server-side and
 * inline, so it runs during HTML parsing rather than after hydration. Google's
 * guidance is to put the default as high in <head> as possible.
 *
 * ONE CAVEAT, VERIFIED AGAINST THE SERVED HTML. Declared-first is not the same
 * as served-first: React hoists `async` scripts (the AdSense tag) to the top of
 * <head>, so on /games the ad tag is emitted ahead of this script a few
 * thousand bytes earlier. That ordering is why `wait_for_update` below is
 * load-bearing rather than a nicety — it makes every Google tag hold its first
 * request until a consent state exists, which this script establishes
 * microseconds later, long inside its 500 ms window. An `async` script cannot
 * realistically execute in that gap: the parser reaches this inline tag on the
 * very next parse step, while the ad script still needs a network round trip.
 *
 *   https://developers.google.com/tag-platform/security/guides/consent
 *
 * Everything starts DENIED. That is the point: a visitor who has not answered
 * the consent prompt yet must not get advertising cookies or personalised ads,
 * so every signal is denied until a consent source says otherwise. Two sources
 * can raise them, and neither is this file:
 *
 *   - Google's certified CMP (Privacy & messaging), for visitors in the EEA,
 *     the UK and Switzerland. It reads the visitor's answer and pushes
 *     `gtag('consent', 'update', …)` itself, and writes the IAB TCF string our
 *     ad partners read.
 *   - Our own banner (components/CookieConsentBanner.tsx), for everyone else —
 *     see the update pushed from components/GoogleAnalytics.tsx.
 *
 * NOTE ON WHAT THIS DOES *NOT* DO. Consent Mode is not a way around consent.
 * With the signals denied, Google's tags still run but drop to a cookieless,
 * non-personalised mode (and `ads_data_redaction` strips ad click identifiers
 * from ad requests). No advertising cookie is set and no personalised ad is
 * served until a source above grants it. Our own privacy promise — no
 * analytics storage before the visitor accepts — is enforced separately and
 * unchanged by gating GoogleAnalytics, PostHog and Sentry on the stored
 * choice.
 *
 * `wait_for_update: 500` gives a consent source half a second to arrive before
 * tags give up and fire in the denied state. Without it, a visitor who has
 * already consented would be measured as anonymous purely because the CMP
 * resolved a few hundred milliseconds after the tag.
 *
 * `url_passthrough` is deliberately NOT enabled: it exists to carry ad click
 * IDs across pages for conversion attribution, and this property runs AdSense
 * as a publisher with no Google Ads conversion tracking — so it would decorate
 * outbound links for no measurement benefit.
 */
export const CONSENT_MODE_DEFAULT = `window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('consent', 'default', {
  ad_storage: 'denied',
  ad_user_data: 'denied',
  ad_personalization: 'denied',
  analytics_storage: 'denied',
  wait_for_update: 500
});
// Strip ad click identifiers from ad requests while ad_storage is denied.
gtag('set', 'ads_data_redaction', true);`;

export default function ConsentModeDefault() {
  return (
    <script
      id="consent-mode-default"
      // Server-rendered inline on purpose: it must run before every Google
      // tag, so it cannot be a deferred client script.
      dangerouslySetInnerHTML={{ __html: CONSENT_MODE_DEFAULT }}
    />
  );
}
