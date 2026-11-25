"use client";

// src/app/duel/[code]/PageClient.tsx
//
// The landing surface for a shared challenge link.
//
// It does exactly two things: report what the code currently is (open /
// started / expired / unknown), and — for a signed-in visitor on an open code —
// claim the second seat and go to the match. It never decides the deal, the
// clock or the winner: those are the store's, exactly as in the ranked lobby.
//
// A signed-out visitor is sent to sign-in and comes straight back to this URL,
// so accepting a challenge never loses the link.

import { useCallback, useEffect, useState } from "react";

import { useUser } from "@clerk/nextjs";
import { IconArrowRight, IconCards, IconLinkOff } from "@tabler/icons-react";
import Link from "next/link";

import { useMatchRouter } from "../../../hooks/useMatchRouter";
import { FRIEND_CHALLENGE_PATH_PREFIX } from "../../../lib/solitaire-duel/friendChallenge";

type ChallengeStatus = "open" | "started" | "expired" | "unknown";

const matchPath = (matchId: string) => `/casino/solitaire-duel/${matchId}`;

export default function FriendChallengePage({ code }: { code: string | null }) {
  const { isSignedIn, isLoaded } = useUser();
  const router = useMatchRouter();

  const [status, setStatus] = useState<ChallengeStatus | null>(null);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const signInHref = code
    ? `/sign-in?redirect_url=${encodeURIComponent(
        `${FRIEND_CHALLENGE_PATH_PREFIX}/${code}`,
      )}`
    : "/sign-in";

  useEffect(() => {
    if (!code) {
      setStatus("unknown");
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/solitaire-duel/invite/${encodeURIComponent(code)}`,
          { cache: "no-store", credentials: "include" },
        );
        const data = await res.json().catch(() => null);
        if (cancelled) return;
        const next = data?.data?.status;
        setStatus(
          next === "open" || next === "started" || next === "expired"
            ? next
            : "unknown",
        );
      } catch {
        if (!cancelled) setStatus("unknown");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code]);

  const accept = useCallback(async () => {
    if (!code || joining) return;
    setJoining(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/solitaire-duel/invite/${encodeURIComponent(code)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({}),
        },
      );
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        setError(data?.error || "Unable to accept this challenge");
        return;
      }
      router.push(matchPath(String(data.data.matchId)));
    } catch {
      setError("Unable to accept this challenge");
    } finally {
      setJoining(false);
    }
  }, [code, joining, router]);

  return (
    <div className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-page px-4 py-16 text-white">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-[420px] bg-[radial-gradient(ellipse_at_top,rgba(0,229,255,0.12),transparent_62%)]"
      />
      <section className="relative w-full max-w-md rounded-2xl border border-white/10 bg-[#06152f]/90 p-6">
        <div className="flex items-center gap-3">
          <span className="inline-flex h-11 w-11 items-center justify-center rounded-xl border border-cyan-400/30 bg-cyan-400/10 text-cyan-200">
            <IconCards size={22} aria-hidden="true" />
          </span>
          <div>
            <p className="text-[11px] font-black uppercase tracking-[0.24em] text-cyan-300/80">
              Friend Challenge
            </p>
            <h1 className="mt-0.5 text-2xl font-black tracking-tight">
              Same deal. Head to head.
            </h1>
          </div>
        </div>

        <p className="mt-4 text-sm leading-relaxed text-white/60">
          Whoever sent this link is holding seat 1. Accept and both of you race
          the exact same Klondike deal from the moment the server starts the
          clock — first to solve it wins. Free, unranked by stake, no queue.
        </p>

        {code ? (
          <p className="mt-3 font-mono text-xs tracking-[0.3em] text-white/35" data-testid="duel-code">
            {code}
          </p>
        ) : null}

        {status === null ? (
          <p className="mt-5 text-sm text-white/45">Checking this link…</p>
        ) : status === "unknown" ? (
          <Closed
            title="This link is not a challenge"
            body="Check the URL — challenge links look like /duel/ABCD2345."
          />
        ) : status === "expired" ? (
          <Closed
            title="This challenge has expired"
            body="Links seat a friend for seven days. Ask for a fresh one, or start your own ranked duel."
          />
        ) : status === "started" ? (
          <Closed
            title="This table has already started"
            body="The second seat is taken. Start your own duel and send the link instead."
          />
        ) : !isLoaded ? (
          <p className="mt-5 text-sm text-white/45">Loading…</p>
        ) : !isSignedIn ? (
          <Link
            href={signInHref}
            data-testid="duel-sign-in"
            className="mt-5 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-[#00e5ff] px-5 py-2.5 text-sm font-black text-[#00212b] transition hover:brightness-110"
          >
            Sign in to accept
            <IconArrowRight size={16} aria-hidden="true" />
          </Link>
        ) : (
          <button
            type="button"
            onClick={accept}
            disabled={joining}
            data-testid="duel-accept"
            className="mt-5 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-[#00e5ff] px-5 py-2.5 text-sm font-black text-[#00212b] transition hover:brightness-110 disabled:opacity-60"
          >
            {joining ? "Taking your seat…" : "Race this deal"}
            <IconArrowRight size={16} aria-hidden="true" />
          </button>
        )}

        {error ? (
          <p role="alert" className="mt-3 text-xs text-rose-300">
            {error}
          </p>
        ) : null}

        <p className="mt-5 border-t border-white/8 pt-3 text-[11px] leading-relaxed text-white/40">
          You play your own copy of the board — you cannot see or affect your
          friend&apos;s cards. A seat that goes idle long enough forfeits; the
          server owns the deal, the clock and the result.
        </p>
      </section>
    </div>
  );
}

function Closed({ title, body }: { title: string; body: string }) {
  return (
    <div className="mt-5 rounded-xl border border-white/10 bg-white/[0.02] p-4" role="status">
      <p className="flex items-center gap-2 text-sm font-bold text-white/80">
        <IconLinkOff size={16} aria-hidden="true" className="text-white/45" />
        {title}
      </p>
      <p className="mt-1.5 text-xs leading-relaxed text-white/45">{body}</p>
      <Link
        href="/play/ranked"
        className="mt-3 inline-flex items-center gap-1.5 text-xs font-extrabold text-[#00e5ff] underline-offset-4 hover:underline"
      >
        Open the ranked lobby
        <IconArrowRight size={14} aria-hidden="true" />
      </Link>
    </div>
  );
}
