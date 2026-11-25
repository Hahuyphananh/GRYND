"use client";
import { useEffect, useState } from "react";
import { IconVolume, IconVolumeOff } from "@tabler/icons-react";
import {
  isAudioMuted,
  toggleAudioMuted,
  subscribeAudioMuted,
} from "../lib/audioSettings";

/**
 * Global sound mute toggle. Lives in the nav bar so the player can silence (or
 * restore) game audio AND the interface sounds from any page. The preference
 * persists in localStorage via `audioSettings` and is shared across all open
 * tabs.
 */
export default function SoundToggle({ className = "", showLabel = false }) {
  const [muted, setMuted] = useState(false);

  useEffect(() => {
    setMuted(isAudioMuted());
    return subscribeAudioMuted(() => setMuted(isAudioMuted()));
  }, []);

  const label = muted ? "Unmute sounds" : "Mute sounds";

  return (
    <button
      type="button"
      onClick={() => toggleAudioMuted()}
      aria-pressed={muted}
      aria-label={label}
      title={muted ? "Sounds off — click to unmute" : "Sounds on — click to mute"}
      data-testid="sound-toggle"
      className={`inline-flex items-center cursor-pointer rounded-lg border px-2 py-1 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#00e5ff] focus-visible:ring-offset-2 focus-visible:ring-offset-[#050b1e] transition-colors ${
        muted
          ? "border-[#ff8c42]/60 bg-[#ff8c42]/10 text-[#ffb347]"
          : "border-[#00e5ff]/50 bg-panel text-[#c9f7ff] hover:bg-[#00e5ff]/10"
      } ${className}`}
    >
      {muted ? <IconVolumeOff size={16} /> : <IconVolume size={16} />}
      {showLabel && <span className="ml-2 text-sm font-medium">{label}</span>}
    </button>
  );
}
