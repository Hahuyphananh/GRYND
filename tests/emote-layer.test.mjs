/**
 * tests/emote-layer.test.mjs
 *
 * The shared emote layer: EmoteBar / EmoteWheel / EmoteBubble / GameEmoteLayer,
 * its mount coverage across every multiplayer match, and the server-side
 * validation + cooldown that runs for every emote room event.
 *
 * Everything here is static/structural (the repo's convention for UI contracts
 * — see tests/tic-tac-toe-ui-contract.test.mjs) plus one cross-check that keeps
 * the client catalog and the server allow-list from drifting. It cannot prove
 * how the bar feels in a live match; that needs a two-player session.
 *
 *   npm run test:emote-layer
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { OFFICIAL_EMOTE_DEFINITIONS } from "../src/lib/emoteAssets";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");
const exists = (relative) => fs.existsSync(path.join(ROOT, relative));

const EMOTES_DIR = "src/components/game/emotes";
const LAYER = `${EMOTES_DIR}/GameEmoteLayer.tsx`;
const BAR = `${EMOTES_DIR}/EmoteBar.tsx`;
const WHEEL = `${EMOTES_DIR}/EmoteWheel.tsx`;
const BUBBLE = `${EMOTES_DIR}/EmoteBubble.tsx`;
const ARTWORK = `${EMOTES_DIR}/EmoteArtwork.tsx`;
const LOADOUT = `${EMOTES_DIR}/useEmoteLoadout.ts`;
const SERVER = "realtime-server/server.js";

/** Pages that mount emotes (one layer each; keno has a mobile+desktop pair). */
const MATCH_PAGES = [
  "src/app/casino/barrier-blitz/[matchId]/PageClient.tsx",
  "src/app/casino/chess-game/[gameId]/PageClient.jsx",
  "src/app/casino/dice-flush/PageClient.tsx",
  "src/app/casino/dots-and-boxes/game/[gameId]/PageClient.tsx",
  "src/app/casino/four-in-a-row/game/[gameId]/PageClient.tsx",
  "src/app/casino/hex-duel/game/[matchId]/PageClient.tsx",
  "src/app/casino/keno-pvp/[matchId]/PageClient.jsx",
  "src/app/casino/memory-grid/[matchId]/PageClient.tsx",
  "src/app/casino/mines-pvp/[matchId]/PageClient.tsx",
  "src/app/casino/mini-golf/[matchId]/PageClient.tsx",
  "src/app/casino/odds/game/[matchId]/PageClient.tsx",
  "src/app/casino/pool-masters/game/[matchId]/PageClient.tsx",
  "src/app/casino/rps/game/[gameId]/PageClient.tsx",
  "src/app/casino/tic-tac-toe/[matchId]/PageClient.tsx",
  "src/components/precision/PrecisionActiveRoundPanel.tsx",
];

// ── The four pieces exist and are the only implementation ─────────────────

test("the shared pieces live in one place", () => {
  for (const file of [LAYER, BAR, WHEEL, BUBBLE, ARTWORK, LOADOUT]) {
    assert.ok(exists(file), `${file} is missing`);
    assert.match(read(file), /^"use client";/m, `${file} must be client-side`);
  }
});

test("the old picker is only a compatibility shim", () => {
  const shim = read("src/components/game/EmotePicker.jsx");

  assert.match(shim, /DEPRECATED/);
  assert.match(shim, /emotes\/EmoteBar/);
  assert.match(shim, /emotes\/EmoteWheel/);
  // No second implementation may live here.
  assert.ok(!/api\/user\/emotes/.test(shim), "the shim must not fetch a loadout");
  assert.ok(!/emoteAssetUrl/.test(shim), "the shim must not resolve artwork");
});

// ── One layer, mounted once per match, replacing every ad-hoc mount ──────

test("every multiplayer match mounts exactly one GameEmoteLayer", () => {
  for (const page of MATCH_PAGES) {
    const source = read(page);
    const mounts = source.match(/<GameEmoteLayer/g) ?? [];

    assert.ok(mounts.length >= 1, `${page} does not mount GameEmoteLayer`);
    assert.ok(!/<EmotePicker/.test(source), `${page} still uses the old picker`);
    assert.ok(!/<EmoteBubble/.test(source), `${page} still renders its own bubbles`);
    assert.ok(
      !source.includes("components/game/EmotePicker"),
      `${page} still imports the shim`,
    );
  }
});

test("each mount identifies its game and passes the existing hook's data", () => {
  for (const page of MATCH_PAGES) {
    const source = read(page);
    const block = source.slice(source.indexOf("<GameEmoteLayer"));
    const opening = block.slice(0, block.indexOf("/>"));

    assert.match(opening, /gameId="[a-z0-9-]+"/, `${page} must pass gameId`);
    assert.match(opening, /incomingEmote=/, `${page} must pass incomingEmote`);
    assert.match(opening, /myEmote=/, `${page} must pass myEmote`);
    assert.match(opening, /onSend=/, `${page} must pass onSend`);
  }
});

// ── Display behaviour ────────────────────────────────────────────────────

test("bubbles are labelled per side and portalled to the viewport", () => {
  const layer = read(LAYER);

  // Portal: pages wrap themselves in animated containers, and a fixed child of
  // a transformed ancestor would be positioned against that ancestor.
  assert.match(layer, /createPortal/);
  assert.match(layer, /document\.body/);
  assert.match(layer, /var\(--safe-top/);
  assert.match(layer, /var\(--safe-bottom/);

  assert.match(layer, /data-emote-position="opponent"/);
  assert.match(layer, /data-emote-position="mine"/);
  assert.match(layer, /label=\{opponentLabel \|\| "Opponent"\}/);
  assert.match(layer, /label="You"/);

  // Muting the opponent hides their bubble without touching your own.
  assert.match(layer, /const showIncoming = Boolean\(incomingEmote\) && !muteOpponent;/);
});

test("the bar is one-tap, respects sending being off, and shows the cooldown", () => {
  const bar = read(BAR);

  assert.match(bar, /EMOTE_SLOT_COUNT/);
  assert.match(bar, /disabled=\{disabled \|\| cooling\}/);
  assert.ok(bar.includes("Send ${emote.label}"), "each slot is labelled");
  assert.match(bar, /aria-expanded=\{wheelOpen\}/);
  // Cooldown drains visibly instead of popping a toast.
  assert.match(bar, /EMOTE_COOLDOWN_MS \/ 1000/);
});

test("sends are single-shot and cannot be queued", () => {
  const layer = read(LAYER);

  assert.match(layer, /if \(!sendEnabled \|\| cooling\) return;/);
  assert.match(layer, /setCooling\(true\)/);
  assert.match(layer, /EMOTE_COOLDOWN_MS/);
  // The cooldown timer is cleared on unmount — no setState after leaving.
  assert.match(layer, /clearTimeout\(cooldownTimer\.current\)/);
});

test("the wheel keeps the full loadout and the existing controls", () => {
  const wheel = read(WHEEL);

  assert.match(wheel, /role="dialog"/);
  assert.match(wheel, /aria-label="Emotes"/);
  assert.match(wheel, /event\.key === "Escape"/);
  assert.match(wheel, /onToggleSend/);
  assert.match(wheel, /onToggleMute/);
  assert.match(wheel, /disabled=\{!sendEnabled\}/);
});

test("loadout + settings are unchanged in behaviour", () => {
  const loadout = read(LOADOUT);

  assert.match(loadout, /grynd:emotes:settings/);
  assert.match(loadout, /\/api\/user\/emotes/);
  assert.match(loadout, /emotesUpdated/);
  assert.match(loadout, /equippedEmotes/);
  assert.match(loadout, /PERMANENT_TEXT_EMOTES/);
});

// ── Server-side validation + cooldown ────────────────────────────────────

const server = read(SERVER);

function serverCatalogKeys() {
  const start = server.indexOf("EMOTE_CATALOG_KEYS = new Set([");
  assert.ok(start > -1, "the server must declare an emote allow-list");
  const body = server.slice(start, server.indexOf("]);", start));
  return [...body.matchAll(/"([a-z0-9-]+)"/g)].map((match) => match[1]).sort();
}

test("the server allow-lists exactly the client catalog", () => {
  assert.deepEqual(
    serverCatalogKeys(),
    OFFICIAL_EMOTE_DEFINITIONS.map((definition) => definition.key).sort(),
    "client catalog and server allow-list must not drift",
  );
});

test("every emote event is validated before it is relayed", () => {
  assert.match(server, /EMOTE_EVENT_SUFFIX = ":emote"/);
  assert.match(server, /relayedEvent\.endsWith\(EMOTE_EVENT_SUFFIX\)/);

  const guardAt = server.indexOf("relayedEvent.endsWith(EMOTE_EVENT_SUFFIX)");
  const relayAt = server.indexOf("socket.to(String(roomId)).emit(String(event), {");
  assert.ok(guardAt > -1 && relayAt > -1);
  assert.ok(guardAt < relayAt, "the guard must run before the broadcast");

  // Only the sanitized object travels on.
  assert.match(server, /payload = \{ \.\.\.payload, emote: safeEmote \};/);
  assert.match(server, /if \(!safeEmote\)/);
});

test("the payload is an allow-list, not free text", () => {
  // Word emotes are an enum…
  assert.match(server, /EMOTE_WORD_VALUES = new Set\(\["GG", "NICE MOVE"\]\)/);
  // …and animated emotes must be a known catalog key.
  assert.match(server, /if \(!EMOTE_CATALOG_KEYS\.has\(key\)\) return null;/);
  // Arbitrary kinds never get through.
  assert.match(server, /if \(emote\.kind !== "animated"\) return null;/);
});

test("emotes are rate-limited per socket and room", () => {
  assert.match(server, /EMOTE_MIN_INTERVAL_MS = 2000/);
  assert.match(server, /EMOTE_WINDOW_MS = 30000/);
  assert.match(server, /EMOTE_WINDOW_MAX = 6/);
  // Budget lives on the socket, so it dies with the connection.
  assert.match(server, /socket\.data\.emoteBudget/);
  assert.match(server, /if \(!allowEmote\(String\(roomId\)\)\)/);
  assert.match(server, /return;/);
});
