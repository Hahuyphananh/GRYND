"use client";
import { SignUp } from '@clerk/nextjs'
import { useEffect } from "react";
import { useUser } from "@clerk/nextjs";

export default function Page() {
  const { isSignedIn, user } = useUser();

  useEffect(() => {
    if (isSignedIn) {
      fetch("/api/sync-user", { method: "POST" });
    }
  }, [isSignedIn]);

  return (
    <SignUp />
  )
}
  
