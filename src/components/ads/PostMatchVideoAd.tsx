"use client";

/**
 * PostMatchVideoAd — the OPTIONAL, dismissible video advertisement that may be
 * shown AFTER a match has finished, and nowhere else.
 *
 * This component is mounted by exactly ONE surface today — the Ultimate
 * Tic-Tac-Toe PvP result screen — as a pilot. It is not in the layout and not on
 * any browsing page or lobby.
 *
 * ── THE RULES IT ENCODES ────────────────────────────────────────────────────
 *
 *   * NOTHING LOADS UNTIL THE PLAYER ASKS. The card renders a "Watch video"
 *     button; the VAST tag is requested only after that click. Rendering the
 *     component costs nothing — no script, no request, no pixel. There is no
 *     provider JavaScript anywhere: playback is a native <video> element fed a
 *     media URL the local parser extracted.
 *
 *   * A FINISHED MATCH IS THE ONLY SURFACE. `matchEnded` must be true or the
 *     component renders nothing at all. It never renders during play, in a
 *     lobby, or on a browsing page.
 *
 *   * CADENCE, NOT EVERY MATCH. Before the card is shown it tells
 *     lib/vast/frequency.ts that this match finished; that module decides
 *     whether the match earns an offer (default: one per THREE completed
 *     matches, never consecutive, with a cooldown after an offer or a
 *     dismissal). A match is counted at most once, so a refresh, a remount, a
 *     duplicated realtime event or a revisit cannot advance the cadence or
 *     resurface a card that was already shown.
 *
 *   * KILLABLE FROM CONFIGURATION, LIVE. The hosting page passes the server's
 *     `POST_MATCH_ADS_ENABLED` answer, so flipping it to false stops the surface
 *     on the next request with no rebuild. The build-time
 *     `NEXT_PUBLIC_POST_MATCH_ADS_ENABLED=false` switch (and the provider
 *     switch) are applied on top. Either way: no card, no request, and the
 *     cadence is not advanced — no game or result-screen change required.
 *
 *   * IT NEVER DELAYS THE RESULT. The card is a sibling of the result content
 *     and has no callback the result screen must await; activation, loading and
 *     failure are all local to this component.
 *
 *   * IT CAN NEVER NAVIGATE. There is no <a>, no `window.open`, no
 *     `location.assign`, and the VAST `<ClickThrough>` is not even exposed by
 *     the parser, so there is nothing to bind. Clicking the video uses the
 *     player's own controls (play/pause/seek/volume) and nothing else.
 *
 *   * IT FAILS INTO SILENCE, NOT INTO FAKE CONTENT. A blocked, malformed,
 *     unfilled or unsupported response shows a short "unavailable" line and a
 *     close button. No placeholder video, no stock clip, no retry loop.
 *
 *   * ONE PLAYER, CLEANLY REMOVED. A single instance is created per activation;
 *     a re-render or double click cannot start a second request (the request
 *     module also refuses concurrent requests globally). Unmount aborts the
 *     fetch, pauses the video, clears its `src` and drops the element, so no
 *     decoder, network stream or listener outlives the component.
 *
 * ── PROVIDER NOTE ───────────────────────────────────────────────────────────
 * The approved HilltopAds response is a VAST 3.0 InLine linear with
 * `skipoffset` and a `<ClickThrough>`. Both are inert here: skip is our own
 * dismiss button (immediately available, never gated behind the provider's
 * offset), and the click-through is intentionally never offered. The provider
 * does not require an interactive creative for playback, so no intrusive
 * fallback is implemented — see the integration report.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { postMatchAdsEnabled, postMatchVastUrl } from "../../lib/vast/config";
import { requestVastAds, sendVastBeacon } from "../../lib/vast/client";
import {
  markPostMatchAdDismissed,
  observeCompletedMatch,
} from "../../lib/vast/frequency";
import {
  pickMediaFile,
  type VastLinearAd,
  type VastMediaFile,
} from "../../lib/vast/parse";

type Phase = "idle" | "loading" | "ready" | "error" | "dismissed";
type ErrorKind = "unavailable" | "playback";

export interface PostMatchVideoAdProps {
  /**
   * True only once the match is OVER and its result is on screen. When false
   * the component renders nothing — this is the gameplay guard, not a hint.
   */
  matchEnded: boolean;
  /**
   * The settled match's id. The cadence counts each completed match once, so a
   * refresh, remount or duplicate event cannot advance it or earn a second
   * offer for the same match. A blank id means no ad.
   */
  matchId: string;
  /**
   * Runtime kill switch, read on the server by the hosting page. Defaults to
   * true; the build-time public switch is applied on top of it.
   */
  enabled?: boolean;
  /**
   * True when the viewer is an active GRYND PRO member (`ad_free`). Resolved
   * server-side by `postMatchAdSurface()`; a member gets no card, no request
   * and no cadence advance, even if a caller only checked the kill switch.
   */
  adFree?: boolean;
  className?: string;
  /** Called when the player closes the card (before or after playback). */
  onDismiss?: () => void;
}

export default function PostMatchVideoAd({
  matchEnded,
  matchId,
  enabled = true,
  adFree = false,
  className = "",
  onDismiss,
}: PostMatchVideoAdProps) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [offerAllowed, setOfferAllowed] = useState(false);
  const [errorKind, setErrorKind] = useState<ErrorKind>("unavailable");
  const [ad, setAd] = useState<VastLinearAd | null>(null);
  const [media, setMedia] = useState<VastMediaFile | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const requestStartedRef = useRef(false);
  const impressionSentRef = useRef(false);
  const startSentRef = useRef(false);
  const completeSentRef = useRef(false);
  const skipSentRef = useRef(false);
  const endedRef = useRef(false);

  // Three gates, all required: the live server flag (prop), the membership
  // answer (prop — `ad_free` is a paid benefit, so a member sees nothing) and
  // the build-time public flag. Any one being false means nothing renders,
  // nothing loads and the cadence is not advanced.
  const active = enabled && !adFree && postMatchAdsEnabled();

  // ── Cadence ───────────────────────────────────────────────────────────────
  // Runs AFTER paint, so the result/reward content is already on screen and the
  // policy can never delay it. The observation is idempotent per match id, which
  // is what makes a refresh of this result page a non-event. The cadence is not
  // advanced at all while advertising is switched off, so re-enabling the flag
  // never releases a backlog of ads.
  useEffect(() => {
    if (!active || !matchEnded) return;
    const decision = observeCompletedMatch(matchId);
    if (decision.offer) setOfferAllowed(true);
  }, [active, matchEnded, matchId]);

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

  // Playback begins only after an explicit activation. `play()` can still be
  // refused by the browser's autoplay policy (the click happened before an
  // async fetch); that is fine — the native controls stay visible and the
  // impression is not counted until playback actually starts.
  useEffect(() => {
    if (phase !== "ready") return;
    const video = videoRef.current;
    if (!video) return;
    void video.play().catch(() => {});
  }, [phase, media?.url]);

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
  const activate = useCallback(async () => {
    // One request per mount, no matter how many times this is invoked.
    if (requestStartedRef.current) return;

    const url = postMatchVastUrl();
    if (!url) {
      setErrorKind("unavailable");
      setPhase("error");
      return;
    }

    requestStartedRef.current = true;
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase("loading");

    const result = await requestVastAds(url, { signal: controller.signal });

    // Unmounted (or closed) while the request was in flight: drop the result.
    if (controller.signal.aborted) return;

    if (!result.ok) {
      setErrorKind("unavailable");
      setPhase("error");
      return;
    }

    const nextAd = result.ads.find((candidate) => pickMediaFile(candidate) !== null) ?? null;
    const nextMedia = nextAd ? pickMediaFile(nextAd) : null;

    if (!nextAd || !nextMedia) {
      setErrorKind("unavailable");
      setPhase("error");
      return;
    }

    setAd(nextAd);
    setMedia(nextMedia);
    setPhase("ready");
  }, []);

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

    // Respect the dismissal: reset the cycle and stamp the time, so closing a
    // card can never immediately produce another ad.
    markPostMatchAdDismissed(matchId);

    // A close mid-roll is a skip for measurement purposes (never a click).
    if (ad && !endedRef.current && !skipSentRef.current) {
      skipSentRef.current = true;
      fireTracking(trackingFor("skip"));
    }

    setPhase("dismissed");
    onDismiss?.();
  }, [ad, fireTracking, matchId, onDismiss, trackingFor]);

  const handlePlay = useCallback(() => {
    if (!ad) return;
    if (!impressionSentRef.current) {
      impressionSentRef.current = true;
      fireTracking(ad.impressionUrls);
    }
    if (!startSentRef.current) {
      startSentRef.current = true;
      fireTracking(trackingFor("start"));
    }
  }, [ad, fireTracking, trackingFor]);

  const handleEnded = useCallback(() => {
    endedRef.current = true;
    if (!ad || completeSentRef.current) return;
    completeSentRef.current = true;
    fireTracking(trackingFor("complete"));
  }, [ad, fireTracking, trackingFor]);

  const handleMediaError = useCallback(() => {
    if (!ad) return;
    // VAST error code 405: media file not supported / playback failed.
    fireTracking(ad.errorUrls, "405");
    setErrorKind("playback");
    setPhase("error");
  }, [ad, fireTracking]);

  // ── Render ────────────────────────────────────────────────────────────────
  // Hooks above, gates here: a match that is not over gets NOTHING, and a
  // dismissed card stays gone for this mount.
  if (!active || !matchEnded || !offerAllowed || phase === "dismissed") {
    return null;
  }

  const shell =
    `mx-auto w-full max-w-sm rounded-2xl border border-[#00e5ff]/30 bg-[#001a2e]/95 p-3 text-left shadow-[0_0_24px_rgba(0,229,255,0.12)] ${className}`.trim();

  const closeButton = (
    <button
      type="button"
      onClick={dismiss}
      aria-label="Close advertisement"
      className="shrink-0 rounded-lg border border-white/15 px-2 py-1 text-xs font-bold text-white/60 transition hover:bg-white/10 hover:text-white"
    >
      ✕
    </button>
  );

  return (
    <section aria-label="Advertisement" className={shell} data-post-match-ad={phase}>
      <div className="flex items-start justify-between gap-3">
        <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#9dd8ff]/60">
          Advertisement
        </p>
        {closeButton}
      </div>

      {phase === "idle" && (
        <>
          <p className="mt-1 text-xs text-white/60">
            Optional — your match result is already saved.
          </p>
          <button
            type="button"
            onClick={() => void activate()}
            className="mt-3 w-full rounded-xl border border-[#00e5ff]/50 bg-[#00e5ff]/10 px-4 py-2.5 text-xs font-bold text-[#67f9ff] transition hover:bg-[#00e5ff]/20"
          >
            Watch video
          </button>
        </>
      )}

      {phase === "loading" && (
        <div role="status" aria-live="polite" className="mt-2 flex items-center gap-2 text-xs text-cyan-200">
          <span aria-hidden="true" className="flex items-center gap-1">
            {[0, 1, 2].map((index) => (
              <span
                key={index}
                className="h-1.5 w-1.5 animate-pulse rounded-full bg-cyan-300"
                style={{ animationDelay: `${index * 150}ms` }}
              />
            ))}
          </span>
          Loading advertisement…
        </div>
      )}

      {phase === "error" && (
        <p role="alert" className="mt-2 text-xs text-white/65">
          {errorKind === "playback"
            ? "This video could not be played."
            : "No advertisement is available right now."}
        </p>
      )}

      {phase === "ready" && media && (
        <>
          {/* No onClick, no <a>, no target: the only interactive surface is the
              player's own control bar. `controlsList` removes unrelated menu
              entries; download is never offered. */}
          <video
            ref={videoRef}
            src={media.url}
            controls
            playsInline
            preload="metadata"
            controlsList="nodownload noremoteplayback"
            disablePictureInPicture
            onPlay={handlePlay}
            onEnded={handleEnded}
            onError={handleMediaError}
            aria-label="Advertisement video"
            className="mt-2 w-full rounded-xl bg-black"
          />
          <p className="mt-2 text-[10px] text-white/40">
            Ad by HilltopAds · the match result is not affected.
          </p>
        </>
      )}
    </section>
  );
}
