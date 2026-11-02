"use client";

// src/components/game/emotes/GameEmoteLayer.tsx
//
// The single emote surface for a multiplayer match. Mount it ONCE per match
// page:
//
//   <GameEmoteLayer
//     gameId="chess"
//     incomingEmote={incomingEmote}
//     myEmote={myEmote}
//     onSend={(emote) => sendEmote(emote)}
//     opponentLabel={opponentName}
//   />
//
// It no longer renders a picker: the emote UI lives inside the chat panel
// (ChatEmoteTray), bottom-left on every page. What stays here is everything the
// chat cannot own:
//   1. the opponent's bubble — fixed to the top of the screen, labelled with
//      their name;
//   2. your own bubble — bottom-right, above the app's bottom UI, safe-area
//      aware and mirrored in cyan;
//   3. the delivery path: the match publishes its `onSend` to emoteChannel so
//      the chat can fire emotes over THIS match's socket event.
//
// Bubbles are portalled to <body>: pages wrap themselves in animated
// (transform/filter) containers, and a `position: fixed` child of a transformed
// ancestor is positioned against that ancestor instead of the viewport.
//
// The component renders no layout of its own (a fragment of portals), so the
// header rows that used to hold the bar lose the element rather than keeping an
// empty gap.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import EmoteBubble from "./EmoteBubble";
import { registerEmoteChannel } from "./emoteChannel";
import {
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
  /** Retained for the existing call sites; the picker now lives in the chat. */
  compact?: boolean;
  /** Retained for the existing call sites; nothing is laid out here any more. */
  className?: string;
};

export default function GameEmoteLayer({
  gameId,
  incomingEmote = null,
  myEmote = null,
  onSend,
  opponentLabel = null,
}: GameEmoteLayerProps) {
  const { muteOpponent } = useEmoteSettings();

  const [portalReady, setPortalReady] = useState(false);
  const sendRef = useRef(onSend);

  // Pages commonly pass an inline arrow, so its identity changes on every
  // render. Keeping it in a ref lets the registration below stay stable.
  useEffect(() => {
    sendRef.current = onSend;
  }, [onSend]);

  // The bubble portal targets <body>, which only exists in the browser. Gating
  // on a post-mount flag keeps the first client render identical to the server
  // render.
  useEffect(() => setPortalReady(true), []);

  // Publish this match's sender for the chat's emote tray.
  useEffect(
    () =>
      registerEmoteChannel({
        gameId,
        opponentLabel,
        send: (emote) => sendRef.current(emote),
      }),
    [gameId, opponentLabel],
  );

  const showIncoming = Boolean(incomingEmote) && !muteOpponent;

  return (
    <>
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
    </>
  );
}
