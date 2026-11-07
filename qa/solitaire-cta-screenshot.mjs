#!/usr/bin/env node
// qa/solitaire-cta-screenshot.mjs
//
// Captures the documentation image for the GRYND CTA:
// `docs/images/solitaire-duel-victory-cta.png`.
//
// It is a screenshot of the real thing, not a mock-up. The itch-shaped package is
// built (CTA on, no portal SDK) and served; a real match is started in Chrome;
// and the shipped `ResultScreen` component — rendered with a settled Victory — is
// mounted over it. The component, its copy, its classes and the stylesheet in the
// image are the bytes `package:itch:solitaire` produces.
//
// A Victory cannot be reached by scripted play (the deal has to be solved), so
// the result panel itself is rendered directly and injected into the live page.
// The board behind it, and the header above it, are a running match.
//
// Run: node --import tsx qa/solitaire-cta-screenshot.mjs
// Requires Chrome (CHROME_PATH is honoured) and puppeteer-core.

import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import puppeteer from "puppeteer-core";

import * as resultScreenModule from "../standalone/solitaire-duel/src/ResultScreen.tsx";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_DIR = join(ROOT, "dist/portal/solitaire-duel");
const OUT_FILE = join(ROOT, "docs/images/solitaire-duel-victory-cta.png");
const VITE_BIN = join(ROOT, "node_modules/vite/bin/vite.js");
const VITE_CONFIG = join(ROOT, "standalone/solitaire-duel/vite.config.mts");

/** The CTA the itch package is built with (scripts/package-itch-solitaire.mjs). */
const CTA_URL = "https://www.grynd.dedyn.io/sign-in";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  join(process.env.LOCALAPPDATA ?? "", "Google/Chrome/Application/chrome.exe"),
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// ── 1. Build the package the itch upload uses ────────────────────────────
if (!existsSync(VITE_BIN)) throw new Error("vite is not installed — run `npm install` first.");

const build = spawnSync(process.execPath, [VITE_BIN, "build", "--config", VITE_CONFIG], {
  cwd: ROOT,
  stdio: "inherit",
  env: { ...process.env, PORTAL_CTA: "on", PORTAL_CTA_URL: CTA_URL, PORTAL_SDK: "none" },
});
if (build.status !== 0) throw new Error(`the standalone build failed (exit ${build.status}).`);
if (!existsSync(join(PACKAGE_DIR, "index.html"))) throw new Error("the build produced no index.html.");
if (!readdirSync(join(PACKAGE_DIR, "assets")).some((name) => name.endsWith(".css"))) {
  throw new Error("the build produced no stylesheet.");
}

// ── 2. The result panel exactly as the package renders it ────────────────
const ResultScreen = resultScreenModule?.default?.default ?? resultScreenModule?.default;
if (typeof ResultScreen !== "function") throw new Error("ResultScreen did not load.");

const overlay = renderToStaticMarkup(
  React.createElement(ResultScreen, {
    outcome: "VICTORY",
    resolution: "finish",
    durationLabel: "1:42",
    playerProgress: { foundationCards: 52, revealedTableau: 31, progressPercent: 100 },
    botProgress: { foundationCards: 44, revealedTableau: 27, progressPercent: 85 },
    botLabel: "Bot · Normal",
    cta: {
      ctaEnabled: true,
      ctaUrl: CTA_URL,
      ctaQuestion: "Want to track your stats and compete in ranked games?",
      ctaLabel: "Sign in to GRYND",
    },
    onReplay: () => {},
    onChangeDifficulty: () => {},
  }),
);

if (!overlay.includes(CTA_URL) || !overlay.includes("Sign in to GRYND")) {
  throw new Error("the rendered panel has no CTA — nothing to screenshot.");
}

// ── 3. Serve the package ─────────────────────────────────────────────────
const server = createServer((req, res) => {
  const requested = decodeURIComponent((req.url ?? "/").split("?")[0]);
  const safe = normalize(requested).replace(/^([/\\])+/, "");
  let file = join(PACKAGE_DIR, safe || "index.html");
  if (!file.startsWith(PACKAGE_DIR)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
  if (!existsSync(file)) {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
});

await new Promise((done) => server.listen(0, "127.0.0.1", done));
const BASE = `http://127.0.0.1:${server.address().port}`;

// ── 4. Play a real match, then mount the Victory panel over it ───────────
const chromePath = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
if (!chromePath) throw new Error("Chrome not found — set CHROME_PATH to a Chrome/Chromium binary.");

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: true,
  args: ["--no-first-run", "--no-default-browser-check", "--disable-extensions", "--mute-audio"],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 2 });

  await page.goto(`${BASE}/index.html`, { waitUntil: "load" });
  await page.waitForSelector('[data-testid="start-race"]');
  await page.click('[data-testid="start-race"]');
  await page.waitForSelector('[data-testid="solitaire-board"]');

  // Wait for GO, so the countdown veil is gone and the board is live.
  await page.waitForFunction(
    () => {
      const stock = document.querySelector('[data-testid="solitaire-stock"]');
      return !!stock && !stock.disabled;
    },
    { timeout: 20_000 },
  );

  // One draw, so the board shows a match that has actually been played.
  await page.click('[data-testid="solitaire-stock"]').catch(() => {});
  await sleep(400);

  // Mount the shipped result panel (rendered above) over the live board.
  await page.evaluate((markup) => document.body.insertAdjacentHTML("beforeend", markup), overlay);
  await page.waitForSelector('[data-testid="grynd-cta"]');
  await sleep(250);

  mkdirSync(dirname(OUT_FILE), { recursive: true });
  await page.screenshot({ path: OUT_FILE });

  const details = await page.evaluate(() => ({
    outcome: document.querySelector('[data-testid="result-outcome"]')?.textContent?.trim(),
    cta: document.querySelector('[data-testid="grynd-cta-link"]')?.getAttribute("href"),
  }));
  console.log(`\nPASS  ${OUT_FILE}`);
  console.log(`  · Victory panel over a live match — outcome ${details.outcome}, CTA ${details.cta}`);
} finally {
  await browser.close();
  server.close();
}
