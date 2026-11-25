"use client";

// src/components/lobby/PlatformQuickQueue.jsx
//
// The platform quick-queue toggle used to sit inside the shared PvP lobby and
// match players across the catalogue. GRYND is Solitaire-only and Solitaire
// Duel matchmaking does not use the quick queue, so the hook is intentionally
// inert: the lobby's toggle block is never rendered (`hasGames: false`) and
// nothing calls the removed queue APIs.

export function usePlatformQuickQueue() {
  return {
    hasGames: false,
    ready: false,
    busy: false,
    error: null,
    onToggle: () => {},
    disabled: true,
    label: "",
    preferences: null,
    emptySelection: true,
    notification: null,
  };
}

export default usePlatformQuickQueue;
