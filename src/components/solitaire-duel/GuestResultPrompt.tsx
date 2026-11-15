"use client";

// src/components/solitaire-duel/GuestResultPrompt.tsx
//
// After a GUEST's one free race, this is the ask.
//
// It lives inside the result screen's extra content, so it can only ever appear
// once the race is over — never mid-hand, where it would be an interruption.
// It renders nothing for a signed-in player: their result is theirs already.
//
// The copy is deliberate about what an account adds, because the guest just
// proved they can play without one: a saved record, a real ladder, live human
// opponents. It does not imply the free race was a demo of a lesser game.

import { useUser } from "@clerk/nextjs";
import { IconArrowRight, IconUserPlus } from "@tabler/icons-react";

import { useMatchRouter } from "../../hooks/useMatchRouter";

export default function GuestResultPrompt() {
  const { isLoaded, isSignedIn } = useUser();
  const router = useRouterSafe();

  // No flash while Clerk resolves, and nothing at all for an account holder.
  if (!isLoaded || isSignedIn) return null;

  return (
    <div
      className="mt-4 rounded-xl border border-[#f5ff3b]/35 bg-[#f5ff3b]/[0.06] p-4 text-left"
      data-testid="guest-result-sign-in"
    >
      <p className="flex items-center gap-2 text-sm font-black text-[#f5ff3b]">
        <IconUserPlus size={16} aria-hidden="true" />
        That was your free race.
      </p>
      <p className="mt-1 text-xs leading-relaxed text-white/60">
        Create an account to keep your results, climb the Solitaire ladder and
        race live players instead of a recorded run — the same deal, the same
        rules, nothing extra to buy.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid="guest-result-sign-up"
          onClick={() =>
            router.push("/sign-up?redirect_url=%2Fplay%2Franked")
          }
          className="inline-flex min-h-9 items-center gap-1.5 rounded-lg bg-[#f5ff3b] px-3 py-1.5 text-xs font-black text-[#1f1700] transition hover:brightness-110"
        >
          Create your account
          <IconArrowRight size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          data-testid="guest-result-sign-in-link"
          onClick={() => router.push("/sign-in?redirect_url=%2Fplay%2Franked")}
          className="inline-flex min-h-9 items-center rounded-lg border border-white/15 bg-white/[0.04] px-3 py-1.5 text-xs font-bold text-white/80 transition hover:bg-white/[0.08]"
        >
          I already have one
        </button>
      </div>
    </div>
  );
}

/** `useMatchRouter` is the app's navigation wrapper; kept behind a name so the
 *  component reads as "go to the ladder" rather than "push a path". */
function useRouterSafe() {
  return useMatchRouter();
}
