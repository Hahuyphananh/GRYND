// src/lib/matchNavigation.ts
//
// WHEN A MATCH ENTRY MUST BE A DOCUMENT NAVIGATION, AND WHEN IT CAN STAY CLIENT-SIDE.
//
// The ad loader (components/AdSenseScript.tsx) is rendered on browsing pages,
// game lobbies included. Its effects are global to the DOCUMENT: the AdSense
// loader is what Auto Ads hook into. A Next.js client-side navigation into a
// match never unloads that document, so ad code a lobby loaded would keep
// running over the board even though the match page's own HTML carries no tag
// at all (the property tests/ad-model.test.mjs pins).
//
// THE RULE. Entering a match is a DOCUMENT navigation whenever this document
// has already loaded ad code: the new document has none, so nothing from the
// lobby can fire during gameplay. When no ad code was loaded — a GRYND PRO
// member's session, or a match opened directly — the entry is an ordinary
// client-side navigation and nothing is slowed down.
//
// WIRING. The loader renders components/AdCodeMarker, which sets the flag
// below; every lobby's router comes from hooks/useMatchRouter, so an entry is
// covered by construction instead of by remembering to call a helper at each
// `router.push`. The lobby/match URL shapes live here, in ONE classifier, so
// the hook and the tests cannot disagree.

/** Window flag set once an ad loader has mounted in this document. */
const AD_CODE_FLAG = "__gryndAdCodeLoaded";

/**
 * True when `href` is a match/board page rather than a browsing surface.
 *
 * A lobby is `/casino/<slug>` or `/games/<slug>/play`; the games hub
 * (`/casino`, `/games`), a game landing page (`/games/<slug>`) and the other
 * browsing pages are not matches. Anything BELOW a lobby is gameplay — the
 * board, an AI/practice table, a per-match sub-page — which is the same
 * route-depth rule the ad tests use, so a route added under a game is treated
 * as gameplay without anybody extending a list.
 */
export function isMatchHref(href: string): boolean {
  if (typeof href !== "string") return false;
  const path = href.split(/[?#]/, 1)[0] ?? "";
  const segments = /^\/(?:casino|games)\/([^/]+)(\/.*)?$/.exec(path);
  if (!segments) return false;
  const rest = (segments[2] ?? "").replace(/\/+$/, "");
  if (!rest) return false;
  // /games/<slug>/play is the LOBBY's rewritten URL — the same page as
  // /casino/<slug>, so it must not be treated as gameplay.
  return rest !== "/play";
}

export type MatchNavigationMode = "document" | "client";

/**
 * `document` when this navigation enters a match in a document that has loaded
 * ad code (the caller must leave the document), `client` otherwise.
 */
export function resolveMatchNavigation(
  href: string,
  adCodeLoaded: boolean,
): MatchNavigationMode {
  return isMatchHref(href) && adCodeLoaded ? "document" : "client";
}

/** Record that ad code is now running in this document. */
export function markAdCodeLoaded(): void {
  if (typeof window === "undefined") return;
  (window as unknown as Record<string, unknown>)[AD_CODE_FLAG] = true;
}

/** True when an ad loader has mounted in this document. */
export function hasAdCodeLoaded(): boolean {
  if (typeof window === "undefined") return false;
  return (window as unknown as Record<string, unknown>)[AD_CODE_FLAG] === true;
}
