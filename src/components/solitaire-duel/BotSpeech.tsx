"use client";

// src/components/solitaire-duel/BotSpeech.tsx
//
// The opponent's voice, in ONE compact row: an optional bot avatar, an optional
// identity header (`children`), and a fixed-height speech slot.
//
// The component is a renderer only. It receives the line the Phase 2 director
// already selected and resolves its Phase 1 translation key through `t()`; it
// contains no event detection, no selection, no timing and no game knowledge.
//
// SPACE: the slot is a fixed 36px, two-line clamp. That is deliberately the
// height the opponent strip already spent on the bot description, so replacing
// that line with this component does not add a tall panel above the board (the
// board's card size is derived from a `100vh - 17rem` budget).
//
// INPUT: the live region is `pointer-events-none` and the component renders no
// controls, so it can never steal a click, a tap or focus from the board.
//
// SEPARATION: this is the OPPONENT speaking. It never touches the application
// mascot (`GlitchSay`, `GlitchBubble`, `useGlitch`) — Glitch's avatar is reused
// roster art for the sixth bot, not the mascot's voice.

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import type { ReactNode } from "react";

import BotAvatar from "./BotAvatar";
import type { SolitaireBot } from "../../lib/solitaire-duel/bots";
import type { SolitaireBotDialogueLine } from "../../lib/solitaire-duel/dialogueDirector";
import { useTranslation } from "../../hooks/useTranslation";

// The match DTO carries the bot id as a string (it comes from an API payload);
// the roster's `SolitaireBotId` is a narrower view of the same value.
type SpeechBot = Pick<SolitaireBot, "name" | "initials" | "avatar"> & {
  id: string;
};

export default function BotSpeech({
  bot,
  line,
  fallback = null,
  children = null,
  showAvatar = true,
  testId = "solitaire-bot-speech",
}: {
  /** The public bot identity — avatar and initials only. */
  bot: SpeechBot;
  /** The director's current line, or null when the character is silent. */
  line: SolitaireBotDialogueLine | null;
  /** Muted text shown while silent (the roster description in the match strip). */
  fallback?: string | null;
  /** Optional identity row (name, rating, difficulty) rendered above the slot. */
  children?: ReactNode;
  /** The match strip already renders a 40px avatar; the result screen does not. */
  showAvatar?: boolean;
  testId?: string;
}) {
  const { t } = useTranslation();
  const reduceMotion = useReducedMotion();

  // One text slot: the chosen line wins, the fallback fills the silence.
  const text = line ? t(line.key) : fallback;
  const key = line ? line.id : "fallback";

  const transition = {
    duration: reduceMotion ? 0 : 0.16,
    ease: "easeOut" as const,
  };
  const initial = reduceMotion ? false : { opacity: 0, y: 3 };
  const exit = reduceMotion ? { opacity: 1 } : { opacity: 0, y: -2 };

  return (
    <div
      data-testid={testId}
      data-bot-id={bot.id}
      data-line-event={line?.event ?? "none"}
      className="flex min-w-0 flex-1 items-center gap-3"
    >
      {showAvatar && (
        <BotAvatar bot={bot} size="h-10 w-10" perfect={bot.id === "perfect"} />
      )}

      <div className="min-w-0 flex-1">
        {children}

        {/* ONE live region for the whole match. Polite, atomic, and inert to
            pointers so a bubble can never sit between the player and a card. */}
        <div
          role="status"
          aria-live="polite"
          aria-atomic="true"
          data-testid={`${testId}-live`}
          className="pointer-events-none mt-0.5 h-9 overflow-hidden"
        >
          <AnimatePresence mode="wait" initial={false}>
            {text ? (
              <motion.p
                key={key}
                initial={initial}
                animate={{ opacity: 1, y: 0 }}
                exit={exit}
                transition={transition}
                data-testid={`${testId}-text`}
                className={`line-clamp-2 text-[11px] leading-snug ${
                  line ? "font-medium text-violet-50" : "text-white/45"
                }`}
              >
                {text}
              </motion.p>
            ) : null}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
