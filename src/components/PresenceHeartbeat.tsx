"use client";

import { useAuth } from "@clerk/nextjs";
import { useEffect } from "react";

export default function PresenceHeartbeat() {
  const { isSignedIn, isLoaded } = useAuth();

  useEffect(() => {
    if (!isLoaded || !isSignedIn) return;

    let intervalId: ReturnType<typeof setInterval> | null = null;

    const getIntervalMs = () => {
      if (typeof document !== "undefined" && document.hidden) return 120000;
      if (typeof navigator !== "undefined" && !navigator.onLine) return 180000;
      return 45000;
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
