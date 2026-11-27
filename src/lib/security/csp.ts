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
//   ExoClick              a.magsrv.com (the loader). The creative iframe and
//                         measurement hosts are account/zone-specific and are
//                         NOT guessed here; an operator adds the exact origins
//                         the dashboard reports through ADS_CREATIVE_HOSTS.
//   Adcash                acscdn.com (the aclib library) plus adcash.com (the
//                         display creative frame), both exact. The library URL
//                         itself is configuration, never a default here. Any
//                         other account-specific host is supplied through
//                         ADS_CREATIVE_HOSTS, never a wildcard.
//   Trustpilot            widget(s).trustpilot.com (the TrustBox bootstrap);
//   CrazyGames            sdk.crazygames.com (the portal bridge, /play only).
//
// If a new third-party script is added, its host goes here — not back to
// `https:`. tests/csp-ads.test.mjs fails if the wildcard returns.

import { createHash } from "node:crypto";

import { HILLTOPS_VAST_TAG } from "../vast/config";
import { ADEXCHANGE_VAST_TAG } from "../vast/providers/config";

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
  "https://a.magsrv.com",
  "https://acscdn.com",
  "https://adcash.com",
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
  "https://a.magsrv.com",
  "https://acscdn.com",
  "https://adcash.com",
  // Adcash DISPLAY delivery, observed in the browser on 2026-11-27: aclib.js
  // loads banner.js, which fetches the zone's creative JSON from
  // rapidadexchange.com and sends its heartbeat to usrpubtrck.com. Both are
  // exact Adcash-family hosts (the VAST from the account's Ad Exchange tag
  // reports `AdSystem: Adcash`), never a wildcard.
  "https://rapidadexchange.com",
  "https://usrpubtrck.com",
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
 * Parse an operator-supplied CSP host allowlist.
 *
 * One or more comma/whitespace separated EXACT https origins. Paths, queries,
 * fragments, credentials, wildcards and non-https values are refused. This is
 * deliberately an allowlist of origins, never a scheme: a provider whose
 * creative/tracking CDN is only known from the publisher dashboard is added
 * here by the operator, not guessed in code.
 */
export function parseHttpsOriginAllowlist(
  value: string | null | undefined,
): string[] {
  const origins: string[] = [];
  const seen = new Set<string>();

  for (const raw of (value ?? "").split(/[,\s]+/)) {
    if (!raw || origins.length >= 16) continue;
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }
    if (url.protocol !== "https:") continue;
    if (url.hostname.includes("*")) continue;
    if (url.username || url.password) continue;
    if (url.pathname !== "/" || url.search || url.hash) continue;
    if (seen.has(url.origin)) continue;
    seen.add(url.origin);
    origins.push(url.origin);
  }

  return origins;
}

/**
 * Exact, code-known iframe hosts. Provider wildcards used to sit here; they are
 * gone. Account-specific creative hosts come from ADS_CREATIVE_HOSTS.
 */
const FRAME_HOSTS = [
  "https://challenges.cloudflare.com",
  "https://*.clerk.com",
  "https://*.clerk.accounts.dev",
  "https://js.stripe.com",
  "https://checkout.stripe.com",
  "https://*.stripe.com",
  "https://*.googlesyndication.com",
  "https://*.doubleclick.net",
  "https://*.google.com",
  "https://fundingchoicesmessages.google.com",
  "https://*.adtrafficquality.google",
  "https://juvenilechoice.com",
  "https://a.magsrv.com",
  "https://acscdn.com",
  "https://adcash.com",
  "https://widget.trustpilot.com",
  "https://widgets.trustpilot.com",
] as const;

/**
 * Exact, code-known image hosts. This replaces the old `https:` blanket: app
 * images, ad pixels and the badge image are named, and any account-specific
 * creative pixel host is supplied through ADS_CREATIVE_HOSTS.
 */
const IMAGE_HOSTS = [
  "https://pagead2.googlesyndication.com",
  "https://*.googlesyndication.com",
  "https://*.doubleclick.net",
  "https://*.google.com",
  "https://*.googleadservices.com",
  "https://*.adtrafficquality.google",
  "https://*.googleusercontent.com",
  "https://img.clerk.com",
  "https://images.clerk.dev",
  "https://*.posthog.com",
  "https://widget.trustpilot.com",
  "https://widgets.trustpilot.com",
  "https://api.producthunt.com",
  "https://juvenilechoice.com",
  "https://a.magsrv.com",
  "https://acscdn.com",
  "https://adcash.com",
  // Adcash display: the creative image is served from crcdn.org and its
  // impression pixel is fired on rapidadexchange.com (both observed in a real
  // zone response on 2026-11-27).
  "https://crcdn.org",
  "https://rapidadexchange.com",
  // Observed in the approved HilltopAds VAST response (2026-11-27): the tag,
  // impression/error beacons and click-through are on rude-movie.com; the
  // progressive MP4/WebM files are on www.dismal-library.pro. Both are exact.
  "https://rude-movie.com",
  "https://www.dismal-library.pro",
  // Ad Exchange (youradexchange.com) — the post-match tag host. Its impression
  // and error beacons are read as images; a creative served from another CDN is
  // added through ADS_CREATIVE_HOSTS rather than guessed here.
  "https://youradexchange.com",
] as const;

/** Build the `frame-src` directive from exact hosts only. */
export function buildFrameSrc({
  development = false,
  env = process.env,
}: {
  development?: boolean;
  env?: NodeJS.ProcessEnv;
} = {}): string {
  const parts = [
    "'self'",
    ...FRAME_HOSTS,
    ...parseHttpsOriginAllowlist(env.ADS_CREATIVE_HOSTS),
  ];
  if (development) parts.push("http://juvenilechoice.com");
  return `frame-src ${parts.join(" ")}`;
}

/** Build the `img-src` directive from exact hosts only. */
export function buildImgSrc({
  publishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
  env = process.env,
}: {
  publishableKey?: string | null;
  env?: NodeJS.ProcessEnv;
} = {}): string {
  const parts = [
    "'self'",
    "data:",
    "blob:",
    ...IMAGE_HOSTS,
    ...parseHttpsOriginAllowlist(env.ADS_CREATIVE_HOSTS),
  ];

  const supabase = httpsOrigin(env.NEXT_PUBLIC_SUPABASE_URL);
  if (supabase) parts.push(supabase);

  const clerkHost = clerkFrontendApiHost(publishableKey);
  if (clerkHost) parts.push(`https://${clerkHost}`);

  return `img-src ${parts.join(" ")}`;
}

/**
 * Build the `media-src` directive from exact hosts only.
 *
 * The approved Hilltop tag's origin is known from code. ExoClick/Adcash tag
 * origins are included only when their configured tags exist. The CDN a VAST
 * MediaFile ultimately redirects to is account-specific and cannot be derived;
 * an operator whose creative is served elsewhere adds that exact origin through
 * ADS_MEDIA_HOSTS. Until they do, the browser blocks the media and the player
 * fails closed instead of allowing every https host to serve video.
 */
export function buildMediaSrc({
  env = process.env,
}: {
  env?: NodeJS.ProcessEnv;
} = {}): string {
  const parts = [
    "'self'",
    "blob:",
    "https://www.dismal-library.pro",
    // Observed in the account's Ad Exchange VAST response (2026-11-27): the
    // progressive H.264 files are served from vidwestxyz.com.
    "https://vidwestxyz.com",
  ];

  const hilltopTag = httpsOrigin(env.NEXT_PUBLIC_HILLTOPS_VAST_URL) ?? httpsOrigin(HILLTOPS_VAST_TAG);
  if (hilltopTag) parts.push(hilltopTag);

  // The Ad Exchange tag is known from code and enabled by default, so its exact
  // origin belongs in the policy without an operator step.
  const adexchangeTag =
    httpsOrigin(env.NEXT_PUBLIC_ADEXCHANGE_VAST_TAG) ?? httpsOrigin(ADEXCHANGE_VAST_TAG);
  if (adexchangeTag) parts.push(adexchangeTag);

  for (const key of [
    "NEXT_PUBLIC_EXOCLICK_VAST_TAG",
    "NEXT_PUBLIC_ADCASH_VAST_TAG",
  ] as const) {
    const origin = httpsOrigin(env[key]);
    if (origin) parts.push(origin);
  }

  parts.push(
    ...parseHttpsOriginAllowlist(env.ADS_CREATIVE_HOSTS),
    ...parseHttpsOriginAllowlist(env.ADS_MEDIA_HOSTS),
  );

  return `media-src ${[...new Set(parts)].join(" ")}`;
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
  env = process.env,
}: {
  development?: boolean;
  publishableKey?: string | null;
  extraHosts?: string;
  nonce?: string | null;
  hashes?: readonly string[];
  env?: NodeJS.ProcessEnv;
} = {}): string {
  const hosts: string[] = [
    ...THIRD_PARTY_SCRIPT_HOSTS,
    ...parseHttpsOriginAllowlist(env.ADS_CREATIVE_HOSTS),
  ];

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

  // The post-match VAST document is fetched by the browser, so its tag origin
  // must be a connect-src source. The approved Hilltop origin is known from
  // code; the other two only when their configured tags exist.
  const hilltopTag =
    httpsOrigin(env.NEXT_PUBLIC_HILLTOPS_VAST_URL) ?? httpsOrigin(HILLTOPS_VAST_TAG);
  if (hilltopTag) parts.push(hilltopTag);

  const adexchangeTag =
    httpsOrigin(env.NEXT_PUBLIC_ADEXCHANGE_VAST_TAG) ?? httpsOrigin(ADEXCHANGE_VAST_TAG);
  if (adexchangeTag) parts.push(adexchangeTag);

  for (const key of [
    "NEXT_PUBLIC_EXOCLICK_VAST_TAG",
    "NEXT_PUBLIC_ADCASH_VAST_TAG",
  ] as const) {
    const origin = httpsOrigin(env[key]);
    if (origin) parts.push(origin);
  }

  const clerkHost = clerkFrontendApiHost(publishableKey);
  if (clerkHost) parts.push(`https://${clerkHost}`);

  parts.push(
    ...THIRD_PARTY_CONNECT_HOSTS,
    ...parseHttpsOriginAllowlist(env.ADS_CREATIVE_HOSTS),
  );

  // `next dev` talks to its own HMR socket over ws:// on the same host, and a
  // local Supabase/PostHog can be plain http. Neither exists in production.
  if (development) parts.push("http:", "ws:", "wss:");

  return `connect-src ${parts.join(" ")}`;
}
