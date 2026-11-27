// src/components/ads/AdcashBanner.tsx
//
// THE reusable Adcash banner component. Pages render it by PLACEMENT name only:
//
//   <AdcashBanner placement="home" />
//
// A SERVER component, so the authoritative gates run before any provider code
// is written into the response.
//
// THE GATES, IN ORDER
//
//   1. Native app. `isNativeShellDocument()` returns null immediately: the
//      Android/iOS WebView receives no container and no Adcash library.
//   2. Configuration. BOTH switches must be opted in, and the placement must
//      have a numeric zone id plus the library URL copied from the publisher
//      panel. Missing anything → nothing.
//   3. Placement. Only the approved browsing surfaces. The client unit also
//      checks the exact pathname.
//   4. Entitlement. `isAdFreeViewer()` — a GRYND PRO member gets no markup, no
//      container, no request. A thrown lookup renders nothing rather than
//      failing the page.
//
// Consent is checked in the client unit, because the consent record lives in
// the browser.

import AdcashBannerUnit from "./AdcashBannerUnit";
import { isAdFreeViewer } from "../../lib/adEntitlement";
import { isNativeShellDocument } from "../../lib/native/shellServer";
import {
  adcashBannerAllowed,
  adcashBannerConfigured,
  adcashBannerEnabled,
  adcashBannerEnabledOnServer,
  adcashBannerVisibleToViewer,
  type AdcashPlacement,
} from "../../lib/adcash/config";

export default async function AdcashBanner({
  placement,
  className = "",
}: {
  placement: AdcashPlacement;
  className?: string;
}) {
  // NATIVE APP — gate 0, ahead of configuration, placement and entitlement.
  if (await isNativeShellDocument()) return null;

  const allowed = adcashBannerAllowed({
    enabled: adcashBannerEnabledOnServer() && adcashBannerEnabled(),
    configured: adcashBannerConfigured(placement),
    placement,
  });

  // Cheap gates first: no membership lookup for a page that cannot show it.
  if (!allowed) return null;

  let adFree: boolean;
  try {
    adFree = await isAdFreeViewer();
  } catch {
    return null;
  }
  if (!adcashBannerVisibleToViewer({ allowed, adFree })) return null;

  return (
    <aside
      aria-label="Advertisement"
      data-adcash-placement={placement}
      className={`mx-auto my-6 w-full max-w-4xl px-4 ${className}`.trim()}
    >
      <AdcashBannerUnit placement={placement} />
    </aside>
  );
}
