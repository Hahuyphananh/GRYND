"use client";

// src/components/odds/PredictionPanel.tsx
//
// The whole Odds prediction control: circular selector, exact/range switch,
// manual min/max (or single-number) inputs, the quick presets, and the live
// width/points preview.
//
// `value` is the single source of truth — every surface reads it and every
// surface writes it through `onChange`, so the wheel, the inputs, the active
// preset and the preview can never disagree. The preview calls the engine's own
// scorer (`potentialScore`), so the number shown before submission is exactly
// the number a hit would pay.

import { useEffect, useRef, useState } from "react";
import { IconMinus, IconPlus, IconX } from "@tabler/icons-react";
import { TARGET_MAX, TARGET_MIN, type OddsPrediction } from "../../lib/odds";
import CircularSelector from "./CircularSelector";
import { clueWindow } from "./oddsMotion";
import {
  ODDS_PRESETS,
  activePreset,
  clampZoom,
  potentialScore,
  selectionLabel,
  selectionOf,
  selectionWidth,
  spanForZoom,
  type OddsPreset,
  type OddsZoom,
} from "./oddsRing";

export type PredictionPanelProps = {
  value: OddsPrediction | null;
  onChange: (prediction: OddsPrediction | null) => void;
  /** Called when Enter is pressed in a field (locks the call in). */
  onSubmit?: () => void;
  /** This round's clue sentence — the wheel dims only what it rules out. */
  clue?: string | null;
  disabled?: boolean;
  className?: string;
};

type Drafts = { min: string; max: string; exact: string };

const EMPTY_DRAFTS: Drafts = { min: "", max: "", exact: "" };

/** A whole number inside 1..100, or null. */
function toDomainInt(raw: string): number | null {
  const text = String(raw ?? "").trim();
  if (!/^\d{1,3}$/.test(text)) return null;
  const value = Number(text);
  if (value < TARGET_MIN || value > TARGET_MAX) return null;
  return value;
}

function draftsFor(value: OddsPrediction | null): Drafts {
  if (!value) return EMPTY_DRAFTS;
  if (value.kind === "exact") {
    return { min: "", max: "", exact: String(value.value) };
  }
  return { min: String(value.min), max: String(value.max), exact: "" };
}

export default function PredictionPanel({
  value,
  onChange,
  onSubmit,
  clue = null,
  disabled = false,
  className = "",
}: PredictionPanelProps) {
  const [zoom, setZoom] = useState<OddsZoom>(1);
  const [mode, setMode] = useState<"exact" | "range">(
    value?.kind === "exact" ? "exact" : "range",
  );
  const [drafts, setDrafts] = useState<Drafts>(() => draftsFor(value));

  // What we last emitted: an incoming value that matches it is our own change
  // and must not overwrite what the player is typing.
  const emittedRef = useRef<string>("");

  const emit = (next: OddsPrediction | null) => {
    emittedRef.current = JSON.stringify(next);
    onChange(next);
  };

  useEffect(() => {
    const serialized = JSON.stringify(value);
    if (serialized === emittedRef.current) return;
    emittedRef.current = serialized;
    setDrafts(draftsFor(value));
    if (value?.kind === "exact") setMode("exact");
    else if (value?.kind === "range") setMode("range");
  }, [value]);

  const selection = selectionOf(value);
  const clueWin = clueWindow(clue);
  const width = selectionWidth(value);
  const points = potentialScore(value);
  const active = activePreset(value);

  const minDraft = toDomainInt(drafts.min);
  const maxDraft = toDomainInt(drafts.max);
  const exactDraft = toDomainInt(drafts.exact);
  const rangeError =
    mode === "range" &&
    drafts.min !== "" &&
    drafts.max !== "" &&
    (minDraft === null || maxDraft === null || minDraft > maxDraft);
  const invalid = mode === "exact" ? exactDraft === null && drafts.exact !== "" : rangeError;

  const commitDrafts = (next: Partial<Drafts>) => {
    const merged = { ...drafts, ...next };
    setDrafts(merged);

    if (mode === "exact") {
      const exact = toDomainInt(merged.exact);
      emit(exact === null ? null : { kind: "exact", value: exact });
      return;
    }

    const min = toDomainInt(merged.min);
    const max = toDomainInt(merged.max);
    if (min === null || max === null || min > max) {
      // Nothing valid to submit — the board disables lock-in, so an impossible
      // half-typed range can never reach the server.
      emit(null);
      return;
    }
    emit({ kind: "range", min, max });
  };

  const switchMode = (next: "exact" | "range") => {
    if (next === mode) return;
    setMode(next);
    if (next === "exact") {
      const candidate = selection ? selection.min : null;
      setDrafts({ min: "", max: "", exact: candidate === null ? "" : String(candidate) });
      emit(candidate === null ? null : { kind: "exact", value: candidate });
      return;
    }
    setDrafts({
      min: selection ? String(selection.min) : "",
      max: selection ? String(selection.max) : "",
      exact: "",
    });
    emit(selection ? { kind: "range", min: selection.min, max: selection.max } : null);
  };

  const applyPreset = (preset: OddsPreset) => {
    setMode("range");
    setDrafts({ min: String(preset.min), max: String(preset.max), exact: "" });
    emit({ kind: "range", min: preset.min, max: preset.max });
  };

  const clear = () => {
    setDrafts(EMPTY_DRAFTS);
    setZoom(1);
    emit(null);
  };

  // How many of the 100 numbers the wheel is showing at this zoom.
  const zoomLabel = String(spanForZoom(zoom, null));

  return (
    <div className={`space-y-3 ${className}`}>
      {/* Mode + zoom */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div
          className="flex items-center rounded-md border border-white/10 bg-black/30 p-0.5"
          role="group"
          aria-label="Prediction type"
        >
          {(["exact", "range"] as const).map((option) => {
            const isActive = mode === option;
            return (
              <button
                key={option}
                type="button"
                onClick={() => switchMode(option)}
                disabled={disabled}
                aria-pressed={isActive}
                className={`odds-label rounded px-2.5 py-1 transition ${
                  isActive
                    ? "bg-[#f5ff3b] text-black"
                    : "text-white/50 hover:text-cyan-100"
                } disabled:cursor-not-allowed disabled:opacity-40`}
              >
                {option}
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-1" role="group" aria-label="Zoom">
          <button
            type="button"
            onClick={() => setZoom((current) => clampZoom(current - 1))}
            disabled={disabled || zoom === 0}
            aria-label="Zoom out"
            className="rounded border border-white/15 bg-black/30 p-1.5 text-white/60 transition hover:border-cyan-400/50 hover:text-cyan-200 disabled:cursor-not-allowed disabled:opacity-30"
          >
            <IconMinus size={13} />
          </button>
          <span className="odds-label w-8 text-center text-white/35">
            {zoomLabel}
          </span>
          <button
            type="button"
            onClick={() => setZoom((current) => clampZoom(current + 1))}
            disabled={disabled || zoom === 2}
            aria-label="Zoom in"
            className="rounded border border-white/15 bg-black/30 p-1.5 text-white/60 transition hover:border-cyan-400/50 hover:text-cyan-200 disabled:cursor-not-allowed disabled:opacity-30"
          >
            <IconPlus size={13} />
          </button>
        </div>
      </div>

      <CircularSelector
        value={value}
        mode={mode}
        zoom={zoom}
        disabled={disabled}
        ruledOut={clueWin}
        onChange={(next) => {
          if (disabled) return;
          // The wheel always reports what it just selected, so mirror it into
          // the text fields rather than waiting for the effect: typing after a
          // tap must continue from the tapped number.
          const mirrored = draftsFor(next);
          setDrafts(mirrored);
          emit(next);
        }}
        onZoomChange={(next) => setZoom(next)}
      />

      {/* Clue context. The dimming is read back from the clue sentence, so it
          shows exactly the window the clue named and nothing more; a call that
          leaves that window is flagged, never blocked. */}
      {clueWin && (
        <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
          <span className="odds-label text-white/30">
            dimmed · outside the clue ({clueWin.min}–{clueWin.max})
          </span>
          {selection && (selection.min < clueWin.min || selection.max > clueWin.max) && (
            <span className="odds-label text-amber-300/80">
              your call leaves the clue
            </span>
          )}
        </div>
      )}

      {/* Manual entry — the precise path, always available. */}
      <div className="grid grid-cols-2 gap-2">
        {mode === "exact" ? (
          <label className="col-span-2 block">
            <span className="odds-label text-white/40">exact number</span>
            <input
              type="text"
              inputMode="numeric"
              value={drafts.exact}
              onChange={(event) => commitDrafts({ exact: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Enter" && exactDraft !== null) onSubmit?.();
              }}
              disabled={disabled}
              placeholder={`${TARGET_MIN}–${TARGET_MAX}`}
              className="odds-input odds-chamfer mt-1 w-full p-2.5 text-center text-xl placeholder-white/20"
              aria-label={`Exact number, ${TARGET_MIN} to ${TARGET_MAX}`}
            />
          </label>
        ) : (
          <>
            <label className="block">
              <span className="odds-label text-white/40">min</span>
              <input
                type="text"
                inputMode="numeric"
                value={drafts.min}
                onChange={(event) => commitDrafts({ min: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !invalid && value) onSubmit?.();
                }}
                disabled={disabled}
                placeholder={String(TARGET_MIN)}
                className="odds-input odds-chamfer mt-1 w-full p-2.5 text-center text-xl placeholder-white/20"
                aria-label={`Minimum, ${TARGET_MIN} to ${TARGET_MAX}`}
              />
            </label>
            <label className="block">
              <span className="odds-label text-white/40">max</span>
              <input
                type="text"
                inputMode="numeric"
                value={drafts.max}
                onChange={(event) => commitDrafts({ max: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !invalid && value) onSubmit?.();
                }}
                disabled={disabled}
                placeholder={String(TARGET_MAX)}
                className="odds-input odds-chamfer mt-1 w-full p-2.5 text-center text-xl placeholder-white/20"
                aria-label={`Maximum, ${TARGET_MIN} to ${TARGET_MAX}`}
              />
            </label>
          </>
        )}
      </div>

      {rangeError && (
        <p className="odds-label text-amber-300" role="alert">
          min can&apos;t exceed max
        </p>
      )}

      {/* The readout the player is betting on. */}
      <dl className="grid grid-cols-4 gap-1.5">
        {[
          ["min", selection ? String(selection.min) : "—", "text-[#f5ff3b]"],
          ["max", selection ? String(selection.max) : "—", "text-[#f5ff3b]"],
          ["width", selection ? String(width) : "—", "text-cyan-200"],
          ["pts", selection ? String(points) : "—", "text-cyan-200"],
        ].map(([label, display, tone]) => (
          <div
            key={label}
            className="odds-hud odds-chamfer px-2 py-1.5 text-center"
          >
            <dt className="odds-label text-white/30">{label}</dt>
            <dd className={`odds-readout mt-1 text-base ${tone}`}>{display}</dd>
          </div>
        ))}
      </dl>

      <p className="odds-label text-white/30">
        {selection
          ? `hit pays +${points} · miss pays 0 · ${
              mode === "exact" ? "one number" : "inclusive range"
            }`
          : "tap the wheel, type a range, or pick a preset"}
      </p>

      {/* Quick picks: every decade, the twenty-blocks, both halves, 1–100. */}
      <div
        className="flex gap-1.5 overflow-x-auto pb-1 sm:flex-wrap sm:overflow-visible"
        role="group"
        aria-label="Quick ranges"
      >
        {ODDS_PRESETS.map((preset) => {
          const isActive = active === preset.id;
          return (
            <button
              key={preset.id}
              type="button"
              onClick={() => applyPreset(preset)}
              disabled={disabled}
              aria-pressed={isActive}
              className={`odds-label shrink-0 rounded border px-2 py-1 transition ${
                isActive
                  ? "border-[#f5ff3b] bg-[#f5ff3b] text-black"
                  : "border-white/12 bg-white/[0.04] text-white/55 hover:border-cyan-400/50 hover:text-cyan-100"
              } disabled:cursor-not-allowed disabled:opacity-40`}
            >
              {preset.label}
            </button>
          );
        })}
      </div>

      <div className="flex items-center justify-between gap-2">
        <span className="odds-label text-white/25">
          {selection ? selectionLabel(value) : "no call selected"}
        </span>
        <button
          type="button"
          onClick={clear}
          disabled={disabled || !value}
          className="odds-label inline-flex items-center gap-1 rounded border border-white/12 px-2 py-1 text-white/45 transition hover:border-red-400/50 hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-30"
        >
          <IconX size={11} /> clear
        </button>
      </div>
    </div>
  );
}
