"use client";

// src/components/solitaire-duel/FriendChallengePanel.tsx
//
// "Challenge a friend": mint one private table, show its link, and then WATCH
// it — the creator should not have to open the match page to learn that the
// friend accepted, and should not have to guess whether the link still works.
//
// Three sources, each authoritative for what it owns:
//
//   POST /api/solitaire-duel/invite        mints (or returns) the link.
//   GET  /api/solitaire-duel/lobby         rehydrates the caller's live
//                                          challenge, so a reload keeps it.
//   GET  /api/solitaire-duel/match/<id>    the caller's own match snapshot:
//                                          `playing` means the second seat was
//                                          claimed. Polled, exactly like the
//                                          lobby's own waiting poll.
//
// Nothing here decides a match, invents an opponent name or claims a start
// before the server says `playing`. The URL is displayed verbatim as the server
// returned it, so the host, path and code cannot disagree.

import { useCallback, useEffect, useState } from "react";

import { useUser } from "@clerk/nextjs";
import {
  IconCheck,
  IconCopy,
  IconLink,
  IconShare3,
  IconSwords,
} from "@tabler/icons-react";

import { useMatchRouter } from "../../hooks/useMatchRouter";
import {
  DISCORD_COMPOSER_URL,
  friendChallengeMessage,
  friendChallengeShareLinks,
  friendChallengeUrl,
} from "../../lib/solitaire-duel/friendChallenge";

type Challenge = {
  code: string;
  url: string;
  matchId: string;
  expiresAtMs: number | null;
};

type Phase = "none" | "waiting" | "accepted" | "expired";

const matchPath = (matchId: string) => `/casino/solitaire-duel/${matchId}`;
const WATCH_POLL_MS = 4_000;

export default function FriendChallengePanel({ embedded = false }: { embedded?: boolean } = {}) {
  const { isSignedIn, isLoaded } = useUser();
  const router = useMatchRouter();

  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [phase, setPhase] = useState<Phase>("none");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset the "copied" tick so the label does not say "Copied" forever.
  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(id);
  }, [copied]);

  // Rehydrate on mount: the server already knows the caller's live challenge
  // (including whether the friend has accepted), so the panel never shows a
  // fresh "Create link" button over an invite that is still open.
  useEffect(() => {
    if (!isSignedIn) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/solitaire-duel/lobby", {
          cache: "no-store",
          credentials: "include",
        });
        const data = await res.json().catch(() => null);
        const mine = data?.data?.myChallenge;
        if (cancelled || !mine?.code) return;
        const url = friendChallengeUrl(mine.code);
        if (!url) return;
        setChallenge({
          code: mine.code,
          url,
          matchId: String(mine.matchId),
          expiresAtMs: mine.expiresAtMs ?? null,
        });
        if (mine.status === "playing") setPhase("accepted");
        else if (mine.status === "cancelled") setPhase("expired");
        else setPhase("waiting");
      } catch {
        // A failed hydrate leaves the create button; the next mount retries.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isSignedIn]);

  // While waiting, poll the caller's OWN match. The seat claim is the server's
  // write, so `playing` is the only proof that the friend actually sat down.
  useEffect(() => {
    if (!challenge || phase !== "waiting") return;
    let stopped = false;
    const tick = async () => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      try {
        const res = await fetch(`/api/solitaire-duel/match/${challenge.matchId}`, {
          cache: "no-store",
          credentials: "include",
        });
        if (stopped) return;
        if (res.status === 404 || res.status === 403) {
          // The lobby was cancelled or swept away.
          setPhase("expired");
          return;
        }
        const data = await res.json().catch(() => null);
        if (stopped || !data?.success || !data.data) return;
        const status = String(data.data.status);
        if (status === "playing") setPhase("accepted");
        else if (status === "cancelled") setPhase("expired");
      } catch {
        // Poll backstop: the interval tries again.
      }
    };
    void tick();
    const id = setInterval(tick, WATCH_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [challenge, phase]);

  const create = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/solitaire-duel/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({}),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        setError(data?.error || "Unable to create a challenge link");
        return;
      }
      setChallenge(data.data as Challenge);
      setPhase("waiting");
    } catch {
      setError("Unable to create a challenge link");
    } finally {
      setBusy(false);
    }
  }, [busy]);

  const copy = useCallback(async () => {
    if (!challenge) return;
    try {
      await navigator.clipboard.writeText(challenge.url);
      setCopied(true);
    } catch {
      // Clipboard can be blocked (insecure context, denied permission). The
      // input is readonly and selectable, so the player can still copy by hand.
      setError("Copy failed — select the link and copy it manually.");
    }
  }, [challenge]);

  // Discord cannot be prefilled from a URL, so its button copies the message
  // (the only thing that can be preloaded there) and then opens Discord.
  const openDiscord = useCallback(async () => {
    if (!challenge) return;
    const message = friendChallengeMessage(challenge.code);
    if (message) {
      try {
        await navigator.clipboard.writeText(message);
        setCopied(true);
      } catch {
        // Opening Discord is still useful: the link input is selectable.
      }
    }
    window.open(DISCORD_COMPOSER_URL, "_blank", "noopener,noreferrer");
  }, [challenge]);

  const share = useCallback(async () => {
    if (!challenge) return;
    const nav = navigator as Navigator & {
      share?: (data: { title?: string; text?: string; url?: string }) => Promise<void>;
    };
    if (typeof nav.share !== "function") {
      await copy();
      return;
    }
    try {
      await nav.share({
        title: "Race me on Solitaire Duel",
        text: "Same deal, head to head.",
        url: challenge.url,
      });
    } catch {
      // The player dismissed the sheet; nothing to report.
    }
  }, [challenge, copy]);

  if (!isLoaded || !isSignedIn) return null;

  return (
    <div
      className={`${embedded ? "" : "mt-4 rounded-xl border p-4"} ${
        phase === "accepted"
          ? "rounded-xl border border-[#00ffa3]/40 bg-[#00ffa3]/[0.06] p-4"
          : embedded
            ? ""
            : "border-white/10 bg-white/[0.02]"
      }`}
      data-testid="friend-challenge"
      data-phase={phase}
    >
      <p className="flex items-center gap-2 text-xs font-black uppercase tracking-[0.16em] text-cyan-200/80">
        <IconLink size={14} aria-hidden="true" />
        Challenge a friend
      </p>

      {phase === "accepted" && challenge ? (
        <div data-testid="friend-challenge-accepted" role="status">
          <p className="mt-1 flex items-center gap-2 text-sm font-black text-[#8dffd0]">
            <IconSwords size={16} aria-hidden="true" />
            Your friend accepted — the deal is live.
          </p>
          <p className="mt-1 text-xs leading-relaxed text-white/55">
            Both seats now hold the same Klondike deal and the server&apos;s clock
            is running. Enter the table to play your copy.
          </p>
          <button
            type="button"
            onClick={() => router.push(matchPath(challenge.matchId))}
            data-testid="friend-challenge-enter"
            className="mt-3 inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-[#00ffa3] px-3.5 py-2 text-xs font-black text-[#00231a] transition hover:brightness-110"
          >
            Enter the duel →
          </button>
        </div>
      ) : phase === "expired" ? (
        <div data-testid="friend-challenge-expired" role="status">
          <p className="mt-1 text-sm font-bold text-white/80">
            That challenge is no longer open.
          </p>
          <p className="mt-1 text-xs leading-relaxed text-white/45">
            The link was used, cancelled or expired after seven days. Send a
            fresh one — it is a new private table.
          </p>
          <button
            type="button"
            onClick={create}
            disabled={busy}
            data-testid="friend-challenge-renew"
            className="mt-3 inline-flex min-h-10 items-center justify-center rounded-lg border border-[#00e5ff]/40 bg-[#00e5ff]/10 px-3.5 py-2 text-xs font-black text-[#9dd8ff] transition hover:bg-[#00e5ff]/20 disabled:opacity-60"
          >
            {busy ? "Creating…" : "Create a new link"}
          </button>
        </div>
      ) : !challenge ? (
        <>
          <p className="mt-1 text-xs leading-relaxed text-white/45">
            Send one private table to a friend instead of waiting in the queue.
            The link seats them opposite you on the same deal for seven days.
          </p>
          <button
            type="button"
            onClick={create}
            disabled={busy}
            data-testid="friend-challenge-create"
            className="mt-3 inline-flex min-h-10 items-center justify-center rounded-lg border border-[#00e5ff]/40 bg-[#00e5ff]/10 px-3.5 py-2 text-xs font-black text-[#9dd8ff] transition hover:bg-[#00e5ff]/20 disabled:opacity-60"
          >
            {busy ? "Creating…" : "Create challenge link"}
          </button>
        </>
      ) : (
        <>
          <p className="mt-1 text-xs leading-relaxed text-white/45">
            Private table created. Only someone with this link can take the
            second seat — you are not in the public queue.
          </p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <input
              readOnly
              value={challenge.url}
              onFocus={(event) => event.currentTarget.select()}
              aria-label="Challenge link"
              data-testid="friend-challenge-url"
              className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-mono text-[11px] text-white/70"
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={copy}
                data-testid="friend-challenge-copy"
                className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-white/15 bg-white/[0.04] px-3 py-2 text-xs font-bold text-white/80 transition hover:bg-white/[0.08]"
              >
                {copied ? (
                  <IconCheck size={14} aria-hidden="true" />
                ) : (
                  <IconCopy size={14} aria-hidden="true" />
                )}
                {copied ? "Copied" : "Copy"}
              </button>
              <button
                type="button"
                onClick={share}
                data-testid="friend-challenge-share"
                className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-white/15 bg-white/[0.04] px-3 py-2 text-xs font-bold text-white/80 transition hover:bg-white/[0.08]"
              >
                <IconShare3 size={14} aria-hidden="true" />
                Share
              </button>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <a
              href={friendChallengeShareLinks(challenge.code)?.whatsapp ?? undefined}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="friend-challenge-whatsapp"
              className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-[#25d366]/40 bg-[#25d366]/10 px-3 py-1.5 text-[11px] font-bold text-[#8ff0b4] transition hover:bg-[#25d366]/20"
            >
              WhatsApp
            </a>
            <button
              type="button"
              onClick={openDiscord}
              data-testid="friend-challenge-discord"
              className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-[#5865f2]/45 bg-[#5865f2]/10 px-3 py-1.5 text-[11px] font-bold text-[#b9c0ff] transition hover:bg-[#5865f2]/20"
            >
              Discord
            </button>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <span
              className="inline-flex items-center gap-1.5 text-[11px] font-bold text-cyan-200/80"
              data-testid="friend-challenge-waiting"
              role="status"
            >
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-cyan-300 opacity-75 motion-reduce:animate-none" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-cyan-300" />
              </span>
              Waiting for your friend to open the link…
            </span>
            <button
              type="button"
              onClick={() => router.push(matchPath(challenge.matchId))}
              data-testid="friend-challenge-open"
              className="text-xs font-extrabold text-[#00e5ff] underline-offset-4 hover:underline"
            >
              Open my table →
            </button>
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-white/35">
            This panel updates itself the moment they accept. The clock starts
            only then.
          </p>
        </>
      )}

      {error ? (
        <p role="alert" className="mt-2 text-xs text-rose-300">
          {error}
        </p>
      ) : null}
    </div>
  );
}
