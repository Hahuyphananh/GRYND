"use client";

// src/hooks/useCoinBalance.ts
//
// The player's spendable coin balance, for the lobby wager pickers.
//
// It reads the same endpoint the navbar does (/api/get-user-tokens, POST),
// which also applies the daily energy grant — so a player who opens a lobby
// after dropping below the floor sees the topped-up number, not a stale one.
//
// A signed-out visitor (or a failed read) gets `null`, which the picker treats
// as "balance unknown" and never as "0 coins".
//
// The read repeats whenever the balance changes somewhere else on the page.
// A credit that happens inside a component (the daily reward claim, for
// instance) calls `notifyCoinBalanceChanged()` and every mounted reader
// re-reads — so the number a player sees can never be stale after a payout it
// just triggered.

import { useEffect, useState } from "react";

/** Fired on `window` after a credit the client knows about. */
export const COIN_BALANCE_EVENT = "grynd:coin-balance";

/**
 * Tell every mounted balance reader to re-read. Safe to call anywhere —
 * a no-op outside the browser.
 */
export function notifyCoinBalanceChanged() {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new Event(COIN_BALANCE_EVENT));
  } catch {
    // Dispatch unavailable — readers simply keep the value they already have.
  }
}

export function useCoinBalance(): number | null {
  const [balance, setBalance] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;

    const read = async () => {
      try {
        const res = await fetch("/api/get-user-tokens", { method: "POST" });
        if (!res.ok) return;
        const json = await res.json();
        if (!alive || !json?.success) return;
        const value = Number(json?.data?.balance);
        if (Number.isFinite(value)) setBalance(value);
      } catch {
        // A balance read is decoration here — the server still enforces the
        // wager, so a failure simply leaves the balance unknown.
      }
    };

    void read();
    window.addEventListener(COIN_BALANCE_EVENT, read);
    return () => {
      alive = false;
      window.removeEventListener(COIN_BALANCE_EVENT, read);
    };
  }, []);

  return balance;
}
