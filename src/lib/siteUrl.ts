// The one place that decides the site's public origin.
//
// Every absolute URL the app emits — og:image / twitter:image, canonical tags,
// JSON-LD @id, the sitemap, links inside emails — is built from this value, so
// getting it wrong breaks all of them at once.
//
// The failure this guards against: `NEXT_PUBLIC_*` values are inlined into the
// bundle at BUILD time, so an env var left over from before the domain move
// (grynd.mywire.org → grynd.dedyn.io) keeps producing absolute URLs on the
// retired host long after the code's fallback was corrected. Social crawlers
// then fetch og:image from a host that 404s it and render a blank card — the
// meta tag looks perfectly correct, which is what makes it hard to spot.

/** The production origin, used whenever nothing usable is configured. */
export const CANONICAL_SITE_URL = "https://grynd.dedyn.io";

// Hostnames that no longer serve this app. A configured base URL pointing at
// one of these is ignored (a retired host 404s the assets it is asked for).
// Add a host here the day it is retired.
const RETIRED_HOSTNAMES: readonly string[] = [
  "grynd.mywire.org",
  "casino-app-sandy.vercel.app",
  "casino-app-2wnk.onrender.com",
  "casino-app-9ajh.onrender.com",
];

/** www and apex are the same site, and ports never matter to us. */
const comparableHost = (hostname: string) => hostname.toLowerCase().replace(/^www\./, "");

function isRetiredHost(host: string): boolean {
  return RETIRED_HOSTNAMES.some(
    (retired) => host === retired || host.endsWith(`.${retired}`)
  );
}

/**
 * A configured value reduced to a usable absolute origin, or null when it is
 * missing, malformed, not http(s), or points at a retired host.
 *
 * The protocol is kept and only a trailing slash and any path are dropped, so
 * a correct configuration is passed through unchanged. The `www.` prefix is the
 * one exception, and it is collapsed later in getSiteUrl() rather than here:
 * `www.` and apex are the same site, and emitting both splits canonical URLs
 * from the sitemap and JSON-LD across two hostnames.
 */
function normalizeConfigured(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    const host = comparableHost(url.hostname);
    if (!host || isRetiredHost(host)) return null;
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

/**
 * Absolute origin for the public site (no trailing slash).
 *
 * A configured `NEXT_PUBLIC_BASE_URL` / `NEXT_PUBLIC_APP_URL` wins, unless it
 * is empty, malformed, or points at a retired host — in which case the
 * canonical origin is used instead, so a stale env var can never emit a dead
 * og:image or canonical URL again.
 */
export function getSiteUrl(): string {
  const configured =
    normalizeConfigured(process.env.NEXT_PUBLIC_BASE_URL) ??
    normalizeConfigured(process.env.NEXT_PUBLIC_APP_URL);

  // www and apex serve the same site, so a `www.` prefix in configuration is
  // collapsed onto the canonical apex origin. Without this, one deployment can
  // emit canonical/og:url on www while robots.txt and the JSON-LD advertise the
  // apex, splitting the site across two hostnames that Google indexes
  // separately. (A retired host never reaches here — normalizeConfigured
  // already rejected it.)
  if (
    configured &&
    comparableHost(new URL(configured).hostname) ===
      comparableHost(new URL(CANONICAL_SITE_URL).hostname)
  ) {
    return CANONICAL_SITE_URL;
  }

  return configured ?? CANONICAL_SITE_URL;
}
