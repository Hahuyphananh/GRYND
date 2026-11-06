"use client";

// src/app/embed/[platform]/[gameKey]/EmbedClient.tsx
//
// Embedded GRYND practice (Phase 5).
//
// Runs inside an authorized platform iframe. EVERY API call carries the
// short-lived platform session token as `Authorization: Bearer …`; this client
// never reads or writes the `grynd_guest` cookie, so an embedded session can
// never touch the browser's standalone guest identity or its progression.
//
// The game shown is Tic-Tac-Toe practice against the bot: the same
// server-authoritative store the standalone game uses. The session's guest id is
// unrated by construction, so nothing here can grant Elo, trophies, coins or
// official stats.
//
// Messaging with the platform page is validated by src/lib/platform/messaging:
// only the exact session origin, only the versioned envelope, only known events.
// Outbound messages always use an explicit targetOrigin — never `"*"`.

import { useCallback, useEffect, useRef, useState } from "react";

import MegaBoard from "../../../../components/tic-tac-toe/MegaBoard";
import {
  buildPlatformMessage,
  parsePlatformMessage,
  platformTargetOrigin,
} from "../../../../lib/platform/messaging";
import type { Seat } from "../../../../lib/tic-tac-toe/types";

const POLL_MS = 1500;

type MatchDto = {
  version: number;
  status: string;
  phase?: string;
  boards: unknown;
  winningBoards?: unknown;
  lastMove?: unknown;
  nextBoard?: unknown;
  playableBoards?: unknown;
  viewerSeat: Seat | null;
  viewerCanMove: boolean;
  result?: string | null;
};

type ApiBody = {
  success?: boolean;
  error?: string;
  data?: { match?: MatchDto } & Partial<MatchDto>;
};

async function callApi(
  path: string,
  token: string,
  init: RequestInit = {},
): Promise<{ status: number; body: ApiBody | null }> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (init.body) headers.set("Content-Type", "application/json");

  const response = await fetch(path, {
    ...init,
    headers,
    cache: "no-store",
    credentials: "omit",
  });
  const body = (await response.json().catch(() => null)) as ApiBody | null;
  return { status: response.status, body };
}

function matchFrom(body: ApiBody | null): MatchDto | null {
  const candidate = body?.data?.match ?? body?.data;
  if (!candidate || typeof candidate !== "object") return null;
  if (!Array.isArray((candidate as MatchDto).boards)) return null;
  if (typeof (candidate as MatchDto).status !== "string") return null;
  return candidate as MatchDto;
}

export default function EmbedClient({
  token,
  platform,
  gameKey,
  platformOrigin,
  expiresAt,
}: {
  token: string;
  platform: string;
  gameKey: string;
  platformOrigin: string;
  expiresAt: string;
}) {
  const targetOrigin = platformTargetOrigin(platformOrigin);
  const [matchId, setMatchId] = useState<string | null>(null);
  const [match, setMatch] = useState<MatchDto | null>(null);
  const [status, setStatus] = useState("Loading practice…");
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ boardIndex: number; cellIndex: number } | null>(null);
  const [expired, setExpired] = useState(false);
  const [exited, setExited] = useState(false);
  const finishedPosted = useRef(false);

  const post = useCallback(
    (type: Parameters<typeof buildPlatformMessage>[0], payload: Record<string, unknown> = {}) => {
      if (!targetOrigin || typeof window === "undefined" || window.parent === window) return;
      // Explicit origin only; never "*".
      window.parent.postMessage(buildPlatformMessage(type, payload), targetOrigin);
    },
    [targetOrigin],
  );

  // Session expiry: the embedded page stops playing as soon as the server's
  // expiry passes, and tells the platform page so it can mint a new session.
  useEffect(() => {
    const milliseconds = Date.parse(expiresAt) - Date.now();
    if (!Number.isFinite(milliseconds)) {
      setExpired(true);
      return;
    }
    if (milliseconds <= 0) {
      setExpired(true);
      return;
    }
    const timer = setTimeout(() => setExpired(true), milliseconds);
    return () => clearTimeout(timer);
  }, [expiresAt]);

  useEffect(() => {
    if (expired) post("grynd:session_expired", { gameKey });
  }, [expired, gameKey, post]);

  useEffect(() => {
    if (!targetOrigin) return;
    post("grynd:ready", { gameKey, platform, version: 1 });

    const onMessage = (event: MessageEvent) => {
      const parsed = parsePlatformMessage(event, targetOrigin);
      if (!parsed) return;
      if (parsed.type === "grynd:ping") {
        post("grynd:ready", { gameKey, platform, version: 1 });
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [gameKey, platform, post, targetOrigin]);

  const loadMatch = useCallback(
    async (id: string) => {
      try {
        const { status: httpStatus, body } = await callApi(
          `/api/tic-tac-toe/match/${encodeURIComponent(id)}`,
          token,
        );
        if (httpStatus === 401) {
          setExpired(true);
          return;
        }
        const dto = matchFrom(body);
        if (httpStatus !== 200 || !dto) {
          setError(body?.error || "Could not load the practice board.");
          return;
        }
        setMatch(dto);
        setStatus(dto.status === "playing" ? "Your move" : "Match finished");
        if (dto.status !== "playing" && !finishedPosted.current) {
          finishedPosted.current = true;
          post("grynd:match_finished", {
            gameKey,
            status: dto.status,
            result: dto.result ?? null,
          });
        }
      } catch {
        setError("Connection lost. Retrying…");
      }
    },
    [gameKey, post, token],
  );

  const start = useCallback(async () => {
    if (starting || matchId || expired) return;
    setStarting(true);
    setError(null);
    try {
      const { status: httpStatus, body } = await callApi("/api/tic-tac-toe/create-ai", token, {
        method: "POST",
        body: JSON.stringify({ difficulty: "normal" }),
      });
      if (httpStatus === 401) {
        setExpired(true);
        return;
      }
      const id = (body?.data as { matchId?: unknown } | undefined)?.matchId;
      if (httpStatus !== 200 || typeof id !== "string" || !id) {
        setError(body?.error || "Unable to start the practice match.");
        return;
      }
      setMatchId(id);
      setStatus("Starting…");
      post("grynd:match_started", { gameKey });
      await loadMatch(id);
    } catch {
      setError("Unable to start the practice match.");
    } finally {
      setStarting(false);
    }
  }, [expired, gameKey, loadMatch, matchId, post, starting, token]);

  // Poll the authoritative match while it is live. The loop is tied to the
  // match id only, so a snapshot update never restarts it.
  useEffect(() => {
    if (!matchId || expired) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      if (cancelled) return;
      await loadMatch(matchId);
      if (!cancelled) timer = setTimeout(tick, POLL_MS);
    };
    void tick();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [expired, loadMatch, matchId]);

  const play = useCallback(
    async (boardIndex: number, cellIndex: number) => {
      if (!matchId || !match || busy || expired) return;
      setBusy(true);
      setPending({ boardIndex, cellIndex });
      try {
        const { status: httpStatus, body } = await callApi(
          `/api/tic-tac-toe/match/${encodeURIComponent(matchId)}/move`,
          token,
          {
            method: "POST",
            body: JSON.stringify({ boardIndex, cellIndex, expectedVersion: match.version }),
          },
        );
        if (httpStatus === 401) {
          setExpired(true);
          return;
        }
        const dto = matchFrom(body);
        if (httpStatus !== 200 || !dto) {
          setError(body?.error || "That move was rejected.");
          return;
        }
        setMatch(dto);
        setError(null);
      } catch {
        setError("That move could not be sent. Try again.");
      } finally {
        setBusy(false);
        setPending(null);
      }
    },
    [busy, expired, match, matchId, token],
  );

  const exit = useCallback(async () => {
    setExited(true);
    post("grynd:exit", { gameKey });
    // Best-effort revoke; a platform that closes the iframe immediately still
    // gets the benefit of short expiry.
    try {
      await callApi("/api/platform/session/end", token, { method: "POST", body: "{}" });
    } catch {
      // Ignore: the platform page has already been told to close the game.
    }
  }, [gameKey, post, token]);

  return (
    <main className="flex min-h-screen flex-col bg-[#000d1a] text-white">
      <header className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
        <div className="min-w-0">
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#00e5ff]">
            GRYND · {platform}
          </p>
          <p className="truncate text-sm font-semibold">Tic-Tac-Toe practice</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-full border border-white/15 px-2 py-0.5 text-[10px] uppercase tracking-wider text-white/60">
            Unrated
          </span>
          <button
            type="button"
            onClick={() => void exit()}
            className="rounded-lg border border-white/20 px-3 py-1.5 text-xs font-semibold text-white/80"
          >
            Exit
          </button>
        </div>
      </header>

      <section className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 px-4 py-5">
        <p className="text-xs text-[#9dd8ff]/70">
          Practice results here are unrated. No Elo, trophies, coins or account
          statistics are affected.
        </p>

        {expired ? (
          <div className="rounded-xl border border-amber-400/40 bg-amber-500/10 p-4 text-sm text-amber-100">
            This session has expired. Return to {platform} and start the game again.
          </div>
        ) : exited ? (
          <div className="rounded-xl border border-white/10 bg-white/5 p-4 text-sm text-[#9dd8ff]/80">
            You can close this window.
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-semibold text-white/85">{status}</p>
              {!matchId ? (
                <button
                  type="button"
                  onClick={() => void start()}
                  disabled={starting}
                  className="rounded-lg border border-[#00ffa6]/40 bg-[#00ffa6]/10 px-4 py-2 text-sm font-semibold text-[#00ffa6] disabled:opacity-60"
                >
                  {starting ? "Starting…" : "Play the bot"}
                </button>
              ) : null}
            </div>

            {error ? <p className="text-sm text-red-300">{error}</p> : null}

            {match ? (
              <div className="rounded-2xl border border-white/10 bg-black/30 p-2">
                <MegaBoard
                  boards={match.boards}
                  winningBoards={match.winningBoards}
                  lastMove={match.lastMove}
                  nextBoard={match.nextBoard}
                  playableBoards={match.playableBoards}
                  status={match.status}
                  viewerSeat={match.viewerSeat}
                  viewerCanMove={match.viewerCanMove && !busy && !expired}
                  busy={busy}
                  pending={pending}
                  onPlay={(boardIndex, cellIndex) => void play(boardIndex, cellIndex)}
                />
              </div>
            ) : (
              <div className="flex h-64 items-center justify-center rounded-2xl border border-white/10 bg-white/5 text-sm text-white/50">
                Start a practice match to play.
              </div>
            )}
          </>
        )}
      </section>
    </main>
  );
}
