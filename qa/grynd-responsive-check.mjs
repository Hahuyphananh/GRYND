#!/usr/bin/env node
// qa/grynd-responsive-check.mjs
//
// Responsive audit for the DEPLOYED GRYND app: loads the pages a guest can
// actually open on a phone and measures the rendered layout in Chrome.
//
//   node qa/grynd-responsive-check.mjs
//   node qa/grynd-responsive-check.mjs --base=https://www.grynd.dedyn.io --verbose
//
// What it reports per page:
//   * horizontal overflow (the page scrolls sideways)
//   * elements that stick out past the right edge of the viewport
//   * interactive targets smaller than 24x24 CSS px (WCAG 2.5.8 minimum)
//   * text rendered below 12px
//   * images wider than the screen
//
// Read-only: it only issues GETs and never signs in, so authenticated screens
// are out of scope by construction.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { launchChrome, openPage, sleep } from "../standalone/chess-ai/scripts/lib/browser.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const found = argv.find((entry) => entry.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
};

const BASE = option("base", process.env.GRYND_BASE || "https://www.grynd.dedyn.io").replace(/\/$/, "");
const VERBOSE = argv.includes("--verbose");

const PAGES = [
  "/",
  "/games",
  "/games/chess",
  "/games/memory-grid",
  "/play/dominoes",
  "/play/chess",
  "/sign-in",
  "/sign-up",
  "/terms",
];

const VIEWPORTS = [
  { name: "phone 390x844", width: 390, height: 844, dpr: 3, mobile: true },
  { name: "small phone 360x640", width: 360, height: 640, dpr: 2, mobile: true },
];

const MEASURE = `(() => {
  const vw = window.innerWidth;
  const doc = document.documentElement;
  const describe = (el) => {
    const id = el.id ? "#" + el.id : "";
    const cls = typeof el.className === "string" && el.className.trim()
      ? "." + el.className.trim().split(/\\s+/).slice(0, 2).join(".")
      : "";
    const text = (el.getAttribute("aria-label") || el.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 40);
    return el.tagName.toLowerCase() + id + cls + (text ? " [" + text + "]" : "");
  };
  const visible = (el) => {
    // SVG geometry (rect/g/line in the logo and mascot artwork) is not layout:
    // its bounding boxes legitimately sit outside the CSS box model.
    if (el.namespaceURI === "http://www.w3.org/2000/svg") return false;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || cs.opacity === "0") return false;
    // A 1x1 clipped element is the "skip to content" pattern, not a control.
    if (r.width <= 1 || r.height <= 1) return false;
    return true;
  };

  const inScroller = (el) => {
    for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
      const overflow = getComputedStyle(node).overflowX;
      if (overflow === "auto" || overflow === "scroll" || overflow === "hidden") return true;
    }
    return false;
  };

  const interactive = [...document.querySelectorAll('button, a[href], input:not([type="hidden"]), select, textarea, [role="button"]')]
    .filter(visible)
    .map((el) => {
      const r = el.getBoundingClientRect();
      return { el: describe(el), w: Math.round(r.width), h: Math.round(r.height) };
    });

  const overflowing = [...document.querySelectorAll("body *")]
    .filter((el) => {
      if (!visible(el)) return false;
      const cs = getComputedStyle(el);
      if (cs.position === "fixed" || cs.position === "absolute") return false;
      // A horizontal carousel is allowed to hold items off-screen.
      if (inScroller(el)) return false;
      return el.getBoundingClientRect().right > vw + 1;
    })
    .slice(0, 12)
    .map(describe);

  const tinyText = [...document.querySelectorAll("p, span, li, a, button, label, small, div")]
    .filter((el) => {
      if (!visible(el)) return false;
      if (!el.textContent || !el.textContent.trim()) return false;
      return parseFloat(getComputedStyle(el).fontSize) < 12;
    })
    .slice(0, 10)
    .map((el) => ({ el: describe(el), size: getComputedStyle(el).fontSize }));

  const wideImages = [...document.images]
    .filter((img) => visible(img) && img.getBoundingClientRect().right > vw + 1)
    .slice(0, 6)
    .map((img) => describe(img) + " " + Math.round(img.getBoundingClientRect().width) + "px");

  return {
    vw,
    vh: window.innerHeight,
    scrollW: doc.scrollWidth,
    scrollH: doc.scrollHeight,
    viewportMeta: !!document.querySelector('meta[name="viewport"]'),
    interactiveCount: interactive.length,
    under24: interactive.filter((t) => t.w < 24 || t.h < 24),
    under40: interactive.filter((t) => t.w < 40 || t.h < 40),
    overflowing,
    tinyText,
    wideImages,
    title: document.title,
    h1: document.querySelector("h1") ? document.querySelector("h1").textContent.trim().slice(0, 60) : null,
  };
})()`;

const findings = [];
const pages = [];

const chrome = await launchChrome();
const page = await openPage(chrome.ws);
try {
  await page.send("Network.enable");
  await page.send("Page.enable");
  await page.send("Runtime.enable");

  for (const viewport of VIEWPORTS) {
    await page.send("Emulation.setDeviceMetricsOverride", {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: viewport.dpr,
      mobile: viewport.mobile,
    });
    await page.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });

    for (const path of PAGES) {
      const url = `${BASE}${path}`;
      try {
        await page.navigate(url);
        await page.until("document.readyState", "document.readyState === 'complete'", 30_000);
        await sleep(1200);

        const box = await page.evaluate(MEASURE);
        const record = { viewport: viewport.name, path, url, ...box };
        pages.push(record);

        const note = (message) => findings.push({ viewport: viewport.name, path, message });
        if (!box.viewportMeta) note("no viewport meta tag");
        if (box.scrollW > box.vw + 1) {
          note(`horizontal overflow: scrollWidth ${box.scrollW} > ${box.vw}`);
        }
        if (box.overflowing.length) {
          note(`elements past the right edge: ${box.overflowing.slice(0, 4).join(" | ")}`);
        }
        if (box.under24.length) {
          note(
            `${box.under24.length} target(s) under 24px: ` +
              box.under24.slice(0, 4).map((t) => `${t.el} ${t.w}x${t.h}`).join(" | ")
          );
        }
        if (box.tinyText.length) {
          note(`text under 12px on: ${box.tinyText.slice(0, 3).map((t) => t.el).join(" | ")}`);
        }
        if (box.wideImages.length) {
          note(`images wider than the screen: ${box.wideImages.join(" | ")}`);
        }

        console.log(
          `${viewport.name.padEnd(20)} ${path.padEnd(20)} ${String(box.scrollW).padStart(4)}/${box.vw}  ` +
            `targets ${String(box.interactiveCount).padStart(3)}  <24px ${String(box.under24.length).padStart(2)}  ` +
            `<40px ${String(box.under40.length).padStart(2)}  text<12 ${box.tinyText.length}`
        );
        if (VERBOSE && box.under40.length) {
          console.log(
            `    dense targets: ${box.under40.slice(0, 8).map((t) => `${t.el} ${t.w}x${t.h}`).join(" | ")}`
          );
        }
      } catch (error) {
        const message = String(error && error.message ? error.message : error);
        findings.push({ viewport: viewport.name, path, message: `failed to load: ${message}` });
        console.log(`${viewport.name} ${path} FAILED: ${message}`);
      }
    }
  }
} finally {
  page.close();
  await chrome.close();
}

mkdirSync(join(ROOT, "dist/qa"), { recursive: true });
writeFileSync(
  join(ROOT, "dist/qa/grynd-responsive.json"),
  JSON.stringify({ base: BASE, pages: pages.length, findings, report: pages }, null, 2)
);

const overflow = findings.filter((f) => f.message.includes("overflow") || f.message.includes("right edge"));
const tiny = findings.filter((f) => f.message.includes("under 24px"));

console.log("\nProduction responsive audit —", BASE);
console.log("-".repeat(72));
console.log(`pages measured      ${pages.length}`);
console.log(`layout findings     ${findings.length}`);
console.log(`horizontal overflow ${overflow.length}`);
console.log(`sub-24px targets    ${tiny.length}`);
console.log("report              dist/qa/grynd-responsive.json\n");

process.exit(overflow.length > 0 ? 1 : 0);
