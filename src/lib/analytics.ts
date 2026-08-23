// Shared analytics helpers for the signup → first-game marketing funnel.

/** Reads UTM / acquisition params from the current URL (if present). */
export function getAcquisitionParams(): Record<string, string> {
  if (typeof window === "undefined") return {};
  const params = new URLSearchParams(window.location.search);
  const out: Record<string, string> = {};
  for (const key of [
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_term",
    "utm_content",
    "ref",
  ]) {
    const value = params.get(key);
    if (value) out[key] = value;
  }
  return out;
}

/** Human-friendly game name from a PostHog event name. */
export function gameNameFromEvent(eventName: string): string {
  return eventName
    .replace(/_game_started$/, "")
    .replace(/_game_ended$/, "")
    .replace(/_/g, " ")
    .trim();
}

const GAME_STARTED_SUFFIX = "_game_started";

/** True for events that represent a game actually starting (excludes
 * lobby/join events which also end in `_game_started` in a few places —
 * acceptable: the funnel cares about "reached a game screen"). */
export function isGameStartEvent(eventName: string): boolean {
  return eventName.endsWith(GAME_STARTED_SUFFIX);
}
