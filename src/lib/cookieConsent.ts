export const COOKIE_CONSENT_KEY = "grynd_cookie_consent";

/** Fired on window whenever the visitor makes a consent choice. */
export const COOKIE_CONSENT_EVENT = "grynd_cookie_consent_change";

/**
 * Fired on window to ask the banner to re-open so the visitor can change or
 * withdraw a choice they already made. Fired by the footer's "Manage cookies"
 * link. Withdrawal has to be as easy as consent (GDPR art. 7(3)), so it cannot
 * require clearing site data by hand.
 */
export const OPEN_CONSENT_BANNER_EVENT = "grynd_open_cookie_banner";

/**
 * Fired on window when Google's CMP reports that its regulations do not apply
 * to this visitor (`gdprApplies: false`) — an EU edge location routing a
 * visitor who is really outside the EEA, and similar proxy cases. Google's
 * message will never appear, so our banner has to stop standing aside.
 */
export const CMP_NOT_APPLICABLE_EVENT = "grynd_cmp_not_applicable";

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
  // Notify listeners (e.g. the sticky mobile CTA hides while the banner is up).
  window.dispatchEvent(new Event(COOKIE_CONSENT_EVENT));
}
