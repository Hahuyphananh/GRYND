// Phase 12 read-only browser QA for the streak surfaces.
//
// Mounts the real rewards page, real cosmetics picker, and real classement page
// with stubbed APIs. No database or player account is touched.
//
// Run: node qa/streak-phase12-check.mjs
//
// Outputs screenshots to qa/reports/streak-phase12/ and exits non-zero when a
// concrete assertion fails.

import esbuild from "esbuild";
import postcss from "postcss";
import tailwindcss from "@tailwindcss/postcss";
import autoprefixer from "autoprefixer";
import { chromium } from "playwright";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "streak-phase12-"));
const REPORTS = join(root, "qa", "reports", "streak-phase12");
mkdirSync(REPORTS, { recursive: true });

const STUBS = {
  "@clerk/nextjs": `
    const signedIn = window.__PHASE12_SIGNED_IN !== false;
    const user = { id: "user_phase12", username: "QA Player", imageUrl: null, fullName: "QA Player" };
    export const useUser = () => ({ isLoaded: true, isSignedIn: signedIn, user });
    export const useAuth = () => ({ isLoaded: true, isSignedIn: signedIn, userId: signedIn ? "user_phase12" : null });
    export const useClerk = () => ({ signOut() {} });
    export const ClerkProvider = ({ children }) => children ?? null;
    export default {};
  `,
  "next/link": `
    import React from "react";
    export default function Link({ href, children, ...rest }) {
      return React.createElement("a", { href: typeof href === "string" ? href : "#", ...rest }, children);
    }
  `,
  "next/navigation": `
    const router = { push(){}, replace(){}, back(){}, refresh(){}, prefetch(){} };
    export const useRouter = () => router;
    export const usePathname = () => window.location.pathname;
    export const useSearchParams = () => new URLSearchParams(window.location.search);
    export default { useRouter, usePathname, useSearchParams };
  `,
  "next/image": `
    import React from "react";
    export default function Img({ src, alt, width, height, className, style }) {
      const url = typeof src === "string" ? src : src?.src;
      return React.createElement("img", { src: url, alt: alt ?? "", width, height, className, style });
    }
  `,
  "posthog-js/react": `export const usePostHog = () => null; export default {};`,
  "components/navigation-bar": `export default function Nav() { return null; }`,
  "components/Footer": `export default function Footer() { return null; }`,
  "components/InteractiveCasinoBg": `
    import React from "react";
    export default function Bg() {
      return React.createElement("div", {
        "data-testid": "qa-casino-bg",
        className: "absolute inset-0 z-0 bg-page",
      });
    }
  `,
  "components/share/ShareLadderButton": `export default function Share() { return null; }`,
  "components/UpgradeProButton": `export default function Upgrade() { return null; }`,
  "components/reports/ReportEntryButton": `export default function Report() { return null; }`,
  "components/states/AsyncState": `
    import React from "react";
    export default function AsyncState({ children, isLoading, error, isEmpty, empty, skeleton }) {
      if (isLoading) return skeleton ?? React.createElement("div", null, "Loading");
      if (error) return React.createElement("div", { role: "alert" }, String(error.message || error));
      if (isEmpty) return empty ?? React.createElement("div", null, "Empty");
      return children;
    }
  `,
};

const stubKeys = Object.keys(STUBS);
const normalized = (value) => value.replace(/\\/g, "/");
const matchStubKey = (specifier, resolveDir) => {
  for (const key of stubKeys) {
    if (specifier === key || specifier.endsWith("/" + key)) return key;
  }
  if (!specifier.startsWith(".")) return null;
  const absolute = normalized(join(resolveDir, specifier));
  for (const key of stubKeys) {
    if (absolute.endsWith("/" + key)) return key;
  }
  return null;
};

await esbuild.build({
  entryPoints: [join(root, "qa/streak-phase12-harness.jsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  loader: { ".js": "jsx" },
  outfile: join(outDir, "harness.js"),
  logLevel: "error",
  absWorkingDir: root,
  define: { "process.env.NODE_ENV": '"development"' },
  banner: {
    js: 'var process = { env: { NODE_ENV: "development" }, platform: "browser", browser: true, version: "v0.0.0" };',
  },
  plugins: [
    {
      name: "streak-stubs",
      setup(build) {
        build.onResolve({ filter: /.*/ }, (args) => {
          const key = matchStubKey(args.path, args.resolveDir);
          if (!key) return null;
          return { path: key, namespace: "streak-stub" };
        });
        build.onLoad({ filter: /.*/, namespace: "streak-stub" }, (args) => ({
          contents: STUBS[args.path],
          loader: "jsx",
          resolveDir: root,
        }));
      },
    },
  ],
});

const compiled = await postcss([tailwindcss(), autoprefixer()]).process(
  readFileSync(join(root, "src/app/globals.css"), "utf8"),
  { from: join(root, "src/app/globals.css") },
);
writeFileSync(
  join(outDir, "app.css"),
  compiled.css.replace(/@import\s+url\(["']?https?:\/\/[^)]*\);?/g, ""),
);
writeFileSync(
  join(outDir, "index.html"),
  `<!doctype html>
<html data-theme="dark" class="dark"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Streak Phase 12 QA</title>
<link rel="stylesheet" href="./app.css">
<style>html,body,#root{background:#030817;color:#d8fbff;min-height:100%;}</style></head>
<body class="antialiased bg-page text-[#d8fbff]"><div id="root"></div><script src="./harness.js"></script></body></html>`,
);

const server = createServer((req, res) => {
  const rawPath = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  const file = new Map([
    ["/index.html", "index.html"],
    ["/app.css", "app.css"],
    ["/harness.js", "harness.js"],
  ]).get(rawPath);
  if (!file) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  try {
    const body = readFileSync(join(outDir, file));
    res.writeHead(200, {
      "Content-Type": rawPath.endsWith(".css")
        ? "text/css"
        : rawPath.endsWith(".js")
          ? "text/javascript"
          : "text/html",
    });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}/index.html`;

let pass = 0;
let fail = 0;
const failures = [];
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`);
  if (ok) pass += 1;
  else {
    fail += 1;
    failures.push({ name, extra });
  }
};

const browser = await chromium.launch();
const screenshots = [];

async function open({ viewport, lang = "en", query = "", signedIn = true, localStorage = {} }) {
  const context = await browser.newContext({ viewport, reducedMotion: "no-preference" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error.message)));
  page.on("console", (message) => {
    // The QA file server intentionally only serves the harness bundle; missing
    // decorative assets are a 403 from this server, not an app exception.
    if (message.type() === "error" && !/Failed to load resource/.test(message.text())) {
      errors.push(message.text());
    }
  });
  await page.addInitScript(
    ({ language, isSignedIn, values }) => {
      window.localStorage.setItem("casino_app_language", language);
      for (const [key, value] of Object.entries(values)) {
        window.localStorage.setItem(key, value);
      }
      window.__PHASE12_SIGNED_IN = isSignedIn;
    },
    { language: lang, isSignedIn: signedIn, values: localStorage },
  );
  await page.goto(`${origin}?${query}`);
  await page.waitForTimeout(900);
  return { context, page, errors };
}

async function shot(page, name) {
  const path = join(REPORTS, `${name}.png`);
  await page.screenshot({ path, fullPage: true });
  screenshots.push(path);
}

const viewports = [
  ["desktop", { width: 1280, height: 900 }],
  ["tablet", { width: 768, height: 1024 }],
  ["mobile", { width: 390, height: 844 }],
  ["small", { width: 320, height: 568 }],
];

// ── Rewards: main states, all viewports ───────────────────────────────────
for (const [label, viewport] of viewports) {
  const { context, page, errors } = await open({ viewport, query: "screen=rewards&current=100" });
  const card = page.getByTestId("streak-milestones-card");
  await card.waitFor({ state: "visible", timeout: 10000 });
  const text = await card.innerText();
  const textLower = text.toLowerCase();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  const thresholds = await page.locator("[data-testid^='streak-milestone-']").count();
  const rewardDays = await page.locator("[data-testid]").evaluateAll((nodes) =>
    nodes.filter((node) => /^streak-reward-\d+$/.test(node.getAttribute("data-testid") || "")).length,
  );
  const ownedEquipButtons = await page.locator("[data-testid^='streak-reward-action-']").count();
  const glowPreview = await page.locator("[data-testid='streak-reward-preview-glow_streak_frost']").count();
  const namePreview = await page.locator("[data-testid='streak-reward-preview-username_streak_centurion']").count();

  check(`${label}: rewards card renders`, await card.isVisible());
  check(`${label}: no horizontal overflow`, overflow <= 1, `overflow=${overflow}px`);
  check(`${label}: all 17 milestones rendered`, thresholds === 17, `count=${thresholds}`);
  check(`${label}: all reward milestones rendered`, rewardDays === 17, `count=${rewardDays}`);
  check(`${label}: current/best/next visible`, /current streak/.test(textLower) && /best streak/.test(textLower) && /next milestone/.test(textLower));
  check(`${label}: multiple day-30 rewards visible`, /emerald/.test(textLower) && /royal emerald/.test(textLower) && /emerald & gold/.test(textLower));
  check(`${label}: glow and username previews render`, glowPreview === 1 && namePreview === 1);
  check(`${label}: owned rewards expose equip actions`, ownedEquipButtons > 0, `buttons=${ownedEquipButtons}`);
  check(`${label}: no runtime errors`, errors.length === 0, errors.slice(0, 2).join(" | "));
  await shot(page, `rewards-${label}`);
  await context.close();
}

// ── Reward-only next milestone (day 150 → day 180) ───────────────────────
{
  const { context, page } = await open({
    viewport: { width: 390, height: 844 },
    query: "screen=rewards&current=150",
  });
  const card = page.getByTestId("streak-milestones-card");
  await card.waitFor({ state: "visible", timeout: 10000 });
  await page.waitForTimeout(700);
  const text = (await card.innerText()).toLowerCase();
  check("rewards: next milestone includes reward-only day 180", /next milestone[\s\S]*180 days[\s\S]*reward milestone/.test(text), text.slice(0, 300));
  check("rewards: reward-only milestone is not mislabeled with a title", !text.includes("180 days — vault elite"));
  check("rewards: day 180 milestone card is present", (await page.getByTestId("streak-milestone-180").count()) === 1);
  await context.close();
}

// ── Rewards card equipment controls ───────────────────────────────────────
{
  const { context, page, errors } = await open({
    viewport: { width: 390, height: 844 },
    query: "screen=rewards&current=100",
    localStorage: { phase12_equipment: JSON.stringify({}) },
  });
  const glowAction = page.getByTestId("streak-reward-action-glow_streak_frost");
  await glowAction.waitFor({ state: "visible", timeout: 10000 });
  check("rewards equipment: owned item starts unequipped", (await glowAction.innerText()).toLowerCase().includes("equip"));
  await glowAction.click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="streak-reward-action-glow_streak_frost"]')?.textContent?.toLowerCase().includes("unequip"),
    { timeout: 5000 },
  );
  check("rewards equipment: equip action updates the card", (await glowAction.innerText()).toLowerCase().includes("unequip"));
  check("rewards equipment: equipped badge is visible", /Equipped/i.test(await page.getByTestId("streak-milestones-card").innerText()));
  await glowAction.click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="streak-reward-action-glow_streak_frost"]')?.textContent?.toLowerCase().includes("equip"),
    { timeout: 5000 },
  );
  check("rewards equipment: unequip restores the equip action", !(await glowAction.innerText()).toLowerCase().includes("unequip"));

  const titleAction = page.getByTestId("streak-reward-action-title_centurion");
  await titleAction.click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="streak-reward-action-title_centurion"]')?.textContent?.toLowerCase().includes("unequip"),
    { timeout: 5000 },
  );
  check("rewards equipment: title equips and exposes unequip", (await titleAction.innerText()).toLowerCase().includes("unequip"));
  check("rewards equipment: no runtime errors", errors.length === 0, errors.slice(0, 2).join(" | "));
  await context.close();
}

// ── Board slots: felt, card back and deck equip/unequip from the card ─────
{
  const { context, page, errors } = await open({
    viewport: { width: 390, height: 844 },
    query: "screen=rewards&current=180",
    localStorage: { phase12_equipment: JSON.stringify({}) },
  });
  for (const id of ["felt_slate", "card_back_carbon", "deck_grandmaster"]) {
    const action = page.getByTestId(`streak-reward-action-${id}`);
    await action.waitFor({ state: "visible", timeout: 10000 });
    await action.click();
    await page.waitForFunction((testId) => {
      const node = document.querySelector(`[data-testid="streak-reward-action-${testId}"]`);
      return node?.textContent?.trim().toLowerCase().includes("unequip");
    }, id, { timeout: 5000 });
    check(`rewards equipment: ${id} equips`, (await action.innerText()).toLowerCase().includes("unequip"));
    await action.click();
    await page.waitForFunction((testId) => {
      const node = document.querySelector(`[data-testid="streak-reward-action-${testId}"]`);
      return node?.textContent?.trim().toLowerCase() === "equip";
    }, id, { timeout: 5000 });
    check(`rewards equipment: ${id} unequips`, (await action.innerText()).trim().toLowerCase() === "equip");
  }
  check("rewards equipment: board slots have no runtime errors", errors.length === 0, errors.slice(0, 2).join(" | "));
  await context.close();
}

// ── Loading / empty / error / signed-out states ───────────────────────────
{
  const { context, page } = await open({ viewport: { width: 390, height: 844 }, query: "screen=rewards&scenario=loading" });
  await page.waitForTimeout(300);
  const text = await page.locator("body").innerText();
  check("loading: loading copy is present", /Loading your streak/.test(text));
  await shot(page, "rewards-loading-mobile");
  await context.close();
}
{
  const { context, page } = await open({ viewport: { width: 390, height: 844 }, query: "screen=rewards&scenario=error" });
  await page.waitForTimeout(800);
  const text = await page.locator("body").innerText();
  check("error: retry state is present", /isn't available/.test(text) && /Try again/.test(text));
  await shot(page, "rewards-error-mobile");
  await context.close();
}
{
  const { context, page } = await open({ viewport: { width: 390, height: 844 }, query: "screen=rewards", signedIn: false });
  await page.waitForTimeout(500);
  const text = await page.locator("body").innerText();
  check("signed out: sign-in prompt is present", /Sign in/.test(text) && /start a streak/.test(text));
  await shot(page, "rewards-signed-out-mobile");
  await context.close();
}

// ── Equipment: equip, unequip, persistence, locked state ──────────────────
{
  const { context, page, errors } = await open({
    viewport: { width: 390, height: 844 },
    query: "screen=equipment",
    localStorage: { phase12_equipment: JSON.stringify({}) },
  });
  const modal = page.getByRole("dialog");
  await modal.waitFor({ state: "visible", timeout: 10000 });
  const dialogText = await modal.innerText();
  check("equipment: picker opens", await modal.isVisible());
  check("equipment: frame, glow and username categories render", /Profile Frame/.test(dialogText) && /Profile Glow/.test(dialogText) && /Username Effect/.test(dialogText));
  check("equipment: locked reward is not offered", !dialogText.includes("Eternal Profile Glow"));

  const frost = page.getByRole("button", { name: /Frost Profile Glow/ });
  await frost.click();
  await page.waitForFunction(() => document.querySelector('button[aria-pressed="true"]')?.textContent?.includes("Frost Profile Glow"));
  check("equipment: equip marks the row pressed", (await frost.getAttribute("aria-pressed")) === "true");
  check("equipment: equip updates the preview glow", (await page.getByTestId("equipped-glow").getAttribute("class"))?.includes("streak-glow-frost"));
  await frost.click();
  await page.waitForTimeout(300);
  check("equipment: clicking the equipped row unequips it", (await frost.getAttribute("aria-pressed")) === "false");
  check("equipment: unequip removes the preview glow", !(await page.getByTestId("equipped-glow").getAttribute("class"))?.includes("streak-glow-frost"));

  const frame = page.getByRole("button", { name: /Eternal Frame/ });
  await frame.click();
  await page.waitForTimeout(300);
  const persisted = await page.evaluate(() => window.localStorage.getItem("phase12_equipment"));
  check("equipment: frame equip persists in storage", Boolean(persisted && persisted.includes("frame_eternal")));
  check("equipment: no runtime errors", errors.length === 0, errors.slice(0, 2).join(" | "));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  check("equipment: Escape closes the modal", (await page.getByRole("dialog").count()) === 0);
  await page.getByRole("button", { name: "Open cosmetics" }).click();
  await page.waitForTimeout(200);
  const focusInside = await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]');
    return Boolean(dialog && document.activeElement && dialog.contains(document.activeElement));
  });
  await page.keyboard.press("Shift+Tab");
  const focusStillInside = await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]');
    return Boolean(dialog && document.activeElement && dialog.contains(document.activeElement));
  });
  check("equipment: opening focuses inside the dialog", focusInside);
  check("equipment: Tab wraps inside the dialog", focusStillInside);
  await shot(page, "equipment-mobile");
  await context.close();
}
{
  const { context, page } = await open({
    viewport: { width: 390, height: 844 },
    query: "screen=equipment",
    localStorage: {
      phase12_equipment: JSON.stringify({
        profile_frame: "frame_eternal",
        profile_glow: "glow_streak_frost",
        username_effect: "username_streak_emerald",
      }),
    },
  });
  await page.waitForTimeout(500);
  const frameClass = await page.getByTestId("equipped-frame").getAttribute("class");
  const glowClass = await page.getByTestId("equipped-glow").getAttribute("class");
  const nameClass = await page.getByTestId("equipped-name").getAttribute("class");
  check("persistence: frame survives reload", frameClass?.includes("frame-eternal"));
  check("persistence: glow survives reload", glowClass?.includes("streak-glow-frost"));
  check("persistence: username effect survives reload", nameClass?.includes("streak-name-emerald"));
  await context.close();
}

// ── Classement: independent per-game boards ───────────────────────────────
{
  const { context, page, errors } = await open({
    viewport: { width: 390, height: 844 },
    query: "screen=classement",
  });
  await page.waitForTimeout(900);
  const duelTab = page.getByRole("button", { name: /Solitaire Ranked Best Streak/ });
  const puzzleTab = page.getByRole("button", { name: /Puzzle Ranked Best Streak/ });
  check("classement: two competitive tabs render", (await duelTab.count()) === 1 && (await puzzleTab.count()) === 1);
  await duelTab.click();
  await page.waitForFunction(() => document.body.innerText.includes("Alice"), { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(300);
  const duelText = await page.locator("body").innerText();
  check("classement: Solitaire board shows its best streak", /12 wins/.test(duelText) && /Alice/.test(duelText));
  await puzzleTab.click();
  await page.waitForFunction(() => document.body.innerText.includes("Ana"), { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(300);
  const puzzleText = await page.locator("body").innerText();
  check("classement: Puzzle board shows its own best streak", /8 wins/.test(puzzleText) && /Ana/.test(puzzleText));
  check("classement: the two boards are not merged", !puzzleText.includes("Alice") && !duelText.includes("Ana"));
  check("classement: no runtime errors", errors.length === 0, errors.slice(0, 2).join(" | "));
  await shot(page, "classement-mobile");
  await context.close();
}

// ── Localization: translated reward names and layout fit ──────────────────
for (const lang of ["fr", "es"]) {
  const { context, page } = await open({
    viewport: { width: 390, height: 844 },
    lang,
    query: "screen=rewards&current=100",
  });
  await page.waitForTimeout(800);
  const text = await page.locator("body").innerText();
  const expected = lang === "fr" ? "Lueur de profil Givre" : "Brillo de perfil Escarcha";
  check(`${lang}: new reward name is translated`, text.includes(expected), text.includes("Frost Profile Glow") ? "English fallback" : "");
  check(`${lang}: rewards heading is translated`, lang === "fr" ? /Récompenses/.test(text) : /Recompensas/.test(text));
  const lower = text.toLowerCase();
  check(`${lang}: card labels are translated`, lang === "fr" ? lower.includes("série actuelle") && lower.includes("paliers de série") : lower.includes("racha actual") && lower.includes("hitos de racha"));
  check(`${lang}: milestone name is translated`, lang === "fr" ? /Maître des séries/.test(text) : /Maestro de rachas/.test(text));
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  check(`${lang}: no horizontal overflow`, overflow <= 1, `overflow=${overflow}px`);
  await shot(page, `rewards-${lang}-mobile`);
  await context.close();
}

// ── Axe accessibility scan ────────────────────────────────────────────────
{
  const { context, page } = await open({ viewport: { width: 1280, height: 900 }, query: "screen=rewards&current=100" });
  await page.waitForTimeout(500);
  check("a11y: harness uses dark theme", (await page.evaluate(() => document.documentElement.getAttribute("data-theme"))) === "dark");
  await page.addScriptTag({ path: join(root, "node_modules/axe-core/axe.min.js") });
  const result = await page.evaluate(async () => {
    return await window.axe.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] },
    });
  });
  const serious = result.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  const details = serious
    .flatMap((violation) =>
      violation.nodes.slice(0, 3).map(
        (node) => `${violation.id} ${node.target.join(" ")}: ${node.failureSummary?.split("\n").pop()}`,
      ),
    )
    .join(" | ");
  check("a11y: no serious/critical axe violations on rewards", serious.length === 0, details || serious.map((v) => v.id).join(", "));
  await context.close();
}

await browser.close();
server.close();

console.log(`\n${pass} passed, ${fail} failed`);
console.log(`screenshots → ${REPORTS}`);
if (failures.length) {
  console.log("FAILURES:");
  for (const failure of failures) console.log(`- ${failure.name}${failure.extra ? ` — ${failure.extra}` : ""}`);
}
process.exit(fail === 0 ? 0 : 1);
