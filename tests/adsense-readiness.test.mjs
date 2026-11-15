/**
 * adsense-readiness.test.mjs
 *
 * THE REVIEW SURFACE — the things an AdSense reviewer must be able to find, and
 * the two claims that would lose the account if they were ever false.
 *
 * tests/adsense.test.mjs already owns the loader, the consent architecture and
 * ads.txt. This file owns what a site review looks for beyond the tag:
 *
 *   1. OWNERSHIP. The publisher id is claimed in the served <head>
 *      (`google-adsense-account`) AND authorised in ads.txt, and both name the
 *      same publisher. Two different ids is silent everywhere except revenue.
 *
 *   2. A PUBLISHER STATEMENT. /about says who runs the site, how it is funded,
 *      that advertising is labelled, that advertisers have no influence, and
 *      that there is no real-money gambling. Those are the sentences a reviewer
 *      (and a reader) uses to classify the site.
 *
 *   3. A DISCLOSURE WITH AN OPT-OUT. /cookie-policy names Google AdSense and
 *      its advertising cookies, gives the third-party opt-out links, and points
 *      at the real withdrawal control (CookieSettingsLink) instead of inventing
 *      a "contact us to opt out" that no one can use.
 *
 *   4. NO ADS ON THE POLICY PAGES. Info pages are not content pages; ads there
 *      are inventory with nothing behind them. The check is source-level, so a
 *      future edit that "monetises the legal pages" fails by name.
 *
 *   5. EDITORIAL INVENTORY. The guides are the content surface, and they carry
 *      the `guides` placement from the ONE guide component — so a new guide
 *      cannot ship without an ad, and a guide page cannot ship without the
 *      loader the slot needs.
 *
 * Source-level by design: this suite runs in CI without a browser, and the
 * pages are server components whose whole content is in the HTML they return.
 *
 * Run:  node --import tsx --test tests/adsense-readiness.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8").replace(/\r\n/g, "\n");
/** Source with comments stripped, so a comment ABOUT a rule cannot satisfy it. */
const code = (path) =>
  read(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

const ABOUT = "src/app/about/page.tsx";
const COOKIES = "src/app/cookie-policy/page.tsx";
const LAYOUT = "src/app/layout.tsx";
const ADS = "src/lib/ads.ts";
const FOOTER = "src/components/Footer.tsx";
const SEO_INVENTORY = "src/lib/seoPages.ts";
const GUIDES_INDEX = "src/app/guides/page.tsx";
const GUIDE_ARTICLE = "src/components/guides/GuideArticle.tsx";
const READINESS_DOC = "docs/adsense-readiness.md";

const PUBLISHER = "pub-4903728316211815";

test("the served <head> claims the same publisher that ads.txt authorises", () => {
  const layout = code(LAYOUT);
  assert.match(
    layout,
    /<meta name="google-adsense-account" content=\{adsenseAccount\} \/>/,
    "Google's site-verification meta tag must be in the head",
  );
  // Only a well-formed id may be claimed: a typo must emit nothing rather than
  // assert ownership of somebody else's publisher.
  assert.match(layout, /normalizePublisherId\(adsensePublisherId\(\)\)/);
  assert.match(layout, /\{adsenseAccount && <meta name="google-adsense-account"/);

  const adsTxt = read("public/ads.txt");
  assert.ok(
    adsTxt.includes(`google.com, ${PUBLISHER}, DIRECT, f08c47fec0942fa0`),
    "ads.txt must authorise the publisher the head claims",
  );
  assert.match(
    code(ADS),
    new RegExp(`DEFAULT_ADSENSE_PUBLISHER_ID = "ca-${PUBLISHER}"`),
    "the publisher id must be the one AdSense issued for this property",
  );
});

test("/about states the publisher case a review has to classify", () => {
  const about = read(ABOUT);
  assert.match(about, /alternates: \{ canonical: "\/about" \}/);
  // Who runs it, and that the content is original rather than bought.
  assert.match(about, /written\s+and maintained in-house/);
  // How it is funded, and that the ads are labelled.
  assert.match(about, /paid for by advertising/);
  assert.match(about, /Google\s?\n?\s*AdSense|Google AdSense/);
  assert.match(about, /labelled “Advertisement”/);
  // The independence claim, which is the "pages made for ads" answer.
  assert.match(about, /Advertisers have no influence/);
  // Never in gameplay, which is the placement promise the code enforces.
  assert.match(about, /no advertising on a live board/);
  // The classification that matters most for a restricted vertical.
  assert.match(about, /no real money is wagered, won or lost/);
  assert.match(about, /18 and over/);
  // Who is accountable for the content, in terms the page really uses.
  assert.match(about, /the same team that runs the game/);
  // It must lead somewhere a reviewer can actually contact.
  assert.match(about, /href="\/contact"/);
  assert.match(about, /href="\/cookie-policy"/);
});

test("/cookie-policy is a real disclosure with a working opt-out", () => {
  const cookies = read(COOKIES);
  assert.match(cookies, /alternates: \{ canonical: "\/cookie-policy" \}/);
  // The four classes, including the advertising one by name.
  assert.match(cookies, /Strictly necessary/);
  assert.match(cookies, /Analytics and diagnostics/);
  assert.match(cookies, /Advertising/);
  assert.match(cookies, /Google AdSense/);
  // The advertising cookies and the reason they exist.
  assert.match(cookies, /DoubleClick/);
  assert.match(cookies, /limit how often you see the same ad/);
  // Consent defaults, and the certified CMP split.
  assert.match(cookies, /Consent Mode/);
  assert.match(cookies, /certified consent management platform/);
  // Real third-party opt-outs, not a promise to email us.
  assert.match(cookies, /https:\/\/adssettings\.google\.com/);
  assert.match(cookies, /https:\/\/www\.aboutads\.info\/choices\//);
  assert.match(cookies, /https:\/\/optout\.networkingadvertising\.org\//);
  // The withdrawal route is the control that exists, not a description of one.
  assert.match(cookies, /import CookieSettingsLink from "\.\.\/\.\.\/components\/CookieSettingsLink"/);
  assert.match(cookies, /<CookieSettingsLink className=\{LINK\} \/>/);
  // And the no-sale statement.
  assert.match(cookies, /does not sell personal information/);
});

test("policy pages carry no ad code", () => {
  for (const page of [ABOUT, COOKIES]) {
    const source = code(page);
    assert.doesNotMatch(source, /AdSlot/, `${page} must not render an ad slot`);
    assert.doesNotMatch(source, /AdSenseScript/, `${page} must not load the ad tag`);
    assert.doesNotMatch(source, /adsbygoogle/, `${page} must not touch the ad API`);
  }
});

test("both pages are published: in the sitemap inventory and the footer", () => {
  const inventory = read(SEO_INVENTORY);
  for (const path of ["/about", "/cookie-policy"]) {
    assert.ok(
      inventory.includes(`path: "${path}"`),
      `${path} must be in the ONE page inventory the sitemap emits`,
    );
  }
  const footer = read(FOOTER);
  assert.match(footer, /href="\/about"/);
  assert.match(footer, /href="\/cookie-policy"/);
});

test("the guides carry the editorial placement from the one article component", () => {
  // The placement is registered configuration, not a literal in a page.
  assert.match(code(ADS), /guides: "NEXT_PUBLIC_ADSENSE_SLOT_GUIDES"/);
  // The index: loader + slot.
  const index = read(GUIDES_INDEX);
  assert.match(index, /<AdSenseScript \/>/);
  assert.match(index, /<AdSlot placement="guides" \/>/);
  // Every ARTICLE: the loader the slot needs, and the slot itself, from the
  // single component all twelve articles share.
  const article = read(GUIDE_ARTICLE);
  assert.match(article, /<AdSenseScript \/>/);
  assert.match(article, /<AdSlot placement="guides" \/>/);
  // The slot is server-gated at the component boundary, so a page cannot opt a
  // member back into ads.
  assert.match(article, /import AdSlot from "\.\.\/AdSlot"/);
});

test("the readiness note names the manual steps and the restricted-content risk", () => {
  const doc = read(READINESS_DOC);
  for (const needle of [
    "google-adsense-account",
    "ads.txt",
    "certified CMP",
    "NEXT_PUBLIC_ADSENSE_SLOT_GUIDES",
    "restricted",
    "gambling",
    "Do not click your own ads",
  ]) {
    assert.ok(doc.toLowerCase().includes(needle.toLowerCase()), `docs must mention: ${needle}`);
  }
});
