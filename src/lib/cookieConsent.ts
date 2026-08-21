export const COOKIE_CONSENT_KEY = "goonbet_cookie_consent";

export type CookieConsent = "accepted" | "declined";

/** Returns the stored consent choice, or null if the visitor hasn't decided yet. */
export function getCookieConsent(): CookieConsent | null {
  if (typeof window === "undefined") return null;
  try {
    const value = window.localStorage.getItem(COOKIE_CONSENT_KEY);
    return value === "accepted" || value === "declined" ? value : null;
  } catch {
    // localStorage unavailable (private mode, blocked storage) — treat as undecided.
    return null;
  }
}

/** Records the visitor's consent choice. */
export function setCookieConsent(value: CookieConsent): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(COOKIE_CONSENT_KEY, value);
  } catch {
    // Storage unavailable — the banner will simply reappear next visit.
  }
}
