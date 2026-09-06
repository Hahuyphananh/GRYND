"use client";

import { useEffect, useRef, useState } from "react";
import { IconCheck, IconX } from "@tabler/icons-react";

// Name glow picker — mirrors ChooseBannerModal. Lists the glows the user
// OWNS (via /api/user/glows → user_glows). Clicking an owned glow equips it
// (users.selected_glow via /api/user/glow/select); "No Glow" clears it.
// Glow colors always come from the catalog hex — never user-supplied.
export default function ChooseGlowModal({ open, onClose, onEquipped }) {
  const [ownedGlows, setOwnedGlows] = useState([]);
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
    fetch("/api/user/glows", { credentials: "include" })
      .then((res) => res.json())
      .then((data) => {
        if (cancelled || !mountedRef.current) return;
        if (data?.success && Array.isArray(data.ownedGlows)) {
          setOwnedGlows(data.ownedGlows);
          setSelectedKey(data.selectedGlow || null);
        } else {
          setError(data?.error || "Could not load your name glows.");
        }
      })
      .catch(() => {
        if (!cancelled && mountedRef.current)
          setError("Could not load your name glows. Please try again.");
      })
      .finally(() => {
        if (!cancelled && mountedRef.current) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const handleSelect = async (glowKey) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/user/glow/select", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ glowKey }),
      });
      const data = await res.json();
      if (!res.ok || !data.success)
        throw new Error(data.error || "Could not update your name glow.");
      const nextKey = data.selectedGlow || null;
      setSelectedKey(nextKey);
      window.dispatchEvent(new Event("profileUpdated"));
      const glow = ownedGlows.find((g) => g.key === nextKey) || null;
      onEquipped?.(
        nextKey
          ? { key: nextKey, color: glow?.color || null, name: glow?.name || null }
          : null,
      );
    } catch (err) {
      setError(err?.message || "Could not update your name glow.");
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
      aria-label="Choose Your Name Glow"
    >
      <div
        className="relative w-full max-w-lg overflow-hidden rounded-2xl border border-[#00e5ff]/40 bg-[#040d24] shadow-[0_0_40px_rgba(0,229,255,0.3)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="absolute left-0 top-0 h-0.5 w-full bg-gradient-to-r from-transparent via-[#00e5ff] to-transparent" />
        <div className="flex items-center justify-between border-b border-[#00e5ff]/20 px-5 py-4">
          <div>
            <h2 className="text-lg font-extrabold tracking-tight text-[#f5ff3b] sm:text-xl">
              Choose Your Name Glow
            </h2>
            <p className="mt-0.5 text-xs text-[#9dd8ff]/80">
              Battlepass-earned glow shown on your name in chat.
            </p>
          </div>
          <button
            type="button"
            onClick={() => onClose?.()}
            disabled={busy}
            aria-label="Close glow picker"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[#00e5ff]/30 text-[#9dd8ff] transition hover:border-[#00e5ff]/70 hover:text-white disabled:opacity-50"
          >
            <IconX size={18} />
          </button>
        </div>

        <div className="max-h-[65vh] overflow-y-auto px-5 py-4">
          {loading ? (
            <div className="flex items-center justify-center py-10 text-sm text-[#00e5ff]">
              <span className="h-5 w-5 animate-spin rounded-full border-2 border-[#00e5ff] border-t-transparent" />
              <span className="ml-3">Loading your name glows...</span>
            </div>
          ) : error ? (
            <div className="rounded-lg border border-red-500/40 bg-red-950/30 px-4 py-6 text-center text-sm text-red-200">
              {error}
            </div>
          ) : (
            <div className="space-y-3">
              <button
                type="button"
                onClick={() => handleSelect(null)}
                disabled={busy}
                aria-pressed={!selectedKey}
                className={`flex w-full items-center justify-between rounded-xl border p-3 text-left transition ${
                  !selectedKey
                    ? "border-[#00e5ff] bg-[#00e5ff]/10"
                    : "border-white/10 bg-white/[0.03] hover:border-[#00e5ff]/50"
                }`}
              >
                <span>
                  <span className="block text-sm font-semibold text-white">No Glow</span>
                  <span className="block text-xs text-[#9dd8ff]">Use the default name color.</span>
                </span>
                {!selectedKey && <IconCheck size={18} className="text-[#00e5ff]" />}
              </button>

              {ownedGlows.map((glow) => {
                const equipped = selectedKey === glow.key;
                return (
                  <button
                    key={glow.key}
                    type="button"
                    onClick={() => handleSelect(glow.key)}
                    disabled={busy}
                    aria-pressed={equipped}
                    className={`flex w-full items-center justify-between rounded-xl border p-3 text-left transition ${
                      equipped
                        ? "border-[#00e5ff] bg-[#00e5ff]/10 shadow-[0_0_16px_rgba(0,229,255,0.3)]"
                        : "border-white/10 bg-white/[0.03] hover:border-[#00e5ff]/50"
                    }`}
                  >
                    <span className="min-w-0">
                      <span
                        className="block text-sm font-semibold"
                        style={{ color: glow.color, textShadow: `0 0 10px ${glow.color}66` }}
                      >
                        {glow.name}
                      </span>
                      <span className="block text-xs text-[#9dd8ff]">{glow.rarity}</span>
                    </span>
                    {equipped && <IconCheck size={18} className="shrink-0 text-[#00e5ff]" />}
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