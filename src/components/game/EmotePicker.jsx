"use client";

import { useEffect, useState } from "react";

export const GAME_EMOTES = [
  { id: "gg", label: "GG", value: "GG", kind: "word" },
  { id: "nice-move", label: "Nice Move", value: "NICE MOVE", kind: "word" },
  { id: "laugh", label: "Laugh", value: "😂" },
  { id: "wow", label: "Wow", value: "😮" },
  { id: "fire", label: "Fire", value: "🔥" },
  { id: "cry", label: "Cry", value: "😭" },
];

const STORAGE_KEY = "grynd:emotes:settings";

export default function EmotePicker({ onSend, incomingEmote = null, myEmote = null, compact = false, hideBubbles = false }) {
  const [open, setOpen] = useState(false);
  const [sendEnabled, setSendEnabled] = useState(true);
  const [muteOpponent, setMuteOpponent] = useState(false);
  const [visibleIncoming, setVisibleIncoming] = useState(null);

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

  return (
    <div className="relative z-30 flex items-center gap-2">
      {!hideBubbles && visibleIncoming && (
        <div className={`absolute bottom-${compact ? "12" : "14"} left-0 flex ${compact ? "h-10 min-w-10 px-2 text-xl" : "h-16 min-w-16 px-3 text-3xl"} items-center justify-center rounded-2xl rounded-bl-md border border-fuchsia-300/60 bg-[#071531]/95 shadow-[0_0_24px_rgba(255,60,172,.4)]`} role="status" aria-label="Opponent emote">
          <span className={visibleIncoming.kind === "word" ? "max-w-[8rem] text-center text-sm font-black leading-tight tracking-tight" : ""}>{visibleIncoming.value}</span>
        </div>
      )}
      {!hideBubbles && myEmote && (
        <div className={`absolute bottom-${compact ? "12" : "14"} right-0 flex ${compact ? "h-10 min-w-10 px-2 text-xl" : "h-16 min-w-16 px-3 text-3xl"} items-center justify-center rounded-2xl rounded-br-md border border-cyan-300/60 bg-[#071531]/95 shadow-[0_0_24px_rgba(0,229,255,.35)]`} role="status" aria-label="Your emote">
          <span className={myEmote.kind === "word" ? "max-w-[8rem] text-center text-sm font-black leading-tight tracking-tight" : ""}>{myEmote.value}</span>
        </div>
      )}
      {open && (
        <div className={`absolute bottom-14 left-1/2 grid w-72 -translate-x-1/2 grid-cols-3 gap-2 rounded-2xl border border-[#00e5ff]/40 bg-[#040d24]/95 p-3 shadow-[0_0_28px_rgba(0,229,255,.28)] backdrop-blur-md ${compact ? "origin-bottom scale-90" : ""}`}>
          <div className="col-span-3 mb-1 text-center text-[10px] font-bold uppercase tracking-[0.16em] text-[#00e5ff]/70">Emotes</div>
          {GAME_EMOTES.map((emote) => (
            <button key={emote.id} type="button" onClick={() => send(emote)} disabled={!sendEnabled} aria-label={`Send ${emote.label}`} className="flex h-16 items-center justify-center rounded-xl border border-white/10 bg-[#071531] text-3xl transition hover:scale-105 hover:border-[#00e5ff]/70 disabled:cursor-not-allowed disabled:opacity-40">
              <span className={emote.kind === "word" ? "max-w-[4.5rem] text-center text-[9px] font-black leading-[1.05] tracking-tight text-[#f5ff3b]" : ""}>{emote.value}</span>
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
