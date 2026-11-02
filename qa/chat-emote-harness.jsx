// qa/chat-emote-harness.jsx
//
// Mounts the REAL ChatWidget (bottom-left on every page) against offline stubs,
// with a match's emote channel registered, so qa/chat-emote-check.mjs can
// verify in a browser what static tests cannot:
//
//   * the emote tray inside the chat, and that its animated assets load;
//   * the full set opening INLINE (not clipped outside the panel);
//   * sends going to the mounted match's channel;
//   * the unread badge on the launcher, raised by a message arriving while the
//     panel is closed and cleared when it opens.
//
// No network: fetch is a recorder that answers with shaped JSON, the socket is a
// fake whose handlers the check can fire, and the document is file://.

import React from "react";
import { createRoot } from "react-dom/client";
import ChatWidget from "../src/components/ChatWidget";
import { registerEmoteChannel } from "../src/components/game/emotes/emoteChannel";

const rec = { calls: [], sends: [] };
window.__chatQA = rec;

const GAME_ROOM = "/casino/dominoes/abc123";

const RESPONSES = {
  "/api/user/is-admin": { success: true, isAdmin: false },
  "/api/user/emotes": {
    success: true,
    emotes: [
      { key: "laugh", name: "Laugh" },
      { key: "fire", name: "Fire" },
      { key: "love", name: "Love" },
      { key: "shock", name: "Shock" },
      { key: "cry", name: "Cry" },
    ],
    equippedEmotes: ["laugh", "fire", "love", "shock", "cry"],
  },
  "/api/chat/messages": {
    success: true,
    messages: [
      {
        id: "seed-1",
        roomType: "game",
        roomId: GAME_ROOM,
        content: "good luck, have fun",
        displayName: "Rival",
        createdAt: new Date().toISOString(),
      },
    ],
  },
};

window.fetch = function (input, init) {
  const url = typeof input === "string" ? input : input?.url;
  const path = String(url).replace(/^https?:\/\/[^/]+/, "").split("?")[0];
  rec.calls.push({ path, method: String(init?.method || "GET").toUpperCase() });
  return Promise.resolve(
    new Response(JSON.stringify(RESPONSES[path] ?? { success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
};

// The emote channel a match page publishes on mount. Recording the send here is
// exactly what proves the chat reaches the game's socket event.
registerEmoteChannel({
  gameId: "dominoes",
  opponentLabel: "Rival",
  send: (emote) => rec.sends.push({ key: emote?.key, kind: emote?.kind }),
});

createRoot(document.getElementById("root")).render(<ChatWidget />);

requestAnimationFrame(() =>
  requestAnimationFrame(() => {
    setTimeout(() => {
      window.__chatReady = true;
    }, 500);
  }),
);
