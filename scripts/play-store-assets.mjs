/**
 * scripts/play-store-assets.mjs
 *
 * Generates the Google Play listing artwork from the REAL app:
 *
 *   play-store/feature-graphic.jpg       1024 x 500
 *   play-store/screenshots/NN-*.jpg      1080 x 1920 each
 *
 * WHY THIS SCRIPT EXISTS
 * `screenshots/` and `light-mode-screenshots/` are web-QA captures: desktop
 * sizes, browser chrome, and whatever overlay the QA run left on screen. Play
 * rejects those — it wants a phone aspect ratio (between 2:1 and 1:2, long edge
 * at least 1080px) of the actual product. This drives the locally installed
 * Chrome against a running dev server at a 9:16 viewport, dismisses the consent
 * banner and any onboarding tour, and shoots exactly the viewport.
 *
 * WHY JPEG
 * Play accepts JPEG or 24-bit PNG *without* an alpha channel. Chrome's PNG
 * encoder always emits RGBA, and this repo has no image library (no sharp, no
 * canvas) to flatten it, so the screenshots are JPEG at q95 — spec-compliant,
 * and visually indistinguishable on UI at these sizes.
 *
 * WHY THE FEATURE GRAPHIC IS HTML
 * It is composed in a 1024x500 page built from the app's own palette
 * (--gr-surface-page #030817, the brand yellow and cyan) and the shipped logo,
 * then screenshotted at exactly the required size. No design tool, no binary
 * asset to keep in sync, and regenerating it after a rebrand is one command.
 *
 * USAGE
 *   npm run dev                 # in another terminal, with .env.local present
 *   npm run assets:play-store
 *
 *   PLAY_ASSETS_BASE=http://localhost:3001 npm run assets:play-store
 */

import puppeteer from "puppeteer-core";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const BASE = process.env.PLAY_ASSETS_BASE || "http://localhost:3000";

const OUT_DIR = "play-store";
const SHOT_DIR = "play-store/screenshots";
const QUALITY = 95;

/** Play: phone screenshots, 9:16, long edge 1920. */
const SHOT_WIDTH = 1080;
const SHOT_HEIGHT = 1920;

/**
 * A real Android viewport rendered at 3x.
 *
 * The CSS width MUST be phone-sized. A 1080px-wide viewport is a DESKTOP
 * viewport: it activates the md/lg breakpoints and yields a desktop page with
 * a phone's pixel dimensions — technically 1080x1920, and nothing like what the
 * installed app shows. 360x640 at deviceScaleFactor 3 is exactly 1080x1920
 * physical pixels of the mobile layout.
 */
const VIEWPORT = { width: 360, height: 640, deviceScaleFactor: 3 };

/**
 * The Capacitor shell's User-Agent (`appendUserAgent: 'GRYNDApp/1.0'` in
 * capacitor.config.ts). Presenting it here makes the server render what the app
 * actually receives — no AdSense tag, no ad slot, no coin offers — so the
 * listing shows the real in-app experience rather than the website's, and the
 * capture exercises the native gates in src/lib/native/shell.ts for free.
 */
const SHELL_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/126.0.0.0 Mobile Safari/537.36 GRYNDApp/1.0";

/** Play: feature graphic, exactly 1024x500. */
const GRAPHIC_WIDTH = 1024;
const GRAPHIC_HEIGHT = 500;

/**
 * The screens, in listing order. Each is a public route that renders the real
 * product without a session — a signed-out reviewer sees exactly this.
 */
const SCREENS = [
  // `scroll` is CSS pixels. These pages open with a tall hero, so an unscrolled
  // 9:16 capture is mostly empty band under the header — the offset parks the
  // section worth showing just below the fixed nav. It is framing, not a crop:
  // the whole frame is still the real page.
  { slug: "01-home-ranked-solitaire", path: "/", scroll: 95 },
  { slug: "02-practice-vs-bots", path: "/play/ai", scroll: 125 },
  // The daily headline is a three-phrase lockup that wraps badly at 360px, so
  // this frame starts at the challenge card, which is the actual feature.
  { slug: "03-daily-challenge", path: "/daily", scroll: 270 },
  { slug: "04-six-ways-to-play", path: "/play", scroll: 95 },
  { slug: "05-grynd-pro", path: "/upgrade-pro", scroll: 95 },
];

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);

function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("Chrome not found. Set CHROME_PATH to your Chrome binary.");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Clear the things that are not the product: the cookie/consent banner, the
 * onboarding tour, a "what's new" modal. Clicking is always preferred to
 * hiding — a click leaves the app in a real state; hiding is the fallback for
 * an overlay that has no dismiss control we recognise.
 */
async function settle(page) {
  // Hydration + first paint of the board. The app talks to sockets for some
  // surfaces, so `networkidle` is not a usable signal — it can never settle.
  await page.evaluate(() => document.fonts?.ready);
  await sleep(3500);

  // The Next.js dev-tools badge ("1 Issue") is not part of the product and
  // must never appear in a store listing screenshot.
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });

  const DISMISS =
    /^(accept( all)?|agree|allow( all)?|got it|ok(ay)?|continue|skip|not now|maybe later|close|dismiss|i understand|start playing|play now)$/i;

  for (let pass = 0; pass < 3; pass += 1) {
    const clicked = await page.evaluate((pattern) => {
      const re = new RegExp(pattern, "i");
      const candidates = [...document.querySelectorAll('button, [role="button"], a[href="#"]')];
      const hit = candidates.find((el) => {
        const label = (el.textContent || "").trim();
        if (!re.test(label)) return false;
        const box = el.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) return false;
        // Only interactive overlays — never a nav link that happens to say "Play now".
        const style = getComputedStyle(el);
        return style.pointerEvents !== "none" && style.visibility !== "hidden";
      });
      if (!hit) return false;
      hit.click();
      return true;
    }, DISMISS.source);

    if (!clicked) break;
    await sleep(900);
  }

  // Fallback: a docked consent/onboarding panel with no recognisable button.
  // Restricted to overlays whose own text is about consent, so the fixed bottom
  // tab bar and real dialogs are never touched.
  await page.evaluate(() => {
    for (const el of document.querySelectorAll("body *")) {
      const style = getComputedStyle(el);
      if (style.position !== "fixed") continue;
      const box = el.getBoundingClientRect();
      if (box.height < window.innerHeight * 0.15) continue;
      if (!/cookie|consent|advertis|privacy/i.test(el.textContent || "")) continue;
      el.style.display = "none";
    }
  });

  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(400);
}

/** Feature graphic HTML, composed from the app's own tokens. */
function featureGraphicHtml(logoDataUri) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body {
    width: ${GRAPHIC_WIDTH}px; height: ${GRAPHIC_HEIGHT}px; overflow: hidden;
    /* --gr-surface-page, the app's own page colour */
    background: #030817;
    font-family: ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif;
    color: #ffffff;
  }
  .stage {
    position: relative; width: 100%; height: 100%;
    background:
      radial-gradient(760px 380px at 82% 18%, rgba(0, 229, 255, 0.18), transparent 68%),
      radial-gradient(620px 420px at 8% 96%, rgba(245, 255, 59, 0.12), transparent 70%),
      linear-gradient(160deg, #030817 0%, #061326 58%, #0a1b33 100%);
    padding: 52px 60px;
    display: flex; align-items: center; justify-content: space-between; gap: 40px;
  }
  /* Hairline grid, so the flat area does not read as dead space. */
  .stage::before {
    content: ""; position: absolute; inset: 0; pointer-events: none;
    background-image:
      linear-gradient(to right, rgba(255,255,255,0.045) 1px, transparent 1px),
      linear-gradient(to bottom, rgba(255,255,255,0.045) 1px, transparent 1px);
    background-size: 64px 64px;
    mask-image: radial-gradient(600px 300px at 50% 50%, #000 30%, transparent 92%);
  }
  .copy { position: relative; max-width: 596px; }
  .logo { height: 46px; width: auto; display: block; margin-bottom: 26px; }
  .eyebrow {
    font-size: 15px; font-weight: 800; letter-spacing: 0.24em; text-transform: uppercase;
    color: #00e5ff; margin-bottom: 14px;
  }  h1 {
    font-size: 48px; line-height: 1.06; font-weight: 900; letter-spacing: -0.02em;
    color: #ffffff;
  }
  h1 em { font-style: normal; color: #f5ff3b; }
  .sub {
    margin-top: 20px; font-size: 21px; line-height: 1.45; font-weight: 500;
    color: rgba(205, 220, 239, 0.92);
  }
  .fan { position: relative; width: 300px; height: 340px; flex: none; }
  .card {
    position: absolute; top: 0; left: 0;
    width: 176px; height: 252px; border-radius: 16px;
    background: linear-gradient(180deg, #ffffff 0%, #eef4ff 100%);
    box-shadow: 0 26px 60px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(255, 255, 255, 0.18) inset;
  }
  .card .corner {
    position: absolute; font-weight: 800; font-size: 27px; line-height: 1;
    display: flex; flex-direction: column; align-items: center; gap: 2px;
  }
  .card .corner span { font-size: 22px; }
  .card .tl { top: 13px; left: 13px; }
  .card .br { bottom: 13px; right: 13px; transform: rotate(180deg); }
  .card .pip {
    position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
    font-size: 92px; line-height: 1; opacity: 0.92;
  }
  .red { color: #d61f3a; }
  .black { color: #0b1626; }
  .back {
    background:
      repeating-linear-gradient(45deg, #123a5e 0 8px, #0d2a45 8px 16px);
    border: 3px solid #1d5c8c;
  }
  .c1 { transform: rotate(-15deg) translate(6px, 26px); }
  .c2 { transform: rotate(0deg) translate(58px, 6px); }
  .c3 { transform: rotate(15deg) translate(112px, 30px); }
  .chip {
    position: absolute; left: 34px; bottom: -6px;
    padding: 10px 18px; border-radius: 999px;
    background: rgba(245, 255, 59, 0.14);
    border: 1px solid rgba(245, 255, 59, 0.55);
    color: #f5ff3b; font-size: 15px; font-weight: 800; letter-spacing: 0.16em;
    text-transform: uppercase; white-space: nowrap;
  }
</style>
</head>
<body>
  <div class="stage">
    <div class="copy">
      <img class="logo" src="${logoDataUri}" alt="GRYND" />
      <div class="eyebrow">Ranked &middot; 1 v 1</div>
      <h1>Klondike Solitaire.<br />Two players. <em>One deal.</em></h1>
      <p class="sub">A free ranked ladder, AI practice and a new daily challenge &mdash; results verified by the server.</p>
    </div>
    <div class="fan">
      <div class="card back c1"></div>
      <div class="card c2">
        <div class="corner tl">K<span class="black">&spades;</span></div>
        <div class="pip black">&spades;</div>
        <div class="corner br">K<span>&spades;</span></div>
      </div>
      <div class="card c3">
        <div class="corner tl">A<span class="red">&hearts;</span></div>
        <div class="pip red">&hearts;</div>
        <div class="corner br">A<span>&hearts;</span></div>
      </div>
      <div class="chip">Server-verified</div>
    </div>
  </div>
</body>
</html>`;
}

/** Read width/height out of a JPEG's SOFn marker (no image library needed). */
function jpegSize(buffer) {
  let offset = 2;
  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    // SOF0..SOF3, SOF5..SOF7, SOF9..SOF11, SOF13..SOF15 carry the frame header.
    const isFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    const length = buffer.readUInt16BE(offset + 2);
    if (isFrame) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  throw new Error("could not read JPEG dimensions");
}

const chromePath = findChrome();
mkdirSync(SHOT_DIR, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: true,
  args: [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--force-color-profile=srgb",
    "--hide-scrollbars",
  ],
});

const written = [];
let failures = 0;

try {
  for (const screen of SCREENS) {
    const page = await browser.newPage();
    try {
      await page.setViewport({ ...VIEWPORT, isMobile: true, hasTouch: true });
      await page.setUserAgent(SHELL_UA);
      // Deterministic output: dark theme, no animation frames mid-flight.
      await page.emulateMediaFeatures([
        { name: "prefers-color-scheme", value: "dark" },
        { name: "prefers-reduced-motion", value: "reduce" },
      ]);

      const response = await page.goto(`${BASE}${screen.path}`, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
      if (!response || response.status() !== 200) {
        throw new Error(`HTTP ${response ? response.status() : "no response"}`);
      }

      // Guard against shooting the wrong app: another dev server can hold the
      // port (a Remotion studio answered 200 on every path in this repo and
      // produced a full set of screenshots of itself). The title is the only
      // reliable tell that this is GRYND, not something else on the port.
      const title = await page.title();
      if (!/grynd/i.test(title)) {
        throw new Error(
          `"${BASE}" is not GRYND (page title: "${title}") — another server owns that port; ` +
            "set PLAY_ASSETS_BASE to the Next dev server"
        );
      }

      await settle(page);

      if (screen.scroll) {
        await page.evaluate((offset) => window.scrollTo(0, offset), screen.scroll);
        await sleep(700);
      }

      const file = `${SHOT_DIR}/${screen.slug}.jpg`;
      await page.screenshot({ path: file, type: "jpeg", quality: QUALITY });
      const { width, height } = jpegSize(readFileSync(file));
      if (width !== SHOT_WIDTH || height !== SHOT_HEIGHT) {
        throw new Error(`expected ${SHOT_WIDTH}x${SHOT_HEIGHT}, got ${width}x${height}`);
      }
      written.push({ file, width, height });
      console.log(`✔ ${screen.path} → ${file} (${width}x${height})`);
    } catch (error) {
      failures += 1;
      console.error(`✖ ${screen.path}: ${error.message}`);
    } finally {
      await page.close();
    }
  }

  // ── Feature graphic ────────────────────────────────────────────────────
  const page = await browser.newPage();
  try {
    await page.setViewport({
      width: GRAPHIC_WIDTH,
      height: GRAPHIC_HEIGHT,
      deviceScaleFactor: 1,
    });

    // The shipped wordmark, embedded as a data URI so the graphic never depends
    // on the dev server serving /images/*.
    const logoPath = [
      "public/images/navbar-logo.png",
      "public/images/smalllogo.png",
      "public/icon-512.png",
    ].find((candidate) => existsSync(candidate));
    if (!logoPath) throw new Error("no logo asset found for the feature graphic");
    const logo = readFileSync(logoPath).toString("base64");
    await page.setContent(featureGraphicHtml(`data:image/png;base64,${logo}`), {
      waitUntil: "load",
    });
    await page.evaluate(() => document.fonts?.ready);
    await sleep(300);

    const file = `${OUT_DIR}/feature-graphic.jpg`;
    await page.screenshot({ path: file, type: "jpeg", quality: QUALITY });
    const { width, height } = jpegSize(readFileSync(file));
    if (width !== GRAPHIC_WIDTH || height !== GRAPHIC_HEIGHT) {
      throw new Error(`expected ${GRAPHIC_WIDTH}x${GRAPHIC_HEIGHT}, got ${width}x${height}`);
    }
    written.push({ file, width, height });
    console.log(`✔ feature graphic → ${file} (${width}x${height})`);
  } catch (error) {
    failures += 1;
    console.error(`✖ feature graphic: ${error.message}`);
  } finally {
    await page.close();
  }
} finally {
  await browser.close();
}

writeFileSync(
  `${OUT_DIR}/README.md`,
  `# Play Store listing assets

Generated by \`npm run assets:play-store\` (\`scripts/play-store-assets.mjs\`)
against a locally running dev server. Re-run it after a visual change — do not
hand-edit these files.

| File | Size | Play requirement |
|---|---|---|
| \`feature-graphic.jpg\` | 1024 × 500 | Required. Shown at the top of the store listing. |
| \`screenshots/*.jpg\` | 1080 × 1920 (9:16) | 2–8 phone screenshots; long edge ≥ 1080px. |

JPEG is used deliberately: Play accepts JPEG or 24-bit PNG **without alpha**,
and Chrome's PNG encoder always emits an alpha channel.

Upload order matters — \`01-home-ranked-solitaire\` is the first thing a visitor
sees on the listing.
`
);

console.log(`\n${written.length}/${SCREENS.length + 1} assets written to ${OUT_DIR}/`);

if (failures > 0) {
  console.error(`${failures} asset(s) FAILED — is \`npm run dev\` running on ${BASE}?`);
  process.exit(1);
}
