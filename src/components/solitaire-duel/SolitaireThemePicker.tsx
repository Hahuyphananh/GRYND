"use client";

/**
 * src/components/solitaire-duel/SolitaireThemePicker.tsx
 *
 * THE Solitaire table selector: six swatches, the current one ticked, and a
 * reset to Classic Green.
 *
 * PHONES GET A BOTTOM SHEET; WIDER SCREENS GET A POPOVER. The collapsed control
 * has always been one small button in the header (its label already names the
 * active theme). Expanded, a dropdown under that button covered the board's top
 * row — the stock, waste and foundations — which is exactly the part of a timed
 * match a player needs to see. On a phone the chooser is now a sheet pinned to
 * the bottom of the screen instead.
 *
 * The sheet still must not hide the board, so it measures the board on open (and
 * on resize) and caps itself to the space BELOW the board. On a short screen
 * that leaves a short sheet that scrolls internally; on a tall one the whole
 * grid fits under the tableau. A backdrop closes it, as does Done — the board
 * itself is never covered.
 *
 * Accessibility: a real `<details>`/`<summary>` disclosure (keyboard and screen
 * reader behaviour for free), options as a `radiogroup` of `radio` buttons with
 * `aria-checked`, and selection signalled by a tick AND a border as well as
 * colour. Every swatch is a real button, so touch works with no hover.
 */

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";

import { DEFAULT_BOARD_THEME, boardThemeFor } from "../../lib/solitaire-duel/boardThemes";
import { useSolitaireBoardTheme } from "../../hooks/useSolitaireBoardTheme";

/** Space kept between the sheet's top edge and the board's bottom edge. */
const SHEET_GAP_PX = 12;
/** Never shrink the sheet below this, even if that means it scrolls. */
const SHEET_MIN_PX = 180;

export default function SolitaireThemePicker({ className = "" }: { className?: string }) {
  const { theme, themeKey, themes, setTheme, reset, isDefault } = useSolitaireBoardTheme();
  const defaultLabel = boardThemeFor(DEFAULT_BOARD_THEME).label;
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const [sheetMaxPx, setSheetMaxPx] = useState<number | null>(null);

  const close = () => {
    if (detailsRef.current) detailsRef.current.open = false;
  };

  // The board is the one thing the sheet may not cover. Measured on open and on
  // resize, because the board's height depends on the viewport and the game
  // mode. No board (a page that only previews the picker) falls back to 70vh.
  useEffect(() => {
    const details = detailsRef.current;
    if (!details) return undefined;

    const measure = () => {
      if (!details.open) return;
      const board = document.querySelector('[data-testid="solitaire-board"]');
      const room = board
        ? window.innerHeight - board.getBoundingClientRect().bottom - SHEET_GAP_PX
        : Math.round(window.innerHeight * 0.7);
      setSheetMaxPx(Math.max(SHEET_MIN_PX, Math.floor(room)));
    };

    details.addEventListener("toggle", measure);
    window.addEventListener("resize", measure);
    return () => {
      details.removeEventListener("toggle", measure);
      window.removeEventListener("resize", measure);
    };
  }, []);

  return (
    <details
      ref={detailsRef}
      className={`relative inline-block ${className}`}
      data-testid="solitaire-theme-picker"
    >
      <summary
        className="flex cursor-pointer list-none items-center gap-2 rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-xs font-semibold text-white/80 transition hover:border-white/30 hover:text-white focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#00e5ff] [&::-webkit-details-marker]:hidden"
        aria-label={`Table theme: ${theme.label}. Choose a Solitaire table theme`}
      >
        <span
          aria-hidden="true"
          className="h-4 w-4 shrink-0 rounded-full border border-black/40"
          style={{ backgroundImage: theme.felt }}
        />
        <span className="whitespace-nowrap">Table · {theme.label}</span>
        <span aria-hidden="true" className="text-white/40">
          ▾
        </span>
      </summary>

      {/* Phone-only scrim. Clicking it closes the sheet; it is never rendered on
          the desktop popover, which is non-modal. */}
      <button
        type="button"
        aria-label="Close table theme"
        onClick={close}
        className="fixed inset-0 z-[60] bg-black/60 sm:hidden"
        tabIndex={-1}
      />

      <div
        role="dialog"
        aria-label="Solitaire table theme"
        style={{ "--sheet-max": sheetMaxPx ? `${sheetMaxPx}px` : "70vh" } as CSSProperties}
        data-testid="solitaire-theme-panel"
        className="fixed inset-x-0 bottom-0 z-[61] max-h-[var(--sheet-max)] overflow-y-auto rounded-t-2xl border-t border-white/15 bg-[#040d24]/98 p-4 text-left shadow-2xl backdrop-blur-md sm:absolute sm:inset-x-auto sm:bottom-auto sm:right-0 sm:top-full sm:z-30 sm:mt-2 sm:max-h-none sm:w-[min(21rem,calc(100vw-2rem))] sm:overflow-visible sm:rounded-xl sm:border sm:p-3"
      >
        <span
          aria-hidden="true"
          className="mx-auto mb-2 block h-1 w-10 rounded-full bg-white/20 sm:hidden"
        />
        <div className="flex items-center justify-between gap-2">
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-white/50">Table theme</p>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={reset}
              disabled={isDefault}
              aria-label={`Reset to ${defaultLabel}`}
              className="rounded-md border border-white/15 px-2 py-1 text-[11px] font-semibold text-white/70 transition hover:border-white/30 hover:text-white disabled:cursor-default disabled:opacity-40 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
            >
              Reset
            </button>
            <button
              type="button"
              onClick={close}
              data-testid="solitaire-theme-sheet-done"
              className="rounded-md border border-[#00e5ff]/40 bg-[#00e5ff]/10 px-2 py-1 text-[11px] font-semibold text-[#b9f7ff] transition hover:bg-[#00e5ff]/20 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#00e5ff] sm:hidden"
            >
              Done
            </button>
          </div>
        </div>

        <div role="radiogroup" aria-label="Solitaire table theme" className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
          {themes.map((option) => {
            const checked = option.key === themeKey;
            return (
              <button
                key={option.key}
                type="button"
                role="radio"
                aria-checked={checked}
                data-theme-key={option.key}
                title={option.blurb}
                onClick={() => setTheme(option.key)}
                className={`flex items-center gap-2 rounded-lg border p-1.5 text-left text-[11px] font-semibold transition focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#00e5ff] ${
                  checked
                    ? "border-[#f5ff3b] bg-[#f5ff3b]/10 text-white"
                    : "border-white/15 text-white/70 hover:border-white/30 hover:text-white"
                }`}
              >
                <span
                  aria-hidden="true"
                  className="h-7 w-7 shrink-0 rounded-md border border-black/40 shadow-inner"
                  style={{ backgroundImage: option.felt }}
                />
                <span className="min-w-0 flex-1">{option.label}</span>
                {/* Selection is never colour-only: the tick is the cue, the
                    border is the reinforcement. */}
                <span aria-hidden="true" className={checked ? "text-[#f5ff3b]" : "opacity-0"}>
                  ✓
                </span>
              </button>
            );
          })}
        </div>

        <p className="mt-2 text-[10px] leading-relaxed text-white/45">
          Changes the table only — the cards, their faces and the rules stay exactly the same.
        </p>
      </div>
    </details>
  );
}
