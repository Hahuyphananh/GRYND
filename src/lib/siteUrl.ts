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

/**
 * The production origin, used whenever nothing usable is configured.
 *
 * `www.` is deliberate: the platform serves the app on www and answers EVERY
 * path on the apex with a 308 to www (verified: `grynd.dedyn.io/<anything>` →
 * `Location: https://www.grynd.dedyn.io/...`). That makes www the host the app
 * actually runs on, so it is the one canonical URLs may name.
 *
 * The apex cannot be used for this. Two different origins cannot exchange
 * answers through a redirect: a POST issued from a page on the apex is
 * replayed against www, that hop is cross-origin, and the reply carries no CORS
 * headers — so the browser discards it and `fetch` rejects with `TypeError:
 * Failed to fetch`. Reads merely *look* fine, because the service worker's GET
 * routes answer them from cache. Writes have no such fallback: "Create Game"
 * did nothing at all. Keeping every emitted URL on www, and relocating a page
 * that is somehow running on the apex (`canonicalRelocationUrl` below), is what
 * stops a client from ever being on the wrong side of that redirect.
 */
export const CANONICAL_SITE_URL = "https://www.grynd.dedyn.io";

// Hostnames that no longer serve this app. A configured base URL pointing at
// one of these is ignored (a retired host 404s the assets it is asked for).
// Add a host here the day it is retired.
const RETIRED_HOSTNAMES: readonly string[] = [
  "grynd.mywire.org",
  "casino-app-sandy.vercel.app",
  "casino-app-2wnk.onrender.com",
  "casino-app-9ajh.onrender.com",
];

/**
 * www, apex and a trailing root dot (`grynd.dedyn.io.`, which DNS resolves
 * identically but the browser treats as its own origin) are one host; ports
 * never matter to us.
 */
const comparableHost = (hostname: string) =>
  hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");

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

  // www and apex serve the same site, so ANY configuration of the pair is
  // collapsed onto CANONICAL_SITE_URL — including a configured apex, which the
  // platform only 308-redirects. Without this, one deployment can emit
  // canonical/og:url on one host while robots.txt and the JSON-LD advertise the
  // other, splitting the site across two hostnames that Google indexes
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

/**
 * The canonical URL for `href` when the page is running on a non-canonical
 * alias of the canonical origin (the apex, while www serves), or null when it
 * is already where it belongs.
 *
 * The client runs this on every page load (src/components/HostCanonicalizer)
 * because a stale service worker can keep serving the app shell from the apex
 * long after the platform started redirecting it: the page then loads, its GETs
 * are answered from the worker's cache, and every write it makes dies on the
 * cross-origin hop. A relocation is the only way out — the target is a
 * different origin, so the worker's scope does not cover it and the browser
 * has to ask the server, which serves the real app.
 *
 * Deliberately narrow: it fires ONLY for the configured canonical host, in a
 * different form (apex ↔ www). A preview deployment, a tunnel, an alias a
 * developer points at their laptop, or an unrelated host is left alone.
 */
export function canonicalRelocationUrl(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;

  const target = new URL(CANONICAL_SITE_URL);
  // Same host in a different form (apex vs www) — never a different site.
  if (comparableHost(url.hostname) !== comparableHost(target.hostname)) {
    return null;
  }
  // Already on the canonical origin: nothing to do, and this is what keeps the
  // relocation from looping once it has happened.
  if (url.host === target.host && url.protocol === target.protocol) return null;

  // Path, query and hash are preserved: the visitor asked for a page, not for
  // the front door.
  url.protocol = target.protocol;
  url.host = target.host;
  return url.toString();
}
