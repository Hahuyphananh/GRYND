// src/lib/portal/home.ts
//
// PURE rules for the "keep playing on GRYND" button that a finished portal
// match offers.
//
// ── WHAT THIS IS, AND THE TENSION IN IT ───────────────────────────────────
//
// A portal visitor who just finished a practice match is the warmest visitor we
// ever get: they have played, they liked it enough to finish, and they have no
// account. Sending them to the main site is the one conversion a portal surface
// can offer — it is also the thing portal rules most dislike.
//
// Poki in particular forbids external account systems and outbound links in a
// submitted build, and reviews for it. So this button is:
//
//   · OPT-IN PER PORTAL — `PORTAL_HOME_PORTALS` names who gets it, and it holds
//     one slug today;
//   · not a redirect chain or a popup: one <a> to one URL, opened in a new tab
//     with `rel="noopener noreferrer"`, which the player has to press;
//   · never a claim of an account — the destination is the public home page,
//     not a sign-up funnel with a guest id in the query string.
//
// If a portal rejects it, removing its slug here removes the button everywhere;
// nothing else has to change.
//
// The URL is a constant with no query string of its own, so the only parameters
// that ever reach the site are the ones this module adds — and they are campaign
// labels, never identifiers.

import type { PortalSlug } from "./catalog";

/** The public GRYND site the button points at. */
export const PORTAL_HOME_ORIGIN = "https://grynd.dedyn.io";

/**
 * Portals that offer the button. Poki only, for now: it is the portalled target
 * the product wants, and itch/CrazyGames visits already keep a visible route
 * back through the game's own end card.
 */
export const PORTAL_HOME_PORTALS: readonly PortalSlug[] = ["poki"];

/** True when this portal's finished matches offer the home button. */
export function offersPortalHome(portal: unknown): boolean {
  return (
    typeof portal === "string" &&
    (PORTAL_HOME_PORTALS as readonly string[]).includes(portal.toLowerCase())
  );
}

/**
 * Where the button goes: the site home with two campaign labels so the traffic
 * is attributable in analytics. No guest id, no match id, no token — nothing
 * that could identify a player or a portal session.
 */
export function portalHomeHref(portal: string): string | null {
  if (!offersPortalHome(portal)) return null;
  const url = new URL(PORTAL_HOME_ORIGIN);
  url.searchParams.set("utm_source", portal.toLowerCase());
  url.searchParams.set("utm_medium", "portal");
  return url.toString();
}
