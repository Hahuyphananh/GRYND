// src/lib/vast/client.ts
//
// Browser-side VAST fetch + measurement beacons for the post-match ad.
//
// THREE PROPERTIES THIS FILE EXISTS TO ENFORCE
//
//   1. ONE REQUEST AT A TIME. The provider's endpoint is per-zone and the ad
//      surface can be mounted by more than one result screen in a session, so a
//      module-scoped in-flight guard refuses a second concurrent request
//      (`reason: "busy"`) instead of firing duplicates. The consumer also keeps
//      its own "already requested" ref, so a re-render cannot restart the fetch.
//
//   2. NOTHING HANGS. Every request is bounded by a timeout, and the caller's
//      AbortSignal is forwarded, so unmounting the component cancels the fetch.
//      The response is size-capped both by header and after decoding.
//
//   3. NOTHING EXECUTES. The body is only ever handed to the strict parser in
//      ./parse.ts. There is no eval, no `Function`, no HTML injection, and no
//      script/img/iframe loaded from the response — the only things this module
//      can cause are a GET for the VAST XML and 1×1 measurement beacons for URLs
//      the parser already vetted as https.
//
// Credentials are never sent (`credentials: "omit"`): the ad is anonymous and
// must not depend on — or leak — the player's Clerk session.

import {
  isVastFailure,
  parseVastResponse,
  type VastFailureReason,
  type VastLinearAd,
} from "./parse";

/** Fetch deadline. A slow ad must never hold the surface open. */
const DEFAULT_TIMEOUT_MS = 8_000;

/** Hard cap on the response body, mirroring the parser's own limit. */
const MAX_RESPONSE_BYTES = 512 * 1024;

export type VastRequestFailureReason =
  | "busy"
  | "timeout"
  | "aborted"
  | "http-error"
  | "network-error"
  | "oversized"
  | VastFailureReason;

export type VastRequestResult =
  | { ok: true; ads: VastLinearAd[] }
  | { ok: false; reason: VastRequestFailureReason };

/** The controller of the request currently in flight, or null. */
let inFlight: AbortController | null = null;

/** True while a VAST request is in flight anywhere on this page. */
export function isVastRequestInFlight(): boolean {
  return inFlight !== null;
}

export interface VastRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Fetches and parses one VAST document.
 *
 * Never throws: transport, timeout, size and parse failures all come back as
 * `{ ok: false, reason }`, which the caller renders as an "unavailable" state.
 */
export async function requestVastAds(
  url: string,
  options: VastRequestOptions = {},
): Promise<VastRequestResult> {
  // Refuse rather than queue: a second simultaneous request is never useful and
  // the guard is what keeps the zone from seeing duplicate demand.
  if (inFlight) return { ok: false, reason: "busy" };

  const controller = new AbortController();
  inFlight = controller;

  const timeoutMs =
    Number.isFinite(options.timeoutMs) && (options.timeoutMs ?? 0) > 0
      ? Number(options.timeoutMs)
      : DEFAULT_TIMEOUT_MS;

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const external = options.signal;
  const forwardAbort = () => controller.abort();
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener("abort", forwardAbort, { once: true });
  }

  try {
    const response = await fetch(url, {
      method: "GET",
      mode: "cors",
      credentials: "omit",
      cache: "no-store",
      redirect: "follow",
      signal: controller.signal,
    });

    if (!response.ok) return { ok: false, reason: "http-error" };

    const declaredLength = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
      return { ok: false, reason: "oversized" };
    }

    const body = await response.text();
    if (body.length > MAX_RESPONSE_BYTES) {
      return { ok: false, reason: "oversized" };
    }

    const parsed = parseVastResponse(body);
    if (isVastFailure(parsed)) return { ok: false, reason: parsed.reason };
    return { ok: true, ads: parsed.ads };
  } catch {
    if (timedOut) return { ok: false, reason: "timeout" };
    if (controller.signal.aborted || external?.aborted) {
      return { ok: false, reason: "aborted" };
    }
    return { ok: false, reason: "network-error" };
  } finally {
    clearTimeout(timer);
    external?.removeEventListener("abort", forwardAbort);
    if (inFlight === controller) inFlight = null;
  }
}

/**
 * Fires VAST measurement URLs as 1×1 image GETs.
 *
 * These are the only requests an ad causes besides the video itself. They are
 * best-effort: a blocked beacon must never surface to the player or break
 * playback, so every failure is swallowed. URLs reaching this function have
 * already been validated as `https:` by the parser; the guard here is a second
 * line of defence, not the only one.
 */
export function sendVastBeacon(urls: readonly string[]): void {
  if (typeof window === "undefined") return;

  for (const url of urls) {
    if (typeof url !== "string") continue;
    if (!url.startsWith("https://")) continue;

    try {
      const pixel = new Image(1, 1);
      pixel.referrerPolicy = "no-referrer";
      pixel.src = url;
    } catch {
      // Ignored on purpose: measurement is not allowed to affect playback.
    }
  }
}
