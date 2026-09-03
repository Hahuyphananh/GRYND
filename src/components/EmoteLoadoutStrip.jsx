"use client";

// src/components/EmoteLoadoutStrip.jsx
//
// Profile-page preview of the player's equipped emote loadout (up to 9
// animated emotes, in order). Reads GET /api/user/emotes (server-authoritative
// loadout persisted in the database), refreshes on the "emotesUpdated" event,
// and opens the full Emotes manager when tapped.

import { useEffect, useState } from "react";
import { emoteAssetUrl, MAX_EQUIPPED_EMOTES } from "../lib/emoteAssets";

export default function EmoteLoadoutStrip({ onChange }) {
  const [state, setState] = useState(null); // { emotes: [], equippedEmotes: [] }

  const refresh = () => {
    fetch("/api/user/emotes", { credentials: "include", cache: "no-store" })
      .then((res) => res.json())
      .then((data) => {
        if (data && data.success === true) {
          setState({
            emotes: Array.isArray(data.emotes) ? data.emotes : [],
            equippedEmotes: Array.isArray(data.equippedEmotes) ? data.equippedEmotes : [],
          });
        }
      })
      .catch(() => {
        // Keep whatever we had — the card simply shows nothing on failure.
      });
  };

  useEffect(() => {
    refresh();
    window.addEventListener("emotesUpdated", refresh);
    return () => window.removeEventListener("emotesUpdated", refresh);
  }, []);

  const byKey = new Map((state?.emotes || []).map((entry) => [entry.key, entry]));
  const equippedKeys = state?.equippedEmotes || [];
  const equipped = equippedKeys.map((key) => byKey.get(key)).filter(Boolean);

  return (
    <button
      type="button"
      onClick={() => onChange?.(true)}
      className="mt-4 block w-full rounded-xl border border-white/10 bg-[#0d0412]/80 p-3 text-left transition hover:border-fuchsia-400/50"
      aria-label={`Open emotes manager — ${equipped.length} of ${MAX_EQUIPPED_EMOTES} equipped`}
    >
      <div className="mb-2 flex items-center justify-between text-[11px]">
        <span className="font-bold uppercase tracking-[0.16em] text-fuchsia-200/80">
          Equipped loadout
        </span>
        <span className="font-bold tabular-nums text-[#9dd8ff]">
          {equipped.length} / {MAX_EQUIPPED_EMOTES}
        </span>
      </div>
      {equipped.length === 0 ? (
        <div className="flex h-14 items-center justify-center rounded-lg border border-dashed border-white/15 text-xs text-white/40">
          No animated emotes equipped — tap to choose up to {MAX_EQUIPPED_EMOTES}
        </div>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {equipped.map((entry) => {
            const assetUrl = emoteAssetUrl(entry.key);
            return assetUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={entry.key}
                src={assetUrl}
                alt=""
                title={entry.name}
                className="h-10 w-10 rounded-lg border border-fuchsia-300/30 bg-[#071531] object-contain p-0.5"
                loading="lazy"
                onError={(event) => {
                  event.currentTarget.style.display = "none";
                }}
              />
            ) : (
              <span
                key={entry.key}
                className="flex h-10 w-10 items-center justify-center rounded-lg border border-fuchsia-300/30 bg-[#071531] text-xs font-black text-fuchsia-200/60"
                title={entry.name}
              >
                {(entry.name || entry.key).slice(0, 1)}
              </span>
            );
          })}
          <span className="flex h-10 items-center rounded-lg border border-dashed border-fuchsia-300/30 px-2 text-[11px] font-semibold text-fuchsia-200/70">
            GG · NICE MOVE always on
          </span>
        </div>
      )}
    </button>
  );
}
