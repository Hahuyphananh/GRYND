"use client";

// src/components/ChooseEmotesModal.jsx
//
// The ONLY way a player manages their in-game emote loadout. Mirrors
// ChooseIconModal (same modal shell + Grynd styling).
//
// Shows:
//   * the nine Equipped slots (ordered — the game picker shows exactly this
//     order, plus the permanent GG / NICE MOVE text emotes),
//   * every OWNED emote (click to equip — appended at the end; click an
//     equipped emote or one of its slots to unequip),
//   * locked Battle Pass emotes with the level they unlock at (never
//     equipable here — ownership is server-authoritative),
//   * an "X / 9 equipped" counter and clear-all.
//
// Edits are staged locally and saved in ONE request:
//   PUT-style POST /api/user/emotes { emotes: [...] } — the server
//   validates every key (catalog + enabled + owned), rejects duplicates,
//   enforces the max of 9, and persists the ordered loadout atomically.
// On success it dispatches the "emotesUpdated" window event so open game
// pickers refresh their equipped list.

import { useEffect, useRef, useState } from "react";
import { IconCheck, IconLock, IconX } from "@tabler/icons-react";
import { emoteAssetUrl, MAX_EQUIPPED_EMOTES } from "../lib/emoteAssets";

const RARITY_COLORS = {
  Common: "#9ca3af",
  Bronze: "#cd7f32",
  Silver: "#c0c0c0",
  Gold: "#f5c542",
  Elite: "#a78bfa",
  Mythic: "#f472b6",
  Overlord: "#f59e0b",
};

/**
 * @param {object} props
 * @param {boolean} props.open
 * @param {() => void} props.onClose
 */
export default function ChooseEmotesModal({ open, onClose }) {
  const [catalog, setCatalog] = useState([]); // server emotes array
  const [equipped, setEquipped] = useState([]); // ordered loadout (draft)
  const [failedKeys, setFailedKeys] = useState({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [savedFlash, setSavedFlash] = useState(false);
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
    setFailedKeys({});
    setSavedFlash(false);
    let cancelled = false;
    setLoading(true);
    fetch("/api/user/emotes", { credentials: "include", cache: "no-store" })
      .then((res) => res.json())
      .then((data) => {
        if (cancelled || !mountedRef.current) return;
        if (data?.success && Array.isArray(data.emotes)) {
          setCatalog(data.emotes);
          setEquipped(Array.isArray(data.equippedEmotes) ? data.equippedEmotes : []);
        } else {
          setError(data?.error || "Could not load your emotes.");
        }
      })
      .catch(() => {
        if (!cancelled && mountedRef.current)
          setError("Could not load your emotes. Please try again.");
      })
      .finally(() => {
        if (!cancelled && mountedRef.current) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const equippedCount = equipped.length;
  const atCapacity = equippedCount >= MAX_EQUIPPED_EMOTES;

  const toggle = (key) => {
    setError("");
    setSavedFlash(false);
    setEquipped((prev) => {
      if (prev.includes(key)) return prev.filter((k) => k !== key);
      if (prev.length >= MAX_EQUIPPED_EMOTES) {
        setError(`You can equip a maximum of ${MAX_EQUIPPED_EMOTES} emotes. Unequip one first.`);
        return prev;
      }
      return [...prev, key];
    });
  };

  const saveDraft = async (nextDraft) => {
    if (saving) return;
    setSaving(true);
    setError("");
    setSavedFlash(false);
    try {
      const res = await fetch("/api/user/emotes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ emotes: nextDraft }),
      });
      const data = await res.json();
      if (!res.ok || !data.success)
        throw new Error(data.error || "Could not save your emote loadout.");
      setEquipped(Array.isArray(data.equippedEmotes) ? data.equippedEmotes : []);
      setSavedFlash(true);
      // Refresh every open game picker immediately (same page / other tabs
      // listen for this event).
      window.dispatchEvent(new Event("emotesUpdated"));
    } catch (err) {
      setError(err?.message || "Could not save your emote loadout.");
    } finally {
      setSaving(false);
    }
  };

  const handleSave = () => saveDraft(equipped);

  const handleClearAll = () => {
    setEquipped([]);
    setError("");
    setSavedFlash(false);
    saveDraft([]);
  };

  if (!open) return null;

  const byKey = new Map(catalog.map((entry) => [entry.key, entry]));
  const owned = catalog.filter((entry) => entry.owned);
  const locked = catalog.filter((entry) => !entry.owned);

  // Slot tiles [1..9] filled by the current draft order.
  const slotEntries = Array.from({ length: MAX_EQUIPPED_EMOTES }, (_, index) =>
    equipped[index] ? byKey.get(equipped[index]) || null : null
  );

  const tileArtwork = (entry, sizeClass) => {
    const key = entry.key;
    const assetUrl = emoteAssetUrl(key);
    if (assetUrl && !failedKeys[key]) {
      return (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={assetUrl}
          alt=""
          className={`${sizeClass} object-contain`}
          loading="lazy"
          onError={() => setFailedKeys((prev) => ({ ...prev, [key]: true }))}
        />
      );
    }
    return (
      <span
        className={`flex ${sizeClass} items-center justify-center rounded-full border border-white/15 bg-[#08142f] text-sm font-black uppercase text-[#9dd8ff]/70`}
        aria-hidden="true"
      >
        {(entry.name || key).slice(0, 1)}
      </span>
    );
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={() => !saving && onClose?.()}
      role="dialog"
      aria-modal="true"
      aria-label="Manage your emotes"
    >
      <div
        className="relative flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-[#00e5ff]/40 bg-[#040d24] shadow-[0_0_40px_rgba(0,229,255,0.3)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="absolute left-0 top-0 h-0.5 w-full bg-gradient-to-r from-transparent via-[#00e5ff] to-transparent" />

        {/* Header */}
        <div className="flex items-center justify-between border-b border-[#00e5ff]/20 px-5 py-4">
          <div>
            <h2 className="text-lg font-extrabold tracking-tight text-[#f5ff3b] sm:text-xl">
              Emotes
            </h2>
            <p className="mt-0.5 text-xs text-[#9dd8ff]/80">
              Choose up to {MAX_EQUIPPED_EMOTES} animated emotes to use in games. GG and NICE MOVE
              are always available.
            </p>
          </div>
          <button
            type="button"
            onClick={() => onClose?.()}
            disabled={saving}
            aria-label="Close emotes manager"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[#00e5ff]/30 text-[#9dd8ff] transition hover:border-[#00e5ff]/70 hover:text-white disabled:opacity-50"
          >
            <IconX size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {loading ? (
            <div className="flex items-center justify-center py-10 text-sm text-[#00e5ff]">
              <span className="h-5 w-5 animate-spin rounded-full border-2 border-[#00e5ff] border-t-transparent" />
              <span className="ml-3">Loading your emotes…</span>
            </div>
          ) : error && catalog.length === 0 ? (
            <div className="rounded-lg border border-red-500/40 bg-red-950/30 px-4 py-6 text-center text-sm text-red-200">
              {error}
            </div>
          ) : (
            <div className="space-y-6">
              {/* Equipped slots */}
              <section>
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-bold uppercase tracking-[0.16em] text-[#00e5ff]">
                    Equipped Emotes
                  </h3>
                  <span
                    className={`text-xs font-bold tabular-nums ${
                      atCapacity ? "text-[#f5ff3b]" : "text-[#9dd8ff]"
                    }`}
                  >
                    {equippedCount} / {MAX_EQUIPPED_EMOTES} equipped
                  </span>
                </div>
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-9">
                  {slotEntries.map((entry, index) => (
                    <button
                      key={index}
                      type="button"
                      disabled={!entry}
                      onClick={() => entry && toggle(entry.key)}
                      title={entry ? `Unequip ${entry.name}` : `Slot ${index + 1} — empty`}
                      aria-label={entry ? `Unequip ${entry.name}` : `Slot ${index + 1} empty`}
                      className={`relative flex aspect-square items-center justify-center rounded-xl border transition ${
                        entry
                          ? "border-[#00e5ff]/60 bg-[#00e5ff]/10 shadow-[0_0_10px_rgba(0,229,255,0.25)] hover:border-[#00e5ff] hover:bg-[#00e5ff]/15"
                          : "border-dashed border-white/15 bg-white/[0.02]"
                      }`}
                    >
                      <span className="absolute left-1 top-0.5 text-[8px] font-bold text-[#9dd8ff]/50">
                        {index + 1}
                      </span>
                      {entry ? (
                        tileArtwork(entry, "h-10 w-10 sm:h-11 sm:w-11")
                      ) : (
                        <span className="text-lg text-white/15">＋</span>
                      )}
                    </button>
                  ))}
                </div>
                <div className="mt-2 flex items-center justify-between gap-2">
                  <p className="text-[11px] text-[#9dd8ff]/60">
                    Tap an equipped slot to unequip it. The picker shows these in order + GG / NICE
                    MOVE.
                  </p>
                  {equippedCount > 0 && (
                    <button
                      type="button"
                      onClick={handleClearAll}
                      disabled={saving}
                      className="shrink-0 rounded-lg border border-white/10 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-white/60 transition hover:bg-white/10 hover:text-white disabled:opacity-50"
                    >
                      Clear all
                    </button>
                  )}
                </div>
              </section>

              {/* Owned emotes */}
              <section>
                <h3 className="mb-2 text-sm font-bold uppercase tracking-[0.16em] text-[#00e5ff]">
                  Your Emotes
                </h3>
                {owned.length === 0 ? (
                  <p className="rounded-lg border border-[#00e5ff]/20 bg-[#08142f] px-4 py-6 text-center text-sm text-[#9dd8ff]">
                    You don&apos;t own any emotes yet.
                  </p>
                ) : (
                  <div className="grid grid-cols-3 gap-2.5 sm:grid-cols-4">
                    {owned.map((entry) => {
                      const isEquipped = equipped.includes(entry.key);
                      return (
                        <button
                          key={entry.key}
                          type="button"
                          onClick={() => toggle(entry.key)}
                          aria-pressed={isEquipped}
                          aria-label={isEquipped ? `Unequip ${entry.name}` : `Equip ${entry.name}`}
                          title={`${entry.name} — ${isEquipped ? "equipped (click to unequip)" : atCapacity ? "loadout full" : "click to equip"}`}
                          className={`group relative flex flex-col items-center gap-1.5 rounded-xl border p-2.5 transition-all duration-200 ${
                            isEquipped
                              ? "border-[#00e5ff] bg-[#00e5ff]/10 shadow-[0_0_14px_rgba(0,229,255,0.35)]"
                              : atCapacity
                                ? "border-white/5 bg-white/[0.02] opacity-60 hover:border-[#00e5ff]/40 hover:opacity-90"
                                : "border-white/10 bg-white/[0.03] hover:border-[#00e5ff]/50 hover:bg-[#00e5ff]/5"
                          }`}
                        >
                          <span className="relative">
                            {tileArtwork(entry, "h-14 w-14 sm:h-16 sm:w-16")}
                            {isEquipped && (
                              <span className="absolute -bottom-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full bg-[#00e5ff] text-[#001933] shadow-[0_0_10px_rgba(0,229,255,0.8)]">
                                <IconCheck size={13} strokeWidth={3} />
                              </span>
                            )}
                          </span>
                          <span className="max-w-full truncate text-[10px] font-semibold text-[#9dd8ff]">
                            {entry.name}
                          </span>
                          <span
                            className="text-[9px]"
                            style={{ color: RARITY_COLORS[entry.rarity] || "#9ca3af" }}
                          >
                            {entry.rarity}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </section>

              {/* Locked (Battle Pass) emotes */}
              {locked.length > 0 && (
                <section>
                  <h3 className="mb-2 text-sm font-bold uppercase tracking-[0.16em] text-[#f5ff3b]/80">
                    Locked Emotes
                  </h3>
                  <div className="grid grid-cols-3 gap-2.5 sm:grid-cols-4">
                    {locked.map((entry) => (
                      <div
                        key={entry.key}
                        className="relative flex flex-col items-center gap-1.5 rounded-xl border border-white/5 bg-white/[0.02] p-2.5 opacity-70"
                        title={
                          entry.unlockLevel
                            ? `Battle Pass Level ${entry.unlockLevel} reward`
                            : "Locked"
                        }
                      >
                        <span className="relative grayscale">
                          {tileArtwork(entry, "h-14 w-14 sm:h-16 sm:w-16")}
                          <span className="absolute -bottom-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full border border-[#f5ff3b]/50 bg-[#1a1a2e] text-[#f5ff3b]">
                            <IconLock size={11} />
                          </span>
                        </span>
                        <span className="max-w-full truncate text-[10px] font-semibold text-white/50">
                          {entry.name}
                        </span>
                        <span className="text-[9px] text-[#9dd8ff]/60">
                          {entry.unlockLevel ? `Battle Pass Lv ${entry.unlockLevel}` : entry.rarity}
                        </span>
                      </div>
                    ))}
                  </div>
                  <p className="mt-2 text-[11px] text-[#9dd8ff]/60">
                    Unlock these animated emotes by reaching their Battle Pass level. Unlocked
                    emotes appear here and can be equipped — nothing auto-equips.
                  </p>
                </section>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[#00e5ff]/20 px-5 py-3">
          <span className="text-[11px] text-[#9dd8ff]/60">
            {savedFlash ? (
              <span className="font-semibold text-emerald-300">
                ✓ Loadout saved — live in games everywhere.
              </span>
            ) : error ? (
              <span className="font-semibold text-red-300">{error}</span>
            ) : (
              `${equippedCount} / ${MAX_EQUIPPED_EMOTES} equipped`
            )}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => onClose?.()}
              disabled={saving}
              className="rounded-lg border border-white/20 px-4 py-1.5 text-sm font-semibold text-white/70 transition hover:bg-white/10 disabled:opacity-50"
            >
              Close
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || loading}
              className="rounded-lg border border-[#00e5ff]/40 bg-[#00e5ff]/10 px-4 py-1.5 text-sm font-bold text-[#00e5ff] transition hover:bg-[#00e5ff]/20 disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save loadout"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
