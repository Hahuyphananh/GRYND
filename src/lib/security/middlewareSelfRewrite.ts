// src/lib/security/middlewareSelfRewrite.ts
//
// Keep a middleware self-rewrite from being proxied back into this same server.
//
// ── WHY THIS EXISTS ────────────────────────────────────────────────────────
// Clerk's middleware decorates every request it processes: it copies the
// caller's headers into `x-middleware-request-*` / `x-middleware-override-headers`
// and then hands the render an `x-middleware-rewrite` pointing at the SAME url to
// make Next apply them (see `decorateRequest` in @clerk/nextjs: on a resume it
// does `rewriteURL = new URL(req.url)`).
//
// That is harmless when Next resolves it internally. This app runs `src/proxy.ts`
// on the NODE runtime (it imports `pg`, which cannot load on Edge), and the Node
// router decides "internal or external?" by comparing the rewrite URL's origin
// with its own `initUrl` — built from the SERVER'S BIND HOSTNAME, not from the
// rewrite (server/lib/router-utils/resolve-routes.js:117):
//
//   next start -p 3000            → initUrl = http://localhost:3000/page
//   next start -H 127.0.0.1 …     → initUrl = http://127.0.0.1:3000/page
//
// Meanwhile `NextURL` rewrites every loopback hostname to `localhost`
// (server/web/uri.js, `p()`), so the header Next finally reads is always
// `http://localhost:3000/page`. Behind a reverse proxy the app is bound to
// 127.0.0.1, the origins therefore NEVER match, Next returns `finished: true`
// and proxies the request to itself with httpxy — which runs the proxy again,
// which rewrites to itself again. Nothing is ever written: the browser waits
// until `proxyTimeout` (30s), the socket is hung up, the request ends as a 500
// "Internal Server Error", and the journal fills with
// `MaxListenersExceededWarning: … close listeners added to [ServerResponse]`
// from each abandoned pass. The loop also re-runs the rate limiter once per
// pass, which is why a first `/api/health` could answer 429.
//
// ── WHAT IT DOES ───────────────────────────────────────────────────────────
// When the rewrite targets the request's OWN path and query on this app, drop
// it and set `x-middleware-next: 1` instead — i.e. "continue to the page, with
// these headers". Clerk's decorations are applied by Next BEFORE either header
// is consulted, so `auth()` in RSC sees exactly what it saw before. This is a
// no-op for routing (the path is identical), so it cannot change which page
// renders; it only stops Next from dialling itself.
//
// ── WHAT IT DELIBERATELY DOES NOT DO ───────────────────────────────────────
// A rewrite that changes the path is left exactly as it is. It cannot be
// rewritten to a relative value: `adapter.js` re-parses the header with
// `new NextURL(value)` and Node's `URL` throws `ERR_INVALID_URL` on a relative
// input, so a "cleaned" value turns a working rewrite into an instant 500. It
// cannot be pointed at the bind address either, because the proxy has no way to
// learn `initUrl`. Any rewrite to a genuine external host (Clerk's FAPI
// handshake, Sentry's tunnel, the PostHog ingestion rewrite) is likewise left
// untouched, so real proxying still works.

/** Hostnames Next (and a local deployment) use for this same process. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Turn a same-path middleware self-rewrite into an internal continuation.
 *
 * Returns true when the header was normalised, false when there was nothing
 * safe to do (no rewrite, a cross-path rewrite, or a rewrite to a real external
 * host). Mutating the response's `Headers` is intentional: it is the same
 * object Next reads afterwards.
 */
export function internalizeMiddlewareSelfRewrite(
  headers: Headers,
  requestUrl: string,
): boolean {
  const rewrite = headers.get("x-middleware-rewrite");
  if (!rewrite) return false;

  let target: URL;
  let self: URL;
  try {
    target = new URL(rewrite);
    self = new URL(requestUrl);
  } catch {
    // A malformed or already-relative rewrite needs no help; leave it alone.
    return false;
  }

  const isSelf = target.origin === self.origin || LOOPBACK_HOSTS.has(target.hostname);
  if (!isSelf) return false;

  // Only the identity rewrite (Clerk decorating the request it was given) is
  // safe to drop: same path AND same query means "render exactly this request",
  // so removing the rewrite cannot change the destination.
  if (`${target.pathname}${target.search}` !== `${self.pathname}${self.search}`) {
    return false;
  }

  headers.delete("x-middleware-rewrite");
  // Without this Next answers the request with a client-side refresh
  // (`x-middleware-refresh`) instead of rendering the page.
  headers.set("x-middleware-next", "1");
  return true;
}
