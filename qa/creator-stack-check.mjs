// qa/creator-stack-check.mjs
//
// Verifies the Creator Mode phone-stacking CSS from src/app/globals.css:
// inside the phone viewport ([data-creator-phone], rendered by
// <CreatorResponsiveLayout> in EVERY recording ratio), games marked
// [data-creator-stack] switch to a phone-style stacked column (and
// [data-creator-stack-swap] additionally puts gameplay first). Desktop /
// non-creator rendering must be unchanged.
//
// Run: node qa/creator-stack-check.mjs

import { chromium } from "playwright";
import tailwind from "tailwindcss";
import postcss from "postcss";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!existsSync("node_modules/tailwindcss")) {
  console.log("tailwindcss not installed — install deps first (npm ci)");
  process.exit(1);
}

// Tailwind classes that mirror the games' real desktop layouts (row at
// sm:/md:/lg: breakpoints, exactly what the 1080px-wide creator frame
// sees today).
const html = `<!doctype html>
<html><head><meta charset="utf-8"></head>
<body>
  <div id="viewport" style="width:1280px">
    <!-- Portrait recording frame (CreatorModeProvider-style) -->
    <div id="frame-portrait" style="width:1080px;height:1920px;overflow:hidden">
      <div data-creator-layout="portrait" style="display:flex;flex-direction:column;height:100%;width:100%">
        <div data-creator-phone class="relative flex min-h-0 min-w-0 flex-col self-start">
        <div id="main" style="flex:1;overflow-y:auto;display:flex;justify-content:flex-start;align-items:flex-start">
          <div class="roulette-body flex flex-col sm:flex-row w-full max-w-[1300px]" data-creator-stack data-creator-stack-swap>
            <div class="left-col">controls panel</div>
            <div class="right-col">wheel + board</div>
          </div>
        </div>
        </div>
      </div>
    </div>
    <!-- Landscape recording frame: also a phone viewport → must stack too -->
    <div id="frame-landscape" style="width:1080px;height:600px;overflow:hidden">
      <div data-creator-layout="landscape" style="display:flex;height:100%;width:100%">
        <div data-creator-phone class="relative flex min-h-0 min-w-0 flex-col self-start mx-auto">
          <div class="roulette-body-landscape flex flex-col sm:flex-row w-full max-w-[1300px]" data-creator-stack>
            <div class="left-col">controls panel</div>
            <div class="right-col">wheel + board</div>
          </div>
        </div>
      </div>
    </div>
    <!-- No creator mode: plain page, must keep desktop row -->
    <div id="plain">
      <div class="roulette-body-plain flex flex-col sm:flex-row w-full max-w-[1300px]">
        <div class="left-col">controls panel</div>
        <div class="right-col">wheel + board</div>
      </div>
    </div>
  </div>
</body></html>`;

const tmp = mkdtempSync(join(tmpdir(), "creator-check-"));
writeFileSync(join(tmp, "input.html"), html);

const generated = await postcss([tailwind({ content: [join(tmp, "input.html")] })]).process(
  "@tailwind base;\n@tailwind components;\n@tailwind utilities;\n",
  { from: undefined },
);

// Append the creator portrait-stacking rules from globals.css.
const globals = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");
const start = globals.indexOf('[data-creator-phone] [data-creator-stack]');
const end = globals.indexOf("@media (prefers-reduced-motion", start);
if (start < 0) throw new Error("portrait-stacking CSS not found in globals.css");
const stackingCss = globals.slice(start, end).trim();
writeFileSync(join(tmp, "tw.css"), generated.css + "\n" + stackingCss);

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 2000 } });
  await page.goto("file://" + join(tmp, "input.html").replace(/\\/g, "/"));
  await page.addStyleTag({ path: join(tmp, "tw.css") });

  const results = await page.evaluate(() => {
    const out = {};
    const body = document.querySelector(".roulette-body");
    const cs = getComputedStyle(body);
    out.portraitDirection = cs.flexDirection;
    out.portraitMaxWidth = cs.maxWidth;
    const kids = [...body.children];
    // Visual (rendered) order — topmost child first.
    const sorted = kids
      .map((k, i) => ({ i, y: k.getBoundingClientRect().top }))
      .sort((a, b) => a.y - b.y);
    out.visualFirstChild = kids[sorted[0].i].textContent.trim();
    out.visualSecondChild = kids[sorted[1].i].textContent.trim();
    out.portraitFirstOrder = getComputedStyle(kids[0]).order;
    out.portraitSecondOrder = getComputedStyle(kids[1]).order;
    out.landscapeDirection = getComputedStyle(document.querySelector(".roulette-body-landscape")).flexDirection;
    out.landscapeMaxWidth = getComputedStyle(document.querySelector(".roulette-body-landscape")).maxWidth;
    out.plainDirection = getComputedStyle(document.querySelector(".roulette-body-plain")).flexDirection;
    out.portraitLeftWidth = getComputedStyle(document.querySelector(".left-col")).width;
    return out;
  });

  console.log(JSON.stringify(results, null, 2));
  const check = (cond, label) => {
    console.log(cond ? "PASS" : "FAIL", label);
    return cond;
  };
  const passes = [];
  passes.push(check(results.portraitDirection === "column", "portrait forces column"));
  passes.push(check(parseInt(results.portraitMaxWidth, 10) <= 460, "portrait caps width to phone column (460px)"));
  passes.push(check(results.visualFirstChild === "wheel + board", "swap puts gameplay (wheel) first on screen"));
  passes.push(check(Number(results.portraitFirstOrder) > Number(results.portraitSecondOrder), "flex orders swapped so controls land below"));
  // Landscape is a phone viewport too → the stack rules apply there as well
  passes.push(check(results.landscapeDirection === "column", "landscape phone viewport stacks to a column"));
  passes.push(check(parseInt(results.landscapeMaxWidth, 10) <= 460, "landscape phone column keeps phone-width cap"));
  passes.push(check(results.plainDirection === "row", "no creator mode keeps desktop row"));
  const failed = passes.filter((p) => !p);
  console.log(failed.length === 0 ? "ALL PASS" : `${failed.length} FAILED`);
  process.exitCode = failed.length === 0 ? 0 : 1;
} finally {
  await browser.close();
}