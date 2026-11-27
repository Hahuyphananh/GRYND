// src/lib/security/csp.ts
//
// THE policy sources used by the proxy, in one testable place.
//
// WHY: the policy used to end its script-src directive with the bare token
// `https:`. That allows ANY https origin to serve script, so an injected
// <script src="https://attacker.example/x.js"> executed and script-src stopped
// being an injection control at all — the exact thing CSP is for. And
// script-src also carried `'unsafe-inline'`, so an inline `<script>` injected
// into the page ran too.
//
// NOW: script-src is nonce-based. The proxy mints one nonce per request, puts
// it in the request's `Content-Security-Policy` header (Next then stamps its
// own bootstrap/chunk scripts with it) and in the response policy, and every
// hand-authored inline script in the app receives the same nonce from
// `headers().get("x-nonce")`. Host sources stay named individually so a
// third-party `<script src>` still has to be on the list.
//
// Every host below is one this app actually loads, named individually:
//
//   Clerk                 the auth UI bundle (named hosts + the Frontend API
//                         host, which comes from the publishable key);
//   Turnstile             challenges.cloudflare.com;
//   AdSense               pagead2.googlesyndication.com is the loader the
//                         server renders; the ad code it installs pulls
//                         further scripts from the googlesyndication /
//                         doubleclick / google / googleadservices families,
//                         plus Google's certified CMP
//                         (fundingchoicesmessages.google.com) and the
//                         adtrafficquality check;
//   GA4                   www.googletagmanager.com, and only after consent;
//   PostHog               *.posthog.com — posthog-js fetches its surveys,
//                         dead-click, web-vitals and exception modules from
//                         the assets host at runtime (us-assets / eu-assets);
//   HilltopAds            juvenilechoice.com (the banner snippet);
//   Trustpilot            widget(s).trustpilot.com (the TrustBox bootstrap);
//   CrazyGames            sdk.crazygames.com (the portal bridge, /play only).
//
// If a new third-party script is added, its host goes here — not back to
// `https:`. tests/csp-ads.test.mjs fails if the wildcard returns.

import { createHash } from "node:crypto";

/**
 * Origin allowlist for third-party script. Kept as exact CSP source
 * expressions, not URLs, so a path can never sneak in.
 */
export const THIRD_PARTY_SCRIPT_HOSTS = [
  "https://*.clerk.com",
  "https://*.clerk.accounts.dev",
  "https://challenges.cloudflare.com",
  "https://pagead2.googlesyndication.com",
  "https://*.googlesyndication.com",
  "https://*.doubleclick.net",
  "https://*.google.com",
  "https://*.googleadservices.com",
  "https://www.googletagmanager.com",
  // posthog-js loads surveys / autocapture / web-vitals modules from the
  // assets host at runtime; the US and EU deploys use different subdomains.
  "https://*.posthog.com",
  "https://www.googletagservices.com",
  "https://fundingchoicesmessages.google.com",
  "https://*.adtrafficquality.google",
  "https://juvenilechoice.com",
  "https://widget.trustpilot.com",
  "https://widgets.trustpilot.com",
  "https://sdk.crazygames.com",
] as const;

/**
 * Hosts the BROWSER opens connections to (fetch, XHR, WebSocket).
 *
 * This used to be `'self' https: wss:`, which let any injected script
 * exfiltrate to any HTTPS host and made connect-src decorative. It is now the
 * actual list:
 *
 *   - the app itself ('self'), plus blob: for locally generated downloads;
 *   - Supabase (Realtime + PostgREST) and the Socket.IO service — both derived
 *     from the configured env values below, so a deploy never has to edit this
 *     file;
 *   - Clerk (session refresh + FAPI calls), Turnstile;
 *   - Stripe.js (api/checkout/m.stripe.network and Link);
 *   - GA4, Google's ad families and the certified CMP;
 *   - PostHog (directly in development; /ingest same-origin in production);
 *   - Trustpilot, HilltopAds, CrazyGames.
 *
 * Sentry is NOT here on purpose: the client is configured with a tunnel
 * (`tunnelRoute: "/monitoring"`), so its requests go to 'self'.
 */
export const THIRD_PARTY_CONNECT_HOSTS = [
  "https://*.clerk.com",
  "https://*.clerk.accounts.dev",
  "https://challenges.cloudflare.com",
  "https://api.stripe.com",
  "https://*.stripe.com",
  "https://*.link.com",
  "https://www.googletagmanager.com",
  "https://*.google-analytics.com",
  "https://*.analytics.google.com",
  "https://pagead2.googlesyndication.com",
  "https://*.googlesyndication.com",
  "https://*.doubleclick.net",
  "https://*.google.com",
  "https://*.googleadservices.com",
  "https://www.googletagservices.com",
  "https://fundingchoicesmessages.google.com",
  "https://*.adtrafficquality.google",
  "https://*.posthog.com",
  "https://widget.trustpilot.com",
  "https://widgets.trustpilot.com",
  "https://juvenilechoice.com",
  "https://sdk.crazygames.com",
] as const;

/**
 * The Clerk Frontend API host, decoded from the publishable key.
 *
 * Clerk serves its JS from the instance's own Frontend API host, which is
 * either `<slug>.clerk.accounts.dev` (covered by the named hosts above) or a
 * CUSTOM domain like `clerk.example.com`. Removing the `https:` blanket
 * without this would break sign-in on a custom-domain instance, so the host is
 * derived from the key the app is already configured with.
 *
 * `pk_test_<base64>` decodes to `<host>$`. Anything that does not decode to a
 * dotted hostname is ignored (the named hosts still apply).
 */
export function clerkFrontendApiHost(
  publishableKey: string | null | undefined = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
): string | null {
  const key = (publishableKey ?? "").trim();
  // pk_test_… / pk_live_… → the third segment onward is the base64 payload.
  const encoded = key.split("_").slice(2).join("_");
  if (!encoded) return null;

  try {
    const decoded = Buffer.from(
      encoded.replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    )
      .toString("utf8")
      .replace(/\$$/, "")
      .trim();
    const isHostname =
      /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(decoded) && decoded.includes(".");
    return isHostname ? decoded : null;
  } catch {
    return null;
  }
}

// ── Inline-script hashes ───────────────────────────────────────────────────
//
// A nonce only covers inline scripts rendered WITH the request nonce. One
// inline script cannot have it: the GA4 init snippet is rendered by a CLIENT
// component (components/GoogleAnalytics.tsx) after the visitor consents, so
// the element is created in the browser and never sees the server-rendered
// nonce. It is allowed by its exact content hash instead.
//
// The text below must stay byte-identical to the template literal in that
// component; tests/csp-ads.test.mjs fails if the two drift apart.
const GA_INIT_SNIPPET = [
  "window.dataLayer = window.dataLayer || [];",
  "function gtag(){dataLayer.push(arguments);}",
  "gtag('js', new Date());",
  "gtag('config', 'G-PFN3BBLC0E');",
].join("\n");

const GA_INIT_HASH = `'sha256-${createHash("sha256")
  .update(GA_INIT_SNIPPET, "utf8")
  .digest("base64")}'`;

/** CSP source expressions for inline scripts that cannot carry the nonce. */
export function inlineScriptHashes(): readonly string[] {
  return [GA_INIT_HASH];
}

/** `https://host` → `wss://host`; anything else is returned unchanged. */
function toWebSocketOrigin(origin: string): string {
  return origin.startsWith("https://") ? `wss://${origin.slice("https://".length)}` : origin;
}

/** A usable https origin from a configured URL, or null. */
function httpsOrigin(value: string | null | undefined): string | null {
  const raw = (value ?? "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * Build the whole `script-src` directive (without the trailing `;`).
 *
 * `nonce` is the per-request value; when present it is the only way an inline
 * script may run ('unsafe-inline' is deliberately never emitted — browsers
 * ignore it anyway once a nonce is present, and emitting it would re-open the
 * injection path on a request that somehow has no nonce).
 *
 * `extraHosts` carries the development-only http origin for the Hilltop
 * banner; production passes nothing.
 */
export function buildScriptSrc({
  development = false,
  publishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
  extraHosts = "",
  nonce = null,
  hashes = [],
}: {
  development?: boolean;
  publishableKey?: string | null;
  extraHosts?: string;
  nonce?: string | null;
  hashes?: readonly string[];
} = {}): string {
  const hosts: string[] = [...THIRD_PARTY_SCRIPT_HOSTS];

  const clerkHost = clerkFrontendApiHost(publishableKey);
  if (clerkHost) hosts.push(`https://${clerkHost}`);

  const parts = ["'self'"];
  if (nonce) parts.push(`'nonce-${nonce}'`);
  parts.push(...hashes, ...hosts);
  if (development) parts.push("'unsafe-eval'");

  const extra = extraHosts.trim();
  if (extra) parts.push(extra);

  return `script-src ${parts.join(" ")}`;
}

/**
 * Build the whole `connect-src` directive (without the trailing `;`).
 *
 * The Supabase and Socket.IO origins are read from the same env vars the
 * browser client uses, so a deploy points the policy at its own backends
 * without editing code. A missing value simply contributes no source —
 * `'self'` still covers the same-origin paths (/ingest, /monitoring, /api).
 */
export function buildConnectSrc({
  development = false,
  publishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
  env = process.env,
}: {
  development?: boolean;
  publishableKey?: string | null;
  env?: NodeJS.ProcessEnv;
} = {}): string {
  const parts = ["'self'", "blob:"];

  const supabase = httpsOrigin(env.NEXT_PUBLIC_SUPABASE_URL);
  if (supabase) parts.push(supabase, toWebSocketOrigin(supabase));

  const realtime = httpsOrigin(env.NEXT_PUBLIC_SOCKET_URL);
  if (realtime) parts.push(realtime, toWebSocketOrigin(realtime));

  const clerkHost = clerkFrontendApiHost(publishableKey);
  if (clerkHost) parts.push(`https://${clerkHost}`);

  parts.push(...THIRD_PARTY_CONNECT_HOSTS);

  // `next dev` talks to its own HMR socket over ws:// on the same host, and a
  // local Supabase/PostHog can be plain http. Neither exists in production.
  if (development) parts.push("http:", "ws:", "wss:");

  return `connect-src ${parts.join(" ")}`;
}
