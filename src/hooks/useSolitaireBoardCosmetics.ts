"use client";

// src/hooks/useSolitaireBoardCosmetics.ts
//
// THE selected CARD BACK and DECK SKIN, shared by every board.
//
// Same shape as `useSolitaireBoardTheme` and for the same reasons: one
// module-level store read through `useSyncExternalStore`, so every mounted board
// repaints together, a change in another tab arrives through `storage`, and a
// guest or an offline tab still renders its choice.
//
// PERSISTENCE IS LOCAL-FIRST. The account columns (`users.equipped_card_back`,
// `users.equipped_deck_skin`) are the authority for ownership and cross-device
// sync; this store is what renders, and the appearance drawer adopts the
// account's values when it loads them. A key that is not in the catalog falls
// back to the default rather than leaving a card blank.

import { useSyncExternalStore } from "react";

import {
  CARD_BACK_DEFAULT,
  DECK_DEFAULT,
  cardBackFor,
  deckSkinFor,
  type CardBack,
  type DeckSkin,
} from "../lib/solitaire-duel/boardCosmetics";

export const BOARD_COSMETICS_STORAGE_KEY = "grynd.solitaire.boardCosmetics.v1";
export const BOARD_COSMETICS_EVENT = "grynd:solitaire-cosmetics";

export type BoardCosmetics = { cardBack: string; deckSkin: string };

const DEFAULT_COSMETICS: BoardCosmetics = {
  cardBack: CARD_BACK_DEFAULT,
  deckSkin: DECK_DEFAULT,
};

const listeners = new Set<() => void>();
let cached: BoardCosmetics | null = null;
let storageBound = false;

function sanitize(value: unknown): BoardCosmetics {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    cardBack: cardBackFor(raw.cardBack).key,
    deckSkin: deckSkinFor(raw.deckSkin).key,
  };
}

function readStored(): BoardCosmetics {
  if (typeof window === "undefined") return DEFAULT_COSMETICS;
  try {
    const raw = window.localStorage.getItem(BOARD_COSMETICS_STORAGE_KEY);
    if (!raw) return DEFAULT_COSMETICS;
    return sanitize(JSON.parse(raw));
  } catch {
    return DEFAULT_COSMETICS;
  }
}

function emit() {
  for (const notify of listeners) notify();
}

function bindStorage() {
  if (storageBound || typeof window === "undefined") return;
  storageBound = true;
  window.addEventListener("storage", (event) => {
    if (event.key !== BOARD_COSMETICS_STORAGE_KEY) return;
    cached = readStored();
    emit();
  });
  window.addEventListener(BOARD_COSMETICS_EVENT, () => {
    cached = readStored();
    emit();
  });
}

function getSnapshot(): BoardCosmetics {
  if (cached === null) cached = readStored();
  return cached;
}

function getServerSnapshot(): BoardCosmetics {
  // The server has no preference; the first client render must match it, and
  // React re-reads the snapshot after hydration.
  return DEFAULT_COSMETICS;
}

function subscribe(notify: () => void): () => void {
  bindStorage();
  listeners.add(notify);
  return () => listeners.delete(notify);
}

/** Persist a choice (unknown keys collapse to the default). */
export function applyBoardCosmetics(next: Partial<BoardCosmetics>): void {
  const merged = sanitize({ ...getSnapshot(), ...next });
  cached = merged;
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(BOARD_COSMETICS_STORAGE_KEY, JSON.stringify(merged));
    } catch {
      // Storage unavailable: the choice still applies for this page view.
    }
    window.dispatchEvent(new Event(BOARD_COSMETICS_EVENT));
  }
  emit();
}

export type UseSolitaireBoardCosmetics = {
  cardBack: CardBack;
  deckSkin: DeckSkin;
  cardBackKey: string;
  deckSkinKey: string;
};

export function useSolitaireBoardCosmetics(): UseSolitaireBoardCosmetics {
  const cosmetics = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return {
    cardBack: cardBackFor(cosmetics.cardBack),
    deckSkin: deckSkinFor(cosmetics.deckSkin),
    cardBackKey: cosmetics.cardBack,
    deckSkinKey: cosmetics.deckSkin,
  };
}
