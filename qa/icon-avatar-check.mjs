// qa/icon-avatar-check.mjs
//
// Verifies the IconAvatar stuck-fallback fix in a real browser:
//   1. Mount IconAvatar with iconKey="default" — /icons/default.webp does not
//      exist, so the img 404s and the letter-avatar fallback shows.
//   2. Re-render the SAME mounted instance with iconKey="gryndicon1" — the
//      asset exists, so the avatar must switch to the real image.
// Before the fix the component kept its `failed=true` state and stayed on the
// letter avatar forever (the profile pfp "not changing" bug).
//
// Run: node qa/icon-avatar-check.mjs

import { chromium } from "playwright";
import esbuild from "esbuild";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ICONS_DIR = join(root, "public", "icons");

// 1. Bundle the harness + real IconAvatar (react bundled in, no externals).
const outDir = mkdtempSync(join(tmpdir(), "icon-avatar-"));
const bundleOut = join(outDir, "harness.js");
const result = esbuild.buildSync({
  entryPoints: [join(root, "qa/icon-avatar-harness.jsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  outfile: bundleOut,
  logLevel: "error",
  absWorkingDir: root,
});
const harnessJs = readFileSync(bundleOut, "utf8");

const pageHtml = `<!doctype html>
<html><head><meta charset="utf-8"><title>IconAvatar check</title></head>
<body><div id="root"></div><script src="/harness.js"></script></body></html>`;

// 2. Tiny static server: /icons/<key>.webp served from public/icons (404 when
//    missing — exactly like production for default.webp), / for the page,
//    /harness.js for the bundle.
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
  if (url.pathname.startsWith("/icons/")) {
    const file = join(ICONS_DIR, url.pathname.replace("/icons/", ""));
    if (existsSync(file)) {
      res.writeHead(200, { "Content-Type": "image/webp" });
      res.end(readFileSync(file));
      return;
    }
    res.writeHead(404);
    res.end("not found");
    return;
  }
  res.writeHead(404);
  res.end("not found");
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`);
  ok ? pass++ : fail++;
};

try {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(base, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.renderIcon);

  // Step 1: mount with the default icon (asset missing -> letter fallback).
  await page.evaluate(() =>
    window.renderIcon({ iconKey: "default", name: "Default" })
  );
  await page.waitForFunction(() => {
    const rootEl = document.getElementById("root");
    return rootEl && rootEl.querySelector("span") && !rootEl.querySelector("img");
  });
  const letterShown = await page.evaluate(() => {
    const el = document.getElementById("root").querySelector("span");
    return el ? el.textContent : null;
  });
  check("default icon shows letter-avatar fallback (asset missing)", letterShown === "D", `letter=${letterShown}`);

  // Step 2: re-render the SAME instance with gryndicon1 (asset exists).
  await page.evaluate(() =>
    window.renderIcon({ iconKey: "gryndicon1", name: "Grynd Icon 1" })
  );
  await page.waitForFunction(
    () => {
      const rootEl = document.getElementById("root");
      const img = rootEl && rootEl.querySelector("img");
      return img && img.complete && img.naturalWidth > 0 && img.getAttribute("src") === "/icons/gryndicon1.webp";
    },
    null,
    { timeout: 5000 }
  );
  const imgState = await page.evaluate(() => {
    const img = document.getElementById("root").querySelector("img");
    return img
      ? { src: img.getAttribute("src"), naturalWidth: img.naturalWidth, letterStillShown: !!document.getElementById("root").querySelector("span") }
      : null;
  });
  check(
    "switching to gryndicon1 shows the real image (fallback cleared)",
    imgState && imgState.naturalWidth > 0 && imgState.letterStillShown === false,
    JSON.stringify(imgState)
  );

  // Step 3: switch BACK to a missing asset -> letter fallback returns; then
  // to another existing icon -> image returns. Guards against a one-shot fix.
  await page.evaluate(() => window.renderIcon({ iconKey: "gryndicon2", name: "Grynd Icon 2" }));
  await page.waitForFunction(() => {
    const rootEl = document.getElementById("root");
    const img = rootEl && rootEl.querySelector("img");
    return img && img.complete && img.naturalWidth > 0 && img.getAttribute("src") === "/icons/gryndicon2.webp";
  }, null, { timeout: 5000 });
  check("switching again to gryndicon2 also shows the image", true);

  await page.evaluate(() => window.renderIcon({ iconKey: "default", name: "Default" }));
  await page.waitForFunction(() => {
    const rootEl = document.getElementById("root");
    return rootEl && rootEl.querySelector("span") && !rootEl.querySelector("img");
  });
  check("switching back to default returns to letter fallback", true);

  await page.evaluate(() => window.renderIcon({ iconKey: "gryndicon1", name: "Grynd Icon 1" }));
  await page.waitForFunction(() => {
    const rootEl = document.getElementById("root");
    const img = rootEl && rootEl.querySelector("img");
    return img && img.complete && img.naturalWidth > 0 && img.getAttribute("src") === "/icons/gryndicon1.webp";
  }, null, { timeout: 5000 });
  const finalState = await page.evaluate(() => {
    const img = document.getElementById("root").querySelector("img");
    return img ? { src: img.getAttribute("src"), naturalWidth: img.naturalWidth } : null;
  });
  check("final switch back to gryndicon1 shows the image", finalState && finalState.naturalWidth > 0, JSON.stringify(finalState));

  await browser.close();
} finally {
  server.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);