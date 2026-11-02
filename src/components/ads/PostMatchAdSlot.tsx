"use client";

/**
 * PostMatchAdSlot — the ONE place a result screen mounts the post-match video.
 *
 * `PvpResultScreen` is the single end-of-match surface in GRYND, so wiring the
 * ad there covers every game at once (PvP and vs-AI) instead of asking ~27
 * screens to duplicate the plumbing. This slot does the per-screen work:
 *
 *   1. ASKS THE SERVER whether an ad may be offered at all — one request to
 *      `/api/ads/post-match`, which folds the runtime kill switch and the
 *      GRYND PRO `ad_free` entitlement into a single `enabled` answer (and
 *      sends `adFree` so this component can refuse independently). No
 *      client-supplied flag, storage value or cookie can turn it on.
 *   2. RESOLVES THE MATCH ID. PvP match views carry `matchId`/`gameId` in the
 *      route, which the cadence counts once per match. A client-only practice
 *      board has no server match id, so one is minted per finished result and
 *      remembered for a minute in sessionStorage — a refresh of the same
 *      result reuses it, while playing another game mints a new one.
 *   3. TELLS THE HOST WHEN IT IS DONE. The result screen now plays this ad when
 *      the player picks an EXIT action (return to lobby, run it back, the back
 *      arrow) and holds that action until the ad settles. `onDone` is that
 *      signal, and it always fires exactly once — after the creative closes or
 *      finishes, and ALSO when no ad can be offered (surface off, member, no
 *      id, failed request, cadence declined). Without that second half an
 *      unavailable ad would strand the player on a button that does nothing.
 *
 * Once it does render, `PostMatchVideoAd` starts the creative itself as a
 * full-page overlay with the 15 s skip rule — there is no click-to-play step
 * here.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";

import PostMatchVideoAd from "./PostMatchVideoAd";

/** sessionStorage key for the minted practice-result id. */
const PRACTICE_ID_KEY = "grynd:postMatchPracticeId:v1";

/**
 * How long a minted practice id is reused. Long enough that reloading the
 * result screen is the same finished game (never a second counted match),
 * short enough that playing another quick practice match is a new one.
 */
const PRACTICE_ID_REUSE_MS = 60_000;

interface SurfaceAnswer {
  enabled: boolean;
  adFree: boolean;
}

/**
 * The id for a practice result: stable across a refresh of this result, new
 * once the player has moved on. Falls back to a fresh id when storage is
 * unavailable, which only risks over-counting the cadence on that tab.
 */
function practiceResultId(pathname: string): string {
  const fresh = `practice:${pathname}:${Date.now()}`;
  if (typeof window === "undefined") return "";

  try {
    const raw = window.sessionStorage.getItem(PRACTICE_ID_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { id?: unknown; pathname?: unknown; at?: unknown };
      const at = Number(parsed?.at);
      if (
        parsed?.pathname === pathname &&
        typeof parsed?.id === "string" &&
        Number.isFinite(at) &&
        Date.now() - at < PRACTICE_ID_REUSE_MS
      ) {
        return parsed.id;
      }
    }
    window.sessionStorage.setItem(
      PRACTICE_ID_KEY,
      JSON.stringify({ id: fresh, pathname, at: Date.now() }),
    );
  } catch {
    // Denied storage: fall through with the fresh id.
  }
  return fresh;
}

export default function PostMatchAdSlot({
  matchId,
  pathname,
  onDone,
}: {
  /** Explicit id, when the game passes one instead of using a route param. */
  matchId?: string;
  /** The result screen's own path, for the practice fallback id. */
  pathname?: string;
  /**
   * Called exactly once, as soon as this mount knows whether anything plays:
   * `true` after the creative was closed, skipped or finished; `false` when no
   * ad can be offered. A host that defers navigation until the ad settles
   * depends on both halves of that answer.
   */
  onDone?: (played: boolean) => void;
} = {}) {
  const params = useParams() as Record<string, string | undefined> | null;
  const routeId = matchId || params?.matchId || params?.gameId || "";

  const [surface, setSurface] = useState<SurfaceAnswer | null>(null);
  const [resolvedId, setResolvedId] = useState(routeId);
  const settledRef = useRef(false);

  // Exactly one settle per mount, whichever path answers first.
  const settle = useCallback(
    (played: boolean) => {
      if (settledRef.current) return;
      settledRef.current = true;
      onDone?.(played);
    },
    [onDone],
  );

  // Practice screens have no match id in the URL: mint one per finished game.
  useEffect(() => {
    if (routeId) {
      setResolvedId(routeId);
      return;
    }
    setResolvedId(practiceResultId(pathname || window.location.pathname));
  }, [routeId, pathname]);

  // One server answer per mounted result screen. A failure renders nothing —
  // the surface must never guess, and the result content is already on screen.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/ads/post-match", { cache: "no-store", credentials: "include" })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: SurfaceAnswer | null) => {
        if (cancelled) return;
        if (!data) {
          settle(false);
          return;
        }
        setSurface({ enabled: Boolean(data.enabled), adFree: Boolean(data.adFree) });
      })
      .catch(() => {
        // Silent: a failed read means "no ad", never a broken result screen —
        // and the host's held action must still be released.
        if (!cancelled) settle(false);
      });
    return () => {
      cancelled = true;
    };
  }, [settle]);

  // Answered "no": tell the host so the exit action it is holding can run.
  useEffect(() => {
    if (!surface) return;
    if (!surface.enabled || surface.adFree) settle(false);
  }, [surface, settle]);

  useEffect(() => {
    if (!resolvedId) settle(false);
  }, [resolvedId, settle]);

  if (!surface || !surface.enabled || surface.adFree || !resolvedId) return null;

  return (
    <PostMatchVideoAd
      matchEnded
      matchId={resolvedId}
      enabled={surface.enabled}
      adFree={surface.adFree}
      onDismiss={() => settle(true)}
      onNoOffer={() => settle(false)}
    />
  );
}
