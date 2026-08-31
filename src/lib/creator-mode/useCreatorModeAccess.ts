// src/lib/creator-mode/useCreatorModeAccess.ts
//
// Client hook for Creator Mode access. Fetches /api/creator-mode/access
// (server-authoritative, reuses the existing Clerk auth + isAdmin path)
// and caches the result in sessionStorage per user — the same pattern
// the navigation bar already uses for its is-admin check.
//
// Rendering any creator-mode UI from this hook keeps normal users fully
// shielded: the server never grants access, so `canUseCreatorMode` is
// always false for them no matter what the client does.

"use client";

import { useEffect, useState } from "react";
import { useUser } from "@clerk/nextjs";

const ACCESS_CACHE_PREFIX = "grynd:creatorModeAccess:";

type AccessState = {
  canUseCreatorMode: boolean;
  loading: boolean;
};

export function useCreatorModeAccess(): AccessState {
  const { user } = useUser();
  const [canUseCreatorMode, setCanUseCreatorMode] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user?.id) {
      setCanUseCreatorMode(false);
      setLoading(false);
      return;
    }

    const cacheKey = `${ACCESS_CACHE_PREFIX}${user.id}`;

    // sessionStorage cache first (mirrors the nav's is-admin cache).
    try {
      const cached = window.sessionStorage.getItem(cacheKey);
      if (cached !== null) {
        setCanUseCreatorMode(cached === "true");
        setLoading(false);
        return;
      }
    } catch {
      // sessionStorage unavailable — fall through to the network fetch.
    }

    let cancelled = false;
    fetch("/api/creator-mode/access", { credentials: "include" })
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        const allowed = data?.canUseCreatorMode === true;
        setCanUseCreatorMode(allowed);
        try {
          window.sessionStorage.setItem(cacheKey, String(allowed));
        } catch {
          // ignore
        }
      })
      .catch(() => {
        if (!cancelled) setCanUseCreatorMode(false);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  return { canUseCreatorMode, loading };
}
