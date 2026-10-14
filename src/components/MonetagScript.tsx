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
 * A service worker is NOT registered here — `/sw.js` belongs to next-pwa (it
 * regenerates it on every build), and the network's own worker file is the one
 * its dashboard hands out as `sw1.js` precisely so it does not clash with a
 * PWA's `/sw.js`. That file is served from public/sw1.js (see next.config.js for
 * the no-store + root-scope headers): the file being SERVED is all this app
 * owes the network — whether it is installed is the tag's decision, which also
 * means the tag, not our code, is what can put a second worker at the root
 * scope (which would displace next-pwa's, and is the one thing to watch if
 * offline caching ever regresses).
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
