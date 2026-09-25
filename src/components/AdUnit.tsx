"use client";

// src/components/AdUnit.tsx
//
// The thin client renderer for ONE ad unit. It is deliberately the only
// browser-side piece of the ad model: AdSlot decides (server-side, from the
// membership record) whether this may exist at all, and hands down nothing but
// the public unit id.
//
// Google's contract for manually-placed units is an `<ins class="adsbygoogle">`
// plus one `adsbygoogle.push({})` per element. The push is guarded by a ref
// because React 19 re-runs effects in development: a second push for an
// element that already has an ad logs "All ins elements in the DOM with
// class=adsbygoogle already have ads in them" and the slot can fail to fill.
//
// The unit is `display: block` with a reserved height so ads never cause a
// layout shift (CLS) or reflow the controls around them.

import { useEffect, useRef } from "react";
import { adsensePublisherId } from "../lib/ads";

export default function AdUnit({
  slotId,
  placement,
}: {
  slotId: string;
  /** Placement key — passed through for analytics/debugging only. */
  placement: string;
}) {
  const pushed = useRef(false);

  useEffect(() => {
    if (pushed.current) return;
    pushed.current = true;
    try {
      const w = window as unknown as { adsbygoogle?: unknown[] };
      w.adsbygoogle = w.adsbygoogle || [];
      w.adsbygoogle.push({});
    } catch (err) {
      // A blocked/failed ad request must never break the page.
      console.error("[ads] adsbygoogle push failed:", err);
    }
  }, []);

  return (
    <ins
      className="adsbygoogle block w-full"
      style={{ display: "block", minHeight: "90px" }}
      data-ad-client={adsensePublisherId()}
      data-ad-slot={slotId}
      data-ad-format="auto"
      data-full-width-responsive="true"
      data-ad-placement={placement}
    />
  );
}
