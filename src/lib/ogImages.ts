import { getSiteUrl } from "./siteUrl";

// Open Graph image URLs must be absolute — social crawlers fetch the image
// directly, so a relative path like "/images/smalllogo1.png" would 404 for
// them.
//
// The origin comes from lib/siteUrl.ts, which ignores a retired host in the
// configured env var. That matters here more than anywhere: og:image is the
// field a social platform fetches to draw the card, so a stale origin makes it
// request the image from a host that no longer exists and show a blank image —
// while the tag itself still looks correct in the page source.
export const OG_BASE_URL = getSiteUrl();

/**
 * Absolute base URL for the production site — same value as metadataBase in
 * src/app/layout.tsx. Used by pages that need the full canonical origin.
 */
export const SITE_URL = OG_BASE_URL;

/** Absolute URL for a public OG image path (e.g. "/images/smalllogo1.png"). */
export const ogImageUrl = (path: string) => `${OG_BASE_URL}${path}`;
