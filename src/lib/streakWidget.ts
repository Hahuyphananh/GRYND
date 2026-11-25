/**
 * src/lib/streakWidget.ts
 *
 * Whether the home-page daily STREAK card was closed by this visitor.
 *
 * The card itself is `components/StreakWidget.tsx`. Closing it hides the card
 * for the rest of the browsing session (sessionStorage, exactly like the
 * floating GRYND PRO card in lib/proWidget.ts) and it comes back on the next
 * visit. `/rewards` remains the always-reachable place to see every milestone.
 */

export const STREAK_WIDGET_DISMISS_KEY = "grynd.streakWidget.dismissed.v1";

/** Has this browsing session already closed the streak card? */
export function isStreakWidgetDismissed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.sessionStorage.getItem(STREAK_WIDGET_DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

/** Close it for the rest of this browsing session. */
export function dismissStreakWidget(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(STREAK_WIDGET_DISMISS_KEY, "1");
  } catch {
    // Storage unavailable: the component still hides for this mount.
  }
}
