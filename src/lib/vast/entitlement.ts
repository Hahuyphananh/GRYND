// src/lib/vast/entitlement.ts
//
// THE SERVER-SIDE GATE for the post-match video ad.
//
// The VAST surface is a different provider from AdSense, so it needs its own
// answer to two questions, and both are answered HERE, on the server, per
// request:
//
//   1. Is post-match advertising switched on for this deployment?
//      `POST_MATCH_ADS_ENABLED=false` is the runtime kill switch. Unset means
//      ON (the build-time public switches are applied inside the component).
//
//   2. Is this viewer a GRYND PRO member?
//      `ad_free` is an advertised PRO benefit, so a member must never be
//      offered a post-match video. The answer comes from the SAME
//      server-authoritative check every other ad surface uses
//      (src/lib/adEntitlement.ts → Clerk session + the caller's own
//      subscription row). Nothing the client sends can change it.
//
// Pages call `postMatchAdSurface()` and pass the result to the component as
// two props: `enabled` (kill switch) and `adFree` (member). The component
// treats `adFree` as a hard off switch as well, so a future caller that forgets
// to fold the two together still cannot show a member an ad.

import { isAdFreeViewer } from "../adEntitlement";

/**
 * The runtime kill switch, read per request. `POST_MATCH_ADS_ENABLED=false`
 * (case-insensitive) disables post-match advertising everywhere; any other
 * value — including unset — leaves it to the build-time public switches.
 */
export function postMatchAdsEnabledOnServer(): boolean {
  return (process.env.POST_MATCH_ADS_ENABLED ?? "").trim().toLowerCase() !== "false";
}

export interface PostMatchAdSurface {
  /** True only when advertising is on AND the viewer is not a PRO member. */
  enabled: boolean;
  /** True when the viewer is an active GRYND PRO member (`ad_free`). */
  adFree: boolean;
}

/**
 * The one call a result page makes. One membership lookup per request, shared
 * with the AdSense slots on the same page through React's `cache`.
 */
export async function postMatchAdSurface(): Promise<PostMatchAdSurface> {
  const enabled = postMatchAdsEnabledOnServer();
  const adFree = await isAdFreeViewer();
  return { enabled: enabled && !adFree, adFree };
}
