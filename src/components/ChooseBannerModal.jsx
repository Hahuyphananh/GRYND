"use client";

import { useEffect, useRef, useState } from "react";
import { IconCheck, IconX } from "@tabler/icons-react";
import { bannerAssetUrl } from "../lib/bannerAssets";

export default function ChooseBannerModal({
  open,
  onClose,
  currentBannerKey,
  onEquipped,
}) {
  const [ownedBanners, setOwnedBanners] = useState([]);
  const [selectedKey, setSelectedKey] = useState(currentBannerKey || null);
  const [failedBannerKeys, setFailedBannerKeys] = useState({});
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
    setSelectedKey(currentBannerKey || null);
    setFailedBannerKeys({});
    setError("");
    setBusy(false);
    let cancelled = false;
    setLoading(true);
    fetch("/api/user/banners", { credentials: "include" })
      .then((res) => res.json())
      .then((data) => {
        if (cancelled || !mountedRef.current) return;
        if (data?.success && Array.isArray(data.ownedBanners)) {
          setOwnedBanners(data.ownedBanners);
          setSelectedKey(data.selectedBanner || null);
        } else {
          setError(data?.error || "Could not load your banners.");
        }
      })
      .catch(() => {
        if (!cancelled && mountedRef.current) setError("Could not load your banners. Please try again.");
      })
      .finally(() => {
        if (!cancelled && mountedRef.current) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, currentBannerKey]);

  const handleSelect = async (bannerKey) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/user/banner/select", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bannerKey }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || "Could not update your banner.");
      const nextKey = data.selectedBanner || null;
      setSelectedKey(nextKey);
      window.dispatchEvent(new Event("profileUpdated"));
      onEquipped?.(nextKey);
    } catch (err) {
      setError(err?.message || "Could not update your banner.");
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
      aria-label="Choose Your Banner"
    >
      <div
        className="relative w-full max-w-lg overflow-hidden rounded-2xl border border-[#00e5ff]/40 bg-[#040d24] shadow-[0_0_40px_rgba(0,229,255,0.3)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="absolute left-0 top-0 h-0.5 w-full bg-gradient-to-r from-transparent via-[#00e5ff] to-transparent" />
        <div className="flex items-center justify-between border-b border-[#00e5ff]/20 px-5 py-4">
          <div>
            <h2 className="text-lg font-extrabold tracking-tight text-[#f5ff3b] sm:text-xl">Choose Your Banner</h2>
            <p className="mt-0.5 text-xs text-[#9dd8ff]/80">Wear an official Grynd banner on your profile.</p>
          </div>
          <button
            type="button"
            onClick={() => onClose?.()}
            disabled={busy}
            aria-label="Close banner picker"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[#00e5ff]/30 text-[#9dd8ff] transition hover:border-[#00e5ff]/70 hover:text-white disabled:opacity-50"
          >
            <IconX size={18} />
          </button>
        </div>

        <div className="max-h-[65vh] overflow-y-auto px-5 py-4">
          {loading ? (
            <div className="flex items-center justify-center py-10 text-sm text-[#00e5ff]">
              <span className="h-5 w-5 animate-spin rounded-full border-2 border-[#00e5ff] border-t-transparent" />
              <span className="ml-3">Loading your banners...</span>
            </div>
          ) : error ? (
            <div className="rounded-lg border border-red-500/40 bg-red-950/30 px-4 py-6 text-center text-sm text-red-200">{error}</div>
          ) : (
            <div className="space-y-3">
              <button
                type="button"
                onClick={() => handleSelect(null)}
                disabled={busy}
                aria-pressed={!selectedKey}
                className={`flex w-full items-center justify-between rounded-xl border p-3 text-left transition ${
                  !selectedKey ? "border-[#00e5ff] bg-[#00e5ff]/10" : "border-white/10 bg-white/[0.03] hover:border-[#00e5ff]/50"
                }`}
              >
                <span>
                  <span className="block text-sm font-semibold text-white">No Banner</span>
                  <span className="block text-xs text-[#9dd8ff]">Use the default profile background.</span>
                </span>
                {!selectedKey && <IconCheck size={18} className="text-[#00e5ff]" />}
              </button>

              {ownedBanners.map((banner) => {
                const equipped = selectedKey === banner.key;
                const assetUrl = bannerAssetUrl(banner.key);
                const artworkAvailable = assetUrl && !failedBannerKeys[banner.key];
                return (
                  <button
                    key={banner.key}
                    type="button"
                    onClick={() => handleSelect(banner.key)}
                    disabled={busy}
                    aria-pressed={equipped}
                    className={`w-full overflow-hidden rounded-xl border text-left transition ${
                      equipped ? "border-[#00e5ff] bg-[#00e5ff]/10 shadow-[0_0_16px_rgba(0,229,255,0.3)]" : "border-white/10 bg-white/[0.03] hover:border-[#00e5ff]/50"
                    } ${!artworkAvailable ? "opacity-70" : ""}`}
                  >
                    <div className="aspect-[3/1] w-full overflow-hidden bg-[#08142f]">
                      {artworkAvailable ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={assetUrl}
                          alt=""
                          className="h-full w-full object-cover"
                          loading="lazy"
                          onError={() =>
                            setFailedBannerKeys((previous) => ({
                              ...previous,
                              [banner.key]: true,
                            }))
                          }
                        />
                      ) : (
                        <div className="flex h-full items-center justify-center text-xs text-white/40">Artwork unavailable</div>
                      )}
                    </div>
                    <div className="flex items-center justify-between gap-3 px-3 py-2.5">
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-semibold text-white">{banner.name}</span>
                        <span className="block text-xs text-[#9dd8ff]">{banner.rarity}</span>
                      </span>
                      {equipped && <IconCheck size={18} className="shrink-0 text-[#00e5ff]" />}
                    </div>
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
