"use client";

// src/components/game/emotes/ChatEmoteTray.tsx
//
// The emote picker, inside the chat panel.
//
// It is the same EmoteBar + EmoteWheel pair the match pages used to show in
// their header — one-tap GG/NICE MOVE and pins, the full set and the send/mute
// controls behind the mood button — but it sends through emoteChannel into the
// match currently mounted, so reactions still travel over the game's socket
// event and land on the board as animated bubbles.
//
// The wheel renders INLINE here (`inline`), not as a popover: the chat panel is
// a fixed box with its own scroll, and a popover opening upward would escape
// it. `onOpenChange` lets the panel know to give the grid room by dropping the
// message list's minimum height.

import { useState } from "react";
import EmoteBar from "./EmoteBar";
import EmoteWheel from "./EmoteWheel";
import { useEmoteSender } from "./useEmoteSender";

export default function ChatEmoteTray({
  className = "",
  onOpenChange,
}: {
  className?: string;
  onOpenChange?: (open: boolean) => void;
}) {
  const {
    choices,
    send,
    cooling,
    cooldownKey,
    sendEnabled,
    muteOpponent,
    toggleSend,
    toggleMute,
  } = useEmoteSender();
  const [wheelOpen, setWheelOpen] = useState(false);

  const setOpen = (next: boolean) => {
    setWheelOpen(next);
    onOpenChange?.(next);
  };

  return (
    <div data-chat-emotes="" className={`relative mb-2 ${className}`}>
      {/* The full set opens UPWARD OVER the message list, still inside the chat
          panel. In flow it would grow the panel past its own max-height, and
          squeezing the list to make room leaves no chat to look at. */}
      <div className="absolute bottom-full left-0 right-0 z-30 mb-1">
        <EmoteWheel
          inline
          open={wheelOpen}
          choices={choices}
          onPick={(emote) => {
            send(emote);
            setOpen(false);
          }}
          onClose={() => setOpen(false)}
          sendEnabled={sendEnabled}
          muteOpponent={muteOpponent}
          onToggleSend={toggleSend}
          onToggleMute={toggleMute}
          compact
        />
      </div>

      <div className="overflow-x-auto pb-0.5">
        <EmoteBar
          choices={choices}
          onPick={send}
          onOpenWheel={() => setOpen(!wheelOpen)}
          wheelOpen={wheelOpen}
          disabled={!sendEnabled}
          cooling={cooling}
          cooldownKey={cooldownKey}
          compact
        />
      </div>
    </div>
  );
}
