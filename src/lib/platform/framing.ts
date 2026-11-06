// src/lib/platform/framing.ts
//
// PURE CSP framing policy for external embeds (Phase 5).
//
// The global policy in src/proxy.ts remains `frame-ancestors 'self'` and
// `X-Frame-Options: SAMEORIGIN`. ONLY responses for `/embed/*` are relaxed, and
// only to the explicit platform allowlist parsed from env. There is no wildcard
// path: with no platform configured, embedded responses keep `'self'` and are
// therefore not framable by anyone.
//
// This module is pure so the policy can be unit-tested without a request and so
// the proxy cannot accidentally hand-roll a second, different string.

import { getPlatformOrigins } from "./config";

/** True for the embed application only — never for the standalone site. */
export function isEmbedPath(pathname: unknown): boolean {
  return (
    typeof pathname === "string" &&
    (pathname === "/embed" || pathname.startsWith("/embed/"))
  );
}

/**
 * `frame-ancestors` value for the given origins. Origins are validated by the
 * config parser (https, no path). With no configured origin the result is
 * `'self'`, which blocks all external framing.
 */
export function buildFrameAncestors(origins: readonly string[]): string {
  const unique = [...new Set(origins.filter((origin) => typeof origin === "string" && origin))];
  if (unique.length === 0) return "'self'";
  // `*` is deliberately never produced, even if an operator wrote it in env.
  return unique.filter((origin) => origin !== "*").join(" ") || "'self'";
}

/** Replace (or append) the frame-ancestors directive in a CSP string. */
export function replaceFrameAncestors(csp: string, ancestors: string): string {
  const directive = `frame-ancestors ${ancestors}`;
  if (/frame-ancestors\s+[^;]+;?/.test(csp)) {
    return csp.replace(/frame-ancestors\s+[^;]+;?/, `${directive};`);
  }
  return `${csp.replace(/;\s*$/, "")}; ${directive};`;
}

type HeaderBag = {
  headers: {
    get(name: string): string | null;
    set(name: string, value: string): void;
    delete(name: string): void;
  };
};

/**
 * Apply the embed framing policy to a response for `pathname`.
 *
 * Standalone responses are untouched. For `/embed/*`:
 *   · `X-Frame-Options` is removed (CSP `frame-ancestors` is the modern control;
 *     leaving SAMEORIGIN would block a legitimate platform frame in browsers
 *     that still honour XFO), and
 *   · `frame-ancestors` is narrowed to the env allowlist;
 *   · the session token travels in the iframe URL, so the response is marked
 *     `no-store` and `no-referrer` to keep it out of shared caches and
 *     third-party Referer headers.
 *
 * Nothing else in the CSP changes, and no header is removed for non-embed paths.
 */
export function applyEmbedFramePolicy(
  response: HeaderBag,
  pathname: unknown,
  env: Record<string, string | undefined> = process.env,
): void {
  if (!isEmbedPath(pathname)) return;

  response.headers.delete("X-Frame-Options");

  const ancestors = buildFrameAncestors(getPlatformOrigins(env));
  const csp = response.headers.get("Content-Security-Policy");
  response.headers.set(
    "Content-Security-Policy",
    csp
      ? replaceFrameAncestors(csp, ancestors)
      : `frame-ancestors ${ancestors};`,
  );

  // The embed URL carries the opaque session token. Never let a shared cache
  // keep it, and never let a subresource request leak it through Referer.
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
}
