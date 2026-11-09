/**
 * src/lib/solitaire-duel/boardThemes.ts
 *
 * THE SOLITAIRE TABLE, in six flavours.
 *
 * What a theme paints — and what it deliberately cannot paint:
 *
 *   • the TABLE: the felt behind the cards (a gradient, its edge, its shadow),
 *   • the SLOTS: the empty pile sockets (fill, border, their dim ink),
 *   • the LEGAL-MOVE colour used by those sockets, and
 *   • the LEGEND ink under the board.
 *
 * It does NOT touch the cards. The sheet a face-up card is printed on, the red
 * and black of the pips, the patterned back and the selected/legal outlines on
 * a CARD are all owned by `PlayingCard` and the `--gr-*` token layer. A theme
 * changes the furniture around the cards, never the cards themselves — which is
 * also why a preset cannot make the game unreadable: every felt is dark enough
 * for a white card and every slot/legend colour is checked for contrast in
 * `tests/solitaire-board-themes.test.mjs`.
 *
 * ONE SOURCE OF TRUTH. Solo, Daily, Practice vs AI and Ranked PvP all render
 * the same `<SolitaireBoard>`, and that component reads this catalog through
 * `useSolitaireBoardTheme`. There is no per-mode colour, so the four modes
 * cannot drift apart.
 *
 * The values are plain CSS strings (gradients included) because they are set as
 * custom properties on the board root; `base` mirrors the gradient's mid stop
 * so contrast can be measured in a test without parsing CSS.
 */

export const BOARD_THEME_STORAGE_KEY = "grynd.solitaire.boardTheme.v1";

/** Same-tab notification for a theme change (storage events only cross tabs). */
export const BOARD_THEME_EVENT = "grynd:solitaire-theme";

export type BoardThemeKey =
  | "classic"
  | "ocean"
  | "royal"
  | "midnight"
  | "copper"
  | "sand";

export type BoardTheme = {
  key: BoardThemeKey;
  /** What the selector shows. */
  label: string;
  /** One-line description, used as the radio's title/aria description. */
  blurb: string;
  /** Solid mid tone of the felt — what contrast is measured against. */
  base: string;
  /** The felt itself (CSS `background-image`). */
  felt: string;
  /** The table's own edge, drawn as an inset ring (never a layout border). */
  frame: string;
  /** Empty pile socket. */
  slot: {
    fill: string;
    border: string;
    ink: string;
    /** Filled socket while a held card may be placed there. */
    activeFill: string;
  };
  /** The legal-move cue on an empty pile (and its soft glow). */
  legal: {
    ink: string;
    glow: string;
  };
  /** The one-line legend under the tableau. */
  legend: string;
};

export const DEFAULT_BOARD_THEME: BoardThemeKey = "classic";

/**
 * The presets. Order is the selector's order; Classic is first because it is
 * the default and the reset target.
 */
export const BOARD_THEMES: readonly BoardTheme[] = [
  {
    key: "classic",
    label: "Classic Green",
    blurb: "The traditional card-table green.",
    base: "#0b3d2e",
    felt: "radial-gradient(120% 120% at 50% 0%, #15583f 0%, #0b3d2e 46%, #06251b 100%)",
    frame: "#0a2a20",
    slot: {
      fill: "rgba(3, 24, 18, 0.72)",
      border: "rgba(150, 255, 214, 0.22)",
      ink: "rgba(214, 255, 236, 0.55)",
      activeFill: "rgba(217, 255, 233, 0.12)",
    },
    legal: { ink: "#d9ffe9", glow: "rgba(217, 255, 233, 0.28)" },
    legend: "#cfeee0",
  },
  {
    key: "ocean",
    label: "Ocean Blue",
    blurb: "Deep water, cool and quiet.",
    base: "#0a3554",
    felt: "radial-gradient(120% 120% at 50% 0%, #0f4a72 0%, #0a3554 46%, #061d33 100%)",
    frame: "#072a44",
    slot: {
      fill: "rgba(4, 22, 38, 0.72)",
      border: "rgba(150, 225, 255, 0.22)",
      ink: "rgba(206, 240, 255, 0.55)",
      activeFill: "rgba(205, 239, 255, 0.12)",
    },
    legal: { ink: "#cdefff", glow: "rgba(205, 239, 255, 0.3)" },
    legend: "#cfeeff",
  },
  {
    key: "royal",
    label: "Royal Purple",
    blurb: "Court-velvet purple.",
    base: "#2a1355",
    felt: "radial-gradient(120% 120% at 50% 0%, #3d1f73 0%, #2a1355 46%, #170a30 100%)",
    frame: "#210f45",
    slot: {
      fill: "rgba(14, 7, 33, 0.72)",
      border: "rgba(206, 180, 255, 0.24)",
      ink: "rgba(228, 214, 255, 0.55)",
      activeFill: "rgba(230, 217, 255, 0.12)",
    },
    legal: { ink: "#e6d9ff", glow: "rgba(230, 217, 255, 0.3)" },
    legend: "#e4dcff",
  },
  {
    key: "midnight",
    label: "Midnight",
    blurb: "Almost black, for late-night play.",
    base: "#0b0d18",
    felt: "radial-gradient(120% 120% at 50% 0%, #191c2f 0%, #0b0d18 48%, #050609 100%)",
    frame: "#151827",
    slot: {
      fill: "rgba(3, 4, 8, 0.78)",
      border: "rgba(190, 200, 255, 0.2)",
      ink: "rgba(214, 220, 255, 0.5)",
      activeFill: "rgba(223, 228, 255, 0.1)",
    },
    legal: { ink: "#dfe4ff", glow: "rgba(223, 228, 255, 0.26)" },
    legend: "#d9dff8",
  },
  {
    key: "copper",
    label: "Warm Copper",
    blurb: "A burnished, autumnal table.",
    base: "#42200f",
    felt: "radial-gradient(120% 120% at 50% 0%, #5c2f16 0%, #42200f 46%, #2a1408 100%)",
    frame: "#35190b",
    slot: {
      fill: "rgba(24, 11, 5, 0.72)",
      border: "rgba(255, 196, 148, 0.24)",
      ink: "rgba(255, 224, 196, 0.55)",
      activeFill: "rgba(255, 224, 194, 0.12)",
    },
    legal: { ink: "#ffe0c2", glow: "rgba(255, 224, 194, 0.32)" },
    legend: "#ffdfc4",
  },
  {
    key: "sand",
    label: "Sand",
    blurb: "Sun-baked desert table.",
    base: "#5a472d",
    felt: "radial-gradient(120% 120% at 50% 0%, #7a6140 0%, #5a472d 46%, #3d2f1c 100%)",
    frame: "#4a3a24",
    slot: {
      fill: "rgba(34, 26, 15, 0.72)",
      border: "rgba(255, 236, 194, 0.26)",
      ink: "rgba(255, 240, 210, 0.58)",
      activeFill: "rgba(255, 240, 206, 0.14)",
    },
    legal: { ink: "#fff3d6", glow: "rgba(255, 243, 214, 0.32)" },
    legend: "#ffefd2",
  },
] as const;

const BY_KEY = new Map<string, BoardTheme>(BOARD_THEMES.map((theme) => [theme.key, theme]));

export function isBoardThemeKey(value: unknown): value is BoardThemeKey {
  return typeof value === "string" && BY_KEY.has(value);
}

/**
 * A stored preference is only ever a HINT. Anything unknown — a renamed preset,
 * a corrupted value, a hand-edited localStorage — resolves to Classic Green
 * rather than leaving the board unstyled.
 */
export function boardThemeFor(value: unknown): BoardTheme {
  return BY_KEY.get(typeof value === "string" ? value : "") ?? BY_KEY.get(DEFAULT_BOARD_THEME)!;
}

export function boardThemeLabel(value: unknown): string {
  return boardThemeFor(value).label;
}
