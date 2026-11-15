// src/lib/socketUrl.ts
//
// Which host the Socket.IO client dials.
//
// The app is served from both `grynd.dedyn.io` and `www.grynd.dedyn.io`, but a
// socket connection is cross-origin unless it targets the host the page itself
// was loaded from. Dialing the apex from a www page makes the browser send
// `Origin: https://www.grynd.dedyn.io` to the apex host and puts the handshake
// at the mercy of the server's `Access-Control-Allow-Origin` header — the
// failure mode was "No 'Access-Control-Allow-Origin' header is present" and a
// dead realtime connection.
//
// So the configured URL is only a fallback: when it names the www/apex twin of
// the page's own origin, the page's origin wins and the connection is
// same-origin (no preflight, no allow-list to drift, and the session cookie is
// sent to the host that set it). Any other configuration — a separate realtime
// host, localhost, an IP, a custom port, a base path — is returned untouched.
//
// Pure on purpose: no `window` access here, so the rules are unit-testable.

/** Trim, then drop trailing slashes. An origin never ends with one. */
export function normalizeSocketUrl(value: string | null | undefined): string {
  return String(value ?? "")
    .trim()
    .replace(/\/+$/, "");
}

function parseHttpOrigin(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url;
  } catch {
    return null;
  }
}

/** `www.example.com` → `example.com`; everything else unchanged. */
function withoutWww(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, "");
}

/**
 * The socket URL to dial from a page at `pageOrigin`, or `null` when nothing
 * is configured.
 *
 * Returns the page's own origin when the configured host is its www/apex twin
 * with the same protocol, port and (root) path; otherwise the normalized
 * configured URL.
 */
export function resolveSocketUrl(
  configured: string | null | undefined,
  pageOrigin: string | null | undefined,
): string | null {
  const trimmed = normalizeSocketUrl(configured);
  if (!trimmed) return null;

  const socket = parseHttpOrigin(trimmed);
  const page = pageOrigin ? parseHttpOrigin(pageOrigin) : null;
  if (!socket || !page) return trimmed;

  // A trailing path on the configured value is a base path / namespace the
  // caller asked for; rewriting the origin would silently drop it.
  if (socket.pathname !== "/" && socket.pathname !== "") return trimmed;

  // Different protocol or port is a genuinely different endpoint (staging,
  // a dedicated realtime server), not a hostname spelling of the same one.
  if (socket.protocol !== page.protocol) return trimmed;
  if (socket.port !== page.port) return trimmed;

  // Only DNS hosts have a www twin; localhost, IPs and IPv6 do not.
  if (!socket.hostname.includes(".") || socket.hostname === "localhost") {
    return trimmed;
  }

  if (withoutWww(socket.hostname) !== withoutWww(page.hostname)) return trimmed;

  // Same origin as the page: the browser sends no CORS check at all.
  return normalizeSocketUrl(page.origin);
}
