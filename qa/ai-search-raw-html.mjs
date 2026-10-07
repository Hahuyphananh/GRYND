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

import { load } from "cheerio";

const BASE_URL = (process.env.BASE_URL || "http://localhost:3000").replace(/\/$/, "");

// Pages that must stand on their own for a JS-less reader. `/reviews` carries
// the review schema; the rest are the discoverable entry points.
const PAGES = [
  { path: "/", minText: 1500, needsHeading: true, needsRating: true },
  { path: "/reviews", minText: 400, needsHeading: true, needsReviewSchema: true },
  { path: "/games", minText: 1000, needsHeading: true },
  { path: "/faq", minText: 1500, needsHeading: true },
  { path: "/classement", minText: 300, needsHeading: true },
  // The guides library (src/lib/guides.ts): an index that must list every guide
  // as a real link, and one representative article. Both are server components,
  // so all of their text has to be in the raw HTML — which is exactly what this
  // harness checks.
  { path: "/guides", minText: 800, needsHeading: true },
  { path: "/guides/how-to-improve-typing-speed", minText: 2000, needsHeading: true },
  // Three representative game landing pages: the flagship (chess), a newer
  // title (speed-typing) and the uno/neon-flush alias page. Their structured
  // data is checked on all 21 below; these three also get the heading, text
  // and hydration pass.
  { path: "/games/chess", minText: 2000, needsHeading: true, needsGameSchema: true },
  { path: "/games/speed-typing", minText: 2000, needsHeading: true, needsGameSchema: true },
  { path: "/games/uno", minText: 2000, needsHeading: true, needsGameSchema: true },
];

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`);
  ok ? pass++ : fail++;
};

/**
 * Visible text only: scripts and styles can't be read by a crawler.
 *
 * Parsed with a real HTML parser (cheerio, already a dependency) rather than
 * stripped with regexes: regex-based tag/comment filtering is bypassable by
 * construction (CodeQL js/bad-tag-filter), and the parser also decodes
 * character references the way a crawler does — `&#x27;` is an apostrophe and
 * `&amp;` is an ampersand — which is what the comparisons below rely on.
 */
function visibleText(html) {
  if (!html) return "";
  // Fragment mode (`isDocument = false`) so a bare `<h1>…</h1>` snippet parses
  // the same way a whole page does.
  const $ = load(String(html), null, false);
  $("script, style").remove();
  // Keep every element boundary as whitespace — the regex version replaced
  // each tag with a space, and without this "<h1>a</h1><p>b</p>" would fuse
  // into "ab" and break the substring comparisons below.
  $("*").each((_, el) => {
    $(el).before(" ");
    $(el).after(" ");
  });
  return $.root().text().replace(/\s+/g, " ").trim();
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

/** The first node of each @type in a page's JSON-LD, in document order. */
function byType(docs, type) {
  return docs.filter((doc) => doc && doc["@type"] === type);
}

/** Every JSON key reachable in a value. */
function keysOf(value, found = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) keysOf(item, found);
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      found.add(key);
      keysOf(child, found);
    }
  }
  return found;
}

/**
 * The structured data on the game landing pages must describe the page a
 * visitor actually reads — so every claim is looked up in the VISIBLE text of
 * the same response. Shared by the per-page loop and the full 21-page sweep.
 */
function checkGameSchema({ path, html, text, jsonLd }) {
  const types = jsonLd.flatMap(schemaTypes);
  check(
    `${path}: no JSON-LD failed to parse`,
    jsonLd.every((doc) => !doc.__parseError)
  );

  // The page's own canonical URL, from the <link> Next emits for the
  // `alternates.canonical` the route declares.
  const canonicalTag = /<link[^>]+rel="canonical"[^>]*>/i.exec(html)?.[0] ?? null;
  const canonical = canonicalTag ? (/href="([^"]+)"/.exec(canonicalTag)?.[1] ?? null) : null;
  check(
    `${path}: declares a canonical URL that is this page, not /casino/<slug>`,
    Boolean(canonical) && canonical.endsWith(path) && !canonical.includes("/casino"),
    canonical ?? "no canonical link"
  );

  // Exactly one of each — a second node of the same type on one page is the
  // "duplicate schema" case, even when the two agree.
  for (const type of ["WebApplication", "BreadcrumbList", "FAQPage"]) {
    const count = byType(jsonLd, type).length;
    check(`${path}: exactly one ${type}`, count === 1, `${count} found`);
  }

  const app = byType(jsonLd, "WebApplication")[0];
  check(
    `${path}: the application URL and @id are the canonical page URL`,
    Boolean(canonical) &&
      app?.url === canonical &&
      String(app?.["@id"] ?? "").startsWith(`${canonical}#`),
    `${app?.url} / ${app?.["@id"]}`
  );
  check(
    `${path}: no structured data points at /casino/<slug>`,
    !JSON.stringify(jsonLd).includes("/casino")
  );

  // Everything the markup claims must be readable in the raw HTML.
  check(
    `${path}: the declared name is on the page`,
    Boolean(app?.name) && text.includes(app.name),
    app?.name
  );
  check(
    `${path}: the declared description is a paragraph on the page`,
    Boolean(app?.description) && text.includes(String(app.description).replace(/\s+/g, " ").trim()),
    String(app?.description ?? "").slice(0, 60)
  );

  const crumbs = byType(jsonLd, "BreadcrumbList")[0]?.itemListElement ?? [];
  check(
    `${path}: every breadcrumb name is in the visible crumb trail`,
    crumbs.length === 3 && crumbs.every((crumb) => text.includes(crumb.name)),
    crumbs.map((crumb) => crumb.name).join(" > ")
  );
  check(
    `${path}: the last breadcrumb is this page's canonical URL`,
    Boolean(canonical) && crumbs.at(-1)?.item === canonical,
    crumbs.at(-1)?.item
  );

  const faq = byType(jsonLd, "FAQPage")[0]?.mainEntity ?? [];
  const missingQa = faq.filter(
    (entry) => !text.includes(entry.name) || !text.includes(entry.acceptedAnswer?.text)
  );
  check(
    `${path}: every question AND answer in the markup is on the page`,
    faq.length > 0 && missingQa.length === 0,
    `${faq.length} declared, ${missingQa.length} not visible`
  );

  // Nothing about ratings, reviews or prices, on any node.
  const keys = keysOf(jsonLd);
  const unearned = [
    "aggregateRating",
    "review",
    "reviewCount",
    "ratingValue",
    "offers",
    "price",
  ].filter((key) => keys.has(key));
  check(`${path}: claims no rating, review or price`, unearned.length === 0, unearned.join(", "));

  // The referenced site nodes must be on the same page, or the graph dangles.
  const referenced = (app?.isPartOf?.["@id"] ?? "") + " " + (app?.publisher?.["@id"] ?? "");
  check(
    `${path}: the site identity it references is on the same page`,
    types.includes("WebSite") && types.includes("Organization") && referenced.trim().length > 0,
    referenced.trim()
  );

  const ids = jsonLd.map((doc) => doc?.["@id"]).filter(Boolean);
  check(`${path}: no duplicate @id`, new Set(ids).size === ids.length, `${ids.length} ids`);
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
      visibleText(h[1])
    );
    const jsonLd = extractJsonLd(html);
    const types = jsonLd.flatMap(schemaTypes);

    console.log(
      `   ${html.length} bytes of HTML, ${text.length} chars of visible text, ` +
        `${headings.length} h1, schema: ${types.length ? [...new Set(types)].join(", ") : "none"}`
    );
    if (headings.length)
      console.log(`   h1: ${headings.map((h) => `"${h.slice(0, 70)}"`).join(", ")}`);

    check(`${page.path}: served with 200`, res.status === 200, String(res.status));
    check(
      `${page.path}: exactly one non-empty <h1> in the raw HTML`,
      headings.length === 1 && headings[0].length > 0,
      `${headings.length} found`
    );
    check(
      `${page.path}: at least ${page.minText} chars of readable text without JS`,
      text.length >= page.minText,
      `${text.length} chars`
    );
    check(
      `${page.path}: no JSON-LD failed to parse`,
      !types.includes("undefined") && jsonLd.every((d) => !d.__parseError)
    );

    if (page.needsGameSchema) {
      checkGameSchema({ path: page.path, html, text, jsonLd });
    }

    if (page.needsRating) {
      check(
        `${page.path}: carries an AggregateRating`,
        types.includes("AggregateRating"),
        [...new Set(types)].join(", ")
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
          Number(agg.reviewCount) >= 1
        )
      );
      check(
        `${page.path}: …and individual Review markup`,
        types.includes("Review"),
        [...new Set(types)].join(", ")
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
        `${claimed.length} claimed, ${missingBodies.length} missing`
      );
      const cards = (html.match(/Verified player/g) || []).length;
      check(
        `${page.path}: one review card rendered per review the rating counts`,
        cards === Math.min(Number(agg?.reviewCount ?? 0), 12),
        `${cards} cards for ${agg?.reviewCount} rated reviews`
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

      check(
        `${page.path}: no hydration mismatch or runtime error`,
        complaints.length === 0,
        complaints[0] || ""
      );
      check(
        `${page.path}: the server-rendered <h1> is still there after the client render`,
        Boolean(domH1) && Boolean(rawH1) && domH1 === rawH1,
        `server "${rawH1.slice(0, 40)}" vs dom "${String(domH1).slice(0, 40)}"`
      );
      await tab.close();
    }

    await browser.close();
  }

  // ── Every public game page, schema against the page it describes ──────
  // The slug list comes from the sitemap — the same crawl surface a search
  // engine uses — so a game that drops out of the sitemap fails here rather
  // than silently reducing coverage.
  console.log("\n=== game landing pages: the schema must describe the page ===\n");
  const sitemap = await (await fetch(`${BASE_URL}/sitemap.xml`)).text();
  const gamePaths = [...sitemap.matchAll(/<loc>[^<]*\/games\/([a-z0-9-]+)<\/loc>/g)].map(
    (m) => `/games/${m[1]}`
  );
  check(
    "the sitemap lists every public game page",
    gamePaths.length >= 21 && new Set(gamePaths).size === gamePaths.length,
    `${gamePaths.length} game URLs`
  );
  for (const path of gamePaths) {
    const res = await fetch(BASE_URL + path, { redirect: "manual" });
    const html = await res.text();
    check(`${path}: served with 200`, res.status === 200, String(res.status));
    checkGameSchema({ path, html, text: visibleText(html), jsonLd: extractJsonLd(html) });
  }

  console.log("\n=== home page: the machine-readable identity ===\n");
  const home = await (await fetch(BASE_URL + "/")).text();
  const homeLd = extractJsonLd(home);
  const homeTypes = homeLd.flatMap(schemaTypes);
  check("home: Organization structured data", homeTypes.includes("Organization"));
  check("home: WebSite structured data", homeTypes.includes("WebSite"));
  check(
    "home: the app entity links back to the organization",
    homeTypes.includes("SoftwareApplication")
  );
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
    `${JSON.stringify(homeAgg ?? null)} vs ${JSON.stringify(reviewsAgg ?? null)}`
  );

  console.log(`\n${pass} passed / ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}

await main();
