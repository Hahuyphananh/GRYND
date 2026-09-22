"use client";

import { useEffect, useRef, useState } from "react";
import { IconCheck, IconX } from "@tabler/icons-react";
import { cosmeticFrameRing } from "../lib/profileCosmetics";

// The ONE equip surface for profile cosmetics.
//
// Previously the profile edit popup opened a separate picker per category
// (frame, badge, avatar effect, username effect, chat effect, profile glow,
// prestige effect). That spread a single "dress up my profile" job across
// seven modals, and a row only appeared when the user already owned something
// in that category. This picker lists EVERY category the user owns items in —
// frames and effects together — and equips the chosen one through the
// server-authoritative /api/cosmetics/equip endpoint.
//
// Clicking an equipped item unequips it (the same `{ key: null, category }`
// call the old per-category pickers made). Preview colours/classes always come
// from the catalog `visual` payload — never user input.

// Display order: the frame first (the popup's row is "My Profile Frame"), then
// the effects in the order the old per-category rows used.
const CATEGORY_ORDER = [
  "profile_frame",
  "badge",
  "avatar_effect",
  "username_effect",
  "chat_effect",
  "profile_glow",
  "prestige_effect",
];

const CATEGORY_META = {
  profile_frame: {
    label: "Profile Frame",
    hint: "The ring around your profile picture.",
  },
  badge: { label: "My Badge", hint: "Shown next to your name." },
  avatar_effect: { label: "Avatar Effect", hint: "Plays around your avatar." },
  username_effect: {
    label: "Username Effect",
    hint: "Styles your displayed name.",
  },
  chat_effect: { label: "Chat Effect", hint: "Styles your name in chat." },
  profile_glow: {
    label: "Profile Glow",
    hint: "Rings your whole profile card.",
  },
  prestige_effect: {
    label: "Prestige Effect",
    hint: "Reserved for prestige players.",
  },
};

const categoryRank = (category) => {
  const index = CATEGORY_ORDER.indexOf(category);
  return index === -1 ? CATEGORY_ORDER.length : index;
};

export default function ChooseFrameModal({ open, onClose, onEquipped }) {
  const [owned, setOwned] = useState([]);
  const [equippedByCategory, setEquippedByCategory] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [busyKey, setBusyKey] = useState(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    setError("");
    setBusyKey(null);
    let cancelled = false;
    setLoading(true);
    fetch("/api/cosmetics", { credentials: "include" })
      .then((res) => res.json())
      .then((data) => {
        if (cancelled || !mountedRef.current) return;
        if (data?.success && Array.isArray(data.owned)) {
          // Stable, category-grouped order so the list never reshuffles
          // between opens. Every category is shown in one place now, so the
          // order is the display order rather than ownership order.
          const items = [...data.owned]
            .filter((item) => item && typeof item.key === "string")
            .sort((a, b) => {
              const byCategory = categoryRank(a.category) - categoryRank(b.category);
              if (byCategory !== 0) return byCategory;
              return String(a.name || "").localeCompare(String(b.name || ""));
            });
          setOwned(items);

          const equipped = { ...(data.equipped || {}) };
          for (const item of items) {
            if (item.equipped && !equipped[item.category]) {
              equipped[item.category] = item.key;
            }
          }
          setEquippedByCategory(equipped);
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
  }, [open]);

  // Equip an item, or clear the slot when the SAME item is clicked again.
  const handleSelect = async (item) => {
    if (busyKey) return;
    const category = item.category;
    const isEquipped = equippedByCategory[category] === item.key;
    setBusyKey(item.key);
    setError("");
    try {
      const res = await fetch("/api/cosmetics/equip", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          isEquipped ? { key: null, category } : { key: item.key },
        ),
      });
      const data = await res.json();
      if (!res.ok || !data.success)
        throw new Error(data.error || "Could not update your cosmetics.");

      // The server response is authoritative for the whole equipped map, so a
      // swap in one category can never leave another slot stale.
      const serverEquipped = data.equippedCosmetics || {};
      setEquippedByCategory((prev) => {
        const next = { ...prev };
        if (isEquipped) {
          delete next[category];
          // A key the server swapped in elsewhere still wins.
          if (serverEquipped[category]) next[category] = serverEquipped[category];
        } else {
          next[category] = serverEquipped[category] ?? item.key;
        }
        return next;
      });

      window.dispatchEvent(new Event("profileUpdated"));
      onEquipped?.({
        category,
        item: isEquipped
          ? null
          : { key: item.key, name: item.name, visual: item.visual },
      });
    } catch (err) {
      setError(err?.message || "Could not update your cosmetics.");
    } finally {
      setBusyKey(null);
    }
  };

  if (!open) return null;

  // Group by category, preserving the sorted order within each group.
  const groups = [];
  for (const item of owned) {
    const category = item.category || "other";
    const last = groups[groups.length - 1];
    if (last && last.category === category) last.items.push(item);
    else groups.push({ category, items: [item] });
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={() => !busyKey && onClose?.()}
      role="dialog"
      aria-modal="true"
      aria-label="Choose Your Profile Frame"
    >
      <div
        className="relative w-full max-w-lg overflow-hidden rounded-2xl border border-[#00e5ff]/40 bg-[#040d24] shadow-[0_0_40px_rgba(0,229,255,0.3)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="absolute left-0 top-0 h-0.5 w-full bg-gradient-to-r from-transparent via-[#00e5ff] to-transparent" />
        <div className="flex items-center justify-between border-b border-[#00e5ff]/20 px-5 py-4">
          <div>
            <h2 className="text-lg font-extrabold tracking-tight text-[#f5ff3b] sm:text-xl">
              My Profile Frame
            </h2>
            <p className="mt-0.5 text-xs text-[#9dd8ff]/80">
              Your frame, badge and effects — everything you own, in one place.
              Tap an equipped item again to remove it.
            </p>
          </div>
          <button
            type="button"
            onClick={() => onClose?.()}
            disabled={Boolean(busyKey)}
            aria-label="Close profile cosmetics picker"
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
          ) : error && owned.length === 0 ? (
            <div className="rounded-lg border border-red-500/40 bg-red-950/30 px-4 py-6 text-center text-sm text-red-200">
              {error}
            </div>
          ) : owned.length === 0 ? (
            <div className="rounded-lg border border-[#00e5ff]/20 bg-[#00e5ff]/5 px-4 py-6 text-center text-sm text-[#9dd8ff]">
              You don&apos;t own any cosmetics yet. Visit the{" "}
              <a href="/shop" className="font-semibold text-[#00e5ff] underline">
                Shop
              </a>{" "}
              to unlock a frame, badge or effect.
            </div>
          ) : (
            <div className="space-y-5">
              {error && (
                <p className="rounded-lg border border-red-500/40 bg-red-950/30 px-3 py-2 text-xs text-red-200">
                  {error}
                </p>
              )}

              {groups.map((group) => {
                const meta = CATEGORY_META[group.category] || {
                  label: group.category,
                  hint: null,
                };
                return (
                  <div key={group.category}>
                    <div className="mb-2 flex items-baseline justify-between gap-2">
                      <h3 className="text-xs font-bold uppercase tracking-wider text-[#c9f7ff]">
                        {meta.label}
                      </h3>
                      {meta.hint && (
                        <span className="text-[10px] text-[#9dd8ff]/60">
                          {meta.hint}
                        </span>
                      )}
                    </div>
                    <div className="space-y-2">
                      {group.items.map((item) => {
                        const equipped =
                          equippedByCategory[group.category] === item.key;
                        const ring = cosmeticFrameRing(item.visual);
                        return (
                          <button
                            key={item.key}
                            type="button"
                            onClick={() => handleSelect(item)}
                            disabled={Boolean(busyKey)}
                            aria-pressed={equipped}
                            className={`flex w-full items-center justify-between gap-3 rounded-xl border p-3 text-left transition disabled:opacity-60 ${
                              equipped
                                ? "border-[#00e5ff] bg-[#00e5ff]/10 shadow-[0_0_16px_rgba(0,229,255,0.3)]"
                                : "border-white/10 bg-white/[0.03] hover:border-[#00e5ff]/50"
                            }`}
                          >
                            <span className="flex min-w-0 items-center gap-3">
                              <span
                                aria-hidden="true"
                                className={`h-10 w-10 shrink-0 rounded-full border-2 border-white/10 ${ring.cssClass}`}
                                style={ring.style}
                              />
                              <span className="min-w-0">
                                <span className="block truncate text-sm font-semibold text-white">
                                  {item.name}
                                </span>
                                <span className="block text-xs text-[#9dd8ff]">
                                  {meta.label} · {item.rarity}
                                </span>
                              </span>
                            </span>
                            {busyKey === item.key ? (
                              <span className="shrink-0 text-xs text-[#9dd8ff]">
                                …
                              </span>
                            ) : equipped ? (
                              <IconCheck
                                size={18}
                                className="shrink-0 text-[#00e5ff]"
                              />
                            ) : null}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
