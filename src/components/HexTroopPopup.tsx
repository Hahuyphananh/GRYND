"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { IconCheck, IconX } from "@tabler/icons-react";
import { clampSendCount, maxSendLimit } from "../lib/hexTroopCount";

/**
 * Small action popup for the troop-count step of Hex Duel's Attack and
 * Displace actions.
 *
 * It floats directly above a board tile so choosing how many troops to send
 * no longer requires scrolling down to the panel under the board. Hex Duel
 * anchors it to the SOURCE tile — the territory the troops leave — which
 * makes it the single control for the count and for swapping the source
 * (moving the anchor moves the popup with it).
 *
 * The popup is `position: fixed` and anchored to the tile's measured screen
 * rect, which keeps it correct wherever the anchor is — the board's
 * responsive scale
 * (`HexBoard` scales itself with a CSS transform), the horizontal scroll
 * container on narrow screens, and page scroll. Placement flips below the
 * tile when there is not enough room above, and is clamped inside the
 * viewport.
 */

interface HexTroopPopupProps {
  /** "x,y" of the tile this popup floats above. */
  anchorKey: string;
  /** Short heading, e.g. "Send troops". */
  title: string;
  /** One-line context, e.g. "(3,2) -> (4,2)". */
  hint: string;
  /** Optional muted tip under the hint, e.g. how to switch source tiles. */
  tip?: string;
  /** Currently chosen troop count. */
  value: number;
  /** Maximum troops that can be sent (source troops minus the 1 that stays). */
  max: number;
  /** Accent colour of the acting player. */
  color: string;
  /**
   * Side to try first. Hex Duel passes the side facing AWAY from the target
   * tile so the popup never covers the territory the troops are going to;
   * it still flips to the other side when this one has no room.
   */
  preferPlacement?: Placement;
  onChange: (value: number) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

type Placement = "above" | "below";

interface PopupPosition {
  /** Viewport x of the popup's horizontal centre. */
  left: number;
  top: number;
  placement: Placement;
  /** Caret offset from the popup's left edge. */
  caretLeft: number;
}

/** Gap between the anchored tile and the popup. */
const ANCHOR_GAP = 10;
/** Minimum distance the popup keeps from the viewport edges. */
const VIEWPORT_MARGIN = 10;
const POPUP_WIDTH = 196;

const clamp = (n: number, min: number, max: number) => Math.min(Math.max(n, min), max);

export default function HexTroopPopup({
  anchorKey,
  title,
  hint,
  tip,
  value,
  max,
  color,
  preferPlacement,
  onChange,
  onConfirm,
  onCancel,
}: HexTroopPopupProps) {
  const popupRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<PopupPosition | null>(null);

  const safeMax = maxSendLimit(max);

  // Default to sitting above the tile (the natural spot for a control that
  // belongs to it) unless the caller asked for the other side first.
  const preferred = preferPlacement ?? "above";

  const reposition = useCallback(() => {
    const popup = popupRef.current;
    if (!popup) return;
    const tile = document.querySelector<HTMLElement>(
      `[data-hex-board] [data-tile-key="${anchorKey}"]`,
    );
    if (!tile) {
      setPos(null);
      return;
    }

    const rect = tile.getBoundingClientRect();
    const width = popup.offsetWidth;
    const height = popup.offsetHeight;
    if (!width || !height) return;

    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Try the preferred side first, fall back to the other one. A side only
    // counts as usable when the whole popup plus the viewport margin fits in
    // it, so the fallback is what keeps a tall popup on screen.
    const fitsAbove = rect.top - ANCHOR_GAP - height >= VIEWPORT_MARGIN;
    const fitsBelow = rect.bottom + ANCHOR_GAP + height <= vh - VIEWPORT_MARGIN;
    const placement: Placement =
      preferred === "below"
        ? fitsBelow || !fitsAbove
          ? "below"
          : "above"
        : fitsAbove || !fitsBelow
          ? "above"
          : "below";
    const top = clamp(
      placement === "above" ? rect.top - ANCHOR_GAP - height : rect.bottom + ANCHOR_GAP,
      VIEWPORT_MARGIN,
      Math.max(VIEWPORT_MARGIN, vh - VIEWPORT_MARGIN - height),
    );
    const half = width / 2;
    const left = clamp(
      rect.left + rect.width / 2,
      half + VIEWPORT_MARGIN,
      Math.max(half + VIEWPORT_MARGIN, vw - half - VIEWPORT_MARGIN),
    );
    const caretLeft = clamp(rect.left + rect.width / 2 - (left - half), 16, width - 16);

    setPos((prev) =>
      prev &&
      prev.left === left &&
      prev.top === top &&
      prev.placement === placement &&
      prev.caretLeft === caretLeft
        ? prev
        : { left, top, placement, caretLeft },
    );
  }, [anchorKey, preferred]);

  // Track the anchored tile every frame. The tile can move for reasons no
  // single event covers: the board sizes itself after mount (and re-scales on
  // resize), the page scrolls, a horizontal scroller shifts, and even this
  // popup's own height settles once fonts/styles land. `reposition` bails out
  // of the state update when nothing moved, so the loop is cheap and cannot
  // re-render-storm.
  useEffect(() => {
    let raf = requestAnimationFrame(function tick() {
      reposition();
      raf = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(raf);
  }, [reposition]);

  // Keep the parent's count inside the valid range: a source tile with no
  // spare troops opens this popup at 0, and switching to a smaller source
  // clamps the count down. `onChange` is a state setter, so this settles
  // after a single pass.
  useEffect(() => {
    const next = clampSendCount(value, safeMax);
    if (next !== value) onChange(next);
  }, [value, safeMax, onChange]);

  // Escape dismisses the pending action, like any other popup.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  // Quick picks mirror the old panel's 1 / 3 / 5 / 10 / MAX row, deduped so
  // the current maximum is always offered exactly once (labelled MAX).
  const quickPicks = Array.from(new Set([1, 3, 5, 10, safeMax].filter((n) => n >= 1 && n <= safeMax))).sort(
    (a, b) => a - b,
  );

  return (
    <div
      ref={popupRef}
      role="dialog"
      aria-label={title}
      className="fixed z-[60]"
      style={{
        left: pos?.left ?? 0,
        top: pos?.top ?? 0,
        width: POPUP_WIDTH,
        maxWidth: "calc(100vw - 20px)",
        transform: "translateX(-50%)",
        visibility: pos ? "visible" : "hidden",
        animation: pos ? "floatUp 0.16s ease-out" : undefined,
      }}
    >
      <div
        className="relative rounded-xl border p-2.5 backdrop-blur-md"
        style={{
          borderColor: `${color}66`,
          background:
            "linear-gradient(180deg, rgba(7,18,48,0.97) 0%, rgba(10,26,63,0.97) 100%)",
          boxShadow: `0 0 20px ${color}33, 0 12px 30px rgba(0,0,0,0.65)`,
        }}
      >
        {/* Caret pointing at the anchored tile */}
        <span
          aria-hidden
          className="absolute h-2.5 w-2.5 rotate-45"
          style={{
            left: (pos?.caretLeft ?? 0) - 5,
            background: "rgba(9,23,54,0.98)",
            ...(pos?.placement === "above"
              ? {
                  bottom: -5,
                  borderRight: `1px solid ${color}66`,
                  borderBottom: `1px solid ${color}66`,
                }
              : {
                  top: -5,
                  borderLeft: `1px solid ${color}66`,
                  borderTop: `1px solid ${color}66`,
                }),
          }}
        />

        {/* Header */}
        <div className="mb-1.5 flex items-center justify-between">
          <span
            className="text-[10px] font-bold uppercase tracking-[0.18em]"
            style={{ color }}
          >
            {title}
          </span>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Cancel"
            className="text-slate-500 transition-colors hover:text-slate-300"
          >
            <IconX size={13} />
          </button>
        </div>

        <p className={`font-mono text-[9px] text-slate-500 ${tip ? "mb-0.5" : "mb-2"}`}>{hint}</p>
        {tip && <p className="mb-2 text-[8px] leading-tight text-slate-600">{tip}</p>}

        {/* Troop count */}
        <div className="flex items-center gap-1.5">
          <input
            type="number"
            min={1}
            max={safeMax}
            value={value}
            // Deliberately not auto-focused: on phones that would pop the
            // soft keyboard over the board. The quick picks are the primary
            // input; tapping the field is opt-in.
            aria-label="Troops to send"
            onChange={(e) => onChange(clampSendCount(Number(e.target.value), safeMax))}
            className="w-16 rounded-lg border border-white/15 bg-[#020617] px-2 py-1.5 text-center text-sm text-white outline-none transition focus:border-white/40"
          />
          <span className="text-[10px] text-slate-400">/ {safeMax}</span>
        </div>

        {/* Quick picks */}
        <div className="mt-2 flex gap-1">
          {quickPicks.map((n) => {
            const selected = value === n;
            return (
              <button
                key={n}
                type="button"
                onClick={() => onChange(n)}
                className="flex-1 rounded-md border px-1 py-1 text-[9px] font-bold transition-all"
                style={
                  selected
                    ? {
                        borderColor: `${color}80`,
                        backgroundColor: `${color}26`,
                        color,
                      }
                    : {
                        borderColor: "rgba(255,255,255,0.1)",
                        backgroundColor: "rgba(255,255,255,0.03)",
                        color: "rgb(148 163 184)",
                      }
                }
              >
                {n === safeMax && safeMax > 1 ? "MAX" : n}
              </button>
            );
          })}
        </div>

        {/* Confirm */}
        <div className="mt-2 flex gap-1.5">
          <button
            type="button"
            onClick={onConfirm}
            className="flex-1 rounded-md py-1.5 text-[10px] font-bold uppercase tracking-[0.12em] transition-all active:scale-[0.97]"
            style={{
              backgroundColor: color,
              color: "#020617",
              boxShadow: `0 0 12px ${color}44`,
            }}
          >
            <IconCheck size={12} className="mr-1 mb-0.5 inline" /> Confirm
          </button>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Cancel action"
            className="rounded-md border border-white/10 px-2 py-1.5 text-[10px] text-slate-500 transition-all hover:border-white/20 hover:text-slate-300"
          >
            <IconX size={12} />
          </button>
        </div>
      </div>
    </div>
  );
}
