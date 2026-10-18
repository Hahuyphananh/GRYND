/**
 * game-primitives.test.mjs
 *
 * The shared game-surface primitives of stage 2 — GameBoardFrame, GameCell,
 * GamePiece, TurnBanner — checked by RENDERING them (react-dom/server) and by
 * reading their sources.
 *
 * What this suite is protecting:
 *
 *   1. RENDERING — every primitive renders real HTML on the server, with the
 *      state, seat and ownership hooks a game and a QA harness need. These are
 *      presentational components: no state, no effects, no browser globals, so
 *      "renders once, identically" is a property worth pinning.
 *   2. A11Y — an interactive cell is a real <button>; a cell that is not offered
 *      keeps aria-disabled and STAYS focusable; the turn banner is a live region
 *      only when asked; ownership has a non-visual cue (ownerLabel).
 *   3. NO NEW COLOURS — every colour is a var(--gr-*) token or a token-backed
 *      utility. A pasted Tailwind palette class (text-fuchsia-300) or a hex
 *      would reintroduce exactly the drift stage 1 removed.
 *   4. NO FIXED ASPECT RATIO, NO CLIPPING — the frame must not force a shape on
 *      a board whose geometry is its own, and nothing may hide a legal-move
 *      marker or a label that overhangs its cell.
 *   5. NO COPY, NO LOGIC — TurnBanner holds no instruction text of its own (the
 *      app's translated strings are passed in), and none of the four imports
 *      game logic or framer-motion (which would force them client-side).
 *   6. ADDITIVE — nothing in src/ imports the folder yet; adoption is opt-in,
 *      one component at a time, in a later phase.
 *
 * Run:  node --import tsx --test tests/game-primitives.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const read = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");

const FILES = {
  frame: "src/components/game-ui/GameBoardFrame.tsx",
  cell: "src/components/game-ui/GameCell.tsx",
  piece: "src/components/game-ui/GamePiece.tsx",
  banner: "src/components/game-ui/TurnBanner.tsx",
  barrel: "src/components/game-ui/index.ts",
};
const SRC = Object.fromEntries(Object.entries(FILES).map(([k, p]) => [k, read(p)]));
const GLOBALS = read("src/app/globals.css");

const { GameBoardFrame, GameCell, GamePiece, TurnBanner } = await import(
  "../src/components/game-ui/index.ts"
);

const render = (el) => renderToStaticMarkup(el);

const SILHOUETTES = ["disc", "tile", "diamond", "hex", "bar", "card", "spike", "glyph"];

/** Every colour-ish declaration that is NOT a var(--gr-*) reference. */
function foreignColours(source) {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const found = [];
  for (const hex of withoutComments.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) found.push(hex[0]);
  // `rgb(var(--gr-x-rgb) / a)` is a token reference, not a literal colour.
  for (const fn of withoutComments.matchAll(/\b(?:rgba?|hsla?)\((?!var\(--gr-)/g)) found.push(fn[0]);
  // Tailwind's own palette namespaces: a class like `text-fuchsia-300`.
  // (`transparent` is a keyword, not a palette entry, so it is not flagged.)
  for (const cls of withoutComments.matchAll(
    /\b(?:bg|text|border|ring|fill|stroke|from|to|via|shadow|outline|decoration|divide|placeholder|caret|accent)-(?:black|white|slate|gray|grey|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)\b/g,
  )) {
    found.push(cls[0]);
  }
  return [...new Set(found)];
}

// ══════════════════════════════════════════════════════════════════════════
// 1. Rendering
// ══════════════════════════════════════════════════════════════════════════

test("GameBoardFrame renders a labelled region around its children", () => {
  const html = render(
    h(GameBoardFrame, { label: "Tic-tac-toe board", "data-testid": "board" }, h("span", null, "cells")),
  );
  assert.match(html, /data-gr-board-frame=""/);
  assert.match(html, /role="group"/);
  assert.match(html, /aria-label="Tic-tac-toe board"/);
  assert.match(html, /data-testid="board"/);
  assert.match(html, /<span>cells<\/span>/);
  assert.match(html, /data-shape="rounded"/);
});

test("the frame imposes NO aspect ratio unless asked, and never clips", () => {
  const plain = render(h(GameBoardFrame, { label: "board" }, null));
  assert.ok(
    !/aspect-ratio/.test(plain),
    "the default frame must not set an aspect ratio — boards have their own geometry",
  );

  const fixed = render(h(GameBoardFrame, { aspect: "16 / 9" }, null));
  assert.match(fixed, /aspect-ratio:\s*16\s*\/\s*9/);

  for (const [name, html] of [
    ["default", plain],
    ["aspect", fixed],
    ["sharp", render(h(GameBoardFrame, { shape: "sharp", accent: "corners" }, null))],
  ]) {
    assert.ok(!/overflow:hidden/.test(html), `${name} frame must not clip (legal moves / labels overhang)`);
    assert.ok(!/overflow-hidden/.test(html), `${name} frame must not clip`);
  }
});

test("the sharp frame is the Four-In-A-Row HUD language, and it is explicit", () => {
  const html = render(h(GameBoardFrame, { shape: "sharp", accent: "corners" }, null));
  assert.match(html, /data-shape="sharp"/);
  assert.match(html, /rounded-\[3px\]/, "sharp corners, like the game's own HUD board");
  assert.match(html, /border-brand-cyan\/55/, "the 1px cyan edge");
  assert.match(html, /inset 0 0 44px rgb\(var\(--gr-brand-cyan-rgb\) \/ 0\.05\)/, "the HUD's inset haze");
  const accent = html.match(/data-gr-frame-accent="corners"[^>]*aria-hidden="true"|aria-hidden="true"[^>]*data-gr-frame-accent="corners"/);
  assert.ok(accent, "the corner brackets must be decorative (aria-hidden)");
});

test("maxWidth takes rem as a number and any CSS length as a string", () => {
  assert.match(render(h(GameBoardFrame, { maxWidth: 30 }, null)), /max-width:30rem/);
  assert.match(
    render(h(GameBoardFrame, { maxWidth: "min(100%, 36rem)" }, null)),
    /max-width:min\(100%, 36rem\)/,
  );
});

test("role=presentation drops both the role and the label", () => {
  const html = render(h(GameBoardFrame, { label: "board", role: "presentation" }, null));
  assert.ok(!/role="group"/.test(html));
  assert.ok(!/aria-label/.test(html));
});

test("an interactive GameCell is a real button, and a disabled one stays focusable", () => {
  const button = render(h(GameCell, { label: "Row 1, column 1 — empty", onSelect: () => {} }, null));
  assert.match(button, /^<button/);
  assert.match(button, /type="button"/);
  assert.match(button, /data-interactive="true"/);
  assert.ok(!/aria-disabled/.test(button), "an offered cell must not be announced as disabled");

  const blocked = render(h(GameCell, { disabled: true, onSelect: () => {} }, null));
  assert.match(blocked, /aria-disabled="true"/);
  assert.ok(
    !/(?:^|\s)disabled(?:=|\s|>)/.test(blocked),
    "a cell that is not offered must stay tabbable — aria-disabled, never the native attribute",
  );
  assert.match(blocked, /data-state="disabled"/);
  assert.match(blocked, /gr-disabled/);

  const inert = render(h(GameCell, { label: "cell", occupied: true }, null));
  assert.match(inert, /^<div/, "a cell nobody can act on is not a button");
  assert.match(inert, /data-state="occupied"/);
});

test("GameCell carries one hook per state a game can actually have", () => {
  const cases = [
    [{}, "default"],
    [{ occupied: true }, "occupied"],
    [{ legalMove: true }, "legal"],
    [{ selected: true }, "selected"],
    [{ disabled: true }, "disabled"],
  ];
  const seen = new Set();
  for (const [props, expected] of cases) {
    const html = render(h(GameCell, props, null));
    assert.match(html, new RegExp(`data-state="${expected}"`), `${expected} state must be addressable`);
    if (expected === "legal") assert.match(html, /gr-legal-move/, "the legal cue is the token's hollow marker");
    if (expected === "selected") assert.match(html, /gr-selected/, "selection is the token's dashed outline");
    seen.add(html);
  }
  assert.equal(seen.size, cases.length, "the five states must render differently, not converge");
});

test("ownership is a colour AND a shape, plus a non-visual cue", () => {
  const one = render(h(GameCell, { owner: 1, label: "Row 2, column 1", ownerLabel: "Ana" }, null));
  const two = render(h(GameCell, { owner: 2, label: "Row 2, column 1", ownerLabel: "Bo" }, null));

  for (const html of [one, two]) {
    assert.match(html, /gr-owned/, "an owned cell carries the inset ownership ring");
    assert.match(html, /gr-seat-pip--invert/, "and a pip in the outline colour, readable on the fill");
  }
  assert.match(one, /data-owner="1"[\s\S]*gr-seat--1/);
  assert.match(two, /data-owner="2"[\s\S]*gr-seat--2/);
  assert.notEqual(one, two, "seat 1 and seat 2 must not render identically");
  assert.match(one, /aria-label="Row 2, column 1 — Ana"/, "the owner reaches the accessible name");
  assert.match(two, /aria-label="Row 2, column 1 — Bo"/);

  const unowned = render(h(GameCell, { label: "cell" }, null));
  assert.ok(!/gr-owned/.test(unowned), "a cell with no owner gets no ownership ring");
});

test("a cell is square by default, and a game can opt out", () => {
  // A grid cell with no ratio collapses to its border height — measured in the
  // browser as 22x2px on a 9-column board at 320px — which is never a board.
  const square = render(h(GameCell, { label: "cell" }, null));
  assert.match(square, /aspect-square/);
  const oblong = render(h(GameCell, { label: "cell", square: false }, null));
  assert.ok(!/aspect-square/.test(oblong), "square={false} is the documented opt-out for oblong cells");
  // The ratio is the only thing it adds: no size, no width, no fixed height.
  for (const html of [square, oblong]) {
    assert.ok(!/\b(?:w|h)-\[?\d+px/.test(html), "a cell must not impose a pixel size on its board");
  }
});

test("a cell is touch-friendly only when the board has the room", () => {
  const tight = render(h(GameCell, { onSelect: () => {} }, null));
  const roomy = render(h(GameCell, { onSelect: () => {}, touchTarget: true }, null));
  assert.ok(!/min-h-11/.test(tight), "a 9x9 grid at 320px must not be forced to a 44px cell floor");
  assert.match(roomy, /min-h-11/);
  assert.match(roomy, /min-w-11/);
  for (const html of [tight, roomy]) {
    assert.match(html, /touch-action:manipulation/, "every interactive cell suppresses the double-tap zoom delay");
  }
});

test("grid semantics and the focus ring come from the caller and the tokens", () => {
  const html = render(
    h(GameCell, { role: "gridcell", rowIndex: 2, colIndex: 3, label: "cell", onSelect: () => {} }, null),
  );
  assert.match(html, /role="gridcell"/);
  assert.match(html, /aria-rowindex="2"/);
  assert.match(html, /aria-colindex="3"/);
  assert.match(html, /gr-focusable/, "keyboard focus uses the shared focus-ring token");
  assert.match(html, /gr-cell/, "and the shared cell radius token");
});

test("every GamePiece silhouette is a distinct shape, drawn the same way", () => {
  const paths = new Map();
  for (const silhouette of SILHOUETTES) {
    const html = render(h(GamePiece, { silhouette, seat: 1 }, null));
    assert.match(html, new RegExp(`data-silhouette="${silhouette}"`));
    const d = [...html.matchAll(/d="([^"]+)"/g)].map((m) => m[1]);
    if (silhouette === "glyph") {
      assert.equal(d.length, 0, "glyph draws no silhouette of its own — the game supplies the art");
      continue;
    }
    assert.ok(d.length >= 2, `${silhouette} must draw a body and a highlight`);
    paths.set(silhouette, d[0]);
    // One outline weight, one outline colour, at every size.
    assert.match(html, /stroke="var\(--gr-outline\)"/);
    assert.match(html, /stroke-width="var\(--gr-outline-width\)"/);
    assert.match(html, /vector-effect="non-scaling-stroke"/, `${silhouette} must keep the token's outline weight at any size`);
    // Three values: fill, highlight, shade.
    assert.match(html, /fill="var\(--gr-piece-shade\)"/, `${silhouette} must carry the shade token`);
    assert.match(html, /fill="var\(--gr-piece-highlight\)"/, `${silhouette} must carry the highlight token`);
  }
  assert.equal(
    new Set(paths.values()).size,
    paths.size,
    "no two silhouettes may share a path — that is how every piece became the same blob",
  );
});

test("GamePiece decides ownership by shape, not hue alone", () => {
  const one = render(h(GamePiece, { seat: 1, label: "Ana's disc" }, null));
  const two = render(h(GamePiece, { seat: 2, label: "Bo's disc" }, null));
  assert.match(one, /gr-seat--1/);
  assert.match(two, /gr-seat--2/);
  assert.match(one, /color:var\(--gr-player-1\)/);
  assert.match(two, /color:var\(--gr-player-2\)/);
  assert.match(one, /data-gr-owner-pip="1"/);
  assert.match(two, /data-gr-owner-pip="2"/);
  assert.match(one, /gr-seat-pip--invert/);
  assert.match(two, /gr-seat-pip--invert/);

  const neutral = render(h(GamePiece, { silhouette: "spike" }, null));
  assert.match(neutral, /color:var\(--gr-seat-neutral\)/);
  assert.ok(!/data-gr-owner-pip/.test(neutral), "a neutral piece (a mine, a wall) has no owner pip");
});

test("a labelled piece is announced; an unlabelled one is decorative", () => {
  const labelled = render(h(GamePiece, { label: "Red counter", size: 40 }, null));
  assert.match(labelled, /role="img"/);
  assert.match(labelled, /aria-label="Red counter"/);
  assert.match(labelled, /sr-only/);
  assert.match(labelled, /width:40px/);

  const decorative = render(h(GamePiece, { seat: 1 }, null));
  assert.match(decorative, /aria-hidden="true"/);
});

test("a piece can be given its own art, a size, and a shape family", () => {
  const glyph = [
    "chess",
  ];
  const html = render(
    h(
      GamePiece,
      { silhouette: "glyph", seat: 1, size: "lg", label: glyph[0], shape: "sharp" },
      h("svg", { viewBox: "0 0 24 24" }, h("path", { d: "M2 2h20v20H2z" })),
    ),
  );
  assert.match(html, /h-\[3\.25rem\]/, "the lg preset");
  assert.match(html, /rounded-\[3px\]/, "the sharp family");
  assert.match(html, /viewBox="0 0 24 24"/, "caller-supplied art renders inside the frame");
  assert.match(html, /color:var\(--gr-player-1\)/, "and still inherits the seat colour");
});

test("TurnBanner renders the app's own string, not one of its own", () => {
  const html = render(h(TurnBanner, { message: "Your move — 0:12 left" }, null));
  assert.match(html, /data-gr-turn-banner=""/);
  assert.match(html, /Your move — 0:12 left/);
  assert.match(html, /role="status"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /data-tone="neutral"/);
});

test("the banner's tone and seat are explicit, and announcing is opt-out", () => {
  const mine = render(h(TurnBanner, { message: "Your move", tone: "your-turn", seat: 1 }, null));
  assert.match(mine, /data-tone="your-turn"/);
  assert.match(mine, /text-brand-yellow/, "your turn is the accent the app already uses for 'mine'");
  assert.match(mine, /data-gr-turn-seat="1"/);
  assert.match(mine, /gr-seat--1/);

  const theirs = render(h(TurnBanner, { message: "Opponent is moving", tone: "opponent-turn", seat: 2 }, null));
  assert.match(theirs, /gr-seat--2/);
  assert.match(theirs, /data-gr-turn-seat="2"/);
  assert.notEqual(mine, theirs);

  const quiet = render(h(TurnBanner, { message: "Round 2", announce: "off" }, null));
  assert.ok(!/role="status"/.test(quiet), "off means off — no second live region to double-announce");
  assert.ok(!/aria-live/.test(quiet));

  const loud = render(h(TurnBanner, { message: "5 seconds", announce: "assertive" }, null));
  assert.match(loud, /aria-live="assertive"/);
});

test("the banner takes trailing status content as-is", () => {
  const html = render(
    h(TurnBanner, { message: "Waiting", aside: h("span", { "data-clock": "" }, "0:12"), dense: true }, null),
  );
  assert.match(html, /data-clock=""/);
  assert.match(html, /0:12/);
  assert.match(html, /text-\[11px\]/, "dense is a real variant, not a class the caller re-invents");
});

// ══════════════════════════════════════════════════════════════════════════
// 2. Source contracts
// ══════════════════════════════════════════════════════════════════════════

test("no primitive is a client component — they render on the server", () => {
  for (const [name, source] of Object.entries(SRC)) {
    if (name === "barrel") continue;
    assert.ok(
      !/^["']use client["']/m.test(source),
      `${FILES[name]} must not opt into client rendering: game pages render it on the server too`,
    );
    for (const hook of ["useState", "useEffect", "useReducer", "useRef", "useId", "useLayoutEffect", "useSyncExternalStore"]) {
      assert.ok(!new RegExp(`\\b${hook}\\b`).test(source), `${FILES[name]} must stay stateless (found ${hook})`);
    }
    for (const browserGlobal of ["window.", "document.", "localStorage", "navigator."]) {
      assert.ok(!source.includes(browserGlobal), `${FILES[name]} must not touch ${browserGlobal}`);
    }
    assert.ok(!/from "framer-motion"/.test(source), `${FILES[name]} must not depend on framer-motion`);
    assert.ok(
      !/from "\.\.\/\.\.\/lib\//.test(source),
      `${FILES[name]} must not import game logic — presentation only`,
    );
  }
});

test("no primitive invents a colour", () => {
  for (const [name, source] of Object.entries(SRC)) {
    const foreign = foreignColours(source);
    assert.deepEqual(foreign, [], `${FILES[name]} must use var(--gr-*) tokens, found: ${foreign.join(", ")}`);
  }
  // …and they really do consume the token layer.
  for (const name of ["frame", "cell", "piece", "banner"]) {
    assert.ok(/gr-|--gr-/.test(SRC[name]), `${FILES[name]} must consume the token layer`);
  }
});

test("the stage-1 tokens the primitives rely on still exist", () => {
  for (const token of [
    "--gr-frame-shadow",
    "--gr-frame-inset",
    "--gr-piece-shade",
    "--gr-piece-highlight",
    "--gr-outline",
    "--gr-outline-width",
    "--gr-cell-radius",
    "--gr-focus-ring",
    "--gr-legal-move",
    "--gr-selected",
    "--gr-seat-1-shape",
    "--gr-seat-2-shape",
  ]) {
    assert.match(GLOBALS, new RegExp(`${token}:`), `${token} is missing from the token block`);
  }
  assert.match(GLOBALS, /\.gr-seat-pip--invert\s*\{/, "the inverted seat pip must exist for owned cells and pieces");
});

test("the loaded classes exist in the stylesheet or the Tailwind tokens", () => {
  for (const cls of ["gr-cell", "gr-focusable", "gr-owned", "gr-selected", "gr-legal-move", "gr-seat-pip", "gr-piece"]) {
    assert.match(GLOBALS, new RegExp(`\\.${cls}[\\s,{:.]`), `.${cls} must be defined in globals.css`);
  }
  const tailwind = read("tailwind.config.js");
  for (const utility of ["brand", "surface", "seat", "state", "piece", "ink"]) {
    assert.match(tailwind, new RegExp(`\\b${utility}: \\{`), `${utility} must be a token namespace`);
  }
});

test("no primitive authors user-facing copy", () => {
  const banner = SRC.banner
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  // The message is a REQUIRED prop: there is no fallback sentence to translate.
  assert.match(
    banner,
    /message:\s*ReactNode;/,
    "message must be required — a default would be untranslated copy in a component",
  );
  for (const phrase of [/your turn/i, /waiting for/i, /opponent is/i, /you win/i, /press to/i]) {
    assert.ok(
      !phrase.test(banner),
      `the banner must not contain the instruction "${phrase}" — games pass their own translated string`,
    );
  }
});

test("adoption is opt-in: only explicitly-listed games import it", () => {
  const walk = (dir) => {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = `${dir}/${entry.name}`;
      if (entry.isDirectory()) out.push(...walk(p));
      else out.push(p);
    }
    return out;
  };
  const importers = walk("src").filter((p) => {
    if (p.includes("components/game-ui/")) return false;
    if (!/\.(ts|tsx|js|jsx)$/.test(p)) return false;
    return /components\/game-ui|from "\.\.\/game-ui|from "\.\/game-ui/.test(read(p));
  });
  // Stage 2 shipped the primitives with no adopter. Stage 3 begins adoption,
  // one game at a time, and this list is the record of it: a new importer must
  // be added here deliberately, so no game can acquire the shared surface by
  // accident (and the adopters stay reviewable). Tower Arena is the pilot.
  const ADOPTERS = [
    "src/app/casino/tower-arena/game/[matchId]/PageClient.tsx",
  ];
  assert.deepEqual(
    importers.sort(),
    [...ADOPTERS].sort(),
    "only a documented adopter may import the shared primitives today",
  );
});
