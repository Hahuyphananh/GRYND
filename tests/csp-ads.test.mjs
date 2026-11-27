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
  buildFrameSrc,
  buildImgSrc,
  buildMediaSrc,
  buildScriptSrc,
  clerkFrontendApiHost,
  inlineScriptHashes,
  parseHttpsOriginAllowlist,
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

const tokensOf = (directive, name) =>
  new Set(directive.replace(new RegExp(`^${name}\\s+`), "").split(/\s+/));

test("frame-src names exact provider hosts and never a provider wildcard", () => {
  for (const development of [false, true]) {
    const tokens = tokensOf(buildFrameSrc({ development, env: {} }), "frame-src");
    for (const exact of [
      "https://juvenilechoice.com",
      "https://a.magsrv.com",
      "https://acscdn.com",
      "https://adcash.com",
    ]) {
      assert.ok(tokens.has(exact), `missing ${exact}`);
    }
    for (const wildcard of [
      "https://*.magsrv.com",
      "https://*.acscdn.com",
      "https://*.adcash.com",
    ]) {
      assert.ok(!tokens.has(wildcard), `provider wildcard returned: ${wildcard}`);
    }
    assert.ok(!tokens.has("https:") && !tokens.has("http:"));
  }
});

test("img-src names hosts instead of allowing every https origin", () => {
  const tokens = tokensOf(buildImgSrc({ env: {} }), "img-src");
  assert.ok(!tokens.has("https:"), "a bare https: lets any host receive image beacons");
  assert.ok(tokens.has("'self'"));
  assert.ok(tokens.has("data:"));
  assert.ok(tokens.has("blob:"));
  assert.ok(tokens.has("https://pagead2.googlesyndication.com"));
  assert.ok(tokens.has("https://api.producthunt.com"));
  assert.ok(tokens.has("https://juvenilechoice.com"));
  assert.ok(tokens.has("https://a.magsrv.com"));
  assert.ok(tokens.has("https://acscdn.com"));
  assert.ok(!tokens.has("https://*.magsrv.com"));
});

test("media-src derives exact origins from the configured VAST tags", () => {
  const defaults = tokensOf(buildMediaSrc({ env: {} }), "media-src");
  assert.ok(defaults.has("https://rude-movie.com"));
  assert.ok(
    defaults.has("https://www.dismal-library.pro"),
    "the approved Hilltop creative host is named",
  );
  assert.ok(!defaults.has("https:"), "the default policy has no scheme wildcard");

  const connectDefaults = tokensOf(buildConnectSrc({ publishableKey: null, env: {} }), "connect-src");
  assert.ok(connectDefaults.has("https://rude-movie.com"), "the VAST tag origin must be fetchable");

  const tokens = tokensOf(
    buildMediaSrc({
      env: {
        NEXT_PUBLIC_HILLTOPS_VAST_URL: "https://hilltop-media.example/tag.xml",
        NEXT_PUBLIC_EXOCLICK_VAST_TAG: "https://exo-media.example/tag.xml",
        NEXT_PUBLIC_ADCASH_VAST_TAG: "https://adcash-media.example/tag.xml",
      },
    }),
    "media-src",
  );
  for (const exact of [
    "https://hilltop-media.example",
    "https://exo-media.example",
    "https://adcash-media.example",
  ]) {
    assert.ok(tokens.has(exact), `missing ${exact}`);
  }
  assert.ok(!tokens.has("https:"), "media-src must not permit arbitrary video hosts");
});

test("an operator can add exact account-specific origins, never wildcards", () => {
  assert.deepEqual(parseHttpsOriginAllowlist("https://cdn.example.test, https://track.example.test/"), [
    "https://cdn.example.test",
    "https://track.example.test",
  ]);
  assert.deepEqual(
    parseHttpsOriginAllowlist(
      "https://*.example.test http://plain.example.test https://bad.test/path https://user:pass@bad.test https://ok.test",
    ),
    ["https://ok.test"],
    "wildcards, http, paths and credentials are refused",
  );

  const frame = tokensOf(
    buildFrameSrc({ env: { ADS_CREATIVE_HOSTS: "https://cdn.example.test" } }),
    "frame-src",
  );
  assert.ok(frame.has("https://cdn.example.test"));
  assert.ok(!frame.has("https://unrelated.example.test"));

  const media = tokensOf(
    buildMediaSrc({ env: { ADS_MEDIA_HOSTS: "https://media.example.test" } }),
    "media-src",
  );
  assert.ok(media.has("https://media.example.test"));
});

test("the proxy emits the named frame, image and media directives", () => {
  const proxy = read("src/proxy.ts");
  assert.match(proxy, /buildFrameSrc\(/);
  assert.match(proxy, /buildImgSrc\(/);
  assert.match(proxy, /buildMediaSrc\(/);
  assert.doesNotMatch(proxy, /img-src 'self' data: blob: https:/);
  assert.doesNotMatch(proxy, /media-src 'self' blob: https:/);
});

test("the ad surfaces are still rendered where the model allows them", () => {
  // Guards against 'tighten CSP' turning into 'quietly drop the ad code'.
  assert.match(read("src/app/page.jsx"), /AdSenseScript/);
  assert.match(read("src/app/page.jsx"), /BannerSlot/);
  assert.match(read("src/app/reviews/page.tsx"), /TrustpilotPanel/);
  assert.match(read("src/components/AdSenseScript.tsx"), /adsbygoogle\.js\?client=/);
});

test("the live ad-delivery and creative hosts are named exactly", () => {
  const connect = new Set(
    buildConnectSrc({ publishableKey: null, env: {} }).replace(/^connect-src\s+/, "").split(/\s+/),
  );
  for (const host of ["https://rapidadexchange.com", "https://usrpubtrck.com"]) {
    assert.ok(connect.has(host), `connect-src must name ${host}`);
  }

  const img = new Set(
    buildImgSrc({ publishableKey: null, env: {} }).replace(/^img-src\s+/, "").split(/\s+/),
  );
  for (const host of ["https://crcdn.org", "https://rapidadexchange.com"]) {
    assert.ok(img.has(host), `img-src must name ${host}`);
  }

  const media = new Set(
    buildMediaSrc({ env: {} }).replace(/^media-src\s+/, "").split(/\s+/),
  );
  assert.ok(
    media.has("https://vidwestxyz.com"),
    "media-src must name the VAST MediaFile CDN observed in the Ad Exchange response",
  );
  assert.ok(!media.has("https:"), "media-src stays an allow-list");
});
