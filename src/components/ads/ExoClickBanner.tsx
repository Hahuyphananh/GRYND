// src/components/ads/ExoClickBanner.tsx
//
// THE reusable ExoClick banner component. Pages render it by PLACEMENT name
// only:
//
//   <ExoClickBanner placement="home" />
//
// It is a SERVER component, so every gate that needs an authoritative answer
// runs before a byte of provider code reaches the response — the same model as
// AdSlot and HilltopBanner. There is no prop to spoof and no client state that
// can switch the banner on.
//
// THE GATES, IN ORDER
//
//   1. Native app. `isNativeShellDocument()` (the shell's User-Agent) returns
//      null immediately: the Android/iOS build makes no third-party ad request,
//      and the Play listing describes that behaviour.
//   2. Configuration. BOTH switches (`EXOCLICK_ENABLED` per request and
//      NEXT_PUBLIC_EXOCLICK_ENABLED at build time) must be opted in, and the
//      placement must have a valid loader URL, a real zone id and the
//      provider-generated `<ins>` class token. Anything missing → nothing.
//   3. Placement. Only the approved browsing surfaces (home, hub, leaderboard,
//      profile) — never a lobby below its URL, a match, a board or the
//      post-match overlay. The client unit also checks the exact pathname.
//   4. Entitlement. `isAdFreeViewer()` (Clerk session + the caller's own
//      subscription row). A GRYND PRO member gets no markup, no container and
//      no request. A thrown lookup renders nothing rather than failing the page.
//
// Consent is checked in the client unit, because the consent record lives in
// the browser (localStorage). The server never guesses it.

import ExoClickBannerUnit from "./ExoClickBannerUnit";
import { isAdFreeViewer } from "../../lib/adEntitlement";
import { isNativeShellDocument } from "../../lib/native/shellServer";
import {
  exoclickBannerAllowed,
  exoclickBannerConfigured,
  exoclickBannerEnabled,
  exoclickBannerEnabledOnServer,
  exoclickBannerVisibleToViewer,
  type ExoclickPlacement,
} from "../../lib/exoclick/config";

export default async function ExoClickBanner({
  placement,
  className = "",
}: {
  placement: ExoclickPlacement;
  className?: string;
}) {
  // NATIVE APP — gate 0, ahead of configuration, placement and entitlement.
  if (await isNativeShellDocument()) return null;

  const allowed = exoclickBannerAllowed({
    enabled: exoclickBannerEnabledOnServer() && exoclickBannerEnabled(),
    configured: exoclickBannerConfigured(placement),
    placement,
  });

  // Cheap gates first: a page that can never show the banner must not perform a
  // membership lookup either.
  if (!allowed) return null;

  let adFree: boolean;
  try {
    adFree = await isAdFreeViewer();
  } catch {
    return null;
  }
  if (!exoclickBannerVisibleToViewer({ allowed, adFree })) return null;

  return (
    <aside
      aria-label="Advertisement"
      data-exoclick-placement={placement}
      className={`mx-auto my-6 w-full max-w-4xl px-4 ${className}`.trim()}
    >
      <ExoClickBannerUnit placement={placement} />
    </aside>
  );
}
