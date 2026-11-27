"use client";

/**
 * PostMatchVideoAd — the FULL-PAGE, AUTOMATIC video advertisement that plays
 * AFTER a match has finished, and nowhere else.
 *
 * Mounted by `PostMatchAdSlot`, which every shared result screen (PvP and vs-AI)
 * already uses, plus the bespoke result panels that opt in.
 *
 * ── THE RULES IT ENCODES ────────────────────────────────────────────────────
 *
 *   * A FINISHED MATCH IS THE ONLY SURFACE. `matchEnded` must be true or the
 *     component renders nothing at all. It never renders during play, in a
 *     lobby, or on a browsing page.
 *
 *   * IT PLAYS ITSELF, OVER THE WHOLE PAGE. Once the cadence allows an offer the
 *     tag is requested immediately and the creative takes over the viewport
 *     (`fixed inset-0`), with the result screen still behind it. Until that
 *     creative is actually ready NOTHING is drawn — no loading overlay, no
 *     black screen — so an ad that never arrives is never seen at all. There is
 *     no "Watch video" step. Playback starts muted, because a browser will refuse
 *     an unmuted autoplay without a gesture — a sound toggle is offered instead
 *     of a play button, so the ad itself is never blocked by the autoplay
 *     policy.
 *
 *   * SKIP AFTER 15 SECONDS, AND ONLY FOR LONG ADS. The skip control opens at
 *     15 s for a creative longer than that (or at its own end for a shorter
 *     one), and shows a countdown until it does. The wait is measured from the
 *     PLAYING CLOCK, not from a timer, so a paused or stalled ad does not earn
 *     its skip early, and an ad whose duration cannot be read falls back to the
 *     same 15 s ceiling — never to an indefinite hold. There is no loading or
 *     failure card to close, because the overlay exists only while a creative
 *     is on screen.
 *
 *   * CADENCE, NOT EVERY MATCH BY FORCE. Before the card is shown it tells
 *     lib/vast/frequency.ts that this match finished; that module decides
 *     whether the match earns an offer. The default is now EVERY completed
 *     match, once per match id (so a refresh, a remount, a duplicated realtime
 *     event or a revisit can never re-offer the same match), and the tuning
 *     knobs are still available for a deploy that wants a lighter cadence.
 *
 *   * KILLABLE FROM CONFIGURATION, LIVE. The hosting page passes the server's
 *     `POST_MATCH_ADS_ENABLED` answer, so flipping it to false stops the surface
 *     on the next request with no rebuild. The build-time
 *     `NEXT_PUBLIC_POST_MATCH_ADS_ENABLED=false` switch (and the provider
 *     switch) are applied on top. Either way: no card, no request, and the
 *     cadence is not advanced — no game or result-screen change required.
 *
 *   * IT NEVER BREAKS THE RESULT. The ad is an overlay with no callback the
 *     result screen must await; activation, loading and failure are local. The
 *     result is already saved and already on screen when it appears.
 *
 *   * IT CAN NEVER NAVIGATE. There is no <a>, no `window.open`, no
 *     `location.assign`, and the VAST `<ClickThrough>` is not exposed by the
 *     parser, so there is nothing to bind. The video has no native controls
 *     (they would allow seeking past the skip rule); the only controls are our
 *     own skip and sound toggle.
 *
 *   * NO AD MEANS NO SURFACE. A blocked, malformed, unfilled or failed tag is
 *     not drawn at all: the overlay is removed the instant the answer is
 *     "nothing to play", and `onNoOffer` reports it so a result screen holding
 *     an exit action can run. No placeholder video, no stock clip, no retry
 *     loop, and nothing for the player to dismiss.
 *
 *   * A CREATIVE THAT CANNOT PLAY IS CLEARED THE SAME WAY. The ad was served and
 *     then failed in the browser: the 405 error is reported to the network and
 *     the overlay is removed at once. There is no "could not be played" card
 *     and no stuck surface to dismiss.
 *
 *   * ONE PLAYER, CLEANLY REMOVED. A single instance is created per activation;
 *     a re-render cannot start a second request (the request module also
 *     refuses concurrent requests globally). Unmount aborts the fetch, pauses
 *     the video, clears its `src` and drops the element, so no decoder, network
 *     stream or listener outlives the component.
 *
 * ── PROVIDER NOTE ───────────────────────────────────────────────────────────
 * The approved HilltopAds response is a VAST 3.0 InLine linear with
 * `skipoffset` and a `<ClickThrough>`. Both remain inert: skip is our own
 * control on our own 15 s rule (never the provider's offset), and the
 * click-through is intentionally never offered.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  COOKIE_CONSENT_EVENT,
  getCookieConsent,
  type CookieConsent,
} from "../../lib/cookieConsent";
import {
  postMatchAdsEnabled,
  postMatchAdsRequireConsent,
  postMatchConsentSatisfied,
} from "../../lib/vast/config";
import { sendVastBeacon } from "../../lib/vast/client";
import {
  markPostMatchAdDismissed,
  observeCompletedMatch,
} from "../../lib/vast/frequency";
import type { VastLinearAd, VastMediaFile } from "../../lib/vast/parse";
import { requestVideoAd } from "../../lib/vast/providers";
import { videoFailureOutcome, videoProviderChain } from "../../lib/vast/providers/chain";
import { toPlayerVastAd } from "../../lib/vast/providers/normalize";
import type { NormalizedVideoAd, VideoProviderId } from "../../lib/vast/providers/types";
import { runAdChain } from "../../lib/ads/core/chain";
import {
  claimOpportunity,
  markMatchAdServed,
  newOpportunityOwner,
  videoOpportunityId,
  wasMatchAdServed,
} from "../../lib/ads/core/opportunity";
import { outcomeMetric, reportAdEvent } from "../../lib/ads/core/report";
import { videoChainBudgetMs } from "../../lib/ads/banners/limits";

type Phase = "loading" | "ready" | "closed";

/**
 * How long a long creative holds the viewer before the skip control opens.
 * Short ads are never held beyond their own end.
 */
export const SKIP_AFTER_SECONDS = 15;

export interface PostMatchVideoAdProps {
  /**
   * True only once the match is OVER and its result is on screen. When false
   * the component renders nothing — this is the gameplay guard, not a hint.
   */
  matchEnded: boolean;
  /**
   * The settled match's id. The cadence counts each completed match once, so a
   * refresh, remount or duplicate event cannot earn a second offer for the same
   * match. A blank id means no ad.
   */
  matchId: string;
  /**
   * Runtime kill switch, read on the server by the hosting page. Defaults to
   * true; the build-time public switch is applied on top of it.
   */
  enabled?: boolean;
  /**
   * True when the viewer is an active GRYND PRO member (`ad_free`). Resolved
   * server-side by `postMatchAdSurface()`; a member gets no ad, no request and
   * no cadence advance, even if a caller only checked the kill switch.
   */
  adFree?: boolean;
  className?: string;
  /** Called when the player skips/closes (or the ad finishes on its own). */
  onDismiss?: () => void;
  /**
   * Called when this mount will never play anything: the kill switch or the
   * membership answer turned the surface off, the cadence declined this match,
   * or there is no match id. A host that is holding an exit action until the ad
   * settles needs this answer, otherwise it would wait for a close that can
   * never come.
   */
  onNoOffer?: () => void;
}

export default function PostMatchVideoAd({
  matchEnded,
  matchId,
  enabled = true,
  adFree = false,
  className = "",
  onDismiss,
  onNoOffer,
}: PostMatchVideoAdProps) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [offerAllowed, setOfferAllowed] = useState(false);
  const [consent, setConsent] = useState<CookieConsent | null>(null);
  const [consentReady, setConsentReady] = useState(false);
  const [ad, setAd] = useState<VastLinearAd | null>(null);
  const [media, setMedia] = useState<VastMediaFile | null>(null);
  const [muted, setMuted] = useState(true);
  const [servedProvider, setServedProvider] = useState<VideoProviderId>("hilltop");
  const [playedSeconds, setPlayedSeconds] = useState(0);
  const [videoDuration, setVideoDuration] = useState<number | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const requestStartedRef = useRef(false);
  const ownerRef = useRef(newOpportunityOwner());
  const servedProviderRef = useRef<VideoProviderId>("hilltop");
  const impressionSentRef = useRef(false);
  const startSentRef = useRef(false);
  const completeSentRef = useRef(false);
  const skipSentRef = useRef(false);
  const endedRef = useRef(false);

  // The shared consent record. It is read after mount and on every change, so
  // the server never guesses a visitor's choice. Nothing is requested until the
  // record resolves.
  useEffect(() => {
    const apply = () => {
      setConsent(getCookieConsent());
      setConsentReady(true);
    };
    apply();
    window.addEventListener(COOKIE_CONSENT_EVENT, apply);
    return () => window.removeEventListener(COOKIE_CONSENT_EVENT, apply);
  }, []);

  const consentSatisfied =
    !postMatchAdsRequireConsent() || postMatchConsentSatisfied(consent);

  // Four gates, all required: the live server flag (prop), the membership
  // answer (prop — `ad_free` is a paid benefit, so a member sees nothing), the
  // build-time public flag and the visitor's consent. Any one being false means
  // nothing renders, no VAST request leaves the browser and the cadence is not
  // advanced.
  const active =
    enabled && !adFree && postMatchAdsEnabled() && consentSatisfied;

  // A host that decides navigation AFTER this component must hear "nothing will
  // play" from whichever path produces that answer. Held in a ref so a
  // re-rendered inline callback cannot re-run the cadence effect below (which
  // would double-count the match).
  const onNoOfferRef = useRef(onNoOffer);
  useEffect(() => {
    onNoOfferRef.current = onNoOffer;
  }, [onNoOffer]);

  // ── Nothing to play ──────────────────────────────────────────────────────
  // An unavailable ad must not be left on screen, not even briefly and not as a
  // message the player has to close: the overlay is removed as soon as the
  // answer is known, and the host is told so a held exit action can run. This
  // is NOT a dismissal — nothing played, so the cadence is left untouched and
  // no skip is reported. Idempotent, because two paths can answer at once.
  const removedRef = useRef(false);
  const removeNow = useCallback(() => {
    if (removedRef.current) return;
    removedRef.current = true;
    abortRef.current?.abort();
    abortRef.current = null;
    setPhase("closed");
    onNoOfferRef.current?.();
  }, []);

  // ── Cadence ───────────────────────────────────────────────────────────────
  // Runs AFTER paint, so the result content is already on screen and the policy
  // can never delay it. The observation is idempotent per match id, which is
  // what makes a refresh of this result page a non-event.
  useEffect(() => {
    if (!matchEnded) return;
    // Wait for the stored consent answer before deciding anything. Without this
    // guard the first render (consent still null) would be treated as a refusal
    // and settle the result screen before the record is even read.
    if (!consentReady) return;
    // Switched off (kill switch, membership, build-time flag or consent):
    // nothing is requested and the cadence is deliberately not advanced.
    if (!active) {
      onNoOfferRef.current?.();
      return;
    }
    const decision = observeCompletedMatch(matchId);
    if (decision.offer) setOfferAllowed(true);
    else onNoOfferRef.current?.();
  }, [active, consentReady, matchEnded, matchId]);

  const fireTracking = useCallback(
    (urls: readonly string[], errorCode?: string) => {
      if (urls.length === 0) return;
      sendVastBeacon(
        errorCode
          ? urls.map((url) => url.replace("[ERRORCODE]", errorCode))
          : urls,
      );
    },
    [],
  );

  const trackingFor = useCallback(
    (event: string): string[] =>
      ad ? ad.tracking.filter((item) => item.event === event).map((item) => item.url) : [],
    [ad],
  );

  // ── Activation ────────────────────────────────────────────────────────────
  // One sequential chain per mount, no matter how many times this is invoked.
  // Providers are tried in configured priority, and a fill ends the chain, so
  // two creatives can never play for one match.
  const activate = useCallback(async () => {
    if (requestStartedRef.current) return;

    const opportunity = {
      id: videoOpportunityId(matchId),
      kind: "video" as const,
      placement: "post-match",
    };

    // ROTATION: the opportunity id chooses the first provider, so two
    // configured video providers alternate between matches instead of the
    // configured first one taking every request. Stable for this match id.
    const order = videoProviderChain(opportunity.id);
    if (order.length === 0) {
      removeNow();
      return;
    }

    // A video already served for this match survives a refresh in this tab.
    if (wasMatchAdServed(matchId)) {
      removeNow();
      return;
    }

    if (!claimOpportunity(opportunity.id, ownerRef.current)) {
      removeNow();
      return;
    }

    requestStartedRef.current = true;
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase("loading");

    let filledAd: NormalizedVideoAd | null = null;

    const result = await runAdChain({
      opportunity,
      order,
      totalBudgetMs: videoChainBudgetMs(),
      signal: controller.signal,
      attempt: async (provider, budgetMs) => {
        reportAdEvent({
          metric: "ad_request",
          kind: "video",
          provider,
          placement: "post-match",
          opportunityId: opportunity.id,
        });

        const response = await requestVideoAd(provider, {
          signal: controller.signal,
          timeoutMs: budgetMs,
        });

        if (response.ok) {
          filledAd = response.ad;
          return {
            provider,
            status: "filled" as const,
            verifiedImpression: false,
            reason: "inline-ad",
          };
        }

        // `strict: false` disables discriminant narrowing, so read the failure
        // branch explicitly (the same pattern as the VAST parser callers).
        const failure = response as {
          ok: false;
          reason: Parameters<typeof videoFailureOutcome>[1];
        };
        return videoFailureOutcome(provider, failure.reason);
      },
      onOutcome: (outcome) => {
        reportAdEvent({
          metric: outcomeMetric(outcome.status),
          kind: "video",
          provider: outcome.provider,
          placement: "post-match",
          opportunityId: opportunity.id,
          status: outcome.status,
          reason: outcome.reason,
          verifiedImpression: false,
        });
      },
    });

    // Unmounted (or closed) while the chain was in flight: drop the result.
    if (controller.signal.aborted) return;

    // No provider filled: there is no advertisement, so the surface leaves
    // immediately instead of holding the result screen.
    const ad = filledAd;
    if (!result.filled || !ad) {
      removeNow();
      return;
    }

    setAd(toPlayerVastAd(ad));
    setMedia(ad.media);
    setServedProvider(ad.provider);
    servedProviderRef.current = ad.provider;
    markMatchAdServed(matchId);
    setPhase("ready");
  }, [matchId, removeNow]);

  // THE AD STARTS ITSELF. No click, no "watch video" step: the moment the
  // cadence allows an offer the tag is requested. Muted playback is what makes
  // that possible under every browser's autoplay policy.
  useEffect(() => {
    // `offerAllowed` is only set after the consent record resolved, so this
    // cannot request before consent; `active` still turns a later decline off.
    if (!active || !matchEnded || !offerAllowed) return;
    void activate();
  }, [activate, active, matchEnded, offerAllowed]);

  // ── Teardown ──────────────────────────────────────────────────────────────
  // Abort any in-flight request and release the media element. Removing `src`
  // and calling `load()` is what actually stops the network/decoder work; just
  // unmounting can leave the stream alive until GC.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
      const video = videoRef.current;
      if (!video) return;
      try {
        video.pause();
        video.removeAttribute("src");
        video.load();
      } catch {
        // A media element that is already detached can throw; nothing to do.
      }
    };
  }, []);

  // A full-page overlay owns the viewport: the page behind it must not scroll.
  // Only once the creative is actually on screen — the wait for the tag leaves
  // the result screen completely untouched.
  useEffect(() => {
    if (!active || !matchEnded || !offerAllowed || phase !== "ready" || !media) {
      return undefined;
    }
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [active, matchEnded, offerAllowed, phase, media]);

  // Playback begins as soon as the creative is ready. If the browser still
  // refuses, that is not fatal: the muted attribute is the supported path and a
  // refusal leaves the skip control (and thus an exit) available.
  useEffect(() => {
    if (phase !== "ready") return;
    const video = videoRef.current;
    if (!video) return;
    void video.play().catch(() => {});
  }, [phase, media?.url]);

  const dismiss = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;

    const video = videoRef.current;
    if (video) {
      try {
        video.pause();
      } catch {
        // Already detached; nothing to pause.
      }
    }

    // Respect the dismissal: it resets the cycle and stamps the time, so
    // closing an ad can never immediately produce another one.
    markPostMatchAdDismissed(matchId);

    // A close mid-roll is a skip for measurement purposes (never a click).
    if (ad && !endedRef.current && !skipSentRef.current) {
      skipSentRef.current = true;
      fireTracking(trackingFor("skip"));
    }

    setPhase("closed");
    onDismiss?.();
  }, [ad, fireTracking, matchId, onDismiss, trackingFor]);

  const handlePlay = useCallback(() => {
    if (!ad) return;
    if (!impressionSentRef.current) {
      impressionSentRef.current = true;
      fireTracking(ad.impressionUrls);
      // The ONLY verified impression: the media element actually started.
      reportAdEvent({
        metric: "ad_impression",
        kind: "video",
        provider: servedProviderRef.current,
        placement: "post-match",
        opportunityId: videoOpportunityId(matchId),
        verifiedImpression: true,
      });
    }
    if (!startSentRef.current) {
      startSentRef.current = true;
      fireTracking(trackingFor("start"));
      reportAdEvent({
        metric: "ad_video_start",
        kind: "video",
        provider: servedProviderRef.current,
        placement: "post-match",
        opportunityId: videoOpportunityId(matchId),
        verifiedImpression: true,
      });
    }
  }, [ad, fireTracking, matchId, trackingFor]);

  const handleEnded = useCallback(() => {
    endedRef.current = true;
    if (ad && !completeSentRef.current) {
      completeSentRef.current = true;
      fireTracking(trackingFor("complete"));
      reportAdEvent({
        metric: "ad_video_complete",
        kind: "video",
        provider: servedProviderRef.current,
        placement: "post-match",
        opportunityId: videoOpportunityId(matchId),
        verifiedImpression: true,
      });
    }
    // The creative is over; hand the page back to the result.
    dismiss();
  }, [ad, dismiss, fireTracking, matchId, trackingFor]);

  const handleMediaError = useCallback(() => {
    if (!ad) return;
    // The served creative could not be played: report it to the network, then
    // clear the surface immediately. A broken ad must never sit over the result
    // waiting to be closed.
    // VAST error code 405: media file not supported / playback failed.
    fireTracking(ad.errorUrls, "405");
    reportAdEvent({
      metric: "ad_error",
      kind: "video",
      provider: servedProviderRef.current,
      placement: "post-match",
      opportunityId: videoOpportunityId(matchId),
      status: "invalid_response",
      reason: "media-error",
      verifiedImpression: false,
    });
    removeNow();
  }, [ad, fireTracking, matchId, removeNow]);

  const handleDuration = useCallback((video: HTMLVideoElement) => {
    const value = video.duration;
    if (Number.isFinite(value) && value > 0) setVideoDuration(value);
  }, []);

  // ── Skip rule ─────────────────────────────────────────────────────────────
  // Measured on the PLAYING CLOCK. Until the creative's real duration is known
  // the 15 s ceiling applies, so an unreadable duration can only shorten the
  // hold, never extend it. A short ad unlocks at its own end — it is over
  // anyway — and a long one at 15 s.
  const skipUnlockSeconds =
    videoDuration !== null && videoDuration <= SKIP_AFTER_SECONDS
      ? videoDuration
      : SKIP_AFTER_SECONDS;
  const canSkip = playedSeconds >= skipUnlockSeconds;
  const skipRemaining = Math.max(0, Math.ceil(skipUnlockSeconds - playedSeconds));

  // ── Render ────────────────────────────────────────────────────────────────
  // Hooks above, gates here: a match that is not over, an offer the cadence
  // refused, or a closed ad gets NOTHING. So does the wait for the tag: the
  // overlay only mounts once a creative is READY, so an unavailable ad never
  // flashes a loading screen over the result it would have interrupted.
  if (!active || !matchEnded || !offerAllowed || phase !== "ready" || !media) {
    return null;
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Advertisement"
      data-post-match-ad={phase}
      className={`fixed inset-0 z-[100] flex flex-col bg-black ${className}`.trim()}
    >
      <div className="flex items-center justify-between gap-3 px-4 pb-2 pt-3">
        <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-white/45">
          Advertisement
        </p>

        <button
          type="button"
          onClick={dismiss}
          disabled={!canSkip}
          aria-label={
            canSkip ? "Skip advertisement" : `Skip available in ${skipRemaining} seconds`
          }
          className={`rounded-lg border px-3 py-1.5 text-[11px] font-bold transition ${
            canSkip
              ? "border-white/40 bg-white/10 text-white hover:bg-white/20"
              : "cursor-not-allowed border-white/15 text-white/40"
          }`}
        >
          {canSkip ? "Skip" : `Skip in ${skipRemaining}s`}
        </button>
      </div>

      <div className="relative min-h-0 flex-1 bg-black">
        {/* No onClick, no <a>, no target, no native controls: the only
            interactive surfaces are the skip control above and the sound toggle
            below. `controlsList` removes unrelated menu entries; download is
            never offered. */}
        <video
          ref={videoRef}
          src={media.url}
          autoPlay
          muted={muted}
          playsInline
          preload="auto"
          controls={false}
          controlsList="nodownload noremoteplayback"
          disablePictureInPicture
          onPlay={handlePlay}
          onTimeUpdate={(event) => setPlayedSeconds(event.currentTarget.currentTime)}
          onLoadedMetadata={(event) => handleDuration(event.currentTarget)}
          onDurationChange={(event) => handleDuration(event.currentTarget)}
          onEnded={handleEnded}
          onError={handleMediaError}
          aria-label="Advertisement video"
          className="absolute inset-0 h-full w-full bg-black object-contain"
        />
      </div>

      <div className="flex items-center justify-between gap-3 px-4 pb-3 pt-2">
        <button
          type="button"
          onClick={() => setMuted((current) => !current)}
          aria-pressed={!muted}
          className="rounded-lg border border-white/20 px-3 py-1.5 text-[11px] font-bold text-white/70 transition hover:bg-white/10 hover:text-white"
        >
          {muted ? "Sound off" : "Sound on"}
        </button>
        <p className="text-[11px] text-white/30">
          Ad by {
            {
              hilltop: "HilltopAds",
              exoclick: "ExoClick",
              adcash: "Adcash",
              adexchange: "Ad Exchange",
            }[servedProvider]
          }{" "}
          · the match result is not affected.
        </p>
      </div>
    </div>
  );
}
