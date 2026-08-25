"use client";

import { useAuth } from "@clerk/nextjs";
import { useEffect } from "react";

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

    const handleVisibility = () => startHeartbeat();
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
