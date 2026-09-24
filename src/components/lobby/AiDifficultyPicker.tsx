"use client";

// src/components/lobby/AiDifficultyPicker.tsx
//
// The shared "choose the AI difficulty before you start" control.
//
// Rendered inside `PvpLobby`'s `children` slot (the lobby already documents
// that slot as "extra content inside the main card (e.g. difficulty pickers)"),
// so a game lobbies it in with one element and gets the same look, the same
// wording and the same persistence as every other game.
//
// Works both ways round:
//   * controlled   — pass `value` + `onChange` when the lobby owns the state in
//                    React (chess, hex-duel, dice-flush style: the value is
//                    sent with the create-AI request).
//   * uncontrolled — pass only `gameKey` when the choice is a device preference
//                    the match reads later via `readStoredAiDifficulty`.
//
// The choice is remembered per game via `storeAiDifficulty`, so a returning
// player does not re-pick it on every visit.

import { useCallback, useMemo, useState } from "react";
import { IconRobot } from "@tabler/icons-react";

import {
  AI_DIFFICULTIES,
  AI_DIFFICULTY_LABELS,
  DEFAULT_AI_DIFFICULTY,
  type AiDifficulty,
  readStoredAiDifficulty,
  storeAiDifficulty,
} from "../../lib/aiDifficulty";

export interface AiDifficultyPickerProps {
  /** Storage namespace — one per game, so tiers never overwrite each other. */
  gameKey: string;
  /** Controlled value. Omit to let the picker own the choice. */
  value?: AiDifficulty;
  /** Controlled change handler. Omit to let the picker own the choice. */
  onChange?: (next: AiDifficulty) => void;
  /** One line per tier explaining what it changes, shown under the chips. */
  hint?: Partial<Record<AiDifficulty, string>>;
  /** Static sub-line shown when `hint` has nothing for the current tier. */
  fallbackHint?: string;
  /** Heading over the chips. */
  title?: string;
  disabled?: boolean;
  className?: string;
}

export default function AiDifficultyPicker({
  gameKey,
  value,
  onChange,
  hint,
  fallbackHint = "Applies to free practice matches against the bot.",
  title = "AI Difficulty",
  disabled = false,
  className = "",
}: AiDifficultyPickerProps) {
  // Uncontrolled fallback: read the remembered tier once, on first render.
  const [internal, setInternal] = useState<AiDifficulty>(() => readStoredAiDifficulty(gameKey));
  const isControlled = value !== undefined;
  const current = isControlled ? value : internal;

  const choose = useCallback(
    (next: AiDifficulty) => {
      // Persist on every change, controlled or not: the choice is per-device by
      // design, so a page that forgets to send it still plays at the picked
      // tier next time.
      storeAiDifficulty(gameKey, next);
      if (!isControlled) setInternal(next);
      onChange?.(next);
    },
    [gameKey, isControlled, onChange]
  );

  const hintText = useMemo(() => hint?.[current] ?? fallbackHint, [hint, current, fallbackHint]);

  return (
    <div
      className={`mt-4 rounded-xl border border-cyan-500/25 bg-black/30 p-3 ${className}`}
      data-testid={`ai-difficulty-picker-${gameKey}`}
    >
      <div className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-cyan-300">
        <IconRobot className="h-4 w-4" />
        {title}
      </div>

      <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label={title}>
        {AI_DIFFICULTIES.map((tier) => {
          const active = tier === current;
          return (
            <button
              key={tier}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={disabled}
              onClick={() => choose(tier)}
              data-testid={`ai-difficulty-${gameKey}-${tier}`}
              className={`rounded-lg border px-2 py-2 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${
                active
                  ? "border-cyan-300/70 bg-cyan-400/20 text-cyan-100 shadow-[0_0_12px_rgba(34,211,238,0.25)]"
                  : "border-white/10 bg-white/[0.03] text-slate-300 hover:border-cyan-400/40 hover:bg-cyan-500/10"
              }`}
            >
              {AI_DIFFICULTY_LABELS[tier]}
            </button>
          );
        })}
      </div>

      {hintText && <p className="mt-2 text-[11px] leading-snug text-slate-400">{hintText}</p>}
    </div>
  );
}

/** Re-exported so a lobby can render its own label without importing twice. */
export { DEFAULT_AI_DIFFICULTY };
