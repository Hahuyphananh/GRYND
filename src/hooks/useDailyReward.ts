"use client";

// src/hooks/useDailyReward.ts
//
// The daily login reward's client state, extracted so every surface that shows
// it agrees on the rules. Two surfaces render this reward — the full card on
// /rewards (components/DailyRewardCard) and the compact corner widget on the
// home and games pages (components/DailyRewardWidget) — and the claim is a real
// credit, so the request shapes, the refusals and the balance notification must
// not be re-implemented per surface.
//
// The SERVER owns the whole reward: the curated 7-day curve, whether today was
// claimed, and whether the player has played a game today (the gate that
// unlocks the claim). This hook never computes an amount and never credits
// anything; it reads the status `/api/rewards/daily` reports and asks the
// server to claim.
//
// A read only fires once the Clerk session is known — a signed-out visitor has
// no reward, and firing an authenticated read first would just be a wasted 401.

import { useCallback, useEffect, useState } from "react";
import { useUser } from "@clerk/nextjs";
import { notifyCoinBalanceChanged } from "./useCoinBalance";

export type DailyRewardStatus = {
  claimable: boolean;
  playGateSatisfied: boolean;
  streakDay: number;
  cycleDay: number;
  /** How many days the board shows (14). Server-owned, never hardcoded. */
  cycleDays: number;
  reward: number;
  today: string;
  cycle: number[];
  balance: number;
  /**
   * True when the wallet has no room for today's reward under the hard ceiling,
   * so the server would REFUSE a claim. The surfaces warn with this BEFORE the
   * player presses Claim — a refusal they cannot act on is not a UX.
   */
  walletFull: boolean;
  /** The ceiling that verdict was computed against (server-owned). */
  walletCap: number;
};

export type UseDailyReward = {
  /** True once Clerk has resolved the session (signed in OR out). */
  isLoaded: boolean;
  isSignedIn: boolean;
  status: DailyRewardStatus | null;
  /** A status read is in flight. */
  loading: boolean;
  /** A claim is in flight. */
  claiming: boolean;
  /** Coins credited by the claim made on this mount, or null. */
  claimedNow: number | null;
  /** A read or claim failure, already phrased for display. */
  error: string | null;
  /** Re-read the status from the server. */
  load: () => Promise<void>;
  /** Claim today's reward. Refusals (gate / already claimed) are re-read, not thrown. */
  claim: () => Promise<void>;
};

export function useDailyReward(): UseDailyReward {
  const { isLoaded, isSignedIn } = useUser();
  const [status, setStatus] = useState<DailyRewardStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [claiming, setClaiming] = useState(false);
  const [claimedNow, setClaimedNow] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // `no-store` is required, not a micro-optimisation: a status read is what
      // the /rewards board and the corner widget render from, and the shared
      // CsrfFetchGuard (src/components/CsrfFetchGuard.tsx) serves GET /api/*
      // responses from a 2-second in-memory cache. Without this the read fired
      // straight after a claim could be answered from that cache with the
      // PRE-claim status, so the page kept showing the day that was just
      // claimed. A read that must reflect a write is never cacheable.
      const res = await fetch("/api/rewards/daily", { cache: "no-store" });
      const json = await res.json().catch(() => null);
      if (res.ok && json?.success) {
        setStatus(json as DailyRewardStatus);
      } else {
        setError("We couldn't load your daily reward.");
      }
    } catch {
      setError("We couldn't load your daily reward.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isLoaded) return;
    if (!isSignedIn) {
      setLoading(false);
      return;
    }
    void load();
  }, [isLoaded, isSignedIn, load]);

  const claim = useCallback(async () => {
    setClaiming(true);
    setError(null);
    try {
      // The claim takes no parameters, but every mutating request must declare
      // a JSON content type — the shared middleware rejects a bodyless POST with
      // 415 otherwise (the same guard every other POST in the app satisfies).
      const res = await fetch("/api/rewards/daily", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const json = await res.json().catch(() => null);
      if (res.ok && json?.success) {
        // `credited` is what the server actually paid; the advertised `reward`
        // is only a fallback for an older response shape.
        setClaimedNow(Number(json.credited ?? json.reward) || 0);
        await load();
        // The claim credited the balance the navbar and lobby pickers read.
        notifyCoinBalanceChanged();
      } else {
        // A refusal is a state, not a fault: the gate (403), an already-claimed
        // day (409) or a full wallet (409) is re-read from the server either
        // way. The message must be set AFTER that re-read — `load()` starts by
        // clearing the error, so setting it first made every refusal vanish
        // and a refused claim looked exactly like a claim that paid nothing.
        const message =
          typeof json?.error === "string" ? json.error : "We couldn't claim your reward.";
        await load();
        // Keep a load failure if the re-read was the thing that broke.
        setError((previous) => previous ?? message);
      }
    } catch {
      setError("We couldn't claim your reward.");
    } finally {
      setClaiming(false);
    }
  }, [load]);

  return {
    isLoaded,
    isSignedIn,
    status,
    loading,
    claiming,
    claimedNow,
    error,
    load,
    claim,
  };
}
