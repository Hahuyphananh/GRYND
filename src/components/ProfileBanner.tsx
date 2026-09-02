"use client";

import { useEffect, useState } from "react";
import { bannerAssetUrl } from "../lib/bannerAssets";

export default function ProfileBanner({
  bannerKey,
  className = "",
  heightClass = "h-16 sm:h-20",
}: {
  bannerKey?: string | null;
  className?: string;
  heightClass?: string;
}) {
  const assetUrl = bannerAssetUrl(bannerKey);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [assetUrl]);

  // No key, malformed key, or unknown key means the profile uses its normal
  // card background and does not reserve banner space.
  if (!assetUrl) return null;

  return (
    <div
      className={`w-full overflow-hidden rounded-t-xl border-b border-white/10 bg-[#08142f] ${heightClass} ${className}`}
      aria-label={failed ? "Banner artwork unavailable" : "Profile banner"}
    >
      {failed ? (
        <div className="flex h-full items-center justify-center text-xs text-white/40">
          Banner unavailable
        </div>
      ) : (
        // The official catalog controls the path. The 3:1 source artwork is
        // cropped responsively into the existing 64-80px profile strip.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={assetUrl}
          alt=""
          className="h-full w-full object-cover"
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      )}
    </div>
  );
}
