"use client";

import { useEffect, useRef, useState } from "react";
import { IconCheck, IconX } from "@tabler/icons-react";
import { normalizeCosmeticVisual } from "../lib/profileCosmetics";

// Generic cosmetics picker — the category-agnostic sibling of ChooseFrameModal.
// Lists the catalog cosmetics the user OWNS in one category (via
// /api/cosmetics) and equips the chosen one through the server-authoritative
// /api/cosmetics/equip endpoint. "None" clears that category slot. Names and
// colors always come from the catalog `visual` payload — never user input.
//
// Used by the profile edit popup so every purchased category (badge, avatar /
// username / chat effects, profile glow, prestige effect) can be equipped and
// unequipped in the same place as frames.
export default function ChooseCosmeticModal({
  open,
  category,
  title,
  subtitle,
  onClose,
  onEquipped,
}) {
  const [ownedItems, setOwnedItems] = useState([]);
  const [selectedKey, setSelectedKey] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!open || !category) return;
    setError("");
    setBusy(false);
    let cancelled = false;
    setLoading(true);
    fetch("/api/cosmetics", { credentials: "include" })
      .then((res) => res.json())
      .then((data) => {
        if (cancelled || !mountedRef.current) return;
        if (data?.success && Array.isArray(data.owned)) {
          const items = data.owned.filter((item) => item?.category === category);
          setOwnedItems(items);
          setSelectedKey(
            items.find((item) => item.equipped)?.key ||
              data.equipped?.[category] ||
              null,
          );
        } else {
          setError(data?.error || "Could not load your cosmetics.");
        }
      })
      .catch(() => {
        if (!cancelled && mountedRef.current)
          setError("Could not load your cosmetics. Please try again.");
      })
      .finally(() => {
        if (!cancelled && mountedRef.current) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, category]);

  const handleSelect = async (itemKey) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/cosmetics/equip", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          itemKey ? { key: itemKey } : { key: null, category },
        ),
      });
      const data = await res.json();
      if (!res.ok || !data.success)
        throw new Error(data.error || "Could not update your cosmetics.");

      const nextKey = data.equippedCosmetics?.[category] ?? (itemKey || null);
      setSelectedKey(nextKey);
      window.dispatchEvent(new Event("profileUpdated"));
      const item = ownedItems.find((f) => f.key === nextKey) || null;
      onEquipped?.(
        item ? { key: item.key, name: item.name, visual: item.visual } : null,
      );
    } catch (err) {
      setError(err?.message || "Could not update your cosmetics.");
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  const heading = title || "Choose Your Cosmetic";

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={() => !busy && onClose?.()}
      role="dialog"
      aria-modal="true"
      aria-label={heading}
    >
      <div
        className="relative w-full max-w-lg overflow-hidden rounded-2xl border border-[#00e5ff]/40 bg-[#040d24] shadow-[0_0_40px_rgba(0,229,255,0.3)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="absolute left-0 top-0 h-0.5 w-full bg-gradient-to-r from-transparent via-[#00e5ff] to-transparent" />
        <div className="flex items-center justify-between border-b border-[#00e5ff]/20 px-5 py-4">
          <div>
            <h2 className="text-lg font-extrabold tracking-tight text-[#f5ff3b] sm:text-xl">
              {heading}
            </h2>
            <p className="mt-0.5 text-xs text-[#9dd8ff]/80">
              {subtitle || "Token-shop cosmetic shown on your profile."}
            </p>
          </div>
          <button
            type="button"
            onClick={() => onClose?.()}
            disabled={busy}
            aria-label="Close cosmetics picker"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[#00e5ff]/30 text-[#9dd8ff] transition hover:border-[#00e5ff]/70 hover:text-white disabled:opacity-50"
          >
            <IconX size={18} />
          </button>
        </div>

        <div className="max-h-[65vh] overflow-y-auto px-5 py-4">
          {loading ? (
            <div className="flex items-center justify-center py-10 text-sm text-[#00e5ff]">
              <span className="h-5 w-5 animate-spin rounded-full border-2 border-[#00e5ff] border-t-transparent" />
              <span className="ml-3">Loading your cosmetics...</span>
            </div>
          ) : error ? (
            <div className="rounded-lg border border-red-500/40 bg-red-950/30 px-4 py-6 text-center text-sm text-red-200">
              {error}
            </div>
          ) : ownedItems.length === 0 ? (
            <div className="rounded-lg border border-[#00e5ff]/20 bg-[#00e5ff]/5 px-4 py-6 text-center text-sm text-[#9dd8ff]">
              You don&apos;t own any cosmetics in this category yet. Visit the{" "}
              <a href="/shop" className="font-semibold text-[#00e5ff] underline">
                Shop
              </a>{" "}
              to unlock one.
            </div>
          ) : (
            <div className="space-y-3">
              <button
                type="button"
                onClick={() => handleSelect(null)}
                disabled={busy}
                aria-pressed={!selectedKey}
                className={`flex w-full items-center justify-between gap-3 rounded-xl border p-3 text-left transition ${
                  !selectedKey
                    ? "border-[#00e5ff] bg-[#00e5ff]/10"
                    : "border-white/10 bg-white/[0.03] hover:border-[#00e5ff]/50"
                }`}
              >
                <span className="flex items-center gap-3">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-dashed border-white/25 bg-black/30 text-[10px] uppercase text-white/50">
                    None
                  </span>
                  <span>
                    <span className="block text-sm font-semibold text-white">
                      None
                    </span>
                    <span className="block text-xs text-[#9dd8ff]">
                      Do not use a cosmetic in this slot.
                    </span>
                  </span>
                </span>
                {!selectedKey && <IconCheck size={18} className="text-[#00e5ff]" />}
              </button>

              {ownedItems.map((item) => {
                const equipped = selectedKey === item.key;
                const { color } = normalizeCosmeticVisual(item.visual);
                return (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => handleSelect(item.key)}
                    disabled={busy}
                    aria-pressed={equipped}
                    className={`flex w-full items-center justify-between gap-3 rounded-xl border p-3 text-left transition ${
                      equipped
                        ? "border-[#00e5ff] bg-[#00e5ff]/10 shadow-[0_0_16px_rgba(0,229,255,0.3)]"
                        : "border-white/10 bg-white/[0.03] hover:border-[#00e5ff]/50"
                    }`}
                  >
                    <span className="flex min-w-0 items-center gap-3">
                      <span
                        className="h-10 w-10 shrink-0 rounded-full border-2"
                        style={{
                          borderColor: color ?? "#a78bfa",
                          boxShadow: `0 0 12px ${color ?? "#a78bfa"}66`,
                        }}
                      />
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-semibold text-white">
                          {item.name}
                        </span>
                        <span className="block text-xs text-[#9dd8ff]">
                          {item.rarity}
                        </span>
                      </span>
                    </span>
                    {equipped && (
                      <IconCheck size={18} className="shrink-0 text-[#00e5ff]" />
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
