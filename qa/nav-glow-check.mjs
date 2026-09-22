// qa/nav-glow-check.mjs
//
// Reported bug: the equipped name glow (a Battle Pass reward) showed on the
// profile card but never in the navbar next to the name and avatar. The navbar
// rendered the name with the username EFFECT only — /api/get-user-tokens has
// always returned the glow as `glowColor`, but the navbar never read it, so
// there was nothing to paint.
//
// This drives the REAL navbar (qa/nav-glow-harness.jsx) and asserts what the
// browser actually paints on the display name:
//   * with a glow equipped → the catalog hex is the text colour and its halo
//     is the text-shadow (the same treatment the profile card gives it);
//   * the glow comes from the server payload — the Grynd+ chat colour
//     (`nameColor`) never paints the name, and no extra request is made;
//   * with no glow equipped → the name keeps the stylesheet colour;
//   * the mobile-menu name gets the same treatment (both branches share one
//     style object);
//   * `profileUpdated` (dispatched when the profile page equips a glow)
//     re-fetches, so a freshly equipped glow appears without a reload;
//   * no React / hydration / runtime errors.
//
// Run: node qa/nav-glow-check.mjs

import esbuild from "esbuild";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import autoprefixer from "autoprefixer";
import { chromium } from "playwright";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "nav-glow-"));
const REPORTS = join(root, "qa", "reports");
mkdirSync(REPORTS, { recursive: true });

const GLOW = "#7dd3fc";
// #7dd3fc + the profile card's 66-hex alpha suffix, as the browser reports it.
const EXPECTED_COLOR = "rgb(125, 211, 252)";
const EXPECTED_HALO = "rgba(125, 211, 252, 0.4)";
// The stylesheet colour on the name span (`text-[#c9f7ff]`).
const STYLESHEET_COLOR = "rgb(201, 247, 255)";

const STUBS = {
  "@clerk/nextjs": `
    export const useUser = () => ({
      isLoaded: true,
      isSignedIn: true,
      user: { id: "user_1", username: "GlowTester", firstName: "Glow", fullName: "Glow Tester" },
    });
    export const useAuth = () => ({ isLoaded: true, isSignedIn: true, userId: "user_1" });
    export const useClerk = () => ({ signOut() {} });
  `,
  "components/SignOutButton": `
    import React from "react";
    export const SignOutButton = ({ children }) => children ?? null;
    export default SignOutButton;
  `,
  "components/AddFundsModal": `export default function M() { return null; }`,
  "components/BattlepassClaimBadge": `export default function B() { return null; }`,
  "next/navigation": `
    const router = { push(){}, replace(){}, back(){}, refresh(){}, prefetch(){} };
    export const useRouter = () => router;
    export const usePathname = () => "/";
    export const useSearchParams = () => new URLSearchParams();
    export default { useRouter, usePathname, useSearchParams };
  `,
  "next/image": `import React from "react"; export default function Img() { return null; }`,
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
  entryPoints: [join(root, "qa/nav-glow-harness.jsx")],
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
      name: "nav-stubs",
      setup(build) {
        build.onResolve({ filter: /.*/ }, (args) => {
          const key = matchStubKey(args.path, args.resolveDir);
          if (!key) return null;
          return { path: key, namespace: "nav-stub" };
        });
        build.onLoad({ filter: /.*/, namespace: "nav-stub" }, (args) => ({
          contents: STUBS[args.path],
          loader: "jsx",
          resolveDir: root,
        }));
      },
    },
  ],
});

const compiled = await postcss([
  tailwindcss(join(root, "tailwind.config.js")),
  autoprefixer(),
]).process(readFileSync(join(root, "src/app/globals.css"), "utf8"), {
  from: join(root, "src/app/globals.css"),
});
writeFileSync(
  join(outDir, "app.css"),
  compiled.css.replace(/@import\s+url\(["']?https?:\/\/[^)]*\);?/g, ""),
);

writeFileSync(
  join(outDir, "index.html"),
  `<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Navbar glow check</title>
<link rel="stylesheet" href="./app.css"></head>
<body><div id="root"></div><script src="./harness.js"></script></body></html>`,
);

const server = createServer((req, res) => {
  const path = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  try {
    const buf = readFileSync(join(outDir, path.replace(/^\//, "")));
    res.writeHead(200, {
      "Content-Type": path.endsWith(".css")
        ? "text/css"
        : path.endsWith(".js")
          ? "text/javascript"
          : "text/html",
    });
    res.end(buf);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}/index.html`;

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`);
  ok ? pass++ : fail++;
};

const browser = await chromium.launch();

const NAME = '[data-testid="nav-user-name"]';

const readName = (page, selector = NAME) =>
  page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const cs = getComputedStyle(el);
    return {
      text: el.textContent.replace(/\s+/g, " ").trim(),
      inlineColor: el.style.color,
      inlineShadow: el.style.textShadow,
      color: cs.color,
      textShadow: cs.textShadow,
    };
  }, selector);

async function boot(glow, viewport = { width: 1440, height: 900 }) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e.message)));
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  await page.addInitScript((value) => {
    window.__navGlow = value;
  }, glow);
  await page.goto(origin);
  await page.waitForSelector(NAME, { timeout: 20000 });
  // The glow lands with the /api/user/glows response, one tick after the name.
  await page.waitForTimeout(300);
  return { context, page, consoleErrors, pageErrors };
}

// ── 1. A glow IS equipped ──────────────────────────────────────────────────
{
  const { context, page, consoleErrors, pageErrors } = await boot(GLOW);

  const name = await readName(page);
  check("the display name renders", name?.text?.includes("Glow Tester"), JSON.stringify(name?.text));
  check(
    "the equipped glow colour is the name colour",
    name?.inlineColor === EXPECTED_COLOR && name?.color === EXPECTED_COLOR,
    `inline=${JSON.stringify(name?.inlineColor)} computed=${JSON.stringify(name?.color)}`,
  );
  check(
    "the equipped glow halo is on the name",
    (name?.textShadow || "").includes(EXPECTED_HALO),
    JSON.stringify(name?.textShadow),
  );
  check(
    "the Grynd+ chat colour (nameColor) does not paint the name",
    name?.inlineColor !== "rgb(255, 0, 255)",
    JSON.stringify(name?.inlineColor),
  );
  check(
    "the glow rides the balance payload — no extra request",
    await page.evaluate(() =>
      window.__ng.requests.every((r) => r !== "/api/user/glows"),
    ),
  );

  // ── 3. The mobile-menu name shares the same treatment ────────────────────
  await page.getByRole("button", { name: "Toggle menu" }).first().click();
  await page.waitForTimeout(200);
  const menuNames = await page.evaluate((sel) => {
    const els = [...document.querySelectorAll(sel)];
    return els.map((el) => ({
      text: el.textContent.replace(/\s+/g, " ").trim(),
      inlineColor: el.style.color,
      inlineShadow: el.style.textShadow,
    }));
  }, NAME);
  const menuGlow = menuNames.find((n) => n.text.includes("Glow Tester") && n.inlineColor);
  check(
    "the mobile-menu name carries the same glow",
    Boolean(menuGlow) && menuGlow.inlineColor === EXPECTED_COLOR,
    JSON.stringify(menuNames),
  );

  await page.screenshot({ path: join(REPORTS, "nav-glow-equipped.png") });

  const structural = [...pageErrors, ...consoleErrors].filter((e) =>
    /validateDOMNesting|descendant of|hydration|Hydration|Cannot read|Cannot update|is not a function|unique "key"|Objects are not valid/i.test(
      e,
    ),
  );
  check("no React / hydration / runtime errors", structural.length === 0, structural.slice(0, 3).join(" | "));

  await context.close();
}

// ── 2. No glow equipped ────────────────────────────────────────────────────
{
  const { context, page, consoleErrors, pageErrors } = await boot(null);

  const name = await readName(page);
  check("the display name still renders without a glow", Boolean(name?.text));
  check(
    "no glow equipped → the stylesheet colour stands (no inline colour)",
    name?.inlineColor === "" && name?.color === STYLESHEET_COLOR && !name?.textShadow.includes("rgba(125"),
    `inline=${JSON.stringify(name?.inlineColor)} computed=${JSON.stringify(name?.color)} shadow=${JSON.stringify(name?.textShadow)}`,
  );

  await page.screenshot({ path: join(REPORTS, "nav-glow-none.png") });

  const structural = [...pageErrors, ...consoleErrors].filter((e) =>
    /validateDOMNesting|descendant of|hydration|Hydration|Cannot read|Cannot update|is not a function|unique "key"|Objects are not valid/i.test(
      e,
    ),
  );
  check("no React / hydration / runtime errors without a glow", structural.length === 0, structural.slice(0, 3).join(" | "));

  await context.close();
}

// ── 4. `profileUpdated` re-fetches the glow ────────────────────────────────
{
  const { context, page } = await boot(null);
  const before = await page.evaluate(
    () => window.__ng.requests.filter((r) => r === "/api/get-user-tokens").length,
  );
  await page.evaluate(() => window.dispatchEvent(new Event("profileUpdated")));
  await page.waitForTimeout(300);
  const after = await page.evaluate(
    () => window.__ng.requests.filter((r) => r === "/api/get-user-tokens").length,
  );
  check(
    "equipping a glow on the profile page refreshes the navbar",
    after > before,
    `before=${before} after=${after}`,
  );
  await context.close();
}

await browser.close();
server.close();

console.log(`\n${pass} passed, ${fail} failed`);
console.log("screenshots → qa/reports/nav-glow-{equipped,none}.png");
process.exit(fail === 0 ? 0 : 1);
