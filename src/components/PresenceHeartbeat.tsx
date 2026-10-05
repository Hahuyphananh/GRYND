"use client";

import { useAuth } from "@clerk/nextjs";
import { useEffect } from "react";
import { claimFetchSlot } from "../lib/sharedPoll";

// One localStorage key for the whole browser: the first tab to claim a beat
// wins it, the others no-op. The stamp is the claim time, so the freshness
// window (intervalMs * slack) is exactly the heartbeat cadence.
const HEARTBEAT_CLAIM_KEY = "grynd:presence:heartbeat";

function getStorage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

export default function PresenceHeartbeat() {
  const { isSignedIn, isLoaded } = useAuth();

  useEffect(() => {
    if (!isLoaded || !isSignedIn) return;

    let intervalId: ReturnType<typeof setInterval> | null = null;

    // The global heartbeat is a keep-alive that drives presence/online
    // status. It used to fire every 45s, which turned into a Neon UPSERT
    // storm at scale (one write per signed-in tab every 45s). The offline
    // windows in the consumers (stats/live = 5 min, friends = 6 min) are
    // keyed to this cadence, so a 5-minute beat keeps online-detection
    // correct while cutting writes ~6.7x.
    const getIntervalMs = () => {
      if (typeof document !== "undefined" && document.hidden) return 600000;
      if (typeof navigator !== "undefined" && !navigator.onLine) return 600000;
      return 300000;
    };

    const ping = () => {
      // One beat per BROWSER, not per tab: several open tabs all keep the same
      // `user_presence` row alive, so the first tab to claim the slot sends the
      // request and the rest skip it. The server already makes the write a
      // conditional no-op; this removes the redundant round-trip entirely.
      // localStorage unavailable → claimFetchSlot returns true, so every tab
      // keeps beating exactly as before.
      if (
        !claimFetchSlot(
          getStorage(),
          HEARTBEAT_CLAIM_KEY,
          Date.now(),
          getIntervalMs(),
        )
      ) {
        return;
      }
      fetch("/api/presence/heartbeat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        keepalive: true,
        body: "{}",
      }).catch((error) => {
        console.error("[PRESENCE_HEARTBEAT_CLIENT_ERROR]", error);
      });
    };

    const startHeartbeat = () => {
      if (intervalId) clearInterval(intervalId);
      intervalId = setInterval(ping, getIntervalMs());
    };

    ping();
    startHeartbeat();

    const handleVisibility = () => {
      // Returning to the tab after a long hide: the 5-minute offline window may
      // have elapsed, so re-mark online at once instead of waiting out a full
      // interval. Deduped, so a tab that comes back while another beat recently
      // costs no request.
      if (typeof document !== "undefined" && !document.hidden) ping();
      startHeartbeat();
    };
    const handleOnline = () => {
      ping();
      startHeartbeat();
    };
    const handleOffline = () => startHeartbeat();

    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    return () => {
      if (intervalId) clearInterval(intervalId);
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, [isLoaded, isSignedIn]);

  return null;
}
