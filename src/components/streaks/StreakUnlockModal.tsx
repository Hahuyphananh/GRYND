"use client";

// THE UNLOCK CELEBRATION — shown when a completion crosses a milestone.
//
// It is driven by one window event (`grynd:streak-unlocked`) so every completion
// surface — daily, duel, a background poll — reports the same way without each
// of them owning a modal. The items are the server's `newlyUnlocked` list; the
// modal cannot invent one.

import { useCallback, useEffect, useState } from "react";

import { boardItem } from "../../lib/solitaire-duel/boardCosmetics";
import { applyBoardCosmetics } from "../../hooks/useSolitaireBoardCosmetics";
import { setStoredBoardTheme } from "../../hooks/useSolitaireBoardTheme";

type UnlockEvent = CustomEvent<{ items: string[]; currentStreak: number }>;

const SLOT_FOR: Record<string, "felt" | "card_back" | "deck_skin"> = {
  felt: "felt",
  card_back: "card_back",
  deck_skin: "deck_skin",
};

export default function StreakUnlockModal() {
  const [items, setItems] = useState<string[]>([]);
  const [streak, setStreak] = useState(0);
  const [equipping, setEquipping] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const onUnlock = (event: Event) => {
      const detail = (event as UnlockEvent).detail;
      if (!detail?.items?.length) return;
      setItems(detail.items);
      setStreak(detail.currentStreak ?? 0);
      setMessage(null);
    };
    window.addEventListener("grynd:streak-unlocked", onUnlock);
    return () => window.removeEventListener("grynd:streak-unlocked", onUnlock);
  }, []);

  const equip = useCallback(async (itemId: string) => {
    const item = boardItem(itemId);
    if (!item) return;
    const slot = SLOT_FOR[item.kind];
    setEquipping(itemId);
    try {
      const response = await fetch("/api/cosmetics/equip", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ item: itemId, category: slot }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || !body?.success) {
        setMessage(body?.error || "Could not equip that item.");
        return;
      }
      if (slot === "felt") setStoredBoardTheme(itemId);
      if (slot === "card_back") applyBoardCosmetics({ cardBack: itemId });
      if (slot === "deck_skin") applyBoardCosmetics({ deckSkin: itemId });
      setMessage("Equipped.");
      window.dispatchEvent(new Event("grynd:streak-updated"));
    } catch {
      setMessage("Could not equip that item.");
    } finally {
      setEquipping(null);
    }
  }, []);

  if (items.length === 0) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Streak rewards unlocked"
      data-testid="streak-unlock-modal"
      className="fixed inset-0 z-[130] flex items-center justify-center bg-black/70 p-4"
    >
      <div className="w-full max-w-md rounded-2xl border border-amber-300/35 bg-surface p-5 text-white shadow-2xl">
        <p className="text-[10px] font-black uppercase tracking-[0.24em] text-amber-200/85">
          {streak}-day streak
        </p>
        <h2 className="mt-1 text-2xl font-black tracking-tight">Unlocked</h2>
        <ul className="mt-3 space-y-1.5">
          {items.map((itemId) => {
            const item = boardItem(itemId);
            return (
              <li
                key={itemId}
                className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2"
              >
                <span className="min-w-0">
                  <span className="block text-xs font-bold text-white">
                    {item?.label ?? itemId}
                  </span>
                  <span className="block text-[10px] text-white/45">
                    {item?.blurb ?? "Permanent unlock"}
                  </span>
                </span>
                {item ? (
                  <button
                    type="button"
                    onClick={() => void equip(itemId)}
                    disabled={equipping === itemId}
                    className="shrink-0 rounded-lg border border-amber-300/45 bg-amber-300/15 px-2.5 py-1 text-[10px] font-black uppercase tracking-[0.12em] text-amber-100 hover:bg-amber-300/25 disabled:opacity-50"
                  >
                    {equipping === itemId ? "Equipping…" : "Equip now"}
                  </button>
                ) : (
                  <span className="shrink-0 text-[10px] text-white/40">Profile</span>
                )}
              </li>
            );
          })}
        </ul>
        {message && <p className="mt-2 text-[11px] text-cyan-200/80">{message}</p>}
        <button
          type="button"
          onClick={() => setItems([])}
          className="mt-4 w-full rounded-xl bg-amber-300 px-4 py-2 text-sm font-black text-[#2a1e04]"
        >
          Nice
        </button>
      </div>
    </div>
  );
}
