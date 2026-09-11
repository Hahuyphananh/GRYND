"use client";

// src/components/IconAvatar.tsx
//
// The ONLY way Grynd renders a player avatar. Takes an OFFICIAL icon key and
// resolves it through the official asset resolver (src/lib/iconAssets.ts). It
// NEVER accepts an arbitrary image URL / base64 / external avatar.
//
// Behavior:
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

export default function IconAvatar({
  iconKey,
  name,
  size = "h-14 w-14",
  className = "",
}: {
  /** Official Grynd icon key. Anything invalid resolves to the default icon. */
  iconKey?: string | null;
  /** Display name — used only for the letter-avatar fallback. */
  name?: string | null;
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