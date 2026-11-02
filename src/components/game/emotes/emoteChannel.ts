"use client";

// src/components/game/emotes/emoteChannel.ts
//
// The bridge between a match page and the global chat widget.
//
// The emote picker now lives INSIDE the chat (bottom-left), which is mounted
// once in the root layout — outside the match page's React tree. The send
// function, however, belongs to the match: it travels over the game's own
// socket event via `useGameEmotes`, so it can only be known by the page.
//
// So the match page PUBLISHES its send function here (GameEmoteLayer does it
// on mount) and the chat SUBSCRIBES to it. One active match at a time, which
// is exactly what a match page is.
//
// Nothing about emote appearance or validation lives here: this module only
// carries a callback.

import { useSyncExternalStore } from "react";
import type { EmoteChoice } from "./useEmoteLoadout";

export type EmoteChannel = {
  /** Which game is currently mounted, e.g. "dominoes". */
  gameId: string;
  /** Opponent display name, used to label their bubble. */
  opponentLabel: string | null;
  /** Sends one emote over the match's existing socket event. */
  send: (emote: EmoteChoice) => void;
};

let activeChannel: EmoteChannel | null = null;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

/** Publish the mounted match's sender. Returns the unregister function. */
export function registerEmoteChannel(channel: EmoteChannel): () => void {
  activeChannel = channel;
  notify();
  return () => {
    // Only clear if we are still the active one: a page with two layers
    // (e.g. keno's mobile + desktop mounts) must not unregister the other.
    if (activeChannel === channel) {
      activeChannel = null;
      notify();
    }
  };
}

/** The sender of the match currently on screen, or null outside a match. */
export function getEmoteChannel(): EmoteChannel | null {
  return activeChannel;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// Server render has no match mounted: the chat must render the same markup on
// both sides of hydration, so the snapshot is a constant.
const getServerChannel = () => null;

/** Reactive form for React surfaces (the chat tray). */
export function useActiveEmoteChannel(): EmoteChannel | null {
  return useSyncExternalStore(subscribe, getEmoteChannel, getServerChannel);
}
