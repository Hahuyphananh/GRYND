// qa/creator-fill-check.mjs
//
// Verifies the Creator Mode frame-fill CSS from src/app/globals.css:
// inside [data-creator-layout], the generic [data-creator-fill] wrapper
// (used by <CreatorResponsiveLayout>) makes the game page root fill the
// recording frame edge-to-edge — full width (desktop max-w caps and
// mx-auto centering overridden) and full height (min-height) — instead of
// leaving the game as a small centred strip in a much bigger frame.
// Games marked [data-creator-stack] are exempt (they keep their phone
// column). Desktop / non-creator rendering must be unchanged.
//
// Run: node qa/creator-fill-check.mjs

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

// Blackjack-like root (mx-auto max-w-5xl = the desktop cap), plus a
// stack-marked element to assert the phone-column exemption survives.
const html = `<!doctype html>
<html><head><meta charset="utf-8"></head>
<body>
  <div id="viewport" style="width:2000px">
    <!-- Portrait recording frame (9:16) -->
    <div id="frame-portrait" style="width:1080px;height:1920px;overflow:hidden">
      <div data-creator-layout="portrait" style="display:flex;flex-direction:column;height:100%;width:100%">
        <div data-creator-fill class="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
          <div class="game-root mx-auto max-w-5xl px-3 py-4 sm:px-4 sm:py-6">
            <div class="panel rounded-2xl p-6">opponent + table + hand</div>
          </div>
        </div>
      </div>
    </div>
    <!-- Portrait frame with a data-creator-stack element: must keep its
         phone-width cap even inside a fill container (the stack rules are
         scoped to the phone viewport, which is always present in the real
         DOM). -->
    <div id="frame-stack" style="width:1080px;height:1920px;overflow:hidden">
      <div data-creator-layout="portrait" style="display:flex;flex-direction:column;height:100%;width:100%">
        <div data-creator-phone class="relative flex min-h-0 min-w-0 flex-col self-start">
          <div data-creator-fill class="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
            <div data-creator-stack class="mx-auto flex w-full max-w-[1300px] flex-col gap-4 sm:flex-row">
              <div class="left-col">controls</div>
              <div class="right-col">board</div>
            </div>
          </div>
        </div>
      </div>
    </div>
    <!-- Portrait frame with a position:fixed banner inside the fill
         container (chess turn banner / end popup pattern): must keep its
         compact centered size, not stretch full-frame. -->
    <div id="frame-fixed" style="width:1080px;height:1920px;overflow:hidden">
      <div data-creator-layout="portrait" style="display:flex;flex-direction:column;height:100%;width:100%">
        <div data-creator-fill class="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
          <div class="game-root-banner mx-auto max-w-5xl px-3 py-4"><div class="panel p-6">game</div></div>
          <div class="fixed left-1/2 top-1/3 z-50 -translate-x-1/2 -translate-y-1/2 rounded-2xl px-10 py-6">turn banner</div>
        </div>
      </div>
    </div>
    <!-- Landscape recording frame (16:9): the game still renders inside
         the phone viewport (fitted, centered) → the fill rules must apply
         within the phone viewport too -->
    <div id="frame-landscape" style="width:1920px;height:1080px;overflow:hidden">
      <div data-creator-layout="landscape" style="display:flex;height:100%;width:100%">
        <div data-creator-phone class="relative flex min-h-0 min-w-0 flex-col self-start mx-auto"
             style="width:390px;height:693.3333333333334px;zoom:1.5576923076923077">
          <div data-creator-fill class="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
            <div class="game-root-landscape mx-auto max-w-5xl px-3 py-4 sm:px-4 sm:py-6">
              <div class="panel rounded-2xl p-6">landscape game</div>
            </div>
          </div>
        </div>
      </div>
    </div>
    <!-- No creator mode: plain page, must keep desktop max-width + centre -->
    <div id="plain">
      <div class="game-root-plain mx-auto max-w-5xl px-3 py-4 sm:px-4 sm:py-6">
        <div class="panel rounded-2xl p-6">plain game</div>
      </div>
    </div>
  </div>
</body></html>`;

const tmp = mkdtempSync(join(tmpdir(), "creator-fill-check-"));
writeFileSync(join(tmp, "input.html"), html);

const generated = await postcss([tailwind({ content: [join(tmp, "input.html")] })]).process(
  "@tailwind base;\n@tailwind components;\n@tailwind utilities;\n",
  { from: undefined },
);

// Append the creator fill + stacking CSS from globals.css.
const globals = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");
const start = globals.indexOf('[data-creator-phone] [data-creator-stack]');
const end = globals.indexOf("@media (prefers-reduced-motion", start);
if (start < 0) throw new Error("creator frame-fill CSS not found in globals.css");
const creatorCss = globals.slice(start, end).trim();
writeFileSync(join(tmp, "tw.css"), generated.css + "\n" + creatorCss);

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 2000, height: 2200 } });
  await page.goto("file://" + join(tmp, "input.html").replace(/\\/g, "/"));
  await page.addStyleTag({ path: join(tmp, "tw.css") });

const results = await page.evaluate(() => {
  const out = {};
  const fr = document.getElementById("frame-portrait").getBoundingClientRect();
  const ff = document.getElementById("frame-landscape").getBoundingClientRect();
  const landPhone = document.querySelector("#frame-landscape [data-creator-phone]").getBoundingClientRect();
  const root = document.querySelector(".game-root").getBoundingClientRect();
  const rootCss = getComputedStyle(document.querySelector(".game-root"));
  const landRoot = document.querySelector(".game-root-landscape").getBoundingClientRect();
  const landCss = getComputedStyle(document.querySelector(".game-root-landscape"));
  const stackRoot = document.querySelector('[data-creator-stack]');
  const stackCss = getComputedStyle(stackRoot);
  const banner = document.querySelector(".game-root-banner").parentElement.querySelector(".fixed");
  const bannerRect = banner.getBoundingClientRect();
  const bannerCss = getComputedStyle(banner);
  const plain = document.querySelector(".game-root-plain").getBoundingClientRect();
  const plainCss = getComputedStyle(document.querySelector(".game-root-plain"));
  out.portrait = { rootW: root.width, frameW: fr.width, rootH: root.height, frameH: fr.height };
  out.portraitMaxW = rootCss.maxWidth;
  out.landscape = { rootW: landRoot.width, frameW: ff.width, phoneW: landPhone.width, phoneH: landPhone.height, rootH: landRoot.height, frameH: ff.height };
  out.landscapeMaxW = landCss.maxWidth;
  out.stackMaxW = stackCss.maxWidth;
  out.stackDirection = stackCss.flexDirection;
  out.banner = { w: bannerRect.width, position: bannerCss.position };
  out.plain = { w: plain.width };
  out.plainMaxW = plainCss.maxWidth;
  // scrollability: fill container should allow internal scrolling
  const fill = document.querySelector('[data-creator-fill]');
  out.fillOverflowY = getComputedStyle(fill).overflowY;
  return out;
});

  console.log(JSON.stringify(results, null, 2));
  const check = (cond, label) => {
    console.log(cond ? "PASS" : "FAIL", label);
    return cond;
  };
  const passes = [];
  // Portrait: page root fills the full frame width
  passes.push(
    check(
      Math.abs(results.portrait.rootW - results.portrait.frameW) < 1,
      "portrait game root fills frame width",
    ),
  );
  passes.push(check(results.portraitMaxW === "none" || results.portraitMaxW === "100%", "portrait max-width cap removed"));
  // Portrait: root stretches to the full frame height
  passes.push(
    check(results.portrait.rootH >= results.portrait.frameH - 1, "portrait game root stretches to frame height"),
  );
  // Landscape: the game still fills its (fitted, centered) phone viewport
  passes.push(
    check(
      Math.abs(results.landscape.rootW - results.landscape.phoneW) < 1,
      "landscape game root fills phone viewport width",
    ),
  );
  passes.push(check(results.landscapeMaxW === "none" || results.landscapeMaxW === "100%", "landscape max-width cap removed"));
  passes.push(
    check(results.landscape.rootH >= results.landscape.phoneH - 1, "landscape game root stretches to phone viewport height"),
  );
  // Stack exemption: phone column keeps its cap + column direction
  passes.push(check(parseInt(results.stackMaxW, 10) <= 460, "data-creator-stack keeps phone-width cap (460px)"));
  passes.push(check(results.stackDirection === "column", "data-creator-stack keeps column direction"));
  // Fixed overlays inside the fill wrapper keep their compact size
  passes.push(check(results.banner.position === "fixed", "fixed banner is still position:fixed"));
  const expectedBannerLimit = 460; // px-10 py-6 text chip — far smaller than the 1080 frame
  passes.push(
    check(results.banner.w < expectedBannerLimit, "fixed banner keeps compact width (not stretched full-frame)"),
  );
  // Non-creator rendering untouched: plain page keeps desktop max-width
  passes.push(check(Math.abs(results.plain.w - 1024) < 2, "no creator mode keeps desktop max-w-5xl (1024px)"));
  passes.push(check(results.plainMaxW.includes("1024"), "no creator mode keeps desktop max-width value"));
  // Scrollability inside the frame
  passes.push(check(results.fillOverflowY === "auto" || results.fillOverflowY === "scroll", "frame content scrolls internally when taller"));

  const failed = passes.filter((p) => !p);
  console.log(failed.length === 0 ? "ALL PASS" : `${failed.length} FAILED`);
  process.exitCode = failed.length === 0 ? 0 : 1;
} finally {
  await browser.close();
}