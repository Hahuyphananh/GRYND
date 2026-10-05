// qa/cloudflare-verify.mjs
//
// Post-deploy verification for the Vercel → Cloudflare Workers cutover.
//
// It answers the two questions that a green deploy does NOT answer:
//
//   1. Did the Next build actually INLINE the public env vars into the bundle?
//      `NEXT_PUBLIC_*` are compiled in at build time. Setting them only as
//      Cloudflare *runtime* vars (wrangler `vars` / dashboard) leaves the client
//      and edge bundles with `undefined` — which is what makes the sign-in page
//      render blank (Clerk has no publishable key) and makes every signed-in
//      game route redirect to /complete-profile (the middleware's age lookup
//      reads NEXT_PUBLIC_SUPABASE_URL, gets nothing, and treats "age unknown"
//      as "no age record").
//
//   2. Do the two broken flows actually work in a real browser — does /sign-in
//      render Clerk's UI, and does a game route avoid the /complete-profile
//      redirect?
//
// Usage:
//   node qa/cloudflare-verify.mjs
//   GRYND_URL=https://grynd.dedyn.io node qa/cloudflare-verify.mjs
//   GRYND_GAME_PATH=/games/mines-pvp node qa/cloudflare-verify.mjs
//
// To exercise the AUTHENTICATED game route (the real age-gate check), paste the
// Cookie header from a signed-in browser session:
//
//   GRYND_COOKIE='__session=...; __client_uat=...' node qa/cloudflare-verify.mjs
//
// DevTools → Network → any request → Request Headers → copy the `cookie:` value.
// Without it, the script still proves sign-in renders and that an anonymous
// visitor is sent to /sign-in (never to /complete-profile).

import { chromium } from "playwright";

const BASE = (
  process.env.GRYND_URL || "https://grynd.phananhalbert.workers.dev"
).replace(/\/+$/, "");
const SIGN_IN_PATH = "/sign-in";
const GAME_PATH = process.env.GRYND_GAME_PATH || "/games/chess";
const AUTH_COOKIE = process.env.GRYND_COOKIE || "";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail });
  const tag = ok ? "PASS" : "FAIL";
  console.log(`  [${tag}] ${name}${detail ? ` — ${detail}` : ""}`);
}
function info(name, detail) {
  console.log(`  [info] ${name}${detail ? ` — ${detail}` : ""}`);
}

async function getText(url) {
  const res = await fetch(url, { redirect: "follow" });
  return { status: res.status, text: await res.text() };
}

// ── 1. Inlined public vars ─────────────────────────────────────────────────
// Each pattern is something the client/edge bundle only contains if the value
// was present at BUILD time. Presence proves the build saw the env var.
const EXPECTED_INLINE = {
  // A real Clerk key is `pk_test_<base64>` (60+ base64 chars). The Clerk SDK's
  // own error string contains the literal text "pk_test_..." — so require
  // enough base64 that that placeholder can never satisfy the check, or the
  // verifier reports a false PASS while Clerk has no key at all.
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: /pk_(test|live)_[A-Za-z0-9+/]{20,}={0,2}/,
  NEXT_PUBLIC_SUPABASE_URL: /https:\/\/[a-z0-9-]+\.supabase\.co/,
  NEXT_PUBLIC_SOCKET_URL: /https:\/\/[a-z0-9-]+\.onrender\.com/,
};

async function collectBundleText() {
  const home = await getText(`${BASE}/`);
  const html = home.text;

  const srcs = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
  const urls = new Set();
  for (const src of srcs) {
    const abs = src.startsWith("http")
      ? src
      : `${BASE}${src.startsWith("/") ? "" : "/"}${src}`;
    if (abs.includes("/_next/")) urls.add(abs);
  }

  let bundle = html; // inline <script> + RSC payload
  for (const url of urls) {
    try {
      const res = await fetch(url);
      if (res.ok) bundle += `\n${await res.text()}`;
    } catch {
      // A missing optional chunk should not fail the run on its own.
    }
  }
  return { status: home.status, html, bundle, chunkCount: urls.size };
}

function metaContent(html, re) {
  const m = html.match(re);
  return m ? m[1] : null;
}

// ── 2. Browser flows ───────────────────────────────────────────────────────
function cookiesFromHeader(header) {
  if (!header) return [];
  const hostname = new URL(BASE).hostname;
  return header
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const i = part.indexOf("=");
      return {
        name: part.slice(0, i),
        value: part.slice(i + 1),
        domain: hostname,
        path: "/",
        secure: BASE.startsWith("https://"),
        sameSite: "Lax",
      };
    })
    .filter((c) => c.name);
}

async function runBrowserChecks() {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const cookies = cookiesFromHeader(AUTH_COOKIE);
    if (cookies.length) await context.addCookies(cookies);

    const page = await context.newPage();
    const clientErrors = [];
    page.on("console", (m) => {
      if (m.type() === "error") clientErrors.push(m.text());
    });
    page.on("pageerror", (e) => clientErrors.push(e.message));

    // ── Sign-in ──
    await page.goto(`${BASE}${SIGN_IN_PATH}`, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    let signInVisible = false;
    try {
      await page
        .locator(
          'input[name="identifier"], input[type="email"], .cl-signIn-root, [data-clerk-component]',
        )
        .first()
        .waitFor({ state: "visible", timeout: 30000 });
      signInVisible = true;
    } catch {
      signInVisible = false;
    }

    let bodyText = "";
    try {
      bodyText = await page.locator("body").innerText();
    } catch {
      bodyText = "";
    }

    check(
      "sign-in renders Clerk UI",
      signInVisible,
      signInVisible ? "" : `body="${bodyText.replace(/\s+/g, " ").slice(0, 120)}"`,
    );

    const clerkErrors = clientErrors.filter((t) =>
      /publishable|clerk|clerkJSVariant/i.test(t),
    );
    if (clerkErrors.length) {
      info("client errors mentioning Clerk", clerkErrors.slice(0, 3).join(" | "));
    }

    // ── Game route ──
    const resp = await page.goto(`${BASE}${GAME_PATH}`, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    // Let client-side redirects settle before reading the final URL.
    await page.waitForTimeout(2000);

    const finalPath = new URL(page.url()).pathname;
    const toCompleteProfile = finalPath.startsWith("/complete-profile");

    check(
      "game route does not force /complete-profile",
      !toCompleteProfile,
      `final=${finalPath}${resp ? ` status=${resp.status()}` : ""}`,
    );

    if (AUTH_COOKIE) {
      const renderedGame =
        !toCompleteProfile &&
        (finalPath.startsWith("/games") || finalPath.startsWith("/casino"));
      check(
        "authenticated game route renders the game",
        renderedGame,
        `final=${finalPath}`,
      );
    } else {
      check(
        "anonymous game route redirects to /sign-in",
        finalPath.startsWith("/sign-in"),
        `final=${finalPath}`,
      );
      info(
        "authenticated age-gate check skipped",
        "set GRYND_COOKIE to exercise it",
      );
    }
  } finally {
    await browser.close();
  }
}

// ── Run ────────────────────────────────────────────────────────────────────
console.log(`\nCloudflare cutover verification — ${BASE}\n`);

console.log("Inlined public vars (build-time):");
let bundle;
try {
  bundle = await collectBundleText();
  check("home page reachable", bundle.status === 200, `status=${bundle.status}`);
  info("scripts fetched", `${bundle.chunkCount} chunk(s) + inline HTML`);
  for (const [name, re] of Object.entries(EXPECTED_INLINE)) {
    check(`${name} inlined`, re.test(bundle.bundle));
  }

  const canonical = metaContent(
    bundle.html,
    /<link[^>]+rel="canonical"[^>]+href="([^"]+)"/i,
  );
  const ogUrl = metaContent(
    bundle.html,
    /<meta[^>]+property="og:url"[^>]+content="([^"]+)"/i,
  );
  if (canonical) info("canonical", canonical);
  if (ogUrl) info("og:url", ogUrl);
} catch (err) {
  check("home page reachable", false, err.message);
}

console.log("\nHealth:");
try {
  const res = await fetch(`${BASE}/api/health`);
  const body = await res.json().catch(() => ({}));
  check("health responds 200", res.status === 200, `status=${res.status}`);
  check("database reachable", body.db === "ok", `db=${body.db ?? "?"}`);
  if (body.redis) info("redis", String(body.redis));
} catch (err) {
  check("health responds 200", false, err.message);
}

console.log("\nBrowser flows:");
try {
  await runBrowserChecks();
} catch (err) {
  check("browser checks ran", false, err.message);
}

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} checks passed.\n`,
);
if (failed.length) {
  console.log("Failures:");
  for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ""}`);
  console.log(
    "\nA missing NEXT_PUBLIC_* value means it was not set as a Workers BUILD\n" +
      "variable and the build did not inline it. Add it under the Worker's\n" +
      "Settings → Build → Build variables and secrets, then redeploy.\n",
  );
}

process.exitCode = failed.length ? 1 : 0;
