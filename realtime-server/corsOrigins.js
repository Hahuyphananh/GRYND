// realtime-server/corsOrigins.js
//
// The browser's Origin for this app can be either the apex or the www host
// (`https://grynd.dedyn.io` and `https://www.grynd.dedyn.io`), depending on the
// link a player followed. CORS treats those as DIFFERENT origins, so an
// allow-list built from a single `CLIENT_URL` entry rejects the other one with
// "No 'Access-Control-Allow-Origin' header is present" — and the Socket.IO
// handshake then fails even though both hosts serve the same app.
//
// Every configured origin therefore also allows its www/apex twin. This module
// is pure (the caller passes `CLIENT_URL`) so the rules can be tested without
// booting the realtime server.

/** Trim and strip one trailing slash. An origin never ends with one. */
function normalizeOrigin(origin) {
  return String(origin || "")
    .trim()
    .replace(/\/$/, "");
}

/**
 * A configured origin plus its www/apex twin.
 *
 * Only real DNS hosts are expanded: `localhost`, IP hosts and non-http(s)
 * values stay exactly as configured, so a development or internal origin never
 * gains a meaningless `www.` alias. A parsed URL is reduced to its origin, so a
 * stray path or trailing slash in the env value cannot stop it matching the
 * `Origin` header.
 */
function originVariants(origin) {
  const normalized = normalizeOrigin(origin);
  if (!normalized) return [];

  let url;
  try {
    url = new URL(normalized);
  } catch {
    return [normalized];
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return [normalized];

  const base = normalizeOrigin(url.origin);
  const host = url.hostname;
  if (
    !host.includes(".") ||
    host === "localhost" ||
    /^\d{1,3}(\.\d{1,3}){3}$/.test(host) ||
    host.includes(":")
  ) {
    return [base];
  }

  const twin = new URL(base);
  twin.hostname = host.startsWith("www.") ? host.slice(4) : `www.${host}`;
  return [base, normalizeOrigin(twin.origin)];
}

/**
 * The full allow-list from `CLIENT_URL` (comma-separated), deduplicated.
 *
 * Empty entries are ignored, so an unset variable yields an empty list and the
 * server's existing fail-closed boot check still applies.
 */
function parseAllowedOrigins(value) {
  return [
    ...new Set(
      String(value || "")
        .split(",")
        .flatMap(originVariants)
        .filter(Boolean),
    ),
  ];
}

module.exports = { normalizeOrigin, originVariants, parseAllowedOrigins };
