"use client";

// src/components/game/EmotePicker.jsx
//
// In-game emote picker + bubbles.
//
// The picker NO LONGER owns the emoji inventory. It shows:
//   1. PERMANENT_TEXT_EMOTES — GG and NICE MOVE. Always available to
//      everyone, rendered as text, never part of the 9-slot loadout.
//   2. The signed-in user's EQUIPPED animated emotes (max 9), fetched once
//      from GET /api/user/emotes (server-authoritative loadout persisted in
//      the database across devices/sessions).
// Locked / unowned / unequipped emotes are never shown here — the profile
// page (ChooseEmotesModal) is where players manage their loadout.
//
// The wire payload is a tiny stable object ({ key, kind, ... }) — never an
// asset URL. Receivers resolve keys through the official emote catalog
// (emoteAssetUrl) so a malicious/unknown key can never render an arbitrary
// image.
//
// Existing games keep working unchanged: EmotePicker / EmoteBubble /
// useGameEmotes APIs are unchanged. Animated emotes render their official
// /emotes/<key>.webp artwork (animated WebP plays natively); word emotes
// render text.

import { useEffect, useState } from "react";
import { emoteAssetUrl } from "../../lib/emoteAssets";

/**
 * Permanent text system emotes. GG and NICE MOVE are always available,
 * visually distinct from the animated Noto emotes, and are intentionally
 * NOT part of the database-owned 9-slot loadout.
 */
export const PERMANENT_TEXT_EMOTES = [
  { id: "gg", key: "gg", label: "GG", value: "GG", kind: "word" },
  { id: "nice-move", key: "nice-move", label: "Nice Move", value: "NICE MOVE", kind: "word" },
];

// The old hardcoded emoji inventory (laugh/wow/fire/cry) is deliberately
// gone: it has been replaced by the official animated Noto emote catalog
// (src/lib/emoteAssets.ts + the `emotes` table). GG / NICE MOVE remain as
// PERMANENT_TEXT_EMOTES above.

const STORAGE_KEY = "grynd:emotes:settings";

// ── Emote artwork renderer ─────────────────────────────────────────────
// Renders a word emote as text and an animated catalog emote as its official
// local asset (animated WebP plays in the browser). Asset resolution is
// allow-listed via emoteAssetUrl(key) — arbitrary values from a socket can
// never reach an <img src>; invalid/unknown keys render nothing (fail safe).
export function EmoteArtwork({ emote, imageClassName = "h-11 w-11", textClassName = "", onError = null }) {
  if (!emote) return null;
  if (emote.kind === "word") {
    return (
      <span className={textClassName || "font-black tracking-tight"}>{emote.value}</span>
    );
  }
  const assetUrl = emoteAssetUrl(emote.key);
  if (!assetUrl) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={assetUrl}
      alt=""
      aria-hidden="true"
      loading="lazy"
      draggable={false}
      className={`${imageClassName} object-contain select-none`}
      onError={(event) => {
        // Asset missing/disabled — hide it (fail safe, no broken image).
        event.currentTarget.style.display = "none";
        if (onError) onError();
      }}
    />
  );
}

// Small animated bubble shown near a player's name when an emote arrives.
// Drop it inside a `relative` container anchored to the name/avatar — e.g.
// `<span className="relative ...">{opponentName}<EmoteBubble emote={incomingEmote} /></span>`.
// `side` controls the color: "incoming" (opponent, fuchsia) vs "mine" (cyan).
export function EmoteBubble({ emote, side = "incoming" }) {
  if (!emote) return null;
  const isMine = side === "mine";
  return (
    <span
      role="status"
      aria-label={isMine ? "Your emote" : "Opponent emote"}
      className={`absolute bottom-full left-0 mb-1 whitespace-nowrap rounded-xl ${
        isMine ? "rounded-bl-sm border-cyan-300/60 shadow-[0_0_18px_rgba(0,229,255,.35)]" : "rounded-bl-sm border-fuchsia-300/60 shadow-[0_0_18px_rgba(255,60,172,.35)]"
      } border bg-[#071531] px-2 py-1 text-base`}
    >
      <EmoteArtwork emote={emote} imageClassName="h-7 w-7" />
    </span>
  );
}

// ── Server loadout fetching ────────────────────────────────────────────
// One lightweight fetch per page (never per popup-open). The module-level
// promise dedupes concurrent picker mounts, and the window "emotesUpdated"
// event invalidates it after a profile-page loadout save.
let emotesRequestPromise = null;

function requestEquippedEmotes() {
  if (!emotesRequestPromise) {
    emotesRequestPromise = fetch("/api/user/emotes", {
      credentials: "include",
      cache: "no-store",
    })
      .then((res) => res.json())
      .then((data) => (data && data.success === true ? data : null))
      .catch(() => null)
      .finally(() => {
        // Reset AFTER the request settles so late subscribers still get the
        // cached payload via the promise chain above.
        setTimeout(() => {
          emotesRequestPromise = null;
        }, 0);
      });
  }
  return emotesRequestPromise;
}

function invalidateEmotesCache() {
  emotesRequestPromise = null;
}

export default function EmotePicker({ onSend, incomingEmote = null, myEmote = null, compact = false, hideBubbles = false }) {
  const [open, setOpen] = useState(false);
  const [sendEnabled, setSendEnabled] = useState(true);
  const [muteOpponent, setMuteOpponent] = useState(false);
  const [visibleIncoming, setVisibleIncoming] = useState(null);
  // Loadout state: { emotes: catalogEntries, equippedEmotes: string[] }
  const [loadout, setLoadout] = useState(null);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      setSendEnabled(saved.sendEnabled !== false);
      setMuteOpponent(saved.muteOpponent === true);
    } catch {}
  }, []);

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ sendEnabled, muteOpponent })); } catch {}
  }, [sendEnabled, muteOpponent]);

  // Fetch the equipped loadout once when the picker mounts (not when the
  // popup opens). Signed-out / failed requests keep GG + NICE MOVE working.
  useEffect(() => {
    let cancelled = false;
    requestEquippedEmotes().then((data) => {
      if (cancelled || !data) return;
      setLoadout({
        emotes: Array.isArray(data.emotes) ? data.emotes : [],
        equippedEmotes: Array.isArray(data.equippedEmotes) ? data.equippedEmotes : [],
      });
    });
    const handleEmotesUpdated = () => {
      invalidateEmotesCache();
      requestEquippedEmotes().then((data) => {
        if (!data || cancelled) return;
        setLoadout({
          emotes: Array.isArray(data.emotes) ? data.emotes : [],
          equippedEmotes: Array.isArray(data.equippedEmotes) ? data.equippedEmotes : [],
        });
      });
    };
    window.addEventListener("emotesUpdated", handleEmotesUpdated);
    return () => {
      cancelled = true;
      window.removeEventListener("emotesUpdated", handleEmotesUpdated);
    };
  }, []);

  useEffect(() => {
    if (!incomingEmote || muteOpponent) return;
    setVisibleIncoming(incomingEmote);
    const timer = window.setTimeout(() => setVisibleIncoming(null), 2800);
    return () => window.clearTimeout(timer);
  }, [incomingEmote, muteOpponent]);

  const send = (emote) => {
    if (!sendEnabled) return;
    onSend?.(emote);
    setOpen(false);
  };

  // Equipped animated emotes in loadout order (catalog metadata joined on
  // the key — the payload stays a stable key, never a URL).
  const catalogByKey = new Map((loadout?.emotes || []).map((entry) => [entry.key, entry]));
  const equippedEmotes = (loadout?.equippedEmotes || [])
    .map((key) => catalogByKey.get(key))
    .filter(Boolean)
    .map((entry) => ({
      id: entry.key,
      key: entry.key,
      kind: "animated",
      label: entry.name || entry.key,
      value: entry.name || entry.key,
    }));

  // At most 11 choices: 2 permanent text emotes + up to 9 equipped emotes.
  const emotes = [...PERMANENT_TEXT_EMOTES, ...equippedEmotes];

  return (
    <div className="relative z-30 flex items-center gap-2">
      {!hideBubbles && visibleIncoming && (
        <div className={`absolute bottom-${compact ? "12" : "14"} left-0 flex ${compact ? "h-10 min-w-10 px-2 text-xl" : "h-16 min-w-16 px-3 text-3xl"} items-center justify-center rounded-2xl rounded-bl-md border border-fuchsia-300/60 bg-[#071531]/95 shadow-[0_0_24px_rgba(255,60,172,.4)]`} role="status" aria-label="Opponent emote">
          <EmoteArtwork
            emote={visibleIncoming}
            imageClassName={compact ? "h-8 w-8" : "h-12 w-12"}
            textClassName="max-w-[8rem] text-center text-sm font-black leading-tight tracking-tight"
          />
        </div>
      )}
      {!hideBubbles && myEmote && (
        <div className={`absolute bottom-${compact ? "12" : "14"} right-0 flex ${compact ? "h-10 min-w-10 px-2 text-xl" : "h-16 min-w-16 px-3 text-3xl"} items-center justify-center rounded-2xl rounded-br-md border border-cyan-300/60 bg-[#071531]/95 shadow-[0_0_24px_rgba(0,229,255,.35)]`} role="status" aria-label="Your emote">
          <EmoteArtwork
            emote={myEmote}
            imageClassName={compact ? "h-8 w-8" : "h-12 w-12"}
            textClassName="max-w-[8rem] text-center text-sm font-black leading-tight tracking-tight"
          />
        </div>
      )}
      {open && (
        <div className={`absolute bottom-14 left-1/2 grid w-72 -translate-x-1/2 grid-cols-3 gap-2 rounded-2xl border border-[#00e5ff]/40 bg-[#040d24]/95 p-3 shadow-[0_0_28px_rgba(0,229,255,.28)] backdrop-blur-md ${compact ? "origin-bottom scale-90" : ""}`}>
          <div className="col-span-3 mb-1 text-center text-[10px] font-bold uppercase tracking-[0.16em] text-[#00e5ff]/70">Emotes</div>
          {emotes.map((emote) => (
            <button key={emote.id} type="button" onClick={() => send(emote)} disabled={!sendEnabled} aria-label={`Send ${emote.label}`} className="flex h-16 items-center justify-center rounded-xl border border-white/10 bg-[#071531] text-3xl transition hover:scale-105 hover:border-[#00e5ff]/70 disabled:cursor-not-allowed disabled:opacity-40">
              {emote.kind === "word" ? (
                <span className="max-w-[4.5rem] text-center text-[9px] font-black leading-[1.05] tracking-tight text-[#f5ff3b]">{emote.value}</span>
              ) : (
                <EmoteArtwork emote={emote} imageClassName="h-12 w-12" />
              )}
            </button>
          ))}
          <div className="col-span-3 border-t border-white/10 pt-2 text-center text-[10px] font-bold uppercase tracking-[0.16em] text-white/40">Emote controls</div>
          <button type="button" onClick={() => setSendEnabled((value) => !value)} className="col-span-3 rounded-lg border border-white/10 px-2 py-1.5 text-[10px] font-bold uppercase tracking-wider text-white/70 hover:bg-white/10">
            {sendEnabled ? "Disable sending" : "Enable sending"}
          </button>
          <button type="button" onClick={() => setMuteOpponent((value) => !value)} className="col-span-3 rounded-lg border border-white/10 px-2 py-1.5 text-[10px] font-bold uppercase tracking-wider text-white/70 hover:bg-white/10">
            {muteOpponent ? "Unmute opponent" : "Mute opponent emotes"}
          </button>
        </div>
      )}
      <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} aria-label="Open emotes" className="flex h-10 w-10 items-center justify-center rounded-full border border-[#00e5ff]/45 bg-[#071531] text-xl shadow-[0_0_14px_rgba(0,229,255,.2)] transition hover:scale-105 hover:border-[#00e5ff]">
        🙂
      </button>
    </div>
  );
}
