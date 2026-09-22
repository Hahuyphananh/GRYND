// qa/profil-i18n-check.mjs
//
// Renders the REAL /profil page (qa/profil-i18n-harness.jsx) once per language
// and asserts the copy that is actually on screen. The unit suite
// (tests/profil-page-i18n.test.mjs) proves every `t("profile.*")` key exists in
// EN/FR/ES; this proves the page RENDERS them — a key that resolves but is
// wired to the wrong element, a text node left outside `t(...)`, or a broken
// interpolation all show up here and not in the bundle.
//
// Checked per language (EN / FR / ES):
//   * the page heading, the personal-info card, the token balance;
//   * the Battlepass, Grynd+ membership, profile-customization and referral
//     sections (all copy that used to be hardcoded);
//   * the four areas the request called out — statistics, add friends, danger
//     zone and the edit-profile popup labels;
//   * the edit popup's own labels (opened by a real click);
//   * zero React / hydration / runtime errors.
//
// Run: node qa/profil-i18n-check.mjs

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
const outDir = mkdtempSync(join(tmpdir(), "profil-i18n-"));
const REPORTS = join(root, "qa", "reports");
mkdirSync(REPORTS, { recursive: true });

// ── Stubs ──────────────────────────────────────────────────────────────────
// Clerk says "signed in" so the page renders its real body instead of the
// sign-in prompt. The child display components are inert: they are not part of
// this change and would otherwise contribute their own copy + fetches.
const STUBS = {
  "@clerk/nextjs": `
    export const useUser = () => ({
      isLoaded: true,
      isSignedIn: true,
      user: {
        fullName: "Profil Tester",
        createdAt: "2025-04-21T00:00:00.000Z",
        emailAddresses: [{ emailAddress: "tester@example.com" }],
      },
    });
    export const useClerk = () => ({ signOut() {} });
    export const useAuth = () => ({ isLoaded: true, isSignedIn: true, userId: "user_1" });
  `,
  "components/navigation-bar": `export default function Nav() { return null; }`,
  "components/Footer": `export default function Footer() { return null; }`,
  "components/ContactMessageHistory": `export default function H() { return null; }`,
  "components/EmoteLoadoutStrip": `export default function S() { return null; }`,
  "components/UserStatsTabs": `export default function T() { return null; }`,
  "components/ChooseIconModal": `export default function M() { return null; }`,
  "components/ChooseGlowModal": `export default function M() { return null; }`,
  "components/ChooseFrameModal": `export default function M() { return null; }`,
  "components/ChooseEmotesModal": `export default function M() { return null; }`,
  "posthog-js/react": `export const usePostHog = () => null; export default {};`,
  "next/navigation": `
    const router = { push(){}, replace(){}, back(){}, refresh(){}, prefetch(){} };
    export const useRouter = () => router;
    export const usePathname = () => "/profil";
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
  entryPoints: [join(root, "qa/profil-i18n-harness.jsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  // The app ships JSX inside `.js` files (LanguageContext, several hooks).
  loader: { ".js": "jsx" },
  outfile: join(outDir, "harness.js"),
  logLevel: "error",
  absWorkingDir: root,
  define: { "process.env.NODE_ENV": '"development"' },
  // A browser has no `process`; Next shims it, so the bundle needs the same.
  banner: {
    js: 'var process = { env: { NODE_ENV: "development" }, platform: "browser", browser: true, version: "v0.0.0" };',
  },
  plugins: [
    {
      name: "profil-stubs",
      setup(build) {
        build.onResolve({ filter: /.*/ }, (args) => {
          const key = matchStubKey(args.path, args.resolveDir);
          if (!key) return null;
          return { path: key, namespace: "profil-stub" };
        });
        build.onLoad({ filter: /.*/, namespace: "profil-stub" }, (args) => ({
          contents: STUBS[args.path],
          loader: "jsx",
          resolveDir: root,
        }));
      },
    },
  ],
});

// ── The app's real stylesheet ──────────────────────────────────────────────
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
<title>Profile i18n check</title>
<link rel="stylesheet" href="./app.css"></head>
<body><div id="root"></div><script src="./harness.js"></script></body></html>`,
);

// ── Serve it from a real origin so `localStorage` (the language store) works ─
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

// ── Reporting ──────────────────────────────────────────────────────────────
let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`);
  ok ? pass++ : fail++;
};

const browser = await chromium.launch();
const bodyText = (page) => page.evaluate(() => document.body.innerText);

// One expectation set per language: a heading from each section the request
// named, plus the French-only copy that used to leak into every locale.
const EXPECTATIONS = {
  en: {
    title: "Your Profile",
    personal: "Personal info",
    balance: "Token balance",
    battlepass: "Battlepass Level",
    membership: "Grynd+ Membership",
    referral: "Referral System",
    stats: "User Statistics",
    addFriends: "Add Friends",
    danger: "Danger Zone: Delete Account",
    editButton: "Edit Profile",
    editOpen: "My Grynd Icon",
    memberSince: "Member since",
    streak: "Daily streak",
    notFrench: ["Infos Personnelles", "Solde de jetons"],
  },
  fr: {
    title: "Votre profil",
    personal: "Infos personnelles",
    balance: "Solde de jetons",
    battlepass: "Niveau Battlepass",
    membership: "Abonnement Grynd+",
    referral: "Système de parrainage",
    stats: "Statistiques",
    addFriends: "Ajouter des amis",
    danger: "Zone dangereuse",
    editButton: "Modifier le profil",
    editOpen: "Mon icône Grynd",
    memberSince: "Membre depuis",
    streak: "Série quotidienne",
    notFrench: ["Your Profile", "Token balance"],
  },
  es: {
    title: "Tu perfil",
    personal: "Información personal",
    balance: "Saldo de fichas",
    battlepass: "Nivel del Battlepass",
    membership: "Membresía Grynd+",
    referral: "Sistema de referidos",
    stats: "Estadísticas",
    addFriends: "Añadir amigos",
    danger: "Zona de peligro",
    editButton: "Editar perfil",
    editOpen: "Mi icono de Grynd",
    memberSince: "Miembro desde",
    streak: "Racha diaria",
    notFrench: ["Your Profile", "Saldo de jetons"],
  },
};

for (const lang of ["en", "fr", "es"]) {
  const want = EXPECTATIONS[lang];
  const context = await browser.newContext({ viewport: { width: 1280, height: 1100 } });
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e.message)));
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });

  // The language provider reads this key on mount.
  await page.addInitScript((value) => {
    window.localStorage.setItem("casino_app_language", value);
  }, lang);

  await page.goto(origin);
  try {
    await page.waitForFunction(
      (expected) => document.body.innerText.includes(expected),
      want.title,
      { timeout: 20000 },
    );
  } catch (err) {
    // Diagnostics: the page never rendered its heading in this language.
    const body = await bodyText(page).catch(() => "<no body>");
    console.error(`\n[diag] ${lang}: heading "${want.title}" never appeared`);
    console.error(`[diag] page errors: ${pageErrors.join(" | ") || "none"}`);
    console.error(`[diag] console errors: ${consoleErrors.join(" | ") || "none"}`);
    console.error(`[diag] body: ${body.slice(0, 600)}`);
    await context.close();
    await browser.close();
    server.close();
    process.exit(1);
  }
  const text = await bodyText(page);

  for (const [name, expected] of Object.entries(want)) {
    // `notFrench` is an absence assertion, and `editOpen` lives inside the
    // popup — both are asserted separately below.
    if (name === "notFrench" || name === "editOpen") continue;
    check(`${lang}: ${name} renders "${expected}"`, text.includes(expected));
  }
  for (const forbidden of want.notFrench) {
    check(`${lang}: no leftover "${forbidden}"`, !text.includes(forbidden));
  }

  // The edit-profile popup is the "popup labels" part of the request.
  const editButton = page.getByRole("button", { name: want.editButton, exact: true });
  const editButtonCount = await editButton.count();
  check(`${lang}: the edit-profile button is translated`, editButtonCount === 1);
  if (editButtonCount === 1) {
    await editButton.click();
    await page.waitForTimeout(200);
    const openText = await bodyText(page);
    check(`${lang}: edit popup opens with "${want.editOpen}"`, openText.includes(want.editOpen));
    check(
      `${lang}: edit popup keeps its other labels translated`,
      openText.includes(
        lang === "en"
          ? "My Profile Frame"
          : lang === "fr"
            ? "Mon cadre de profil"
            : "Mi marco de perfil",
      ),
    );
  }

  // Only React-level breakage counts here: the stub responses leave a few
  // asset 404s in the console, which are noise.
  const structural = [...pageErrors, ...consoleErrors].filter((e) =>
    /validateDOMNesting|descendant of|hydration|Hydration|Cannot read|Cannot update|is not a function|unique "key"|Objects are not valid|Each child/i.test(
      e,
    ),
  );
  check(
    `${lang}: no React / hydration / runtime errors`,
    structural.length === 0,
    structural.slice(0, 3).join(" | "),
  );

  await page.screenshot({
    path: join(REPORTS, `profil-i18n-${lang}.png`),
    fullPage: true,
  });
  await context.close();
}

await browser.close();
server.close();

console.log(`\n${pass} passed, ${fail} failed`);
console.log(`screenshots → qa/reports/profil-i18n-{en,fr,es}.png`);
process.exit(fail === 0 ? 0 : 1);
