"use client";

// src/components/game/EmotePicker.jsx
//
// DEPRECATED — kept as a compatibility shim.
//
// The emote UI now lives in ./emotes (EmoteBar, EmoteWheel, EmoteBubble,
// GameEmoteLayer) and every multiplayer match mounts GameEmoteLayer once. This
// file remains so older imports keep working — including the QA harnesses that
// stub this module path — and simply composes the new pieces with the old
// prop shape.

import { useState } from "react";

import EmoteBar from "./emotes/EmoteBar";
import EmoteWheel from "./emotes/EmoteWheel";
import EmoteBubbleDefault from "./emotes/EmoteBubble";
import { useEmoteLoadout, useEmoteSettings } from "./emotes/useEmoteLoadout";

export { default as EmoteArtwork } from "./emotes/EmoteArtwork";
export { default as EmoteBubble } from "./emotes/EmoteBubble";
export {
  PERMANENT_TEXT_EMOTES,
  EMOTE_COOLDOWN_MS,
  EMOTE_SLOT_COUNT,
} from "./emotes/useEmoteLoadout";

export default function EmotePicker({
  onSend,
  incomingEmote = null,
  myEmote = null,
  compact = false,
  hideBubbles = false,
}) {
  const { choices } = useEmoteLoadout();
  const { sendEnabled, muteOpponent, toggleSend, toggleMute } = useEmoteSettings();
  const [open, setOpen] = useState(false);

  const pick = (emote) => {
    if (!sendEnabled) return;
    onSend?.(emote);
    setOpen(false);
  };

  return (
    <div className="relative z-30 flex items-center gap-2">
      {!hideBubbles && incomingEmote && !muteOpponent && (
        <div className="absolute bottom-14 left-0">
          <EmoteBubbleDefault emote={incomingEmote} side="incoming" />
        </div>
      )}
      {!hideBubbles && myEmote && (
        <div className="absolute bottom-14 right-0">
          <EmoteBubbleDefault emote={myEmote} side="mine" />
        </div>
      )}

      <EmoteBar
        choices={choices}
        onPick={pick}
        onOpenWheel={() => setOpen((value) => !value)}
        wheelOpen={open}
        disabled={!sendEnabled}
        compact={compact}
      />

      <EmoteWheel
        open={open}
        choices={choices}
        onPick={pick}
        onClose={() => setOpen(false)}
        sendEnabled={sendEnabled}
        muteOpponent={muteOpponent}
        onToggleSend={toggleSend}
        onToggleMute={toggleMute}
        compact={compact}
      />
    </div>
  );
}
