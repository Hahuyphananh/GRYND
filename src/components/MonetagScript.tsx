/**
 * Monetag MultiTag loader — the second ad provider, scoped exactly like the
 * first one.
 *
 * WHY IT IS PER PAGE, NOT IN THE ROOT LAYOUT
 * Same reasoning as components/AdSenseScript.tsx: ads belong on the surfaces a
 * player browses *between* games, never next to a wager in progress. So this is
 * rendered by the page, on the same set of browsing pages that already render
 * the AdSense loader (the four main pages plus each game lobby whose board lives
 * on its own match route), and it is absent from every match route and from the
 * games whose lobby and board are one page.
 *
 * TWO SERVER-SIDE GATES (never a client flag):
 *
 *   1. CONFIGURATION. The zone id comes from NEXT_PUBLIC_MONETAG_ZONE
 *      (lib/ads.ts), falling back to the zone this property is registered
 *      under. A value that isn't a plain zone id emits NOTHING — no tag pointed
 *      at a zone that isn't ours. NEXT_PUBLIC_MONETAG_ENABLED=false switches the
 *      provider off entirely.
 *
 *   2. ENTITLEMENT. GRYND PRO is ad-free, so a member's response carries no
 *      Monetag tag at all: no ad code, no ad requests, no popunder, and nothing
 *      for an in-page-push unit to hook into. The answer comes from the caller's
 *      own subscription row (lib/adEntitlement.ts, memoized per request), so the
 *      same lookup serves this loader and the AdSense one.
 *
 * The snippet is the provider's, verbatim — the loader script with the zone it
 * belongs to:
 *
 *   <script src="https://quge5.com/88/tag.min.js" data-zone="…" async
 *     data-cfasync="false"></script>
 *
 * `data-cfasync="false"` is part of it: it tells Cloudflare's Rocket Loader to
 * leave the tag alone, and the provider's zone endpoint returns 404 when the
 * request arrives without the loader's own query handling (measured — see the
 * notes in docs if a zone is ever changed).
 *
 * CONSENT. Unlike the AdSense tag, this one is not a Google-certified CMP and
 * does not deliver a consent prompt, so it is not gated on our own banner
 * either: it loads with the page, for everyone who is not a member. The
 * consent-gated third parties (GA4, PostHog, Sentry) keep their own gating in
 * their own components — this change does not loosen any of them.
 *
 * ONE TAG, ALL FOUR FORMATS — INCLUDING ONCLICK.
 * The zone below is a Monetag "MultiTag", not an In-Page-Push-only zone: with
 * one tag in the page the network activates every format of the zone — Onclick,
 * Push Notifications, In-Page Push and Vignette Banner (its own documentation:
 * "MultiTag consists of 4 ad formats", one tag). Measured against zone 295730,
 * the tag fetches https://6opo.com/88/295730 and that answer pulls the other
 * three format scripts (auqot.com/pfe…?z=12031484, ekhay.com/vignette.min.js?z=12031483,
 * b3mny.com/tag.min.js?z=12031482), while the Onclick handler is the tag's own
 * `function onclick` code in quge5.com/88/tag.min.js. There is therefore NO
 * separate Onclick script to install, and adding one would double-inject the
 * same zone — a duplicate popunder, not a second format.
 *
 * A service worker is NOT registered here, and this component must never start
 * registering one. The NAME of the network's worker file is not ours to choose:
 * their zone endpoint answers with `"swName":"sw.js"` (measured for zone
 * 12031484) and their loader calls `navigator.serviceWorker.register(...)` with
 * that name, i.e. it asks the site for /sw.js at the ROOT. On this site /sw.js
 * belongs to next-pwa, which regenerates it on every build, so the network's
 * worker cannot have that path. public/sw1.js (the same worker file, under the
 * name it was renamed to by hand) is served from the root path with the
 * no-store + root-scope headers instead — see next.config.js — which is a
 * standing offer for the day Monetag sets this zone's `swName` to `sw1.js`.
 * Until then nothing requests it: verified in a real browser against a
 * production build, with notifications permitted and clicks simulated — zero
 * registrations, zero requests for /sw1.js, and the tag's own four format
 * scripts all loading. qa/monetag-browser-check.mjs (npm run verify:monetag)
 * reports that same evidence on demand.
 *
 * Do not "fix" the unused file by registering it from our code: a second worker
 * at the root scope displaces next-pwa's, and the network's worker installs a
 * `fetch` handler (verified by executing it), so folding that worker into
 * next-pwa's would put it next to workbox's routing in the same worker — a
 * human decision, not a side effect of this component.
 *
 * This is a server component with no client JavaScript: React hoists `async`
 * scripts into <head>, deduplicated, so rendering it here lands it where the
 * provider expects while keeping it off the match pages.
 */
import { MONETAG_TAG_SRC, monetagEnabled, monetagZoneId } from "../lib/ads";
import { isAdFreeViewer } from "../lib/adEntitlement";

export default async function MonetagScript() {
  if (!monetagEnabled()) return null;

  // Only ever emit a real zone id — a malformed one would load a zone that
  // isn't this property's.
  const zone = monetagZoneId();
  if (!zone) return null;

  // GRYND PRO members are ad-free: no tag, no ad code, no ad requests.
  if (await isAdFreeViewer()) return null;

  return (
    <script
      id="monetag-multitag"
      async
      data-cfasync="false"
      data-zone={zone}
      src={MONETAG_TAG_SRC}
    />
  );
}
