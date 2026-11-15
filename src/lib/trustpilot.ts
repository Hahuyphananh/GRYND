// src/lib/trustpilot.ts
//
// Trustpilot configuration — the ONE place the Trustpilot identifiers live.
//
// WHY ENVIRONMENT-BASED
// The business unit id and the TrustBox template id are issued by the Trustpilot
// business account, not by this repository, and they change when the domain is
// re-verified or the widget is re-designed. They therefore come from
// NEXT_PUBLIC_* values (they are public by design — a widget id is visible in
// the page source of every site that embeds one):
//
//   NEXT_PUBLIC_TRUSTPILOT_BUSINESS_UNIT_ID  the business unit being reviewed
//   NEXT_PUBLIC_TRUSTPILOT_TEMPLATE_ID       which TrustBox design to render
//   NEXT_PUBLIC_TRUSTPILOT_DOMAIN            optional; defaults to the site host
//   NEXT_PUBLIC_TRUSTPILOT_ENABLED           "false" removes the whole surface
//
// NOTHING IS FAKED. A missing or malformed id means NO widget and NO review
// call-to-action — never a broken embed, and never a review link pointing at a
// domain that isn't verified on Trustpilot. That is the same rule src/lib/ads.ts
// applies to ad-unit ids.
//
// Client- and server-safe: reads only NEXT_PUBLIC_* values and the site origin,
// so no database, Clerk or Node-only import can leak into a client bundle.

import { getSiteUrl } from "./siteUrl";

/** The TrustBox bootstrap. Trustpilot's own snippet, protocol made explicit. */
export const TRUSTPILOT_SCRIPT_SRC =
  "https://widget.trustpilot.com/bootstrap/v5/tp.widget.bootstrap.min.js";

/**
 * Trustpilot ids are 24 lowercase hex characters. A little tolerance is kept
 * around that length because the format is not formally documented and has
 * grown before; obvious placeholders (all one character, or far too short) are
 * still rejected, so a documentation dummy can never reach the page.
 */
const TRUSTPILOT_ID_PATTERN = /^[0-9a-f]{20,32}$/i;

const DOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

export interface TrustpilotConfig {
  businessUnitId: string;
  templateId: string;
  /** The business domain as registered on Trustpilot, e.g. `www.grynd.dedyn.io`. */
  domain: string;
  /** Public profile page: what visitors read. */
  reviewUrl: string;
  /** Review-collection page: where a visitor writes one. */
  evaluateUrl: string;
}

function normalizeId(value: string | undefined): string | null {
  const trimmed = (value ?? "").trim();
  if (!TRUSTPILOT_ID_PATTERN.test(trimmed)) return null;
  if (/^(.)\1*$/.test(trimmed)) return null; // all-one-character placeholder
  return trimmed.toLowerCase();
}

/** A configured domain reduced to a bare hostname, or null when unusable. */
function normalizeDomain(value: string | undefined): string | null {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return null;
  try {
    const host = new URL(
      trimmed.includes("://") ? trimmed : `https://${trimmed}`
    ).hostname.replace(/\.$/, "").toLowerCase();
    return host && DOMAIN_PATTERN.test(host) ? host : null;
  } catch {
    return null;
  }
}

/** False only when the deploy switched the surface off on purpose. */
export function trustpilotEnabled(): boolean {
  return (
    (process.env.NEXT_PUBLIC_TRUSTPILOT_ENABLED ?? "").trim().toLowerCase() !==
    "false"
  );
}

/**
 * The reviewed domain. Configured value wins; otherwise the canonical site
 * host. This is the domain Trustpilot must have verified — the meta tag in the
 * home page's metadata (src/app/page.jsx) is what proves it.
 */
export function trustpilotDomain(): string | null {
  return (
    normalizeDomain(process.env.NEXT_PUBLIC_TRUSTPILOT_DOMAIN) ??
    normalizeDomain(getSiteUrl())
  );
}

/**
 * Everything the widget and the review CTA need, or null when this deploy has
 * no usable Trustpilot setup (in which case both render nothing at all).
 */
export function getTrustpilotConfig(): TrustpilotConfig | null {
  if (!trustpilotEnabled()) return null;

  const businessUnitId = normalizeId(
    process.env.NEXT_PUBLIC_TRUSTPILOT_BUSINESS_UNIT_ID
  );
  const templateId = normalizeId(process.env.NEXT_PUBLIC_TRUSTPILOT_TEMPLATE_ID);
  const domain = trustpilotDomain();
  if (!businessUnitId || !templateId || !domain) return null;

  return {
    businessUnitId,
    templateId,
    domain,
    reviewUrl: `https://www.trustpilot.com/review/${domain}`,
    evaluateUrl: `https://www.trustpilot.com/evaluate/${domain}`,
  };
}
