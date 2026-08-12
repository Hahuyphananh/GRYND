// ── Slot Theme Definitions ──
// Slots is a single 1v1 game — only the "fruit" theme remains (the gems /
// sevens / egyptian skins were removed). The theme's symbol pool is the
// 5-key SVG icon set from `slotIcons.jsx` — the engine matches on these
// stable string keys and the client renders them as inline SVGs (no
// emoji). `getTheme` falls back to "fruit" for unknown ids, so historical
// match rows carrying a removed theme render as Fruit Fortune.

import { SLOT_SYMBOLS } from "./slotIcons.jsx";

export const SLOT_THEMES = {
  fruit: {
    name: "🍒 Fruit Fortune",
    symbols: SLOT_SYMBOLS,
  },
};

/** Look up a theme by id; falls back to "fruit" if unknown. */
export function getTheme(themeId) {
  return SLOT_THEMES[themeId] || SLOT_THEMES.fruit;
}

/** Theme IDs for easy iteration. */
export const THEME_IDS = ["fruit"];
