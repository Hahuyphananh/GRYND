// src/components/AdSlot.tsx
//
// THE reusable ad abstraction. Pages render a slot by PLACEMENT NAME only:
//
//   <AdSlot placement="home" />
//
// and never pass (and can never influence) membership. Three server-side gates
// decide whether anything renders, in this order:
//
//   1. ads are enabled for this deploy (NEXT_PUBLIC_ADSENSE_ENABLED !== "false"),
//   2. this placement has a REAL ad-unit id configured
//      (NEXT_PUBLIC_ADSENSE_SLOT_<PLACEMENT>) — an unconfigured placement
//      renders nothing rather than an invented "fake" slot id,
//   3. the viewer is not a GRYND PRO member (checked against the caller's own
//      subscription row — see lib/adEntitlement.ts).
//
// WHY IT IS A SERVER COMPONENT. The entitlement check must be authoritative,
// and the answer must not depend on anything the browser sends. As a server
// component there is no `premium` prop to spoof, no client state that can hide
// ads for a free user, and BY CONSTRUCTION no ad can be injected into a client
// component that isn't allowed to have one. It also means the ad markup for a
// member is never sent to their browser at all — not merely hidden with CSS.
//
// PLACEMENT POLICY. Only non-gameplay surfaces may render a slot. The ad model
// is "monetise browsing, never an action in progress": no slot exists inside a
// match/board route, and ads never cover controls, sit over navigation, or
// invite accidental clicks. tests/ad-model.test.mjs enforces that by scanning
// the gameplay routes.
//
// LEGACY NOTE: the previous AdSlot accepted a `premium` boolean and rendered an
// empty placeholder. That prop is gone — a client-supplied entitlement flag is
// exactly the thing this model must not trust.

import AdUnit from "./AdUnit";
import {
  adUnitId,
  adsEnabled,
  type AdPlacement,
} from "../lib/ads";
import { isAdFreeViewer } from "../lib/adEntitlement";

export default async function AdSlot({
  placement,
  className = "",
}: {
  placement: AdPlacement;
  className?: string;
}) {
  if (!adsEnabled()) return null;

  const slotId = adUnitId(placement);
  if (!slotId) return null;

  if (await isAdFreeViewer()) return null;

  return (
    <aside
      // A labeled landmark, so the block is announced as an advertisement
      // rather than read as part of the page's own content.
      aria-label="Advertisement"
      data-ad-placement={placement}
      className={`mx-auto my-6 w-full max-w-4xl px-4 ${className}`.trim()}
    >
      <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.2em] text-[#9dd8ff]/50">
        Advertisement
      </span>
      <AdUnit slotId={slotId} placement={placement} />
    </aside>
  );
}
