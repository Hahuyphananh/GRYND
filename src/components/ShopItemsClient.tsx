"use client";

// src/components/ShopItemsClient.tsx
//
// Token-priced item shop section (consumables + timed boosts). Unlike the
// Stripe-backed token packs, items are bought directly with the player's
// token balance — no checkout, no webhook. The server only ever sees an
// itemKey; price and award are resolved server-side (the client's amount is
// ignored). After a purchase the component refetches /api/shop/items for the
// authoritative balance + inventory.

import { useCallback, useEffect, useState } from "react";

export type ShopItem = {
  key: string;
  name: string;
  desc: string;
  price: number;
  category: "consumable" | "timed";
  badge: string | null;
  color: string | null;
  owned: number | null;
  activeUntil: string | null;
};

type ShopItemsPayload = {
  success: boolean;
  balance: number;
  items: ShopItem[];
  error?: string;
};

async function loadItems(): Promise<ShopItemsPayload | null> {
  try {
    const res = await fetch("/api/shop/items", { credentials: "include" });
    return await res.json().catch(() => null);
  } catch {
    return null;
  }
}

export default function ShopItemsClient() {
  const [payload, setPayload] = useState<ShopItemsPayload | null>(null);
  const [buying, setBuying] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setPayload(await loadItems());
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function buy(itemKey: string, name: string) {
    setError(null);
    setSuccess(null);
    setBuying(itemKey);
    try {
      const res = await fetch("/api/shop/items/buy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemKey }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error || "Could not buy item. Please try again.");
        setBuying(null);
        return;
      }
      setSuccess(`${name} purchased — ${data.balance?.toLocaleString?.() ?? ""} tokens remaining`);
      await refresh();
    } catch {
      setError("Could not buy item. Please try again.");
    } finally {
      setBuying(null);
    }
  }

  if (!payload || !payload.success || !payload.items?.length) return null;

  const balance = payload.balance;

  return (
    <section className="mt-12">
      <div className="mb-6 text-center">
        <h3 className="text-lg font-bold text-[#f5ff3b]">Item Shop</h3>
        <p className="mt-1 text-sm text-[#9dd8ff]/70">
          Token-priced items — no real money. Buy once, they last until used.
        </p>
        <p className="mt-1 text-sm text-[#9dd8ff]/70">
          {balance !== null && balance !== undefined
            ? `Your balance: ${balance.toLocaleString()} tokens`
            : ""}
        </p>
      </div>

      {success && (
        <p className="mb-4 text-center text-sm font-semibold text-green-400">{success}</p>
      )}
      {error && <p className="mb-4 text-center text-sm text-red-400">{error}</p>}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {payload.items.map((item) => {
          const isTimed = item.category === "timed";
          const owned = item.owned ?? 0;
          const activeUntil = item.activeUntil;
          const active =
            isTimed && activeUntil ? new Date(activeUntil).getTime() > Date.now() : false;
          const buyLabel = buying === item.key ? "Buying…" : `Buy — ${item.price.toLocaleString()} tokens`;

          return (
            <div
              key={item.key}
              className="relative flex flex-col rounded-2xl border border-[#00e5ff]/20 bg-[#040d24]/70 p-5 text-center shadow-[0_0_20px_rgba(0,229,255,0.08)] transition-all"
            >
              {item.badge && (
                <span
                  className="absolute -top-3 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full px-3 py-0.5 text-xs font-bold text-[#040d24]"
                  style={{ backgroundColor: item.color ?? "#00e5ff" }}
                >
                  {item.badge}
                </span>
              )}

              <div className="text-sm font-semibold uppercase tracking-wider text-[#c9f7ff]">
                {item.name}
              </div>

              <p className="mt-2 flex-1 text-xs leading-relaxed text-[#9dd8ff]/80">{item.desc}</p>

              <div className="mt-3 text-2xl font-black text-[#00e5ff]">
                {item.price.toLocaleString()}
                <span className="text-xs font-normal text-[#9dd8ff]/70"> tokens</span>
              </div>

              <div className="mt-2 min-h-[1.25rem] text-xs">
                {isTimed ? (
                  active ? (
                    <span className="text-[#a3e635]">
                      Active — expires {new Date(activeUntil!).toLocaleDateString()}{" "}
                      {new Date(activeUntil!).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  ) : (
                    <span className="text-[#9dd8ff]/50">Not active</span>
                  )
                ) : owned > 0 ? (
                  <span className="text-[#34d399]">Owned × {owned}</span>
                ) : (
                  <span className="text-[#9dd8ff]/50">Not owned</span>
                )}
              </div>

              <button
                type="button"
                onClick={() => buy(item.key, item.name)}
                disabled={buying !== null}
                className="mt-4 w-full rounded-xl bg-[#00e5ff] px-4 py-2 font-semibold text-[#040d24] transition-colors hover:bg-[#33ebff] disabled:opacity-60"
              >
                {buyLabel}
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}