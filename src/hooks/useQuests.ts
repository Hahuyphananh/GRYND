"use client";

// src/hooks/useQuests.ts
//
// The client state for the quest board on /rewards.
//
// ── Server-owned, always ───────────────────────────────────────────────────
//
// This hook never decides whether a quest is complete, how much it pays, or
// what the player's progress is. It reads `/api/quests`, asks
// `/api/quests/claim` with ONE value (the quest id), and renders what the server
// returns. There is no local progress arithmetic and no optimistic credit: a
// claim that the server refuses simply re-reads the truth.
//
// ── Why `no-store` ─────────────────────────────────────────────────────────
//
// The shared CsrfFetchGuard serves GET /api/* responses from a short in-memory
// cache. A board read fired straight after a claim would then be answered with
// the PRE-claim board (the same bug the daily reward hit), so a read that must
// reflect a write is requested with `cache: "no-store"`.
//
// ── Balance ────────────────────────────────────────────────────────────────
//
// A successful claim returns the canonical balance from the server, and the
// hook announces the change so every mounted `useCoinBalance()` reader (the
// navbar, lobby pickers, the /rewards header) re-reads. There is still exactly
// one balance source of truth: `users.balance`, read through the existing
// endpoints.

import { useCallback, useEffect, useState } from "react";
import { useUser } from "@clerk/nextjs";
import { notifyCoinBalanceChanged } from "./useCoinBalance";
import { useTranslation } from "./useTranslation";

export type QuestView = {
  id?: number;
  periodType: "daily" | "weekly";
  periodKey: string;
  slot: number;
  definitionId: string | null;
  objective: "pvp_matches" | "pvp_wins" | "pvp_games";
  gameKey: string | null;
  title: string;
  description: string;
  target: number;
  progress: number;
  reward: number;
  completed: boolean;
  claimed: boolean;
  claimable: boolean;
};

export type QuestBoardState = {
  daily: QuestView[];
  weekly: QuestView[];
  balance: number;
  periodKeys: { daily: string; weekly: string };
  resets: {
    dailyStart: string;
    dailyEnd: string;
    weeklyStart: string;
    weeklyEnd: string;
  };
};

export type UseQuests = {
  /** True once Clerk has resolved the session (signed in OR out). */
  isLoaded: boolean;
  isSignedIn: boolean;
  board: QuestBoardState | null;
  /** A board read is in flight. */
  loading: boolean;
  /** The id of the quest currently being claimed, or null. */
  claimingId: number | null;
  /** The last successful claim made on this mount, for the confirmation. */
  claimedNow: { id: number; amount: number } | null;
  /** A read or claim failure, already phrased for display. */
  error: string | null;
  /** Re-read the board. */
  load: () => Promise<void>;
  /** Claim one quest. Returns what was credited, or 0 when refused. */
  claim: (questId: number) => Promise<number>;
};

export type UseQuestsOptions = {
  /**
   * Re-read on focus / visibility / bfcache restore. On by default — a page the
   * player returns to should show the progress the match they just played
   * produced. The navbar's quest badge turns it OFF: it mounts on every page, so
   * a page mount is already a fresh read and a board read per alt-tab is not
   * worth it there (a claim announces itself through the balance event instead).
   */
  autoRefresh?: boolean;
};

export function useQuests({ autoRefresh = true }: UseQuestsOptions = {}): UseQuests {
  const { isLoaded, isSignedIn } = useUser();
  const [board, setBoard] = useState<QuestBoardState | null>(null);
  const [loading, setLoading] = useState(true);
  const [claimingId, setClaimingId] = useState<number | null>(null);
  const [claimedNow, setClaimedNow] = useState<{ id: number; amount: number } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  const applyBoard = useCallback((json: any) => {
    if (!json) return;
    setBoard({
      daily: Array.isArray(json.daily) ? json.daily : [],
      weekly: Array.isArray(json.weekly) ? json.weekly : [],
      balance: Number(json.balance ?? 0),
      periodKeys: json.periodKeys ?? { daily: "", weekly: "" },
      resets: json.resets ?? {
        dailyStart: "",
        dailyEnd: "",
        weeklyStart: "",
        weeklyEnd: "",
      },
    });
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/quests", { cache: "no-store" });
      const json = await res.json().catch(() => null);
      if (res.ok && json?.success) {
        applyBoard(json);
      } else if (res.status !== 401) {
        setError("We couldn't load your quests.");
      }
    } catch {
      setError("We couldn't load your quests.");
    } finally {
      setLoading(false);
    }
  }, [applyBoard]);

  useEffect(() => {
    if (!isLoaded) return;
    if (!isSignedIn) {
      setLoading(false);
      setBoard(null);
      return;
    }
    void load();
  }, [isLoaded, isSignedIn, load]);

  // A match settled on another page is what moves progress, so a return to this
  // tab (or a bfcache restore) re-reads instead of showing a stale board.
  useEffect(() => {
    if (!autoRefresh) return undefined;
    if (!isLoaded || !isSignedIn) return;

    const refresh = () => {
      void load();
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) refresh();
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") refresh();
    };

    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [autoRefresh, isLoaded, isSignedIn, load]);

  const claim = useCallback(
    async (questId: number): Promise<number> => {
      setClaimingId(questId);
      setError(null);
      try {
        // The body carries the quest id and nothing else — the server derives
        // the player from the session and the amount from the stored row.
        const res = await fetch("/api/quests/claim", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ questId }),
        });
        const json = await res.json().catch(() => null);

        if (res.ok && json?.success) {
          applyBoard(json);
          const credited = Number(json.credited ?? 0) || 0;
          setClaimedNow({ id: questId, amount: credited });
          // The credit moved `users.balance`; every balance reader re-reads.
          notifyCoinBalanceChanged();
          return credited;
        }

        // A refusal is a state, not a fault: incomplete, already claimed and
        // expired all re-read the board. The message is set AFTER the re-read
        // because `load()` starts by clearing the error.
        const message =
          typeof json?.error === "string"
            ? json.error
            : "We couldn't claim that quest.";
        await load();
        setError((previous) => previous ?? message);
        return 0;
      } catch {
        setError("We couldn't claim that quest.");
        return 0;
      } finally {
        setClaimingId(null);
      }
    },
    [applyBoard, load],
  );

  return {
    isLoaded,
    isSignedIn,
    board,
    loading,
    claimingId,
    claimedNow,
    error,
    load,
    claim,
  };
}

/**
 * Localised quest copy, with the server's own text as the fallback: a quest the
 * catalog ships before its locale strings land still reads correctly instead of
 * showing a raw key.
 *
 *   const localise = useQuestText();
 *   localise(`quests.defs.${quest.definitionId}.title`, quest.title);
 */
export function useQuestText() {
  const { t } = useTranslation();
  return useCallback(
    (key: string, fallback: string): string => {
      const value = t(key);
      return !value || value === key ? fallback : String(value);
    },
    [t],
  );
}
