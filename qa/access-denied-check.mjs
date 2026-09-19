// qa/access-denied-check.mjs
//
// Browser check for the rebranded /access-denied page — the other half of the
// age gate (a signed-in account whose recorded date of birth is under 18).
// Mounts the REAL page (qa/access-denied-harness.jsx) with the project's REAL
// Tailwind CSS.
//
//   1. It belongs to the same brand family as /complete-profile and the 404:
//      #030817 stage, navy glass card, the GRYND logo, a shimmer heading, and
//      the family's "18+" reel marker — here SLASHED, with the brand's rose
//      (#ff5d8f) as the denial accent instead of a flat error red.
//   2. The old off-brand treatment (`#003366` stage, white card, `text-red-600`
//      heading) is gone.
//   3. The page answers the player's three questions: why they are here,
//      whether it can be corrected, and what to do next.
//   4. Both actions work: "Contact support" links to /contact, and "Sign out"
//      goes through the REAL <SignOutButton> (Clerk's signOut is stubbed and
//      the call is recorded) — the restriction itself is never lifted here.
//   5. Copy resolves in all three locales (no raw "accessDenied.*" keys) and the
//      layout holds at 320 / 360 / 390 / 1280 px with touch-sized actions.
//
// Screenshots land in qa/reports/access-denied/.
//
// Run: node qa/access-denied-check.mjs

import esbuild from "esbuild";
import { chromium } from "playwright";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import tailwind from "tailwindcss";
import postcss from "postcss";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = join(root, "qa/reports/access-denied");
mkdirSync(SHOTS, { recursive: true });

const BRAND_BG = "rgb(3, 8, 23)"; // #030817 — the app-wide stage
const ROSE = "rgb(255, 93, 143)"; // #ff5d8f — the denial accent
const GOLD = "rgb(255, 215, 0)"; // #FFD700 — primary action
const OLD_BLUE = "003366";

// ── 1. Bundle the real page (Clerk stubbed, SignOutButton real) ─────────────
const shell = (extra) => `import { createElement, Fragment } from "react";
const Passthrough = (p) => createElement(Fragment, null, p ? p.children : null);
const Null = () => null;
${extra}`;

const NEXT_STUBS = {
  "next/navigation": shell(`export const useRouter = () => ({ push() {}, replace() {}, back() {}, refresh() {}, prefetch() {} });
export const usePathname = () => "/access-denied";
export const redirect = () => {};
export default {};`),
  "next/image": shell(`export default function Image(p) {
  const src = typeof p.src === "string" ? p.src : p.src && p.src.src;
  const { priority, fill, ...rest } = p;
  return createElement("img", { ...rest, src, "data-next-image": "stub" });
}`),
  "next/link": shell(`export default function Link(p) {
  const { href, children, ...rest } = p;
  return createElement("a", { ...rest, href: typeof href === "string" ? href : String(href), "data-next-link": "" }, children);
}`),
  "next/font/google": shell(`export const Inter = () => ({ className: "" }); export default {};`),
  "next/font/local": shell(`export default () => ({ className: "" });`),
};

// Clerk stub that records the sign-out the real SignOutButton performs.
const CLERK_STUB = shell(`export const useUser = () => ({
  isLoaded: true,
  isSignedIn: true,
  user: { id: "user_1", firstName: "Tester", username: "tester", fullName: "Tester Person" },
});
export const useAuth = () => ({ isLoaded: true, isSignedIn: true, userId: "user_1" });
export const useClerk = () => ({
  signOut(opts) { window.__signOuts.push(opts || {}); return Promise.resolve(); },
});
export default { useUser, useAuth, useClerk };`);

const APP_STUBS = new Map([
  [
    "context/LanguageContext",
    shell(
      `export const useLanguage = () => ({ language: window.__lang || "en", setLanguage() {} });\nexport const LanguageProvider = Passthrough;\nexport default { useLanguage, LanguageProvider };`,
    ),
  ],
]);

const outDir = mkdtempSync(join(tmpdir(), "access-denied-"));
await esbuild.build({
  entryPoints: [join(root, "qa/access-denied-harness.jsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  outfile: join(outDir, "harness.js"),
  logLevel: "error",
  absWorkingDir: root,
  define: { "process.env.NODE_ENV": '"development"' },
  loader: { ".png": "js" },
  plugins: [
    {
      name: "qa-stubs",
      setup(build) {
        build.onResolve({ filter: /^next\/|^@clerk\/|^posthog-js\// }, (args) => ({
          path: args.path,
          namespace: "qa-bare",
        }));
        build.onLoad({ filter: /.*/, namespace: "qa-bare" }, (args) => {
          const js = (contents) => ({ contents, loader: "js", resolveDir: root });
          if (NEXT_STUBS[args.path]) return js(NEXT_STUBS[args.path]);
          if (args.path.startsWith("@clerk/")) return js(CLERK_STUB);
          if (args.path.startsWith("posthog-js/"))
            return js(`export const usePostHog = () => null;\nexport default {};`);
          return js(shell(`export default Null;`));
        });
        for (const tail of APP_STUBS.keys()) {
          const escaped = tail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          build.onResolve({ filter: new RegExp(`${escaped}$`) }, () => ({
            path: tail,
            namespace: "qa-app",
          }));
        }
        build.onLoad({ filter: /.*/, namespace: "qa-app" }, (args) => ({
          contents: APP_STUBS.get(args.path),
          loader: "js",
          resolveDir: root,
        }));
        build.onLoad({ filter: /\.(png|jpe?g|webp|gif|svg)$/ }, () => ({
          contents: `export default { src: "/images/logo1.png", width: 612, height: 408 };`,
          loader: "js",
        }));
      },
    },
  ],
});

// ── 2. Real Tailwind CSS (see the precision check for the @import note) ─────
const globals = readFileSync(join(root, "src/app/globals.css"), "utf8").replace(
  /@import url\([^)]*\);\s*/g,
  "",
);
const generated = await postcss([tailwind(join(root, "tailwind.config.js"))]).process(
  globals,
  { from: join(root, "src/app/globals.css") },
);
writeFileSync(join(outDir, "tw.css"), generated.css);
writeFileSync(
  join(outDir, "index.html"),
  `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body><div id="root"></div><script src="./harness.js"></script></body></html>`,
);

// ── 3. Assertions ───────────────────────────────────────────────────────────
let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`);
  ok ? pass++ : fail++;
};

const snapshot = () =>
  page.evaluate(() => {
    const rect = (el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, w: r.width, h: r.height };
    };
    const txt = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim() : null);
    const cs = (el) => (el ? getComputedStyle(el) : null);
    const card = document.querySelector('[class*="rounded-3xl"]');
    const heading = document.querySelector("h1");
    const headingSpan = heading?.querySelector("span");
    const marker = document.querySelector('[role="img"]');
    const contact = document.querySelector('a[href="/contact"]');
    const signOut = [...document.querySelectorAll("button")].find((b) =>
      /Sign out/.test(txt(b) ?? ""),
    );
    const terms = document.querySelector('a[href="/terms"]');
    return {
      vw: window.innerWidth,
      vh: window.innerHeight,
      docScrollWidth: document.documentElement.scrollWidth,
      docClientWidth: document.documentElement.clientWidth,
      stageBg: cs(document.querySelector("section")?.parentElement)?.backgroundColor ?? null,
      cardBg: cs(card)?.backgroundColor ?? null,
      cardBox: card ? rect(card) : null,
      cardBorder: cs(card)?.borderTopColor ?? null,
      legacyBlue: document.querySelectorAll(`[class*="${"003366"}"]`).length,
      legacyErrorRed: [...document.querySelectorAll("*")].filter(
        (el) => cs(el)?.color === "rgb(220, 38, 38)",
      ).length,
      logo: document.querySelector('img[alt="GRYND"]')?.getAttribute("src") ?? null,
      heading: txt(heading),
      headingColor: cs(headingSpan)?.color ?? null,
      headingBox: heading ? rect(heading) : null,
      marker: marker
        ? {
            label: marker.getAttribute("aria-label"),
            text: txt(marker),
            hasSlash: !!marker.querySelector("span[aria-hidden]"),
            box: rect(marker),
          }
        : null,
      badge: txt(document.querySelector("section span.rounded-full")) ?? null,
      subtitle: txt(document.querySelector("h1 + p")) ?? null,
      whyTitle: txt(document.querySelector("ul")?.previousElementSibling) ?? null,
      whyBullets: [...document.querySelectorAll("li")].map((li) => txt(li)).filter(Boolean),
      accountLine: txt(
        [...document.querySelectorAll("span")].find((s) =>
          /^(Signed in as|Connecté|Sesión)/.test(txt(s) ?? ""),
        ) ?? null,
      ),
      contact: contact
        ? { href: contact.getAttribute("href"), text: txt(contact), bg: cs(contact).backgroundColor, box: rect(contact) }
        : null,
      signOut: signOut
        ? { text: txt(signOut), border: cs(signOut).borderTopColor, box: rect(signOut), type: signOut.type }
        : null,
      terms: terms ? { href: terms.getAttribute("href"), text: txt(terms) } : null,
      linkCount: document.querySelectorAll("a").length,
      signOuts: window.__signOuts.length,
    };
  });

let browser = null;
let page = null;
const consoleErrors = [];
const shots = [];

const mount = async (vp) => {
  const p = await browser.newPage({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: vp.dpr,
    hasTouch: vp.dpr > 1,
  });
  p.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));
  p.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (/Failed to load resource|fonts\.googleapis|net::ERR|URL scheme "file"/.test(text)) return;
    consoleErrors.push(`console: ${text}`);
  });
  await p.goto("file://" + join(outDir, "index.html").replace(/\\/g, "/"));
  await p.addStyleTag({ path: join(outDir, "tw.css") });
  await p.waitForFunction(() => typeof window.renderAccessDenied === "function", null, {
    timeout: 20000,
  });
  return p;
};

const render = async (lang) => {
  await page.evaluate((l) => {
    window.__lang = l;
    window.__signOuts = [];
    window.renderAccessDenied();
  }, lang);
  await page.waitForFunction(() => !!document.querySelector("h1"), null, { timeout: 10000 });
  await page.waitForTimeout(450);
};

try {
  browser = await chromium.launch();

  // ── A. Desktop: brand + content + actions ────────────────────────────────
  page = await mount({ width: 1280, height: 900, dpr: 1 });
  console.log("── 1280 × 900 (en) ─────────────────────────");
  await render("en");
  let s = await snapshot();

  check(
    "the page sits on the app-wide dark stage (#030817)",
    s.stageBg === BRAND_BG,
    `stage bg ${s.stageBg}`,
  );
  check(
    "the card is the family's navy glass, not a white one",
    !!s.cardBg && s.cardBg !== "rgb(255, 255, 255)" && /^rgba\(11, 34, 79/.test(s.cardBg),
    `card bg ${s.cardBg}`,
  );
  check(
    "the denial accent is the brand's rose, not a flat error red",
    /^rgba\(255, 93, 143/.test(s.cardBorder ?? "") && s.legacyErrorRed === 0,
    `border ${s.cardBorder}, red-text nodes ${s.legacyErrorRed}`,
  );
  check(
    "the old off-brand #003366 / white-card treatment is gone",
    s.legacyBlue === 0,
    `${s.legacyBlue} legacy nodes`,
  );
  check(
    "the GRYND logo anchors the page",
    s.logo === "/images/logo1.png",
    `logo ${s.logo}`,
  );
  check(
    "the heading uses the family's shimmer-gradient treatment",
    s.heading === "Access denied" && s.headingColor === "rgba(0, 0, 0, 0)",
    `"${s.heading}" color ${s.headingColor}`,
  );
  check(
    "the 18+ reel marker is present and SLASHED (aria-labelled, not decorative)",
    s.marker?.label === "Under 18" &&
      s.marker.text === "18+" &&
      s.marker.hasSlash === true,
    `marker "${s.marker?.text}" label "${s.marker?.label}" slashed ${s.marker?.hasSlash}`,
  );
  check(
    "the copy says WHY the player is blocked",
    /18\+/.test(s.subtitle ?? "") && /under 18/.test(s.subtitle ?? ""),
    `"${s.subtitle}"`,
  );
  check(
    "the page answers \"what you can do\" in three steps",
    s.whyBullets.length === 3 &&
      s.whyBullets.every((b) => b.length > 20 && !b.includes("accessDenied.")) &&
      /contact support/i.test(s.whyBullets[0] ?? ""),
    JSON.stringify(s.whyBullets.map((b) => b.slice(0, 32))),
  );
  check(
    "the page names the restricted account",
    /^Signed in as Tester$/.test(s.accountLine ?? ""),
    `"${s.accountLine}"`,
  );
  check(
    "\"Contact support\" is the gold primary action and points at /contact",
    s.contact?.href === "/contact" && s.contact.bg === GOLD && s.contact.text.includes("Contact support"),
    `href ${s.contact?.href}, bg ${s.contact?.bg}`,
  );
  check(
    "\"Sign out\" is the secondary action, on the rose outline",
    s.signOut?.text === "Sign out" &&
      /^rgba\(255, 93, 143/.test(s.signOut.border ?? "") &&
      s.signOut.type === "button",
    `"${s.signOut?.text}" border ${s.signOut?.border}`,
  );
  check(
    "the footnote links the terms",
    s.terms?.href === "/terms" && (s.terms?.text ?? "").length > 0,
    `${s.terms?.text} → ${s.terms?.href}`,
  );

  // The sign-out action must go through the real SignOutButton wiring.
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((b) =>
      /Sign out/.test(b.textContent || ""),
    );
    btn.click();
  });
  await page.waitForTimeout(400);
  const signOutCalls = await page.evaluate(() => window.__signOuts);
  check(
    "clicking Sign out really triggers Clerk's signOut (redirecting home)",
    signOutCalls.length === 1 && signOutCalls[0].redirectUrl === "/",
    JSON.stringify(signOutCalls),
  );
  await page.screenshot({ path: join(SHOTS, "1280-en.png") });
  shots.push(join(SHOTS, "1280-en.png"));

  // ── B. Locales ───────────────────────────────────────────────────────────    for (const lang of ["fr", "es"]) {
    await render(lang);
    const l = await snapshot();
    // Labelled so a missing/unlabelled field names itself instead of just
    // lowering a count.
    const strings = {
      heading: l.heading,
      subtitle: l.subtitle,
      badge: l.badge,
      whatTitle: l.whyTitle,
      contact: l.contact?.text,
      signOut: l.signOut?.text,
      terms: l.terms?.text,
      account: l.accountLine,
      why1: l.whyBullets[0],
      why2: l.whyBullets[1],
      why3: l.whyBullets[2],
    };
    const missing = Object.entries(strings)
      .filter(([, v]) => !v)
      .map(([k]) => k);
    const leaked = Object.entries(strings)
      .filter(([, v]) => v && v.includes("accessDenied."))
      .map(([k]) => k);
    check(
      `${lang}: every string resolves to real translated copy (no "accessDenied.*" leaks)`,
      missing.length === 0 && leaked.length === 0,
      missing.length ? `empty: ${missing.join(", ")}` : `leaked keys: ${leaked.join(", ")}`,
    );
    check(
      `${lang}: the translation still names the 18+ rule`,
      /18/.test([l.subtitle, ...l.whyBullets].join(" ")),
      `"${l.subtitle?.slice(0, 60)}…"`,
    );
  }

  // ── C. Phones ────────────────────────────────────────────────────────────
  for (const vp of [
    { label: "360", width: 360, height: 640, dpr: 2 },
    { label: "320", width: 320, height: 568, dpr: 2 },
    { label: "390", width: 390, height: 844, dpr: 3 },
  ]) {
    page = await mount(vp);
    console.log(`── ${vp.label} × ${vp.height} (en) ─────────────────────────`);
    await render("en");
    const m = await snapshot();

    check(
      `${vp.label}: nothing scrolls sideways`,
      m.docScrollWidth <= m.docClientWidth + 1,
      `scrollWidth ${m.docScrollWidth} vs ${m.docClientWidth}`,
    );
    check(
      `${vp.label}: the card fits the viewport width`,
      m.cardBox.left >= -1 && m.cardBox.right <= m.vw + 1,
      `card ${Math.round(m.cardBox.left)}..${Math.round(m.cardBox.right)} of ${m.vw}`,
    );
    check(
      `${vp.label}: both actions are touch-sized (>= 44px tall) and inside the card`,
      m.contact.box.h >= 44 &&
        m.signOut.box.h >= 44 &&
        m.contact.box.bottom <= m.cardBox.bottom + 1 &&
        m.signOut.box.bottom <= m.cardBox.bottom + 1,
      `contact ${Math.round(m.contact.box.h)}px, sign-out ${Math.round(m.signOut.box.h)}px`,
    );
    check(
      `${vp.label}: the slashed 18+ marker and heading are above the fold`,
      m.marker.box.bottom <= m.vh && m.headingBox.bottom <= m.vh,
      `marker bottom ${Math.round(m.marker.box.bottom)}, heading bottom ${Math.round(m.headingBox.bottom)} of ${m.vh}`,
    );
    check(
      `${vp.label}: still no sideways scroll with the whole card laid out`,
      m.docScrollWidth <= m.docClientWidth + 1,
      `scrollWidth ${m.docScrollWidth} vs ${m.docClientWidth}`,
    );
    await page.screenshot({ path: join(SHOTS, `${vp.label}-en.png`) });
    shots.push(join(SHOTS, `${vp.label}-en.png`));
    await page.close();
  }

  check(
    "no page/console errors anywhere in the run",
    consoleErrors.length === 0,
    consoleErrors.slice(0, 3).join(" | "),
  );
} finally {
  if (browser) await browser.close();
}

console.log(`\nScreenshots written to qa/reports/access-denied/ (${shots.length} files)`);
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
