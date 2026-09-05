// qa/creator-phone-check.mjs
//
// Verifies the Creator Mode phone-frame behavior from
// src/components/creator-mode/CreatorModeLayout.jsx (the `data-creator-phone`
// wrapper rendered by <CreatorResponsiveLayout>) + src/app/globals.css:
//
//   • EVERY recording ratio lays the game out at a real phone width
//     (390px) and `zoom`s it up to fill the output frame.
//   • Portrait (9:16): the phone viewport FILLS the whole 1080×1920
//     output frame edge-to-edge (getBoundingClientRect ≈ 1080×1920,
//     anchored top-left).
//   • Landscape (16:9) / square (1:1): the full phone screen is fitted
//     inside the frame, centered, zoomed to fill the frame height — the
//     recording looks like a real phone screen (never a shrunken
//     desktop page).
//   • The generic [data-creator-fill] root still fills the phone viewport
//     (desktop max-w caps overridden; full width + height).
//   • A [data-creator-stack] GRID (chess-ai style board + sidebar) collapses
//     to a single stacked column inside the phone viewport.
//   • Non-creator rendering is byte-for-byte unchanged.
//
// Run: node qa/creator-phone-check.mjs

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

// Mirrors the exact DOM <CreatorResponsiveLayout> renders: shell →
// (portrait) data-creator-phone wrapper → data-creator-fill → game root.
// PHONE_LAYOUT_WIDTH = 390; phoneHeight = 1920 / (1080 / 390) = 693.333…;
// zoom = 1080 / 390 = 2.769230769230769.
const html = `<!doctype html>
<html><head><meta charset="utf-8"></head>
<body>
  <div id="viewport" style="width:2000px">
    <!-- Portrait recording frame (9:16) with the phone viewport -->
    <div id="frame-portrait" style="width:1080px;height:1920px;overflow:hidden">
      <div data-creator-layout="portrait" style="display:flex;flex-direction:column;height:100%;width:100%;overflow:hidden">
        <div data-creator-phone class="relative flex min-h-0 min-w-0 flex-col self-start"
             style="width:390px;height:693.3333333333334px;zoom:2.769230769230769">
          <div data-creator-fill class="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
            <div class="game-root mx-auto max-w-5xl px-3 py-4 sm:px-4 sm:py-6">
              <div class="panel rounded-2xl p-6">opponent + table + hand</div>
              <div data-creator-stack class="grid lg:grid-cols-[1fr_340px] gap-8 items-start">
                <div class="board-col">board</div>
                <div class="side-col">sidebar</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
    <!-- Landscape recording frame (16:9): full phone screen fitted inside,
         centered, zoomed to fill the height -->
    <div id="frame-landscape" style="width:1920px;height:1080px;overflow:hidden">
      <div data-creator-layout="landscape" style="display:flex;height:100%;width:100%">
        <div data-creator-phone class="relative flex min-h-0 min-w-0 flex-col self-start mx-auto"
             style="width:390px;height:693.3333333333334px;zoom:1.5576923076923077">
          <div data-creator-fill class="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
            <div class="game-root-landscape mx-auto max-w-5xl px-3 py-4">
              <div class="panel rounded-2xl p-6">landscape game</div>
            </div>
          </div>
        </div>
      </div>
    </div>
    <!-- Square recording frame (1:1): same phone treatment -->
    <div id="frame-square" style="width:1080px;height:1080px;overflow:hidden">
      <div data-creator-layout="square" style="display:flex;height:100%;width:100%">
        <div data-creator-phone class="relative flex min-h-0 min-w-0 flex-col self-start mx-auto"
             style="width:390px;height:693.3333333333334px;zoom:1.5576923076923077">
          <div data-creator-fill class="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
            <div class="game-root-square mx-auto max-w-5xl px-3 py-4">
              <div class="panel rounded-2xl p-6">square game</div>
            </div>
          </div>
        </div>
      </div>
    </div>
    <!-- No creator mode: plain page, must keep desktop max-width + centre -->
    <div id="plain">
      <div class="game-root-plain mx-auto max-w-5xl px-3 py-4">
        <div class="panel rounded-2xl p-6">plain game</div>
      </div>
    </div>
  </div>
</body></html>`;

const tmp = mkdtempSync(join(tmpdir(), "creator-phone-check-"));
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
    const fl = document.getElementById("frame-landscape").getBoundingClientRect();
    const fs = document.getElementById("frame-square").getBoundingClientRect();
    const phones = [...document.querySelectorAll("[data-creator-phone]")];
    const phoneStyle = getComputedStyle(phones[0]);
    const portraitPhone = phones[0].getBoundingClientRect();
    const landPhone = phones[1].getBoundingClientRect();
    const squarePhone = phones[2].getBoundingClientRect();
    const root = document.querySelector(".game-root");
    const rootRect = root.getBoundingClientRect();
    const rootCss = getComputedStyle(root);
    const stack = document.querySelector("[data-creator-stack]");
    const stackCss = getComputedStyle(stack);
    const stackKids = [...stack.children].map((k) => {
      const r = k.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom };
    });
    const landRoot = document.querySelector(".game-root-landscape").getBoundingClientRect();
    const landCss = getComputedStyle(document.querySelector(".game-root-landscape"));
    const squareRoot = document.querySelector(".game-root-square").getBoundingClientRect();
    const plain = document.querySelector(".game-root-plain").getBoundingClientRect();
    const plainCss = getComputedStyle(document.querySelector(".game-root-plain"));
    out.phone = {
      w: portraitPhone.width,
      h: portraitPhone.height,
      left: portraitPhone.left,
      top: portraitPhone.top,
      cssWidth: phoneStyle.width,
      zoom: phoneStyle.zoom,
    };
    out.portrait = { frameW: fr.width, frameH: fr.height };
    out.landscape = {
      frameW: fl.width,
      frameH: fl.height,
      phoneW: landPhone.width,
      phoneH: landPhone.height,
      phoneLeft: landPhone.left,
      phoneTop: landPhone.top,
    };
    out.square = {
      frameW: fs.width,
      frameH: fs.height,
      phoneW: squarePhone.width,
      phoneH: squarePhone.height,
      phoneLeft: squarePhone.left,
      phoneTop: squarePhone.top,
    };
    out.root = { w: rootRect.width, h: rootRect.height, maxW: rootCss.maxWidth };
    out.stack = { gridTemplateColumns: stackCss.gridTemplateColumns, kids: stackKids };
    out.landRoot = { w: landRoot.width, h: landRoot.height, maxW: landCss.maxWidth };
    out.plain = { w: plain.width, maxW: plainCss.maxWidth };
    return out;
  });

  console.log(JSON.stringify(results, null, 2));
  const check = (cond, label) => {
    console.log(cond ? "PASS" : "FAIL", label);
    return cond;
  };
  const passes = [];
  // Phone wrapper is laid out at 390px CSS width (the phone layout width)
  passes.push(check(parseInt(results.phone.cssWidth, 10) === 390, "phone wrapper lays out at 390px CSS width"));
  // …and zoomed up so it fills the whole 1080×1920 portrait frame edge-to-edge
  passes.push(
    check(Math.abs(results.phone.w - results.portrait.frameW) < 2, "portrait phone viewport fills frame width"),
  );
  passes.push(
    check(Math.abs(results.phone.h - results.portrait.frameH) < 2, "portrait phone viewport fills frame height"),
  );
  passes.push(check(results.phone.left === 0 && results.phone.top === 0, "portrait phone viewport anchored top-left"));
  // Landscape: the full phone screen is fitted inside the frame, centered,
  // zoomed to fill the frame HEIGHT (1080px) — the game renders as a real
  // phone screen, never a shrunken desktop page.
  passes.push(
    check(Math.abs(results.landscape.phoneH - results.landscape.frameH) < 2, "landscape phone viewport fills frame height"),
  );
  passes.push(
    check(results.landscape.phoneW < results.landscape.frameW, "landscape phone viewport is narrower than the frame (fitted, centered)"),
  );
  passes.push(
    check(
      Math.abs(results.landscape.phoneLeft - (results.landscape.frameW - results.landscape.phoneW) / 2) < 2,
      "landscape phone viewport is centered horizontally",
    ),
  );
  // Square: same fitted phone-screen treatment
  passes.push(
    check(Math.abs(results.square.phoneH - results.square.frameH) < 2, "square phone viewport fills frame height"),
  );
  passes.push(
    check(
      Math.abs(results.square.phoneLeft - (results.square.frameW - results.square.phoneW) / 2) < 2,
      "square phone viewport is centered horizontally",
    ),
  );
  // The game root fills the whole phone viewport (its getBoundingClientRect
  // is the zoomed size, so the game content fills the output edge-to-edge)
  passes.push(check(Math.abs(results.root.w - results.phone.w) < 1, "game root fills phone viewport width (zoomed 1080px)"));
  passes.push(check(Math.abs(results.root.h - results.phone.h) < 1, "game root fills phone viewport height (zoomed 1920px)"));
  passes.push(check(results.root.maxW === "none" || results.root.maxW === "100%", "game root desktop max-width cap removed"));
  passes.push(check(Math.abs(results.landRoot.w - results.landscape.phoneW) < 1, "landscape game root fills its phone viewport"));
  passes.push(check(results.landRoot.maxW === "none" || results.landRoot.maxW === "100%", "landscape max-width cap removed"));
  // data-creator-stack GRID stacks to a single column (children stacked vertically)
  passes.push(
    check(
      results.stack.kids.length === 2 &&
        results.stack.kids[1].top >= results.stack.kids[0].bottom - 1,
      "data-creator-stack grid stacks children into one column",
    ),
  );
  // Non-creator rendering untouched
  passes.push(check(Math.abs(results.plain.w - 1024) < 2, "no creator mode keeps desktop max-w-5xl (1024px)"));
  passes.push(check(results.plain.maxW.includes("1024"), "no creator mode keeps desktop max-width value"));

  const failed = passes.filter((p) => !p);
  console.log(failed.length === 0 ? "ALL PASS" : `${failed.length} FAILED`);
  process.exitCode = failed.length === 0 ? 0 : 1;
} finally {
  await browser.close();
}
