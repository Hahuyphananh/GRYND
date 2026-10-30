"use client";

// src/components/game/emotes/useEmoteLoadout.ts
//
// Shared state for the GRYND emote layer: the player's equipped loadout
// (server-authoritative, DB-backed) and the local send/mute settings.
//
// Extracted from the old EmotePicker so EmoteBar, EmoteWheel and
// GameEmoteLayer all read ONE loadout fetch instead of mounting their own.
//
// Nothing here decides what an emote looks like: the payload stays a stable
// `{ key, kind, value }` object and artwork is resolved through the
// allow-listed catalog in src/lib/emoteAssets.ts.

import { useCallback, useEffect, useMemo, useState } from "react";

/** A permanent text emote (GG / NICE MOVE). Never part of the 9-slot loadout. */
export type WordEmote = {
  id: string;
  key: string;
  kind: "word";
  label: string;
  value: string;
};

/** An equipped animated emote, resolved to its official catalog key. */
export type AnimatedEmote = {
  id: string;
  key: string;
  kind: "animated";
  label: string;
  value: string;
};

export type EmoteChoice = WordEmote | AnimatedEmote;

/**
 * What crosses the wire and what `useGameEmotes` holds. Kept loose (all
 * optional) because it arrives from a socket and from a JS hook, and because
 * games store it in their own loosely-typed state.
 */
export type EmotePayload = {
  id?: string;
  key?: string;
  kind?: string;
  label?: string;
  value?: string;
} | null;

/**
 * Permanent text system emotes. Always available to everyone, visually distinct
 * from the animated pins, and intentionally NOT part of the DB loadout.
 */
export const PERMANENT_TEXT_EMOTES: WordEmote[] = [
  { id: "gg", key: "gg", label: "GG", value: "GG", kind: "word" },
  {
    id: "nice-move",
    key: "nice-move",
    label: "Nice Move",
    value: "NICE MOVE",
    kind: "word",
  },
];

/** Quick-bar slots (2 words + this many pins). The wheel shows the full set. */
export const EMOTE_SLOT_COUNT = 6;

/** Minimum gap between two emotes a player can send, enforced in the UI. */
export const EMOTE_COOLDOWN_MS = 2500;

const SETTINGS_KEY = "grynd:emotes:settings";

export type EmoteSettings = {
  sendEnabled: boolean;
  muteOpponent: boolean;
};

// ── Loadout fetching ──────────────────────────────────────────────────────
// One lightweight fetch per page (never per popup-open). The module-level
// promise dedupes concurrent mounts, and the window "emotesUpdated" event
// invalidates it after a profile-page loadout save.
type EmoteStatePayload = { emotes?: unknown[]; equippedEmotes?: unknown[] } | null;

let emotesRequestPromise: Promise<EmoteStatePayload> | null = null;

function requestEquippedEmotes(): Promise<EmoteStatePayload> {
  if (!emotesRequestPromise) {
    emotesRequestPromise = fetch("/api/user/emotes", {
      credentials: "include",
      cache: "no-store",
    })
      .then((res) => res.json())
      .then((data) => (data && data.success === true ? data : null))
      .catch(() => null)
      .finally(() => {
        // Reset AFTER settling so late subscribers still get the payload
        // through the promise chain above.
        setTimeout(() => {
          emotesRequestPromise = null;
        }, 0);
      });
  }
  return emotesRequestPromise;
}

/** Forget the cached loadout (call after saving on the profile page). */
export function invalidateEmoteLoadoutCache(): void {
  emotesRequestPromise = null;
}

type CatalogEntry = { key?: string; name?: string };

/**
 * The player's equipped emotes, in loadout order, as `EmoteChoice`s.
 *
 * Signed-out players (or a failed request) get an empty list — GG and NICE
 * MOVE keep working on their own.
 */
export function useEmoteLoadout() {
  const [state, setState] = useState<{
    emotes: CatalogEntry[];
    equippedEmotes: string[];
  } | null>(null);

  useEffect(() => {
    let cancelled = false;

    const apply = (data: EmoteStatePayload) => {
      if (cancelled || !data) return;
      setState({
        emotes: Array.isArray(data.emotes) ? (data.emotes as CatalogEntry[]) : [],
        equippedEmotes: Array.isArray(data.equippedEmotes)
          ? (data.equippedEmotes as string[])
          : [],
      });
    };

    void requestEquippedEmotes().then(apply);

    const handleUpdated = () => {
      invalidateEmoteLoadoutCache();
      void requestEquippedEmotes().then(apply);
    };
    window.addEventListener("emotesUpdated", handleUpdated);

    return () => {
      cancelled = true;
      window.removeEventListener("emotesUpdated", handleUpdated);
    };
  }, []);

  const equipped = useMemo<AnimatedEmote[]>(() => {
    const catalogByKey = new Map(
      (state?.emotes || []).map((entry) => [entry.key, entry]),
    );
    return (state?.equippedEmotes || [])
      .map((key) => catalogByKey.get(key))
      .filter((entry): entry is CatalogEntry => Boolean(entry?.key))
      .map((entry) => ({
        id: entry.key as string,
        key: entry.key as string,
        kind: "animated" as const,
        label: entry.name || (entry.key as string),
        value: entry.name || (entry.key as string),
      }));
  }, [state]);

  /** Words first, then equipped pins — the order every surface renders. */
  const choices = useMemo<EmoteChoice[]>(
    () => [...PERMANENT_TEXT_EMOTES, ...equipped],
    [equipped],
  );

  return {
    choices,
    equippedCount: equipped.length,
    loading: state === null,
    hasLoadout: equipped.length > 0,
  };
}

// ── Local send/mute settings ─────────────────────────────────────────────
/**
 * Device-local emote preferences, persisted exactly as before under
 * `grynd:emotes:settings`. They are deliberately local: muting an opponent is
 * about this device's experience, not about their account.
 */
export function useEmoteSettings() {
  const [settings, setSettings] = useState<EmoteSettings>({
    sendEnabled: true,
    muteOpponent: false,
  });
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
      setSettings({
        sendEnabled: saved.sendEnabled !== false,
        muteOpponent: saved.muteOpponent === true,
      });
    } catch {
      // Corrupt/absent settings keep the defaults.
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      // Private mode / quota: settings simply don't persist.
    }
  }, [settings, hydrated]);

  const toggleSend = useCallback(
    () =>
      setSettings((current) => ({
        ...current,
        sendEnabled: !current.sendEnabled,
      })),
    [],
  );
  const toggleMute = useCallback(
    () =>
      setSettings((current) => ({
        ...current,
        muteOpponent: !current.muteOpponent,
      })),
    [],
  );

  return { ...settings, toggleSend, toggleMute };
}
