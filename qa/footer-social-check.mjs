// qa/footer-social-check.mjs
//
// Browser check for the official GRYND profiles row, which the site-wide footer
// and the contact page both mount. Mounts the REAL Footer
// (qa/footer-social-harness.jsx) and asserts:
//
//   1. Every official profile is linked, and nothing else is — the set of hrefs
//      must equal the expected list, so a typo'd or stale URL fails the check.
//   2. Each link opens in a new tab with rel="noopener noreferrer" (an external
//      link that hands `window.opener` to the other site is a real risk).
//   3. Each icon-only link carries an accessible name and a distinct icon — a
//      row of identical glyphs is unusable and normally means copy-paste.
//   4. No network is listed twice.
//   5. The contact page reuses the same row component instead of keeping its own
//      copy of the links (a second copy is how the surfaces drift apart).
//   6. The footer also names the community in WORDS ("Reddit Community"),
//      pointing at the exact subreddit in a new tab, and takes that URL from
//      the shared list rather than hardcoding a second copy.
//
// Run: node qa/footer-social-check.mjs

import { chromium } from "playwright";
import esbuild from "esbuild";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// The official profiles, transcribed from the live accounts. Order matters:
// it's the order they appear in the footer.
const EXPECTED = [
  // The subreddit leads the row: it is the community hub, not a feed.
  { name: "Reddit", href: "https://www.reddit.com/r/GRYND/" },
  {
    name: "Instagram", href: "https://www.instagram.com/grynd.gg/" },
  { name: "TikTok", href: "https://www.tiktok.com/@grynd.gg" },
  { name: "YouTube", href: "https://www.youtube.com/@TryGrynd" },
  { name: "LinkedIn", href: "https://www.linkedin.com/in/grynd-gg/" },
  { name: "X (formerly Twitter)", href: "https://x.com/TryGrynd" },
  // No `utm_*` tags: on our own site they'd only pad their campaign numbers.
  { name: "Product Hunt", href: "https://www.producthunt.com/products/grynd" },
];

// 1. Bundle the harness + the real Footer. Two Next-specific escapes are
//    stubbed here: a static .png import (Next turns it into an object with
//    `.src`) and next/image + next/link, which need Next's runtime.
const outDir = mkdtempSync(join(tmpdir(), "footer-social-"));
const bundleOut = join(outDir, "harness.js");
await esbuild.build({
  entryPoints: [join(root, "qa/footer-social-harness.jsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  outfile: bundleOut,
  logLevel: "error",
  absWorkingDir: root,
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [
    {
      name: "next-static-image",
      setup(build) {
        build.onLoad({ filter: /\.png$/ }, () => ({
          contents: `export default { src: "/images/stub-logo.png", width: 150, height: 60 };`,
          loader: "js",
        }));
      },
    },
    {
      name: "next-stubs",
      setup(build) {
        const STUBS = {
          "next-image-stub": `import React from "react";
            export default function Image({ src, alt, ...rest }) {
              return React.createElement("img", { src: typeof src === "string" ? src : src?.src, alt: alt || "", ...rest });
            }`,
          "next-link-stub": `import React from "react";
            export default function Link({ href, children, ...rest }) {
              return React.createElement("a", { href, ...rest }, children);
            }`,
        };
        build.onResolve({ filter: /^next\/(image|link)$/ }, (args) => ({
          path: args.path === "next/image" ? "next-image-stub" : "next-link-stub",
          namespace: "next-stub",
        }));
        build.onLoad({ filter: /^next-(image|link)-stub$/ }, (args) => ({
          contents: STUBS[args.path],
          loader: "js",
          // A virtual module has no directory of its own, so name one: this is
          // what lets the stub's `react` import resolve from the project.
          resolveDir: root,
        }));
      },
    },
  ],
});
const harnessJs = readFileSync(bundleOut, "utf8");

// 2. Tiny static server for the harness page (the row needs no assets: the
//    logo <img> is never fetched by these assertions).
const pageHtml = `<!doctype html>
<html><head><meta charset="utf-8"><title>Footer social check</title>
<style>body{margin:0;background:#030817}</style></head>
<body><div id="root"></div><script src="/harness.js"></script></body></html>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(pageHtml);
    return;
  }
  if (url.pathname === "/harness.js") {
    res.writeHead(200, { "Content-Type": "application/javascript" });
    res.end(harnessJs);
    return;
  }
  // The stubbed logo: the row never needs it, but a 404 would log noise.
  if (url.pathname === "/images/stub-logo.png") {
    res.writeHead(200, { "Content-Type": "image/png" });
    res.end(Buffer.alloc(0));
    return;
  }
  res.writeHead(404);
  res.end("not found");
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`);
  ok ? pass++ : fail++;
};

try {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on("pageerror", (err) => console.log("PAGE ERROR:", err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") console.log("CONSOLE ERROR:", msg.text());
  });
  await page.goto(base, { waitUntil: "networkidle" });
  await page.waitForSelector('[data-testid="footer-social"]');

  const row = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="footer-social"]');
    if (!el) return null;
    return [...el.querySelectorAll("a")].map((a) => {
      const svg = a.querySelector("svg");
      return {
        href: a.getAttribute("href"),
        label: a.getAttribute("aria-label"),
        title: a.getAttribute("title"),
        target: a.getAttribute("target"),
        rel: a.getAttribute("rel"),
        visibleText: a.textContent.trim(),
        icon: svg ? svg.outerHTML : null,
      };
    });
  });

  const hrefs = (row ?? []).map((l) => l.href);

  check(
    "links exactly the official GRYND profiles, in order, with no extras",
    JSON.stringify(hrefs) === JSON.stringify(EXPECTED.map((e) => e.href)),
    JSON.stringify(hrefs),
  );

  check(
    "every link opens in a new tab with rel=noopener noreferrer",
    (row ?? []).length > 0 &&
      row.every((l) => l.target === "_blank" && /noopener/.test(l.rel || "") && /noreferrer/.test(l.rel || "")),
    JSON.stringify((row ?? []).map((l) => `${l.target}/${l.rel}`)),
  );

  check(
    "every link is reachable without sight: it has an accessible name + tooltip",
    (row ?? []).length > 0 &&
      row.every((l, i) => l.label && l.label.includes(EXPECTED[i].name) && l.title === EXPECTED[i].name),
    JSON.stringify((row ?? []).map((l) => l.label)),
  );

  const icons = (row ?? []).map((l) => l.icon);
  check(
    "each link renders its own brand icon (no glyph reused, none missing)",
    icons.length === EXPECTED.length &&
      icons.every(Boolean) &&
      new Set(icons).size === EXPECTED.length &&
      row.every((l) => l.visibleText === ""),
    `icons=${new Set(icons).size}/${EXPECTED.length}`,
  );

  check(
    "no profile is listed twice",
    new Set(hrefs).size === hrefs.length,
    JSON.stringify(hrefs),
  );

  // ── The clearly labelled community link ───────────────────────────────
  // The icon row is discoverable but carries no visible text, so the footer's
  // Navigation column also names the destination outright. It has to point at
  // the exact subreddit, in a new tab, with the same external-link hardening
  // as the icons.
  const community = await page.evaluate(() => {
    const anchor = [...document.querySelectorAll("a")].find(
      (el) => el.textContent.replace(/\s+/g, " ").trim() === "Reddit Community",
    );
    if (!anchor) return null;
    return {
      text: anchor.textContent.replace(/\s+/g, " ").trim(),
      href: anchor.getAttribute("href"),
      target: anchor.getAttribute("target"),
      rel: anchor.getAttribute("rel"),
    };
  });
  check(
    "the footer names the community in words, not just an icon",
    community?.text === "Reddit Community",
    JSON.stringify(community),
  );
  check(
    "…at the exact subreddit URL, opened in a new tab with noopener noreferrer",
    community?.href === "https://www.reddit.com/r/GRYND/" &&
      community.target === "_blank" &&
      /noopener/.test(community.rel || "") &&
      /noreferrer/.test(community.rel || ""),
    JSON.stringify(community),
  );

  // ── Mobile ────────────────────────────────────────────────────────────
  // The footer is the one surface mounted on every page, so the community
  // link has to be reachable and tappable at phone width too — in the icon
  // row AND as the labelled entry.
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await phone.goto(base, { waitUntil: "networkidle" });
  await phone.waitForSelector('[data-testid="footer-social"]');
  const mobile = await phone.evaluate(() => {
    const anchor = [...document.querySelectorAll("a")].find(
      (el) => el.textContent.replace(/\s+/g, " ").trim() === "Reddit Community",
    );
    const tile = document.querySelector(
      '[data-testid="footer-social"] a[href="https://www.reddit.com/r/GRYND/"]',
    );
    const rect = anchor?.getBoundingClientRect();
    const doc = document.documentElement;
    return {
      labelled: anchor
        ? {
            href: anchor.getAttribute("href"),
            target: anchor.getAttribute("target"),
            visible: Boolean(rect && rect.width > 0 && rect.height > 0),
            inViewportX: Boolean(rect && rect.left >= 0 && rect.right <= doc.clientWidth + 1),
          }
        : null,
      tile: Boolean(tile),
      overflow: doc.scrollWidth - doc.clientWidth,
    };
  });
  check(
    "the community link is present and tappable at phone width",
    Boolean(mobile.labelled?.visible && mobile.labelled.inViewportX) && mobile.tile,
    JSON.stringify(mobile),
  );
  check(
    "…still at the exact subreddit, opening in a new tab",
    mobile.labelled?.href === "https://www.reddit.com/r/GRYND/" &&
      mobile.labelled.target === "_blank" &&
      mobile.tile,
    JSON.stringify(mobile.labelled),
  );
  check(
    "the footer does not overflow sideways once the row gains a seventh tile",
    mobile.overflow <= 2,
    `overflow=${mobile.overflow}`,
  );
  await phone.close();

  await browser.close();

  // ── One list, two surfaces ────────────────────────────────────────────
  // Source-level wiring check (same spirit as the lobby's "renders <Footer />"
  // assertion): the contact page has to mount the shared row rather than carry
  // its own copy of the URLs, which is how the two would drift.
  const PROFILE_HOSTS =
    /instagram\.com|tiktok\.com|x\.com|youtube\.com|linkedin\.com|producthunt\.com|reddit\.com/i;
  const read = (rel) => readFileSync(join(root, rel), "utf8");

  // The labelled link must borrow the URL from the shared list rather than
  // hardcode its own copy — one subreddit, one place to change it.
  const footerSrc = read("src/components/Footer.tsx");
  check(
    "the footer's community link reuses the shared social list's URL",
    footerSrc.includes("REDDIT_COMMUNITY.href") && !/reddit\.com/i.test(footerSrc),
    `reuses=${footerSrc.includes("REDDIT_COMMUNITY.href")}`,
  );

  // The Product Hunt BADGE is a third-party embed (an <a> to their site plus
  // their widget image), not one of our profile links — and both the landing
  // page and the footer carry it deliberately. Strip just those two URLs
  // before asking whether a page hardcoded a profile URL of its own.
  const stripBadges = (src) =>
    src
      .replace(/https:\/\/www\.producthunt\.com\/products\/grynd\?embed=true[^"']*/gi, "")
      .replace(/https:\/\/api\.producthunt\.com[^"']*/gi, "");

  const contactSrc = read("src/app/contact/PageClient.jsx");
  check(
    "contact page mounts the shared SocialLinks row (no second copy of the list)",
    contactSrc.includes("<SocialLinks") && !PROFILE_HOSTS.test(stripBadges(contactSrc)),
    `mounts=${contactSrc.includes("<SocialLinks")}`,
  );
  check(
    "contact page renders the site footer, like the other content pages",
    contactSrc.includes("<Footer />"),
  );

  // ── Landing-page follow strip ─────────────────────────────────────────
  const homeSrc = read("src/app/PageClient.jsx");
  check(
    "landing page mounts the shared row and hardcodes no profile URL",
    homeSrc.includes("<SocialLinks") && !PROFILE_HOSTS.test(stripBadges(homeSrc)),
    `mounts=${homeSrc.includes("<SocialLinks")}`,
  );

  // Its copy comes from the translation system, in all three locales — a
  // follow strip that renders `home.social.title` at the user would ship as a
  // visible bug in fr/es.
  const { t } = await import("../src/lib/appTextTranslations.js");
  const missing = [];
  for (const locale of ["en", "fr", "es"]) {
    for (const key of ["home.social.title", "home.social.subtitle"]) {
      if (t(locale, key) === key) missing.push(`${locale}:${key}`);
    }
  }
  check(
    "follow-strip copy is localized in en, fr and es",
    missing.length === 0,
    missing.join(", "),
  );
} finally {
  server.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
