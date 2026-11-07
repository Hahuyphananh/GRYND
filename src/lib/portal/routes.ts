// src/lib/portal/routes.ts
//
// PURE link rewriting for the portal surface.
//
// ── THE PROBLEM ───────────────────────────────────────────────────────────
//
// The games navigate with app paths: a practice match opens
// `/casino/<game>/<id>` (or `/casino/odds/game/<id>`), and "back to lobby"
// goes to `/casino/<game>`. Those paths are NOT framable — only `/play/*` is —
// so inside a portal iframe the first navigation left the surface and the frame
// went blank.
//
// ── THE RULE ──────────────────────────────────────────────────────────────
//
// While the current document IS the portal surface for game G, a link to G's
// own lobby or board is rewritten to the mirror under `/play/G`. Nothing else
// is touched: another game's path, a site page, an API route and an external
// URL all pass through unchanged, so this can never silently redirect the app
// outside the portal.
//
// The rewrite is deliberately conservative — it matches G's lobby and ONE
// match segment, the only two shapes the games navigate to. A deeper path is
// left alone rather than flattened onto the lobby, because guessing where the
// player meant to go is worse than a path that is simply not framable.

import { portalGameKeyFromPath } from "./framing";

/** `<scheme>://…`, `//host`, `mailto:`, etc. are never rewritten. */
function isAppPath(href: string): boolean {
  return href.startsWith("/") && !href.startsWith("//");
}

/**
 * Rewrite an app href for the portal surface.
 *
 * On `/play/dominoes`:
 *   /casino/dominoes                → /play/dominoes
 *   /casino/dominoes/abc?x=1        → /play/dominoes/abc?x=1
 *   /games/dominoes                 → /play/dominoes
 *   /casino/odds/game/ai            → unchanged (a different game)
 *   /rewards                        → unchanged
 *
 * On `/play/odds`, additionally:
 *   /casino/odds/game/ai            → /play/odds/ai
 *   /casino/odds/game/42?x=1        → /play/odds/42?x=1
 */
export function portalAwareHref(href: unknown, pathname: unknown): string {
  if (typeof href !== "string" || !isAppPath(href)) {
    return typeof href === "string" ? href : "";
  }

  const gameKey = portalGameKeyFromPath(pathname);
  if (!gameKey) return href;

  // Odds' board lives one segment deeper than every other game's, so its shape
  // is mapped explicitly before the generic rule can see it.
  if (gameKey === "odds") {
    const oddsBoard = /^\/casino\/odds\/game\/([A-Za-z0-9._~-]{1,64})([\s\S]*)$/.exec(href);
    if (oddsBoard) return `/play/odds/${oddsBoard[1]}${oddsBoard[2]}`;
  }

  const lobby = new RegExp(`^/(?:casino|games)/${gameKey}([\\s\\S]*)$`).exec(href);
  if (!lobby) return href;

  const rest = lobby[1] ?? "";
  // Only "" (the lobby, optionally with query/hash) or "/<one segment>".
  if (rest === "" || rest.startsWith("?") || rest.startsWith("#")) {
    return `/play/${gameKey}${rest}`;
  }
  if (!/^\/[A-Za-z0-9._~-]{1,64}(?:[?#][\s\S]*)?$/.test(rest)) return href;

  return `/play/${gameKey}${rest}`;
}

/** The board path for a game inside the portal surface. */
export function portalMatchHref(gameKey: string, matchId: string): string {
  return `/play/${gameKey}/${matchId}`;
}
