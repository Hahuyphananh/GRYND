"use client";

// src/components/game/SeatAvatar.tsx
//
// The ONE way a MATCH SEAT is depicted across the 1v1 game boards: the
// player's official Grynd pfp (the icon key the server resolved for that seat),
// or the GRYND mark for the bot seat.
//
// Why it lives here rather than on each page: every duel board draws the same
// two seats in a different frame (scoreboard card, progress meter, seat chip),
// and "the AI seat shows the logo, a human seat shows their pfp" is a rule, not
// a per-page styling choice. Keeping it in one component is what stops a seat's
// face from meaning one thing on one board and another thing on the next.
//
// The AI seat can never resolve an icon key: bot seats carry a sentinel id
// (e.g. `mini_golf_ai_bot`) with no `users` row, so the shared seat-identity
// resolver returns null for it (see src/lib/seatIdentity.js). `isAi` is
// therefore what selects the logo — never a missing icon key, which a human
// whose artwork has not shipped yet would also have.

import FrameAvatar from "../FrameAvatar";
// The GRYND mark for the AI seat. Static import so the asset can't go missing
// silently — `.src` is the hashed URL an <img> needs.
import smallLogo from "../../images/smalllogo.png";

const SMALL_LOGO_SRC: string = smallLogo.src;

export type SeatAvatarProps = {
  /** The seat's official Grynd icon key (human seats only). */
  iconKey?: string | null;
  /** The seat's equipped profile frame, as the server resolved it. */
  profileFrame?: unknown;
  /** Display name — used as the avatar's alt / initial fallback. */
  name?: string | null;
  /** True for the bot seat: always the GRYND logo, whatever `iconKey` says. */
  isAi?: boolean;
  /** True for a GUEST seat (a signed-out practice player): draws the "G" badge. */
  isGuest?: boolean;
  /** Tailwind size classes (e.g. "h-7 w-7"). */
  size?: string;
  className?: string;
};

/**
 * A seat's avatar. The AI seat renders the GRYND logo as a raw, size-pinned
 * `<img>` (the logo is not an avatar-shaped asset, so it is contained rather
 * than cropped); every human seat goes through the shared `<FrameAvatar>`, so
 * the equipped frame ring is drawn identically here and everywhere else.
 */
export default function SeatAvatar({
  iconKey = null,
  profileFrame = null,
  name,
  isAi = false,
  isGuest = false,
  size = "h-7 w-7",
  className = "",
}: SeatAvatarProps) {
  if (isAi) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={SMALL_LOGO_SRC}
        alt=""
        aria-hidden="true"
        data-seat-avatar="ai"
        className={`shrink-0 rounded-full bg-black/40 object-contain p-px ${size} ${className}`}
      />
    );
  }
  return (
    <FrameAvatar
      frame={profileFrame}
      iconKey={iconKey || null}
      name={name || undefined}
      isGuest={isGuest}
      size={size}
      className={className}
    />
  );
}