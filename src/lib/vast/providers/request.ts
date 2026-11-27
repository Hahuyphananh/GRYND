// src/lib/vast/providers/request.ts
//
// The one request path every adapter uses.
//
// It reuses the existing browser fetcher and strict parser
// (src/lib/vast/client.ts → parse.ts) rather than adding a second networking
// stack. The parser remains Inline-only: a Wrapper response resolves to
// `wrapper-unsupported`, which the adapter reports honestly instead of
// following an arbitrary URL.
//
// No wrapper resolution happens here. The bounded wrapper design and the reason
// it is not enabled are documented in docs/vast-providers.md.

import { requestVastAds } from "../client";
import { pickMediaFile } from "../parse";
import { normalizeVastAd } from "./normalize";
import { VIDEO_AD_PLACEMENT } from "./config";
import type {
  VideoAdFailureReason,
  VideoAdProviderConfig,
  VideoAdRequestOptions,
  VideoAdResult,
  VideoProviderId,
} from "./types";

/**
 * Requests one provider's tag and returns the first playable Inline ad.
 *
 * Never throws: a disabled/unconfigured adapter, a transport failure, a
 * refused Wrapper/VPAID creative or an ad with no playable media all come back
 * as a typed failure, which the future chain can treat as "no ad".
 */
export async function requestWithConfig(
  provider: VideoProviderId,
  config: VideoAdProviderConfig,
  options: VideoAdRequestOptions = {},
): Promise<VideoAdResult> {
  if (config.placement !== VIDEO_AD_PLACEMENT) {
    return { ok: false, provider, reason: "placement-not-allowed" };
  }
  if (!config.enabled) {
    return { ok: false, provider, reason: "disabled" };
  }
  if (!config.tagUrl) {
    return { ok: false, provider, reason: "not-configured" };
  }

  const requested =
    Number.isFinite(options.timeoutMs) && (options.timeoutMs ?? 0) > 0
      ? Number(options.timeoutMs)
      : config.timeoutMs;

  const result = await requestVastAds(config.tagUrl, {
    signal: options.signal,
    timeoutMs: Math.max(250, Math.min(config.timeoutMs, requested)),
  });

  if (!result.ok) {
    // `strict: false` disables discriminated-union narrowing on `ok`, so the
    // failure branch is read explicitly (the same reason parse.ts exports
    // `isVastFailure`).
    const failure = result as { ok: false; reason: VideoAdFailureReason };
    return { ok: false, provider, reason: failure.reason };
  }

  for (const ad of result.ads) {
    const media = pickMediaFile(ad);
    if (media) {
      return { ok: true, ad: normalizeVastAd(provider, ad, media) };
    }
  }

  return { ok: false, provider, reason: "no-media" };
}
