"use client";

/**
 * src/hooks/useSolitaireBoardTheme.ts
 *
 * THE selected Solitaire table theme, shared by every board and the picker.
 *
 * One module-level store, read through `useSyncExternalStore`, so:
 *
 *   • the board and the selector can never disagree (no prop drilling, no
 *     context provider to forget on a route),
 *   • the store notifies every mounted board in the same tab instantly, and
 *   • a change in another tab arrives through the `storage` event.
 *
 * PERSISTENCE IS LOCAL-FIRST. This store is the cache: it is what renders, and
 * it is all a guest, an offline tab or the standalone portal has. Signed-in
 * players additionally get cross-device sync from
 * `useSolitaireBoardThemeSync` (mounted once in SiteChrome), which adopts the
 * account's column (`users.solitaire_board_theme`) and uploads every change.
 * The stored key is versioned and anything unreadable falls back to Classic
 * Green.
 */

import { useCallback, useSyncExternalStore } from "react";

import {
  BOARD_THEMES,
  BOARD_THEME_EVENT,
  BOARD_THEME_STORAGE_KEY,
  DEFAULT_BOARD_THEME,
  boardThemeFor,
  isBoardThemeKey,
  type BoardTheme,
  type BoardThemeKey,
} from "../lib/solitaire-duel/boardThemes";

const listeners = new Set<() => void>();

/** Local choice not yet confirmed by the account (see markBoardThemeSyncPending). */
const BOARD_THEME_PENDING_KEY = "grynd.solitaire.boardTheme.pending.v1";

/** Resolved once per tab; `null` means "not read from storage yet". */
let cached: BoardThemeKey | null = null;
let storageBound = false;

function readStored(): BoardThemeKey {
  if (typeof window === "undefined") return DEFAULT_BOARD_THEME;
  try {
    const raw = window.localStorage.getItem(BOARD_THEME_STORAGE_KEY);
    // A stored value that is no longer a preset is treated as absent.
    return isBoardThemeKey(raw) ? raw : DEFAULT_BOARD_THEME;
  } catch {
    // Storage disabled (private mode, quota, blocked cookies): the default.
    return DEFAULT_BOARD_THEME;
  }
}

function emit() {
  for (const notify of listeners) notify();
}

function bindStorage() {
  if (storageBound || typeof window === "undefined") return;
  storageBound = true;
  window.addEventListener("storage", (event) => {
    if (event.key !== BOARD_THEME_STORAGE_KEY) return;
    cached = readStored();
    emit();
  });
  // A same-tab write from a non-React caller (or another copy of the module in
  // a different bundle chunk) is picked up here.
  window.addEventListener(BOARD_THEME_EVENT, () => {
    cached = readStored();
    emit();
  });
}

function getSnapshot(): BoardThemeKey {
  if (cached === null) cached = readStored();
  return cached;
}

/**
 * The theme the board is currently using. Exposed for the sync hook, which
 * needs to tell "the player changed it while we were asking the server" from
 * "nothing happened" without re-subscribing.
 */
export function getStoredBoardTheme(): BoardThemeKey {
  return getSnapshot();
}

function getServerSnapshot(): BoardThemeKey {
  // The server has no preference to read, and the first client render must agree
  // with the server markup; React re-reads the snapshot after hydration.
  return DEFAULT_BOARD_THEME;
}

function subscribe(notify: () => void): () => void {
  bindStorage();
  listeners.add(notify);
  return () => {
    listeners.delete(notify);
  };
}

/** Persist a preset. Unknown keys collapse to Classic Green instead of failing. */
export function setStoredBoardTheme(value: unknown): void {
  const next = boardThemeFor(value).key;
  cached = next;
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(BOARD_THEME_STORAGE_KEY, next);
    } catch {
      // Storage unavailable: the choice still applies for this page view.
    }
    window.dispatchEvent(new Event(BOARD_THEME_EVENT));
  }
  emit();
}

/** Forget the preference: back to the default, with nothing left in storage. */
export function resetStoredBoardTheme(): void {
  cached = DEFAULT_BOARD_THEME;
  if (typeof window !== "undefined") {
    try {
      window.localStorage.removeItem(BOARD_THEME_STORAGE_KEY);
    } catch {
      // ignore
    }
    window.dispatchEvent(new Event(BOARD_THEME_EVENT));
  }
  emit();
}

/**
 * Is there a local choice the account has not accepted yet?
 *
 * Written by the sync hook when a push fails (offline, server error) or is in
 * flight. It is what stops a later load from adopting an OLDER server value
 * over a newer local pick: while this is set, the local choice is pushed first
 * and only the account's confirmation clears it.
 */
export function hasPendingBoardThemeSync(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(BOARD_THEME_PENDING_KEY) === "1";
  } catch {
    return false;
  }
}

/** Mark the local choice as not-yet-accepted by the account (or accepted). */
export function markBoardThemeSyncPending(pending: boolean): void {
  if (typeof window === "undefined") return;
  try {
    if (pending) window.localStorage.setItem(BOARD_THEME_PENDING_KEY, "1");
    else window.localStorage.removeItem(BOARD_THEME_PENDING_KEY);
  } catch {
    // Storage unavailable: sync still works for this page view, it just cannot
    // remember that a retry is owed.
  }
}

export type UseSolitaireBoardTheme = {
  theme: BoardTheme;
  themeKey: BoardThemeKey;
  themes: readonly BoardTheme[];
  setTheme: (key: unknown) => void;
  reset: () => void;
  isDefault: boolean;
};

export function useSolitaireBoardTheme(): UseSolitaireBoardTheme {
  const themeKey = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const setTheme = useCallback((key: unknown) => setStoredBoardTheme(key), []);
  const reset = useCallback(() => resetStoredBoardTheme(), []);

  return {
    theme: boardThemeFor(themeKey),
    themeKey,
    themes: BOARD_THEMES,
    setTheme,
    reset,
    isDefault: themeKey === DEFAULT_BOARD_THEME,
  };
}
