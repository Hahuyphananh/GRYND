"use client";

// src/components/game/emotes/GameEmoteLayer.tsx
//
// The single emote surface for a multiplayer match. Mount it ONCE per match
// page, next to the controls it should sit beside:
//
//   <GameEmoteLayer
//     gameId="chess"
//     incomingEmote={incomingEmote}
//     myEmote={myEmote}
//     onSend={(emote) => sendEmote(emote)}
//     opponentLabel={opponentName}
//   />
//
// It renders three things and owns no socket logic:
//   1. the opponent's bubble — fixed to the top of the screen, labelled with
//      their name (this is what the old per-game bubbles got wrong in odds and
//      precision, where the reaction appeared above your own emote button);
//   2. your own bubble — bottom-right, above the app's bottom UI, safe-area
//      aware and mirrored in cyan;
//   3. the quick bar + wheel, in the flow where you mounted it.
//
// Bubbles are portalled to <body>: pages wrap themselves in animated
// (transform/filter) containers, and a `position: fixed` child of a transformed
// ancestor is positioned against that ancestor instead of the viewport.
//
// Cooldown lives here (not in the socket hook) because it is a UI/anti-spam
// rule: 2.5 s between sends per player. The realtime server enforces its own
// limit as the authority.

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import EmoteBar from "./EmoteBar";
import EmoteBubble from "./EmoteBubble";
import EmoteWheel from "./EmoteWheel";
import {
  EMOTE_COOLDOWN_MS,
  useEmoteLoadout,
  useEmoteSettings,
  type EmoteChoice,
  type EmotePayload,
} from "./useEmoteLoadout";

export type GameEmoteLayerProps = {
  /** Used for layout/diagnostics and future per-game emote sets. */
  gameId: string;
  /** Latest emote received from the opponent (cleared by useGameEmotes). */
  incomingEmote?: EmotePayload;
  /** Your own last emote (echoed locally by useGameEmotes). */
  myEmote?: EmotePayload;
  /** Sends one emote over the game's existing socket event. */
  onSend: (emote: EmoteChoice) => void;
  /** Shown on the opponent bubble so it is always clear whose reaction it is. */
  opponentLabel?: string | null;
  compact?: boolean;
  className?: string;
};

export default function GameEmoteLayer({
  gameId,
  incomingEmote = null,
  myEmote = null,
  onSend,
  opponentLabel = null,
  compact = false,
  className = "",
}: GameEmoteLayerProps) {
  const { choices } = useEmoteLoadout();
  const { sendEnabled, muteOpponent, toggleSend, toggleMute } = useEmoteSettings();

  const [wheelOpen, setWheelOpen] = useState(false);
  const [cooling, setCooling] = useState(false);
  const [cooldownKey, setCooldownKey] = useState(0);
  const [portalReady, setPortalReady] = useState(false);

  const cooldownTimer = useRef<number | null>(null);

  // The bubble portal targets <body>, which only exists in the browser. Gating
  // on a post-mount flag keeps the first client render identical to the server
  // render (the ToastProvider learned the same lesson).
  useEffect(() => setPortalReady(true), []);

  useEffect(
    () => () => {
      if (cooldownTimer.current) window.clearTimeout(cooldownTimer.current);
    },
    [],
  );

  const pick = useCallback(
    (emote: EmoteChoice) => {
      // Sending disabled, or still cooling down: swallow the tap rather than
      // queue it. Nothing is replayed later.
      if (!sendEnabled || cooling) return;

      onSend(emote);
      setWheelOpen(false);
      setCooling(true);
      setCooldownKey((key) => key + 1);
      if (cooldownTimer.current) window.clearTimeout(cooldownTimer.current);
      cooldownTimer.current = window.setTimeout(
        () => setCooling(false),
        EMOTE_COOLDOWN_MS,
      );
    },
    [onSend, sendEnabled, cooling],
  );

  const showIncoming = Boolean(incomingEmote) && !muteOpponent;

  return (
    <div
      data-emote-layer=""
      data-game={gameId}
      className={`relative inline-flex items-center ${className}`}
    >
      {portalReady &&
        createPortal(
          <>
            {showIncoming ? (
              <div
                data-emote-position="opponent"
                aria-live="polite"
                className="pointer-events-none fixed inset-x-0 z-[65] flex justify-center px-3"
                style={{ top: "calc(var(--safe-top, 0px) + 5rem)" }}
              >
                <EmoteBubble
                  emote={incomingEmote}
                  side="incoming"
                  label={opponentLabel || "Opponent"}
                />
              </div>
            ) : null}
            {myEmote ? (
              <div
                data-emote-position="mine"
                className="pointer-events-none fixed inset-x-0 z-[65] flex justify-end px-3"
                style={{ bottom: "calc(var(--safe-bottom, 0px) + 6rem)" }}
              >
                <EmoteBubble emote={myEmote} side="mine" label="You" />
              </div>
            ) : null}
          </>,
          document.body,
        )}

      <EmoteBar
        choices={choices}
        onPick={pick}
        onOpenWheel={() => setWheelOpen((open) => !open)}
        wheelOpen={wheelOpen}
        disabled={!sendEnabled}
        cooling={cooling}
        cooldownKey={cooldownKey}
        compact={compact}
      />

      <EmoteWheel
        open={wheelOpen}
        choices={choices}
        onPick={pick}
        onClose={() => setWheelOpen(false)}
        sendEnabled={sendEnabled}
        muteOpponent={muteOpponent}
        onToggleSend={toggleSend}
        onToggleMute={toggleMute}
        compact={compact}
      />
    </div>
  );
}
