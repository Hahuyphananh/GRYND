"use client";

// src/components/CosmeticsClient.tsx
//
// Token-priced cosmetic shop + equipment panel (frames / badges / avatar,
// username, chat and profile effects). Bought only with Grynd tokens (no
// cash), purchased and equipped through server-authoritative endpoints
// (/api/cosmetics/buy, /api/cosmetics/equip). The client only ever submits a
// cosmetic key; price and ownership are resolved server-side.

import { useCallback, useEffect, useState } from "react";

type CosmeticItem = {
  key: string;
  name: string;
  description: string;
  category: string;
  rarity: string;
  visual: Record<string, unknown>;
  unlockCondition: string | null;
  priceTokens?: number | null;
  owned?: boolean;
  equipped?: boolean;
};

type CosmeticsPayload = {
  success: boolean;
  shop: CosmeticItem[];
  owned: CosmeticItem[];
  equipped: Record<string, string>;
  error?: string;
};

const CATEGORY_LABEL: Record<string, string> = {
  profile_frame: "Profile Frame",
  badge: "Badge",
  avatar_effect: "Avatar Effect",
  username_effect: "Username Effect",
  chat_effect: "Chat Effect",
  profile_glow: "Profile Glow",
  prestige_effect: "Prestige Effect",
};

async function loadCosmetics(): Promise<CosmeticsPayload | null> {
  try {
    const res = await fetch("/api/cosmetics", { credentials: "include" });
    return await res.json().catch(() => null);
  } catch {
    return null;
  }
}

function visualOf(item: CosmeticItem): { cssClass?: string; color?: string } {
  const v = item.visual || {};
  return {
    cssClass: typeof v.cssClass === "string" ? v.cssClass : undefined,
    color: typeof v.color === "string" ? v.color : undefined,
  };
}

export default function CosmeticsClient() {
  const [payload, setPayload] = useState<CosmeticsPayload | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setPayload(await loadCosmetics());
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function buy(key: string, name: string) {
    setError(null);
    setSuccess(null);
    setBusy(`buy:${key}`);
    try {
      const res = await fetch("/api/cosmetics/buy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error || "Could not buy cosmetic. Please try again.");
        return;
      }
      setSuccess(`${name} unlocked!`);
      await refresh();
    } catch {
      setError("Could not buy cosmetic. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  async function equip(item: CosmeticItem) {
    setError(null);
    setSuccess(null);
    const equipped = item.equipped;
    setBusy(`equip:${item.key}`);
    try {
      const res = await fetch("/api/cosmetics/equip", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(equipped ? { key: null, category: item.category } : { key: item.key }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error || "Could not update equipment.");
        return;
      }
      setSuccess(equipped ? `${item.name} unequipped` : `${item.name} equipped`);
      await refresh();
    } catch {
      setError("Could not update equipment.");
    } finally {
      setBusy(null);
    }
  }

  if (!payload || !payload.success) return null;
  const hasShop = payload.shop?.length > 0;
  const hasOwned = payload.owned?.length > 0;
  if (!hasShop && !hasOwned) return null;

  return (
    <section className="mt-12">
      <div className="mb-6 text-center">
        <h3 className="text-lg font-bold text-[#a78bfa]">Cosmetics</h3>
        <p className="mt-1 text-sm text-[#9dd8ff]/70">
          Profile frames, badges and effects — token-priced, never cash. Equip what you own.
        </p>
      </div>

      {success && (
        <p className="mb-4 text-center text-sm font-semibold text-green-400">{success}</p>
      )}
      {error && <p className="mb-4 text-center text-sm text-red-400">{error}</p>}

      {hasShop && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {payload.shop.map((item) => {
            const { color } = visualOf(item);
            const locked = Boolean(item.unlockCondition) && !item.owned;
            return (
              <div
                key={item.key}
                className="relative flex flex-col rounded-2xl border border-[#a78bfa]/25 bg-[#040d24]/70 p-5 text-center shadow-[0_0_20px_rgba(167,139,250,0.08)]"
              >
                <div
                  className="mx-auto mb-2 h-10 w-10 rounded-full border-2"
                  style={{ borderColor: color ?? "#a78bfa", boxShadow: `0 0 12px ${color ?? "#a78bfa"}66` }}
                />
                <div className="text-sm font-semibold uppercase tracking-wider text-[#c9f7ff]">
                  {item.name}
                </div>
                <div className="mt-0.5 text-[10px] uppercase tracking-wider text-[#a78bfa]">
                  {CATEGORY_LABEL[item.category] ?? item.category} · {item.rarity}
                </div>
                <p className="mt-2 flex-1 text-xs leading-relaxed text-[#9dd8ff]/80">
                  {item.description}
                </p>
                {item.owned ? (
                  <p className="mt-3 rounded-xl bg-green-950/40 px-4 py-2 text-sm font-semibold text-green-400">
                    Owned ✓
                  </p>
                ) : (
                  <button
                    type="button"
                    onClick={() => buy(item.key, item.name)}
                    disabled={busy !== null || locked}
                    className="mt-3 w-full rounded-xl bg-[#a78bfa] px-4 py-2 font-semibold text-[#040d24] transition-colors hover:bg-[#c4b5fd] disabled:opacity-50"
                  >
                    {locked
                      ? "Requires Prestige"
                      : busy === `buy:${item.key}`
                        ? "Buying…"
                        : `Buy — ${(item.priceTokens ?? 0).toLocaleString()}`}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {hasOwned && (
        <>
          <h4 className="mt-8 text-center text-sm font-bold uppercase tracking-wider text-[#c9f7ff]">
            Your Cosmetics
          </h4>
          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {payload.owned.map((item) => {
              const { color } = visualOf(item);
              return (
                <div
                  key={item.key}
                  className={`flex items-center gap-3 rounded-xl border bg-[#040d24]/70 p-3 ${
                    item.equipped ? "border-[#a3e635]/60" : "border-[#00e5ff]/20"
                  }`}
                >
                  <div
                    className="h-8 w-8 flex-shrink-0 rounded-full border-2"
                    style={{ borderColor: color ?? "#a78bfa" }}
                  />
                  <div className="min-w-0 flex-1 text-left">
                    <div className="truncate text-xs font-semibold text-[#c9f7ff]">{item.name}</div>
                    <div className="text-[10px] uppercase tracking-wider text-[#a78bfa]">
                      {CATEGORY_LABEL[item.category] ?? item.category}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => equip(item)}
                    disabled={busy !== null}
                    className={`flex-shrink-0 rounded-lg px-2.5 py-1 text-xs font-semibold transition-colors disabled:opacity-60 ${
                      item.equipped
                        ? "border border-[#a3e635]/60 text-[#a3e635] hover:bg-[#a3e635]/10"
                        : "bg-[#00e5ff] text-[#040d24] hover:bg-[#33ebff]"
                    }`}
                  >
                    {busy === `equip:${item.key}` ? "…" : item.equipped ? "Unequip" : "Equip"}
                  </button>
                </div>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}