"use client";
import React, { useEffect, useState } from "react";
import { IconVolume, IconVolumeOff } from "@tabler/icons-react";
import {
  isAudioMuted,
  toggleAudioMuted,
  subscribeAudioMuted,
} from "../lib/audioSettings";

/**
 * Global game-audio mute toggle. Lives in the nav bar so the player can
 * silence (or restore) every game's sound effects from any page. The
 * preference persists in localStorage via `audioSettings` and is shared
 * across all open tabs.
 */
export default function SoundToggle({ className = "" }) {
  const [muted, setMuted] = useState(false);

  useEffect(() => {
    setMuted(isAudioMuted());
    return subscribeAudioMuted(() => setMuted(isAudioMuted()));
  }, []);

  return (
    <button
      onClick={() => toggleAudioMuted()}
      aria-pressed={muted}
      aria-label={muted ? "Unmute game sounds" : "Mute game sounds"}
      title={muted ? "Sounds off — click to unmute" : "Sounds on — click to mute"}
      className={`inline-flex items-center cursor-pointer rounded-lg border px-2 py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff] focus-visible:ring-offset-2 focus-visible:ring-offset-[#050b1e] transition-colors ${
        muted
          ? "border-[#ff8c42]/60 bg-[#ff8c42]/10 text-[#ffb347]"
          : "border-[#00e5ff]/50 bg-[#091737] text-[#c9f7ff] hover:bg-[#00e5ff]/10"
      } ${className}`}
    >
      {muted ? <IconVolumeOff size={16} /> : <IconVolume size={16} />}
    </button>
  );
}
