"use client";

/**
 * src/components/solitaire-duel/SolitaireThemePicker.tsx
 *
 * THE Solitaire table selector: six swatches, the current one ticked, and a
 * reset to Classic Green.
 *
 * It is a POPOVER on purpose. The Solitaire page's height budget is what keeps
 * the whole tableau above the fold (`--cw` in SolitaireBoard is capped by the
 * viewport), so a permanent six-tile grid in the header would push the board
 * down. Collapsed, this is one small button (its label already names the active
 * theme); expanded, it is an absolutely-positioned panel that changes no layout.
 *
 * Accessibility: a real `<details>`/`<summary>` disclosure (keyboard and screen
 * reader behaviour for free), options as a `radiogroup` of `radio` buttons with
 * `aria-checked`, and selection signalled by a tick AND a border as well as
 * colour. Every swatch is a real button, so touch works with no hover.
 */

import { DEFAULT_BOARD_THEME, boardThemeFor } from "../../lib/solitaire-duel/boardThemes";
import { useSolitaireBoardTheme } from "../../hooks/useSolitaireBoardTheme";

export default function SolitaireThemePicker({ className = "" }: { className?: string }) {
  const { theme, themeKey, themes, setTheme, reset, isDefault } = useSolitaireBoardTheme();
  const defaultLabel = boardThemeFor(DEFAULT_BOARD_THEME).label;

  return (
    <details className={`relative inline-block ${className}`} data-testid="solitaire-theme-picker">
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

      <div className="absolute right-0 z-30 mt-2 w-[min(21rem,calc(100vw-2rem))] rounded-xl border border-white/15 bg-[#040d24]/97 p-3 text-left shadow-2xl backdrop-blur-md">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-white/50">Table theme</p>
          <button
            type="button"
            onClick={reset}
            disabled={isDefault}
            aria-label={`Reset to ${defaultLabel}`}
            className="rounded-md border border-white/15 px-2 py-1 text-[11px] font-semibold text-white/70 transition hover:border-white/30 hover:text-white disabled:cursor-default disabled:opacity-40 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
          >
            Reset
          </button>
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
