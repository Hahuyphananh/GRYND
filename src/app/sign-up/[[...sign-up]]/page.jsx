"use client";

import { SignUp } from "@clerk/nextjs";
import { useEffect } from "react";
import { useUser } from "@clerk/nextjs";

export default function Page() {
  const { isLoaded, isSignedIn } = useUser();

  useEffect(() => {
    if (typeof window !== "undefined" && isLoaded && isSignedIn) {
      fetch("/api/sync-user", { method: "POST" })
        .then((res) => {
          if (!res.ok) {
            console.error("❌ Failed to sync user");
          }
        })
        .catch((err) => console.error("❌ Sync-user error:", err));
    }
  }, [isLoaded, isSignedIn]);

  return <SignUp />;
}
