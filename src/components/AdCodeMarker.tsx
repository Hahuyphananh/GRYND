"use client";

// src/components/AdCodeMarker.tsx
//
// Marks THIS document as one that has loaded ad code. Both ad loaders render
// it, so a page cannot gain an ad tag without also gaining the flag that keeps
// the tag's document-global behaviour (popunder handler, vignette, in-page
// push) out of gameplay: see lib/matchNavigation.ts and hooks/useMatchRouter.
//
// It paints nothing and is a no-op on a GRYND PRO member's page, because the
// loaders themselves render nothing for a member — no tag, no flag, no cost.

import { useEffect } from "react";
import { markAdCodeLoaded } from "../lib/matchNavigation";

export default function AdCodeMarker() {
  useEffect(() => {
    markAdCodeLoaded();
  }, []);

  return null;
}
