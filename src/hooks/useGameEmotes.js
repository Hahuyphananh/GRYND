"use client";

// src/hooks/useGameEmotes.js
//
// Shared emote wiring for multiplayer games. The realtime server's generic
// `room_event` handler broadcasts any event name to a socket room, so a game
// only needs to:
//   1. join a dedicated per-match emote room,
//   2. listen for its emote event,
//   3. emit `room_event` with the same event when the player sends one.
//
// The server already excludes the sender from the broadcast (socket.to), so
// the `selfId` check below is only a belt-and-suspenders guard.
//
// Usage:
//   const { incomingEmote, myEmote, sendEmote } = useGameEmotes({
//     socket,
//     roomId: `mines:emote:${matchId}`,
//     eventName: "mines:emote",
//     selfId: user?.id,
//   });
//   ... <EmotePicker onSend={(emote) => sendEmote(emote)} ... />

import { useCallback, useEffect, useState } from "react";

const EMOTE_CLEAR_MS = 3000;

export default function useGameEmotes({ socket, roomId, eventName, selfId }) {
  const [incomingEmote, setIncomingEmote] = useState(null);
  const [incomingSenderId, setIncomingSenderId] = useState(null);
  const [myEmote, setMyEmote] = useState(null);

  useEffect(() => {
    if (!socket || !roomId || !eventName) return;

    socket.emit("join_room", { roomId });

    const handleEmote = (payload) => {
      if (payload?.senderId && payload.senderId === selfId) return;
      setIncomingEmote(payload?.emote || null);
      setIncomingSenderId(payload?.senderId ?? null);
      window.setTimeout(() => setIncomingEmote(null), EMOTE_CLEAR_MS);
      window.setTimeout(() => setIncomingSenderId(null), EMOTE_CLEAR_MS);
    };
    socket.on(eventName, handleEmote);

    return () => {
      socket.emit("leave_room", { roomId });
      socket.off(eventName, handleEmote);
    };
  }, [socket, roomId, eventName, selfId]);

  const sendEmote = useCallback(
    (emote) => {
      // LOCAL-FIRST: the sender's own bubble is shown unconditionally, so
      // clicking an emote always pops it on your name even when the socket
      // isn't connected/joined yet (e.g. the room id is set a tick after the
      // picker mounts). The broadcast below is then best-effort — if we
      // can't emit now, the next successful send will carry it.
      setMyEmote(emote);
      window.setTimeout(() => setMyEmote(null), EMOTE_CLEAR_MS);
      if (!socket || !roomId || !eventName) return;
      socket.emit("room_event", {
        roomId,
        event: eventName,
        payload: { emote, senderId: selfId },
      });
    },
    [socket, roomId, eventName, selfId]
  );

  return { incomingEmote, incomingSenderId, myEmote, sendEmote };
}
