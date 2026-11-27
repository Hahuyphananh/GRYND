// src/lib/vast/providers/adexchange.ts
//
// Ad Exchange (youradexchange.com) VAST adapter.
//
// The operator supplied this account's video tag:
//   https://youradexchange.com/video/select.php?r=12500162
// It is a real, account-specific tag (not a guess), it answers VAST 4.0, and it
// is a VIDEO endpoint only — there is no display zone behind it.
//
// ── SCOPE ──────────────────────────────────────────────────────────────────
//
//   * POST-MATCH ONLY. This adapter is reachable only through the post-match
//     chain, which the player mounts only once `matchEnded` is true. It is not
//     a banner, not a sticky/interstitial/push format, and it cannot follow a
//     player onto a board.
//   * PRO MEMBERS NEVER REACH IT. The hosting surface resolves the GRYND PRO
//     `ad_free` entitlement server-side and renders nothing for a member, so no
//     request is made on their behalf.
//   * CONSENT FIRST. It sits behind the same consent gate as every other video
//     provider (`NEXT_PUBLIC_POST_MATCH_ADS_REQUIRES_CONSENT`, default true).
//   * INLINE ONLY. The shared strict parser is used: Wrapper and VPAID are
//     refused, and an empty `<VAST/>` (a real no-fill from this tag) resolves
//     to `no-ad`, which the chain treats as a no-fill rather than an error.
//
// ── CONFIGURATION ──────────────────────────────────────────────────────────
//
//   NEXT_PUBLIC_ADEXCHANGE_VAST_TAG        optional override; must be https.
//   NEXT_PUBLIC_ADEXCHANGE_VAST_ENABLED=false   kill switch. Enabled by
//                                          default because the tag is already
//                                          the account's, unlike the other
//                                          providers which wait for a dashboard
//                                          value; set "false" to opt out.
//   NEXT_PUBLIC_ADEXCHANGE_VAST_TIMEOUT_MS optional, 1000–8000.

import { ADEXCHANGE_VAST_TAG, normalizeVideoTagUrl, videoAdsGloballyEnabled, videoTimeoutMs } from "./config";
import { requestWithConfig } from "./request";
import type {
  VideoAdProvider,
  VideoAdProviderConfig,
  VideoAdRequestOptions,
  VideoAdResult,
} from "./types";

/** Enabled unless explicitly switched off ("false" / "0"). */
function adexchangeEnabled(): boolean {
  const raw = (process.env.NEXT_PUBLIC_ADEXCHANGE_VAST_ENABLED ?? "").trim().toLowerCase();
  if (!raw) return true;
  return raw !== "false" && raw !== "0" && raw !== "off" && raw !== "no";
}

export function adexchangeVideoConfig(): VideoAdProviderConfig {
  const tagUrl =
    normalizeVideoTagUrl(process.env.NEXT_PUBLIC_ADEXCHANGE_VAST_TAG) ??
    normalizeVideoTagUrl(ADEXCHANGE_VAST_TAG);
  return {
    id: "adexchange",
    enabled: videoAdsGloballyEnabled() && adexchangeEnabled(),
    configured: tagUrl !== null,
    tagUrl,
    timeoutMs: videoTimeoutMs(process.env.NEXT_PUBLIC_ADEXCHANGE_VAST_TIMEOUT_MS),
    placement: "post-match",
  };
}

export const adexchangeVideoProvider: VideoAdProvider = {
  id: "adexchange",
  config: adexchangeVideoConfig,
  request: (options?: VideoAdRequestOptions): Promise<VideoAdResult> =>
    requestWithConfig("adexchange", adexchangeVideoConfig(), options),
};
