"use client";

// src/components/IconAvatar.tsx
//
// The ONLY way Grynd renders a player avatar. Takes an OFFICIAL icon key and
// resolves it through the official asset resolver (src/lib/iconAssets.ts). It
// NEVER accepts an arbitrary image URL / base64 / external avatar.
//
// Behavior:
//   * guest seat                           → letter badge (no account, no icon)
//   * malformed / unknown / null icon key  → official default icon
//   * missing artwork file (asset not added yet or moved) → letter-avatar
//     fallback via the <img> onError handler (never blocks a render)
//   * sizing/layout is controlled by the caller via `size` / `className`.

import { useEffect, useState } from "react";
import {
  DEFAULT_ICON_KEY,
  iconAssetUrl,
  isIconKey,
} from "../lib/iconAssets";
import { GUEST_AVATAR_LETTER, GUEST_DISPLAY_NAME } from "../lib/guestIdentity";

export default function IconAvatar({
  iconKey,
  name,
  isGuest = false,
  size = "h-14 w-14",
  className = "",
}: {
  /** Official Grynd icon key. Anything invalid resolves to the default icon. */
  iconKey?: string | null;
  /** Display name — used only for the letter-avatar fallback. */
  name?: string | null;
  /**
   * True for a GUEST seat (a signed-out practice player). A guest owns no
   * account, so it owns no icon: the avatar is the letter badge ("G").
   */
  isGuest?: boolean;
  /** Wrapper size classes, e.g. "h-9 w-9". */
  size?: string;
  /** Extra classes applied to the <img> (keep it an avatar shape). */
  className?: string;
}) {
  const effectiveKey = isIconKey(iconKey) ? iconKey : DEFAULT_ICON_KEY;
  const src = iconAssetUrl(effectiveKey);
  const [failed, setFailed] = useState(false);

  // Reset the fallback whenever the resolved asset changes (e.g. the user
  // equips a different icon). Otherwise a component that fell back to the
  // letter avatar (missing default.webp, network blip) would stay stuck on
  // the letter even after the new icon's file became available.
  useEffect(() => {
    setFailed(false);
  }, [src]);

  const initial = (name || "U").charAt(0).toUpperCase();

  // A guest is signed out and has no account, so there is no catalog icon to
  // resolve: render the badge directly rather than fetching an asset that
  // would 404. The badge is the guest's initial — "G" for "Guest".
  if (isGuest) {
    return (
      <span
        role="img"
        aria-label={name || GUEST_DISPLAY_NAME}
        data-avatar="guest"
        className={`flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-[#00e5ff]/25 font-bold text-[#8ff3ff] ring-1 ring-inset ring-[#00e5ff]/40 ${size} ${className}`}
      >
        {name ? initial : GUEST_AVATAR_LETTER}
      </span>
    );
  }

  const avatarEl = failed ? (
    <span
      aria-hidden="true"
      className={`flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-[#00e5ff] text-[#001933] font-bold ${size}`}
    >
      {initial}
    </span>
  ) : (
    // The key has already been validated by isIconKey above; src can only ever
    // be an official /icons/<key>.webp path derived from the catalog.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={name || "icon"}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={`shrink-0 overflow-hidden rounded-full object-cover ${size} ${className}`}
    />
  );

  return avatarEl;
}