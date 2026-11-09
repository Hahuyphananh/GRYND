/**
 * solitaire-board-themes.test.mjs
 *
 * THE TABLE-THEME CONTRACT.
 *
 * The six presets are the only new colour source in Solitaire, so this suite
 * pins the three things that would break quietly:
 *
 *   1. THE CATALOG — the six documented presets, unique keys/labels, Classic
 *      Green as the default, and a fallback that never leaves the board
 *      unstyled when the stored value is junk.
 *   2. CONTRAST — every felt is dark enough to hold a white card, and the slot
 *      text / legend / legal-move cue stay readable on it. This is measured
 *      here rather than eyeballed, so a "nicer" colour can't ship unreadable.
 *   3. WIRING — one shared board reads the theme, the picker is a real
 *      radiogroup with a reset, and all four modes render that same board.
 *      A theme must never be applied per mode.
 *
 * Run:  node --import tsx --test tests/solitaire-board-themes.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  BOARD_THEMES,
  BOARD_THEME_EVENT,
  BOARD_THEME_STORAGE_KEY,
  DEFAULT_BOARD_THEME,
  boardThemeFor,
  boardThemeLabel,
  isBoardThemeKey,
} from "../src/lib/solitaire-duel/boardThemes.ts";

const read = (path) => fs.readFileSync(path, "utf8").replace(/\r\n/g, "\n");
const code = (path) =>
  read(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

const BOARD = "src/components/solitaire-duel/SolitaireBoard.tsx";
const PICKER = "src/components/solitaire-duel/SolitaireThemePicker.tsx";
const SOLO = "src/components/solitaire-duel/SoloSolitaireGame.tsx";
const MATCH = "src/app/casino/solitaire-duel/[matchId]/PageClient.tsx";
const STANDALONE = "standalone/solitaire-duel/src/App.tsx";
const CARD = "src/components/solitaire-duel/PlayingCard.tsx";

// ── Colour maths (WCAG 2.x) ───────────────────────────────────────────────

const parseColor = (value) => {
  const hex = value.trim();
  if (hex.startsWith("#")) {
    const body = hex.slice(1);
    const full = body.length === 3 ? body.split("").map((c) => c + c).join("") : body;
    return {
      rgb: [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)),
      alpha: 1,
    };
  }
  const rgba = hex.match(/rgba?\(([^)]+)\)/);
  assert.ok(rgba, `unparseable colour: ${value}`);
  const parts = rgba[1].split(",").map((n) => Number.parseFloat(n.trim()));
  return { rgb: parts.slice(0, 3), alpha: parts.length > 3 ? parts[3] : 1 };
};

/** Paint `fg` over an opaque `bg`. */
const over = (fg, bg) => {
  const a = fg.alpha;
  return {
    rgb: fg.rgb.map((c, i) => a * c + (1 - a) * bg.rgb[i]),
    alpha: 1,
  };
};

const channel = (c) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};

const luminance = ({ rgb }) =>
  0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);

const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const WHITE = parseColor("#ffffff");

// ── 1. The catalog ────────────────────────────────────────────────────────

test("catalog: exactly the six documented presets, Classic Green first", () => {
  assert.deepEqual(
    BOARD_THEMES.map((theme) => theme.label),
    ["Classic Green", "Ocean Blue", "Royal Purple", "Midnight", "Warm Copper", "Sand"],
  );
  assert.equal(BOARD_THEMES[0].key, DEFAULT_BOARD_THEME);
  assert.equal(DEFAULT_BOARD_THEME, "classic");
  assert.equal(new Set(BOARD_THEMES.map((t) => t.key)).size, BOARD_THEMES.length, "keys must be unique");
  assert.equal(new Set(BOARD_THEMES.map((t) => t.label)).size, BOARD_THEMES.length, "labels must be unique");
  for (const theme of BOARD_THEMES) {
    assert.match(theme.felt, /gradient\(/, `${theme.key}: the felt must be a gradient`);
    assert.match(theme.base, /^#[0-9a-f]{6}$/i, `${theme.key}: base must be a hex colour`);
    assert.match(theme.frame, /^#[0-9a-f]{6}$/i, `${theme.key}: frame must be a hex colour`);
    assert.ok(theme.blurb && theme.blurb.length > 8, `${theme.key}: needs a blurb`);
  }
});

test("fallback: an unknown, missing or corrupted preference is Classic Green", () => {
  assert.equal(boardThemeFor("sand").key, "sand");
  assert.equal(boardThemeFor(undefined).key, "classic");
  assert.equal(boardThemeFor(null).key, "classic");
  assert.equal(boardThemeFor("").key, "classic");
  assert.equal(boardThemeFor("neon").key, "classic");
  assert.equal(boardThemeFor(42).key, "classic");
  assert.equal(boardThemeFor({ key: "ocean" }).key, "classic");
  assert.equal(boardThemeLabel("nope"), "Classic Green");
  assert.equal(isBoardThemeKey("midnight"), true);
  assert.equal(isBoardThemeKey("Midnight"), false);
});

test("storage: the preference key is versioned and the change event is namespaced", () => {
  assert.equal(BOARD_THEME_STORAGE_KEY, "grynd.solitaire.boardTheme.v1");
  assert.match(BOARD_THEME_STORAGE_KEY, /^grynd\./, "site preference keys share one namespace");
  assert.equal(BOARD_THEME_EVENT, "grynd:solitaire-theme");
});

// ── 2. Contrast ───────────────────────────────────────────────────────────

test("contrast: a white card stands out on every felt", () => {
  for (const theme of BOARD_THEMES) {
    const ratio = contrast(WHITE, parseColor(theme.base));
    assert.ok(
      ratio >= 4.5,
      `${theme.label}: the white card face measures ${ratio.toFixed(2)}:1 against the felt (needs 4.5:1)`,
    );
  }
});

test("contrast: the legend and the legal-move cue stay readable on the felt", () => {
  for (const theme of BOARD_THEMES) {
    const base = parseColor(theme.base);
    const legend = contrast(over(parseColor(theme.legend), base), base);
    assert.ok(legend >= 4.5, `${theme.label}: legend is ${legend.toFixed(2)}:1 (needs 4.5:1)`);

    const legal = contrast(over(parseColor(theme.legal.ink), base), base);
    assert.ok(legal >= 4.5, `${theme.label}: legal-move cue is ${legal.toFixed(2)}:1 (needs 4.5:1)`);
  }
});

test("contrast: the socket hint text is readable on the socket it sits in", () => {
  for (const theme of BOARD_THEMES) {
    const base = parseColor(theme.base);
    const socket = over(parseColor(theme.slot.fill), base);
    const ink = over(parseColor(theme.slot.ink), socket);
    const ratio = contrast(ink, socket);
    assert.ok(
      ratio >= 3,
      `${theme.label}: socket hint is ${ratio.toFixed(2)}:1 against the socket fill (needs 3:1)`,
    );
  }
});

// ── 3. Wiring ─────────────────────────────────────────────────────────────

test("board: the table comes from the theme, not from a hardcoded colour", () => {
  const board = code(BOARD);

  assert.match(board, /import \{ useSolitaireBoardTheme \} from "\.\.\/\.\.\/hooks\/useSolitaireBoardTheme"/);
  assert.match(board, /const \{ theme \} = useSolitaireBoardTheme\(\)/);
  // Themed surfaces are custom properties on the board root...
  for (const token of ["--sol-slot", "--sol-slot-border", "--sol-slot-ink", "--sol-slot-active", "--sol-legal", "--sol-legal-glow", "--sol-legend"]) {
    assert.ok(board.includes(`"${token}"`), `${token} must be set on the board root`);
  }
  assert.match(board, /backgroundImage: theme\.felt/);
  assert.match(board, /boxShadow: `inset 0 0 0 2px \$\{theme\.frame\}/, "the frame must be an inset ring, not a layout border");
  // ...and the empty piles read them instead of the old fixed navy.
  assert.match(board, /border-\[color:var\(--sol-legal\)\]/);
  assert.match(board, /bg-\[color:var\(--sol-slot\)\]/);
  assert.match(board, /text-\[color:var\(--sol-legend\)\]/);
  assert.equal(board.includes("#040d24"), false, "no fixed socket colour may remain");
  assert.equal(board.includes("text-white/45"), false, "the legend must follow the theme");
  // The active theme is observable (a browser check and support both need it).
  assert.match(board, /data-solitaire-theme=\{theme\.key\}/);
});

test("cards: a theme never restyles the cards themselves", () => {
  const card = code(CARD);
  assert.equal(card.includes("--sol-"), false, "PlayingCard must not read any table-theme variable");
  // The card's own palette still comes from the shared tokens.
  for (const token of ["--gr-outline", "--gr-brand-cyan"]) {
    assert.ok(card.includes(token), `the card keeps ${token}`);
  }
});

test("picker: a radiogroup of swatches with a reset, labelled for assistive tech", () => {
  const picker = code(PICKER);
  assert.match(picker, /role="radiogroup"[\s\S]*aria-label="Solitaire table theme"/);
  assert.match(picker, /role="radio"/);
  assert.match(picker, /aria-checked=\{checked\}/);
  assert.match(picker, /data-theme-key=\{option\.key\}/);
  assert.match(picker, /onClick=\{\(\) => setTheme\(option\.key\)\}/);
  // The reset is disabled only when already on the default, and names its target.
  assert.match(picker, /disabled=\{isDefault\}/);
  assert.match(picker, /aria-label=\{`Reset to \$\{defaultLabel\}`\}/);
  // Every preset renders a swatch with its name and a non-colour selection cue.
  assert.match(picker, /option\.label/);
  assert.match(picker, /backgroundImage: option\.felt/);
  assert.match(picker, /✓/);
  // Collapsed by default so the board keeps its height budget.
  assert.match(picker, /<details/);
});

test("modes: solo, daily, practice and ranked all render the one themed board", () => {
  const solo = code(SOLO);
  assert.match(solo, /<SolitaireBoard/, "solo/daily render the shared board");
  assert.match(solo, /<SolitaireThemePicker \/>/, "solo/daily host the selector");

  // Daily reuses SoloSolitaireGame, so it inherits the selector and the theme.
  const daily = code("src/app/daily/PageClient.tsx");
  assert.match(daily, /<SoloSolitaireGame[\s\S]*mode="daily"/);

  // Ranked PvP and practice both go through the match page's shared board.
  assert.match(code(MATCH), /<SolitaireBoard/);
  assert.match(code("src/app/casino/solitaire-duel/play-ai/PageClient.tsx"), /create-ai|play-ai|solitaire-duel/, "practice enters through the same match page");

  // The portal build mounts the same component, so a theme applies there too.
  assert.match(code(STANDALONE), /<SolitaireBoard/);

  // No page paints its own felt: the board owns every table surface.
  for (const path of [SOLO, MATCH, "src/app/solitaire/PageClient.tsx", "src/app/daily/PageClient.tsx"]) {
    assert.equal(code(path).includes("radial-gradient"), false, `${path} must not hardcode a table background`);
  }
});

test("hook: the preference is read through one shared store and persisted locally", () => {
  const hook = code("src/hooks/useSolitaireBoardTheme.ts");
  assert.match(hook, /useSyncExternalStore\(subscribe, getSnapshot, getServerSnapshot\)/);
  assert.match(hook, /localStorage\.setItem\(BOARD_THEME_STORAGE_KEY, next\)/);
  assert.match(hook, /localStorage\.removeItem\(BOARD_THEME_STORAGE_KEY\)/);
  assert.match(hook, /getServerSnapshot[\s\S]*return DEFAULT_BOARD_THEME/, "the server render is always the default");
  // A stored value that is no longer a preset cannot style the board.
  assert.match(hook, /isBoardThemeKey\(raw\) \? raw : DEFAULT_BOARD_THEME/);
});
