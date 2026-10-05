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
 * These tests pin the guard: a retired or malformed configured value is
 * ignored in favour of the live canonical origin, and a valid value still wins.
 *
 * Run:  node --import tsx --test tests/site-url.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { CANONICAL_SITE_URL, getSiteUrl } from "../src/lib/siteUrl.ts";

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

test("the canonical origin is the live domain", () => {
  assert.equal(CANONICAL_SITE_URL, "https://grynd.dedyn.io");
});

test("a valid configured base URL is used, trailing slash stripped", () => {
  assert.equal(
    withEnv({ NEXT_PUBLIC_BASE_URL: "https://grynd.dedyn.io" }, getSiteUrl),
    "https://grynd.dedyn.io",
  );
  assert.equal(
    withEnv({ NEXT_PUBLIC_BASE_URL: "https://www.grynd.dedyn.io/" }, getSiteUrl),
    "https://www.grynd.dedyn.io",
  );
});

test("a path on the configured value is dropped", () => {
  assert.equal(
    withEnv({ NEXT_PUBLIC_BASE_URL: "https://grynd.dedyn.io/foo/bar" }, getSiteUrl),
    "https://grynd.dedyn.io",
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
        NEXT_PUBLIC_APP_URL: "https://grynd.dedyn.io",
      },
      getSiteUrl,
    ),
    "https://grynd.dedyn.io",
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
    withEnv({ NEXT_PUBLIC_BASE_URL: "grynd.dedyn.io" }, getSiteUrl),
    "https://grynd.dedyn.io",
  );
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
