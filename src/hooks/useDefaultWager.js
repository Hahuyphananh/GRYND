"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const STORAGE_KEY = "grynd.defaultWagers.v1";

/**
 * Drop-in replacement for `useState(defaultWager)` in game pages. Returns
 * [wager, setWager] with the same shape as useState, but the initial value
 * is upgraded to the player's saved default for this game (from
 * /api/user/default-wagers, with a localStorage snapshot for instant paint)
 * as long as the player hasn't already touched the wager control.
 *
 * The setter is wrapped so a saved default never clobbers a value the
 * player (or the game's own logic) already set — once anything calls the
 * setter, the async default is ignored.
 */
export function useDefaultWager(gameKey, fallback) {
  const [wager, setWager] = useState(fallback);
  const touchedRef = useRef(false);

  const setWagerGuarded = useCallback((value) => {
    touchedRef.current = true;
    setWager(value);
  }, []);

  useEffect(() => {
    let cancelled = false;

    const apply = (saved) => {
      if (cancelled || touchedRef.current) return;
      if (typeof saved === "number" && Number.isFinite(saved) && saved > 0) {
        setWager(saved);
      }
    };

    // Instant snapshot from a previous visit, then a server refresh.
    try {
      const cached = window.localStorage.getItem(STORAGE_KEY);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (parsed && typeof parsed[gameKey] === "number") apply(parsed[gameKey]);
      }
    } catch {
      // storage unavailable — fall through to the fetch
    }

    fetch("/api/user/default-wagers", { credentials: "include" })
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        if (data?.success && data.wagers && typeof data.wagers[gameKey] === "number") {
          apply(data.wagers[gameKey]);
          try {
            window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data.wagers));
          } catch {
            // ignore
          }
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [gameKey]);

  return [wager, setWagerGuarded];
}