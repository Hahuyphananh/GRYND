// src/components/last-run/inputKeys.ts
//
// Pure control logic for LAST RUN — no React, no DOM.
//
// The hook (useRunInput) owns listeners and pointer capture; this module owns
// the decisions that are worth testing: which key is which control, when a key
// belongs to a text field instead of the game, and what a press/release does to
// the held state. Keeping it here means the mapping can be tested in Node.

export type RunControl = "jump" | "duck";

export type RunInputState = { jump: boolean; duck: boolean };

export const NEUTRAL_INPUT: RunInputState = Object.freeze({ jump: false, duck: false });

/**
 * Space and Arrow Up jump; Arrow Down ducks.
 *
 * Only the physical key `code` is read, so a layout remap of the printed key
 * cannot silently break the controls.
 */
export function controlForKey(code: string): RunControl | null {
  if (code === "Space" || code === "ArrowUp") return "jump";
  if (code === "ArrowDown") return "duck";
  return null;
}

/**
 * Is the event aimed at something that legitimately uses Space/arrows?
 *
 * A chat box, a search field or a contenteditable must keep its own keys; the
 * game must never preventDefault inside them.
 */
export function isEditableTarget(tagName: string, isContentEditable: boolean): boolean {
  if (isContentEditable) return true;
  const tag = (tagName || "").toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/**
 * Apply one control edge. Returns the same object when nothing changed, which
 * is what keeps duplicate events from becoming duplicate network requests.
 */
export function setHeld(
  current: RunInputState,
  control: RunControl,
  pressed: boolean,
): { state: RunInputState; changed: boolean } {
  if (current[control] === pressed) return { state: current, changed: false };
  return { state: { ...current, [control]: pressed }, changed: true };
}

/** Release everything (blur, tab hide, pointer cancel). */
export function releasedState(): RunInputState {
  return { ...NEUTRAL_INPUT };
}
