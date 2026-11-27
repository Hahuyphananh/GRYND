// src/components/ads/BannerSlot.tsx
//
// THE single banner surface, shared by every approved browsing page.
//
// Before this component existed, three provider components were mounted side by
// side and each decided independently whether to load. That made "one slot, one
// ad" impossible to guarantee. Now the page mounts this slot once, and it:
//
//   1. refuses the native shell before any provider code exists,
//   2. resolves the configured priority and keeps only providers whose switch,
//      zone/tag/class and placement are valid (server-side),
//   3. asks the SERVER-AUTHORITATIVE entitlement once, and renders nothing for
//      a GRYND PRO member,
//   4. hands the ordered list to the client chain.
//
// Consent is read in the client, where the record lives. The chain then tries
// one provider at a time and stops at the first creative.
//
// Mounted per page, never globally: no banner loader may follow a player into a
// match.

import BannerSlotClient from "./BannerSlotClient";
import { isAdFreeViewer } from "../../lib/adEntitlement";
import { isNativeShellDocument } from "../../lib/native/shellServer";
import type { BannerPlacement } from "../../lib/ads/core/types";
import { eligibleBannerProviders } from "../../lib/ads/banners/eligibility";
import { bannerSurfaceAllowed } from "../../lib/ads/banners/gates";

export default async function BannerSlot({
  placement,
  className = "",
}: {
  placement: BannerPlacement;
  className?: string;
}) {
  // Gate 0: the Android/iOS shell makes no third-party ad request at all.
  const native = await isNativeShellDocument();

  // Cheap gates first: an unconfigured page never performs a membership lookup.
  const providers = native ? [] : eligibleBannerProviders(placement);
  if (providers.length === 0) return null;

  let adFree = false;
  if (!native) {
    try {
      adFree = await isAdFreeViewer();
    } catch {
      // An entitlement problem must never take the page down.
      return null;
    }
  }

  if (!bannerSurfaceAllowed({ native, placement, providers, adFree })) {
    return null;
  }

  return (
    <aside
      aria-label="Advertisement"
      data-banner-placement={placement}
      data-banner-providers={providers.join(",")}
      className={`mx-auto my-6 w-full max-w-4xl px-4 ${className}`.trim()}
    >
      <BannerSlotClient placement={placement} providers={providers} />
    </aside>
  );
}
