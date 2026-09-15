// qa/creator-dice-flush-check.mjs
//
// Verifies the Dice Flush creator-mode PORTRAIT layout added to
// src/app/globals.css (the [data-creator-layout="portrait"] [data-df="…"]
// rules; the markers are set in src/app/casino/dice-flush/PageClient.tsx).
//
// Background: Dice Flush renders through the generic
// <CreatorResponsiveLayout>, which lays the game out at a real phone width
// (390px) and zooms it to fill the recording frame. The game's own column
// (turn bar → shot clock → opponent strip → last-move recap → sheet → call
// chips → ROLL/Confirm → your dice → move history) was far taller than the
// 390×693 phone viewport, so the capture scrolled past most of the
// scorecard. The portrait rules pin the panel to the frame height and let
// the sheet claim every spare pixel.
//
// This script builds the same DOM the provider + CreatorResponsiveLayout
// render (frame → shell → phone viewport → fill → panel) with the REAL
// Tailwind class strings from the component, compiles globals.css, and
// measures:
//
//   1. nothing scrolls inside the frame — the whole sheet is on screen
//   2. the sheet fills the phone viewport width
//   3. the sheet is the dominant block of the frame
//   4. all 15 sheet rows are at least ~1 line tall (text is not clipped)
//   5. the dice/controls are still on screen below the sheet
//   6. a normal (non-creator) render keeps display:block — untouched
//
// Run: node qa/creator-dice-flush-check.mjs

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

// The phone viewport is laid out at 390×693.33 CSS px and `zoom`ed by this
// factor to fill the 1080×1920 recording frame; getBoundingClientRect()
// reports zoomed values, clientHeight reports layout px.
const ZOOM = 1080 / 390;

const ROW = (label, kind = "") =>
  kind === "head"
    ? `<div class="grid grid-cols-3 bg-[#00e5ff]/5 p-2 text-xs font-bold text-[#00e5ff]">
         <div>Category</div><div class="text-center">Score</div><div class="text-right">Claimed by</div>
       </div>`
    : kind === "bonus"
      ? `<div class="grid grid-cols-3 border-t-2 border-[#f5ff3b]/30 bg-[#f5ff3b]/5 p-2 text-xs font-bold">
           <div class="text-[#f5ff3b]">Bonus (63+)</div><div class="text-center text-[#34d399]">41 / 63</div><div class="text-right text-[#f87171]">52 / 63</div>
         </div>`
      : kind === "total"
        ? `<div class="grid grid-cols-3 border-t-2 border-[#00e5ff]/30 bg-[#00e5ff]/5 p-2 text-sm font-black">
             <div class="text-[#00e5ff]">Total</div><div class="text-center text-[#34d399]">176</div><div class="text-right text-[#f87171]">184</div>
           </div>`
        : `<button class="grid w-full grid-cols-3 border-t border-[#00e5ff]/8 p-2 text-left text-xs">
             <div class="flex items-center gap-1.5 text-white/80">${label}</div>
             <div class="text-center font-bold text-white/25">-</div>
             <div class="text-right text-[10px] font-black text-white/25">-</div>
           </button>`;

const SHEET_ROWS = [
  ROW("", "head"),
  ...["Ones", "Twos", "Threes", "Fours", "Fives", "Sixes"].map((l) => ROW(l)),
  ROW("", "bonus"),
  ...["3-Kind", "4-Kind", "Full Hse", "Sm Str", "Lg Str", "5-Kind"].map((l) => ROW(l)),
  ROW("", "total"),
].join("\n");

const PANEL = `
<div data-df="panel" class="mt-6 rounded-2xl border border-[#00e5ff]/25 bg-[#040d24]/70 p-4 backdrop-blur">
  <div data-df="topbar" class="mb-3 flex items-center justify-between">
    <div class="flex items-center gap-3">
      <span class="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold bg-[#34d399]/20 text-[#34d399]">
        <span class="h-2 w-2 rounded-full bg-[#34d399]"></span>Your turn
      </span>
      <span class="text-xs text-gray-400">Rolls 1/3</span>
      <span class="rounded-full bg-[#00e5ff]/10 px-2 py-0.5 text-xs font-bold text-[#00e5ff]">Sheet 3/12</span>
    </div>
    <div class="flex items-center gap-2">
      <button class="rounded-lg bg-red-600/80 px-3 py-1 text-xs font-bold text-white">Resign</button>
    </div>
  </div>

  <div data-df="board" class="mb-5 overflow-hidden rounded-[24px] border-2 border-[#00e5ff]/20 bg-gradient-to-b from-[#030817] to-[#0a1628] shadow-[0_0_40px_rgba(0,229,255,0.15)]">
    <div data-df="clock" class="border-b border-[#00e5ff]/10 bg-[#020812]/70 px-4 py-2">
      <div class="flex items-center justify-between text-[11px] font-bold uppercase tracking-wider text-white/50">
        <span>Shot clock</span><span class="text-[#00e5ff]">22s</span>
      </div>
      <div class="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
        <div class="h-full rounded-full bg-[#00e5ff]" style="width:73%"></div>
      </div>
      <p class="mt-1 text-[10px] text-white/40">Finish your turn before time runs out.</p>
    </div>

    <div data-df="opponent" class="border-b border-[#00e5ff]/10 bg-[#020812] px-4 py-3">
      <div class="mb-2 flex items-center justify-between">
        <div class="flex items-center gap-2">
          <div class="relative inline-flex items-center gap-1.5 rounded-full bg-[#f87171]/20 border border-[#f87171]/30 px-3 py-1 text-sm font-black text-[#f87171]">AI (medium)</div>
          <div class="rounded-full bg-white/5 px-3 py-1 text-xs font-bold text-white/80">Total: 184</div>
          <div class="flex items-center gap-1.5 rounded-full bg-white/5 px-2.5 py-1">
            <div class="h-1.5 w-16 overflow-hidden rounded-full bg-white/10">
              <div class="h-full rounded-full bg-[#f87171]" style="width:100%"></div>
            </div>
            <span class="text-[10px] font-bold text-white/60">6/6</span>
          </div>
        </div>
        <div class="rounded-xl bg-white/5 px-3 py-1 text-xs font-bold text-white/70">Rolls: 2/3</div>
      </div>
      <div data-df="opponent-dice" class="flex justify-center gap-3">
        <div class="scale-90 opacity-80"><div data-df="die" class="relative h-16 w-16 rounded-2xl border-[3px] border-[#00e5ff]/40"></div></div>
        <div class="scale-90 opacity-80"><div data-df="die" class="relative h-16 w-16 rounded-2xl border-[3px] border-[#00e5ff]/40"></div></div>
        <div class="scale-90 opacity-80"><div data-df="die" class="relative h-16 w-16 rounded-2xl border-[3px] border-[#00e5ff]/40"></div></div>
        <div class="scale-90 opacity-80"><div data-df="die" class="relative h-16 w-16 rounded-2xl border-[3px] border-[#00e5ff]/40"></div></div>
        <div class="scale-90 opacity-80"><div data-df="die" class="relative h-16 w-16 rounded-2xl border-[3px] border-[#00e5ff]/40"></div></div>
      </div>
    </div>

    <div data-df="last-move" class="border-b border-[#00e5ff]/10 bg-[#020812]/50 px-4 py-2">
      <div class="mb-1 flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-white/50">Last Move</div>
      <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        <div class="flex items-center gap-2 rounded-lg bg-[#34d399]/10 border border-[#34d399]/20 px-2.5 py-1">
          <span class="font-bold text-[#34d399]">You</span><span class="text-white/80">→ fours</span><span class="font-bold text-[#34d399]">+12 pts</span>
        </div>
      </div>
    </div>

    <div data-df="center" class="px-3 py-4">
      <div data-df="sheet" class="overflow-hidden rounded-xl border border-[#00e5ff]/15 bg-[#040d24]/60">
${SHEET_ROWS}
      </div>

      <div data-df="call" class="mt-4 rounded-2xl border border-[#f5ff3b]/25 bg-[#f5ff3b]/5 px-4 py-3">
        <div class="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-sm font-bold text-[#f5ff3b]">
          <span>You called <span class="font-black underline decoration-dotted">Threes</span> Bank it this turn for +15 pts!</span>
        </div>
      </div>

      <div data-df="controls" class="mt-3 flex flex-col items-center gap-3">
        <div class="flex items-center justify-center gap-3">
          <button class="rounded-xl border-b-[3px] border-[#00e5ff]/40 bg-[#00e5ff] px-8 py-3 text-lg font-black text-black">ROLL</button>
          <button class="rounded-xl bg-gradient-to-r from-[#f5ff3b] to-[#fbbf24] px-6 py-3 font-black text-black">Confirm Play</button>
        </div>
        <button class="flex h-10 w-10 items-center justify-center rounded-full border border-[#00e5ff]/45 bg-[#071531] text-xl">😀</button>
      </div>

      <div data-df="turn" class="mt-3 text-center text-xs font-bold"><span class="text-[#34d399]">YOUR TURN</span></div>
    </div>

    <div data-df="player" class="border-t border-[#00e5ff]/10 bg-[#020812] px-4 py-3">
      <div class="mb-2 flex items-center justify-between">
        <div class="flex items-center gap-2">
          <div class="relative rounded-full bg-[#34d399]/20 border border-[#34d399]/30 px-3 py-1 text-sm font-black text-[#34d399]">YOU</div>
          <div class="rounded-full bg-white/5 px-3 py-1 text-xs font-bold text-white/80">Total: 176</div>
          <div class="flex items-center gap-1.5 rounded-full bg-white/5 px-2.5 py-1">
            <div class="h-1.5 w-16 overflow-hidden rounded-full bg-white/10">
              <div class="h-full rounded-full bg-[#34d399]" style="width:50%"></div>
            </div>
            <span class="text-[10px] font-bold text-white/60">3/6</span>
          </div>
        </div>
        <div class="rounded-xl bg-white/5 px-3 py-1 text-xs font-bold text-white/60">Tap dice to hold</div>
      </div>
      <div data-df="player-dice" class="flex flex-wrap justify-center gap-3">
        <div data-df="die" class="relative h-16 w-16 rounded-2xl border-[3px] border-[#00e5ff]/40"></div>
        <div data-df="die" class="relative h-16 w-16 rounded-2xl border-[3px] border-[#00e5ff]/40"></div>
        <div data-df="die" class="relative h-16 w-16 rounded-2xl border-[3px] border-[#00e5ff]/40"></div>
        <div data-df="die" class="relative h-16 w-16 rounded-2xl border-[3px] border-[#00e5ff]/40"></div>
        <div data-df="die" class="relative h-16 w-16 rounded-2xl border-[3px] border-[#00e5ff]/40"></div>
      </div>
    </div>
  </div>

  <div data-df="history" class="mb-5 overflow-hidden rounded-xl border border-[#00e5ff]/30 bg-black/30">
    <button class="flex w-full items-center justify-between px-4 py-2.5 text-sm font-bold text-[#00e5ff]">Move History</button>
  </div>
</div>`;

const html = `<!doctype html>
<html><head><meta charset="utf-8"></head>
<body>
  <div id="viewport" style="width:2000px">
    <!-- Portrait recording frame (9:16) -->
    <div id="frame" style="width:1080px;height:1920px;overflow:hidden">
      <div data-creator-layout="portrait" style="display:flex;flex-direction:column;height:100%;width:100%">
        <div id="phone" data-creator-phone class="relative flex min-h-0 min-w-0 flex-col self-start"
             style="width:390px;height:693.3333333333334px;zoom:2.769230769230769">
          <div id="fill" data-creator-fill class="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
${PANEL}
          </div>
        </div>
      </div>
    </div>

    <!-- Same panel with NO creator shell: normal play must be untouched -->
    <div id="plain" style="width:900px">
      <div id="plain-panel" class="mt-6 rounded-2xl border border-[#00e5ff]/25 bg-[#040d24]/70 p-4 backdrop-blur">
        <div data-df="panel" class="mt-6 rounded-2xl border border-[#00e5ff]/25 bg-[#040d24]/70 p-4 backdrop-blur">
          <div data-df="topbar" class="mb-3 flex items-center justify-between"><span class="text-xs">Your turn</span></div>
          <div data-df="sheet" class="overflow-hidden rounded-xl border border-[#00e5ff]/15 bg-[#040d24]/60">
            <div class="grid grid-cols-3 p-2 text-xs"><div>Category</div><div>Score</div><div>Claimed by</div></div>
          </div>
        </div>
      </div>
    </div>
  </div>
</body></html>`;

const tmp = mkdtempSync(join(tmpdir(), "creator-dice-flush-"));
writeFileSync(join(tmp, "input.html"), html);

const generated = await postcss([tailwind({ content: [join(tmp, "input.html")] })]).process(
  "@tailwind base;\n@tailwind components;\n@tailwind utilities;\n",
  { from: undefined },
);

// Append the creator CSS block from globals.css (phone stacking → the
// reduced-motion media query covers the portrait Dice Flush rules too).
const globals = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");
const start = globals.indexOf('[data-creator-phone] [data-creator-stack]');
const end = globals.indexOf("@media (prefers-reduced-motion", start);
if (start < 0) throw new Error("creator CSS not found in globals.css");
const creatorCss = globals.slice(start, end).trim();
if (!creatorCss.includes('[data-df="sheet"]')) {
  throw new Error("Dice Flush portrait rules not found inside the creator CSS block");
}
writeFileSync(join(tmp, "tw.css"), generated.css + "\n" + creatorCss);

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 2200, height: 2400 } });
  await page.goto("file://" + join(tmp, "input.html").replace(/\\/g, "/"));
  await page.addStyleTag({ path: join(tmp, "tw.css") });

  const results = await page.evaluate((ZOOM) => {
    const $ = (sel) => document.querySelector(sel);
    const rect = (el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, w: r.width, h: r.height };
    };
    const fill = $("#fill");
    const phone = rect($("#phone"));
    const fillRect = rect(fill);
    const rows = Array.from(document.querySelectorAll('#fill [data-df="sheet"] > *'));
    const sheet = rect($('#fill [data-df="sheet"]'));
    const player = rect($('#fill [data-df="player"]'));
    const plain = getComputedStyle($('#plain [data-df="panel"]'));
    const blockHeights = {};
    for (const name of ["panel", "topbar", "board", "clock", "opponent", "center", "call", "controls", "player"]) {
      const el = $(`#fill [data-df="${name}"]`);
      blockHeights[name] = el ? Number((el.getBoundingClientRect().height / ZOOM).toFixed(1)) : null;
    }
    return {
      blockHeights,
      phoneH: phone.h,
      phoneW: phone.w,
      fillW: fillRect.w,
      fillClientH: fill.clientHeight,
      fillScrollH: fill.scrollHeight,
      sheet: { top: sheet.top, bottom: sheet.bottom, w: sheet.w, h: sheet.h },
      sheetRowCount: rows.length,
      rowHeights: rows.map((r) => Number(r.getBoundingClientRect().height.toFixed(1))),
      minRowH: Math.min(...rows.map((r) => r.getBoundingClientRect().height)),
      // Dice row at the bottom of the frame (must stay visible)
      diceBottom: player.bottom,
      lastMoveDisplay: getComputedStyle($('#fill [data-df="last-move"]')).display,
      historyDisplay: getComputedStyle($('#fill [data-df="history"]')).display,
      controlsDirection: getComputedStyle($('#fill [data-df="controls"]')).flexDirection,
      plainPanelDisplay: plain.display,
      plainPanelPadding: plain.paddingTop,
    };
  }, ZOOM);

  console.log(JSON.stringify(results, null, 2));

  const check = (cond, label) => {
    console.log(cond ? "PASS" : "FAIL", label);
    return cond;
  };
  const passes = [];

  // 1. The whole game fits the frame — no scrolling inside the capture.
  passes.push(
    check(
      results.fillScrollH <= results.fillClientH + 1,
      `frame content does not scroll (scrollH ${results.fillScrollH} <= clientH ${results.fillClientH})`,
    ),
  );
  // 2. The sheet spans the phone viewport width.
  const widthShare = results.sheet.w / results.fillW;
  passes.push(
    check(
      widthShare >= 0.9,
      `sheet fills the frame width (${(widthShare * 100).toFixed(0)}% of ${results.fillW.toFixed(0)})`,
    ),
  );
  // 3. The sheet is the dominant block of the capture.
  const share = results.sheet.h / results.phoneH;
  passes.push(check(share >= 0.45, `sheet dominates the frame (${(share * 100).toFixed(0)}% of height)`));
  // 4. Every row (header + 12 categories + bonus + total) is on screen —
  //    the rows must fit inside the sheet box, not be clipped by its
  //    overflow:hidden.
  passes.push(check(results.sheetRowCount === 15, `15 sheet rows rendered (${results.sheetRowCount})`));
  const rowsTotal = results.rowHeights.reduce((a, b) => a + b, 0) / ZOOM;
  const sheetH = results.sheet.h / ZOOM;
  passes.push(
    check(
      rowsTotal <= sheetH + 1,
      `all 15 rows fit the sheet, none clipped (${rowsTotal.toFixed(0)}px of ${sheetH.toFixed(0)}px)`,
    ),
  );
  const minRowLayout = results.minRowH / ZOOM;
  passes.push(
    check(minRowLayout >= 20, `every sheet row >= 20px (text not crushed) — min ${minRowLayout.toFixed(1)}px`),
  );
  // 5. The sheet sits above the dice, and the dice are still on screen.
  passes.push(
    check(
      results.sheet.bottom <= results.diceBottom + 1 && results.diceBottom <= results.phoneH + 1,
      "sheet ends above the dice row, which stays inside the frame",
    ),
  );
  // 6. Secondary live-play chrome is dropped in the recording.
  passes.push(check(results.lastMoveDisplay === "none", "last-move recap hidden in portrait capture"));
  passes.push(check(results.historyDisplay === "none", "move-history log hidden in portrait capture"));
  // 7. Controls sit on one row so they cost a single button height.
  passes.push(check(results.controlsDirection === "row", "ROLL/Confirm + emotes share one row"));
  // 8. Normal (non-creator) rendering is untouched.
  passes.push(check(results.plainPanelDisplay === "block", "no creator shell keeps the panel display:block"));
  passes.push(check(results.plainPanelPadding === "16px", "no creator shell keeps the panel p-4 padding"));

  const failed = passes.filter((p) => !p);
  console.log(failed.length === 0 ? "ALL PASS" : `${failed.length} FAILED`);
  process.exitCode = failed.length === 0 ? 0 : 1;
} finally {
  await browser.close();
}
