'use client'
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
        const data = await res.json(); // 👈 capture response body
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
      style={{
        height: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: "1.2rem",
        fontWeight: 500,
      }}
    >
      {status}
    </div>
  );
}