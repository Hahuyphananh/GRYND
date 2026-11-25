/**
 * src/lib/proWidget.ts
 *
 * WHERE the floating GRYND PRO card may appear, and whether it was dismissed.
 *
 * The card itself is `components/GryndProWidget.tsx`; this module owns the two
 * decisions that must stay testable without a browser and identical everywhere:
 *
 *   1. ROUTE ELIGIBILITY. The widget is a pointer to the offer, so it belongs on
 *      browsing surfaces, never in front of a live board, a match, the upgrade
 *      page it points at, or a sign-in form.
 *   2. DISMISSAL. A visitor who closes it should not be asked again during the
 *      same browsing session — sessionStorage, not localStorage, so the next
 *      visit starts clean.
 */

export const PRO_WIDGET_DISMISS_KEY = "grynd.proWidget.dismissed.v1";

/** Pages where the card must never appear, matched exactly. */
const HIDDEN_EXACT = new Set([
  "/upgrade-pro",
  "/solitaire",
  "/daily",
  "/settings",
  "/sign-in",
  "/sign-up",
  "/sign-in/sso-callback",
  "/sign-up/sso-callback",
]);

/**
 * Gameplay routes:
 *   /games/<slug>/play      — the rewritten app entry for a live board,
 *   /casino/<game>/<...>    — a match, a practice bout or a bot picker. The
 *                             bare /casino and /casino/<game> lobbies stay
 *                             eligible; only the third segment is gameplay.
 */
const GAMEPLAY_GAMES_PLAY = /^\/games\/[^/]+\/play(?:\/|$)/;
const GAMEPLAY_CASINO_MATCH = /^\/casino\/[^/]+\/[^/]+/;

export function shouldShowProWidget(pathname: string | null | undefined): boolean {
  const path = (pathname ?? "/").split("?")[0].split("#")[0] || "/";
  if (HIDDEN_EXACT.has(path)) return false;
  // Any /upgrade-pro sub-route (e.g. a checkout return) is still the offer page.
  if (path === "/upgrade-pro" || path.startsWith("/upgrade-pro/")) return false;
  // The portal surface (/play/<gameKey>) renders the game and nothing else.
  if (path === "/play" || path.startsWith("/play/")) return false;
  if (GAMEPLAY_GAMES_PLAY.test(path)) return false;
  if (GAMEPLAY_CASINO_MATCH.test(path)) return false;
  // Onboarding is a focused flow with its own next/back controls.
  if (path === "/welcome" || path.startsWith("/welcome/")) return false;
  return true;
}

/** Has this browsing session already closed the card? */
export function isProWidgetDismissed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.sessionStorage.getItem(PRO_WIDGET_DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

/** Close it for the rest of this browsing session. */
export function dismissProWidget(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(PRO_WIDGET_DISMISS_KEY, "1");
  } catch {
    // Storage unavailable: the component still hides for this mount.
  }
}
