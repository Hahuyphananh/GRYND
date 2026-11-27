// src/lib/vast/providers/hilltop.ts
//
// HilltopAds VAST adapter.
//
// This wraps the EXISTING approved tag and switches (src/lib/vast/config.ts) so
// its behaviour is identical to today: enabled unless the master or provider
// switch is explicitly false, tag from `NEXT_PUBLIC_HILLTOPS_VAST_URL` with the
// approved default.
//
// Phase 5 wires this adapter into the shared chain. The tag, switches and
// timeout semantics are unchanged; only the request path is shared.

import {
  hilltopVideoProviderEnabled,
  postMatchAdsEnabled,
  postMatchVastUrl,
} from "../config";
import { videoTimeoutMs } from "./config";
import { requestWithConfig } from "./request";
import type {
  VideoAdProvider,
  VideoAdProviderConfig,
  VideoAdRequestOptions,
  VideoAdResult,
} from "./types";

export function hilltopVideoConfig(): VideoAdProviderConfig {
  const tagUrl = postMatchVastUrl();
  return {
    id: "hilltop",
    enabled: postMatchAdsEnabled() && hilltopVideoProviderEnabled(),
    configured: tagUrl !== null,
    tagUrl,
    timeoutMs: videoTimeoutMs(process.env.NEXT_PUBLIC_HILLTOPS_VAST_TIMEOUT_MS),
    placement: "post-match",
  };
}

export const hilltopVideoProvider: VideoAdProvider = {
  id: "hilltop",
  config: hilltopVideoConfig,
  request: (options?: VideoAdRequestOptions): Promise<VideoAdResult> =>
    requestWithConfig("hilltop", hilltopVideoConfig(), options),
};
