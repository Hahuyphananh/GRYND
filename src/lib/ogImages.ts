// Open Graph image URLs must be absolute — social crawlers fetch the image
// directly, so a relative path like "/images/smalllogo1.png" would 404 for
// them.
// Trailing slashes from env vars are stripped so a value like
// "https://www.grynd.dedyn.io/" never produces "//images/smalllogo1.png"
// URLs.
export const OG_BASE_URL = (
  process.env.NEXT_PUBLIC_BASE_URL ??
  process.env.NEXT_PUBLIC_APP_URL ??
  "https://www.grynd.dedyn.io"
).replace(/\/+$/, "");

/**
 * Absolute base URL for the production site — same value as metadataBase in
 * src/app/layout.tsx. Used by pages that need the full canonical origin.
 */
export const SITE_URL = OG_BASE_URL;

/** Absolute URL for a public OG image path (e.g. "/images/smalllogo1.png"). */
export const ogImageUrl = (path: string) => `${OG_BASE_URL}${path}`;
