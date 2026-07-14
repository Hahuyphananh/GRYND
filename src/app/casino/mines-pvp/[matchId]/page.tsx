"use client";

// src/app/casino/mines-pvp/[matchId]/page.tsx
//
// MATCH view for the Mines PvP ("Mines Duel") system. Both players
// on the same 5×5 board; server-randomized turn order; each player
// gets 20 s to pick one cell; match resolves after both picks.
//
// Visual design reuses the solo-mines page's 5×5 gameboard
// (cyan safe / magenta mine palette, bomb animation, ❓ for
// unrevealed) and STIPS the left + right sidebars (no bet input,
// no autoplay, no multiplier readout — those don't apply in the
// PvP variant). The page replaces the sidebars with a PvP-specific
// turn indicator + 20 s countdown + a post-match result screen
// that reveals the full board + payout breakdown.

import { useCallback, useEffect, useMemo, useRef, useState, use } from "react";
import { useRouter } from "next/navigation";
import { usePostHog } from "posthog-js/react";
import { useUser } from "@clerk/nextjs";
import { motion } from "framer-motion";
import NavigationBar from "../../../../components/navigation-bar";
import Footer from "../../../../components/Footer";
import { useSocket } from "../../../../context/SocketProvider";
import {
  MINES_PVP_LOBBY_ROOM,
  MINES_PVP_MATCH_UPDATED,
  minesPvpMatchRoom,
} from "../../../../lib/mines-pvp/rooms";
import {
  MATCH_STATUS,
  RESULT,
  GRID_CELLS,
} from "../../../../lib/mines-pvp/constants";

// ── Animation: bomb glyph (reused from solo mines) ──────────────────
function AnimatedBomb({ exploded = false }: { exploded?: boolean }) {
  return (
    <span
      className={`
        relative text-4xl
        ${exploded ? "animate-bomb-explode" : "animate-bomb-fuse"}
      `}
    >
      💣
      {!exploded && (
        <span className="absolute -top-2 -right-2 text-orange-400 animate-ping">
          ✨
        </span>
      )}
    </span>
  );
}

// ── Inline SVG icons (kept in-file so this page doesn't pull in
// other game-specific icon sets) ─────────────────────────────────────

function CoinIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <ellipse cx="12" cy="6" rx="8" ry="2.5" />
      <path d="M4 6 V18 a8 2.5 0 0 0 16 0 V6" />
      <ellipse cx="12" cy="18" rx="8" ry="2.5" />
    </svg>
  );
}

function MineIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <circle cx="12" cy="14" r="7" />
      <path d="M14 7 L17 4" />
      <path d="M16 4 L18 4 L18 6" />
      <circle cx="18" cy="4" r="0.8" fill="currentColor" stroke="none" />
    </svg>
  );
}

function ClockIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7 V12 L15 14" />
    </svg>
  );
}

function CheckIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M5 12 L10 17 L19 7" />
    </svg>
  );
}

function CrossIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M6 6 L18 18" />
      <path d="M18 6 L6 18" />
    </svg>
  );
}

function LoadingDotsIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden
    >
      <circle cx="6" cy="12" r="2" />
      <circle cx="12" cy="12" r="2" />
      <circle cx="18" cy="12" r="2" />
    </svg>
  );
}

function AlertIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M12 3 L22 20 H2 Z" />
      <line x1="12" y1="10" x2="12" y2="15" />
      <circle cx="12" cy="17.5" r="0.8" fill="currentColor" stroke="none" />
    </svg>
  );
}

// ── Type for the match payload returned by /api/mines-pvp/[id]/status
// Mirrors the schema (`mines_pvp_matches` + the server-side
// `scrubMatchForViewer` contract: `board` is null while not yet
// finished, populated with the real `{ size, mines }` once
// status='finished').
//
// New odds-turn flow: `picks` is the chronologically-ordered
// JSONB array of every pick made in this match (the source of
// truth). The legacy `p1Pick` / `p2Pick` scalars still come back
// for backwards-compat and hold the most-recent pick from each
// seat.
type PickEntry = {
  userId: string | null;
  seat: "player1" | "player2" | null;
  cell: number;
  isMine: boolean;
  autoPicked: boolean;
  pickedAt: string | null;
};

type MatchRow = {
  id: number;
  player1Id: string;
  player2Id: string | null;
  stakeAmount: string;
  status: string;
  minesCount: number;
  board: { size: number; mines: number[] } | null;
  firstPlayerId: string | null;
  currentTurnUserId: string | null;
  // Chronological pick history (server-advertised; sanitised per
  // viewer in scrubPickRowsForViewer).
  picks: PickEntry[];
  pickCount: number;
  // Legacy single-pick columns (kept for backwards compat with
  // /status consumers — mirror the most-recent pick from each
  // seat).
  p1Pick: number | null;
  p2Pick: number | null;
  p1PickIsMine: boolean | null;
  p2PickIsMine: boolean | null;
  p1AutoPicked: boolean;
  p2AutoPicked: boolean;
  p1PickedAt: string | null;
  p2PickedAt: string | null;
  roundDeadline: string | null;
  roundTimerSeconds: number;
  winnerId: string | null;
  result: string | null;
  houseFee: string;
  prizePaid: string;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
};

// ── Dynamic-route params arrive async (Promise) on Next.js 15+/16. ─────
// BUG-FIX ("both players stuck in loading mode when starting a game")
// ────────────────────────────────────────────────────────
// The page's two polling URLs were pointed at /api/mines-pvp/${matchId}/status
// and /api/mines-pvp/${matchId}/pick, but those routes never existed — the
// real match gateway lives at /api/mines-pvp/match/${matchId} (with /pick
// underneath it). Every poll therefore 404'd on the server, the response
// body that came back was HTML (not JSON), and the resulting parse error
// surfaced as "Network error" / "Match not found" instead of the live
// match — both players looked stuck on the loading screen. The two URL
// typos are corrected in the `fetchStatus` and `handleCellClick` blocks
// below. As belt-and-braces we also: (a) unwrap the async params prop
// with React's `use()` (mirror of the roulette + blackjack match views)
// so the page never receives `matchId === NaN`; (b) flip setLoading(false)
// on every early-return path in fetchStatus so a stray guard never pins
// the page to "Loading match…"; and (c) tighten the isSignedIn check so
// the brief window before Clerk reports `true`/`false` doesn't dump the
// user onto the "Match not found" panel.
export default function MinesPvpMatchPage({
  params,
}: {
  params: Promise<{ matchId: string }>;
}) {
  // Memoize a stable Promise wrapping the raw `params` prop so `use()`
  // is callable unconditionally on every render (React rules-of-
  // hooks). `Promise.resolve(p)` flattens when `params` is itself a
  // thenable; wraps a plain object on older Next.js so the call is
  // safe there too. The grandparent <Suspense> boundary provided by
  // the route segment (Next.js default behaviour) covers the brief
  // suspend.
  const paramsPromise = useMemo(
    () => Promise.resolve(params),
    [params],
  );
  const resolvedParams = use(paramsPromise);
  const rawMatchId =
    resolvedParams && typeof resolvedParams === "object"
      ? resolvedParams.matchId
      : undefined;
  const numericMatchId = Number(rawMatchId);
  // `matchId` is `null` until params resolve and on truly malformed
  // URLs (e.g. /casino/mines-pvp/not-a-number). Used everywhere the
  // route id is needed; downstream `if (!isValidMatchId)` guards in
  // fetchStatus / effects keep API calls safe.
  const matchId = Number.isFinite(numericMatchId) ? numericMatchId : null;
  const isValidMatchId = matchId !== null;
  const { isSignedIn, user } = useUser();
  const router = useRouter();
  const posthog = usePostHog();
  const { socket } = useSocket();

  // ── Match state ──────────────────────────────────────────────────
  const [match, setMatch] = useState<MatchRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false); // true while a pick POST is in flight
  const [cancelling, setCancelling] = useState(false);
  const [timeLeft, setTimeLeft] = useState<number>(0);

  // Refs used to anchor the countdown interval + the last-seen
  // deadline timestamp so we don't reset the countdown when the
  // status poll lands a few ms early/late.
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Guard so the `mines_pvp_match_resolved` Posthog event fires
  // exactly once per match-resolution, mirroring the
  // `roulette_pvp_match_finished` pattern in
  // src/app/casino/roulette/[matchId]/page.jsx. The ref is
  // re-initialized when the component remounts (different matchId)
  // so navigating between matches doesn't suppress the event.
  const resolvedFiredRef = useRef(false);

  // ── Status fetch ─────────────────────────────────────────────────
  // The /status route calls serverStore.fetchMatchWithAutoResolve,
  // which auto-advances ready→first-turn on the 3s ready deadline
  // and triggers AFK force-pick on the 20s pick deadline. So just
  // polling it on the 1.5s tick is enough — no client-side
  // deadline handling.
  const fetchStatus = useCallback(async () => {
    // BUG-FIX: the original guard was `if (!isSignedIn || !Number.isFinite(matchId)) return;`
    // — that early `return` skipped the `finally { setLoading(false) }`, so any
    // page mount where `matchId` wasn't a finite number left the user pinned to the
    // "Loading match…" spinner. We now branch + flip `loading=false` so the
    // existing `if (!match)` render path renders the "Match not found" panel.
    // Clerk reports `isSignedIn` only AFTER it loads; before that, the
    // value is `undefined`, which would have triggered the early return
    // below and dumped the user onto the "Match not found" panel for the
    // ~hundreds of ms Clerk takes to decide. We now distinguish "loaded +
    // signed out" (real sign-out → redirect) from "loaded + signed in" (poll
    // normally). While Clerk is still deciding we hold `loading=true` so
    // the spinner stays put.
    if (isSignedIn === false) {
      setLoading(false);
      setError("You must be signed in to view this match.");
      return;
    }
    // If isSignedIn is undefined we simply skip the fetch this tick —
    // it's a Clerk-warming-up window, the polling interval will retry
    // inside 1.5 s once Clerk reports the actual value.
    if (isSignedIn !== true) {
      return;
    }
    if (!isValidMatchId) {
      setLoading(false);
      setError("Invalid match link.");
      return;
    }
    try {
      // BUG-FIX: the route lives at /api/mines-pvp/match/[matchId] (verified
      // via `src/app/api/mines-pvp/match/[matchId]/route.js`); the old
      // /api/mines-pvp/${matchId}/status URL 404'd on every poll.
      const res = await fetch(`/api/mines-pvp/match/${matchId}`, {
        cache: "no-store",
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(data?.error || "Unable to load match");
        return;
      }
      // Defensive null-check: API contract says `data.data.match` is the
      // match row OR null; never undefined. Guard against malformed frames
      // so we always end up on a defined UI state instead of an unhandled
      // object.
      const nextMatch =
        data?.data?.match && typeof data.data.match === "object"
          ? data.data.match
          : null;
      setMatch(nextMatch);
      // A successful response always wins over any stale tick error —
      // never preserve "Network error" across a fresh "match is gone"
      // confirmation.
      setError(nextMatch ? null : "Match not found.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setLoading(false);
    }
  }, [isSignedIn, isValidMatchId, matchId]);

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 1500);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  // ── Socket subscription ──────────────────────────────────────────
  // Listen for the per-match room event so the 1.5 s poll can
  // short-circuit on the opponent's pick (the realtime-server's
  // `room_event` handler routes the per-match broadcast into the
  // per-match room, and the `MINES_PVP_MATCH_UPDATED` event name
  // is the same on the lobby room + the per-match room).
  useEffect(() => {
    if (!socket) return;
    const refresh = () => fetchStatus();
    const roomId = minesPvpMatchRoom(matchId);
    socket.emit("join_room", { roomId });
    socket.on(MINES_PVP_MATCH_UPDATED, refresh);
    return () => {
      socket.emit("leave_room", { roomId });
      socket.off(MINES_PVP_MATCH_UPDATED, refresh);
    };
  }, [socket, matchId, fetchStatus]);

  // ── Countdown tick ───────────────────────────────────────────────
  // Driven by the server's `round_deadline` timestamp. Re-syncs
  // whenever the deadline column changes (status poll returns a
  // fresh row with a fresh deadline on each turn start).
  useEffect(() => {
    if (tickRef.current) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
    if (
      !match?.roundDeadline ||
      match.status === MATCH_STATUS.FINISHED ||
      match.status === MATCH_STATUS.CANCELLED
    ) {
      setTimeLeft(0);
      return;
    }
    const deadlineMs = new Date(match.roundDeadline).getTime();
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((deadlineMs - Date.now()) / 1000));
      setTimeLeft(remaining);
    };
    tick();
    tickRef.current = setInterval(tick, 250);
    return () => {
      if (tickRef.current) {
        clearInterval(tickRef.current);
        tickRef.current = null;
      }
    };
  }, [match?.roundDeadline, match?.status]);

  // ── Derived UI state ─────────────────────────────────────────────
  const myUserId = user?.id;

  // Per-seat pick history derived from the chronological `picks`
  // array. Replaces the old single `p1Pick`/`p2Pick` derived
  // fields below. The cell helpers + handleCellClick below use
  // THESE so a player who has picked multiple times still sees
  // every cleared cell.
  const myPicks = useMemo(() => {
    if (!match || !myUserId) return [] as number[];
    return (match.picks ?? [])
      .filter((p) => p && p.userId === myUserId)
      .map((p) => p.cell);
  }, [match, myUserId]);
  const opponentPicks = useMemo(() => {
    if (!match || !myUserId) return [] as number[];
    return (match.picks ?? [])
      .filter((p) => p && p.userId !== null && p.userId !== myUserId)
      .map((p) => p.cell);
  }, [match, myUserId]);
  // My most-recent pick (for "you just picked this" UI affordances
  // + auto-picked flag display inside the result popup).
  const myLastPick = useMemo(() => {
    if (!match || !myUserId) return null as PickEntry | null;
    for (let i = (match.picks ?? []).length - 1; i >= 0; i -= 1) {
      const p = match.picks[i];
      if (p && p.userId === myUserId) return p;
    }
    return null;
  }, [match, myUserId]);
  const opponentLastPick = useMemo(() => {
    if (!match || !myUserId) return null as PickEntry | null;
    for (let i = (match.picks ?? []).length - 1; i >= 0; i -= 1) {
      const p = match.picks[i];
      if (p && p.userId !== null && p.userId !== myUserId) return p;
    }
    return null;
  }, [match, myUserId]);

  // ── Posthog: match-just-resolved ───────────────────────────────
  // Capture `mines_pvp_match_resolved` on the first poll that
  // observes status='finished'. Mirrors roulette-pvp's
  // `roulette_pvp_match_finished` event (same shape: match_id,
  // winner, prize_paid). Subsequent polls of the same match (or
  // component re-renders with a stale `match` object) hit the
  // `resolvedFiredRef` guard and are no-ops.
  useEffect(() => {
    if (!match || match.status !== MATCH_STATUS.FINISHED) {
      // Reset the guard for non-finished states so a remount
      // (e.g. navigating from one match view to another in the
      // same SPA session) gets a fresh event.
      if (resolvedFiredRef.current) {
        resolvedFiredRef.current = false;
      }
      return;
    }
    if (resolvedFiredRef.current) return;
    resolvedFiredRef.current = true;

    const iWon = Boolean(
      match.winnerId && myUserId && match.winnerId === myUserId,
    );
    const winner = iWon ? "you" : "opponent";
    const allPicks = Array.isArray(match.picks) ? match.picks : [];
    const mineHit = allPicks.find((p) => Boolean(p && p.isMine)) ?? null;
    const safePickCounts = { player1: 0, player2: 0 };
    for (const p of allPicks) {
      if (!p || p.isMine) continue;
      if (p.seat === "player1") safePickCounts.player1 += 1;
      else if (p.seat === "player2") safePickCounts.player2 += 1;
    }
    posthog?.capture("mines_pvp_match_resolved", {
      match_id: matchId,
      winner,
      result: match.result,
      stake: Number(match.stakeAmount).toFixed(2),
      prize_paid: Number(match.prizePaid).toFixed(2),
      house_fee: Number(match.houseFee).toFixed(2),
      mines_count: match.minesCount,
      pick_count: allPicks.length,
      p1_safe_picks: safePickCounts.player1,
      p2_safe_picks: safePickCounts.player2,
      loser_id: mineHit ? mineHit.userId ?? null : null,
      loser_seat: mineHit ? mineHit.seat ?? null : null,
      loser_pick_cell: mineHit ? mineHit.cell ?? null : null,
    });
  }, [match, matchId, myUserId, posthog]);
  const isParticipant = useMemo(() => {
    if (!match || !myUserId) return false;
    return match.player1Id === myUserId || match.player2Id === myUserId;
  }, [match, myUserId]);
  const isPlayer1 = match?.player1Id === myUserId;
  const isMyTurn =
    match?.status === MATCH_STATUS.P1_TURN
      ? isPlayer1
      : match?.status === MATCH_STATUS.P2_TURN
        ? !isPlayer1
        : false;
  const mySeat = isPlayer1 ? "player1" : "player2";
  // Most-recent-of-each-seat helpers (used by the legacy pick-audit
  // block inside the result popup). The rest of the UI consumes the
  // per-cell `picks`-array helpers above so a player who has
  // picked multiple times still sees every cleared cell.
  const myPick = myLastPick?.cell ?? null;
  const myPickIsMine = myLastPick?.isMine ?? null;
  const myAutoPicked = myLastPick?.autoPicked ?? false;
  const opponentPick = opponentLastPick?.cell ?? null;
  const opponentPickIsMine = opponentLastPick?.isMine ?? null;
  const opponentAutoPicked = opponentLastPick?.autoPicked ?? false;

  // ── Action handlers ──────────────────────────────────────────────
  const handleCellClick = useCallback(
    async (cellIndex: number) => {
      if (!isMyTurn || busy || !match) return;
      // BUG-FIX ("opponent can't click tiles on their second turn"):
      // The old single-pick guard was `if (myPick !== null) return;`,
      // which blocked players who had already made at least one pick
      // in this match. The odds-turn flow lets the same player pick
      // multiple times across a single match (e.g. sequence
      // P1 → P2 → P2 → P1 → P1 in `activePickerForMatch`'s closed
      // form), so once a player has any prior pick their `myPick`
      // points at it and the guard fired on every subsequent click
      // even though the cell was empty. Use the per-cell picks-array
      // membership checks — same pattern as the disabled-button
      // `cellAlreadyPicked` predicate in the render block, so the
      // client UI + server-side dedup (`pickHistoryCells`) agree.
      if (myPicks.includes(cellIndex)) return; // already picked by me
      if (opponentPicks.includes(cellIndex)) return; // duplicate (opponent already picked this cell)
      setBusy(true);
      setError(null);
      try {
        // BUG-FIX: route lives at /api/mines-pvp/match/[matchId]/pick,
        // not /api/mines-pvp/${matchId}/pick (which 404'd).
        const res = await fetch(`/api/mines-pvp/match/${matchId}/pick`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ cellIndex }),
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
          setError(data?.error || "Pick failed");
          return;
        }
        // Fanout the broadcast to BOTH the per-match room (so the
        // opponent's match view refetches inside ~50 ms) and the
        // lobby room (so the open-lobbies list drops a now-active
        // match). Belt-and-braces with the 1.5 s poll.
        socket?.emit("room_event", {
          roomId: minesPvpMatchRoom(matchId),
          event: MINES_PVP_MATCH_UPDATED,
        });
        socket?.emit("room_event", {
          roomId: MINES_PVP_LOBBY_ROOM,
          event: MINES_PVP_MATCH_UPDATED,
        });
        posthog?.capture("mines_pvp_pick", {
          match_id: matchId,
          cell_index: cellIndex,
          auto: false,
        });
        await fetchStatus();
      } finally {
        setBusy(false);
      }
    },
    [busy, fetchStatus, isMyTurn, match, matchId, myPicks, opponentPicks, posthog, socket],
  );

  const handleCancel = useCallback(async () => {
    if (cancelling) return;
    setCancelling(true);
    setError(null);
    try {
      const res = await fetch(`/api/mines-pvp/match/${matchId}/cancel`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(data?.error || "Cancel failed");
        return;
      }
      posthog?.capture("mines_pvp_lobby_cancelled", { match_id: matchId });
      router.push("/casino/mines-pvp");
    } finally {
      setCancelling(false);
    }
  }, [cancelling, matchId, posthog, router]);

  // ── Cell rendering helpers (reused from solo mines page) ────────
  // Returns { content, style } for a single cell based on the
  // current match state. Two display modes in the odds-turn flow:
  //   1. Mid-match (status not 'finished') — render EVERY cleared
  //      cell as a 💎, color-coded to its picker (cyan = player1,
  //      fuchsia = player2). Revealing safe picks is safe because
  //      the game would have ended if any were a mine.
  //   2. Finished — full board reveal: all mines shown, all safe
  //      cells shown, plus per-pick ring highlighting.
  function getCellDisplay(cellIndex: number): {
    content: React.ReactNode;
    revealed: boolean;
    isMine: boolean;
  } {
    if (!match) {
      return { content: "❓", revealed: false, isMine: false };
    }
    const isFinished = match.status === MATCH_STATUS.FINISHED;

    // Build lookup from cell index → the pick entry that holds it.
    // O(N) but N ≤ 25 so it's cheap; avoids `.find` per tile.
    const pickByCell = new Map<number, PickEntry>();
    for (const p of match.picks ?? []) {
      if (p && typeof p.cell === "number" && Number.isInteger(p.cell)) {
        pickByCell.set(p.cell, p);
      }
    }

    // Mid-match: render every revealed cell as a 💎. The board
    // mines themselves stay hidden (we can't server-trust the
    // board column mid-match — it's null until finished).
    if (!isFinished) {
      const entry = pickByCell.get(cellIndex);
      if (entry) {
        // Every in-flight pick is guaranteed safe (a mine would
        // have ended the match). The seats get their own accent so
        // a glance at the board shows whose territory is whose.
        return {
          content: "💎",
          revealed: true,
          isMine: false,
        };
      }
      return { content: "❓", revealed: false, isMine: false };
    }

    // Finished: full board reveal. The board column is now
    // non-null so we can show every mine (including those that
    // were not picked).
    const mines = match.board?.mines ?? [];
    const pickedEntry = pickByCell.get(cellIndex);
    if (pickedEntry?.isMine) {
      // A picked mine: the picker lost. Render as bomb.
      return {
        content: <AnimatedBomb exploded />,
        revealed: true,
        isMine: true,
      };
    }
    if (pickedEntry) {
      return {
        content: "💎",
        revealed: true,
        isMine: false,
      };
    }
    const isMine = mines.includes(cellIndex);
    return {
      content: isMine ? <AnimatedBomb exploded /> : "💎",
      revealed: true,
      isMine,
    };
  }

  // Helper to know which seat a cell belongs to after the match
  // finishes (or mid-match for accent styling). Returns null on
  // unrevealed cells.
  function cellPickSeat(cellIndex: number): "player1" | "player2" | null {
    if (!match) return null;
    for (const p of match.picks ?? []) {
      if (p && p.cell === cellIndex) return p.seat ?? null;
    }
    return null;
  }

  function getCellClass(cellIndex: number): string {
    if (!match) {
      return "bg-[#071226] border border-[#00e5ff]/20";
    }
    const isFinished = match.status === MATCH_STATUS.FINISHED;
    const display = getCellDisplay(cellIndex);
    const seat = cellPickSeat(cellIndex);
    const isMyCell = seat
      ? (isPlayer1 && seat === "player1") ||
        (!isPlayer1 && seat === "player2")
      : false;

    if (display.revealed) {
      if (display.isMine) {
        // The mine that ended the game; always bright red.
        const highlight = isMyCell
          ? "shadow-[0_0_18px_rgba(255,79,216,0.95)] ring-2 ring-red-300/80"
          : "shadow-[0_0_14px_rgba(255,79,216,0.6)]";
        return `bg-[#3b1021] border-2 border-[#ff4fd8] ${highlight}`;
      }
      // Safe revealed cell — seat-tinted accent. Player1 picks
      // glow cyan, Player2 picks glow fuchsia, regardless of who
      // the viewer is (so both players can read the board).
      const ring = isMyCell
        ? "ring-2 ring-cyan-300/70 shadow-[0_0_14px_rgba(0,229,255,0.7)]"
        : seat === "player1"
          ? "ring-1 ring-cyan-300/30 shadow-[0_0_8px_rgba(0,229,255,0.25)]"
          : seat === "player2"
            ? "ring-1 ring-fuchsia-300/30 shadow-[0_0_8px_rgba(255,79,216,0.25)]"
            : "";
      return `bg-[#09243f] border border-[#00e5ff] ${ring}`;
    }

    // Unrevealed — interactive only on your turn + cell not yet
    // picked by either side. The old `myPick === null` guard is
    // gone because the new flow lets a player have already picked
    // several cells and STILL have a turn (FP/SP/SP/FP …).
    const isPlayable =
      isMyTurn &&
      !myPicks.includes(cellIndex) &&
      !opponentPicks.includes(cellIndex);
    if (isFinished) {
      return "bg-[#0c1a33] border border-[#1f3a6a]";
    }
    if (isPlayable) {
      return "bg-[#071226] border border-[#00e5ff]/20 hover:border-[#00e5ff]/70 hover:shadow-[0_0_16px_rgba(0,229,255,0.35)]";
    }
    return "bg-[#071226] border border-[#00e5ff]/15 opacity-60";
  }

  // ── Turn indicator / status banner ───────────────────────────────
  function renderTurnIndicator() {
    if (!match) return null;
    const isFinished = match.status === MATCH_STATUS.FINISHED;
    const isCancelled = match.status === MATCH_STATUS.CANCELLED;
    const urgent = timeLeft > 0 && timeLeft <= 5;

    if (isCancelled) {
      return (
        <div className="flex items-center justify-center gap-2 rounded-xl border border-red-400/40 bg-red-900/30 px-4 py-3 text-red-200">
          <AlertIcon className="w-5 h-5 text-red-300" />
          <span className="font-semibold">This match was cancelled.</span>
        </div>
      );
    }
    if (isFinished) {
      // Result screen handles its own rendering below.
      return null;
    }
    if (match.status === MATCH_STATUS.WAITING) {
      return (
        <div className="flex items-center justify-center gap-2 rounded-xl border border-cyan-300/40 bg-cyan-500/10 px-4 py-3 text-cyan-200">
          <LoadingDotsIcon className="w-5 h-5 text-cyan-200 animate-pulse" />
          <span className="font-semibold">
            Waiting for an opponent to join… (your stake is escrowed)
          </span>
        </div>
      );
    }
    if (match.status === MATCH_STATUS.READY) {
      return (
        <div className="flex items-center justify-center gap-2 rounded-xl border border-cyan-300/40 bg-cyan-500/10 px-4 py-3 text-cyan-200">
          <LoadingDotsIcon className="w-5 h-5 text-cyan-200 animate-pulse" />
          <span className="font-semibold">
            Both players joined — starting in a few seconds…
          </span>
        </div>
      );
    }
    // p1_turn or p2_turn.
    if (isMyTurn) {
      return (
        <div
          className={`flex flex-wrap items-center justify-center gap-3 rounded-xl border px-4 py-3 ${
            urgent
              ? "border-red-400/60 bg-red-900/30 text-red-200 animate-pulse"
              : "border-cyan-300/40 bg-cyan-500/10 text-cyan-200"
          }`}
        >
          <span className="font-bold text-base sm:text-lg">
            Your turn — pick a tile
          </span>
          <span
            className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-sm font-bold ${
              urgent
                ? "bg-red-500/30 text-red-100"
                : "bg-cyan-500/30 text-cyan-100"
            }`}
          >
            <ClockIcon className="w-4 h-4" />
            {timeLeft}s
          </span>
        </div>
      );
    }
    return (
      <div
        className={`flex flex-wrap items-center justify-center gap-3 rounded-xl border border-fuchsia-300/40 bg-fuchsia-500/10 px-4 py-3 text-fuchsia-200`}
      >
        <span className="font-bold text-base sm:text-lg">
          Opponent is picking…
        </span>
        <span className="inline-flex items-center gap-1 rounded-full bg-fuchsia-500/30 px-3 py-1 text-sm font-bold text-fuchsia-100">
          <ClockIcon className="w-4 h-4" />
          {timeLeft}s
        </span>
      </div>
    );
  }

  // ── Result screen ────────────────────────────────────────────────
  function renderResult() {
    if (!match || match.status !== MATCH_STATUS.FINISHED) return null;
    const iWon =
      match.winnerId && myUserId && match.winnerId === myUserId;
    const iLost =
      match.winnerId && myUserId && match.winnerId !== myUserId;
    const headline = iWon
      ? "Opponent hit a mine - you take the pot"
      : iLost
        ? "You hit a mine"
        : "Match complete";

    const headlineColor = iWon
      ? "text-emerald-300"
      : iLost
        ? "text-red-300"
        : "text-white";
    const headlineEmoji = iWon ? "🏆" : iLost ? "💣" : "✅";
    const headlineBg = iWon
      ? "from-[#0d2b1a] to-[#062a16] border-emerald-300/50 shadow-[0_0_60px_rgba(72,209,154,0.35)]"
      : iLost
        ? "from-[#3a1a1a] to-[#2b0d0d] border-red-500/40 shadow-[0_0_60px_rgba(239,68,68,0.3)]"
        : "from-[#0a1a3a] to-[#04102a] border-cyan-300/40";

    const stake = Number(match.stakeAmount);
    const houseFee = Number(match.houseFee);
    const prizePaid = Number(match.prizePaid);

    return (
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35 }}
        className={`mt-4 rounded-3xl border-2 bg-gradient-to-b p-6 text-center ${headlineBg}`}
      >
          <motion.div
            initial={{ scale: 0, rotate: -25 }}
            animate={{ scale: 1, rotate: 0 }}
            transition={{ type: "spring", stiffness: 300, damping: 12, delay: 0.1 }}
            className="mb-2 text-7xl"
          >
            {headlineEmoji}
          </motion.div>
          <h2 className={`mt-3 text-3xl sm:text-4xl font-black uppercase ${headlineColor}`}>
            {headline}
          </h2>
          <p className="mt-1 text-sm text-white/70">
            {iWon
              ? `You took home ${prizePaid.toFixed(2)} tokens (your stake + 90% of opponent's).`
              : iLost
                ? `You lost your ${stake.toFixed(2)} stake. House kept ${houseFee.toFixed(2)}.`
                : "Result recorded."}
          </p>

          {/* Payout breakdown */}
          <div className="mt-4 grid grid-cols-3 gap-2 text-xs sm:text-sm">
            <div className="rounded-lg border border-white/10 bg-black/30 p-2">
              <p className="text-[10px] uppercase tracking-wider text-white/45">Stake</p>
              <p className="font-bold text-white">{stake.toFixed(2)}</p>
            </div>
            <div className="rounded-lg border border-white/10 bg-black/30 p-2">
              <p className="text-[10px] uppercase tracking-wider text-white/45">Prize</p>
              <p className={`font-bold ${prizePaid > 0 ? "text-emerald-300" : "text-white/50"}`}>
                {prizePaid.toFixed(2)}
              </p>
            </div>
            <div className="rounded-lg border border-white/10 bg-black/30 p-2">
              <p className="text-[10px] uppercase tracking-wider text-white/45">House</p>
              <p className={`font-bold ${houseFee > 0 ? "text-fuchsia-300" : "text-white/50"}`}>
                {houseFee.toFixed(2)}
              </p>
            </div>
          </div>

          {/* Pick audit */}
          <div className="mt-4 grid grid-cols-2 gap-2 text-left text-xs">
            <div className="rounded-lg border border-cyan-300/20 bg-cyan-500/5 p-3">
              <p className="text-[10px] uppercase tracking-wider text-cyan-200/70">
                You picked cell #{myPick ?? "?"}
              </p>
              <p className="mt-1 inline-flex items-center gap-1 font-semibold">
                {myPickIsMine ? (
                  <span className="text-red-300 inline-flex items-center gap-1">
                    <CrossIcon className="w-3.5 h-3.5" /> Mine
                  </span>
                ) : myPick !== null ? (
                  <span className="text-emerald-300 inline-flex items-center gap-1">
                    <CheckIcon className="w-3.5 h-3.5" /> Safe
                  </span>
                ) : (
                  "—"
                )}
                {myAutoPicked && (
                  <span className="ml-1 rounded bg-yellow-300/20 px-1.5 py-0.5 text-[10px] font-bold text-yellow-200">
                    AFK auto
                  </span>
                )}
              </p>
            </div>
            <div className="rounded-lg border border-fuchsia-300/20 bg-fuchsia-500/5 p-3">
              <p className="text-[10px] uppercase tracking-wider text-fuchsia-200/70">
                Opponent picked cell #{opponentPick ?? "?"}
              </p>
              <p className="mt-1 inline-flex items-center gap-1 font-semibold">
                {opponentPickIsMine ? (
                  <span className="text-red-300 inline-flex items-center gap-1">
                    <CrossIcon className="w-3.5 h-3.5" /> Mine
                  </span>
                ) : opponentPick !== null ? (
                  <span className="text-emerald-300 inline-flex items-center gap-1">
                    <CheckIcon className="w-3.5 h-3.5" /> Safe
                  </span>
                ) : (
                  "—"
                )}
                {opponentAutoPicked && (
                  <span className="ml-1 rounded bg-yellow-300/20 px-1.5 py-0.5 text-[10px] font-bold text-yellow-200">
                    AFK auto
                  </span>
                )}
              </p>
            </div>
          </div>

          <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
            <button
              onClick={() => router.push("/casino/mines-pvp")}
              className="px-5 py-2.5 rounded-xl bg-cyan-400 text-[#001933] hover:bg-cyan-300 text-sm font-bold shadow-[0_0_18px_rgba(0,229,255,0.5)] transition"
            >
              Back to lobby
            </button>
            <button
              onClick={() => router.push("/casino")}
              className="px-5 py-2.5 rounded-xl border border-cyan-300/40 bg-transparent text-cyan-200 hover:bg-cyan-300/10 text-sm font-bold transition"
            >
              All games
            </button>
          </div>
      </motion.div>
    );
  }

  // ── Render ───────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="min-h-screen overflow-x-clip bg-gradient-to-br from-[#001933] to-[#000d1a] px-3 pb-24 pt-20 text-white sm:px-6 md:pb-8">
        <NavigationBar currentPath="/casino" />
        <div className="mx-auto mt-12 flex max-w-3xl items-center justify-center gap-3 text-cyan-200">
          <LoadingDotsIcon className="w-6 h-6 text-cyan-300 animate-pulse" />
          <span>Loading match…</span>
        </div>
      </div>
    );
  }

  if (!match) {
    return (
      <div className="min-h-screen overflow-x-clip bg-gradient-to-br from-[#001933] to-[#000d1a] px-3 pb-24 pt-20 text-white sm:px-6 md:pb-8">
        <NavigationBar currentPath="/casino" />
        <div className="mx-auto mt-12 max-w-3xl rounded-2xl border border-red-400/40 bg-red-900/30 p-6 text-red-200">
          <div className="flex items-center gap-2">
            <AlertIcon className="w-5 h-5 text-red-300" />
            <span className="font-semibold">{error || "Match not found."}</span>
          </div>
          <button
            onClick={() => router.push("/casino/mines-pvp")}
            className="mt-4 px-4 py-2 rounded-lg bg-cyan-400 text-[#001933] hover:bg-cyan-300 text-sm font-bold"
          >
            Back to lobby
          </button>
        </div>
        <Footer />
      </div>
    );
  }

  if (!isParticipant) {
    return (
      <div className="min-h-screen overflow-x-clip bg-gradient-to-br from-[#001933] to-[#000d1a] px-3 pb-24 pt-20 text-white sm:px-6 md:pb-8">
        <NavigationBar currentPath="/casino" />
        <div className="mx-auto mt-12 max-w-3xl rounded-2xl border border-red-400/40 bg-red-900/30 p-6 text-red-200">
          <div className="flex items-center gap-2">
            <AlertIcon className="w-5 h-5 text-red-300" />
            <span className="font-semibold">You are not a participant in this match.</span>
          </div>
          <button
            onClick={() => router.push("/casino/mines-pvp")}
            className="mt-4 px-4 py-2 rounded-lg bg-cyan-400 text-[#001933] hover:bg-cyan-300 text-sm font-bold"
          >
            Back to lobby
          </button>
        </div>
        <Footer />
      </div>
    );
  }

  const stake = Number(match.stakeAmount);
  const canCancel =
    match.status === MATCH_STATUS.WAITING &&
    match.player1Id === myUserId &&
    !cancelling;

  return (
    <div className="min-h-screen overflow-x-clip bg-gradient-to-br from-[#001933] to-[#000d1a] px-3 pb-24 pt-20 text-white sm:px-6 md:pb-8">
      <NavigationBar currentPath="/casino" />

      <div className="mx-auto mt-4 max-w-3xl sm:mt-8">
        <motion.div
          initial={{ opacity: 0, y: -12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
        >
          <h1 className="flex items-center justify-center gap-3 text-center text-2xl sm:text-3xl font-extrabold tracking-wide text-transparent bg-clip-text bg-gradient-to-r from-cyan-200 via-cyan-300 to-fuchsia-300 drop-shadow-[0_0_18px_rgba(0,229,255,0.55)]">
            <MineIcon className="w-7 h-7 sm:w-8 sm:h-8 text-cyan-300 drop-shadow-[0_0_12px_rgba(0,229,255,0.65)] flex-shrink-0" />
            <span>Mines Duel · Match #{matchId}</span>
          </h1>
        </motion.div>

        {/* Match info strip */}
        <div className="mt-3 flex flex-wrap items-center justify-center gap-x-5 gap-y-1 text-xs text-white/60">
          <span className="inline-flex items-center gap-1">
            Stake:
            <span className="text-yellow-300 font-semibold inline-flex items-center gap-1">
              {stake.toLocaleString()}
              <CoinIcon className="w-3.5 h-3.5 text-yellow-300" />
            </span>
          </span>
          <span className="inline-flex items-center gap-1">
            Mines:
            <span className="text-fuchsia-300 font-semibold inline-flex items-center gap-1">
              {match.minesCount}
              <MineIcon className="w-3.5 h-3.5 text-fuchsia-300" />
            </span>
          </span>
          <span>
            Seat: <span className="text-cyan-200 font-semibold">{mySeat}</span>
          </span>
        </div>

        {/* Turn indicator */}
        <div className="mt-4">{renderTurnIndicator()}</div>

        {/* Error banner */}
        {error && (
          <div className="mt-3 flex items-center gap-2 rounded-lg border border-red-400/40 bg-red-900/30 px-3 py-2 text-sm text-red-200">
            <AlertIcon className="w-4 h-4 text-red-300" />
            <span>{error}</span>
          </div>
        )}

        {/* ── The 5×5 gameboard (reused from solo mines) ────────── */}
        <div
          className={`mt-6 rounded-2xl border border-[#00e5ff]/40 bg-gradient-to-br from-[#001933] via-[#00111f] to-[#000814] p-6 shadow-[0_0_60px_rgba(0,229,255,0.18),inset_0_0_30px_rgba(0,229,255,0.08)]`}
        >
          <div
            className={`grid grid-cols-5 gap-3 ${
              match.status === MATCH_STATUS.FINISHED ? "" : ""
            }`}
          >
            {Array.from({ length: GRID_CELLS }, (_, i) => i).map((cellIndex) => {
              const display = getCellDisplay(cellIndex);
              const cellAlreadyPicked =
                myPicks.includes(cellIndex) ||
                opponentPicks.includes(cellIndex);
              const isMyTurnClickable =
                isMyTurn &&
                !cellAlreadyPicked &&
                match.status !== MATCH_STATUS.FINISHED;
              return (
                <button
                  key={cellIndex}
                  onClick={() => handleCellClick(cellIndex)}
                  disabled={!isMyTurnClickable || busy}
                  className={`w-full aspect-square rounded-xl flex items-center justify-center transition-all duration-300 text-3xl ${getCellClass(
                    cellIndex,
                  )} ${!isMyTurnClickable ? "cursor-not-allowed" : ""}`}
                >
                  {display.content}
                </button>
              );
            })}
          </div>
        </div>

        {/* Host-only cancel button while still in waiting */}
        {canCancel && (
          <div className="mt-4 flex justify-center">
            <button
              onClick={handleCancel}
              disabled={cancelling}
              className="px-4 py-2 rounded-lg border border-red-500/40 bg-red-500/15 text-red-200 hover:bg-red-500/25 text-sm font-bold transition disabled:opacity-50"
            >
              {cancelling ? "Cancelling…" : "Cancel lobby (refund stake)"}
            </button>
          </div>
        )}

        {/* Post-match result screen */}
        {renderResult()}

        <Footer />
      </div>
    </div>
  );
}
