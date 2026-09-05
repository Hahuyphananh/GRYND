// qa/creator-recording-audit.mjs
//
// Browser audit for the three reported Creator Mode clip issues:
//
//   1. "not centered"            — is the game content centered in the
//                                  recorded frame?
//   2. "not big enough to see"   — how much of the recorded frame does the
//                                  game content actually cover?
//   3. "record the scrolling"    — when the user scrolls inside the game,
//                                  does the recorded snapshot follow the
//                                  scroll position?
//
// It mirrors EXACTLY what the recorder does (src/lib/creator-mode/
// recorder.ts drawCompositeFrame / serializeContainerClean):
//   • builds the DOM the provider + CreatorResponsiveLayout render
//     (data-creator-recording frame → data-creator-layout shell →
//     data-creator-phone viewport → data-creator-fill scroll container),
//     INCLUDING the frame's on-screen `transform: scale()` inline style
//   • clones the frame (`cloneNode(true)`, like serializeContainerClean)
//   • serializes the clone into a <foreignObject> SVG data: URL
//   • draws it into an output canvas at the selected dimensions
//     (fitRect letterbox math, like drawCompositeFrame)
//
// Then it MEASURES the recorded canvas: the bounding box of painted
// content (non-black pixels) tells us where the game sits and how much of
// the frame it covers; sampling colors at fixed positions tells us which
// marker (top header vs. mid game) is actually visible after scrolling.
//
// Run: node qa/creator-recording-audit.mjs

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

// ── Snapshot + measurement helpers (mirror of recorder.drawCompositeFrame) ──

const SNAPSHOT_SNIPPET = `
  window.__snapshot = async (frameSel, outputW, outputH) => {
    const container = document.querySelector(frameSel);
    const cw = container.offsetWidth || 1;
    const ch = container.offsetHeight || 1;
    // EXACT clone behavior of serializeContainerClean (recorder.ts):
    //   • cloneNode(true)
    //   • capture scroll offsets BEFORE cloning, re-apply to the clone
    //   • strip the container's own screen-fit transform
    //   • inline styles kept verbatim otherwise
    const scrolls = [];
    const collectScrolls = (el, path) => {
      if (el.scrollTop > 0 || el.scrollLeft > 0) scrolls.push({ path, top: el.scrollTop, left: el.scrollLeft });
      Array.from(el.children).forEach((child, i) => collectScrolls(child, path.concat(i)));
    };
    collectScrolls(container, []);
    const clone = container.cloneNode(true);
    clone.style.removeProperty("transform");
    clone.style.removeProperty("transform-origin");
    // scrollTop is a live layout property, NOT serializable — so
    // simulate the scrolled view by translating each scrolled element's
    // children by the negative offset (its overflow clip makes this
    // visually identical to scrolling).
    for (const s of scrolls) {
      let node = clone, ok = true;
      for (const i of s.path) {
        const child = node.children[i];
        if (!child) { ok = false; break; }
        node = child;
      }
      if (ok) {
        const tx = s.left ? -s.left + "px" : "0px";
        const ty = s.top ? -s.top + "px" : "0px";
        for (const child of Array.from(node.children)) {
          child.style.translate = tx + " " + ty;
        }
      }
    }
    clone.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
    const html = new XMLSerializer().serializeToString(clone);
    // Page CSS like collectPageCss (urls only — none in the fixtures).
    let css = "";
    for (const sheet of Array.from(document.styleSheets)) {
      try { for (const rule of Array.from(sheet.cssRules)) css += rule.cssText + "\\n"; }
      catch { /* cross-origin sheet */ }
    }
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="' + cw + '" height="' + ch + '" viewBox="0 0 ' + cw + ' ' + ch + '">' +
      '<style><![CDATA[' + css + ']]></style>' +
      '<foreignObject width="' + cw + '" height="' + ch + '">' + html + '</foreignObject></svg>';
    const url = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    const img = new Image();
    await new Promise((ok, fail) => { img.onload = ok; img.onerror = fail; img.src = url; });
    if (img.decode) await img.decode();
    // fitRect letterbox math — same as recorder.
    const scale = Math.min(outputW / cw, outputH / ch);
    const w = cw * scale, h = ch * scale;
    const x = (outputW - w) / 2, y = (outputH - h) / 2;
    const out = document.createElement("canvas");
    out.width = outputW; out.height = outputH;
    const ctx = out.getContext("2d");
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, outputW, outputH);
    ctx.drawImage(img, x, y, w, h);
    // Measure: bounding box + coverage of non-black pixels + sampled
    // colors at given output-canvas positions.
    const data = ctx.getImageData(0, 0, outputW, outputH).data;
    let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1, painted = 0;
    for (let py = 0; py < outputH; py++) {
      for (let px = 0; px < outputW; px++) {
        const i = (py * outputW + px) * 4;
        if (data[i] || data[i+1] || data[i+2]) {
          painted++;
          if (px < minX) minX = px;
          if (px > maxX) maxX = px;
          if (py < minY) minY = py;
          if (py > maxY) maxY = py;
        }
      }
    }
    const sample = (px, py) => {
      const i = (py * outputW + px) * 4;
      return [data[i], data[i+1], data[i+2]].join(",");
    };
    return {
      cw, ch,
      paintedFraction: painted / (outputW * outputH),
      bbox: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 },
      frameW: outputW, frameH: outputH,
      // Center offset of the painted content vs. the frame center.
      centerDeltaX: Math.round(((minX + maxX + 1) / 2) - outputW / 2),
      centerDeltaY: Math.round(((minY + maxY + 1) / 2) - outputH / 2),
      // Colors just below the top edge / at mid-height, in the middle
      // column — tells which marker is visible (red header, green game,
      // blue tail).
      topBand: sample(Math.round(outputW / 2), 40),
      midBand: sample(Math.round(outputW / 2), Math.round(outputH / 2)),
    };
  };
`;

// ── Test fixtures: the EXACT DOM CreatorModeProvider + ResponsiveLayout render ──

// Portrait 9:16 phone frame. The frame carries the provider's inline
// `transform: scale()` (screen-fit device). Content: red header → green
// game → blue tail, taller than the viewport so the fill scrolls.
function phoneHtml({ frameTransform, scrollTop, tall = true }) {
  return `<!doctype html>
<html><head><meta charset="utf-8"></head>
<body>
  <div id="viewport" style="width:2000px">
    <div id="frame-portrait" data-creator-recording
         style="width:1080px;height:1920px;overflow:hidden;background:#000000;${frameTransform};position:relative">
      <div data-creator-layout="portrait" style="display:flex;flex-direction:column;height:100%;width:100%;overflow:hidden">
        <div data-creator-phone class="relative flex min-h-0 min-w-0 flex-col self-start"
             style="width:390px;height:693.3333333333334px;zoom:2.769230769230769">
          <div data-creator-fill id="fill-portrait" class="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
            <div class="game-root mx-auto max-w-5xl px-3 py-4 sm:px-4 sm:py-6">
              <div style="height:200px;background:#ff0000">RED TOP — header</div>
              <div style="height:400px;background:#00ff00;margin-top:8px">GREEN MIDDLE — the game</div>
              ${tall ? '<div style="height:400px;background:#0000ff;margin-top:8px">BLUE BOTTOM — the rest</div>' : ""}
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
  <script>
    const fill = document.getElementById("fill-portrait");
    if (fill.scrollHeight > fill.clientHeight) fill.scrollTop = ${scrollTop};
  </script>
</body></html>`;
}

const tmp = mkdtempSync(join(tmpdir(), "creator-recording-audit-"));
const mk = (name, html) => writeFileSync(join(tmp, name), html);

// Fixtures must exist BEFORE the Tailwind pass so the utility classes
// (flex, overflow-y-auto, …) are compiled into the test stylesheet.
mk("phone-scaled.html", phoneHtml({ frameTransform: "transform:scale(0.3);transform-origin:top left", scrollTop: 0 }));
mk("phone-full.html", phoneHtml({ frameTransform: "transform:scale(1);transform-origin:top left", scrollTop: 0 }));
mk("phone-scrolled.html", phoneHtml({ frameTransform: "transform:scale(1);transform-origin:top left", scrollTop: 0 }));

const generated = await postcss([tailwind({ content: [join(tmp, "*.html")] })]).process(
  "@tailwind base;\n@tailwind components;\n@tailwind utilities;\n",
  { from: undefined },
);

const globals = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");
const start = globals.indexOf('[data-creator-phone] [data-creator-stack]');
const end = globals.indexOf("@media (prefers-reduced-motion", start);
if (start < 0) throw new Error("creator frame-fill CSS not found in globals.css");
const creatorCss = globals.slice(start, end).trim();
writeFileSync(join(tmp, "tw.css"), generated.css + "\n" + creatorCss);

const browser = await chromium.launch({ headless: true });
const results = {};
let failed = 0;
const check = (cond, label) => {
  console.log(cond ? "PASS" : "FAIL", label);
  if (!cond) failed++;
  return cond;
};

try {
  // ── A. Screen-fit transform leaks into the recording ────────────────
  // The provider scales the frame to fit the screen (e.g. 0.3 on a
  // laptop). That inline `transform: scale()` is cloned into the
  // snapshot, so the recorded game should appear shrunk + top-left.
  const pageA = await browser.newPage({ viewport: { width: 1600, height: 2200 } });
  await pageA.goto("file://" + join(tmp, "phone-scaled.html").replace(/\\/g, "/"));
  await pageA.addStyleTag({ path: join(tmp, "tw.css") });
  await pageA.addScriptTag({ content: SNAPSHOT_SNIPPET });
  const scaled = await pageA.evaluate(() => window.__snapshot("#frame-portrait", 1080, 1920));
  results.scaledFrame = scaled;
  console.log("frame with transform:scale(0.3):", JSON.stringify(scaled, null, 1));

  check(
    scaled.paintedFraction > 0.85,
    "recorded game fills the frame (screen-fit transform does NOT leak into the capture)",
  );
  check(
    Math.abs(scaled.centerDeltaX) < 80 && Math.abs(scaled.centerDeltaY) < 80,
    "recorded game is centered in the frame (no top-left offset from the screen-fit scale)",
  );
  await pageA.close();

  // ── B. Same layout at scale(1) — the control ───────────────────────
  const pageB = await browser.newPage({ viewport: { width: 1600, height: 2200 } });
  await pageB.goto("file://" + join(tmp, "phone-full.html").replace(/\\/g, "/"));
  await pageB.addStyleTag({ path: join(tmp, "tw.css") });
  await pageB.addScriptTag({ content: SNAPSHOT_SNIPPET });
  const full = await pageB.evaluate(() => window.__snapshot("#frame-portrait", 1080, 1920));
  results.fullFrame = full;
  console.log("frame with transform:scale(1):", JSON.stringify(full, null, 1));

  check(
    full.paintedFraction > 0.85,
    "control: at scale(1) the game fills the frame edge-to-edge",
  );
  await pageB.close();

  // ── C. In-game scrolling is recorded ────────────────────────────────
  // The user scrolls the game (fill container) down 300px into the green
  // game area. If scroll is captured, the recorded top band is GREEN; if
  // the snapshot always shows the top, it is RED.
  const pageC = await browser.newPage({ viewport: { width: 1600, height: 2200 } });
  await pageC.goto("file://" + join(tmp, "phone-scrolled.html").replace(/\\/g, "/"));
  await pageC.addStyleTag({ path: join(tmp, "tw.css") });
  await pageC.addScriptTag({ content: SNAPSHOT_SNIPPET });

  const scrollProbe = await pageC.evaluate(() => {
    // Scroll AFTER the stylesheet is applied (fixture <script> runs too
    // early, before the creator CSS is injected).
    const fill = document.getElementById("fill-portrait");
    fill.scrollTop = 400;
    const before = fill.scrollTop;
    const cloneFill = document
      .querySelector("[data-creator-recording]")
      .cloneNode(true)
      .querySelector("#fill-portrait");
    return {
      liveScrollTop: before,
      cloneScrollTop: cloneFill ? cloneFill.scrollTop : "missing",
      scrolled: before > 0,
      scrollHeight: fill.scrollHeight,
      clientHeight: fill.clientHeight,
      overflowY: getComputedStyle(fill).overflowY,
    };
  });
  const scrolledSnap = await pageC.evaluate(() => window.__snapshot("#frame-portrait", 1080, 1920));
  results.scroll = { ...scrollProbe, ...scrolledSnap };
  console.log("scrolled game:", JSON.stringify({ ...scrollProbe, ...scrolledSnap }, null, 1));

  check(
    scrollProbe.scrolled && scrollProbe.scrollHeight > scrollProbe.clientHeight,
    "game page is scrollable and was actually scrolled during the audit",
  );
  // Green = 0,255,0 (the game). Red = 255,0,0 (the header). With the
  // scroll fix, the recorded top band shows the green game the user
  // scrolled to — not the red header at the page top.
  const topIsGreen = scrolledSnap.topBand === "0,255,0";
  check(topIsGreen, "recording shows the scrolled position (green game), not the page top (red header)");
  await pageC.close();

  // ── D. Canvas-mode letterbox coverage (informational) ───────────────
  // A 16:9 game canvas inside a 9:16 output — the drawCanvasFrame
  // fitRect math. Report the coverage so the "not big enough" complaint
  // can be judged for canvas games too.
  {
    const cw = 1600, ch = 900, outW = 1080, outH = 1920;
    const s = Math.min(outW / cw, outH / ch);
    const w = cw * s, h = ch * s;
    const coverage = (w * h) / (outW * outH);
    results.canvasLetterbox = { coverage: Math.round(coverage * 100) + "%", drawnW: Math.round(w), drawnH: Math.round(h) };
    console.log("canvas 16:9 → output 9:16 letterbox coverage:", JSON.stringify(results.canvasLetterbox));
  }

  console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
  process.exitCode = failed === 0 ? 0 : 1;
} finally {
  await browser.close();
}