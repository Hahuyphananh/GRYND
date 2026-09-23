// src/lib/cmpOwnership.ts
//
// Which prompt owns consent for the visitor currently on the page.
//
// Two prompts exist and only one may be used at a time: Google's certified CMP
// (EEA, UK, Switzerland — Google requires it, and the TCF string it writes is
// what our ad partners read) and our own banner (everywhere else). The decision
// is made on the server from the request's country header and reaches the page
// as a prop, but the "Manage cookies" link in the footer lives in a different
// subtree and has to make the same call at click time — so the CMP-side
// component records it here instead of threading a prop through every page
// that renders a footer.
//
// Module state is per browser tab, which is exactly the scope we want: consent
// is not shared between tabs except through the CMP's own record.

let owned = false;

/** Called by components/CmpConsentBridge.tsx when the CMP is the active prompt. */
export function setCmpOwnsConsent(value: boolean): void {
  owned = value;
}

/**
 * True when reopening consent must go through Google's CMP
 * (`googlefc.showRevocationMessage()`) rather than our own banner.
 */
export function cmpOwnsConsent(): boolean {
  return owned;
}
