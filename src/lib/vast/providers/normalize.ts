// src/lib/vast/providers/normalize.ts
//
// One shape for every provider's Inline result.
//
// Values come only from the strict parser, so every URL is already https and
// every media file is already a progressive `video/*`. This module adds two
// things the multi-provider world needs:
//
//   1. identity — which provider produced the ad;
//   2. deduplication — a tracking URL repeated in the response is fired once,
//      not once per duplicate element (the player fires the arrays as-is).
//
// The click-through URL is never copied. `hasClickThrough` stays a boolean.

import type {
  VastLinearAd,
  VastMediaFile,
  VastTrackingEvent,
} from "../parse";
import type { NormalizedVideoAd, VideoProviderId } from "./types";

/** Stable order, first occurrence wins. */
function unique(urls: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const url of urls) {
    if (typeof url !== "string" || !url) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

/** All tracking URLs for one VAST event, deduplicated. */
export function trackingUrls(ad: VastLinearAd, event: string): string[] {
  return unique(
    ad.tracking.filter((item) => item.event === event).map((item) => item.url),
  );
}

/**
 * Converts a normalized provider result back into the one shape the existing
 * player consumes. Tracking is rebuilt from the normalized events; the
 * click-through URL remains absent.
 */
export function toPlayerVastAd(ad: NormalizedVideoAd): VastLinearAd {
  const tracking: VastTrackingEvent[] = [
    ...ad.startUrls.map((url) => ({ event: "start", url })),
    ...ad.completeUrls.map((url) => ({ event: "complete", url })),
    ...ad.skipUrls.map((url) => ({ event: "skip", url })),
  ];

  return {
    id: ad.adId,
    adSystem: ad.adSystem,
    durationSeconds: ad.durationSeconds,
    skipOffsetSeconds: ad.skipOffsetSeconds,
    mediaFiles: [ad.media],
    impressionUrls: ad.impressionUrls,
    errorUrls: ad.errorUrls,
    tracking,
    hasClickThrough: ad.hasClickThrough,
  };
}

/**
 * Converts a parsed Inline ad into the provider-neutral result.
 *
 * `media` is the file the caller already picked with `pickMediaFile`; the
 * adapter never guesses a different one.
 */
export function normalizeVastAd(
  provider: VideoProviderId,
  ad: VastLinearAd,
  media: VastMediaFile,
): NormalizedVideoAd {
  return {
    provider,
    adId: ad.id,
    adSystem: ad.adSystem,
    media,
    durationSeconds: ad.durationSeconds,
    skipOffsetSeconds: ad.skipOffsetSeconds,
    impressionUrls: unique(ad.impressionUrls),
    errorUrls: unique(ad.errorUrls),
    startUrls: trackingUrls(ad, "start"),
    completeUrls: trackingUrls(ad, "complete"),
    skipUrls: trackingUrls(ad, "skip"),
    hasClickThrough: ad.hasClickThrough,
  };
}
