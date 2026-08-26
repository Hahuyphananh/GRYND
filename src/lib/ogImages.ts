// Open Graph image URLs must be absolute — social crawlers fetch the image
// directly, so a relative path like "/og-image.png" would 404 for them.
// Trailing slashes from env vars are stripped so a value like
// "https://www.grynd.mywire.org/" never produces "//og-image.png" URLs.
export const OG_BASE_URL = (
  process.env.NEXT_PUBLIC_BASE_URL ??
  process.env.NEXT_PUBLIC_APP_URL ??
  "https://www.grynd.mywire.org"
).replace(/\/+$/, "");

/** Absolute URL for a public OG image path (e.g. "/og-image.png"). */
export const ogImageUrl = (path: string) => `${OG_BASE_URL}${path}`;
