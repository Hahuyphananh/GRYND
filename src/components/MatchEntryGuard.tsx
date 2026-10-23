"use client";

// src/components/MatchEntryGuard.tsx
//
// Match entries that happen by CLICKING A LINK. Next's <Link> is a client-side
// navigation, so a link from a page that has loaded ad code (the profile's
// private-room "Open the match", for instance) would leave that ad code running
// over the board. On such a document the click is turned into a document
// navigation to the same URL — the fresh document carries no ad code.
//
// The other half of the rule is hooks/useMatchRouter, which does the same for
// programmatic `router.push` / `router.replace` in the lobbies. Both read the
// decision from lib/matchNavigation.ts and the flag components/AdCodeMarker
// sets, so they cannot disagree.
//
// It does nothing at all on a document without ad code: GRYND PRO members, and
// anyone who opened a match directly, keep the normal client-side navigation.

import { useEffect } from "react";
import { hasAdCodeLoaded, isMatchHref } from "../lib/matchNavigation";

export default function MatchEntryGuard() {
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      // Only a plain left click on a real link — modified clicks open tabs and
      // must keep their browser behaviour.
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest("a[href]");
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if (anchor.target && anchor.target !== "_self") return;
      if (anchor.hasAttribute("download")) return;

      if (!isMatchHref(anchor.getAttribute("href") ?? "")) return;
      if (!hasAdCodeLoaded()) return;

      // Stop Next's <Link> handler and leave the document instead.
      event.preventDefault();
      event.stopPropagation();
      window.location.assign(anchor.href);
    };

    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);

  return null;
}
