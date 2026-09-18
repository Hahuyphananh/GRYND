"use client";

// aiSettings.ts — the player's Pool Masters AI difficulty preference.
//
// The AI's shot planner runs entirely on the client (see `ai.ts`), so the level
// it plays at is a DEVICE preference, stored in localStorage and read back when
// an AI match mounts — the lobby that starts the match knows nothing about it.
// The tiers themselves live in `AI_DIFFICULTY`; this module only owns the
// choice, and falls back to `normal` when nothing (or garbage) is stored.

import {
  AI_DIFFICULTY,
  AiDifficulty,
  DEFAULT_AI_DIFFICULTY,
  isAiDifficulty,
  potQualityBar,
} from "./ai";

const STORAGE_KEY = "grynd_pool_ai_difficulty";

let difficulty: AiDifficulty | null = null; // null = not yet read from storage
const listeners = new Set<() => void>();

function readStorage(): AiDifficulty | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return isAiDifficulty(raw) ? raw : null;
  } catch {
    return null;
  }
}

function notify() {
  for (const fn of [...listeners]) fn();
}

/** The difficulty the AI should play at. Defaults to `normal`. */
export function getAiDifficulty(): AiDifficulty {
  if (difficulty === null) difficulty = readStorage() ?? DEFAULT_AI_DIFFICULTY;
  return difficulty;
}

/** Set the AI difficulty (persisted to localStorage). */
export function setAiDifficulty(value: AiDifficulty): void {
  if (!isAiDifficulty(value) || value === difficulty) return;
  difficulty = value;
  try {
    window.localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // storage unavailable — keep the in-memory state
  }
  notify();
}

/** Display name for a tier, for the picker and the status line. */
export function aiDifficultyLabel(value: AiDifficulty): string {
  return `${value[0].toUpperCase()}${value.slice(1)}`;
}

/**
 * What a tier actually changes, spelled out for the picker's tooltip and the
 * status line: how far the aim drifts at the contact point, the lowest
 * percentage pot it is willing to take on, and how many shots it tries.
 */
export function aiDifficultyHint(value: AiDifficulty): string {
  const tier = AI_DIFFICULTY[value];
  return `aim drifts ±${tier.aimError} units · takes shots from ${Math.round(
    potQualityBar(tier.caution) * 100,
  )}% · tries ${tier.maxSimulations} shots`;
}

/** Subscribe to difficulty changes; returns an unsubscribe function. */
export function subscribeAiDifficulty(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

// Keep multiple open tabs in sync — localStorage fires `storage` on every tab
// except the one that changed.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key !== STORAGE_KEY) return;
    difficulty = isAiDifficulty(e.newValue) ? e.newValue : DEFAULT_AI_DIFFICULTY;
    notify();
  });
}
