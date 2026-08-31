// src/lib/creator-mode/useCreatorModeAccess.ts
//
// Client hook for Creator Mode access. Fetches /api/creator-mode/access
// (server-authoritative, reuses the existing Clerk auth + isAdmin path)
// and renders any creator-mode UI only from that server answer.
//
// Security stance: the decision is made ON the server from the Clerk
// session (`auth()` + the DB-backed isAdmin check), never on the client.
// This hook therefore never reads client-writable state to decide
// access — no URL params, React state, or (critically) any client
// storage like localStorage or sessionStorage. A normal user who plants
// a sessionStorage flag, edits React state, or tampers with the browser
// still gets `canUseCreatorMode === false`, because the authenticated
// server response is the only thing that can ever grant access.

"use client";

import { useEffect, useState } from "react";
import { useUser } from "@clerk/nextjs";

type AccessState = {
  canUseCreatorMode: boolean;
  loading: boolean;
};

export function useCreatorModeAccess(): AccessState {
  const { user } = useUser();
  // Authoritative answer, derived only from the server fetch. Never
  // initialized from (or defaulted to) any client-writable value.
  const [canUseCreatorMode, setCanUseCreatorMode] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user?.id) {
      setCanUseCreatorMode(false);
      setLoading(false);
      return;
    }

    let cancelled = false;

    fetch("/api/creator-mode/access", { credentials: "include" })
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        setCanUseCreatorMode(data?.canUseCreatorMode === true);
      })
      .catch(() => {
        // Network / request failure → deny (safe default). Never grant
        // access when the server can't be asked.
        if (!cancelled) setCanUseCreatorMode(false);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  return { canUseCreatorMode, loading };
}