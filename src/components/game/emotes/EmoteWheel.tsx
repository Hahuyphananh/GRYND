"use client";

// src/components/game/emotes/EmoteWheel.tsx
//
// The full emote set behind one trigger: hold/tap the mood button in the bar
// and the whole loadout (2 word emotes + up to 9 equipped pins) opens as a
// grid above it.
//
// This is where the old picker's grid went — including its "Emote controls"
// (stop sending / mute the opponent), which stay here for now so no existing
// preference is lost.
//
// `inline` renders the same panel IN FLOW instead of as an upward popover. The
// chat hosts it: the chat is a fixed box with its own scroll, so a popover
// opening above the trigger would sit outside it.

import { useEffect } from "react";
import EmoteArtwork from "./EmoteArtwork";
import type { EmoteChoice } from "./useEmoteLoadout";

export default function EmoteWheel({
  open,
  choices,
  onPick,
  onClose,
  sendEnabled,
  muteOpponent,
  onToggleSend,
  onToggleMute,
  compact = false,
  inline = false,
}: {
  open: boolean;
  choices: EmoteChoice[];
  onPick: (emote: EmoteChoice) => void;
  onClose: () => void;
  sendEnabled: boolean;
  muteOpponent: boolean;
  onToggleSend: () => void;
  onToggleMute: () => void;
  compact?: boolean;
  inline?: boolean;
}) {
  // Escape closes the wheel. Registered only while it is open, and removed on
  // close/unmount, so no listener accumulates across a match.
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className={
        inline
          ? "relative z-40 w-full"
          : "absolute bottom-full left-1/2 z-40 mb-2 w-[min(20rem,calc(100vw-1.5rem))] -translate-x-1/2"
      }
    >
      {/* Click-away layer: invisible, behind the panel. Inline inside the chat
          the ✕ (and the trigger) already close it, and a fixed overlay there
          would swallow the rest of the chat. */}
      {!inline ? (
        <div
          aria-hidden="true"
          onClick={onClose}
          className="fixed inset-0 -z-10"
        />
      ) : null}
      <div
        role="dialog"
        aria-label="Emotes"
        data-emote-wheel=""
        className={`rounded-2xl border border-[#00e5ff]/40 bg-[#040d24]/97 p-3 shadow-[0_0_28px_rgba(0,229,255,.28)] backdrop-blur-md ${
          compact ? "origin-bottom scale-95" : ""
        }`}
      >
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-[#00e5ff]/70">
            Emotes
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close emotes"
            className="rounded-md px-1 text-xs font-bold text-white/50 transition hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
          >
            ✕
          </button>
        </div>

        <div className="grid max-h-[min(30vh,14rem)] grid-cols-3 gap-2 overflow-y-auto">
          {choices.map((emote) => (
            <button
              key={emote.id}
              type="button"
              data-emote-choice={emote.key}
              onClick={() => onPick(emote)}
              disabled={!sendEnabled}
              aria-label={`Send ${emote.label}`}
              className="flex h-14 items-center justify-center rounded-xl border border-white/10 bg-[#071531] transition hover:border-[#00e5ff]/70 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {emote.kind === "word" ? (
                <span className="max-w-[4.5rem] text-center text-[9px] font-black leading-[1.05] tracking-tight text-[#f5ff3b]">
                  {emote.value}
                </span>
              ) : (
                <EmoteArtwork emote={emote} imageClassName="h-10 w-10" />
              )}
            </button>
          ))}
        </div>

        {/* Two columns: the controls are two buttons, and stacking them made the
            inline tray tall enough to push the chat composer out of its panel. */}
        <div className="mt-2 grid grid-cols-2 gap-1.5 border-t border-white/10 pt-2">
          <span className="col-span-2 text-center text-[9px] font-bold uppercase tracking-[0.16em] text-white/40">
            Emote controls
          </span>
          <button
            type="button"
            onClick={onToggleSend}
            className="rounded-lg border border-white/10 px-2 py-1.5 text-[10px] font-bold uppercase tracking-wider text-white/70 transition hover:bg-white/10"
          >
            {sendEnabled ? "Disable sending" : "Enable sending"}
          </button>
          <button
            type="button"
            onClick={onToggleMute}
            className="rounded-lg border border-white/10 px-2 py-1.5 text-[10px] font-bold uppercase tracking-wider text-white/70 transition hover:bg-white/10"
          >
            {muteOpponent ? "Unmute opponent" : "Mute opponent emotes"}
          </button>
        </div>
      </div>
    </div>
  );
}
