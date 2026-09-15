"use client";
import { useEffect, useRef, useState } from "react";
import { useUser } from "@clerk/nextjs";
import posthog from "posthog-js";
import { getAcquisitionParams } from "../../lib/analytics";

export default function SyncPage() {
  const [status, setStatus] = useState("Syncing your account...");
  const replacedRef = useRef(false);

  const { isLoaded, isSignedIn } = useUser();

  useEffect(() => {
    if (!isLoaded || !isSignedIn) return;

    let cancelled = false;

    const syncUser = async (attempt = 1) => {
      try {
        const res = await fetch("/api/sync-user", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
        });

        const data = await res.json();

        if (!res.ok) {
          // Retry transient failures — Clerk eventual consistency right after
          // sign-up and the occasional webhook/sync race both clear quickly.
          if (attempt < 3 && (res.status === 409 || res.status === 500 || res.status === 400)) {
            console.warn(" Sync transient failure, retrying...", res.status, attempt);
            await new Promise((r) => setTimeout(r, 800 * attempt));
            if (!cancelled) return syncUser(attempt + 1);
          }
          console.error(" Sync failed:", res.status, data);
          throw new Error(data?.error || "Sync failed");
        }

        console.log(" Sync success:", data);

        if (!cancelled && !replacedRef.current) {
          replacedRef.current = true;
          const isNewUser = data?.message === "User synced successfully";

          // Marketing funnel: a fresh signup completes at the sync handoff
          // (the one place that knows the user is brand new). Attribution
          // params ride along so signups are traceable to a channel.
          if (isNewUser && process.env.NEXT_PUBLIC_POSTHOG_KEY) {
            try {
              posthog.capture("sign_up_completed", getAcquisitionParams());
            } catch (err) {
              console.warn("[funnel] sign_up_completed failed:", err);
            }
          }

          setStatus("Redirecting...");
          // IMPORTANT: a full navigation (not router.replace) — so back/refresh
          // can't resubmit, and the destination page gets a clean mount.
          // Client-side replaces to /welcome from here remount the page a
          // moment later (killing the onboarding tour), which never happens on
          // a full load. The ref guard keeps this single-fire: dev StrictMode
          // double-invokes the effect.
          // Brand-new accounts go through onboarding; everyone else goes
          // straight home. The documented order is
          //   signup → /welcome/questionnaire → /welcome → first game,
          // so fresh accounts start at the questionnaire (about a minute)
          // and it hands them on to the existing welcome tutorial. Both pages
          // re-check the server-side flags, so a "fresh" account that already
          // completed them (log-out/log-in inside the 15-min window) still
          // lands on the right screen.
          const target = isNewUser ? "/welcome/questionnaire" : "/";
          window.location.replace(target);
        }
      } catch (err) {
        console.error(" Sync error:", err);
        if (!cancelled) setStatus("Something went wrong.");
      }
    };

    syncUser();

    return () => {
      cancelled = true;
    };
  }, [isLoaded, isSignedIn]);

  return (
    <div
      className="flex items-center justify-center h-screen text-white"
      style={{
        background: "linear-gradient(135deg, #001933 0%, #000d1a 100%)",
      }}
    >
      <div className="flex flex-col items-center gap-6">
        {/*  Neon Spinner */}
        <div className="relative">
          <div className="h-16 w-16 rounded-full border-4 border-[#00e5ff]/20"></div>
          <div className="absolute top-0 left-0 h-16 w-16 rounded-full border-4 border-[#00e5ff] border-t-transparent animate-spin shadow-[0_0_20px_#00e5ff]"></div>
        </div>

        {/*  Status Text */}
        <p className="text-lg font-semibold text-[#00e5ff] animate-pulse tracking-wide">
          {status}
        </p>

        {/* Optional subtle glow bar */}
        <div className="w-40 h-1 bg-[#00e5ff]/30 rounded-full overflow-hidden">
          <div className="h-full w-1/2 bg-[#00e5ff] animate-pulse"></div>
        </div>
      </div>
    </div>
  );
}
