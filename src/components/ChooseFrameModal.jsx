"use client";

import { useEffect, useRef, useState } from "react";
import { IconCheck, IconX } from "@tabler/icons-react";
import { cosmeticFrameRing } from "../lib/profileCosmetics";

// Profile frame picker — mirrors ChooseGlowModal / ChooseIconModal. Lists the
// `profile_frame` cosmetics the user OWNS (via /api/cosmetics) and equips the
// chosen one through the server-authoritative /api/cosmetics/equip endpoint.
// "No Frame" clears the slot. The ring color/class always comes from the
// catalog `visual` payload — never user-supplied.
export default function ChooseFrameModal({ open, onClose, onEquipped }) {
  const [ownedFrames, setOwnedFrames] = useState([]);
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
    if (!open) return;
    setError("");
    setBusy(false);
    let cancelled = false;
    setLoading(true);
    fetch("/api/cosmetics", { credentials: "include" })
      .then((res) => res.json())
      .then((data) => {
        if (cancelled || !mountedRef.current) return;
        if (data?.success && Array.isArray(data.owned)) {
          const frames = data.owned.filter(
            (item) => item?.category === "profile_frame",
          );
          setOwnedFrames(frames);
          const equipped =
            frames.find((frame) => frame.equipped)?.key ||
            data.equipped?.profile_frame ||
            null;
          setSelectedKey(equipped);
        } else {
          setError(data?.error || "Could not load your profile frames.");
        }
      })
      .catch(() => {
        if (!cancelled && mountedRef.current)
          setError("Could not load your profile frames. Please try again.");
      })
      .finally(() => {
        if (!cancelled && mountedRef.current) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const handleSelect = async (frameKey) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/cosmetics/equip", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          frameKey ? { key: frameKey } : { key: null, category: "profile_frame" },
        ),
      });
      const data = await res.json();
      if (!res.ok || !data.success)
        throw new Error(data.error || "Could not update your profile frame.");

      const nextKey =
        data.equippedCosmetics?.profile_frame ?? (frameKey || null);
      setSelectedKey(nextKey);
      window.dispatchEvent(new Event("profileUpdated"));
      const frame = ownedFrames.find((f) => f.key === nextKey) || null;
      onEquipped?.(
        frame
          ? { key: frame.key, name: frame.name, visual: frame.visual }
          : null,
      );
    } catch (err) {
      setError(err?.message || "Could not update your profile frame.");
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={() => !busy && onClose?.()}
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
              Choose Your Profile Frame
            </h2>
            <p className="mt-0.5 text-xs text-[#9dd8ff]/80">
              Token-shop frame shown around your profile picture.
            </p>
          </div>
          <button
            type="button"
            onClick={() => onClose?.()}
            disabled={busy}
            aria-label="Close profile frame picker"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[#00e5ff]/30 text-[#9dd8ff] transition hover:border-[#00e5ff]/70 hover:text-white disabled:opacity-50"
          >
            <IconX size={18} />
          </button>
        </div>

        <div className="max-h-[65vh] overflow-y-auto px-5 py-4">
          {loading ? (
            <div className="flex items-center justify-center py-10 text-sm text-[#00e5ff]">
              <span className="h-5 w-5 animate-spin rounded-full border-2 border-[#00e5ff] border-t-transparent" />
              <span className="ml-3">Loading your profile frames...</span>
            </div>
          ) : error ? (
            <div className="rounded-lg border border-red-500/40 bg-red-950/30 px-4 py-6 text-center text-sm text-red-200">
              {error}
            </div>
          ) : ownedFrames.length === 0 ? (
            <div className="rounded-lg border border-[#00e5ff]/20 bg-[#00e5ff]/5 px-4 py-6 text-center text-sm text-[#9dd8ff]">
              You don&apos;t own any profile frames yet. Visit the{" "}
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
                      No Frame
                    </span>
                    <span className="block text-xs text-[#9dd8ff]">
                      Use the default avatar border.
                    </span>
                  </span>
                </span>
                {!selectedKey && <IconCheck size={18} className="text-[#00e5ff]" />}
              </button>

              {ownedFrames.map((frame) => {
                const equipped = selectedKey === frame.key;
                const ring = cosmeticFrameRing(frame.visual);
                return (
                  <button
                    key={frame.key}
                    type="button"
                    onClick={() => handleSelect(frame.key)}
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
                        className={`h-10 w-10 shrink-0 rounded-full border-2 border-white/10 ${ring.cssClass}`}
                        style={ring.style}
                      />
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-semibold text-white">
                          {frame.name}
                        </span>
                        <span className="block text-xs text-[#9dd8ff]">
                          {frame.rarity}
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
