// src/lib/security/clientIp.ts
//
// THE client-IP resolver, in one place, with one trust model.
//
// THE BUG THIS EXISTS FOR: the proxy used to return the FIRST entry of
// X-Forwarded-For. A proxy APPENDS the address it actually saw, so the first
// entry is whatever the caller sent. Every IP-keyed control that read it — the
// per-IP API rate limit, the audit log, the admin MFA attempt counter — keyed
// on an attacker-chosen value. Rotating it defeats the limiter; putting a
// victim's address there gets the victim 429'd.
//
// THE RULE: count in from the RIGHT, past the proxies you control. With one
// trusted hop (Vercel or Render) the rightmost entry is the address our edge
// saw, and nobody upstream can forge it. Entries to its left are client-supplied
// and are never read.
//
// `TRUSTED_PROXY_COUNT` describes the deployment, not the request: 1 for
// Vercel/Render, 2 when Cloudflare also sits in front, and never 0.

/** How many proxies we control sit in front of this process (min 1). */
export function trustedProxyCount(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt(env.TRUSTED_PROXY_COUNT || "1", 10);
  return Number.isFinite(raw) && raw >= 1 ? raw : 1;
}

/**
 * Strip a port / IPv6 brackets and reject anything that is not a plain
 * address, so a forged header value cannot become a log-injection or
 * rate-limit-key primitive.
 */
export function normalizeIp(value: string | null | undefined): string | null {
  const raw = (value ?? "").trim();
  if (!raw) return null;

  // IPv4 with a port (`1.2.3.4:51234`) or a bracketed IPv6 with one.
  const withoutPort = /^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(raw)
    ? raw.slice(0, raw.lastIndexOf(":"))
    : raw;
  const bracketed = /^\[([0-9a-f:]+)\](?::\d+)?$/i.exec(withoutPort);
  const candidate = bracketed ? bracketed[1] : withoutPort;

  return /^[0-9a-f:.]+$/i.test(candidate) ? candidate : null;
}

/**
 * The client IP for a request, or "unknown".
 *
 * `cf-connecting-ip` wins when present: Cloudflare's edge writes and
 * overwrites it, so it cannot be spoofed through Cloudflare.
 */
export function clientIpFromHeaders(
  headers: Headers,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const cloudflare = normalizeIp(headers.get("cf-connecting-ip"));
  if (cloudflare) return cloudflare;

  const forwardedFor = headers.get("x-forwarded-for");
  if (forwardedFor) {
    const hops = forwardedFor
      .split(",")
      .map((hop) => hop.trim())
      .filter(Boolean);
    if (hops.length > 0) {
      // The client's address sits exactly `trustedProxyCount` hops in from the
      // right; anything left of it was written by the client.
      const index = Math.max(hops.length - trustedProxyCount(env), 0);
      const ip = normalizeIp(hops[index]);
      if (ip) return ip;
    }
  }

  return normalizeIp(headers.get("x-real-ip")) || "unknown";
}
