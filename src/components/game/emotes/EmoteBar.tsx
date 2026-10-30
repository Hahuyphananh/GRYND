"use client";

// src/components/game/emotes/EmoteBar.tsx
//
// The always-visible quick bar: a small number of emotes you can fire with ONE
// tap mid-match, plus a trigger for the full wheel.
//
// Why a bar and not the old 🙋 popup: most reactions are sent in the two
// seconds after something happens, and making players open a modal first is
// what makes an emote system feel dead. The bar shows the first
// EMOTE_SLOT_COUNT choices (GG / NICE MOVE, then the equipped pins); the wheel
// holds the rest.
//
// While a cooldown runs, the bar disables itself and draws a thin draining
// line, so "why can't I send another" is answered visually instead of with a
// toast.

import { motion, useReducedMotion } from "framer-motion";
import { IconMoodSmile } from "@tabler/icons-react";
import EmoteArtwork from "./EmoteArtwork";
import {
  EMOTE_COOLDOWN_MS,
  EMOTE_SLOT_COUNT,
  type EmoteChoice,
} from "./useEmoteLoadout";

export default function EmoteBar({
  choices,
  onPick,
  onOpenWheel,
  wheelOpen = false,
  disabled = false,
  cooling = false,
  cooldownKey = 0,
  compact = false,
}: {
  choices: EmoteChoice[];
  onPick: (emote: EmoteChoice) => void;
  onOpenWheel: () => void;
  wheelOpen?: boolean;
  disabled?: boolean;
  cooling?: boolean;
  cooldownKey?: number;
  compact?: boolean;
}) {
  const shouldReduce = useReducedMotion();
  const slots = choices.slice(0, EMOTE_SLOT_COUNT);
  const slotSize = compact ? "h-8 w-8" : "h-9 w-9";
  const artSize = compact ? "h-6 w-6" : "h-7 w-7";

  return (
    <div
      data-emote-bar=""
      className="relative inline-flex items-center gap-1.5 rounded-full border border-[#00e5ff]/35 bg-[#040d24]/90 px-1.5 py-1 shadow-[0_0_18px_rgba(0,229,255,.18)] backdrop-blur-md"
    >
      {slots.map((emote) => (
        <button
          key={emote.id}
          type="button"
          data-emote-slot={emote.key}
          onClick={() => onPick(emote)}
          disabled={disabled || cooling}
          aria-label={`Send ${emote.label}`}
          className={`flex ${slotSize} items-center justify-center rounded-full border border-white/10 bg-[#071531] transition hover:scale-105 hover:border-[#00e5ff]/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:scale-100`}
        >
          {emote.kind === "word" ? (
            <span className="px-0.5 text-center text-[8px] font-black leading-[1.05] tracking-tight text-[#f5ff3b]">
              {emote.value === "NICE MOVE" ? "NICE" : emote.value}
            </span>
          ) : (
            <EmoteArtwork emote={emote} imageClassName={artSize} />
          )}
        </button>
      ))}

      <button
        type="button"
        onClick={onOpenWheel}
        aria-expanded={wheelOpen}
        aria-label="All emotes"
        className={`flex ${slotSize} items-center justify-center rounded-full border border-[#00e5ff]/45 bg-[#071531] text-[#00e5ff] transition hover:scale-105 hover:border-[#00e5ff] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff]`}
      >
        <IconMoodSmile size={compact ? 16 : 18} aria-hidden="true" />
      </button>

      {cooling ? (
        <motion.span
          key={cooldownKey}
          aria-hidden="true"
          initial={{ scaleX: 1 }}
          animate={{ scaleX: shouldReduce ? 0.999 : 0 }}
          transition={{ duration: EMOTE_COOLDOWN_MS / 1000, ease: "linear" }}
          className="absolute inset-x-1.5 -bottom-px h-0.5 origin-left rounded-full bg-[#00e5ff]/70"
        />
      ) : null}
    </div>
  );
}
