"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useUser } from "@clerk/nextjs";

export default function SyncPage() {
  const router = useRouter();
  const { isSignedIn } = useUser();
  const [status, setStatus] = useState("Syncing your account...");

  useEffect(() => {
    if (isSignedIn) {
      fetch("/api/sync-user", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
      })
        .then(async (res) => {
          const data = await res.json();
          if (!res.ok) {
            console.error("🔴 Sync failed with response:", res.status, data);
            throw new Error("Sync failed");
          }
          console.log("✅ User sync success:", data);
          setStatus("Redirecting...");
          router.push("/");
        })
        .catch((err) => {
          console.error("❌ User sync failed:", err);
          setStatus("Something went wrong.");
        });
    }
  }, [isSignedIn, router]);

  return (
    <div
      className="flex items-center justify-center h-screen text-white"
      style={{
        background: "linear-gradient(135deg, #001933 0%, #000d1a 100%)",
      }}
    >
      <div className="flex flex-col items-center gap-6">
        
        {/* 🔵 Neon Spinner */}
        <div className="relative">
          <div className="h-16 w-16 rounded-full border-4 border-[#00e5ff]/20"></div>
          <div className="absolute top-0 left-0 h-16 w-16 rounded-full border-4 border-[#00e5ff] border-t-transparent animate-spin shadow-[0_0_20px_#00e5ff]"></div>
        </div>

        {/* ⚡ Status Text */}
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