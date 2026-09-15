// qa/hex-troop-popup-check.mjs
//
// Verifies the Hex Duel troop-count popup
// (src/components/HexTroopPopup.tsx) that replaced the panel which used to
// sit under the board and forced a scroll.
//
// The popup floats above the tile the player is acting on, which it locates
// through the `data-hex-board` / `data-tile-key` anchors added to
// HexBoard.tsx and HexTile.tsx. It is `position: fixed`, so it has to stay
// correct even though the board itself is rendered inside an
// `overflow-x-auto overflow-y-hidden` scroller and scaled by a CSS
// transform.
//
// This script bundles the REAL components (esbuild) with the REAL Tailwind
// classes (postcss), renders the same DOM shape the game uses — page >
// max-w container > scroll container > HexBoard, with the popup as a sibling
// of the board — and drives it in Chromium to check:
//
//   1. the popup is visible and anchored ABOVE the anchor tile, centred on it
//      (the anchor is whichever `data-tile-key` the game passes — Hex Duel
//      anchors it to the SOURCE tile the troops leave from)
//   2. it is never clipped by the board's overflow container (hit-testable)
//   3. quick picks drive the count; the maximum is offered once, labelled MAX
//   4. Confirm / Escape fire the right handlers
//   5. it honours the caller's preferred side, and flips below the tile when
//      the tile is near the top of the screen
//   6. it stays clamped inside a narrow viewport
//
// Run: node qa/hex-troop-popup-check.mjs

import { build } from "esbuild";
import tailwind from "tailwindcss";
import postcss from "postcss";
import { chromium } from "playwright";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!existsSync("node_modules/esbuild") || !existsSync("node_modules/playwright")) {
  console.log("esbuild/playwright not installed — install deps first (npm ci)");
  process.exit(1);
}

const ROOT = process.cwd().replace(/\\/g, "/");
const tmp = mkdtempSync(join(tmpdir(), "hex-popup-"));
// Keep the entry inside the project so imports resolve like the app does.
const ENTRY = join(ROOT, ".qa-hex-popup-entry.tsx");
const OUT = join(tmp, "bundle.js").replace(/\\/g, "/");
const PAGE = "file://" + join(tmp, "index.html").replace(/\\/g, "/");

// Space above the board keeps the target tile mid-viewport on load (the
// "above" case); the footer makes the page scrollable (the "flip" case).
const SPACER_ABOVE = 700;
const SPACER_BELOW = 2000;

const GRID = Array.from({ length: 5 }, (_, y) =>
  Array.from({ length: 5 }, (_, x) => ({
    x,
    y,
    owner: (x + y) % 3 === 0 ? "player1" : (x + y) % 3 === 1 ? "player2" : "neutral",
    troops: (x * 3 + y) % 7,
    shield: 0,
    capital: x === 0 && y === 0,
  })),
);

const ENTRY_SOURCE = `
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import HexBoard from "./src/components/HexBoard";
import HexTroopPopup from "./src/components/HexTroopPopup";

const GRID = ${JSON.stringify(GRID)};
const params = new URLSearchParams(location.search);
const ANCHOR = params.get("tile") || "1,0";
const PREFER = params.get("prefer");

function Harness() {
  const [open, setOpen] = useState(true);
  const [value, setValue] = useState(2);
  const state = (window.__hex = window.__hex || { confirmed: 0, cancelled: 0, changes: [] });
  return (
    <>
      <div style={{ height: ${SPACER_ABOVE} }} />
      <div className="flex justify-center overflow-x-auto overflow-y-hidden px-1 sm:px-2" style={{ scrollbarWidth: "none" }}>
        <HexBoard grid={GRID} selectedTile={null} onTileClick={() => {}} />
      </div>
      <div style={{ height: ${SPACER_BELOW} }} />
      {open && (
        <HexTroopPopup
          anchorKey={ANCHOR}
          preferPlacement={PREFER === "below" ? "below" : PREFER === "above" ? "above" : undefined}
          title="Send troops"
          hint="Move the chosen number of troops"
          tip="Tap another green tile to send from there"
          value={value}
          max={3}
          color="#22d3ee"
          onChange={(n) => { state.changes.push(n); setValue(n); }}
          onConfirm={() => { state.confirmed += 1; setOpen(false); }}
          onCancel={() => { state.cancelled += 1; setOpen(false); }}
        />
      )}
    </>
  );
}

createRoot(document.getElementById("root")).render(
  <div className="mx-auto w-full max-w-7xl px-2 sm:px-4 lg:px-6">
    <Harness />
  </div>,
);
`;

writeFileSync(ENTRY, ENTRY_SOURCE);

let failed = [];
try {
  await build({
    entryPoints: [ENTRY],
    bundle: true,
    outfile: OUT,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    loader: { ".tsx": "tsx" },
    define: { "process.env.NODE_ENV": '"development"' },
    logLevel: "warning",
  });

  writeFileSync(
    join(tmp, "index.html"),
    `<!doctype html><html><head><meta charset="utf-8"></head>
<body><div id="root"></div><script src="./bundle.js"></script></body></html>`,
  );

  const generated = await postcss([
    tailwind({
      content: [
        ENTRY,
        join(ROOT, "src/components/HexTroopPopup.tsx"),
        join(ROOT, "src/components/HexBoard.tsx"),
        join(ROOT, "src/components/HexTile.tsx"),
      ],
    }),
  ]).process("@tailwind base;\n@tailwind components;\n@tailwind utilities;\n", {
    from: undefined,
  });
  writeFileSync(join(tmp, "tw.css"), generated.css);

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));

    const check = (cond, label) => {
      console.log(cond ? "PASS" : "FAIL", label);
      if (!cond) failed.push(label);
      return cond;
    };

    const load = async (tile = "1,0", prefer = null) => {
      const query = new URLSearchParams({ tile });
      if (prefer) query.set("prefer", prefer);
      await page.goto(`${PAGE}?${query}`);
      await page.addStyleTag({ path: join(tmp, "tw.css") });
      await page.waitForSelector('[role="dialog"]');
      // Let the board settle (it sizes itself in an effect after mount).
      await page.waitForTimeout(150);
    };

    const measure = (tileKey = "1,0") =>
      page.evaluate((key) => {
        const dialog = document.querySelector('[role="dialog"]');
        const tile = document.querySelector(`[data-hex-board] [data-tile-key="${key}"]`);
        if (!dialog || !tile) return null;
        const d = dialog.getBoundingClientRect();
        const t = tile.getBoundingClientRect();
        const centreX = d.left + d.width / 2;
        const centreY = d.top + d.height / 2;
        const hit = document.elementFromPoint(centreX, centreY);
        const caret = dialog.querySelector('span[aria-hidden="true"]');
        const c = caret && caret.getBoundingClientRect();
        return {
          dialog: { top: d.top, bottom: d.bottom, left: d.left, right: d.right, w: d.width, h: d.height },
          tile: { top: t.top, bottom: t.bottom, left: t.left, right: t.right, w: t.width, h: t.height },
          tileCentreX: t.left + t.width / 2,
          dialogCentreX: centreX,
          hitInsidePopup: !!(hit && dialog.contains(hit)),
          vw: window.innerWidth,
          vh: window.innerHeight,
          inputValue: Number(document.querySelector('input[aria-label="Troops to send"]').value),
          tipText:
            Array.from(dialog.querySelectorAll("p"))
              .map((p) => p.textContent.trim())
              .find((t) => t.startsWith("Tap another green tile")) ?? null,
          quickPickLabels: Array.from(dialog.querySelectorAll("button")).map((b) => b.textContent.trim()),
          caretInside: !!(c && c.left >= d.left - 6 && c.right <= d.right + 6),
        };
      }, tileKey);

    // ── 1. Anchored above the tile, centred on it ────────────────────────
    await load();
    let m = await measure();
    console.log(JSON.stringify(m, null, 2));
    const GAP = 10;
    check(m.dialog.bottom <= m.tile.top, "popup sits above the anchored tile");
    check(
      Math.abs(m.dialog.bottom - (m.tile.top - GAP)) <= 2,
      `popup clears the tile by the ${GAP}px anchor gap`,
    );
    check(
      Math.abs(m.dialogCentreX - m.tileCentreX) <= 1,
      "popup is horizontally centred on the anchored tile",
    );
    check(m.hitInsidePopup, "popup is not clipped by the board's overflow container");
    check(m.caretInside, "caret stays inside the popup body");
    check(m.tipText !== null, "the switch-source tip is rendered when supplied");

    // ── 2. Quick picks + Confirm ────────────────────────────────────────
    check(m.quickPickLabels.includes("MAX"), "the maximum is offered, labelled MAX");
    check(
      m.quickPickLabels.filter((l) => l === "MAX").length === 1,
      "the maximum appears exactly once (no duplicate MAX/1 buttons)",
    );
    check(!m.quickPickLabels.includes("3"), "the count equal to the maximum is not offered twice");
    await page.getByRole("dialog").getByRole("button", { name: "1", exact: true }).click();
    m = await measure();
    check(m.inputValue === 1, "clicking a quick pick updates the count input");
    await page.getByRole("dialog").getByRole("button", { name: "MAX", exact: true }).click();
    m = await measure();
    check(m.inputValue === 3, "the MAX pick fills the limit");
    await page.getByRole("dialog").getByRole("button", { name: /Confirm/ }).click();
    let state = await page.evaluate(() => window.__hex);
    check(
      state.confirmed === 1 && state.changes.includes(1) && state.changes.includes(3),
      "Confirm fires onConfirm once, after the picks",
    );
    check(
      (await page.locator('[role="dialog"]').count()) === 0,
      "popup unmounts once the action is confirmed",
    );

    // ── 3. Escape cancels ───────────────────────────────────────────────
    await load();
    await page.keyboard.press("Escape");
    state = await page.evaluate(() => window.__hex);
    check(state.cancelled === 1, "Escape cancels the pending action");

    // ── 4. Honours the caller's preferred side ──────────────────────────
    // Hex Duel asks for the side facing away from the target so the popup
    // never covers it. Park the tile mid-viewport, where BOTH sides fit, so
    // the preference is the only thing deciding.
    const parkMidViewport = async () => {
      await page.evaluate(() => {
        const t = document.querySelector('[data-hex-board] [data-tile-key="1,0"]');
        window.scrollTo(0, Math.max(0, window.scrollY + t.getBoundingClientRect().top - 300));
      });
      await page.waitForTimeout(80);
    };

    await load("1,0", "below");
    await parkMidViewport();
    m = await measure();
    check(
      m.tile.top - GAP - m.dialog.h >= GAP && m.tile.bottom + GAP + m.dialog.h <= m.vh - GAP + 1,
      `both sides have room (tile ${m.tile.top.toFixed(0)}..${m.tile.bottom.toFixed(0)}px, popup ${m.dialog.h.toFixed(0)}px)`,
    );
    check(
      m.dialog.top >= m.tile.bottom - 1,
      "prefer=below opens under the tile even though above has room",
    );
    check(
      Math.abs(m.dialog.top - (m.tile.bottom + GAP)) <= 2,
      "…clearing the tile by the anchor gap",
    );

    await load("1,0", "above");
    await parkMidViewport();
    m = await measure();
    check(
      m.dialog.bottom <= m.tile.top + 1,
      "prefer=above opens over the tile even though below has room",
    );

    // ── 5. Flips below when the tile is near the top of the screen ──────
    await page.setViewportSize({ width: 900, height: 640 });
    await load();
    await page.evaluate(() => {
      const t = document.querySelector('[data-hex-board] [data-tile-key="1,0"]');
      const y = window.scrollY + t.getBoundingClientRect().top;
      window.scrollTo(0, Math.max(0, y - 40));
    });
    await page.waitForFunction(() => {
      const d = document.querySelector('[role="dialog"]');
      const t = document.querySelector('[data-hex-board] [data-tile-key="1,0"]');
      return !!d && !!t && d.getBoundingClientRect().top >= t.getBoundingClientRect().bottom - 1;
    });
    m = await measure();
    check(m.tile.top < 120, `tile scrolled near the viewport top (${m.tile.top.toFixed(0)}px)`);
    check(m.dialog.top >= m.tile.bottom - 1, "popup flips below the tile when there is no room above");
    check(m.dialog.bottom <= m.vh - GAP + 0.5, "flipped popup keeps the viewport margin");
    check(m.hitInsidePopup, "flipped popup is still hit-testable");

    // ── 6. Clamped inside a narrow viewport ─────────────────────────────
    await page.setViewportSize({ width: 360, height: 740 });
    await load("4,0");
    m = await measure("4,0");
    check(
      m.dialog.left >= GAP - 0.5 && m.dialog.right <= m.vw - GAP + 0.5,
      `popup stays inside the 360px viewport (${m.dialog.left.toFixed(0)}..${m.dialog.right.toFixed(0)})`,
    );
    check(
      m.dialog.top >= GAP - 0.5 && m.dialog.bottom <= m.vh - GAP + 0.5,
      "popup stays inside the viewport vertically",
    );
    check(m.hitInsidePopup, "narrow-viewport popup is hit-testable");

    check(errors.length === 0, `no runtime errors (${errors.length})`);
    if (errors.length) console.log(errors.join("\n"));
  } finally {
    await browser.close();
  }
} finally {
  rmSync(ENTRY, { force: true });
  rmSync(tmp, { recursive: true, force: true });
}

console.log(failed.length === 0 ? "ALL PASS" : `${failed.length} FAILED`);
process.exitCode = failed.length === 0 ? 0 : 1;
