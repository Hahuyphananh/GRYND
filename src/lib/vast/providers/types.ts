// src/lib/vast/providers/types.ts
//
// Provider-neutral types for the post-match video ad.
//
// The existing player (components/ads/PostMatchVideoAd.tsx) understands
// `VastLinearAd` + `VastMediaFile`. These adapters keep that foundation and
// only CHANGE THE SOURCE of an already-parsed Inline ad: a normalized result
// carries the same media, duration, skip hint, impressions, start/complete
// tracking and error URLs the player already uses. No provider-specific player
// is introduced, and no click-through URL is ever exposed.

import type { VastRequestFailureReason } from "../client";
import type { VastMediaFile } from "../parse";

export type VideoProviderId = "hilltop" | "exoclick" | "adcash" | "adexchange";

/** The only surface a post-match video ad may use. */
export type VideoAdPlacement = "post-match";

export interface NormalizedVideoAd {
  provider: VideoProviderId;
  adId: string | null;
  adSystem: string | null;
  /** The one playable progressive video file. */
  media: VastMediaFile;
  durationSeconds: number | null;
  /** Provider hint only; the player keeps its own 15 s skip policy. */
  skipOffsetSeconds: number | null;
  impressionUrls: string[];
  errorUrls: string[];
  startUrls: string[];
  completeUrls: string[];
  skipUrls: string[];
  /**
   * `<ClickThrough>` was present. The URL is deliberately absent: the player
   * has nothing it could bind, so the ad can never navigate.
   */
  hasClickThrough: boolean;
}

export type VideoAdFailureReason =
  | VastRequestFailureReason
  | "disabled"
  | "not-configured"
  | "no-media"
  | "placement-not-allowed";

export type VideoAdResult =
  | { ok: true; ad: NormalizedVideoAd }
  | { ok: false; provider: VideoProviderId; reason: VideoAdFailureReason };

export interface VideoAdProviderConfig {
  id: VideoProviderId;
  /** Provider switch AND the global post-match switch. */
  enabled: boolean;
  /** A valid https tag URL exists. */
  configured: boolean;
  tagUrl: string | null;
  timeoutMs: number;
  placement: VideoAdPlacement;
}

export interface VideoAdRequestOptions {
  signal?: AbortSignal;
  /** A chain-wide remaining budget; the adapter never exceeds its own cap. */
  timeoutMs?: number;
}

export interface VideoAdProvider {
  id: VideoProviderId;
  config(): VideoAdProviderConfig;
  request(options?: VideoAdRequestOptions): Promise<VideoAdResult>;
}
