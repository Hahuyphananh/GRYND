// src/lib/ads/core/report.ts
//
// Provider-level ad metrics, through PostHog (the analytics client the product
// already uses). Deliberately narrow:
//
//   * No user id, match id, URL, zone id, tag, creative or free-form error text.
//     Only the provider, the surface, the placement, the opportunity KIND, the
//     game MODE (a short fixed token such as `puzzle-daily`) and a short status
//     token leave the browser. The opportunity id itself is NOT sent: it is only
//     used locally for dedupe.
//   * No revenue is ever emitted. These providers' reporting is not available
//     to this app, and an estimate would be a fabrication.
//   * An impression is emitted ONLY by the player's real `play` event. A banner
//     creative appearing is a `fill`, not an impression: display networks give
//     us no verified impression callback, so `verified_impression` stays false.
//
// PostHog is consent-gated by the existing provider, so calling capture here
// makes no request for a visitor who has not accepted analytics.

import type { AdKind, AdOutcomeStatus, AdProviderId } from "./types";

export type AdMetric =
  | "ad_request"
  | "ad_fill"
  | "ad_no_fill"
  | "ad_timeout"
  | "ad_blocked"
  | "ad_error"
  | "ad_impression"
  | "ad_video_start"
  | "ad_video_complete";

export interface AdEvent {
  metric: AdMetric;
  kind: AdKind;
  provider: AdProviderId;
  placement: string;
  opportunityId: string;
  /**
   * The finished game's mode as a bounded analytics dimension (`solo`, `daily`,
   * `puzzle-daily`, `puzzle-unlimited`, `puzzle-ranked`, `puzzle-ai`,
   * `puzzle-strategic`). Free text, ids and anything outside the token rule are
   * dropped rather than sent.
   */
  mode?: string;
  status?: AdOutcomeStatus;
  reason?: string;
  latencyMs?: number;
  verifiedImpression?: boolean;
}

/** Only a short lowercase token may become the `ad_mode` dimension. */
const AD_MODE_RE = /^[a-z][a-z0-9-]{0,31}$/;

export interface AdEventPayload {
  event: AdMetric;
  properties: Record<string, string | number | boolean>;
}

/** Maps a provider outcome to the metric it represents. */
export function outcomeMetric(status: AdOutcomeStatus): AdMetric {
  switch (status) {
    case "filled":
      return "ad_fill";
    case "no_fill":
      return "ad_no_fill";
    case "timeout":
      return "ad_timeout";
    case "blocked":
      return "ad_blocked";
    case "provider_disabled":
    case "network_error":
    case "invalid_response":
      return "ad_error";
  }
}

/**
 * The exact payload sent to PostHog. Exported so tests can prove that no
 * identifier, URL, zone, match or revenue field is present.
 */
export function buildAdEvent(event: AdEvent): AdEventPayload {
  const properties: Record<string, string | number | boolean> = {
    ad_kind: event.kind,
    provider: event.provider,
    placement: event.placement,
    verified_impression: event.verifiedImpression === true,
  };

  if (typeof event.mode === "string" && AD_MODE_RE.test(event.mode)) {
    properties.ad_mode = event.mode;
  }
  if (event.status) properties.status = event.status;
  if (event.reason) properties.reason = event.reason.slice(0, 64);
  if (typeof event.latencyMs === "number" && Number.isFinite(event.latencyMs)) {
    properties.latency_ms = Math.max(0, Math.round(event.latencyMs));
  }

  return { event: event.metric, properties };
}

/** Sends one event. Never throws; a blocked analytics client changes nothing. */
export function reportAdEvent(event: AdEvent): void {
  if (typeof window === "undefined") return;

  const payload = buildAdEvent(event);
  void import("posthog-js")
    .then((module) => {
      // `capture` is a no-op until the consent-gated provider initialises.
      const posthog = module.default as unknown as {
        capture?: (name: string, properties: Record<string, unknown>) => void;
      };
      posthog?.capture?.(payload.event, payload.properties);
    })
    .catch(() => {
      // Analytics is not allowed to affect the ad surface.
    });
}
