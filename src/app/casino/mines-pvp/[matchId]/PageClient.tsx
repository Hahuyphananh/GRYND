"use client";

// src/app/casino/mines-pvp/[matchId]/page.tsx
//
// MATCH view for the Mines PvP ("Mines Duel") system. Both players
// on the same 5×5 board; server-randomized turn order; each player
// gets 20 s to pick one cell; match resolves after both picks.
//
// Skill mechanic (minesweeper-style): a safe pick reveals ONE number
// on the clicked tile — how many tiles away the NEAREST mine is
// (1 = touching a mine) — stamped server-side from the hidden board,
// so the client can never compute it mid-match. The number is PRIVATE:
// each player only sees the numbers on the tiles they picked, so the
// shared board never hands the opponent free clues. Skill = building
// your own picture of where the mines are while denying the opponent
// theirs.
//
// Visual design reuses the solo-mines page's 5×5 gameboard
// (cyan safe / magenta mine palette, bomb animation,  for
// unrevealed) and STIPS the left + right sidebars (no bet input,
// no autoplay, no multiplier readout — those don't apply in the
// PvP variant). The page replaces the sidebars with a PvP-specific
// turn indicator + 20 s countdown + a post-match result screen
// that reveals the full board + payout breakdown.

import { useCallback, useEffect, useMemo, useRef, useState, use, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { usePostHog } from "posthog-js/react";
import { useUser } from "@clerk/nextjs";
import { motion, AnimatePresence } from "framer-motion";
import NavigationBar from "../../../../components/navigation-bar";
import Footer from "../../../../components/Footer";
// Shared Creator Mode foundation (admin-only): mounts the viewport
// recorder + overlay and auto-starts when the match actually begins
// (leaves the waiting room), auto-stops when it finishes or the user
// quits. The waiting/matchmaking takeover and Footer stay OUTSIDE so
// nothing is recorded until real gameplay starts.
import CreatorModeHost from "../../../../components/creator-mode/CreatorModeHost";
import {
  CreatorView,
  CreatorModeShell,
  ShellHeader,
  ShellMain,
  ShellAside,
  useCreatorModeLayout,
} from "../../../../components/creator-mode/CreatorModeLayout";
import ReportModal from "../../../../components/ReportModal";
import MatchWaiting from "../../../../components/lobby/MatchWaiting";
import PvpResultScreen from "../../../../components/result/PvpResultScreen";
import EmotePicker, { EmoteBubble } from "../../../../components/game/EmotePicker";
import useGameEmotes from "../../../../hooks/useGameEmotes";
import { useSocket } from "../../../../context/SocketProvider";
import {
  MINES_PVP_LOBBY_ROOM,
  MINES_PVP_MATCH_UPDATED,
  minesPvpMatchRoom,
} from "../../../../lib/mines-pvp/rooms";
import { playVictory, playDefeat, playTick, playGoodReveal, playBuzz } from "../../../../lib/gameAudio";
import {
  IconBomb,
  IconSparkles,
  IconDiamondFilled,
  IconQuestionMark,
  IconFlag,
  IconTrophy,
  IconCheck,
} from "@tabler/icons-react";
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
      <IconBomb size={32} className="text-red-400" />
      {!exploded && (
        <span className="absolute -top-2 -right-2 animate-ping">
          <IconSparkles size={14} className="text-orange-400" />
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

type PlayerSeatProps = {
  isMe: boolean;
  name: string;
  tiles: number;
  wagerLabel: string;
  thinking: boolean;
  isWinner: boolean;
  emote: { kind?: string; value?: string; key?: string } | null;
  emoteSide: "mine" | "incoming";
};

// Per-player seat card: username + wager + tiles clicked, with a live
// turn/winner state. The emote bubble is anchored to the player's name
// (relative span) so an emote "pops" on the sender's name — the pattern
// shared by the RPS / keno-pvp / pool match views.
function PlayerSeat({
  isMe,
  name,
  tiles,
  wagerLabel,
  thinking,
  isWinner,
  emote,
  emoteSide,
}: PlayerSeatProps) {
  const border = isMe
    ? "border-cyan-300/25 bg-cyan-500/[0.06]"
    : "border-fuchsia-300/25 bg-fuchsia-500/[0.06]";
  const ring = thinking
    ? isMe
      ? "ring-1 ring-cyan-300/60 shadow-[0_0_14px_rgba(0,229,255,0.25)]"
      : "ring-1 ring-fuchsia-300/60 shadow-[0_0_14px_rgba(255,79,216,0.25)]"
    : "";
  return (
    <div
      className={`rounded-xl border px-3 py-2.5 transition-all ${border} ${ring}`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="relative flex min-w-0 items-center gap-2">
          <span
            className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full border text-xs font-black ${
              isMe
                ? "border-cyan-300/40 bg-cyan-400/15 text-cyan-200"
                : "border-fuchsia-300/40 bg-fuchsia-400/15 text-fuchsia-200"
            }`}
          >
            {(name || "?").charAt(0).toUpperCase()}
          </span>
          <span className="truncate text-sm font-bold text-white/90">
            {name}
          </span>
          {/* Emote pops above the sender's name */}
          <EmoteBubble emote={emote} side={emoteSide} />
        </span>
        {thinking && (
          <span className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-white/60">
            <span
              className={`h-1.5 w-1.5 animate-pulse rounded-full ${
                isMe ? "bg-cyan-300" : "bg-fuchsia-300"
              }`}
            />
            {isMe ? "Your turn" : "Picking"}
          </span>
        )}
        {isWinner && (
          <span className="inline-flex items-center gap-1 rounded-full border border-yellow-300/40 bg-yellow-400/15 px-2 py-0.5 text-[10px] font-black uppercase tracking-wider text-yellow-200">
            <IconTrophy size={11} className="text-yellow-300" />
            Winner
          </span>
        )}
      </div>
      <div className="mt-2 flex items-center gap-3 text-[11px] text-white/55">
        <span className="inline-flex items-center gap-1 font-semibold text-yellow-200/80">
          <CoinIcon className="h-3.5 w-3.5 text-yellow-300" />
          {wagerLabel}
        </span>
        <span className="inline-flex items-center gap-1">
          <IconDiamondFilled size={11} className="text-cyan-300" />
          Tiles: <b className="text-white/85">{tiles}</b>
        </span>
      </div>
    </div>
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

// Creator-mode board sizer: the 5×5 board is square, so cap it to the
// smaller frame dimension (minus shell chrome/padding) — it then fills
// the frame without overflowing in ANY orientation (9:16 / 16:9 / 1:1 /
// custom). Reads the shell's layout context (useCreatorModeLayout), so it
// must be rendered inside <CreatorModeShell />.
function CreatorBoardStage({ children }: { children: ReactNode }) {
  const { width, height, isPortrait } = useCreatorModeLayout();
  const cap = Math.max(
    280,
    Math.min(width, height) * (isPortrait ? 0.94 : 0.88) - (isPortrait ? 32 : 96),
  );
  return (
    <div
      className="flex w-full flex-col items-center justify-center"
      style={{ maxWidth: cap }}
    >
      {children}
    </div>
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
  // Proximity hint for safe picks — distance to the NEAREST mine in
  // tiles (1 = touching a mine), stamped server-side from the hidden
  // board. PRIVATE: the /status route strips it from the opponent's
  // picks, so a viewer only ever sees numbers on their own tiles.
  // null on mines and legacy picks.
  hint?: number | null;
  autoPicked: boolean;
  pickedAt: string | null;
  // Flag discriminator: true when this entry ended the match via the
  // "call a mine" move (flagTile). Terminal by definition, so it only
  // ever appears in the finished reveal. `isMine` then tells whether
  // the flag was CORRECT (cell really was a mine) or WRONG.
  flag?: boolean;
};

// Enriched player summary — added server-side by enrichMatchWithPlayers
// (users.name + selectedIcon per seat). `missing` marks a seat whose
// users row wasn't found (the client falls back to seat labels).
type PlayerSummary = {
  id: string;
  displayName: string;
  iconKey: string;
  missing?: boolean;
};

type MatchRow = {
  id: number;
  player1Id: string;
  player2Id: string | null;
  isAi: boolean;
  stakeAmount: string;
  status: string;
  minesCount: number;
  // Server-computed: how many safe (non-mine) tiles are still
  // unrevealed. The client can't derive this mid-match (the
  // opponent's `isMine` flags are scrubbed), so /status stamps it
  // from the board + pick history. As it approaches 0, only mines
  // are left unrevealed — whoever must pick next loses by logic
  // (the zugzwang endgame), which is what this counter makes
  // legible.
  safeTilesRemaining: number;
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
  // Player summaries (usernames/icons) — enriched server-side by
  // enrichMatchWithPlayers; null until the /match route fills them in.
  players: {
    p1: PlayerSummary | null;
    p2: PlayerSummary | null;
  } | null;
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
  const [resigning, setResigning] = useState(false);
  const [timeLeft, setTimeLeft] = useState<number>(0);
  // Report modal — flags the human opponent for moderation.
  const [showReportModal, setShowReportModal] = useState(false);
  // Flag mode: when ON, clicking a tile submits a "call a mine" flag
  // instead of a pick. Only meaningful on your turn (the handler
  // guards `isMyTurn` anyway); auto-resets when the turn passes.
  const [flagMode, setFlagMode] = useState(false);

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
    // Poll slower than the socket fast-path. The per-match room broadcast
    // (MINES_PVP_MATCH_UPDATED above) drives live updates; this HTTP poll
    // is a reconnect/consistency safety net only. Turn pacing comes from
    // the server's round_deadline timestamp + a local 250ms tick, never
    // from poll frequency, so 5s is safe and keeps match-time DB reads
    // minimal.
    const interval = setInterval(fetchStatus, 5000);
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
  const { incomingEmote, myEmote, sendEmote } = useGameEmotes({
    socket,
    roomId: matchId ? `mines:emote:${matchId}` : null,
    eventName: "mines:emote",
    selfId: myUserId,
  });

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

  // ── Audio: match-just-resolved ─────────────────────────────────
  // Same resolvedFiredRef guard as the posthog capture below, so the
  // fanfare/defeat plays exactly once per match.
  useEffect(() => {
    if (!match || match.status !== MATCH_STATUS.FINISHED) return;
    if (resolvedFiredRef.current) return;
    const iWon = Boolean(
      match.winnerId && myUserId && match.winnerId === myUserId,
    );
    if (!match.winnerId) playTick();
    else if (iWon) playVictory();
    else playDefeat();
  }, [match, myUserId, resolvedFiredRef]);

  // ── Audio: my pick reveal (safe chime / mine buzz) ─────────────
  const lastPickIdxRef = useRef(-1);
  useEffect(() => {
    if (!myLastPick) return;
    const idx = (match.picks ?? []).indexOf(myLastPick);
    if (idx === lastPickIdxRef.current || idx < 0) return;
    lastPickIdxRef.current = idx;
    if (myLastPick.flag) {
      // A flag call — correct flag plays the good chime, a wrong one
      // the buzz (both show as the reveal below).
      if (myLastPick.isMine) playGoodReveal();
      else playBuzz();
    } else if (myLastPick.isMine) {
      playBuzz();
    } else {
      playGoodReveal();
    }
  }, [myLastPick, match?.picks]);

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
    // The deciding entry is the LAST one in the chronology: a picked
    // mine, or the flag that ended the match. The loser is whoever
    // winnerId is NOT — deriving it from the winner (rather than from
    // the mine-hit entry) stays correct for flags, where the mine-hit
    // entry belongs to the WINNER.
    const lastEntry = allPicks[allPicks.length - 1] ?? null;
    const loserId = match.winnerId
      ? match.winnerId === match.player1Id
        ? match.player2Id
        : match.player1Id
      : null;
    const safePickCounts = { player1: 0, player2: 0 };
    for (const p of allPicks) {
      if (!p || p.isMine || p.flag) continue;
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
      ended_by: lastEntry?.flag ? "flag" : lastEntry?.isMine ? "mine" : null,
      loser_id: loserId,
      loser_seat: lastEntry ? lastEntry.seat ?? null : null,
      loser_pick_cell: lastEntry ? lastEntry.cell ?? null : null,
    });
  }, [match, matchId, myUserId, posthog]);
  const isParticipant = useMemo(() => {
    if (!match || !myUserId) return false;
    return match.player1Id === myUserId || match.player2Id === myUserId;
  }, [match, myUserId]);
  const isPlayer1 = match?.player1Id === myUserId;
  const isAi = Boolean(match?.isAi);
  // The opponent is whoever occupies the seat we don't hold. Only
  // reportable once a real human opponent has joined. Never reportable
  // in AI matches.
  const opponentClerkId = isAi
    ? null
    : isPlayer1
      ? match?.player2Id ?? null
      : match?.player1Id ?? null;
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

  // Auto-exit flag mode the moment it's no longer your turn, so a
  // stale toggle can't turn a later pick into an accidental flag.
  useEffect(() => {
    if (!isMyTurn) setFlagMode(false);
  }, [isMyTurn]);

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
        // Flag mode submits to the /flag route ("call a mine"); normal
        // mode to /pick. The server re-validates turn + state either way.
        const res = await fetch(
          flagMode
            ? `/api/mines-pvp/match/${matchId}/flag`
            : `/api/mines-pvp/match/${matchId}/pick`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ cellIndex }),
          },
        );
        const data = await res.json();
        if (!res.ok || !data.success) {
          setError(data?.error || (flagMode ? "Flag failed" : "Pick failed"));
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
        posthog?.capture(flagMode ? "mines_pvp_flag" : "mines_pvp_pick", {
          match_id: matchId,
          cell_index: cellIndex,
          auto: false,
        });
        // Server-side AI trigger: if this is a free AI match and the
        // human just picked, trigger the bot's response so it plays
        // immediately rather than waiting for the status poll.
        if (match?.isAi) {
          try {
            await fetch(`/api/mines-pvp/match/${matchId}/ai-turn`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              credentials: "include",
              body: JSON.stringify({}),
            });
          } catch {
            // Best-effort: status polling will recover if this fails.
          }
        }
        await fetchStatus();
      } finally {
        setBusy(false);
      }
    },
    [busy, fetchStatus, flagMode, isMyTurn, match, matchId, myPicks, opponentPicks, posthog, socket],
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

  const handleResign = useCallback(async () => {
    if (resigning) return;
    if (!window.confirm("Resign this match? Your stake is forfeited and your opponent wins.")) return;
    setResigning(true);
    setError(null);
    try {
      const res = await fetch(`/api/mines-pvp/match/${matchId}/resign`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(data?.error || "Resign failed");
        return;
      }
      posthog?.capture("mines_pvp_resigned", { match_id: matchId });
      await fetchStatus();
    } finally {
      setResigning(false);
    }
  }, [matchId, posthog, resigning, fetchStatus]);

  // ── Minesweeper hint badge (the skill mechanic) ─────────────────
  // Distance semantics: 1 = right next to a mine (HOT), higher = safer.
  // The number is PRIVATE — each player only sees the numbers on the
  // tiles they picked themselves, so the opponent's picks give away
  // nothing.
  function hintBadgeClass(hint: number): string {
    if (hint <= 1) return "bg-red-500/20 text-red-200 border-red-400/50";
    if (hint === 2) return "bg-orange-500/20 text-orange-200 border-orange-300/40";
    if (hint === 3) return "bg-amber-500/20 text-amber-200 border-amber-300/40";
    if (hint === 4) return "bg-emerald-500/20 text-emerald-200 border-emerald-300/40";
    return "bg-cyan-500/20 text-cyan-200 border-cyan-300/40";
  }

  /** The  + hint-number badge shown on the viewer's own SAFE picks. */
  function safeCellContent(entry: PickEntry | undefined) {
    const hint =
      entry && typeof entry.hint === "number" ? entry.hint : null;
    return (
      <span className="relative inline-flex items-center justify-center">
        <IconDiamondFilled size={22} className="text-cyan-300" />
        {hint !== null && (
          <span
            className={`absolute -top-2.5 -right-2.5 flex h-5 w-5 items-center justify-center rounded-full border text-[11px] font-black tabular-nums ${hintBadgeClass(
              hint,
            )}`}
          >
            {hint}
          </span>
        )}
      </span>
    );
  }

  // ── Cell rendering helpers (reused from solo mines page) ────────
  // Returns { content, style } for a single cell based on the
  // current match state. Two display modes in the odds-turn flow:
  //   1. Mid-match (status not 'finished') — render EVERY cleared
  //      cell as a , color-coded to its picker (cyan = player1,
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
      return { content: <IconQuestionMark size={22} className="text-white/30" />, revealed: false, isMine: false };
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

    // Mid-match: render every revealed cell as a . The board
    // mines themselves stay hidden (we can't server-trust the
    // board column mid-match — it's null until finished).
    if (!isFinished) {
      const entry = pickByCell.get(cellIndex);
      if (entry) {
        // Every in-flight pick is guaranteed safe (a mine would
        // have ended the match). The seats get their own accent so
        // a glance at the board shows whose territory is whose —
        // and the minesweeper number shows how many mines touch
        // this cell (the deduction surface).
        return {
          content: safeCellContent(entry),
          revealed: true,
          isMine: false,
        };
      }
      // Flag mode: an unrevealed playable cell shows a  instead of
      // a  so a click here declares a mine rather than picking it.
      const isFlagTarget =
        flagMode &&
        isMyTurn &&
        !myPicks.includes(cellIndex) &&
        !opponentPicks.includes(cellIndex);
      if (isFlagTarget) {
        return {
          content: <IconFlag size={22} className="text-red-300 drop-shadow-[0_0_6px_rgba(248,113,113,0.6)]" />,
          revealed: false,
          isMine: false,
        };
      }
      return { content: <IconQuestionMark size={22} className="text-white/30" />, revealed: false, isMine: false };
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
        content: safeCellContent(pickedEntry),
        revealed: true,
        isMine: false,
      };
    }
    const isMine = mines.includes(cellIndex);
    return {
      content: isMine ? <AnimatedBomb exploded /> : <IconDiamondFilled size={22} className="text-cyan-300" />,
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
      // Flag mode tints playable cells red so the player can see at
      // a glance that clicking means "declare a mine".
      return flagMode
        ? "bg-[#2a0d1e] border border-red-400/60 hover:border-red-300 hover:shadow-[0_0_16px_rgba(248,113,113,0.45)]"
        : "bg-[#071226] border border-[#00e5ff]/20 hover:border-[#00e5ff]/70 hover:shadow-[0_0_16px_rgba(0,229,255,0.35)]";
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
            Both players joined. Starting in a few seconds…
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
            Your turn. Pick a tile
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
        className={`relative flex flex-wrap items-center justify-center gap-3 rounded-xl border border-fuchsia-300/40 bg-fuchsia-500/10 px-4 py-3 text-fuchsia-200`}
      >
        <span className="font-bold text-base sm:text-lg">
          {isAi ? "GRYND AI is picking…" : "Opponent is picking…"}
        </span>
        <span className="inline-flex items-center gap-1 rounded-full bg-fuchsia-500/30 px-3 py-1 text-sm font-bold text-fuchsia-100">
          <ClockIcon className="w-4 h-4" />
          {timeLeft}s
        </span>
      </div>
    );
  }

  // ── Result screen — shared PvpResultScreen (UX plan P3-3) ───────
  // Rendered when the match is finished. Every number comes from the
  // real match row (winnerId / stakeAmount / houseFee / prizePaid /
  // players / startedAt→endedAt) — nothing is invented. Winner/payout
  // logic is untouched; the old bespoke WIN/LOSS overlay is gone and
  // this shared screen is the single end-of-match experience.
  function renderResult() {
    if (!match || match.status !== MATCH_STATUS.FINISHED) return null;
    const iWon =
      match.winnerId && myUserId && match.winnerId === myUserId;
    const iLost =
      match.winnerId && myUserId && match.winnerId !== myUserId;
    const isDrawResult = !iWon && !iLost;

    const stake = Number(match.stakeAmount);
    const houseFee = Number(match.houseFee);
    const prizePaid = Number(match.prizePaid);
    const tokenDelta = iWon ? prizePaid : iLost ? -stake : 0;

    // Duration from the existing timestamps (omitted when unavailable).
    let durationSeconds: number | null = null;
    if (match.startedAt && match.endedAt) {
      const start = new Date(match.startedAt).getTime();
      const end = new Date(match.endedAt).getTime();
      if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
        durationSeconds = Math.round((end - start) / 1000);
      }
    }

    // The deciding entry: the last pick in the chronology — either the
    // mine that was picked, or the flag that ended the match.
    const allResultPicks = Array.isArray(match.picks) ? match.picks : [];
    const lastEntry = allResultPicks[allResultPicks.length - 1] ?? null;
    const flagEntry = lastEntry?.flag ? lastEntry : null;
    const iFlagged = Boolean(
      flagEntry && myUserId && flagEntry.userId === myUserId,
    );
    const opponentLabel = isAi ? "GRYND AI" : "Opponent";
    const headline = flagEntry
      ? iFlagged
        ? flagEntry.isMine
          ? "Correct flag. You called the mine"
          : "Wrong flag. The tile was safe"
        : flagEntry.isMine
          ? `${opponentLabel} called your mine`
          : `${opponentLabel}'s flag missed`
      : iWon
        ? `${opponentLabel} hit a mine - you take the pot`
        : iLost
          ? "You hit a mine"
          : "Match complete";

    const subline = isAi
      ? iWon
        ? "You beat the GRYND AI!"
        : iLost
          ? "The GRYND AI won this round."
          : null
      : iWon
        ? `You took home ${prizePaid.toFixed(2)} tokens (your stake + 90% of opponent's).`
        : iLost
          ? `You lost your ${stake.toFixed(2)} stake. House kept ${houseFee.toFixed(2)}.`
          : null;

    const p1Summary = match.players?.p1 ?? null;
    const p2Summary = match.players?.p2 ?? null;
    const oppSummary = isPlayer1 ? p2Summary : p1Summary;
    const oppName = oppSummary?.displayName || "Opponent";
    const outcome = isDrawResult ? "draw" : iWon ? "win" : "loss";

    return (
      <PvpResultScreen
        open
        outcome={outcome}
        headline={headline}
        subline={subline ?? undefined}
        gameName="Mines Duel"
        opponent={
          isAi
            ? { name: "GRYND AI", isAi: true }
            : { name: oppName, iconKey: oppSummary?.iconKey || null }
        }
        tokenDelta={tokenDelta}
        durationSeconds={durationSeconds}
        summary={[
          {
            label: "Result",
            value: outcome === "win" ? "Win" : outcome === "loss" ? "Loss" : "Draw",
          },
          ...(isAi ? [] : [{ label: "Opponent", value: oppName }]),
        ]}
        details={[
          { label: "Match ID", value: String(match.id) },
          { label: "Wager", value: `${stake.toFixed(2)} tokens` },
          { label: "Prize", value: `${prizePaid.toFixed(2)} tokens` },
          { label: "House fee", value: `${houseFee.toFixed(2)} tokens` },
          { label: "Winner", value: iWon ? "You" : iLost ? "Opponent" : "Draw" },
        ]}
        playAgain={{ onClick: () => router.push("/casino/mines-pvp") }}
        onReturnToLobby={() => router.push("/casino")}
      />
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

  // ── Player seat info (usernames + stats for the header cards) ─────
  const p1Summary = match.players?.p1 ?? null;
  const p2Summary = match.players?.p2 ?? null;
  const mySummary = isPlayer1 ? p1Summary : p2Summary;
  const oppSummary = isPlayer1 ? p2Summary : p1Summary;
  const myDisplayName = mySummary?.displayName || "You";
  const opponentDisplayName = isAi
    ? "GRYND AI"
    : oppSummary?.displayName || "Opponent";
  const inPickState =
    match.status === MATCH_STATUS.P1_TURN ||
    match.status === MATCH_STATUS.P2_TURN;
  const mySeatClerkId = isPlayer1 ? match.player1Id : match.player2Id;
  const oppSeatClerkId = isPlayer1 ? match.player2Id : match.player1Id;
  const meWon =
    match.status === MATCH_STATUS.FINISHED &&
    Boolean(match.winnerId) &&
    match.winnerId === mySeatClerkId;
  const oppWon =
    match.status === MATCH_STATUS.FINISHED &&
    Boolean(match.winnerId) &&
    !meWon &&
    Boolean(oppSeatClerkId);
  const wagerLabel = isAi ? "Free play" : `${stake.toLocaleString()} tokens`;

  // ── Creator Mode arrangement ──────────────────────────────────────
  // The game content is extracted into nodes so the SAME pieces compose
  // the normal page, the portrait (9:16) phone frame, and the
  // landscape/square frame — mirroring Tower Arena's creator shell.
  // No game logic or state is touched, only layout.

  // Title
  const titleNode = (
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
  );

  // Match info strip
  const infoNode = (
    <div className="mt-3 flex flex-wrap items-center justify-center gap-x-5 gap-y-1 text-xs text-white/60">
      <span className="inline-flex items-center gap-1">
        {isAi ? "Free vs AI" : "Stake:"}
        {!isAi && (
          <span className="text-yellow-300 font-semibold inline-flex items-center gap-1">
            {stake.toLocaleString()}
            <CoinIcon className="w-3.5 w-3.5 text-yellow-300" />
          </span>
        )}
        {isAi && (
          <span className="text-emerald-300 font-semibold">
            No tokens at stake
          </span>
        )}
      </span>
      <span className="inline-flex items-center gap-1">
        Mines:
        <span className="text-fuchsia-300 font-semibold inline-flex items-center gap-1">
          {match.minesCount}
          <MineIcon className="w-3.5 h-3.5 text-fuchsia-300" />
        </span>
      </span>
      {/* Safe-tiles counter — makes the zugzwang endgame legible.
          Server-stamped (the client can't count the opponent's
          scrubbed safe reveals). Color-coded so the "only mines
          left" moment is unmissable: emerald while comfortable,
          amber when it's tight, red + pulse when the next forced
          mine is one pick away. */}
      <span
        title="Safe (non-mine) tiles still unrevealed. When it hits 0, only mines are left. Whoever must pick next loses by logic (zugzwang)."
        className={`inline-flex items-center gap-1 ${
          match.safeTilesRemaining <= 2
            ? "animate-pulse"
            : ""
        }`}
      >
        <span className="inline-flex items-center gap-1"><IconDiamondFilled size={14} className="text-cyan-300" /> Safe left:</span>
        <span
          className={`font-bold inline-flex items-center gap-1 ${
            match.safeTilesRemaining <= 2
              ? "text-red-300"
              : match.safeTilesRemaining <= 4
                ? "text-amber-300"
                : "text-emerald-300"
          }`}
        >
          {match.safeTilesRemaining}
        </span>
      </span>
      <span>
        Seat: <span className="text-cyan-200 font-semibold">{mySeat}</span>
      </span>
      {opponentClerkId && (
        <button
          onClick={() => setShowReportModal(true)}
          className="inline-flex items-center gap-1 rounded-full border border-red-500/30 bg-red-500/10 px-2.5 py-0.5 text-xs font-bold text-red-400 transition-all hover:bg-red-500/20 hover:shadow-[0_0_10px_rgba(239,68,68,0.3)]"
        >
          <span className="inline-flex items-center gap-1"><IconFlag size={12} /> Report opponent</span>
        </button>
      )}
    </div>
  );

  // Player seats — stacks on narrow screens, two-up once there's room
  // (normal mobile gets single cards, desktop + creator frames get 2-up).
  const seatsNode = (
    <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2 sm:gap-3">
      <PlayerSeat
        isMe
        name={myDisplayName}
        tiles={myPicks.length}
        wagerLabel={wagerLabel}
        thinking={inPickState && isMyTurn}
        isWinner={meWon}
        emote={myEmote}
        emoteSide="mine"
      />
      <PlayerSeat
        isMe={false}
        name={opponentDisplayName}
        tiles={opponentPicks.length}
        wagerLabel={wagerLabel}
        thinking={inPickState && !isMyTurn}
        isWinner={oppWon}
        emote={incomingEmote}
        emoteSide="incoming"
      />
    </div>
  );

  // Resign (mid-match only)
  const resignNode =
    match.status !== MATCH_STATUS.FINISHED &&
    match.status !== MATCH_STATUS.CANCELLED &&
    match.status !== MATCH_STATUS.WAITING &&
    match.status !== MATCH_STATUS.READY ? (
      <div className="mt-3 flex justify-center">
        <button
          onClick={handleResign}
          disabled={resigning}
          className="inline-flex items-center gap-1 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-2 text-xs font-bold text-red-300 transition-all hover:bg-red-500/25 disabled:opacity-50"
        >
          <IconFlag size={14} />
          {resigning ? "Resigning…" : "Resign match"}
        </button>
      </div>
    ) : null;

  // Pick / flag-mode toggle (your turn only)
  const pickToggleNode =
    isMyTurn &&
    match.status !== MATCH_STATUS.FINISHED &&
    match.status !== MATCH_STATUS.CANCELLED ? (
      <div className="mt-3 flex flex-col items-center gap-1.5">
        <div className="inline-flex rounded-xl border border-cyan-300/30 bg-[#08142f]/80 p-1 text-xs font-bold">
          <button
            onClick={() => setFlagMode(false)}
            className={`px-3 py-1.5 rounded-lg transition ${
              !flagMode
                ? "bg-cyan-300 text-[#001933] shadow-[0_0_10px_rgba(0,229,255,0.45)]"
                : "text-cyan-200/70 hover:text-cyan-100"
            }`}
          >
            <span className="inline-flex items-center gap-1"><IconDiamondFilled size={14} className="text-cyan-300" /> Pick a tile</span>
          </button>
          <button
            onClick={() => setFlagMode(true)}
            className={`px-3 py-1.5 rounded-lg transition ${
              flagMode
                ? "bg-red-400 text-[#2a0d1e] shadow-[0_0_10px_rgba(248,113,113,0.45)]"
                : "text-red-300/70 hover:text-red-200"
            }`}
          >
            <span className="inline-flex items-center gap-1"><IconFlag size={14} className="text-red-300" /> Flag a mine</span>
          </button>
        </div>
        {flagMode && (
          <p className="text-[10px] uppercase tracking-widest text-red-300/80 font-bold">
            Click a tile you believe is a mine. Correct = opponent
            loses · wrong = you lose
          </p>
        )}
      </div>
    ) : null;

  // Emote picker
  const emoteNode = (
    <div className="mt-3 flex justify-center">
      <EmotePicker
        compact
        hideBubbles
        incomingEmote={incomingEmote}
        myEmote={myEmote}
        onSend={(emote) => sendEmote(emote)}
      />
    </div>
  );

  // Error banner
  const errorNode = error ? (
    <div className="mt-3 flex items-center gap-2 rounded-lg border border-red-400/40 bg-red-900/30 px-3 py-2 text-sm text-red-200">
      <AlertIcon className="w-4 h-4 text-red-300" />
      <span>{error}</span>
    </div>
  ) : null;

  // ── The 5×5 gameboard (reused from solo mines) — padding/gaps shrink
  // on small screens so the cells stay big and thumb-friendly. ──────
  const boardNode = (
    <div
      className="mt-6 w-full rounded-2xl border border-[#00e5ff]/40 bg-gradient-to-br from-[#001933] via-[#00111f] to-[#000814] p-3 shadow-[0_0_60px_rgba(0,229,255,0.18),inset_0_0_30px_rgba(0,229,255,0.08)] sm:p-6"
    >
      <div className="grid grid-cols-5 gap-2 sm:gap-3">
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
  );

  // Minesweeper hint legend — the skill mechanic
  const legendNode = (
    <p className="mt-3 text-center text-[10px] uppercase tracking-widest text-white/35 font-bold">
      <span className="inline-flex items-center gap-1"><IconDiamondFilled size={12} className="text-cyan-300" /> number = tiles to the nearest mine (1 = right next to it) · only you see your own</span>
    </p>
  );

  // Host-only cancel button while still in waiting
  const cancelNode = canCancel ? (
    <div className="mt-4 flex justify-center">
      <button
        onClick={handleCancel}
        disabled={cancelling}
        className="px-4 py-2 rounded-lg border border-red-500/40 bg-red-500/15 text-red-200 hover:bg-red-500/25 text-sm font-bold transition disabled:opacity-50"
      >
        {cancelling ? "Cancelling…" : "Cancel lobby (refund stake)"}
      </button>
    </div>
  ) : null;

  // Normal (non-creator) page — identical stack as before.
  const normalView = (
    <>
      {titleNode}
      {infoNode}
      {seatsNode}
      <div className="mt-4">{renderTurnIndicator()}</div>
      {resignNode}
      {pickToggleNode}
      {emoteNode}
      {errorNode}
      {boardNode}
      {legendNode}
      {cancelNode}
    </>
  );

  // Portrait (9:16) — phone-style: compact status header, the board
  // filling the middle, and turn/controls/seats pinned below.
  const portraitContent = (
    <CreatorModeShell className="bg-gradient-to-br from-[#001933] to-[#000d1a]">
      <ShellHeader className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <MineIcon className="h-5 w-5 shrink-0 text-cyan-300" />
            <h1 className="truncate text-base font-extrabold tracking-tight text-cyan-100">
              Mines Duel
            </h1>
          </div>
          <div className="flex shrink-0 items-center gap-1.5 text-[11px] font-bold">
            <span className="inline-flex items-center gap-1 rounded-full border border-fuchsia-400/30 bg-fuchsia-500/15 px-2 py-0.5 text-fuchsia-200">
              <MineIcon className="h-3 w-3" /> {match.minesCount}
            </span>
            <span className="inline-flex items-center gap-1 rounded-full border border-cyan-400/30 bg-cyan-500/15 px-2 py-0.5 text-cyan-200">
              <IconDiamondFilled size={12} /> {match.safeTilesRemaining} safe
            </span>
            <span className="rounded-full border border-white/15 bg-white/5 px-2 py-0.5 text-white/70">
              Seat {mySeat}
            </span>
          </div>
        </div>
        <div className="flex items-center justify-between gap-2 text-[11px] font-semibold">
          <span className="truncate text-cyan-200">
            {isAi ? "Free vs AI — no tokens at stake" : `${stake.toLocaleString()} tokens at stake`}
          </span>
          <span className="shrink-0 text-white/50">Match #{matchId}</span>
        </div>
      </ShellHeader>

      <ShellMain className="flex-col overflow-hidden">
        <div className="flex h-full w-full flex-col items-center justify-center px-3 py-2">
          <CreatorBoardStage>
            {boardNode}
            {legendNode}
          </CreatorBoardStage>
        </div>
      </ShellMain>

      <ShellAside className="space-y-2">
        {renderTurnIndicator()}
        {seatsNode}
        {pickToggleNode}
        {emoteNode}
        {resignNode}
        {errorNode}
      </ShellAside>
    </CreatorModeShell>
  );

  // Landscape (16:9) / square (1:1) — board fills the height with the
  // turn/controls/seats in a right rail.
  const landscapeContent = (
    <CreatorModeShell className="bg-gradient-to-br from-[#001933] to-[#000d1a]">
      <ShellMain className="overflow-hidden">
        <div className="flex h-full w-full flex-col items-center justify-center p-4">
          <CreatorBoardStage>
            {boardNode}
            {legendNode}
          </CreatorBoardStage>
        </div>
      </ShellMain>
      <ShellAside className="space-y-2">
        {renderTurnIndicator()}
        {seatsNode}
        {pickToggleNode}
        {emoteNode}
        {resignNode}
        {errorNode}
      </ShellAside>
    </CreatorModeShell>
  );

  return (
    <>
      {/* Unified full-screen waiting takeover (matchmaking → countdown) */}
      {(match.status === MATCH_STATUS.WAITING ||
        match.status === MATCH_STATUS.READY) && (
        <MatchWaiting
          state={
            match.status === MATCH_STATUS.READY ? "ready" : "waiting"
          }
          gameName={isAi ? "Mines Duel vs AI" : "Mines Duel"}
          subtitle={
            match.status === MATCH_STATUS.READY
              ? "Both players joined. Starting in a few seconds…"
              : isAi
                ? "Free practice against the GRYND AI — the board starts in a moment."
                : `Your ${stake.toLocaleString()} stake is escrowed. Someone with the same stake will join shortly.`
          }
          seats={[
            // Real username + wager on both seats once the opponent has
            // joined — the ready takeover flips their seat from open to
            // occupied (same treatment as the in-game seat cards).
            match.status === MATCH_STATUS.READY
              ? {
                  label: "You",
                  name: myDisplayName,
                  occupied: true,
                  wager: wagerLabel,
                }
              : { label: "You", name: myDisplayName, occupied: true },
            match.status === MATCH_STATUS.READY
              ? {
                  label: isAi ? "GRYND AI" : "Opponent",
                  name: opponentDisplayName,
                  occupied: true,
                  wager: wagerLabel,
                }
              : { label: isAi ? "GRYND AI" : "Opponent", occupied: false },
          ]}
          onCancel={
            match.status === MATCH_STATUS.WAITING && canCancel
              ? handleCancel
              : null
          }
          cancelLabel="Cancel lobby (refund stake)"
          cancelling={cancelling}
        />
      )}

      <div className="min-h-screen overflow-x-clip bg-gradient-to-br from-[#001933] to-[#000d1a] px-3 pb-24 pt-20 text-white sm:px-6 md:pb-8">
      <NavigationBar currentPath="/casino" />

      {/* Only the actual game content is recorded — the matchmaking
          takeover / NavBar above and the Footer + modals below sit
          outside the shared CreatorModeHost recording viewport.
          Recording auto-starts when the match leaves waiting and stops
          when it finishes/cancels. */}
      <div className="mx-auto mt-4 max-w-3xl sm:mt-8">
        <CreatorModeHost
          autoStart={
            Boolean(match) &&
            match.status !== MATCH_STATUS.WAITING &&
            match.status !== MATCH_STATUS.FINISHED &&
            match.status !== MATCH_STATUS.CANCELLED
          }
          autoStop={
            match?.status === MATCH_STATUS.FINISHED ||
            match?.status === MATCH_STATUS.CANCELLED
          }
          gameLabel="mines-duel"
          backToLobbyHref="/casino/mines-pvp"
        >
        <CreatorView
          normal={normalView}
          portrait={portraitContent}
          landscape={landscapeContent}
        />
        </CreatorModeHost>

        <Footer />
      </div>

      {/* Post-match result screen — rendered as a fixed overlay
          (mirrors the chess game's `showResultPopup` pattern), so
          the win/lose panel sits on top of the board instead of
          below it. The fixed inset-0 backdrop covers the full
          viewport without needing its own portal; the rendered
          `motion.div` already short-circuits to `null` for any
          status other than `MATCH_STATUS.FINISHED`. */}
      {renderResult()}

      {/* Report modal */}
      <ReportModal
        isOpen={showReportModal}
        onClose={() => setShowReportModal(false)}
        onSubmit={async (reason, details) => {
          const res = await fetch("/api/reports/submit", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              reportedClerkId: opponentClerkId,
              gameType: "mines-pvp",
              gameId: String(matchId),
              reason,
              details: details || undefined,
            }),
          });
          const data = await res.json();
          if (!data.success) throw new Error(data.error || "Failed to submit report");
        }}
        reportedPlayerName="Opponent"
        gameType="Mines Duel"
      />
      </div>
    </>
  );
}
