// qa/games-mobile-audit.mjs
//
// Audits EVERY game route at phone width in a real browser and reports the ones
// that do not fit — the mobile counterpart of qa/games-blank-audit.mjs.
//
// The class of bug behind "tic-tac-toe isn't responsive when 9 boards show" is
// specific: an element whose intrinsic width exceeds the phone's content box, so
// it is either cut off (the page root is usually `overflow-x-clip`/`hidden`, so
// nothing even scrolls to reveal it) or smuggled into a horizontally-scrolling
// band. So each route is judged on three measurable signals:
//
//   1. CUT OFF  — visible elements whose painted box extends past the viewport
//      (right > viewport + 1 or left < -1). Only the OUTERMOST such element per
//      subtree is reported, so one bad wrapper does not list its 40 children.
//   2. SCROLL BAND — elements that actually scroll horizontally on a phone
//      (`overflow-x: auto|scroll` with `scrollWidth > clientWidth`). A band is
//      not always a bug, so these are reported separately, with the hidden
//      width, for review.
//   3. PAGE SCROLL — the document itself scrolling sideways.
//
// Decorative, non-interactive and screen-reader-only nodes are ignored (they
// legitimately sit outside the box). Screenshots of every route that flags go
// to qa/reports/games-mobile-audit/, and the full result to
// qa/reports/games-mobile-audit.json.
//
// Usage:
//   node qa/games-mobile-audit.mjs                       # localhost:3210
//   BASE=http://localhost:3000 node qa/games-mobile-audit.mjs
//   WIDTH=320 node qa/games-mobile-audit.mjs             # a narrower phone
//   node qa/games-mobile-audit.mjs --shots               # screenshot everything
//
// The server must already be running. Start it with CLERK_SECRET_KEY="" so the
// proxy skips Clerk and every route stays reachable without a session:
//   CLERK_SECRET_KEY="" npx next dev -p 3210
//
// One artefact of that bypass: a route that calls Clerk's `auth()` server-side
// renders Clerk's own configuration-error page instead of the game. That page's
// long, unbreakable message is a genuine overflow OF THE ERROR PAGE, not of the
// app — it is reported by the audit as `Chess table` at narrow widths. Judge
// that one entry with that in mind; every other entry is real UI.

import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPORTS = join(root, "qa", "reports", "games-mobile-audit");
mkdirSync(REPORTS, { recursive: true });

const BASE = process.env.BASE || "http://localhost:3210";
const WIDTH = Number(process.env.WIDTH || 390);
const HEIGHT = Number(process.env.HEIGHT || 844);
const SHOT_ALL = process.argv.includes("--shots");
const CHANNEL = process.env.BROWSER_CHANNEL || "";

// ── The route inventory (kept in step with qa/games-blank-audit.mjs) ───────
// Landing pages: what a player can reach without an existing match.
const ROUTES = [
  { game: "Hub", path: "/games" },
  { game: "Chess", path: "/games/chess" },
  { game: "Chess vs AI", path: "/games/chess/ai" },
  { game: "Dice Flush", path: "/games/dice-flush" },
  { game: "Dots and Boxes", path: "/games/dots-and-boxes" },
  { game: "Four-In-A-Row", path: "/games/four-in-a-row" },
  { game: "Four-In-A-Row vs AI", path: "/games/four-in-a-row/play-ai" },
  { game: "Hex Duel", path: "/games/hex-duel" },
  { game: "Hex Duel multiplayer", path: "/games/hex-duel/multiplayer" },
  { game: "Hex Duel history", path: "/games/hex-duel/history" },
  { game: "Keno", path: "/games/keno" },
  { game: "Keno PvP", path: "/games/keno-pvp" },
  { game: "Lane Runner", path: "/games/lane-runner" },
  { game: "Lane Runner history", path: "/games/lane-runner/history" },
  { game: "Memory Grid", path: "/games/memory-grid" },
  { game: "Mines PvP", path: "/games/mines-pvp" },
  { game: "Neon Flush", path: "/games/neon-flush" },
  { game: "Odds", path: "/games/odds" },
  { game: "Pool Masters", path: "/games/pool-masters" },
  { game: "Precision", path: "/games/precision" },
  { game: "Precision test", path: "/games/precision/test" },
  { game: "RPS", path: "/games/rps" },
  { game: "RPS vs AI", path: "/games/rps/play-ai" },
  { game: "Solitaire Duel", path: "/games/solitaire-duel" },
  { game: "Sudoku Duel", path: "/games/sudoku-duel" },
  { game: "Tic-Tac-Toe", path: "/games/tic-tac-toe" },
  { game: "Tower Arena", path: "/games/tower-arena" },
  { game: "Uno", path: "/games/uno" },
];

// Match / table pages: the render path a real game link takes.
const MATCH_ROUTES = [
  { game: "Tic-Tac-Toe match", path: "/games/tic-tac-toe/1" },
  { game: "Chess table", path: "/games/chess/10" },
  { game: "Dots and Boxes game", path: "/games/dots-and-boxes/game/1" },
  { game: "Four-In-A-Row game", path: "/games/four-in-a-row/game/1" },
  { game: "Keno PvP match", path: "/games/keno-pvp/1" },
  { game: "Lane Runner match", path: "/games/lane-runner/1" },
  { game: "Memory Grid match", path: "/games/memory-grid/1" },
  { game: "Mines PvP match", path: "/games/mines-pvp/1" },
  { game: "Pool Masters game", path: "/games/pool-masters/game/1" },
  { game: "Precision game", path: "/games/precision/game/1" },
  { game: "RPS game", path: "/games/rps/game/1" },
  { game: "Solitaire Duel match", path: "/games/solitaire-duel/1" },
  { game: "Sudoku Duel match", path: "/games/sudoku-duel/1" },
  { game: "Tower Arena game", path: "/games/tower-arena/game/1" },
  { game: "Uno game", path: "/games/uno/game/1" },
];

const ALL = [...ROUTES, ...MATCH_ROUTES];

// ── The in-page measurement ────────────────────────────────────────────────
// Everything runs in the page so the browser does the layout work. Returning
// only strings keeps a 1000-node page from serialising its whole DOM.
const PROBE = () => {
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;

  const cssPath = (el) => {
    const parts = [];
    let node = el;
    let depth = 0;
    while (node && node.nodeType === 1 && depth < 4) {
      let part = node.tagName.toLowerCase();
      if (node.id) {
        part += `#${node.id}`;
        parts.unshift(part);
        break;
      }
      const cls = (node.getAttribute("class") || "").trim().split(/\s+/).filter(Boolean);
      if (cls.length) part += "." + cls.slice(0, 3).join(".");
      parts.unshift(part);
      node = node.parentElement;
      depth += 1;
    }
    return parts.join(" > ");
  };

  const skip = (el, style, r) => {
    if (style.display === "none" || style.visibility === "hidden") return true;
    if (style.pointerEvents === "none") return true;
    if (r.width === 0 || r.height === 0) return true;
    // A running animation (the support FAB's ping ripple, a loading pulse) is
    // mid-flight when the probe runs and paints outside a box it never holds at
    // rest. `scale(2)` on a 56px button reads as a 110px overflow.
    if (style.animationName !== "none") return true;
    // A `fixed`/`absolute` node parked far outside the box (an off-canvas menu,
    // a transition start state) is not the bug in question.
    if (r.bottom < -8 || r.top > vh * 4) return true;
    if (el.closest('[aria-hidden="true"]')) return true;
    if (el.closest('[data-mobile-audit-ignore]')) return true;
    return false;
  };

  // 1. Elements painting outside the viewport. Deepest-first so an ancestor can
  //    claim its descendants, then reversed to report only the outermost.
  const all = [...document.querySelectorAll("body *")];
  const rects = new Map();
  const offenders = [];
  for (const el of all) {
    const style = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    rects.set(el, r);
    if (skip(el, style, r)) continue;
    if (r.right <= vw + 1 && r.left >= -1) continue;
    offenders.push(el);
  }
  const outermost = offenders.filter((el) => {
    let node = el.parentElement;
    while (node) {
      if (offenders.includes(node)) return false;
      node = node.parentElement;
    }
    return true;
  });

  const cutOff = outermost.map((el) => {
    const r = rects.get(el);
    return {
      selector: cssPath(el),
      left: Math.round(r.left),
      right: Math.round(r.right),
      width: Math.round(r.width),
      overflowRight: Math.round(r.right - vw),
      overflowLeft: Math.round(-r.left),
      text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60),
    };
  });

  // 2. Horizontal scroll bands: they "work" but hide content on a phone.
  const bands = [];
  for (const el of all) {
    const style = getComputedStyle(el);
    if (!/(auto|scroll)/.test(style.overflowX)) continue;
    if (el.scrollWidth <= el.clientWidth + 1) continue;
    if (el.clientHeight === 0) continue;
    bands.push({
      selector: cssPath(el),
      hiddenWidth: el.scrollWidth - el.clientWidth,
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60),
    });
  }

  // 3. Fixed-size offenders: a wide inline/fixed size is the usual cause.
  const fixed = [];
  for (const el of offenders) {
    const inline = el.getAttribute("style") || "";
    const cls = el.getAttribute("class") || "";
    if (/min-width|width/i.test(inline) || /(^|\s)(min-)?w-\[\d/.test(cls)) {
      fixed.push({ selector: cssPath(el), inline: inline.slice(0, 120), class: cls.slice(0, 140) });
    }
  }

  return {
    viewportWidth: vw,
    viewportHeight: vh,
    documentScrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
    documentWidth: Math.max(
      document.documentElement.scrollWidth,
      document.body.scrollWidth,
      document.documentElement.offsetWidth,
    ),
    textChars: (document.body.innerText || "").replace(/\s+/g, " ").trim().length,
    cutOff: cutOff.slice(0, 10),
    cutOffCount: cutOff.length,
    bands: bands.slice(0, 10),
    fixed: fixed.slice(0, 10),
  };
};

// ── Run ───────────────────────────────────────────────────────────────────
const browser = await chromium.launch(CHANNEL ? { channel: CHANNEL } : {});
const context = await browser.newContext({
  viewport: { width: WIDTH, height: HEIGHT },
  deviceScaleFactor: 2,
  hasTouch: true,
  isMobile: true,
});
const results = [];

console.log(`Auditing ${ALL.length} game routes at ${WIDTH}×${HEIGHT} against ${BASE}\n`);

for (const route of ALL) {
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push(String(e.message).slice(0, 160)));
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text().slice(0, 160));
  });

  let status = 0;
  let probe = null;
  let error = null;
  try {
    const res = await page.goto(BASE + route.path, { waitUntil: "domcontentloaded", timeout: 90000 });
    status = res?.status() ?? 0;
    // Let the client hydrate + fetch and any entrance motion settle.
    await page.waitForTimeout(2500);
    probe = await page.evaluate(PROBE);
  } catch (e) {
    error = String(e.message).slice(0, 180);
  }

  const flagged =
    !!probe && (probe.cutOffCount > 0 || probe.bands.length > 0 || probe.documentWidth > WIDTH + 1);

  results.push({ ...route, status, error, consoleErrors: consoleErrors.slice(0, 3), ...(probe ?? {}) });

  if (probe) {
    const doc = `doc ${probe.documentWidth}`;
    const verdict = probe.cutOffCount > 0 ? `CUT OFF ${probe.cutOffCount}` : probe.bands.length ? `BAND ${probe.bands.length}` : probe.documentWidth > WIDTH + 1 ? "PAGE SCROLL" : "ok";
    console.log(
      `${verdict.padEnd(14)} ${route.game.padEnd(24)} ${route.path.padEnd(34)} ${doc}, ${probe.textChars} chars${error ? ` (error: ${error})` : ""}`,
    );
    for (const c of probe.cutOff.slice(0, 4)) {
      console.log(
        `                 ↳ +${c.overflowRight}px right / +${c.overflowLeft}px left  ${c.width}px wide  ${c.selector}`,
      );
    }
  } else {
    console.log(`${"ERROR".padEnd(14)} ${route.game.padEnd(24)} ${route.path.padEnd(34)} ${error ?? `HTTP ${status}`}`);
  }

  if ((flagged || SHOT_ALL) && probe) {
    const name = route.path.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "root";
    await page.screenshot({ path: join(REPORTS, `${name}.png`), fullPage: false }).catch(() => {});
  }

  await page.close();
}

await browser.close();

writeFileSync(join(REPORTS, "games-mobile-audit.json"), JSON.stringify(results, null, 2));

const cutOff = results.filter((r) => (r.cutOffCount ?? 0) > 0);
const bands = results.filter((r) => (r.bands?.length ?? 0) > 0);
console.log(`\n${results.length} routes audited at ${WIDTH}×${HEIGHT}`);
console.log(`  ${cutOff.length} cut off:  ${cutOff.map((r) => r.game).join(", ") || "none"}`);
console.log(`  ${bands.length} scroll bands: ${bands.map((r) => r.game).join(", ") || "none"}`);
console.log(`Report: qa/reports/games-mobile-audit.json`);
process.exit(cutOff.length === 0 ? 0 : 1);
