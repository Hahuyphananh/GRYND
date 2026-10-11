/**
 * site-url.test.mjs
 *
 * The site origin feeds every absolute URL the app emits: og:image /
 * twitter:image, canonical tags, JSON-LD ids, the sitemap, and the links
 * inside emails. It comes from NEXT_PUBLIC_BASE_URL, which is inlined at BUILD
 * time — so a value left over from before a domain move keeps producing URLs
 * on a retired host.
 *
 * That is not hypothetical: production served
 * `og:image = https://www.grynd.mywire.org/images/og-banner.png` while that
 * host answers 404 for the image, so every shared link rendered a blank card
 * even though the meta tag looked correct.
 *
 * The canonical origin is `www`: the platform serves the app there and answers
 * EVERY apex path with a 308 to www. The apex therefore cannot be named as the
 * canonical origin — and more importantly a page cannot be *served* from it,
 * because a POST issued there is replayed against www, that hop is cross-origin,
 * the reply carries no CORS headers, and `fetch` rejects with
 * `TypeError: Failed to fetch`. Reads only look healthy (the service worker
 * answers them from cache); writes die. That asymmetry is exactly the reported
 * Pool Masters bug: the lobby listed games, and "Create Game" did nothing.
 *
 * These tests pin both halves: the origin every URL builder uses, and the
 * relocation that moves a page off a non-canonical alias of it.
 *
 * Run:  node --import tsx --test tests/site-url.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  CANONICAL_SITE_URL,
  canonicalRelocationUrl,
  getSiteUrl,
} from "../src/lib/siteUrl.ts";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, "..", p), "utf8");

const BASE_KEYS = ["NEXT_PUBLIC_BASE_URL", "NEXT_PUBLIC_APP_URL"];

/** Run `fn` with the base-URL env vars set exactly as given, then restore. */
function withEnv(values, fn) {
  const saved = Object.fromEntries(BASE_KEYS.map((k) => [k, process.env[k]]));
  try {
    for (const key of BASE_KEYS) {
      const value = values[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return fn();
  } finally {
    for (const key of BASE_KEYS) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("the canonical origin is the host the app is served on (www)", () => {
  assert.equal(CANONICAL_SITE_URL, "https://www.grynd.dedyn.io");
});

test("www and apex are one site, and www is the form that is emitted", () => {
  // The apex only 308-redirects, so a canonical/og:url that names it hands
  // crawlers a redirect instead of the page.
  assert.equal(new URL(CANONICAL_SITE_URL).hostname, "www.grynd.dedyn.io");
});

test("a valid configured base URL is used, trailing slash stripped", () => {
  assert.equal(
    withEnv({ NEXT_PUBLIC_BASE_URL: "https://www.grynd.dedyn.io" }, getSiteUrl),
    CANONICAL_SITE_URL,
  );
});

// `www.` and apex serve the same site, so either form of the pair is collapsed
// onto the canonical www origin. A configured apex is the dangerous case: it is
// a stale configuration from before the platform moved to www, and emitting it
// splits canonical/og:url from the host that actually answers.
test("a configured apex is collapsed onto the canonical www origin", () => {
  for (const value of [
    "https://grynd.dedyn.io",
    "https://grynd.dedyn.io/",
    "grynd.dedyn.io",
  ]) {
    assert.equal(
      withEnv({ NEXT_PUBLIC_BASE_URL: value }, getSiteUrl),
      CANONICAL_SITE_URL,
      `value ${JSON.stringify(value)}`,
    );
  }
});

test("a www configured host is kept as the canonical origin", () => {
  for (const value of [
    "https://www.grynd.dedyn.io/",
    "https://www.grynd.dedyn.io",
  ]) {
    assert.equal(
      withEnv({ NEXT_PUBLIC_BASE_URL: value }, getSiteUrl),
      CANONICAL_SITE_URL,
    );
  }
});

test("a path on the configured value is dropped", () => {
  assert.equal(
    withEnv({ NEXT_PUBLIC_BASE_URL: "https://www.grynd.dedyn.io/foo/bar" }, getSiteUrl),
    CANONICAL_SITE_URL,
  );
});

// The list must grow as hosts are retired.
const RETIRED = [
  "https://www.grynd.mywire.org",
  "https://grynd.mywire.org",
  "https://casino-app-sandy.vercel.app",
];

for (const host of RETIRED) {
  test(`a retired host is ignored: ${host}`, () => {
    assert.equal(
      withEnv({ NEXT_PUBLIC_BASE_URL: host }, getSiteUrl),
      CANONICAL_SITE_URL,
      "a retired host must never become the site origin",
    );
  });
}

test("a retired base URL falls through to a valid NEXT_PUBLIC_APP_URL", () => {
  assert.equal(
    withEnv(
      {
        NEXT_PUBLIC_BASE_URL: "https://www.grynd.mywire.org",
        NEXT_PUBLIC_APP_URL: "https://www.grynd.dedyn.io",
      },
      getSiteUrl,
    ),
    CANONICAL_SITE_URL,
  );
});

test("empty, whitespace, malformed and non-http values fall back", () => {
  for (const value of ["", "   ", "not a url", "ftp://grynd.dedyn.io", "javascript:alert(1)"]) {
    assert.equal(
      withEnv({ NEXT_PUBLIC_BASE_URL: value }, getSiteUrl),
      CANONICAL_SITE_URL,
      `value ${JSON.stringify(value)}`,
    );
  }
});

test("nothing configured falls back to the canonical origin", () => {
  assert.equal(withEnv({}, getSiteUrl), CANONICAL_SITE_URL);
});

test("the schema-less form is accepted", () => {
  assert.equal(
    withEnv({ NEXT_PUBLIC_BASE_URL: "www.grynd.dedyn.io" }, getSiteUrl),
    CANONICAL_SITE_URL,
  );
});

// ── Relocation: a page found on the apex must move to the served host ───────
//
// A stale service worker can keep serving the app shell from the apex long
// after the platform began redirecting it. That page can READ (the worker
// answers from cache) but cannot WRITE (the POST is replayed cross-origin and
// the reply is discarded), which is the whole reported failure. Relocating is
// the only fix available to the client.

test("relocation: a page on the apex moves to the canonical origin", () => {
  assert.equal(
    canonicalRelocationUrl("https://grynd.dedyn.io/casino/pool-masters"),
    "https://www.grynd.dedyn.io/casino/pool-masters",
  );
});

test("relocation: path, query and hash are preserved", () => {
  assert.equal(
    canonicalRelocationUrl(
      "https://grynd.dedyn.io/casino/pool-masters/game/abc-123?ai=1&turn=2#table",
    ),
    "https://www.grynd.dedyn.io/casino/pool-masters/game/abc-123?ai=1&turn=2#table",
  );
});

test("relocation: nothing to do on the canonical origin (no redirect loop)", () => {
  for (const href of [
    "https://www.grynd.dedyn.io/",
    "https://www.grynd.dedyn.io/casino/pool-masters?x=1",
    "https://www.grynd.dedyn.io:443/casino",
  ]) {
    assert.equal(canonicalRelocationUrl(href), null, href);
  }
});

test("relocation: every other host is left alone", () => {
  for (const href of [
    "http://localhost:3000/casino/pool-masters",
    "http://127.0.0.1:3000/casino",
    "https://casino-app-sandy.vercel.app/casino",
    "https://preview-abc123.vercel.app/casino",
    "https://www.grynd.mywire.org/",
    "https://evil.example.com/casino",
    "https://notgrynd.dedyn.io.evil.example.com/",
    "not a url",
    "javascript:alert(1)",
  ]) {
    assert.equal(canonicalRelocationUrl(href), null, href);
  }
});

test("relocation: the host comparison is case- and www-insensitive only", () => {
  assert.equal(
    canonicalRelocationUrl("https://GRYND.DEDYN.IO/casino"),
    "https://www.grynd.dedyn.io/casino",
  );
  // A trailing dot is the same host per DNS, and must not read as a new one.
  assert.equal(
    canonicalRelocationUrl("https://grynd.dedyn.io./casino"),
    "https://www.grynd.dedyn.io/casino",
  );
});

// ── Wiring: the relocation guard must actually run on every page ────────────

test("the relocation guard is mounted in the root layout", () => {
  const layout = read("src/app/layout.tsx");
  assert.match(layout, /import HostCanonicalizer from "\.\.\/components\/HostCanonicalizer"/);
  assert.match(layout, /<HostCanonicalizer \/>/);
});

test("the guard relocates with replace(), once, and only on an alias", () => {
  const src = read("src/components/HostCanonicalizer.tsx");
  // replace(), not assign(): an alias URL must not become a back-button entry.
  assert.match(src, /window\.location\.replace\(target\)/);
  assert.ok(
    !/window\.location\.(assign|href\s*=)/.test(src),
    "the guard must not push a history entry for the alias URL",
  );
  // One attempt per origin per session, so a worker that keeps answering from
  // the alias cannot turn the relocation into a loop.
  assert.match(src, /sessionStorage\.getItem\(ATTEMPTED_KEY\)/);
  assert.match(src, /sessionStorage\.setItem\(ATTEMPTED_KEY/);
  // The decision itself lives in the tested resolver, not inline here.
  assert.match(src, /canonicalRelocationUrl\(window\.location\.href\)/);
});

// ── Wiring: the consumers must use the guarded resolver, not the raw env var.

const READERS = [
  "src/lib/ogImages.ts",
  "src/app/sitemap.ts",
  "src/lib/emails/unsubscribe.ts",
  "src/lib/emails/welcome.ts",
  "src/lib/emails/inactivity.ts",
];

test("URL builders go through getSiteUrl(), not process.env directly", () => {
  for (const file of READERS) {
    const src = read(file);
    assert.match(src, /getSiteUrl/, `${file} must use the shared resolver`);
    assert.ok(
      !/process\.env\.NEXT_PUBLIC_(BASE|APP)_URL/.test(src),
      `${file} must not read the base URL env vars directly`,
    );
  }
});

test("ogImages exposes the guarded origin", () => {
  const src = read("src/lib/ogImages.ts");
  assert.match(src, /export const OG_BASE_URL = getSiteUrl\(\)/);
  assert.match(src, /export const ogImageUrl/);
});

// The landing pages and the guides each used to hard-code the origin. Two
// literals and the resolver could disagree — which is how the app ended up
// emitting the apex while the platform served www.
test("per-page origins are derived from the one resolver", () => {
  for (const file of ["src/lib/gameLandingPages.ts", "src/lib/guides.ts"]) {
    const src = read(file);
    assert.match(
      src,
      /export const SITE_ORIGIN = CANONICAL_SITE_URL;/,
      `${file} must not hard-code the origin`,
    );
    assert.match(src, /import \{ CANONICAL_SITE_URL \} from "\.\/siteUrl"/);
  }
});

test("the native shell loads the served host, not the redirecting apex", () => {
  const src = read("capacitor.config.ts");
  assert.match(src, /url: 'https:\/\/www\.grynd\.dedyn\.io\/'/);
  assert.ok(
    !/url: 'https:\/\/grynd\.dedyn\.io/.test(src),
    "the WebView must not boot on the host that 308-redirects",
  );
});

test("robots.txt advertises the sitemap on the served host", () => {
  // A sitemap URL that 308s makes the crawler fetch it twice and can park the
  // sitemap under the redirecting host.
  assert.match(read("public/robots.txt"), /^Sitemap: https:\/\/www\.grynd\.dedyn\.io\/sitemap\.xml$/m);
});
