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

import { useEffect, useState } from "react";

export function useCoinBalance(): number | null {
  const [balance, setBalance] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
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
    })();
    return () => {
      alive = false;
    };
  }, []);

  return balance;
}
