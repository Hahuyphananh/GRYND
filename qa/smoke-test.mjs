import { chromium } from "playwright";
import fs from "node:fs";

const baseUrl =
  process.env.GRYND_URL || "https://www.grynd.mywire.org/";

const errors = [];
const visited = new Set();

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

page.on("console", message => {
  if (message.type() === "error") {
    errors.push({
      type: "console",
      message: message.text(),
      url: page.url()
    });
  }
});

page.on("pageerror", error => {
  errors.push({
    type: "pageerror",
    message: error.message,
    url: page.url()
  });
});

page.on("requestfailed", request => {
  const url = request.url();

  // Ignore normal browser/framework aborts.
  if (
    request.failure()?.errorText === "net::ERR_ABORTED" &&
    !url.includes("/api/")
  ) {
    return;
  }

  errors.push({
    type: "requestfailed",
    url,
    error: request.failure()?.errorText || "unknown"
  });
});

page.on("response", response => {
  if (response.status() >= 400) {
    errors.push({
      type: "http",
      status: response.status(),
      url: response.url()
    });
  }
});

async function visit(url) {
  if (visited.has(url)) return;

  visited.add(url);

  try {
    console.log(`Visiting ${url}`);

    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 30000
    });

    if (response && response.status() >= 400) {
      errors.push({
        type: "navigation",
        status: response.status(),
        url
      });
    }

    await page.waitForTimeout(2000);
  } catch (error) {
    errors.push({
      type: "navigation-error",
      url,
      message: error.message
    });
  }
}

await visit(baseUrl);

const links = await page.locator("a").evaluateAll(anchors =>
  anchors
    .map(a => a.href)
    .filter(Boolean)
);

const sameOriginLinks = [
  ...new Set(
    links.filter(link => {
      try {
        return new URL(link).origin === new URL(baseUrl).origin;
      } catch {
        return false;
      }
    })
  )
];

for (const url of sameOriginLinks.slice(0, 25)) {
  await visit(url);
}

const report = {
  timestamp: new Date().toISOString(),
  baseUrl,
  pagesVisited: [...visited],
  errors
};

fs.mkdirSync("qa/reports", {
  recursive: true
});

fs.writeFileSync(
  "qa/reports/qa-report.json",
  JSON.stringify(report, null, 2)
);

console.log("");
console.log("Detected errors:");
console.log(JSON.stringify(errors, null, 2));

await browser.close();

process.exitCode = errors.length > 0 ? 1 : 0;
