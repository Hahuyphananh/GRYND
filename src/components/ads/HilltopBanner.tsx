// src/components/ads/HilltopBanner.tsx
//
// THE reusable HilltopAds banner component. Pages render it by PLACEMENT name
// only, exactly like AdSlot:
//
//   <HilltopBanner placement="hub" />
//
// It is a SERVER component, and every gate runs before a byte of provider code
// is written into the response — the same reason AdSlot is a server component:
// there is no prop to spoof, no client state to fake, and a GRYND PRO member's
// page simply never contains the tag.
//
// THE GATES, IN ORDER
//
//   1. Configuration. `HILLTOP_BANNER_ENABLED` (runtime, per request),
//      NEXT_PUBLIC_HILLTOP_BANNER_ENABLED (build time) and the provider
//      attestation must ALL be opted in, and the provider URL must validate
//      (https/protocol-relative on the approved host). Anything missing or
//      malformed → nothing. See src/lib/hilltop/config.ts for why the default
//      is off.
//   2. Placement. Only the approved browsing surfaces (home, hub, leaderboard,
//      profile) — never a lobby, match or board route. Enforced twice: here by
//      the placement name, and again in the browser against the exact pathname.
//   3. Entitlement. `isAdFreeViewer()` (src/lib/adEntitlement.ts): Clerk session
//      plus the caller's own subscription row, memoized per request. Members get
//      `null`, so no script, no container and no ad request reach their browser.
//      A thrown entitlement lookup is swallowed and renders NO banner: an ad
//      problem must never take a page down.
//
// The client-side work (single injection, container containment, failure
// handling) lives in HilltopBannerUnit.
//
// NOT IN THE LAYOUT. This is mounted per page, never globally: a document-level
// banner loader must not follow a player into a match.

import HilltopBannerUnit from "./HilltopBannerUnit";
import { isAdFreeViewer } from "../../lib/adEntitlement";
import {
  hilltopBannerAllowed,
  hilltopBannerEnabled,
  hilltopBannerEnabledOnServer,
  hilltopBannerScriptUrl,
  hilltopProviderAttested,
  hilltopBannerVisibleToViewer,
  type HilltopPlacement,
} from "../../lib/hilltop/config";

export default async function HilltopBanner({
  placement,
  className = "",
}: {
  placement: HilltopPlacement;
  className?: string;
}) {
  const allowed = hilltopBannerAllowed({
    enabled:
      hilltopBannerEnabledOnServer() &&
      hilltopBannerEnabled() &&
      hilltopProviderAttested(),
    configured: hilltopBannerScriptUrl() !== null,
    placement,
  });

  // Cheap gates first: a page that can never show the banner must not perform a
  // membership lookup either.
  if (!allowed) return null;

  // Server-authoritative entitlement — the client is never asked, and a member
  // never receives the markup. `isAdFreeViewer` already fails open (to "free")
  // on an outage; this guard is the last line of defence so an entitlement
  // problem can never break the page that hosts the ad.
  let adFree: boolean;
  try {
    adFree = await isAdFreeViewer();
  } catch {
    return null;
  }
  if (!hilltopBannerVisibleToViewer({ allowed, adFree })) return null;

  return (
    <aside
      aria-label="Advertisement"
      data-hilltop-placement={placement}
      className={`mx-auto my-6 w-full max-w-4xl px-4 ${className}`.trim()}
    >
      {/* The caption lives in the UNIT, not here. Once the tag has loaded in
          this session a later page draws nothing, and a bare "Advertisement"
          heading above an empty box would be worse than no ad at all. */}
      <HilltopBannerUnit placement={placement} />
    </aside>
  );
}
