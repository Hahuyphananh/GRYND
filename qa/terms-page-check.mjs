// qa/terms-page-check.mjs
//
// Renders the legal/policy pages plus the trust/support pages (/terms,
// /privacy-policy, /fair-play, /security-policy, /accessibility, /faq,
// /contact) in a real headless Chromium and verifies they hydrate
// cleanly:
//   • no console errors, page errors, or failed requests
//   • the page title renders
//   • the key sections (UGC, Creator Recordings, arbitration, security,
//     accessibility, FAQ answers, contact form) are actually present in
//     the rendered DOM
//
// Run against a local dev server (default http://localhost:3000) or the
// deployed site via GRYND_URL:
//
//   npm run verify:legal-pages
//   GRYND_URL=https://www.grynd.mywire.org npm run verify:legal-pages
//   GRYND_URL=http://localhost:3100 node qa/terms-page-check.mjs

import { chromium } from "playwright";

const baseUrl = process.env.GRYND_URL || "http://localhost:3000";

const suites = [
  {
    route: "/terms",
    title: "Terms & Conditions",
    mustInclude: [
      "8. User Content & Community",
      "Creator Recordings",
      "17. Governing Law & Disputes",
      "Binding arbitration",
      "Opt-out",
    ],
  },
  {
    route: "/privacy-policy",
    title: "Privacy Policy",
    mustInclude: ["Creator Recordings", "Law 25", "Data Retention"],
  },
  {
    route: "/fair-play",
    title: "Fair Play Policy",
    mustInclude: ["incorporated into our Terms & Conditions", "Anti-Cheating", "Prohibited Behavior"],
  },
  {
    route: "/security-policy",
    title: "Security Policy",
    mustInclude: [
      "Encryption in Transit & At Rest",
      "Account Security",
      "Payment & Token Integrity",
      "Vulnerability Management",
      "Data Privacy & Retention",
      "Incident Response",
    ],
  },
  {
    route: "/accessibility",
    title: "Accessibility Policy",
    mustInclude: [
      "Our Commitment",
      "Keyboard Navigation",
      "Screen Reader Support",
      "Reduced Motion",
      "Real-Time & Skill Games",
    ],
  },
  {
    route: "/faq",
    title: "Frequently Asked Questions",
    mustInclude: [
      "Getting Started & Tokens",
      "What data does GRYND collect about me?",
      "Trust & Support",
      "How do I delete my account?",
    ],
  },
  {
    route: "/contact",
    title: "Contact Us",
    mustInclude: ["Reach Us", "Response Time", "Quick Links", "Send Message"],
  },
];

const errors = [];
const results = [];

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

// Same filters as qa/smoke-test.mjs: ignore the Tawk.to chat widget and
// the expected 401s from unauthenticated /api/ calls the shared layout
// makes (an anonymous QA browser isn't signed in).
page.on("console", (m) => {
  if (m.type() !== "error") return;
  const text = m.text();
  if (text.toLowerCase().includes("tawk.to")) return;
  if (/401 \(Unauthorized\)/.test(text)) return;
  errors.push(`[console] ${text}`);
});
page.on("pageerror", (e) => errors.push(`[pageerror] ${e.message}`));
page.on("requestfailed", (r) => {
  const t = r.failure()?.errorText || "unknown";
  if (t === "net::ERR_ABORTED" || r.url().toLowerCase().includes("tawk.to")) return;
  errors.push(`[requestfailed] ${r.url()} ${t}`);
});

for (const suite of suites) {
  const url = baseUrl + suite.route;
  try {
    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 120000,
    });
    if (response && response.status() >= 400) {
      errors.push(`[http ${response.status()}] ${url}`);
    }

    // Wait for React to hydrate and render the heading.
    await page.locator("h1").first().waitFor({ state: "visible", timeout: 60000 });
    await page.waitForTimeout(1500);

    const h1 = (await page.locator("h1").first().innerText()) || "";
    const text = await page.evaluate(() => document.body.innerText);
    // Case-insensitive: CSS text-transform (e.g. uppercase headings on
    // /contact) is reflected by innerText, so normalize both sides.
    const lowerText = text.toLowerCase();

    const titleOk = h1.toLowerCase().includes(suite.title.toLowerCase());
    const missing = suite.mustInclude.filter((s) => !lowerText.includes(s.toLowerCase()));

    results.push({
      route: suite.route,
      http: response ? response.status() : null,
      title: h1.slice(0, 60),
      titleOk,
      missing,
    });
  } catch (e) {
    errors.push(`[nav] ${url} ${e.message}`);
  }
}

console.log(JSON.stringify({ baseUrl, results, errors }, null, 2));

await browser.close();

const pageFailures = results.filter((r) => !r.titleOk || r.missing.length > 0);
process.exitCode = errors.length > 0 || pageFailures.length > 0 ? 1 : 0;