// src/lib/recentlyPlayed.js
//
// Client-side "Recently played" tracking for the casino lobby (UX plan
// P1-1). Games record a play when their real game session starts — either
// through the shared <GameSessionHost /> autoStart or, for game pages that
// don't mount it, directly via the useRecordPlayedGame hook — and the
// lobby renders the most recent ones as a "Play again" strip.
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
 *  first, deduped, capped at MAX_RECENT. Also fires the server-side
 *  per-game counter (/api/game-plays) that powers the lobby's "Most
 *  Played" sort — same real "session started" signal, best-effort and
 *  fire-and-forget so it can never block or break the game start. */
export function recordPlayedGame(gameLabel) {
  if (!gameLabel || typeof gameLabel !== "string") return;
  const next = [gameLabel, ...parse(readRaw()).filter((k) => k !== gameLabel)];
  writeRaw(next.slice(0, MAX_RECENT));

  // Server-side play counter (casino lobby "Most Played"). Non-blocking:
  // failures are ignored — recently-played and the game itself don't
  // depend on this. Deduped per edge (autoStart flips once per session).
  try {
    fetch("/api/game-plays", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ gameLabel }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    // fetch unavailable — skip the counter entirely
  }
}

/** Most-recently-played game labels, newest first. */
export function getPlayedGames() {
  return parse(readRaw());
}

/** Clear the recently-played history (used by any "clear" affordance). */
export function clearPlayedGames() {
  writeRaw([]);
}