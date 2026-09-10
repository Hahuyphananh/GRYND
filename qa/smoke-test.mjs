```js
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const baseUrl =
  process.env.GRYND_URL || "https://www.grynd.dedyn.io/";

const errors = [];
const visited = new Set();
const queued = new Set();

const MAX_CRAWLED_PAGES = 150;
const PAGE_WAIT_MS = 1500;

const browser = await chromium.launch({
  headless: true
});

const context = await browser.newContext({
  viewport: {
    width: 1440,
    height: 900
  }
});

const page = await context.newPage();

/*
 * ---------------------------------------------------------
 * ERROR FILTERING
 * ---------------------------------------------------------
 */

function isTawkUrl(url = "") {
  return url.toLowerCase().includes("tawk.to");
}

function isExpected401(url = "", status = null) {
  return (
    status === 401 &&
    url.includes("/api/")
  );
}

/*
 * Browser console errors
 */
page.on("console", message => {
  if (message.type() !== "error") {
    return;
  }

  const messageText = message.text();

  /*
   * Tawk.to is a third-party service.
   * Its browser/CORS errors should not make Grynd fail QA.
   */
  if (
    messageText.toLowerCase().includes("tawk.to")
  ) {
    return;
  }

  errors.push({
    type: "console",
    message: messageText,
    url: page.url()
  });
});

/*
 * Unhandled JavaScript errors
 */
page.on("pageerror", error => {
  errors.push({
    type: "pageerror",
    message: error.message,
    url: page.url()
  });
});

/*
 * Failed network requests
 */
page.on("requestfailed", request => {
  const url = request.url();
  const errorText =
    request.failure()?.errorText || "unknown";

  /*
   * Ignore normal browser/framework aborts.
   */
  if (
    errorText === "net::ERR_ABORTED" &&
    !url.includes("/api/")
  ) {
    return;
  }

  /*
   * Ignore third-party Tawk.to failures.
   */
  if (isTawkUrl(url)) {
    return;
  }

  /*
   * Ignore expected unauthenticated API failures.
   */
  if (
    url.includes("/api/") &&
    errorText.toLowerCase().includes("401")
  ) {
    return;
  }

  errors.push({
    type: "requestfailed",
    url,
    error: errorText
  });
});

/*
 * HTTP responses
 */
page.on("response", response => {
  const status = response.status();
  const url = response.url();

  /*
   * Ignore Tawk.to HTTP problems.
   */
  if (isTawkUrl(url)) {
    return;
  }

  /*
   * A protected API returning 401 to our unauthenticated
   * QA browser is expected.
   */
  if (isExpected401(url, status)) {
    return;
  }

  if (status >= 400) {
    errors.push({
      type: "http",
      status,
      url
    });
  }
});

/*
 * ---------------------------------------------------------
 * NEXT.JS ROUTE DISCOVERY
 * ---------------------------------------------------------
 *
 * Your repository uses:
 *
 * src/app/
 *
 * Examples found in the repository:
 *
 * src/app/casino/page.jsx
 * src/app/casino/chess/page.jsx
 * src/app/casino/keno/page.jsx
 * src/app/casino/blackjack/page.tsx
 *
 * Dynamic routes such as:
 *
 * src/app/casino/blackjack/[matchId]/...
 *
 * are skipped because we cannot safely invent a real match ID.
 */

function discoverNextRoutes() {
  const routes = new Set();

  const appRoot = path.join(
    process.cwd(),
    "src",
    "app"
  );

  if (!fs.existsSync(appRoot)) {
    console.log(
      "WARNING: src/app was not found."
    );

    return [];
  }

  function scan(directory, routeParts = []) {
    const entries = fs.readdirSync(
      directory,
      {
        withFileTypes: true
      }
    );

    for (const entry of entries) {
      /*
       * Ignore generated/dependency directories.
       */
      if (
        entry.name === "node_modules" ||
        entry.name === ".next" ||
        entry.name === ".git"
      ) {
        continue;
      }

      const fullPath = path.join(
        directory,
        entry.name
      );

      if (entry.isDirectory()) {
        /*
         * Next.js route groups:
         *
         * (auth)
         * (casino)
         *
         * do not appear in URLs.
         */
        const isRouteGroup =
          entry.name.startsWith("(") &&
          entry.name.endsWith(")");

        const nextRouteParts =
          isRouteGroup
            ? routeParts
            : [
                ...routeParts,
                entry.name
              ];

        scan(
          fullPath,
          nextRouteParts
        );

        continue;
      }

      const isPage =
        entry.name === "page.js" ||
        entry.name === "page.jsx" ||
        entry.name === "page.ts" ||
        entry.name === "page.tsx";

      if (!isPage) {
        continue;
      }

      const route =
        routeParts.length === 0
          ? "/"
          : `/${routeParts.join("/")}`;

      /*
       * Skip dynamic routes.
       *
       * Examples:
       * [matchId]
       * [id]
       * [...slug]
       * [[...slug]]
       */
      if (
        route.includes("[") ||
        route.includes("]")
      ) {
        console.log(
          `Skipping dynamic route: ${route}`
        );

        continue;
      }

      routes.add(route);
    }
  }

  scan(appRoot);

  return [...routes].sort();
}

/*
 * ---------------------------------------------------------
 * CONFIRMED IMPORTANT GRYND ROUTES
 * ---------------------------------------------------------
 *
 * These routes were found in the repository and are
 * explicitly included so they are always tested even if
 * the homepage does not link to them.
 *
 * Do NOT add dynamic [matchId] URLs here.
 */

const criticalRoutes = [
  "/",
  "/casino",

  "/casino/chess",
  "/casino/chess/ai",

  "/casino/keno",
  "/casino/keno-pvp",

  "/casino/blackjack",

  "/casino/plinko",

  "/casino/roulette",

  "/casino/rps",

  "/casino/uno",

  "/casino/odds",

  "/casino/precision",

  "/casino/mines-pvp",

  "/casino/memory-grid",

  "/casino/lane-runner",
  "/casino/lane-runner/history",

  "/casino/hex-duel",

  "/faq",
  "/contact",
  "/profil",
  "/classement",
  "/fair-play",
  "/accessibility",
  "/privacy-policy",
  "/security-policy",
  "/terms"
];

/*
 * ---------------------------------------------------------
 * URL HELPERS
 * ---------------------------------------------------------
 */

function normalizeUrl(url) {
  try {
    const parsed = new URL(
      url,
      baseUrl
    );

    const base = new URL(baseUrl);

    /*
     * Only crawl Grynd's own domain.
     */
    if (parsed.origin !== base.origin) {
      return null;
    }

    /*
     * Remove fragments because:
     *
     * /casino#top
     *
     * and
     *
     * /casino#bottom
     *
     * are the same page for QA purposes.
     */
    parsed.hash = "";

    return parsed.toString();
  } catch {
    return null;
  }
}

function routeToUrl(route) {
  return new URL(
    route,
    baseUrl
  ).toString();
}

/*
 * ---------------------------------------------------------
 * PAGE VISIT
 * ---------------------------------------------------------
 */

async function visit(url) {
  const normalizedUrl =
    normalizeUrl(url);

  if (!normalizedUrl) {
    return [];
  }

  if (visited.has(normalizedUrl)) {
    return [];
  }

  if (
    visited.size >= MAX_CRAWLED_PAGES
  ) {
    return [];
  }

  visited.add(normalizedUrl);

  console.log(
    `[${visited.size}/${MAX_CRAWLED_PAGES}] Visiting ${normalizedUrl}`
  );

  try {
    const response = await page.goto(
      normalizedUrl,
      {
        waitUntil: "domcontentloaded",
        timeout: 30000
      }
    );

    /*
     * Navigation HTTP errors.
     */
    if (
      response &&
      response.status() >= 400
    ) {
      errors.push({
        type: "navigation",
        status: response.status(),
        url: normalizedUrl
      });
    }

    /*
     * Give client-side React/Next.js code time
     * to initialize.
     */
    await page.waitForTimeout(
      PAGE_WAIT_MS
    );

    /*
     * Collect links from the page.
     */
    const links =
      await page.locator("a").evaluateAll(
        anchors =>
          anchors
            .map(anchor => anchor.href)
            .filter(Boolean)
      );

    return links
      .map(normalizeUrl)
      .filter(Boolean);

  } catch (error) {
    errors.push({
      type: "navigation-error",
      url: normalizedUrl,
      message: error.message
    });

    return [];
  }
}

/*
 * ---------------------------------------------------------
 * ROUTE TESTING
 * ---------------------------------------------------------
 */

const discoveredRoutes =
  discoverNextRoutes();

console.log("");
console.log(
  `Discovered ${discoveredRoutes.length} static Next.js routes.`
);

const allRoutes = [
  ...new Set([
    ...criticalRoutes,
    ...discoveredRoutes
  ])
];

console.log(
  `Testing ${allRoutes.length} known routes.`
);

console.log("");

/*
 * First test every known static route.
 */
for (const route of allRoutes) {
  if (
    visited.size >= MAX_CRAWLED_PAGES
  ) {
    break;
  }

  const url =
    routeToUrl(route);

  queued.add(url);

  const links =
    await visit(url);

  /*
   * Add newly discovered same-origin links
   * to the crawl queue.
   */
  for (const link of links) {
    if (
      !visited.has(link) &&
      !queued.has(link)
    ) {
      queued.add(link);
    }
  }
}

/*
 * ---------------------------------------------------------
 * RECURSIVE SAME-ORIGIN CRAWL
 * ---------------------------------------------------------
 *
 * Unlike the old version, this does not stop after
 * 25 homepage links.
 *
 * It continues discovering links from visited pages.
 *
 * Safety limit: 150 pages.
 */

const crawlQueue = [
  ...queued
];

let crawlIndex = 0;

while (
  crawlIndex < crawlQueue.length &&
  visited.size < MAX_CRAWLED_PAGES
) {
  const url =
    crawlQueue[crawlIndex];

  crawlIndex++;

  if (
    !url ||
    visited.has(url)
  ) {
    continue;
  }

  const links =
    await visit(url);

  for (const link of links) {
    if (
      !visited.has(link) &&
      !crawlQueue.includes(link)
    ) {
      crawlQueue.push(link);
    }
  }
}

/*
 * ---------------------------------------------------------
 * DEDUPLICATE ERRORS
 * ---------------------------------------------------------
 */

const uniqueErrors = [
  ...new Map(
    errors.map(error => [
      JSON.stringify(error),
      error
    ])
  ).values()
];

/*
 * ---------------------------------------------------------
 * QA REPORT
 * ---------------------------------------------------------
 */

const report = {
  timestamp:
    new Date().toISOString(),

  baseUrl,

  pagesVisitedCount:
    visited.size,

  pagesVisited:
    [...visited],

  discoveredStaticRoutes:
    discoveredRoutes,

  criticalRoutes,

  crawlLimit:
    MAX_CRAWLED_PAGES,

  errors:
    uniqueErrors
};

fs.mkdirSync(
  "qa/reports",
  {
    recursive: true
  }
);

fs.writeFileSync(
  "qa/reports/qa-report.json",
  JSON.stringify(
    report,
    null,
    2
  )
);

console.log("");
console.log(
  "========================================"
);

console.log(
  `Pages visited: ${visited.size}`
);

console.log(
  `Errors detected: ${uniqueErrors.length}`
);

console.log(
  "========================================"
);

console.log("");

if (uniqueErrors.length > 0) {
  console.log(
    "Detected errors:"
  );

  console.log(
    JSON.stringify(
      uniqueErrors,
      null,
      2
    )
  );
} else {
  console.log(
    "Grynd browser QA completed successfully."
  );
}

await browser.close();

process.exitCode =
  uniqueErrors.length > 0
    ? 1
    : 0;
```
