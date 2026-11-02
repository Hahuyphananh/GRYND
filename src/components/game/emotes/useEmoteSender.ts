"use client";

// src/components/game/emotes/useEmoteSender.ts
//
// The send side of the emote UI, used by the tray inside the chat.
//
// It owns the two anti-spam rules that used to live in GameEmoteLayer now that
// the picking happens in the chat:
//   * sending can be switched off per device (`sendEnabled`);
//   * one emote every EMOTE_COOLDOWN_MS — a tap during the cooldown is
//     swallowed, never queued, so nothing fires late.
//
// The actual delivery is delegated to whichever match page registered itself
// in emoteChannel, which is why this hook can live in the global chat.

import { useCallback, useEffect, useRef, useState } from "react";
import { getEmoteChannel, useActiveEmoteChannel } from "./emoteChannel";
import {
  EMOTE_COOLDOWN_MS,
  useEmoteLoadout,
  useEmoteSettings,
  type EmoteChoice,
} from "./useEmoteLoadout";

export function useEmoteSender() {
  const channel = useActiveEmoteChannel();
  const { choices } = useEmoteLoadout();
  const { sendEnabled, muteOpponent, toggleSend, toggleMute } = useEmoteSettings();

  const [cooling, setCooling] = useState(false);
  const [cooldownKey, setCooldownKey] = useState(0);
  const cooldownTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (cooldownTimer.current) window.clearTimeout(cooldownTimer.current);
    },
    [],
  );

  const send = useCallback(
    (emote: EmoteChoice) => {
      // Sending disabled, still cooling down, or no match mounted: swallow the
      // tap rather than queue it. Nothing is replayed later.
      if (!sendEnabled || cooling) return;
      const target = getEmoteChannel();
      if (!target) return;

      target.send(emote);

      setCooling(true);
      setCooldownKey((key) => key + 1);
      if (cooldownTimer.current) window.clearTimeout(cooldownTimer.current);
      cooldownTimer.current = window.setTimeout(
        () => setCooling(false),
        EMOTE_COOLDOWN_MS,
      );
    },
    [sendEnabled, cooling],
  );

  return {
    channel,
    choices,
    send,
    cooling,
    cooldownKey,
    sendEnabled,
    muteOpponent,
    toggleSend,
    toggleMute,
  };
}
