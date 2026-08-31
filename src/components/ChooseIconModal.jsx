"use client";

// src/components/ChooseIconModal.jsx
//
// The ONLY way a player changes their avatar. Opens a premium Grynd-style
// modal ("Choose Your Icon") that lists the official Grynd icons the current
// user OWNS (via /api/user/icons → user_icons). Clicking an owned icon equips
// it through the server-authoritative /api/user/icon/select endpoint
// (validates catalog existence, enabled status, and ownership) and updates
// users.selected_icon. There is NO upload / URL / external-avatar path.
//
// Real-time: on a successful equip the modal dispatches the existing
// "profileUpdated" window event (the nav bar + other surfaces already listen
// for it) and reports the new key through onEquipped so the caller can update
// its own state immediately.

import { useEffect, useRef, useState } from "react";
import IconAvatar from "./IconAvatar";
import { IconX, IconCheck } from "@tabler/icons-react";

/**
 * @param {object} props
 * @param {boolean} props.open       — whether the modal is visible
 * @param {() => void} props.onClose — close the modal
 * @param {string|null} props.currentIconKey — currently equipped icon key
 * @param {(key: string) => void} [props.onEquipped] — fired with the new key
 */
export default function ChooseIconModal({
  open,
  onClose,
  currentIconKey,
  onEquipped,
}) {
  const [ownedIcons, setOwnedIcons] = useState([]);
  const [selectedKey, setSelectedKey] = useState(currentIconKey || "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [busyKey, setBusyKey] = useState(null);
  const [justEquippedKey, setJustEquippedKey] = useState(null);
  const mountedRef = useRef(true);

  // Reset transient state each time the modal opens.
  useEffect(() => {
    if (open) {
      setSelectedKey(currentIconKey || "");
      setError("");
      setBusyKey(null);
      setJustEquippedKey(null);
    }
  }, [open, currentIconKey]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Load the user's owned icons when the modal opens.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    fetch("/api/user/icons", { credentials: "include" })
      .then((res) => res.json())
      .then((data) => {
        if (cancelled || !mountedRef.current) return;
        if (data?.success && Array.isArray(data.ownedIcons)) {
          setOwnedIcons(data.ownedIcons);
          if (data.selectedIcon) setSelectedKey(data.selectedIcon);
        } else {
          setError(data?.error || "Could not load your icons.");
        }
      })
      .catch(() => {
        if (!cancelled && mountedRef.current) {
          setError("Could not load your icons. Please try again.");
        }
      })
      .finally(() => {
        if (!cancelled && mountedRef.current) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const handleEquip = async (iconKey) => {
    if (!iconKey || busyKey) return;
    setBusyKey(iconKey);
    setError("");
    setJustEquippedKey(null);
    try {
      const res = await fetch("/api/user/icon/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ iconKey }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Could not equip this icon.");
      }
      setSelectedKey(data.selectedIcon);
      setJustEquippedKey(data.selectedIcon);
      // Refresh every avatar around the app (nav bar, etc.) immediately.
      window.dispatchEvent(new Event("profileUpdated"));
      if (onEquipped) onEquipped(data.selectedIcon);
    } catch (err) {
      setError(err?.message || "Could not equip this icon.");
    } finally {
      setBusyKey(null);
    }
  };

  const handleClose = () => {
    if (busyKey) return; // don't close mid-equip
    if (onClose) onClose();
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={handleClose}
      role="dialog"
      aria-modal="true"
      aria-label="Choose Your Icon"
    >
      <div
        className="relative w-full max-w-md overflow-hidden rounded-2xl border border-[#00e5ff]/40 bg-[#040d24] shadow-[0_0_40px_rgba(0,229,255,0.3)] sm:max-w-lg"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Neon top edge */}
        <div className="absolute top-0 left-0 h-0.5 w-full bg-gradient-to-r from-transparent via-[#00e5ff] to-transparent" />

        {/* Header */}
        <div className="flex items-center justify-between border-b border-[#00e5ff]/20 px-5 py-4">
          <div>
            <h2 className="text-lg font-extrabold tracking-tight text-[#f5ff3b] sm:text-xl">
              Choose Your Icon
            </h2>
            <p className="mt-0.5 text-xs text-[#9dd8ff]/80">
              Pick an official Grynd icon to wear as your avatar.
            </p>
          </div>
          <button
            type="button"
            onClick={handleClose}
            disabled={!!busyKey}
            aria-label="Close icon picker"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[#00e5ff]/30 text-[#9dd8ff] transition hover:border-[#00e5ff]/70 hover:text-white disabled:opacity-50"
          >
            <IconX size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="max-h-[60vh] overflow-y-auto px-5 py-4">
          {loading ? (
            <div className="flex items-center justify-center py-10 text-sm text-[#00e5ff]">
              <span className="h-5 w-5 animate-spin rounded-full border-2 border-[#00e5ff] border-t-transparent" />
              <span className="ml-3">Loading your icons…</span>
            </div>
          ) : error ? (
            <div className="rounded-lg border border-red-500/40 bg-red-950/30 px-4 py-6 text-center text-sm text-red-200">
              {error}
            </div>
          ) : ownedIcons.length === 0 ? (
            <div className="rounded-lg border border-[#00e5ff]/20 bg-[#08142f] px-4 py-8 text-center text-sm text-[#9dd8ff]">
              You don't own any icons yet. Your default icon is always available.
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-3 sm:grid-cols-4">
              {ownedIcons.map((icon) => {
                const equipped = selectedKey === icon.key;
                const busy = busyKey === icon.key;
                const justEquipped = justEquippedKey === icon.key;
                return (
                  <button
                    key={icon.key}
                    type="button"
                    onClick={() => handleEquip(icon.key)}
                    disabled={!!busyKey}
                    aria-pressed={equipped}
                    aria-label={equipped ? `${icon.name} (equipped)` : `Equip ${icon.name}`}
                    title={icon.name}
                    className={`group relative flex flex-col items-center gap-1.5 rounded-xl border p-2.5 transition-all duration-200 ${
                      equipped
                        ? "border-[#00e5ff] bg-[#00e5ff]/10 shadow-[0_0_16px_rgba(0,229,255,0.4)]"
                        : "border-white/10 bg-white/[0.03] hover:border-[#00e5ff]/50 hover:bg-[#00e5ff]/5"
                    } ${busy ? "opacity-60" : ""} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff] focus-visible:ring-offset-2 focus-visible:ring-offset-[#040d24]`}
                  >
                    <span className="relative">
                      <IconAvatar
                        iconKey={icon.key}
                        name={icon.name}
                        size="h-14 w-14 sm:h-16 sm:w-16"
                        showFrame={false}
                        className={
                          equipped
                            ? "ring-2 ring-[#00e5ff] ring-offset-2 ring-offset-[#040d24]"
                            : "transition group-hover:ring-2 group-hover:ring-[#00e5ff]/40 group-hover:ring-offset-2 group-hover:ring-offset-[#040d24]"
                        }
                      />
                      {/* Equipped check badge */}
                      {equipped && (
                        <span className="absolute -bottom-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full bg-[#00e5ff] text-[#001933] shadow-[0_0_10px_rgba(0,229,255,0.8)]">
                          <IconCheck size={13} strokeWidth={3} />
                        </span>
                      )}
                      {/* Just-equipped pulse */}
                      {justEquipped && !equipped && (
                        <span className="absolute inset-0 animate-ping rounded-full border-2 border-[#00e5ff]" />
                      )}
                    </span>
                    <span className="max-w-full truncate text-[10px] font-semibold text-[#9dd8ff]">
                      {icon.name}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-[#00e5ff]/20 px-5 py-3">
          <span className="text-[11px] text-[#9dd8ff]/60">
            {selectedKey ? "Changes apply instantly everywhere." : ""}
          </span>
          <button
            type="button"
            onClick={handleClose}
            disabled={!!busyKey}
            className="rounded-lg border border-[#00e5ff]/40 bg-[#00e5ff]/10 px-4 py-1.5 text-sm font-bold text-[#00e5ff] transition hover:bg-[#00e5ff]/20 disabled:opacity-50"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
