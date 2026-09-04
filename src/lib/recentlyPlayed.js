// src/lib/recentlyPlayed.js
//
// Client-side "Recently played" tracking for the casino lobby (UX plan
// P1-1). Games record a play when their real game session starts (via the
// shared <CreatorModeHost />, which every game page already mounts), and
// the lobby renders the most recent ones as a "Play again" strip.
//
// Storage is sessionStorage (per browser session — a returning player on
// a fresh tab starts clean), keyed per app with a version suffix so the
// shape can evolve without stale-data bugs. All access is guarded:
// sessionStorage can throw (private mode / disabled), and this module is
// imported by server-rendered code paths too.

"use client";

const STORAGE_KEY = "grynd.recentlyPlayed.v1";
const MAX_RECENT = 10;

function readRaw() {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeRaw(list) {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    // Storage unavailable — recently-played is best-effort chrome.
  }
}

function parse(raw) {
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list)
      ? list.filter((item) => typeof item === "string" && item.length > 0)
      : [];
  } catch {
    return [];
  }
}

/** Record a game play (gameLabel key, e.g. "plinko-duel"). Most recent
 *  first, deduped, capped at MAX_RECENT. */
export function recordPlayedGame(gameLabel) {
  if (!gameLabel || typeof gameLabel !== "string") return;
  const next = [gameLabel, ...parse(readRaw()).filter((k) => k !== gameLabel)];
  writeRaw(next.slice(0, MAX_RECENT));
}

/** Most-recently-played game labels, newest first. */
export function getPlayedGames() {
  return parse(readRaw());
}

/** Clear the recently-played history (used by any "clear" affordance). */
export function clearPlayedGames() {
  writeRaw([]);
}