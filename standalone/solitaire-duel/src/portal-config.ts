// standalone/solitaire-duel/src/portal-config.ts
//
// The one place a portal build's behaviour differs. Everything here is resolved
// at BUILD time — there is no runtime environment, no config fetch, no query
// parameter — so a published package behaves identically wherever it is served.
//
// ── THE GRYND CTA ────────────────────────────────────────────────────────
//
// DEFAULT: OFF. A portal package ships with no CTA and no GRYND address in it,
// because most portals either forbid outbound links to an account system or
// forbid promoting another product at all. Enabling it is an explicit,
// per-portal build decision — the itch.io package is the one build that makes
// that decision for itself (`scripts/package-itch-solitaire.mjs`):
//
//   PORTAL_CTA=on PORTAL_CTA_URL=https://www.grynd.dedyn.io/sign-in \
//     npm run build:portal:solitaire
//
// The destination is the production sign-in route (`src/app/sign-in/[[...sign-in]]`,
// allow-listed in `src/proxy.ts`), never a made-up path.
//
// What the CTA may and may not say is fixed by the copy below: it invites the
// player to sign in to GRYND, and it NEVER claims this match — or its result,
// its stats or its progress — was saved, uploaded, recorded or transferred to
// an account. Nothing about the result leaves the browser, and the link is an
// ordinary anchor: it opens only if the player chooses to click it, and "Play
// again" is always available without leaving.
//
// The `typeof` guards are what let this module be imported outside Vite (the
// tests import it): an undeclared identifier is only safe to touch under
// `typeof`, and the short-circuit means the second reference never evaluates.

function ctaFlag(): boolean {
  return typeof __GRYND_CTA_ENABLED__ === "boolean" ? __GRYND_CTA_ENABLED__ : false;
}

function ctaDestination(): string {
  const value = typeof __GRYND_CTA_URL__ === "string" ? __GRYND_CTA_URL__ : "";
  // https only, and never a relative path: a portal package must not point at
  // its own origin by accident.
  return /^https:\/\/[^\s]+$/i.test(value) ? value : "";
}

export type PortalConfig = {
  /** True only when a build explicitly enabled the CTA with a valid URL. */
  ctaEnabled: boolean;
  /** Absolute https destination, or "" when the CTA is off. */
  ctaUrl: string;
  /** The question the CTA asks. No claim about this match being saved. */
  ctaQuestion: string;
  /** The button label. It names the destination and promises nothing more. */
  ctaLabel: string;
};

const DESTINATION = ctaDestination();

export const PORTAL_CONFIG: PortalConfig = Object.freeze({
  ctaEnabled: ctaFlag() && DESTINATION.length > 0,
  ctaUrl: DESTINATION,
  ctaQuestion: "Want to track your stats and compete in ranked games?",
  ctaLabel: "Sign in to GRYND",
});
