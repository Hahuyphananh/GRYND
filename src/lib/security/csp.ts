// src/lib/security/csp.ts
//
// THE script-src allowlist, in one testable place.
//
// WHY: the policy used to end its script-src directive with the bare token
// `https:`. That allows ANY https origin to serve script, so an injected
// <script src="https://attacker.example/x.js"> executed and script-src stopped
// being an injection control at all — the exact thing CSP is for.
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

/**
 * Build the whole `script-src` directive (without the trailing `;`).
 *
 * `extraHosts` carries the development-only http origin for the Hilltop
 * banner; production passes nothing.
 */
export function buildScriptSrc({
  development = false,
  publishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
  extraHosts = "",
}: {
  development?: boolean;
  publishableKey?: string | null;
  extraHosts?: string;
} = {}): string {
  const hosts: string[] = [...THIRD_PARTY_SCRIPT_HOSTS];

  const clerkHost = clerkFrontendApiHost(publishableKey);
  if (clerkHost) hosts.push(`https://${clerkHost}`);

  // Order matters only for readability: 'self' and 'unsafe-inline' first, then
  // the named origins, then the dev-only escape hatch.
  const parts = ["'self'", "'unsafe-inline'", ...hosts];
  if (development) parts.push("'unsafe-eval'");

  const extra = extraHosts.trim();
  if (extra) parts.push(extra);

  return `script-src ${parts.join(" ")}`;
}
