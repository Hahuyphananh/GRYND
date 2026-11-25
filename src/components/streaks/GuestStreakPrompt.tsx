"use client";

// THE GUEST STREAK PROMPT — one local day, and an honest reason to sign up.
//
// A guest's streak cannot be server-side (there is no account to key it on), so
// this says exactly that: "1 day, kept only in this browser". It never claims a
// streak the player does not have and never blocks play.

import Link from "next/link";
import { useUser } from "@clerk/nextjs";

export default function GuestStreakPrompt() {
  const { isLoaded, isSignedIn } = useUser();
  if (!isLoaded || isSignedIn) return null;

  return (
    <div
      data-testid="guest-streak-prompt"
      className="mx-auto mt-3 flex w-full max-w-6xl flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-300/25 bg-amber-400/[0.07] px-3 py-2 text-[11px] text-amber-100/90"
    >
      <p>
        <span aria-hidden="true">🔥</span>{" "}
        <strong>Day 1 streak</strong> — kept only in this browser. Create an
        account to save it and unlock table felts, card backs and deck skins.
      </p>
      <Link
        href="/sign-up"
        className="rounded-lg border border-amber-300/45 bg-amber-300/15 px-2.5 py-1 font-black uppercase tracking-[0.12em] text-amber-100 hover:bg-amber-300/25"
      >
        Save my streak
      </Link>
    </div>
  );
}
