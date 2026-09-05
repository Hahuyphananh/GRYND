"use client";

// src/components/creator-mode/CreatorModeLobby.jsx
//
// Creator Mode entry point inside the EXISTING casino lobby (no separate
// page). Rendered ONLY when the server-backed access check grants it
// (admin today, approved creators later) — normal users never see it and
// the endpoint never grants them access.
//
// Flow:
//   1. Admin clicks the "🎥 Creator Mode" control → settings modal opens.
//   2. Admin picks the recording dimensions (9:16 default / 16:9 / 1:1 /
//      custom with validation) and sees a live preview of the recording
//      frame.
//   3. "Enable Creator Mode" persists the flag + dimensions to
//      sessionStorage (session-scoped only — the user's permanent
//      profile/settings are never touched) and tells the lobby to tag
//      game links with ?creator=1.
//   4. No recording happens here. The game page's CreatorModeProvider
//      reads the stored dimensions and starts recording only when the
//      actual game begins.
//
// The lobby's game cards carry ?creator=1 when enabled (see
// buildCreatorHref in src/lib/creator-mode/client.ts).

import React, { useEffect, useState } from "react";
import { useUser } from "@clerk/nextjs";
import { useCreatorModeAccess } from "../../lib/creator-mode/useCreatorModeAccess";
import {
  getStoredCreatorDimensions,
  getStoredCreatorMode,
  isCreatorModeSearch,
  setStoredCreatorDimensions,
  setStoredCreatorMode,
} from "../../lib/creator-mode/client";
import {
  DIMENSION_PRESETS,
  MAX_CAPTURE_DIMENSION,
  MIN_CAPTURE_DIMENSION,
  sanitizeDimensions,
} from "../../lib/creator-mode/types";

const PRESET_KEYS = ["9:16", "16:9", "1:1", "custom"];

/** Fit a (width × height) frame into a max box, preserving aspect. */
function fitFrame(width, height, maxW, maxH) {
  const aspect = width / height;
  if (aspect >= 1) {
    const w = Math.min(maxW, maxH * aspect);
    return { w: Math.round(w), h: Math.round(w / aspect) };
  }
  const h = Math.min(maxH, maxW / aspect);
  return { w: Math.round(h * aspect), h: Math.round(h) };
}

function gcd(a, b) {
  return b ? gcd(b, a % b) : a;
}

/**
 * Visual preview of the recording frame at the selected dimensions.
 * The 9:16 preset renders a phone-style portrait frame labelled for
 * TikTok / Shorts / Reels so it's obvious what the video is for.
 */
function RecordingFramePreview({ width, height, preset }) {
  const { w, h } = fitFrame(width, height, 200, 156);
  const isPortrait = width < height;
  const isPhone = preset === "9:16";

  return (
    <div className="flex flex-col items-center gap-2">
      <div
        className="relative flex items-center justify-center rounded-xl border border-[#00e5ff]/25 bg-[#08142f]"
        style={{ width: w + 24, height: h + 24 }}
      >
        <div
          className={`relative overflow-hidden bg-[#040d24] ${
            isPhone ? "rounded-[1.4rem] border-2 border-[#0e1f4d]" : "rounded-lg border border-[#00e5ff]/40"
          }`}
          style={{ width: w, height: h }}
        >
          {/* Faint game-area grid so the frame reads as a game capture. */}
          <div
            className="absolute inset-0 opacity-[0.35]"
            style={{
              backgroundImage:
                "repeating-linear-gradient(0deg, rgba(0,229,255,0.12) 0 1px, transparent 1px 18px), repeating-linear-gradient(90deg, rgba(0,229,255,0.12) 0 1px, transparent 1px 18px)",
            }}
          />
          {/* Phone notch for the 9:16 default. */}
          {isPhone && (
            <div className="absolute left-1/2 top-1.5 h-2 w-10 -translate-x-1/2 rounded-full bg-black/80" />
          )}
          {/* REC dot + label */}
          <div className="absolute left-2 top-2 flex items-center gap-1 rounded-full bg-black/60 px-1.5 py-0.5">
            <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
            <span className="text-[8px] font-bold tracking-wider text-white/90">REC</span>
          </div>
          {isPhone ? (
            <div className="absolute inset-x-0 bottom-1 flex justify-center">
              <span className="rounded-full bg-black/60 px-2 py-0.5 text-[8px] font-bold tracking-wide text-[#f5ff3b]">
                TikTok · Shorts · Reels
              </span>
            </div>
          ) : (
            <div className="absolute inset-x-0 bottom-1 flex justify-center">
              <span className="rounded-full bg-black/60 px-2 py-0.5 text-[8px] font-bold tracking-wide text-[#9dd8ff]">
                {preset}
              </span>
            </div>
          )}
        </div>
      </div>
      <p className="text-[11px] font-semibold text-[#9dd8ff] tabular-nums">
        {width} × {height}
        {isPortrait ? " · Portrait" : " · Landscape"}
      </p>
      {preset === "9:16" && (
        <p className="-mt-1 text-[10px] text-[#f5ff3b]/80">
          Made for TikTok / Shorts / Reels
        </p>
      )}
    </div>
  );
}

export default function CreatorModeLobby({ onChange = () => {} }) {
  const { user } = useUser();
  const { canUseCreatorMode, loading } = useCreatorModeAccess();

  const [enabled, setEnabled] = useState(false);
  const [open, setOpen] = useState(false);
  const [preset, setPreset] = useState("9:16");
  const [customW, setCustomW] = useState("");
  const [customH, setCustomH] = useState("");

  // Restore session state for this user (flag + dimensions). Same rule as
  // the game-page provider: the URL ?creator=1 param is canonical and is
  // persisted to storage, so landing on any lobby with the param (e.g.
  // deep-linked from a decorated game card) keeps the mode alive through
  // subsequent in-app navigations that don't carry the param.
  useEffect(() => {
    if (!user?.id) return;
    const fromUrl = isCreatorModeSearch(window.location.search);
    const storedEnabled = getStoredCreatorMode(user.id);
    const enabledNow = fromUrl || storedEnabled;
    setEnabled(enabledNow);
    if (enabledNow && fromUrl) {
      setStoredCreatorMode(user.id, true);
    }
    const stored = getStoredCreatorDimensions(user.id);
    setPreset(stored.preset);
    setCustomW(String(stored.width));
    setCustomH(String(stored.height));
    // Keep the lobby's game-link decoration in sync with stored state.
    onChange?.(enabledNow);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  // Close the modal on Escape (per the app's accessibility conventions).
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  // Hide entirely for users without access — including while the access
  // check is still loading (no flash of a control they can't use).
  if (!canUseCreatorMode || loading) return null;

  // ── Custom dimension validation ────────────────────────────────────
  // NOTE: plain computed values, not useMemo — these live after an early
  // return, and hooks after a conditional return would violate the Rules
  // of Hooks ("Rendered more hooks than during the previous render").
  const customValidation = (() => {
    if (customW.trim() === "" || customH.trim() === "") {
      return { error: "Width and height are required." };
    }
    const w = Number(customW);
    const h = Number(customH);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
      return { error: "Enter valid numbers." };
    }
    if (w < MIN_CAPTURE_DIMENSION || w > MAX_CAPTURE_DIMENSION || h < MIN_CAPTURE_DIMENSION || h > MAX_CAPTURE_DIMENSION) {
      return {
        error: `Use between ${MIN_CAPTURE_DIMENSION} and ${MAX_CAPTURE_DIMENSION} px.`,
      };
    }
    return { error: null, width: w, height: h };
  })();

  // The effective dimensions shown in the preview + saved on Enable.
  const effective = (() => {
    if (preset === "custom") {
      const sanitized = sanitizeDimensions(Number(customW) || 0, Number(customH) || 0);
      return { preset: "custom", width: sanitized.width, height: sanitized.height };
    }
    const p = DIMENSION_PRESETS[preset];
    return { preset, width: p.width, height: p.height };
  })();

  const canEnable = preset !== "custom" || customValidation.error === null;

  const enable = () => {
    setStoredCreatorDimensions(user?.id, effective);
    setStoredCreatorMode(user?.id, true);
    setEnabled(true);
    onChange?.(true);
    setOpen(false);
  };

  const disable = () => {
    setStoredCreatorMode(user?.id, false);
    setEnabled(false);
    onChange?.(false);
    setOpen(false);
  };

  const ratioText = (() => {
    const g = gcd(effective.width, effective.height) || 1;
    return `${effective.width / g}:${effective.height / g}`;
  })();

  const selectPreset = (key) => {
    setPreset(key);
    if (key !== "custom") {
      const p = DIMENSION_PRESETS[key];
      setCustomW(String(p.width));
      setCustomH(String(p.height));
    }
  };

  return (
    <>
      {/* Lobby entry control — only ever rendered for authorized users. */}
      <button
        onClick={() => setOpen(true)}
        data-creator-mode-entry
        aria-haspopup="dialog"
        aria-expanded={open}
        className={`inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-sm font-semibold transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff] focus-visible:ring-offset-2 focus-visible:ring-offset-[#040d24] ${
          enabled
            ? "border-[#00e5ff] bg-[#00e5ff]/15 text-[#00e5ff] shadow-[0_0_15px_rgba(0,229,255,0.4)]"
            : "border-[#00e5ff]/30 bg-[#040d24] text-[#9dd8ff] hover:border-[#00e5ff]/60 hover:text-[#d8fbff]"
        }`}
      >
        <span aria-hidden>🎥</span>
        <span className="text-xs font-bold uppercase tracking-widest">Creator Mode</span>
        <span
          className={`ml-1 rounded-full px-2 py-0.5 text-[10px] font-bold ${
            enabled ? "bg-[#00e5ff] text-black" : "bg-[#10234a] text-[#6aa4d8]"
          }`}
        >
          {enabled ? "ON" : "OFF"}
        </span>
      </button>

      {/* Settings modal */}
      {open && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Creator Mode settings"
        >
          <div
            className="absolute inset-0 bg-black/75 backdrop-blur-sm"
            onClick={() => setOpen(false)}
          />

          <div className="relative z-10 w-full max-w-md overflow-hidden rounded-2xl border border-[#00e5ff]/30 bg-gradient-to-b from-[#0a1533] to-[#040d24] p-5 shadow-[0_0_60px_rgba(0,229,255,0.2)] sm:p-6">
            {/* Header */}
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-extrabold text-[#f5ff3b]">
                  🎥 Creator Mode
                </h2>
                <p className="mt-0.5 text-xs leading-relaxed text-[#9dd8ff]">
                  Record your game when it starts. Nothing is recorded in
                  the lobby.
                </p>
              </div>
              <button
                onClick={() => setOpen(false)}
                className="rounded-lg p-1 text-[#6aa4d8] transition hover:text-white"
                aria-label="Close"
              >
                <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M5 5l10 10M15 5L5 15" />
                </svg>
              </button>
            </div>

            {/* Recording dimensions */}
            <p className="mb-2 text-[10px] font-bold uppercase tracking-widest text-[#9dd8ff]">
              Recording dimensions
            </p>
            <div className="mb-3 flex flex-wrap gap-1.5">
              {PRESET_KEYS.map((key) => (
                <button
                  key={key}
                  onClick={() => selectPreset(key)}
                  className={`rounded-lg px-3 py-1.5 text-xs font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff] ${
                    preset === key
                      ? "bg-[#00e5ff] text-black shadow-[0_0_12px_rgba(0,229,255,0.5)]"
                      : "border border-[#00e5ff]/30 bg-[#08142f] text-[#d8fbff] hover:bg-[#10234a]"
                  }`}
                >
                  {key === "custom" ? "Custom" : key}
                  {key === "9:16" && (
                    <span className="ml-1 text-[9px] font-bold uppercase opacity-70">
                      default
                    </span>
                  )}
                </button>
              ))}
            </div>

            {/* Custom inputs */}
            {preset === "custom" && (
              <div className="mb-3 rounded-xl border border-[#00e5ff]/20 bg-[#08142f]/60 p-3">
                <div className="flex items-center gap-2">
                  <div className="flex-1">
                    <label
                      htmlFor="creator-w"
                      className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-[#6aa4d8]"
                    >
                      Width (px)
                    </label>
                    <input
                      id="creator-w"
                      type="number"
                      inputMode="numeric"
                      min={MIN_CAPTURE_DIMENSION}
                      max={MAX_CAPTURE_DIMENSION}
                      value={customW}
                      onChange={(e) => setCustomW(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && canEnable && enable()}
                      placeholder={String(MIN_CAPTURE_DIMENSION)}
                      className="w-full rounded-lg border border-[#00e5ff]/40 bg-[#040d24] px-3 py-2 text-sm text-[#d8fbff] focus:border-[#00e5ff] focus:outline-none focus:ring-1 focus:ring-[#00e5ff]"
                    />
                  </div>
                  <span className="pt-5 text-sm font-bold text-[#6aa4d8]">×</span>
                  <div className="flex-1">
                    <label
                      htmlFor="creator-h"
                      className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-[#6aa4d8]"
                    >
                      Height (px)
                    </label>
                    <input
                      id="creator-h"
                      type="number"
                      inputMode="numeric"
                      min={MIN_CAPTURE_DIMENSION}
                      max={MAX_CAPTURE_DIMENSION}
                      value={customH}
                      onChange={(e) => setCustomH(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && canEnable && enable()}
                      placeholder={String(MIN_CAPTURE_DIMENSION)}
                      className="w-full rounded-lg border border-[#00e5ff]/40 bg-[#040d24] px-3 py-2 text-sm text-[#d8fbff] focus:border-[#00e5ff] focus:outline-none focus:ring-1 focus:ring-[#00e5ff]"
                    />
                  </div>
                </div>
                <p className="mt-2 text-[10px] text-[#6aa4d8]">
                  {MIN_CAPTURE_DIMENSION}–{MAX_CAPTURE_DIMENSION} px · Aspect{" "}
                  <span className="font-bold text-[#9dd8ff] tabular-nums">{ratioText}</span>
                </p>
                {customValidation.error && (
                  <p className="mt-1 text-[11px] font-semibold text-red-400">
                    {customValidation.error}
                  </p>
                )}
              </div>
            )}

            {/* Visual preview of the recording frame */}
            <div className="mb-4 flex justify-center rounded-xl border border-[#00e5ff]/15 bg-[#08142f]/40 py-3">
              <RecordingFramePreview
                width={effective.width}
                height={effective.height}
                preset={effective.preset}
              />
            </div>

            {/* Actions */}
            <div className="flex flex-col gap-2">
              <button
                onClick={enable}
                disabled={!canEnable}
                className="w-full rounded-xl bg-[#00e5ff] px-4 py-2.5 text-sm font-bold text-black shadow-[0_0_20px_rgba(0,229,255,0.45)] transition hover:bg-[#d8fbff] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f5ff3b]"
              >
                {enabled ? "Update Settings" : "Enable Creator Mode"}
              </button>
              <div className="flex gap-2">
                <button
                  onClick={() => setOpen(false)}
                  className="flex-1 rounded-xl border border-[#00e5ff]/30 bg-[#08142f] px-4 py-2 text-sm font-bold text-[#d8fbff] transition hover:bg-[#10234a] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
                >
                  Cancel
                </button>
                {enabled && (
                  <button
                    onClick={disable}
                    className="flex-1 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-2 text-sm font-bold text-red-300 transition hover:bg-red-500/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
                  >
                    Disable
                  </button>
                )}
              </div>
              <p className="text-center text-[10px] text-[#6aa4d8]">
                Creator Mode is session-only — your profile is not changed.
                Recording starts when the game starts.
              </p>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
