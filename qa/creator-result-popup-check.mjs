// qa/creator-result-popup-check.mjs
//
// Browser check for the four games whose win/loss popup was missing from
// Creator Mode clips (Keno PvP, Mines Duel, Tower Arena, Precision PvP),
// plus the shared rule every game page has to follow:
//
//   THE END-OF-MATCH PANEL MUST BE A CHILD OF <CreatorModeHost>.
//
// The recorder captures the provider's `[data-creator-recording]` frame
// element, so a panel rendered as a sibling of the HOST — or inside a node
// <CreatorView> swaps out (its `normal`/`portrait`/`landscape` props) — is
// simply not in the recording. The creator still SEES it (it is
// `position: fixed` against the browser window), but the clip ends on the
// board. That is exactly the bug that was fixed.
//
// Two layers, both real Chrome (Chromium via Playwright):
//
//   A. RENDER LAYER — for each game × recording ratio the harness builds
//      the frame the provider renders (logical 1080×1920 etc. + the
//      screen-fit `transform: scale()`), puts the shared panel's markup
//      (same classes as src/components/result/PvpResultScreen.jsx) inside
//      it, and then runs the recorder's EXACT snapshot pipeline
//      (clone → strip the container transform → <foreignObject> SVG →
//      drawImage at the output size, see src/lib/creator-mode/recorder.ts):
//        • panel covers the frame exactly (getBoundingClientRect)
//        • the panel's #f5ff3b hero text is present in the captured pixels
//        • the game board below is tinted by the 80% backdrop (no
//          saturated board pixels survive)
//      Negative control per game: the SAME panel as a sibling of the frame
//      (the pre-fix placement) → zero popup pixels in the capture, the
//      board fully visible, and the panel sized to the browser window
//      instead of the frame.
//
//   B. SOURCE LAYER — asserts, per page, that the element which renders the
//      panel really is a sibling of <CreatorView> and inside
//      <CreatorModeHost> (and that Tower Arena no longer early-returns past
//      the host), so the fixture in layer A matches the shipped code.
//
// Run: node qa/creator-result-popup-check.mjs

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

// ── The four fixed games ───────────────────────────────────────────────
// `marker` is the JSX element that renders the end-of-match panel; the
// source layer checks it sits between <CreatorView .../> and
// </CreatorModeHost>.
const GAMES = [
  {
    key: "keno-pvp",
    label: "Keno PvP",
    headline: "Keno Duel — 12 – 9 pts · WIN",
    file: "src/app/casino/keno-pvp/[matchId]/PageClient.jsx",
    marker: "<ResultModal",
    overlayIn: ["src/app/casino/keno-pvp/[matchId]/PageClient.jsx", "CreatorResultOverlay"],
  },
  {
    key: "mines-pvp",
    label: "Mines Duel",
    headline: "Mines Duel — you take the pot",
    file: "src/app/casino/mines-pvp/[matchId]/PageClient.tsx",
    marker: "{renderResult()}",
    overlayIn: ["src/app/casino/mines-pvp/[matchId]/PageClient.tsx", "CreatorResultOverlay"],
  },
  {
    key: "tower-arena",
    label: "Tower Arena",
    headline: "Tower Arena — 1st place",
    file: "src/app/casino/tower-arena/game/[matchId]/PageClient.tsx",
    marker: "{finalPlacementPopup}",
    overlayIn: ["src/app/casino/tower-arena/game/[matchId]/PageClient.tsx", "CreatorResultOverlay"],
  },
  {
    key: "precision",
    label: "Precision PvP",
    headline: "Precision — you took the match",
    file: "src/app/casino/precision/game/[matchId]/PageClient.tsx",
    marker: "<PrecisionResultPopup",
    overlayIn: ["src/components/precision/PrecisionResultPopup.tsx", "CreatorResultOverlay"],
  },
];

// Recording presets the provider supports (DIMENSION_PRESETS).
const RATIOS = [
  { key: "9:16", w: 1080, h: 1920, orientation: "portrait" },
  { key: "16:9", w: 1920, h: 1080, orientation: "landscape" },
  { key: "1:1", w: 1080, h: 1080, orientation: "square" },
];

// Screen-fit scale the provider applies on a laptop-sized window.
const FRAME_SCALE = 0.42;

// ── Snapshot + measurement (mirror of recorder.drawCompositeFrame) ─────

const SNAPSHOT_SNIPPET = `
  window.__record = async (frameSel, outW, outH) => {
    const container = document.querySelector(frameSel);
    const cw = container.offsetWidth || 1;
    const ch = container.offsetHeight || 1;
    // serializeContainerClean(): clone, then drop the container's OWN
    // on-screen transform so capture runs at the logical size.
    const clone = container.cloneNode(true);
    clone.style.removeProperty("transform");
    clone.style.removeProperty("transform-origin");
    clone.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
    const html = new XMLSerializer().serializeToString(clone);
    let css = "";
    for (const sheet of Array.from(document.styleSheets)) {
      try { for (const rule of Array.from(sheet.cssRules)) css += rule.cssText + "\\n"; }
      catch { /* cross-origin sheet */ }
    }
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="' + cw + '" height="' + ch + '" viewBox="0 0 ' + cw + ' ' + ch + '">' +
      '<style><![CDATA[' + css + ']]></style>' +
      '<foreignObject width="' + cw + '" height="' + ch + '">' + html + '</foreignObject></svg>';
    const img = new Image();
    await new Promise((ok, fail) => {
      img.onload = ok;
      img.onerror = fail;
      img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    });
    if (img.decode) await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, outW, outH);
    ctx.drawImage(img, 0, 0, cw, ch);
    const data = ctx.getImageData(0, 0, outW, outH).data;
    let painted = 0, yellow = 0, board = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i+1], b = data[i+2];
      if (r || g || b) painted++;
      // The panel's hero colour, text-[#f5ff3b] (245,255,59) — a loose
      // "warm yellow" test that also catches anti-aliased strokes and
      // excludes the dark-green panel, the emerald chip and white text.
      if (r > 140 && g > 140 && b < 130) yellow++;
      // The fixture's game board marker, #00ff00.
      if (r < 60 && g > 180 && b < 60) board++;
    }
    const ci = ((outH >> 1) * outW + (outW >> 1)) * 4;
    return {
      outW, outH,
      paintedFraction: painted / (outW * outH),
      popupPx: yellow,
      boardPx: board,
      centerPixel: [data[ci], data[ci+1], data[ci+2]].join(","),
    };
  };

  window.__coverage = (frameSel, overlaySel) => {
    const frame = document.querySelector(frameSel);
    const overlay = document.querySelector(overlaySel);
    const f = frame.getBoundingClientRect();
    const o = overlay.getBoundingClientRect();
    return {
      frame: { w: Math.round(f.width), h: Math.round(f.height) },
      overlay: { w: Math.round(o.width), h: Math.round(o.height) },
      dw: Math.round(Math.abs(o.width - f.width)),
      dh: Math.round(Math.abs(o.height - f.height)),
      overlayPosition: getComputedStyle(overlay).position,
      overlayZ: getComputedStyle(overlay).zIndex,
      frameTransform: getComputedStyle(frame).transform,
    };
  };
`;

// ── Fixtures ───────────────────────────────────────────────────────────
// The panel markup mirrors src/components/result/PvpResultScreen.jsx:
// root `fixed inset-0 z-[95] … bg-black/80 backdrop-blur-sm` (compact adds
// `!px-2 !py-3`), panel `max-w-[22rem] p-3.5` (compact) / `max-w-md p-5`
// (full) with the win gradient + `text-[#f5ff3b]` hero.
function panelMarkup({ label, headline, compact }) {
  return `
      <div class="result-overlay fixed inset-0 z-[95] flex items-center justify-center overflow-y-auto bg-black/80 px-3 py-6 backdrop-blur-sm ${
        compact ? "!px-2 !py-3" : "sm:px-4"
      }">
        <div class="relative w-full rounded-2xl border-2 bg-gradient-to-b text-center from-[#0d2b1a] via-[#072014] to-[#04170e] border-emerald-400/50 ${
          compact ? "max-w-[22rem] p-3.5" : "max-w-md p-5 sm:p-6"
        }">
          <div class="mx-auto mb-2 flex h-16 w-16 items-center justify-center rounded-2xl border border-white/10 bg-black/30">TROPHY</div>
          <span class="inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-black uppercase tracking-[0.2em] border-emerald-300/50 bg-emerald-400/15 text-emerald-300">YOU WON</span>
          <p class="mt-2 font-black uppercase tracking-[0.15em] text-emerald-300 ${compact ? "text-sm" : "text-lg sm:text-xl"}">You beat</p>
          <p class="truncate font-black text-[#f5ff3b] ${compact ? "text-2xl" : "text-4xl sm:text-5xl"}">@Rival</p>
          <p class="mt-1.5 text-white/75 ${compact ? "text-[11px]" : "text-sm"}">${headline}</p>
        </div>
      </div>`;
}

/**
 * Mirrors the DOM <CreatorModeProvider> renders: the recording frame
 * (logical size + screen-fit transform) with the game inside it, and the
 * result panel either INSIDE the frame (the fixed placement) or as a
 * sibling of it (the pre-fix placement, outside the capture).
 */
function fixture({ label, headline, ratio, placement, compact }) {
  const inside = placement === "inside";
  const overlay = panelMarkup({ label, headline, compact });
  const viewportW = Math.max(1600, Math.round(ratio.w * FRAME_SCALE) + 60);
  return `<!doctype html>
<html><head><meta charset="utf-8"></head>
<body>
  <div id="viewport" style="width:${viewportW}px">
    <div id="frame" data-creator-recording
         style="width:${ratio.w}px;height:${ratio.h}px;overflow:hidden;background:#000000;transform:scale(${FRAME_SCALE});transform-origin:top left;position:relative">
      <div data-creator-layout="${ratio.orientation}" style="display:flex;flex-direction:column;height:100%;width:100%;overflow:hidden">
        <div class="game-board" style="flex:1;min-height:0;background:#00ff00;display:flex;align-items:center;justify-content:center;color:#004d00;font:700 44px sans-serif;text-align:center">${label}<br>game board</div>
      </div>
      ${inside ? overlay : ""}
    </div>
    ${inside ? "" : overlay}
  </div>
</body></html>`;
}

const tmp = mkdtempSync(join(tmpdir(), "creator-result-popup-"));
const fixtureNames = new Map();
for (const game of GAMES) {
  for (const ratio of RATIOS) {
    const name = `${game.key}-${ratio.key.replace(":", "x")}-inside.html`;
    fixtureNames.set(`${game.key}|${ratio.key}|inside`, name);
    writeFileSync(
      join(tmp, name),
      fixture({
        label: game.label,
        headline: game.headline,
        ratio,
        placement: "inside",
        compact: true,
      }),
    );
  }
  const control = `${game.key}-9x16-outside.html`;
  fixtureNames.set(`${game.key}|9:16|outside`, control);
  writeFileSync(
    join(tmp, control),
    fixture({
      label: game.label,
      headline: game.headline,
      ratio: RATIOS[0],
      placement: "outside",
      compact: true,
    }),
  );
}

// Tailwind must compile the same utilities the real panel uses — so the
// fixtures are written before this pass and globbed as content.
const generated = await postcss([
  tailwind({ content: [join(tmp, "*.html")] }),
]).process("@tailwind base;\n@tailwind components;\n@tailwind utilities;\n", {
  from: undefined,
});

const globals = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");
const start = globals.indexOf("[data-creator-phone] [data-creator-stack]");
const end = globals.indexOf("@media (prefers-reduced-motion", start);
if (start < 0) throw new Error("creator frame-fill CSS not found in globals.css");
const creatorCss = globals.slice(start, end).trim();
writeFileSync(join(tmp, "tw.css"), generated.css + "\n" + creatorCss);

// ── Run ────────────────────────────────────────────────────────────────

let browser;
try {
  browser = await chromium.launch({ headless: true });
} catch {
  // Fall back to the system Chrome when the Playwright bundle is absent.
  browser = await chromium.launch({ headless: true, channel: "chrome" });
}

let failed = 0;
const check = (cond, label) => {
  console.log(cond ? "PASS" : "FAIL", label);
  if (!cond) failed++;
};

const openFixture = async (name) => {
  const page = await browser.newPage({ viewport: { width: 1600, height: 2200 } });
  await page.goto("file://" + join(tmp, name).replace(/\\/g, "/"));
  await page.addStyleTag({ path: join(tmp, "tw.css") });
  await page.addScriptTag({ content: SNAPSHOT_SNIPPET });
  return page;
};

try {
  console.log("── A. Render layer: the panel is captured inside the frame ──\n");

  for (const game of GAMES) {
    for (const ratio of RATIOS) {
      const name = fixtureNames.get(`${game.key}|${ratio.key}|inside`);
      const page = await openFixture(name);
      const coverage = await page.evaluate(() =>
        window.__coverage("#frame", "#frame .result-overlay"),
      );
      const snap = await page.evaluate(
        ([w, h]) => window.__record("#frame", w, h),
        [ratio.w, ratio.h],
      );
      await page.close();

      const tag = `${game.label} ${ratio.key} (${ratio.w}×${ratio.h})`;
      console.log(
        `${tag}: overlay ${coverage.overlay.w}×${coverage.overlay.h} vs frame ${coverage.frame.w}×${coverage.frame.h}` +
          ` · popupPx=${snap.popupPx} boardPx=${snap.boardPx} painted=${snap.paintedFraction.toFixed(3)} center=${snap.centerPixel}`,
      );
      check(
        coverage.dw <= 2 && coverage.dh <= 2,
        `${tag}: the result panel covers the recording frame exactly (no letterbox gap)`,
      );
      check(
        snap.popupPx >= 100,
        `${tag}: the panel's headline is present in the captured frame (${snap.popupPx} px)`,
      );
      check(
        snap.boardPx <= Math.round(ratio.w * ratio.h * 0.02),
        `${tag}: the game board behind the panel is dimmed out of the capture`,
      );
      check(
        snap.paintedFraction >= 0.98,
        `${tag}: the capture is fully painted (nothing clipped or blank)`,
      );
    }
  }

  console.log("\n── B. Negative control: the pre-fix placement is NOT captured ──\n");

  for (const game of GAMES) {
    const name = fixtureNames.get(`${game.key}|9:16|outside`);
    const page = await openFixture(name);
    const coverage = await page.evaluate(() =>
      window.__coverage("#frame", "#viewport > .result-overlay"),
    );
    const snap = await page.evaluate(
      ([w, h]) => window.__record("#frame", w, h),
      [RATIOS[0].w, RATIOS[0].h],
    );
    await page.close();

    console.log(
      `${game.label}: overlay ${coverage.overlay.w}×${coverage.overlay.h} (frame on screen ${coverage.frame.w}×${coverage.frame.h})` +
        ` · popupPx=${snap.popupPx} boardPx=${snap.boardPx} painted=${snap.paintedFraction.toFixed(3)}`,
    );
    check(
      snap.popupPx === 0,
      `${game.label}: popup OUTSIDE the frame is absent from the recording (the old bug — clip ended on the board)`,
    );
    check(
      snap.boardPx > Math.round(RATIOS[0].w * RATIOS[0].h * 0.5),
      `${game.label}: control capture shows the untouched board (no panel overlay)`,
    );
    check(
      coverage.dw > 100 && coverage.dh > 100,
      `${game.label}: outside the frame the panel sizes to the browser window (visible to the creator, invisible to the recorder)`,
    );
  }

  console.log("\n── C. Source layer: the shipped placement matches the fixture ──\n");

  for (const game of GAMES) {
    const src = readFileSync(join(process.cwd(), game.file), "utf8");
    const hostOpen = src.indexOf("<CreatorModeHost");
    const hostClose = src.indexOf("</CreatorModeHost>", hostOpen);
    const viewOpen = src.indexOf("<CreatorView", hostOpen);
    const viewSelfClose = src.indexOf("/>", viewOpen);
    const markerAt = src.indexOf(game.marker, hostOpen);
    const countIn = (from, to) => {
      let n = 0;
      let at = src.indexOf(game.marker, from);
      while (at >= 0 && at < to) {
        n++;
        at = src.indexOf(game.marker, at + game.marker.length);
      }
      return n;
    };
    // Rendered once inside the frame, and never after it (a second copy
    // rendered after </CreatorModeHost> would be the old, unrecorded bug).
    const renderedInside = countIn(viewSelfClose, hostClose);
    const renderedAfterHost = countIn(hostClose, src.length);

    check(hostOpen >= 0 && hostClose > hostOpen, `${game.key}: page mounts <CreatorModeHost>`);
    check(viewOpen > hostOpen && viewSelfClose > viewOpen, `${game.key}: page renders <CreatorView />`);
    check(
      renderedInside === 1 && renderedAfterHost === 0,
      `${game.key}: ${game.marker} renders exactly once and only inside <CreatorModeHost> (inside=${renderedInside}, afterHost=${renderedAfterHost})`,
    );
    check(
      markerAt > viewSelfClose,
      `${game.key}: ${game.marker} is a SIBLING of <CreatorView /> (not inside its normal/portrait/landscape props)`,
    );
    check(
      markerAt < hostClose,
      `${game.key}: ${game.marker} is inside <CreatorModeHost> — i.e. inside the recorded frame`,
    );

    const [overlayFile, overlayNeedle] = game.overlayIn;
    const overlaySrc = readFileSync(join(process.cwd(), overlayFile), "utf8");
    check(
      overlaySrc.includes(overlayNeedle),
      `${game.key}: panel renders through ${overlayNeedle} (compact sizing only while creator mode is on)`,
    );
  }

  // Tower Arena regression guard: the finished state must not early-return
  // past the host (that unmounted the recording frame before the results
  // screen and the placement popup could be captured).
  const ta = readFileSync(join(process.cwd(), GAMES[2].file), "utf8");
  check(
    !ta.includes("if (isFinished && showResults)"),
    "tower-arena: no early return past <CreatorModeHost> at finish (host stays mounted)",
  );
  check(
    ta.includes("showingResults"),
    "tower-arena: the finished state is swapped inside the host instead",
  );

  console.log(
    failed === 0
      ? "\nALL PASS — the end-of-match popup is inside the recorded frame in every preset, and is provably absent from the capture in the pre-fix placement."
      : `\n${failed} CHECK(S) FAILED`,
  );
  process.exitCode = failed === 0 ? 0 : 1;
} finally {
  await browser.close();
}
