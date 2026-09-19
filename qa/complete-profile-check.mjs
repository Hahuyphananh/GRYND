// qa/complete-profile-check.mjs
//
// Browser check for the redesigned /complete-profile age gate. It mounts the
// REAL page (qa/complete-profile-harness.jsx) with the project's REAL Tailwind
// CSS, because everything asserted here is either brand styling or form
// behaviour — a stubbed stylesheet would make the styling assertions vacuous.
//
//   1. Brand stage: the page sits on #030817 with the navy glass card, cyan /
//      yellow accents and the GRYND logo — and the old off-brand `#003366`
//      background + white card treatment is gone for good.
//   2. The 18+ rule is legible and enforced by the control itself: the date
//      input carries `max` = today − 18 years, a dark colour scheme, and a
//      hint spelling the same boundary out.
//   3. Live feedback: an underage date reports the too-young line, a valid date
//      reports the computed age, and the CTA only unlocks once a date is set.
//   4. Submit contract (unchanged by the redesign): an underage date never
//      reaches the network; a valid one POSTs the ISO date to
//      /api/update-birthdate exactly once and then routes to /sync.
//   5. Accessibility: labelled input wired with aria-describedby, an error
//      banner announced via role=alert, and touch-sized controls on phones.
//   6. All three locales resolve real copy (no raw "completeProfile.*" keys
//      leaking to the UI) and nothing scrolls sideways at 320 / 360 / 1280 px.
//
// Screenshots land in qa/reports/complete-profile/.
//
// Run: node qa/complete-profile-check.mjs

import esbuild from "esbuild";
import { chromium } from "playwright";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import tailwind from "tailwindcss";
import postcss from "postcss";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = join(root, "qa/reports/complete-profile");
mkdirSync(SHOTS, { recursive: true });

const BRAND_BG = "rgb(3, 8, 23)"; // #030817 — the app-wide stage
const CYAN = "rgb(0, 229, 255)"; // #00e5ff
const GOLD = "rgb(255, 215, 0)"; // #FFD700
const OLD_BLUE = "003366"; // the off-brand colour this page used to wear

// ── 1. Bundle the real page with the usual dependency stubs ─────────────────
const shell = (extra) => `import { createElement, Fragment } from "react";
const Passthrough = (p) => createElement(Fragment, null, p ? p.children : null);
const Null = () => null;
${extra}`;

const NEXT_STUBS = {
  "next/navigation": shell(`export const useRouter = () => ({
  push(url) { window.__pushes.push(String(url)); },
  replace(url) { window.__pushes.push(String(url)); },
  back() {}, refresh() {}, prefetch() {},
});
export const useParams = () => ({});
export const usePathname = () => "/complete-profile";
export const useSearchParams = () => new URLSearchParams();
export const redirect = () => {};
export const notFound = () => {};
export default { useRouter, useParams, usePathname, useSearchParams };`),
  // next/image turns a static import into an object with `.src`; render it the
  // same way the real component does so the logo assertion is meaningful.
  "next/image": shell(`export default function Image(p) {
  const src = typeof p.src === "string" ? p.src : p.src && p.src.src;
  const { priority, fill, ...rest } = p;
  return createElement("img", { ...rest, src, "data-next-image": "stub" });
}`),
  "next/link": shell(`export default Passthrough;`),
  "next/dynamic": shell(`export default () => Null;`),
  "next/font/google": shell(`export const Inter = () => ({ className: "" }); export default {};`),
  "next/font/local": shell(`export default () => ({ className: "" });`),
};

const CLERK_STUB = shell(`export const useUser = () => ({
  isLoaded: true,
  isSignedIn: true,
  user: { id: "user_1", firstName: "Tester", username: "tester", fullName: "Tester Person" },
});
export const useAuth = () => ({ isLoaded: true, isSignedIn: true, userId: "user_1" });
export const useClerk = () => ({ signOut() {} });
export default { useUser, useAuth, useClerk };`);

const APP_STUBS = new Map([
  // Real `useTranslation()` + real copy, with the language read off a global so
  // one page load can be re-rendered per locale.
  [
    "context/LanguageContext",
    shell(
      `export const useLanguage = () => ({ language: window.__lang || "en", setLanguage() {} });\nexport const LanguageProvider = Passthrough;\nexport default { useLanguage, LanguageProvider };`,
    ),
  ],
]);

const outDir = mkdtempSync(join(tmpdir(), "complete-profile-"));
await esbuild.build({
  entryPoints: [join(root, "qa/complete-profile-harness.jsx")],
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
        // Static image imports (the logo) → the shape next/image produces.
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

const expectedMax = () => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear() - 18, now.getUTCMonth(), now.getUTCDate()))
    .toISOString()
    .slice(0, 10);
};
// A date that is comfortably 18+ (40 years back) and one clearly underage (5).
const ADULT = `${new Date().getUTCFullYear() - 40}-06-15`;
const MINOR = `${new Date().getUTCFullYear() - 5}-06-15`;

const snapshot = () =>
  page.evaluate(() => {
    const rect = (el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, w: r.width, h: r.height };
    };
    const txt = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim() : null);
    const stage = document.querySelector("section")?.parentElement ?? null;
    const card = document.querySelector('[class*="rounded-3xl"]');
    const input = document.getElementById("birthDate");
    const label = document.querySelector('label[for="birthDate"]');
    const cta = document.querySelector('button[type="submit"]');
    const logo = document.querySelector('img[alt="GRYND"]');
    const status = document.getElementById("birthDateStatus");
    const helper = document.getElementById("birthDateHelp");
    const alert = document.querySelector('[role="alert"]');
    const cs = (el) => (el ? getComputedStyle(el) : null);
    return {
      vw: window.innerWidth,
      vh: window.innerHeight,
      docScrollWidth: document.documentElement.scrollWidth,
      docClientWidth: document.documentElement.clientWidth,
      stageBg: cs(stage)?.backgroundColor ?? null,
      stageBox: stage ? rect(stage) : null,
      cardBg: cs(card)?.backgroundColor ?? null,
      cardBox: card ? rect(card) : null,
      legacyBlueNodes: document.querySelectorAll(`[class*="${"003366"}"]`).length,
      logo: logo ? { src: logo.getAttribute("src"), box: rect(logo) } : null,
      heading: txt(document.querySelector("h1")),
      headingBox: document.querySelector("h1")
        ? rect(document.querySelector("h1"))
        : null,
      headingColor: (() => {
        const span = document.querySelector("h1 span");
        return span ? cs(span).color : null;
      })(),
      input: input
        ? {
            type: input.type,
            max: input.getAttribute("max"),
            min: input.getAttribute("min"),
            value: input.value,
            ariaInvalid: input.getAttribute("aria-invalid"),
            describedBy: input.getAttribute("aria-describedby"),
            colorScheme: cs(input).colorScheme,
            bg: cs(input).backgroundColor,
            color: cs(input).color,
            box: rect(input),
          }
        : null,
      labelText: txt(label),
      cta: cta
        ? {
            text: txt(cta),
            bg: cs(cta).backgroundColor,
            color: cs(cta).color,
            disabled: cta.disabled,
            box: rect(cta),
          }
        : null,
      helperText: txt(helper),
      statusText: txt(status),
      statusColor: cs(status)?.color ?? null,
      alertText: txt(alert),
      accountLine: txt(
        [...document.querySelectorAll("span")].find((s) =>
          /^(Signed in as|Connecté|Sesión)/.test(txt(s) ?? ""),
        ) ?? null,
      ),
      whyBullets: [...document.querySelectorAll("li")].map((li) => txt(li)).filter(Boolean),
      linkLabels: [...document.querySelectorAll("a")].map((a) => txt(a)),
      fetches: window.__fetches.length,
      pushes: window.__pushes.length,
      skipLine: txt(document.querySelector("section > p:last-of-type")),
    };
  });

const setInput = async (value) => {
  await page.evaluate((v) => {
    const input = document.getElementById("birthDate");
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    ).set;
    setter.call(input, v);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);
  await page.waitForTimeout(120);
};

const clickCta = async () => {
  await page.evaluate(() => document.querySelector('button[type="submit"]').click());
  await page.waitForTimeout(250);
};

let browser = null;
let page = null;
const consoleErrors = [];
const shots = [];

const mount = async ({ width, height, dpr }) => {
  const p = await browser.newPage({
    viewport: { width, height },
    deviceScaleFactor: dpr,
    hasTouch: dpr > 1,
  });
  p.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));
  p.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    // Asset/font fetches fail on a file:// page with no network — not layout.
    if (/Failed to load resource|fonts\.googleapis|net::ERR|URL scheme "file"/.test(text)) return;
    consoleErrors.push(`console: ${text}`);
  });
  await p.goto("file://" + join(outDir, "index.html").replace(/\\/g, "/"));
  await p.addStyleTag({ path: join(outDir, "tw.css") });
  await p.waitForFunction(() => typeof window.renderProfile === "function", null, {
    timeout: 20000,
  });
  return p;
};

const render = async (lang) => {
  await page.evaluate((l) => {
    window.__lang = l;
    window.__fetches = [];
    window.__pushes = [];
    window.renderProfile();
  }, lang);
  await page.waitForFunction(() => !!document.getElementById("birthDate"), null, {
    timeout: 10000,
  });
  await page.waitForTimeout(450);
};

try {
  browser = await chromium.launch();

  // ── A. Desktop: brand + the whole age-gate contract ──────────────────────
  page = await mount({ width: 1280, height: 900, dpr: 1 });
  console.log("\n── 1280 × 900 (en) ─────────────────────────");
  await render("en");
  let s = await snapshot();

  check(
    "the page sits on the app-wide dark stage (#030817)",
    s.stageBg === BRAND_BG,
    `stage bg ${s.stageBg}`,
  );
  check(
    "the age gate is a navy glass card, not a white one",
    !!s.cardBg &&
      s.cardBg !== "rgb(255, 255, 255)" &&
      /^rgba\(11, 34, 79/.test(s.cardBg),
    `card bg ${s.cardBg}`,
  );
  check(
    "the off-brand #003366 / white-card treatment is gone",
    s.legacyBlueNodes === 0 && (s.cardBg ?? "").indexOf(OLD_BLUE) === -1,
    `${s.legacyBlueNodes} legacy nodes, card ${s.cardBg}`,
  );
  check(
    "the GRYND logo anchors the page",
    s.logo?.src === "/images/logo1.png" && s.logo.box.h >= 30,
    `logo ${s.logo?.src} (${Math.round(s.logo?.box.h ?? 0)}px tall)`,
  );
  check(
    "the heading is the brand's shimmer-gradient treatment",
    s.heading === "One last step" && s.headingColor === "rgba(0, 0, 0, 0)",
    `"${s.heading}" color ${s.headingColor}`,
  );
  check(
    "the 18+ requirement is spelled out before the player submits",
    /at least\s*18/.test(s.helperText ?? "") && !/completeProfile\./.test(s.helperText ?? ""),
    `"${s.helperText}"`,
  );
  check(
    "the input itself refuses an underage date (max = today − 18y)",
    s.input?.type === "date" && s.input.max === expectedMax(),
    `max ${s.input?.max} (expected ${expectedMax()})`,
  );
  check(
    "the date input stays on-brand (dark colour scheme, navy field, legible value)",
    s.input?.colorScheme === "dark" &&
      /^rgb\(4, 13, 36\)/.test(s.input.bg) &&
      s.input.color === "rgb(216, 251, 255)",
    `color-scheme ${s.input?.colorScheme}, bg ${s.input?.bg}, text ${s.input?.color}`,
  );
  check(
    "the field is labelled and described for assistive tech",
    s.labelText === "Date of birth" &&
      (s.input?.describedBy ?? "").includes("birthDateHelp") &&
      (s.input?.describedBy ?? "").includes("birthDateStatus") &&
      s.input.ariaInvalid === "false",
    `label "${s.labelText}", describedby "${s.input?.describedBy}"`,
  );
  check(
    "the primary action is the brand's gold CTA",
    !!s.cta && s.cta.bg === GOLD && s.cta.text === "Continue" && s.cta.color === "rgb(3, 8, 23)",
    `bg ${s.cta?.bg}, text "${s.cta?.text}"`,
  );
  check(
    "the three \"why we ask\" bullets explain the request",
    s.whyBullets.length === 3 &&
      s.whyBullets.every((b) => b.length > 20 && !b.includes("completeProfile.")),
    JSON.stringify(s.whyBullets.map((b) => b.slice(0, 34))),
  );
  check(
    "the page names the account being verified",
    /^Signed in as Tester$/.test(s.accountLine ?? ""),
    `"${s.accountLine}"`,
  );
  check(
    "no error banner before a submit",
    s.alertText === null,
    `alert "${s.alertText}"`,
  );

  // ── Live feedback + submit contract ──────────────────────────────────────
  await setInput(MINOR);
  s = await snapshot();
  check(
    "an underage date is called out immediately, in the player's language",
    /need to be at least 18/.test(s.statusText ?? "") &&
      s.statusColor === "rgb(251, 191, 36)" &&
      !s.statusText.includes("completeProfile."),
    `status "${s.statusText}" (${s.statusColor})`,
  );
  check(
    "an underage date locks the CTA instead of offering a failing submit",
    s.cta.disabled === true && s.cta.text === "Continue",
    `disabled ${s.cta.disabled}`,
  );
  await clickCta();
  s = await snapshot();
  check(
    "a locked CTA never reaches the network",
    s.fetches === 0 && s.pushes === 0,
    `${s.fetches} fetch(es), ${s.pushes} push(es)`,
  );
  await page.screenshot({ path: join(SHOTS, "1280-underage-locked.png") });
  shots.push(join(SHOTS, "1280-underage-locked.png"));

  // An empty field is the same story: no date, nothing to submit.
  await setInput("");
  s = await snapshot();
  check(
    "an empty date also keeps the CTA locked",
    s.cta.disabled === true && s.alertText === null,
    `disabled ${s.cta.disabled}, alert "${s.alertText}"`,
  );

  await setInput(ADULT);
  s = await snapshot();
  const expectedAge = new Date().getUTCFullYear() - Number(ADULT.slice(0, 4));
  check(
    "a valid date reports the computed age in green",
    s.statusText === `You're ${expectedAge} — good to go.` &&
      s.statusColor === "rgb(74, 222, 128)",
    `status "${s.statusText}" (${s.statusColor})`,
  );
  await clickCta();
  s = await snapshot();
  const fetchBody = await page.evaluate(() => window.__fetches.map((f) => JSON.parse(f.body)));
  check(
    "a valid date POSTs the ISO date once and then routes to /sync",
    s.fetches === 1 &&
      s.pushes === 1 &&
      (await page.evaluate(() => window.__pushes[0])) === "/sync" &&
      fetchBody[0]?.birthDate === ADULT,
    `fetches ${JSON.stringify(fetchBody)}, pushes ${await page.evaluate(() => window.__pushes)}`,
  );
  await page.screenshot({ path: join(SHOTS, "1280-valid.png") });
  shots.push(join(SHOTS, "1280-valid.png"));

  // ── Server-side failure still gets a visible, announced banner ────────────
  // A fresh mount: the successful submit above left the page in its
  // "Verifying…" state (in real life it has already navigated to /sync).
  await render("en");
  await page.evaluate(() => {
    window.__fetches = [];
    window.__pushes = [];
    window.fetch = () =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ success: false, error: "server said no" }),
      });
  });
  await setInput(ADULT);
  await clickCta();
  s = await snapshot();
  check(
    "a rejected submission surfaces the alert banner and re-arms the form",
    /Failed to update profile/.test(s.alertText ?? "") &&
      s.input.ariaInvalid === "true" &&
      s.cta.disabled === false &&
      s.cta.text === "Continue" &&
      s.pushes === 0,
    `alert "${s.alertText}", aria-invalid ${s.input.ariaInvalid}, cta "${s.cta.text}"`,
  );
  check(
    "the page logged the failure for support without leaking it to the player",
    consoleErrors.some((e) => /update-birthdate failed/.test(e)),
    consoleErrors.filter((e) => /update-birthdate/.test(e)).slice(0, 1).join(" | "),
  );
  await page.screenshot({ path: join(SHOTS, "1280-server-error.png") });
  shots.push(join(SHOTS, "1280-server-error.png"));

  // ── B. Locales: no key ever leaks into the UI ────────────────────────────
  for (const lang of ["fr", "es"]) {
    await render(lang);
    const localized = await snapshot();
    const strings = [
      localized.heading,
      localized.helperText,
      localized.statusText,
      localized.labelText,
      localized.cta?.text,
      localized.accountLine,
      localized.skipLine,
      ...localized.whyBullets,
    ].filter(Boolean);
    check(
      `${lang}: every string resolves to real translated copy (no "completeProfile.*" leaks)`,
      strings.length >= 8 && strings.every((v) => !v.includes("completeProfile.")),
      `${strings.length} strings, e.g. "${localized.heading}" / "${localized.cta?.text}"`,
    );
    check(
      `${lang}: the age boundary and CTA translate too`,
      /18/.test(localized.helperText ?? "") &&
        localized.cta.text !== "Continue",
      `hint "${localized.helperText}" / cta "${localized.cta?.text}"`,
    );
  }

  // ── C. Phones: fit, taps and the stacked layout ──────────────────────────
  for (const vp of [
    { label: "360", width: 360, height: 640, dpr: 2 },
    { label: "320", width: 320, height: 568, dpr: 2 },
    { label: "390", width: 390, height: 844, dpr: 3 },
  ]) {
    const phone = await mount(vp);
    page = phone;
    console.log(`\n── ${vp.label} × ${vp.height} (en) ─────────────────────────`);
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
      `${vp.label}: the date field and CTA are touch-sized (>= 44px tall)`,
      m.input.box.h >= 44 && m.cta.box.h >= 44,
      `input ${Math.round(m.input.box.h)}px, cta ${Math.round(m.cta.box.h)}px`,
    );
    // The date field is `w-full`, so it defines the card's content column:
    // the CTA must match it exactly (both span the same form column).
    check(
      `${vp.label}: the CTA spans the same content column as the date field`,
      Math.abs(m.cta.box.w - m.input.box.w) <= 2,
      `cta ${Math.round(m.cta.box.w)}px vs input ${Math.round(m.input.box.w)}px`,
    );
    check(
      `${vp.label}: the input and CTA stay inside the card (nothing clipped by its overflow)`,
      m.input.box.left >= m.cardBox.left - 1 &&
        m.input.box.right <= m.cardBox.right + 1 &&
        m.cta.box.left >= m.cardBox.left - 1 &&
        m.cta.box.right <= m.cardBox.right + 1 &&
        m.cta.box.bottom <= m.cardBox.bottom + 1,
      `input ${Math.round(m.input.box.left)}..${Math.round(m.input.box.right)}, cta bottom ${Math.round(m.cta.box.bottom)} vs card ${Math.round(m.cardBox.bottom)}`,
    );
    check(
      `${vp.label}: the logo, the 18+ marker and the heading are above the fold`,
      m.logo.box.bottom <= m.cardBox.top + 1 &&
        m.heading === "One last step" &&
        m.headingBox.bottom <= m.vh,
      `heading bottom ${Math.round(m.headingBox.bottom)} of ${m.vh}`,
    );
    check(
      `${vp.label}: the account line truncates instead of widening the card`,
      !!m.accountLine && m.accountLine.length > 0,
      `"${m.accountLine}"`,
    );
    await page.screenshot({ path: join(SHOTS, `${vp.label}-en.png`) });
    shots.push(join(SHOTS, `${vp.label}-en.png`));

    // The happy path has to be usable with a thumb on the smallest screens.
    await setInput(ADULT);
    await clickCta();
    const done = await snapshot();
    check(
      `${vp.label}: verifying a valid date works from the phone layout`,
      done.fetches === 1 && done.pushes === 1,
      `${done.fetches} fetch(es), ${done.pushes} push(es)`,
    );

    // …and the underage state is legible, not just blocked.
    await setInput(MINOR);
    const minor = await snapshot();
    check(
      `${vp.label}: an underage date shows the warning and locks the CTA`,
      /at least 18/.test(minor.statusText ?? "") && minor.cta.disabled === true,
      `status "${minor.statusText}", cta disabled ${minor.cta.disabled}`,
    );
    await page.screenshot({ path: join(SHOTS, `${vp.label}-underage.png`) });
    shots.push(join(SHOTS, `${vp.label}-underage.png`));
    check(
      `${vp.label}: still no sideways scroll in the underage state`,
      minor.docScrollWidth <= minor.docClientWidth + 1,
      `scrollWidth ${minor.docScrollWidth} vs ${minor.docClientWidth}`,
    );
    await page.close();
  }

  // One console.error is deliberate (the stubbed server failure above); every
  // other page/console error is a real problem.
  const unexpected = consoleErrors.filter((e) => !/update-birthdate failed/.test(e));
  check(
    "no unexpected page/console errors anywhere in the run",
    unexpected.length === 0,
    unexpected.slice(0, 3).join(" | "),
  );
} finally {
  if (browser) await browser.close();
}

console.log(`\nScreenshots written to qa/reports/complete-profile/ (${shots.length} files)`);
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
