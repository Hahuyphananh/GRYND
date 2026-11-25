"use client";

/**
 * src/hooks/useSolitaireBoardThemeSync.ts
 *
 * CROSS-DEVICE SYNC for the Solitaire table theme.
 *
 * The store in `useSolitaireBoardTheme` stays the single source of truth for
 * rendering, and localStorage stays its cache — so a guest, an offline tab and
 * the standalone portal keep working exactly as before. This hook adds one
 * conversation with the account, mounted once in `SiteChrome`:
 *
 *   1. ON LOAD, ask the account what it has.
 *        • a saved theme → adopt it (the account wins across devices) and
 *          refresh the local cache, so offline play matches;
 *        • no saved theme (NULL) → publish the local choice, so a guest's
 *          selection follows the player into the account instead of being lost.
 *      A change the player makes WHILE that request is in flight wins over the
 *      server value and is pushed instead — a slow network must not revert a
 *      choice the player just made.
 *
 *   2. ON EVERY CHANGE (picker, reset, another tab via the storage event),
 *      PUT the resolved key. The last pushed key is remembered so adopting the
 *      server value does not echo straight back as a write.
 *
 * Failure is always local-first: a 404 (the standalone portal has no Next API),
 * an offline tab or a signed-out visitor all leave the local preference
 * authoritative and the board keeps its theme. The portal never mounts this
 * hook — it lives in SiteChrome, which the portal build does not use.
 */

import { useEffect, useRef } from "react";

import {
  isBoardThemeKey,
  type BoardThemeKey,
} from "../lib/solitaire-duel/boardThemes";
import {
  getStoredBoardTheme,
  hasPendingBoardThemeSync,
  markBoardThemeSyncPending,
  setStoredBoardTheme,
  useSolitaireBoardTheme,
} from "./useSolitaireBoardTheme";

const ENDPOINT = "/api/solitaire/board-theme";

/** The newest push wins: an older response must not clear a newer pending flag. */
let pushSeq = 0;

async function pushTheme(theme: BoardThemeKey): Promise<void> {
  const seq = (pushSeq += 1);
  // The choice is not the account's until the account says so. If this request
  // fails — or the tab closes mid-flight — the next load retries it instead of
  // adopting a server value that is older than the local pick.
  markBoardThemeSyncPending(true);
  try {
    const res = await fetch(ENDPOINT, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ theme }),
    });
    if (seq === pushSeq && res.ok) markBoardThemeSyncPending(false);
  } catch {
    // Offline / portal / signed out: the choice already applied locally, and the
    // pending flag keeps the newest local pick ahead of an older server value.
    // The next change (or the next page load) retries; nothing is lost.
  }
}

export function useSolitaireBoardThemeSync(): void {
  const { themeKey } = useSolitaireBoardTheme();
  /** The theme as it was before the first request, to detect a concurrent pick. */
  const initialTheme = useRef<BoardThemeKey>(themeKey);
  const signedIn = useRef(false);
  const ready = useRef(false);
  const lastSynced = useRef<BoardThemeKey | null>(null);

  // ── 1. Hydrate from the account, once ──────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch(ENDPOINT, { cache: "no-store", credentials: "same-origin" });
        if (!res.ok) return; // no API here (portal) / server error: stay local
        const data = (await res.json().catch(() => null)) as
          | { signedIn?: unknown; theme?: unknown }
          | null;
        if (cancelled || data?.signedIn !== true) return;

        signedIn.current = true;
        ready.current = true;

        // The player picked a table while we were asking — or made one in an
        // earlier session that never reached the account (offline, failed
        // write): their newest choice beats the stored one, and becomes the
        // account's value.
        const current = getStoredBoardTheme();
        if (current !== initialTheme.current || hasPendingBoardThemeSync()) {
          lastSynced.current = current;
          await pushTheme(current);
          return;
        }

        if (isBoardThemeKey(data.theme)) {
          lastSynced.current = data.theme;
          // Adopting the account's theme also refreshes the local cache.
          setStoredBoardTheme(data.theme);
          markBoardThemeSyncPending(false);
          return;
        }

        // No saved choice yet: upload the local one (guest → account).
        lastSynced.current = current;
        await pushTheme(current);
      } catch {
        // Offline: local persistence remains authoritative.
      }
    })();

    return () => {
      cancelled = true;
    };
    // Mount-only on purpose: this is a one-time reconciliation, not a
    // subscription (the push effect below handles every later change).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── 2. Push every later change ─────────────────────────────────────────
  useEffect(() => {
    if (!ready.current || !signedIn.current) return;
    if (lastSynced.current === themeKey) return;
    lastSynced.current = themeKey;
    void pushTheme(themeKey);
  }, [themeKey]);
}
