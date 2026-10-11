"use client";

import { useEffect } from "react";
import { canonicalRelocationUrl } from "../lib/siteUrl";

/**
 * Moves the page onto the canonical origin (www) when it is running on the
 * apex instead.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * The platform serves the app on www and answers every apex path with a 308 to
 * www. A page can still end up on the apex anyway, because a service worker
 * installed while the app lived there keeps serving the shell from its own
 * cache — and `public/sw.js` even coerces the redirect into a 200 so the shell
 * keeps working. What does not keep working is anything the page WRITES: a
 * POST from the apex is replayed against www, that hop is cross-origin, the
 * reply carries no CORS headers, and `fetch` rejects with
 * `TypeError: Failed to fetch`. So "Create Game" in the pool lobby did nothing
 * while the lobby's cached list of games looked perfectly healthy.
 *
 * A relocation is the fix rather than a fallback request: moving to another
 * origin is a navigation, and the worker's scope covers only the apex, so the
 * browser must finally ask the server — which serves the app on www with
 * same-origin APIs.
 *
 * Renders nothing, and does nothing at all on a host that is not an alias of
 * the canonical one (see canonicalRelocationUrl).
 */
export default function HostCanonicalizer() {
  useEffect(() => {
    const target = canonicalRelocationUrl(window.location.href);
    if (!target) return;

    // A worker that keeps answering from the apex could land a relocation back
    // on the alias; one attempt per origin per session, then stop. Storage can
    // be unavailable (Safari private mode), in which case the relocation still
    // goes ahead — the alternative is leaving the visitor on a host where
    // every write fails, which is strictly worse than a possible extra hop.
    const ATTEMPTED_KEY = "grynd:canonical-relocation";
    try {
      if (window.sessionStorage.getItem(ATTEMPTED_KEY)) return;
      window.sessionStorage.setItem(ATTEMPTED_KEY, "1");
    } catch {
      // No storage: relocate without the loop guard.
    }

    // replace(), not assign(): the alias URL must not become a back-button
    // entry, or Back would bounce the visitor straight back into the broken
    // origin.
    window.location.replace(target);
  }, []);

  return null;
}
