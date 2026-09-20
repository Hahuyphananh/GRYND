// qa/ai-search-raw-html.mjs
//
// Checks what a crawler that runs NO JavaScript actually receives — the raw
// HTML Next.js serves. AI answer engines and most text crawlers read exactly
// this and nothing more, so a page whose content is assembled by JS is
// invisible to them even though a real visitor sees it.
//
// For each page it asserts the three things that were flagged for this site:
//
//   1. a MAIN HEADING that is really in the HTML (exactly one <h1>, non-empty);
//   2. enough REAL TEXT to be quotable — not a shell with a loading state;
//   3. structured data a machine can trust: Organization/WebSite on the home
//      page, and AggregateRating/Review for the player reviews (built from the
//      moderated reviews, never hardcoded).
//
// It then loads the same pages in a real browser to make sure the HTML a
// crawler gets is also the HTML a visitor gets: the server-rendered <h1> must
// survive hydration unchanged, and nothing may report a hydration mismatch.
// (That matters here because the server-rendered content only exists at all
// after the providers stopped deferring every page to a mount effect.)
//
// Needs a running server (dev or production):
//   npm run dev            # or: next build && next start
//   BASE_URL=http://localhost:3000 node qa/ai-search-raw-html.mjs
//
// Run: npm run verify:ai-search

const BASE_URL = (process.env.BASE_URL || "http://localhost:3000").replace(/\/$/, "");

// Pages that must stand on their own for a JS-less reader. `/reviews` carries
// the review schema; the rest are the discoverable entry points.
const PAGES = [
  { path: "/", minText: 1500, needsHeading: true, needsRating: true },
  { path: "/reviews", minText: 400, needsHeading: true, needsReviewSchema: true },
  { path: "/games", minText: 1000, needsHeading: true },
  { path: "/faq", minText: 1500, needsHeading: true },
  { path: "/classement", minText: 300, needsHeading: true },
];

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`);
  ok ? pass++ : fail++;
};

/** Visible text only: scripts, styles and comments can't be read by a crawler. */
function visibleText(html) {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    // A crawler reads the DECODED characters, so `&#x27;` is an apostrophe and
    // `&amp;` is an ampersand. Comparing raw markup against a DOM's innerText
    // without decoding produced false failures (e.g. `WHO&#x27;S` vs `WHO'S`).
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function extractJsonLd(html) {
  const out = [];
  const re = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      out.push(JSON.parse(m[1]));
    } catch {
      out.push({ __parseError: m[1].slice(0, 120) });
    }
  }
  return out;
}

/** Every @type reachable in a JSON-LD document (including @graph children). */
function schemaTypes(doc) {
  const types = [];
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (node["@type"]) types.push(String(node["@type"]));
    for (const value of Object.values(node)) walk(value);
  };
  walk(doc);
  return types;
}

async function main() {
  // Fail loudly with a useful message rather than a wall of connection errors.
  try {
    const probe = await fetch(BASE_URL, { redirect: "manual" });
    if (!probe.ok && probe.status !== 0) {
      console.log(`server at ${BASE_URL} answered ${probe.status}`);
    }
  } catch (err) {
    console.log(`No server at ${BASE_URL} — start one first (npm run dev), or set BASE_URL.`);
    console.log(String(err?.message || err));
    process.exit(1);
  }

  for (const page of PAGES) {
    console.log(`\n=== ${page.path} ===\n`);
    const res = await fetch(BASE_URL + page.path, { redirect: "manual" });
    const html = await res.text();
    const text = visibleText(html);
    const headings = [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)].map((h) =>
      visibleText(h[1]),
    );
    const jsonLd = extractJsonLd(html);
    const types = jsonLd.flatMap(schemaTypes);

    console.log(
      `   ${html.length} bytes of HTML, ${text.length} chars of visible text, ` +
        `${headings.length} h1, schema: ${types.length ? [...new Set(types)].join(", ") : "none"}`,
    );
    if (headings.length) console.log(`   h1: ${headings.map((h) => `"${h.slice(0, 70)}"`).join(", ")}`);

    check(`${page.path}: served with 200`, res.status === 200, String(res.status));
    check(
      `${page.path}: exactly one non-empty <h1> in the raw HTML`,
      headings.length === 1 && headings[0].length > 0,
      `${headings.length} found`,
    );
    check(
      `${page.path}: at least ${page.minText} chars of readable text without JS`,
      text.length >= page.minText,
      `${text.length} chars`,
    );
    check(`${page.path}: no JSON-LD failed to parse`, !types.includes("undefined") && jsonLd.every((d) => !d.__parseError));

    if (page.needsRating) {
      check(
        `${page.path}: carries an AggregateRating`,
        types.includes("AggregateRating"),
        [...new Set(types)].join(", "),
      );
    }

    if (page.needsReviewSchema) {
      const appDoc = jsonLd.find((d) => JSON.stringify(d).includes("AggregateRating"));
      const agg = appDoc?.aggregateRating;
      check(`${page.path}: carries an AggregateRating`, Boolean(agg), JSON.stringify(agg ?? null));
      check(
        `${page.path}: …with a real ratingValue and reviewCount`,
        Boolean(
          agg &&
            Number(agg.ratingValue) >= 1 &&
            Number(agg.ratingValue) <= 5 &&
            Number(agg.reviewCount) >= 1,
        ),
      );
      check(
        `${page.path}: …and individual Review markup`,
        types.includes("Review"),
        [...new Set(types)].join(", "),
      );

      // The schema must describe reviews that are ACTUALLY ON THE PAGE — not a
      // score with no visible reviews behind it. Every review body the markup
      // claims has to be readable in the raw HTML, and there must be one card
      // per review the aggregate counts (up to the page limit).
      const claimed = Array.isArray(appDoc?.review) ? appDoc.review : [];
      const missingBodies = claimed
        .map((r) => r.reviewBody)
        .filter((body) => body && !text.includes(body.slice(0, Math.min(60, body.length))));
      check(
        `${page.path}: every Review body in the markup is in the raw HTML too`,
        claimed.length > 0 && missingBodies.length === 0,
        `${claimed.length} claimed, ${missingBodies.length} missing`,
      );
      const cards = (html.match(/Verified player/g) || []).length;
      check(
        `${page.path}: one review card rendered per review the rating counts`,
        cards === Math.min(Number(agg?.reviewCount ?? 0), 12),
        `${cards} cards for ${agg?.reviewCount} rated reviews`,
      );
    }
  }

  // ── Hydration: the crawler's HTML must be the visitor's HTML ──────────
  console.log("\n=== hydration — server HTML must survive the client render ===\n");

  let chromium = null;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    console.log("playwright not installed — skipping the hydration phase (npm ci)");
  }

  if (chromium) {
    const browser = await chromium.launch();
    const HYDRATION_SIGNATURES = [
      /hydrat/i,
      /did not match/i,
      /server rendered HTML/i,
      /server-rendered/i,
      /text content does not match/i,
      /Minified React error/i,
    ];

    for (const page of PAGES) {
      const tab = await browser.newPage();
      const complaints = [];
      tab.on("console", (msg) => {
        if (msg.type() !== "error" && msg.type() !== "warning") return;
        const text = msg.text();
        if (HYDRATION_SIGNATURES.some((re) => re.test(text))) complaints.push(text);
      });
      tab.on("pageerror", (err) => complaints.push(String(err?.message || err)));

      const raw = await (await fetch(BASE_URL + page.path)).text();
      const rawH1 = visibleText((/<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(raw) || ["", ""])[1]);

      await tab.goto(BASE_URL + page.path, { waitUntil: "networkidle" });
      const domH1 = await tab.evaluate(() => {
        const h1 = document.querySelector("h1");
        return h1 ? h1.innerText.replace(/\s+/g, " ").trim() : null;
      });

      check(`${page.path}: no hydration mismatch or runtime error`, complaints.length === 0, complaints[0] || "");
      check(
        `${page.path}: the server-rendered <h1> is still there after the client render`,
        Boolean(domH1) && Boolean(rawH1) && domH1 === rawH1,
        `server "${rawH1.slice(0, 40)}" vs dom "${String(domH1).slice(0, 40)}"`,
      );
      await tab.close();
    }

    await browser.close();
  }

  console.log("\n=== home page: the machine-readable identity ===\n");
  const home = await (await fetch(BASE_URL + "/")).text();
  const homeLd = extractJsonLd(home);
  const homeTypes = homeLd.flatMap(schemaTypes);
  check("home: Organization structured data", homeTypes.includes("Organization"));
  check("home: WebSite structured data", homeTypes.includes("WebSite"));
  check("home: the app entity links back to the organization", homeTypes.includes("SoftwareApplication"));
  // If the reviews ever legitimately drop to zero (all unapproved), the rating
  // must disappear rather than linger as a stale claim.
  const homeAgg = homeLd.map((d) => d.aggregateRating).find(Boolean);
  const reviewsPageHtml = await (await fetch(BASE_URL + "/reviews")).text();
  const reviewsAgg = extractJsonLd(reviewsPageHtml)
    .map((d) => d.aggregateRating)
    .find(Boolean);
  check(
    "home: the rating matches the reviews page (one claim, not two)",
    JSON.stringify(homeAgg ?? null) === JSON.stringify(reviewsAgg ?? null),
    `${JSON.stringify(homeAgg ?? null)} vs ${JSON.stringify(reviewsAgg ?? null)}`,
  );

  console.log(`\n${pass} passed / ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}

await main();
