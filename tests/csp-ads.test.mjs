// tests/csp-ads.test.mjs
//
// The script-src allowlist must stay an allowlist.
//
// The 2026-11 audit found script-src ending in `https:`, which permits any
// HTTPS origin to serve script and makes the directive useless as an XSS
// control. The fix (src/lib/security/csp.ts) names each origin instead. These
// tests pin both halves: no wildcard scheme, and every provider the app
// actually loads is present.
//
// Run with: node --import tsx --test tests/csp-ads.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  THIRD_PARTY_SCRIPT_HOSTS,
  buildConnectSrc,
  buildScriptSrc,
  clerkFrontendApiHost,
  inlineScriptHashes,
} from "../src/lib/security/csp.ts";
import { CRAZYGAMES_SDK_SRC } from "../src/lib/portal/crazygames.ts";
import { TRUSTPILOT_SCRIPT_SRC } from "../src/lib/trustpilot.ts";
import { HILLTOP_PROVIDER_SCRIPT_URL } from "../src/lib/hilltop/config.ts";

const read = (path) => readFileSync(path, "utf8");

const hostsOf = (directive) => new Set(directive.replace(/^script-src\s+/, "").split(/\s+/));

test("script-src never falls back to a scheme-wide wildcard", () => {
  for (const development of [false, true]) {
    const directive = buildScriptSrc({ development, publishableKey: null });
    const tokens = [...hostsOf(directive)];
    assert.ok(
      !tokens.includes("https:") && !tokens.includes("http:"),
      "a bare scheme token allows every host on it",
    );
    assert.ok(
      !tokens.some((token) => token === "*" || token.endsWith("://")),
      "no wildcard scheme may remain",
    );
  }
});

test("script-src is nonce-based and never allows inline", () => {
  const prod = buildScriptSrc({ development: false, publishableKey: null });
  assert.match(prod, /'self'/);
  // Inline scripts must present the per-request nonce. 'unsafe-inline' is
  // exactly what let an injected <script> run before this change.
  assert.doesNotMatch(prod, /'unsafe-inline'/);
  assert.doesNotMatch(prod, /'nonce-/, "no nonce supplied, none emitted");
  assert.doesNotMatch(prod, /'unsafe-eval'/, "eval is development-only");

  const withNonce = buildScriptSrc({ nonce: "abc123", publishableKey: null });
  assert.match(withNonce, /'nonce-abc123'/);
  assert.doesNotMatch(withNonce, /'unsafe-inline'/);

  const dev = buildScriptSrc({ development: true, publishableKey: null });
  assert.match(dev, /'unsafe-eval'/, "next dev needs eval");
});

test("the GA inline snippet keeps a hash that matches the shipped script", () => {
  const hashes = inlineScriptHashes();
  assert.equal(hashes.length, 1);
  assert.match(hashes[0], /^'sha256-[A-Za-z0-9+/=]+'$/);

  // Drift guard: the hash is computed from a copy of the snippet the CLIENT
  // component renders (it cannot carry the request nonce), so every line of
  // that copy must still exist verbatim in the component.
  const tag = read("src/components/GoogleAnalytics.tsx");
  for (const line of [
    "window.dataLayer = window.dataLayer || [];",
    "function gtag(){dataLayer.push(arguments);}",
    "gtag('js', new Date());",
    "gtag('config', 'G-PFN3BBLC0E');",
  ]) {
    assert.ok(tag.includes(line), `GA snippet drifted: ${line}`);
  }
});

test("connect-src is an allowlist, not a scheme wildcard", () => {
  const directive = buildConnectSrc({ publishableKey: null, env: {} });
  const tokens = new Set(directive.replace(/^connect-src\s+/, "").split(/\s+/));

  assert.ok(!tokens.has("https:"), "a bare https: lets any injected script exfiltrate");
  assert.ok(!tokens.has("wss:"), "a bare wss: does the same over WebSocket");
  assert.ok(tokens.has("'self'"));
  assert.ok(tokens.has("https://*.clerk.com"));
  assert.ok(tokens.has("https://api.stripe.com"));
  assert.ok(tokens.has("https://*.posthog.com"));
});

test("connect-src pins the deploy's own Supabase and realtime backends", () => {
  const directive = buildConnectSrc({
    publishableKey: null,
    env: {
      NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co/",
      NEXT_PUBLIC_SOCKET_URL: "https://grynd-realtime.onrender.com",
    },
  });
  const tokens = new Set(directive.replace(/^connect-src\s+/, "").split(/\s+/));

  assert.ok(tokens.has("https://project.supabase.co"));
  assert.ok(tokens.has("wss://project.supabase.co"));
  assert.ok(tokens.has("https://grynd-realtime.onrender.com"));
  assert.ok(tokens.has("wss://grynd-realtime.onrender.com"));
});

test("every provider the app loads is explicitly allowed", () => {
  const hosts = hostsOf(buildScriptSrc({ publishableKey: null }));

  // AdSense loader rendered by AdSenseScript.tsx.
  assert.match(read("src/components/AdSenseScript.tsx"), /pagead2\.googlesyndication\.com/);
  assert.ok(hosts.has("https://pagead2.googlesyndication.com"));

  // GA4 loader (components/GoogleAnalytics.tsx).
  assert.match(read("src/components/GoogleAnalytics.tsx"), /www\.googletagmanager\.com/);
  assert.ok(hosts.has("https://www.googletagmanager.com"));

  // PostHog's runtime modules (surveys, dead clicks, web vitals, exceptions).
  assert.ok(hosts.has("https://*.posthog.com"));

  // Trustpilot bootstrap — derived from the real constant, not a copy.
  const trustpilotHost = new URL(TRUSTPILOT_SCRIPT_SRC).origin;
  assert.ok(hosts.has(trustpilotHost), `missing ${trustpilotHost}`);

  // HilltopAds banner (protocol-relative URL → https origin).
  const hilltop = HILLTOP_PROVIDER_SCRIPT_URL.startsWith("//")
    ? `https:${HILLTOP_PROVIDER_SCRIPT_URL}`
    : HILLTOP_PROVIDER_SCRIPT_URL;
  assert.ok(hosts.has(new URL(hilltop).origin), "missing the HilltopAds host");

  // CrazyGames portal SDK.
  assert.ok(hosts.has(new URL(CRAZYGAMES_SDK_SRC).origin));

  // Clerk and Turnstile.
  assert.ok(hosts.has("https://*.clerk.com"));
  assert.ok(hosts.has("https://challenges.cloudflare.com"));

  // The ad code's own families + Google's certified CMP.
  for (const required of [
    "https://*.googlesyndication.com",
    "https://*.doubleclick.net",
    "https://fundingchoicesmessages.google.com",
  ]) {
    assert.ok(hosts.has(required), `missing ${required}`);
  }
});

test("a custom Clerk frontend API host is derived from the publishable key", () => {
  const host = "clerk.grynd.example";
  const key = `pk_test_${Buffer.from(`${host}$`).toString("base64")}`;
  assert.equal(clerkFrontendApiHost(key), host);

  const directive = buildScriptSrc({ publishableKey: key });
  assert.ok(directive.includes(`https://${host}`), "custom-domain sign-in would break");

  // Garbage keys must not add a bogus source.
  assert.equal(clerkFrontendApiHost("not-a-key"), null);
  assert.equal(clerkFrontendApiHost(""), null);
  assert.equal(clerkFrontendApiHost("pk_test_%%%"), null);
});

test("the proxy builds its policy from the shared allowlist", () => {
  const proxy = read("src/proxy.ts");
  assert.match(proxy, /buildScriptSrc\(/);
  assert.ok(
    !proxy.includes("cloudflare.com https: "),
    "the proxy still appends a bare https: token",
  );
});

test("the ad surfaces are still rendered where the model allows them", () => {
  // Guards against 'tighten CSP' turning into 'quietly drop the ad code'.
  assert.match(read("src/app/page.jsx"), /AdSenseScript/);
  assert.match(read("src/app/page.jsx"), /HilltopBanner/);
  assert.match(read("src/app/reviews/page.tsx"), /TrustpilotPanel/);
  assert.match(read("src/components/AdSenseScript.tsx"), /adsbygoogle\.js\?client=/);
});
