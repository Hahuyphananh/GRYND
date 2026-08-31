// src/lib/creator-mode/client.ts
//
// Client-side transport helpers for passing creator-mode state from the
// lobby into a game (and onward into a match page).
//
// Transport design:
//   1. The lobby appends `?creator=1` to game links when creator mode
//      is enabled — visible, testable, survives reloads.
//   2. The game page (CreatorModeProvider) persists the flag to
//      sessionStorage keyed by user id, so subsequent in-app
//      navigations (e.g. lobby page → /[matchId] match page via
//      router.push) keep the mode active even though those links don't
//      carry the query param.
//
// These helpers are shared by the lobby toggle and the game provider so
// the key names and parsing rules live in exactly one place.

import {
  CREATOR_DIMENSIONS_STORAGE_PREFIX,
  CREATOR_MODE_PARAM,
  CREATOR_MODE_PARAM_ON,
  CREATOR_MODE_STORAGE_PREFIX,
  DEFAULT_CREATOR_DIMENSIONS,
  sanitizeDimensions,
  type CreatorModeDimensions,
} from "./types";

/** True when a URL search string carries the creator-mode flag. */
export function isCreatorModeSearch(search: string): boolean {
  if (!search) return false;
  return new URLSearchParams(search).get(CREATOR_MODE_PARAM) === CREATOR_MODE_PARAM_ON;
}

/**
 * Append (or remove) the creator-mode query param from a path/URL.
 * Preserves any existing query params. Used by the lobby to decorate
 * every game card link while the mode is on.
 */
export function buildCreatorHref(href: string, enabled: boolean): string {
  const [path, existingSearch = ""] = href.split("?");
  const params = new URLSearchParams(existingSearch);
  if (enabled) {
    params.set(CREATOR_MODE_PARAM, CREATOR_MODE_PARAM_ON);
  } else {
    params.delete(CREATOR_MODE_PARAM);
  }
  const search = params.toString();
  return search ? `${path}?${search}` : path;
}

function storageKey(userId: string): string {
  return `${CREATOR_MODE_STORAGE_PREFIX}${userId}`;
}

/** Read the persisted creator-mode flag for a user (sessionStorage). */
export function getStoredCreatorMode(userId: string | null | undefined): boolean {
  if (!userId) return false;
  try {
    return window.sessionStorage.getItem(storageKey(userId)) === CREATOR_MODE_PARAM_ON;
  } catch {
    return false;
  }
}

/** Persist the creator-mode flag for a user (sessionStorage). */
export function setStoredCreatorMode(
  userId: string | null | undefined,
  enabled: boolean,
): void {
  if (!userId) return;
  try {
    if (enabled) {
      window.sessionStorage.setItem(storageKey(userId), CREATOR_MODE_PARAM_ON);
    } else {
      window.sessionStorage.removeItem(storageKey(userId));
    }
  } catch {
    // storage unavailable — mode simply won't persist across navigations
  }
}

function dimsKey(userId: string): string {
  return `${CREATOR_DIMENSIONS_STORAGE_PREFIX}${userId}`;
}

/** Read the persisted recording dimensions for a user, or the default. */
export function getStoredCreatorDimensions(
  userId: string | null | undefined,
): CreatorModeDimensions {
  if (!userId) return DEFAULT_CREATOR_DIMENSIONS;
  try {
    const raw = window.sessionStorage.getItem(dimsKey(userId));
    if (raw) {
      const parsed = JSON.parse(raw);
      const width = Number(parsed?.width);
      const height = Number(parsed?.height);
      if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
        const { width: w, height: h } = sanitizeDimensions(width, height);
        const preset =
          parsed?.preset === "custom" ||
          parsed?.preset === "9:16" ||
          parsed?.preset === "16:9" ||
          parsed?.preset === "1:1"
            ? parsed.preset
            : "custom";
        return { preset, width: w, height: h };
      }
    }
  } catch {
    // corrupt storage — fall back to default
  }
  return DEFAULT_CREATOR_DIMENSIONS;
}

/** Persist the recording dimensions for a user (sessionStorage). */
export function setStoredCreatorDimensions(
  userId: string | null | undefined,
  dimensions: CreatorModeDimensions,
): void {
  if (!userId) return;
  try {
    window.sessionStorage.setItem(dimsKey(userId), JSON.stringify(dimensions));
  } catch {
    // ignore — dimensions just won't persist across navigations
  }
}
