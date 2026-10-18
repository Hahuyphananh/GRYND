"use client";

// src/app/casino/mines-pvp/[matchId]/PageClient.tsx
//
// MATCH view for the Mines Duel — SIMULTANEOUS, INDEPENDENT-BOARD competitive
// scoring. There are NO turns: both players race at the same time, each on
// their OWN server-generated 10×10 board. Whoever scores more when both boards
// are done — or the server-authoritative 180s clock runs out — wins.
//
// ── What each seat can see ───────────────────────────────────────────
//   • The viewer's OWN board only: every cell they have resolved (safe reveals
//     with their server-stamped clue, mines they detonated, mine they
//     confirmed by flagging, and their wrong-flag markers).
//   • The opponent ONLY as compact public progress — score, tiles, confirmed
//     mines, completion. Their board, mine positions and mine values are never
//     rendered.
//   • Both full boards are revealed ONLY once the match is `finished` (the
//     replay state).
//
// ── Scoring (all server-minted; the client never computes a score) ───
//   • safe reveal +5 · wrong flag −10 · mine hit −25 · board cleared +100
//   • a correct flag awards the flagged mine's own value (10/20/30/50)
//   Scores clamp at 0. The client only *displays* the authoritative change
//   (via a score diff against the refetched snapshot) so the animation can
//   never disagree with the server.
//
// ── Reused visual language ───────────────────────────────────────────
// The board frame, tile styling, safe/mine palette, clue badges, bomb fuse /
// explosion, reveal + hint-pop cues, seat emote system, shared result screen,
// matchmaking takeover and audio cues are all carried over from the original
// Mines page rather than re-invented.

import { useCallback, useEffect, useMemo, useRef, useState, use, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { usePostHog } from "posthog-js/react";
import { useUser } from "@clerk/nextjs";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import NavigationBar from "../../../../components/navigation-bar";
import Footer from "../../../../components/Footer";
import GameSessionHost from "../../../../components/GameSessionHost";
import ReportModal from "../../../../components/ReportModal";
import MatchWaiting from "../../../../components/lobby/MatchWaiting";
import PvpResultScreen from "../../../../components/result/PvpResultScreen";
import FrameAvatar from "../../../../components/FrameAvatar";
import { cosmeticEffectClass } from "../../../../lib/profileCosmetics";
import EmotePicker, { EmoteBubble } from "../../../../components/game/EmotePicker";
import useGameEmotes from "../../../../hooks/useGameEmotes";
import { useSocket } from "../../../../context/SocketProvider";
import {
  MINES_PVP_LOBBY_ROOM,
  MINES_PVP_MATCH_UPDATED,
  MINES_PVP_SCORE_EVENT,
  minesPvpMatchRoom,
} from "../../../../lib/mines-pvp/rooms";
import { playVictory, playDefeat, playTick, playGoodReveal, playBuzz } from "../../../../lib/gameAudio";
import { withReducedMotion } from "../../../../lib/animations";
import {
  useMatchSync,
} from "../../../../hooks/useMatchSync";
import { usePracticeBotHeartbeat } from "../../../../hooks/usePracticeBotHeartbeat";
import { minesPvpDueRead } from "../../../../lib/deadlineRead";
import { useDeadlineRead } from "../../../../hooks/useDeadlineRead";
import { useServerClockEstimate } from "../../../../hooks/useServerClockEstimate";
import {
  IconSparkles,
  IconDiamondFilled,
  IconQuestionMark,
  IconFlag,
  IconTrophy,
} from "@tabler/icons-react";
import { MATCH_STATUS, GRID_CELLS } from "../../../../lib/mines-pvp/constants";
// The platform's ONE seat-based verdict (src/lib/results/viewerOutcome.ts).
// The snapshot carries the server's own `viewerSeat`, so the result screen
// never has to ask Clerk who the viewer is.
import { viewerOutcome } from "../../../../lib/results/viewerOutcome";

// How long the finished board keeps the table to itself before the result
// overlay covers it (the finished reveal must land first). Reduced motion
// skips the wait.
const RESULT_BEAT_MS = 900;
// Finished-reveal sweep step (in index order: top-left → bottom-right).
const REVEAL_STEP_MS = 6;

// ── The mine and the flag ─────────────────────────────────────────────
//
// Drawn here, in the shared cartoon language, instead of borrowed from an
// icon set: a spiked ball with one dark outline, a pink body and a single
// highlight — the same three-value treatment (and the same `--gr-outline`
// edge) as every other game piece. A mine must never read as a generic token,
// and a flag must look planted, not pasted on.
const GR_OUTLINE = "var(--gr-outline, #05101f)";

function MineGlyph({ size = 18, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <g stroke={GR_OUTLINE} strokeWidth="2.8" strokeLinecap="round">
        <path d="M12 2.6V6M12 18v3.4M2.6 12H6M18 12h3.4M5.4 5.4l2.4 2.4M16.2 16.2l2.4 2.4M18.6 5.4l-2.4 2.4M7.8 16.2l-2.4 2.4" />
      </g>
      <circle cx="12" cy="12" r="6.6" fill="#ff4fd8" stroke={GR_OUTLINE} strokeWidth="2.4" />
      <path d="M8.6 9.6a4.4 4.4 0 0 1 3-2.3" fill="none" stroke="#ffe4f8" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function FlagGlyph({ size = 16, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <path d="M8 21V4" stroke={GR_OUTLINE} strokeWidth="3.2" strokeLinecap="round" />
      <path d="M8 4.6 19 8 8 11.4 Z" fill="#ff5a6e" stroke={GR_OUTLINE} strokeWidth="2" strokeLinejoin="round" />
      <rect x="4.6" y="18.8" width="10" height="2.6" rx="1.3" fill="#22d3ee" stroke={GR_OUTLINE} strokeWidth="1.4" />
    </svg>
  );
}

// ── Animation: the mine's fuse + explosion (reused from the original board) ─
function AnimatedBomb({
  exploded = false,
  delayMs = 0,
}: {
  exploded?: boolean;
  delayMs?: number;
}) {
  return (
    <span
      className={`relative inline-flex ${
        exploded ? "animate-bomb-explode" : "animate-bomb-fuse"
      }`}
      style={delayMs > 0 ? { animationDelay: `${delayMs}ms` } : undefined}
    >
      <MineGlyph size={18} />
      {!exploded && (
        <span className="absolute -top-1.5 -right-1.5 animate-ping">
          <IconSparkles size={8} className="text-orange-400" />
        </span>
      )}
    </span>
  );
}

// ── Inline SVG icons (kept in-file, reused from the original page) ───
function CoinIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <ellipse cx="12" cy="6" rx="8" ry="2.5" />
      <path d="M4 6 V18 a8 2.5 0 0 0 16 0 V6" />
      <ellipse cx="12" cy="18" rx="8" ry="2.5" />
    </svg>
  );
}

function MineIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <circle cx="12" cy="14" r="7" />
      <path d="M14 7 L17 4" />
      <path d="M16 4 L18 4 L18 6" />
      <circle cx="18" cy="4" r="0.8" fill="currentColor" stroke="none" />
    </svg>
  );
}

function ClockIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7 V12 L15 14" />
    </svg>
  );
}

function CheckIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="M5 12 L10 17 L19 7" />
    </svg>
  );
}

function CrossIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="M6 6 L18 18" />
      <path d="M18 6 L6 18" />
    </svg>
  );
}

function LoadingDotsIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <circle cx="6" cy="12" r="2" />
      <circle cx="12" cy="12" r="2" />
      <circle cx="18" cy="12" r="2" />
    </svg>
  );
}

function AlertIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="M12 3 L22 20 H2 Z" />
      <line x1="12" y1="10" x2="12" y2="15" />
      <circle cx="12" cy="17.5" r="0.8" fill="currentColor" stroke="none" />
    </svg>
  );
}

// ── Payload types (mirror src/lib/mines-pvp/matchView.js) ────────────
type OwnReveal = { cell: number; mine: boolean; hint: number | null };

type PlayerSummary = {
  id: string;
  displayName: string;
  iconKey: string | null;
  profileFrame?: unknown;
  nameColor?: string | null;
  /** True for a signed-out practice guest — draws the "G" badge. */
  isGuest?: boolean;
  missing?: boolean;
};

type MatchRow = {
  id: number;
  player1Id: string;
  player2Id: string | null;
  isAi: boolean;
  stakeAmount: number;
  minesCount: number;
  status: string;
  viewerIsPlayer1: boolean;
  // The seat the SERVER says the viewer holds — the settled `result` is read
  // against it (never against a Clerk id, which a free-play guest has none of).
  viewerSeat: "player1" | "player2";
  opponentSeat: string;
  matchTimerSeconds: number;
  matchDeadline: string | null;
  /** The ready banner's stamped instant — the read that flips `ready` → `active`. */
  readyDeadline: string | null;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  myRevealed: OwnReveal[];
  myFlags: number[];
  myCorrectFlagCells: number[];
  myIncorrectFlagCells: number[];
  myScore: number;
  mySafeRevealed: number;
  myMinesHit: number;
  myCorrectFlags: number;
  myIncorrectFlags: number;
  myCompleted: boolean;
  myCompletedAt: string | null;
  myLocked: boolean;
  mySafeTilesRemaining: number;
  opponentScore: number;
  opponentSafeRevealed: number;
  opponentMinesHit: number;
  opponentCorrectFlags: number;
  opponentIncorrectFlags: number;
  opponentCompleted: boolean;
  opponentCompletedAt: string | null;
  opponentLocked: boolean;
  result: string | null;
  winnerId: string | null;
  winReason: string | null;
  board: { size: number; mines: number[]; values?: Record<string, number> } | null;
  opponentBoard: { size: number; mines: number[]; values?: Record<string, number> } | null;
  safeTilesRemaining: number;
  myMinesFound: number;
  opponentMinesFound: number;
  houseFee?: number;
  prizePaid?: number;
  players: { p1: PlayerSummary | null; p2: PlayerSummary | null } | null;
};

function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const m = Math.floor(s / 60);
  const sec = String(s % 60).padStart(2, "0");
  return `${m}:${sec}`;
}

// Minesweeper clue badge (the skill mechanic; 1 = right next to a mine).
function hintBadgeClass(hint: number): string {
  if (hint <= 1) return "bg-red-500/20 text-red-200 border-red-400/50";
  if (hint === 2) return "bg-orange-500/20 text-orange-200 border-orange-300/40";
  if (hint === 3) return "bg-amber-500/20 text-amber-200 border-amber-300/40";
  if (hint === 4) return "bg-emerald-500/20 text-emerald-200 border-emerald-300/40";
  return "bg-cyan-500/20 text-cyan-200 border-cyan-300/40";
}

// The revealed-safe tile content: a cyan diamond + the server-stamped clue.
function safeCellContent(hint: number | null): ReactNode {
  return (
    <span className="relative inline-flex items-center justify-center animate-tile-reveal">
      <IconDiamondFilled size={15} className="text-cyan-300" />
      {hint !== null && (
        <span
          className={`animate-hint-pop absolute -top-2 -right-2 flex h-3.5 w-3.5 items-center justify-center rounded-full border text-[9px] font-black tabular-nums ${hintBadgeClass(
            hint,
          )}`}
        >
          {hint}
        </span>
      )}
    </span>
  );
}

// Reusable floating score chip (+5 / −25 …), reusing the state-in entrance.
function ScorePop({ delta }: { delta: number }) {
  const positive = delta >= 0;
  return (
    <motion.span
      initial={{ opacity: 0, y: 6, scale: 0.9 }}
      animate={{ opacity: 1, y: -18, scale: 1 }}
      exit={{ opacity: 0, y: -30 }}
      transition={{ duration: 0.9, ease: "easeOut" }}
      className={`pointer-events-none absolute left-1/2 top-full z-20 -translate-x-1/2 whitespace-nowrap rounded-lg px-2 py-0.5 text-sm font-black tabular-nums shadow-lg ${
        positive
          ? "bg-cyan-400/90 text-[#001a2e]"
          : "bg-red-500/90 text-white"
      }`}
    >
      {positive ? "+" : ""}
      {delta}
    </motion.span>
  );
}

// ── Scoreboard side (score + compact public progress) ────────────────
function ScoreSide({
  label,
  name,
  iconKey,
  profileFrame,
  nameColor,
  isGuest = false,
  score,
  tiles,
  tilesTotal,
  mines,
  completed,
  pops,
  emote,
  emoteSide,
  align,
  accent,
}: {
  label: string;
  name: string;
  iconKey?: string | null;
  profileFrame?: unknown;
  nameColor?: string | null;
  isGuest?: boolean;
  score: number;
  tiles: number;
  tilesTotal: number;
  mines: number;
  completed: boolean;
  pops: { id: number; delta: number }[];
  emote: { kind?: string; value?: string; key?: string } | null;
  emoteSide: "mine" | "incoming";
  align: "left" | "right";
  accent: "cyan" | "fuchsia";
}) {
  const pct = tilesTotal > 0 ? Math.min(100, (tiles / tilesTotal) * 100) : 0;
  const acText = accent === "cyan" ? "text-cyan-300" : "text-fuchsia-300";
  const acBar = accent === "cyan" ? "bg-cyan-400" : "bg-fuchsia-400";
  const acBorder = accent === "cyan" ? "border-cyan-300/30" : "border-fuchsia-300/30";
  return (
    <div
      className={`relative flex min-w-0 flex-col ${
        align === "right" ? "items-end text-right" : "items-start text-left"
      }`}
    >
      <div className="flex items-center gap-2">
        <FrameAvatar frame={profileFrame} iconKey={iconKey || null} name={name} isGuest={isGuest} size="h-7 w-7" />
        <div className="min-w-0">
          <p className={`text-[10px] font-bold uppercase tracking-widest ${acText}`}>{label}</p>
          <p
            className={`truncate text-xs font-bold text-white/90 ${cosmeticEffectClass(
              (profileFrame as any)?.usernameEffect?.visual,
            ) || ""}`}
            style={nameColor ? { color: nameColor } : undefined}
          >
            {name}
          </p>
        </div>
        <EmoteBubble emote={emote} side={emoteSide} />
      </div>
      <p className="mt-1 text-3xl font-black tabular-nums text-white sm:text-4xl">
        {score.toLocaleString()}
        {completed && (
          <span className="ml-1.5 align-middle text-[10px] font-black uppercase tracking-widest text-emerald-300">
            Cleared
          </span>
        )}
      </p>
      <div className={`mt-1 h-1.5 w-full max-w-[10rem] overflow-hidden rounded-full bg-white/10 border ${acBorder}`}>
        <div className={`h-full rounded-full ${acBar} transition-all duration-500`} style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-1 text-[10px] font-semibold text-white/50 tabular-nums">
        {tiles}/{tilesTotal} tiles · {mines} mines
      </p>
      <AnimatePresence>
        {pops.map((p) => (
          <ScorePop key={p.id} delta={p.delta} />
        ))}
      </AnimatePresence>
    </div>
  );
}

export default function MinesPvpMatchPage({
  params,
}: {
  params: Promise<{ matchId: string }>;
}) {
  const paramsPromise = useMemo(() => Promise.resolve(params), [params]);
  const resolvedParams = use(paramsPromise);
  const rawMatchId =
    resolvedParams && typeof resolvedParams === "object" ? resolvedParams.matchId : undefined;
  const numericMatchId = Number(rawMatchId);
  const matchId = Number.isFinite(numericMatchId) ? numericMatchId : null;
  const isValidMatchId = matchId !== null;
  const { isSignedIn, user } = useUser();
  const router = useRouter();
  const posthog = usePostHog();
  const { socket } = useSocket();

  const [match, setMatch] = useState<MatchRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [resigning, setResigning] = useState(false);
  const [timeLeft, setTimeLeft] = useState<number>(0);
  const [showReportModal, setShowReportModal] = useState(false);
  const [flagMode, setFlagMode] = useState(false);
  const [messages, setMessages] = useState<
    { id: number; text: string; tone: "mine" | "safe" }[]
  >([]);

  // The page's estimate of the server's clock (null until sampled), for timing
  // the deadline read below against the server's own instants.
  const serverNowEstimate = useServerClockEstimate();

  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const resolvedFiredRef = useRef(false);

  // ── Status fetch (authoritative per-viewer snapshot) ─────────────
  const fetchStatus = useCallback(async () => {
    if (isSignedIn === false) {
      setLoading(false);
      setError("You must be signed in to view this match.");
      return;
    }
    if (isSignedIn !== true) return;
    if (!isValidMatchId) {
      setLoading(false);
      setError("Invalid match link.");
      return;
    }
    try {
      const res = await fetch(`/api/mines-pvp/match/${matchId}`, {
        cache: "no-store",
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(data?.error || "Unable to load match");
        return;
      }
      const nextMatch =
        data?.data?.match && typeof data.data.match === "object" ? data.data.match : null;
      setMatch(nextMatch);
      setError(nextMatch ? null : "Match not found.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setLoading(false);
    }
  }, [isSignedIn, isValidMatchId, matchId]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  // Event-driven sync: the MATCH_UPDATED socket push is the fast path; this
  // reconciles ONCE on socket reconnect and on tab focus — never on a timer.
  useMatchSync(fetchStatus, socket, Boolean(isValidMatchId));

  // …and each stamped deadline still needs ITS one read. This route is the only
  // caller of `fetchMatchWithAutoResolve`, whose first step is "Ready banner
  // elapsed → go live" and which also settles an expired 180s match timer. With
  // no reader the board sat on "Starting in a few seconds…" and never started.
  // ONE bounded read per pending instant, cleared the moment it is gone; which
  // instant counts is `minesPvpDueRead` (see `lib/deadlineRead.ts`).
  // `serverNow` is the page's own estimate of the server's clock, so the read
  // fires ON the stamped instant rather than a skew-covering slack past it — the
  // banner running out IS the read. It answers null until the sample lands, and
  // the hook then keeps its full slack rather than trusting the device clock.
  useDeadlineRead(minesPvpDueRead(match), fetchStatus, {
    serverNow: serverNowEstimate,
  });

  // ── Realtime: existing per-match room refetch hint ──────────────
  // `lobby:updated` is the bare "refetch the authoritative snapshot" hint
  // every game relays. `mines-pvp:score` is the server-only cosmetic score
  // hint — we only use it as an extra prompt to refetch, never as a source of
  // truth (the refetched snapshot recomputes the score).
  useEffect(() => {
    if (!socket || !isValidMatchId) return;
    const refresh = () => fetchStatus();
    const roomId = minesPvpMatchRoom(matchId);
    socket.emit("join_room", { roomId });
    socket.on(MINES_PVP_MATCH_UPDATED, refresh);
    socket.on(MINES_PVP_SCORE_EVENT, refresh);
    return () => {
      socket.emit("leave_room", { roomId });
      socket.off(MINES_PVP_MATCH_UPDATED, refresh);
      socket.off(MINES_PVP_SCORE_EVENT, refresh);
    };
  }, [socket, matchId, isValidMatchId, fetchStatus]);

  // ── Server-authoritative countdown (visual only) ────────────────
  useEffect(() => {
    if (tickRef.current) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
    const deadline = match?.matchDeadline;
    if (!deadline || match?.status !== MATCH_STATUS.ACTIVE) {
      setTimeLeft(match?.status === MATCH_STATUS.ACTIVE ? Number(match?.matchTimerSeconds) || 0 : 0);
      return;
    }
    const deadlineMs = new Date(deadline).getTime();
    const tick = () => {
      setTimeLeft(Math.max(0, Math.ceil((deadlineMs - Date.now()) / 1000)));
    };
    tick();
    tickRef.current = setInterval(tick, 250);
    return () => {
      if (tickRef.current) {
        clearInterval(tickRef.current);
        tickRef.current = null;
      }
    };
  }, [match?.matchDeadline, match?.status, match?.matchTimerSeconds]);

  // ── Derived state ───────────────────────────────────────────────
  const myUserId = user?.id;
  const { incomingEmote, myEmote, sendEmote } = useGameEmotes({
    socket,
    roomId: matchId ? `mines:emote:${matchId}` : null,
    eventName: "mines:emote",
    selfId: myUserId,
  });

  const isPlayer1 = match?.player1Id === myUserId;
  const isAi = Boolean(match?.isAi);
  const status = match?.status ?? null;
  const isWaiting = status === MATCH_STATUS.WAITING;
  const isReady = status === MATCH_STATUS.READY;
  const isActive = status === MATCH_STATUS.ACTIVE;
  const isFinished = status === MATCH_STATUS.FINISHED;
  const isCancelled = status === MATCH_STATUS.CANCELLED;
  const isParticipant = useMemo(() => {
    if (!match || !myUserId) return false;
    return match.player1Id === myUserId || match.player2Id === myUserId;
  }, [match, myUserId]);

  // ── Practice bot heartbeat ─────────────────────────────────────────────
  // The bot plays its OWN board, and the server advances it on READ (see
  // `playAiTurnInTransaction`, run from this page's status fetch). The page's
  // sync is event-driven on purpose and correct for a human duel, whose
  // opponent pushes MATCH_UPDATED — but a practice match pushes nothing while
  // the bot plays, so without a read the bot freezes the moment the player
  // stops acting, and the board is left waiting on a clock that is only
  // resolved on a read too.
  //
  // Gated on four things so nothing else pays for it: it is a practice match,
  // the match is live (a finished/expired status settles on the next read and
  // then stops this), the bot's own board is neither locked nor complete (it
  // has nothing left to play), and the tab is visible.
  const botStillPlaying =
    isAi && isActive && !match?.opponentLocked && !match?.opponentCompleted;
  usePracticeBotHeartbeat(botStillPlaying, fetchStatus);

  const myRevealMap = useMemo(() => {
    const map = new Map<number, OwnReveal>();
    for (const r of match?.myRevealed ?? []) {
      if (r && Number.isInteger(r.cell)) map.set(r.cell, r);
    }
    return map;
  }, [match]);
  const myFlagSet = useMemo(() => new Set(match?.myFlags ?? []), [match]);
  const correctFlagSet = useMemo(() => new Set(match?.myCorrectFlagCells ?? []), [match]);
  const incorrectFlagSet = useMemo(() => new Set(match?.myIncorrectFlagCells ?? []), [match]);

  // "Resolved" = every cell the seat has settled: revealed cells (safe tiles
  // plus detonated mines) AND mines confirmed by a correct flag. This is the
  // same set the server checks for completion, so the progress bar reaches
  // 100/100 exactly when the board clears.
  const myRevealedCount = myRevealMap.size;
  const myTilesResolved = myRevealedCount + correctFlagSet.size;
  const opponentTilesResolved =
    (Number(match?.opponentSafeRevealed) || 0) +
    (Number(match?.opponentMinesHit) || 0) +
    (Number(match?.opponentCorrectFlags) || 0);

  // ── Score feedback (diffed from the authoritative snapshot) ─────
  const prevScoresRef = useRef<{ me: number; opp: number } | null>(null);
  const popIdRef = useRef(0);
  const [myPops, setMyPops] = useState<{ id: number; delta: number }[]>([]);
  const [oppPops, setOppPops] = useState<{ id: number; delta: number }[]>([]);
  useEffect(() => {
    if (!match) {
      prevScoresRef.current = null;
      return;
    }
    const me = Number(match.myScore) || 0;
    const opp = Number(match.opponentScore) || 0;
    const prev = prevScoresRef.current;
    prevScoresRef.current = { me, opp };
    if (!prev) return;
    if (me !== prev.me) {
      setMyPops((p) => [...p, { id: (popIdRef.current += 1), delta: me - prev.me }]);
    }
    if (opp !== prev.opp) {
      setOppPops((p) => [...p, { id: (popIdRef.current += 1), delta: opp - prev.opp }]);
    }
  }, [match]);
  useEffect(() => {
    if (!myPops.length) return;
    const t = setTimeout(() => setMyPops((p) => p.slice(1)), 1200);
    return () => clearTimeout(t);
  }, [myPops]);
  useEffect(() => {
    if (!oppPops.length) return;
    const t = setTimeout(() => setOppPops((p) => p.slice(1)), 1200);
    return () => clearTimeout(t);
  }, [oppPops]);

  // ── Deciding action → result beat ───────────────────────────────
  const shouldReduceMotion = useReducedMotion();
  const [resultRevealed, setResultRevealed] = useState(false);
  useEffect(() => {
    if (status !== MATCH_STATUS.FINISHED) {
      setResultRevealed(false);
      return;
    }
    if (shouldReduceMotion) {
      setResultRevealed(true);
      return;
    }
    const timer = setTimeout(() => setResultRevealed(true), RESULT_BEAT_MS);
    return () => clearTimeout(timer);
  }, [status, shouldReduceMotion]);

  // ── Finished-reveal sweep ───────────────────────────────────────
  const revealDelayMs = useCallback(
    (cellIndex: number) => {
      if (!match || !isFinished) return 0;
      if (shouldReduceMotion || myRevealMap.has(cellIndex)) return 0;
      return cellIndex * REVEAL_STEP_MS;
    },
    [match, isFinished, shouldReduceMotion, myRevealMap],
  );

  // ── Audio: result ───────────────────────────────────────────────
  const resultSoundFiredRef = useRef(false);
  useEffect(() => {
    if (!match || !isFinished) {
      resultSoundFiredRef.current = false;
      return;
    }
    if (!resultRevealed || resultSoundFiredRef.current) return;
    resultSoundFiredRef.current = true;
    // The verdict, from the SERVER's result + the seat it says the viewer
    // holds — not from `winnerId === user.id`, which a signed-out free-play
    // visitor fails whatever the row says.
    const verdict = viewerOutcome({
      result: match.result,
      winnerId: match.winnerId,
      viewerSeat: match.viewerSeat,
    });
    if (verdict === "win") playVictory();
    else if (verdict === "loss") playDefeat();
    else playTick();
  }, [match, isFinished, resultRevealed]);

  // ── Posthog: match resolved ─────────────────────────────────────
  useEffect(() => {
    if (!match || !isFinished) {
      if (resolvedFiredRef.current) resolvedFiredRef.current = false;
      return;
    }
    if (resolvedFiredRef.current) return;
    resolvedFiredRef.current = true;
    const iWon =
      viewerOutcome({
        result: match.result,
        winnerId: match.winnerId,
        viewerSeat: match.viewerSeat,
      }) === "win";
    posthog?.capture("mines_pvp_match_resolved", {
      match_id: matchId,
      winner: iWon ? "you" : match.winnerId ? "opponent" : "draw",
      result: match.result,
      my_score: match.myScore,
      opponent_score: match.opponentScore,
      my_safe_revealed: match.mySafeRevealed,
      my_mines_hit: match.myMinesHit,
      my_correct_flags: match.myCorrectFlags,
      my_incorrect_flags: match.myIncorrectFlags,
      my_completed: match.myCompleted,
      win_reason: match.winReason,
      mines_count: match.minesCount,
    });
  }, [match, matchId, posthog, isFinished]);

  // ── Timer urgency ticks (last 5s) ───────────────────────────────
  const lastTickSecondRef = useRef<number | null>(null);
  useEffect(() => {
    if (isAi || !isActive || match?.myLocked) return;
    if (timeLeft > 5) {
      lastTickSecondRef.current = null;
      return;
    }
    if (timeLeft <= 0) return;
    if (lastTickSecondRef.current === timeLeft) return;
    lastTickSecondRef.current = timeLeft;
    playTick();
  }, [isAi, isActive, match?.myLocked, timeLeft]);

  // ── Actions ─────────────────────────────────────────────────────
  const postAction = useCallback(
    async (action: "pick" | "flag" | "unflag", cellIndex: number) => {
      if (busy || !match) return;
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`/api/mines-pvp/match/${matchId}/${action}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ cellIndex }),
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
          setError(data?.error || "Action failed");
          return;
        }
        const info = data?.data || {};
        if (action === "flag") {
          if (info.wrongFlag) {
            setMessages((prev) =>
              [...prev, { id: Date.now(), text: "Wrong flag −10", tone: "safe" as const }].slice(-3),
            );
            playBuzz();
          } else if (info.flagRevealed) {
            setMessages((prev) =>
              [
                ...prev,
                { id: Date.now(), text: `Mine confirmed +${Number(info.mineValue) || 0}`, tone: "mine" as const },
              ].slice(-3),
            );
            playGoodReveal();
          }
        } else if (action === "pick") {
          if (info.revealedMine) {
            setMessages((prev) =>
              [...prev, { id: Date.now(), text: "💥 Mine hit −25", tone: "safe" as const }].slice(-3),
            );
            playBuzz();
          } else {
            playGoodReveal();
          }
        } else {
          playTick();
        }
        // Existing realtime contract: a bare refetch hint to the match room
        // (opponent refetches immediately) and the lobby room (open list).
        socket?.emit("room_event", {
          roomId: minesPvpMatchRoom(matchId),
          event: MINES_PVP_MATCH_UPDATED,
        });
        socket?.emit("room_event", {
          roomId: MINES_PVP_LOBBY_ROOM,
          event: MINES_PVP_MATCH_UPDATED,
        });
        posthog?.capture(
          action === "flag" ? "mines_pvp_flag" : action === "unflag" ? "mines_pvp_unflag" : "mines_pvp_pick",
          { match_id: matchId, cell_index: cellIndex },
        );
        // Free vs-AI: let the bot take its move now.
        if (match?.isAi) {
          try {
            await fetch(`/api/mines-pvp/match/${matchId}/ai-turn`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              credentials: "include",
              body: JSON.stringify({}),
            });
          } catch {
            /* best-effort; the poll recovers */
          }
        }
        await fetchStatus();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Network error");
      } finally {
        setBusy(false);
      }
    },
    [busy, match, matchId, posthog, socket, fetchStatus],
  );

  const boardLocked = !isActive || Boolean(match?.myLocked) || timeLeft <= 0;

  const handleCellClick = useCallback(
    (cellIndex: number) => {
      if (!match || busy || boardLocked) return;
      const reveal = myRevealMap.get(cellIndex);
      if (reveal) return; // already resolved
      if (correctFlagSet.has(cellIndex)) return; // confirmed mine — locked
      if (flagMode) {
        if (incorrectFlagSet.has(cellIndex)) {
          postAction("unflag", cellIndex);
          return;
        }
        if (myFlagSet.has(cellIndex)) return;
        postAction("flag", cellIndex);
        return;
      }
      postAction("pick", cellIndex);
    },
    [match, busy, boardLocked, myRevealMap, correctFlagSet, incorrectFlagSet, myFlagSet, flagMode, postAction],
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
      router.push("/casino/mines-pvp");
    } finally {
      setCancelling(false);
    }
  }, [cancelling, matchId, router]);

  const handleResign = useCallback(async () => {
    if (resigning) return;
    if (!window.confirm("Resign this match? Your opponent wins.")) return;
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
      await fetchStatus();
    } finally {
      setResigning(false);
    }
  }, [matchId, resigning, fetchStatus]);

  // ── Cell rendering ──────────────────────────────────────────────
  function getCellDisplay(cellIndex: number): {
    content: ReactNode;
    revealed: boolean;
    isMine: boolean;
    tone: "hidden" | "safe" | "mine" | "correctFlag" | "wrongFlag" | "flagTarget";
  } {
    if (!match) {
      return { content: <IconQuestionMark size={15} className="text-white/25" />, revealed: false, isMine: false, tone: "hidden" };
    }
    const reveal = myRevealMap.get(cellIndex);
    const isCorrect = correctFlagSet.has(cellIndex);
    const isWrong = incorrectFlagSet.has(cellIndex);

    // Own resolved cells (live and finished).
    if (reveal) {
      if (reveal.mine) {
        return { content: <AnimatedBomb exploded />, revealed: true, isMine: true, tone: "mine" };
      }
      return { content: safeCellContent(reveal.hint), revealed: true, isMine: false, tone: "safe" };
    }
    // A mine the player CONFIRMED by flagging (own knowledge only).
    if (isCorrect) {
      return {
        content: (
          <span className="relative inline-flex items-center justify-center animate-tile-reveal">
            <MineGlyph size={17} />
            <span className="animate-hint-pop absolute -top-2 -right-2 flex h-3.5 w-3.5 items-center justify-center rounded-full border border-emerald-300/50 bg-emerald-500/20 text-emerald-200">
              <CheckIcon className="h-2.5 w-2.5" />
            </span>
          </span>
        ),
        revealed: true,
        isMine: true,
        tone: "correctFlag",
      };
    }
    if (isWrong) {
      return {
        content: (
          <span className="relative inline-flex items-center justify-center animate-tile-reveal">
            <FlagGlyph size={17} />
            <span className="animate-hint-pop absolute -top-2 -right-2 flex h-3.5 w-3.5 items-center justify-center rounded-full border border-red-400/50 bg-red-500/20 text-red-200">
              <CrossIcon className="h-2.5 w-2.5" />
            </span>
          </span>
        ),
        revealed: false,
        isMine: false,
        tone: "wrongFlag",
      };
    }
    // Finished replay of a cell the player never touched.
    if (isFinished) {
      const isMine = Boolean(match.board?.mines?.includes(cellIndex));
      const revealDelay = revealDelayMs(cellIndex);
      const style = revealDelay > 0 ? { animationDelay: `${revealDelay}ms` } : undefined;
      return {
        content: isMine ? (
          <span className="animate-state-in inline-flex items-center justify-center" style={style}>
            <AnimatedBomb exploded delayMs={revealDelay} />
          </span>
        ) : (
          <span className="animate-state-in inline-flex items-center justify-center" style={style}>
            <IconDiamondFilled size={15} className="text-cyan-300/60" />
          </span>
        ),
        revealed: true,
        isMine,
        tone: isMine ? "mine" : "safe",
      };
    }
    // Flag mode: an unrevealed cell is a flag target.
    if (flagMode && !match.myLocked && isActive) {
      return {
        content: <FlagGlyph size={16} className="opacity-70" />,
        revealed: false,
        isMine: false,
        tone: "flagTarget",
      };
    }
    return { content: <IconQuestionMark size={15} className="text-white/25" />, revealed: false, isMine: false, tone: "hidden" };
  }

  // ── The tiles, in the shared cartoon language ────────────────────────
  //
  // Every tile is a slab with ONE dark outline (`--gr-outline`), a light band
  // along the top and a darker underside — the three values the rest of
  // GRYND's pieces use, lit from the top-left. The tone only picks the HUE:
  //
  //   hidden      deep blue, raised: a tile you may still turn over
  //   safe        revealed, flatter: carries the clue number
  //   mine        detonated: hot pink, the loudest thing on the board
  //   correctFlag emerald: a mine you PROVED by flagging it
  //   wrongFlag   red: a flag the server rejected
  //   flagTarget  red-tinted: the cell flag mode is pointing at
  //
  // Focus is the shared ring (`.gr-focusable`), so a keyboard player gets the
  // same cue on a hidden, revealed or inert tile; `cursor-not-allowed` is the
  // only "disabled" signal, because a revealed tile is still information, not
  // a blanked-out control.
  const TILE_DEPTH = {
    raised: "shadow-[inset_0_2px_0_rgba(255,255,255,0.10),inset_0_-3px_0_rgba(3,8,20,0.55)]",
    flat: "shadow-[inset_0_2px_0_rgba(160,235,255,0.16),inset_0_-2px_0_rgba(3,8,20,0.45)]",
    hot: "shadow-[inset_0_2px_0_rgba(255,150,235,0.45),inset_0_-3px_0_rgba(70,0,45,0.6)]",
    good: "shadow-[inset_0_2px_0_rgba(140,255,205,0.35),inset_0_-3px_0_rgba(0,50,30,0.55)]",
    bad: "shadow-[inset_0_2px_0_rgba(255,160,170,0.3),inset_0_-3px_0_rgba(70,0,10,0.55)]",
  } as const;

  function getCellClass(tone: ReturnType<typeof getCellDisplay>["tone"]): string {
    // The border COLOUR lives on each tone (not on the shared base), so a tone
    // class and the base can never fight over the same property.
    const base =
      "gr-focusable relative isolate flex h-full w-full items-center justify-center rounded-[4px] border-2 text-sm transition-[background-color,border-color,box-shadow,transform] duration-150 ease-out";
    switch (tone) {
      case "mine":
        return `${base} bg-[#4a1030] border-[#ff4fd8] ${TILE_DEPTH.hot}`;
      case "correctFlag":
        return `${base} bg-[#10291c] border-emerald-400/80 ${TILE_DEPTH.good}`;
      case "wrongFlag":
        return `${base} bg-[#2c0f16] border-[#ff5a6e] ${TILE_DEPTH.bad}`;
      case "safe":
        return `${base} bg-[#0b2a44] border-[#1d5b80] ${TILE_DEPTH.flat}`;
      case "flagTarget":
        return `${base} bg-[#2c0f16] border-[#ff5a6e] ${TILE_DEPTH.bad} hover:-translate-y-px hover:border-[#ff8a99]`;
      default:
        return `${base} border-[color:var(--gr-outline)] bg-[#0e2743] ${TILE_DEPTH.raised} hover:-translate-y-px hover:border-[#2f7fb8] hover:bg-[#143555]`;
    }
  }

  // ── Result ──────────────────────────────────────────────────────
  function renderResult() {
    if (!match || !isFinished || !resultRevealed) return null;
    // THE VERDICT IS THE SERVER'S, READ FROM THE VIEWER'S SEAT. `result` is
    // settled from the winner SEAT, and `viewerSeat` is the seat the server
    // says the viewer holds — so a guest sees the result the server wrote,
    // never a false loss from comparing `winnerId` against a Clerk id the
    // guest does not have.
    const verdict = viewerOutcome({
      result: match.result,
      winnerId: match.winnerId,
      viewerSeat: match.viewerSeat,
    });
    const iWon = verdict === "win";
    const iLost = verdict === "loss";
    // A finished row that names no winner is a draw for both seats — never a
    // loss.
    const isDrawResult = !iWon && !iLost;
    const outcome = verdict ?? "draw";

    const oppSummary = isPlayer1 ? match.players?.p2 : match.players?.p1;
    const oppName = oppSummary?.displayName || (isAi ? "GRYND AI" : "Opponent");

    let durationSeconds: number | null = null;
    if (match.startedAt && match.endedAt) {
      const start = new Date(match.startedAt).getTime();
      const end = new Date(match.endedAt).getTime();
      if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
        durationSeconds = Math.round((end - start) / 1000);
      }
    }
    let completedInSeconds: number | null = null;
    if (match.startedAt && match.myCompletedAt) {
      const start = new Date(match.startedAt).getTime();
      const done = new Date(match.myCompletedAt).getTime();
      if (Number.isFinite(start) && Number.isFinite(done) && done >= start) {
        completedInSeconds = Math.round((done - start) / 1000);
      }
    }

    const headline =
      match.winReason === "resign"
        ? iWon
          ? `${oppName} resigned`
          : "You resigned"
        : match.winReason === "disconnect"
          ? iWon
            ? `${oppName} disconnected`
            : "You disconnected"
          : `${match.myScore} – ${match.opponentScore}`;

    return (
      <PvpResultScreen
        open
        outcome={outcome}
        headline={headline}
        gameName="Mines Duel"
        opponent={
          isAi
            ? { name: "GRYND AI", isAi: true }
            : { name: oppName, iconKey: oppSummary?.iconKey || null, profileFrame: oppSummary?.profileFrame || null }
        }
        durationSeconds={durationSeconds}
        sides={[
          { name: "You", score: match.myScore, highlight: iWon },
          { name: oppName, score: match.opponentScore, highlight: iLost },
        ]}
        details={[
          { label: "Final score", value: `${match.myScore} – ${match.opponentScore}` },
          { label: "Tiles revealed", value: String(myRevealedCount) },
          { label: "Correct flags", value: String(match.myCorrectFlags) },
          { label: "Wrong flags", value: String(match.myIncorrectFlags) },
          { label: "Mines hit", value: String(match.myMinesHit) },
          { label: "Board cleared", value: match.myCompleted ? "Yes" : "No" },
          ...(completedInSeconds !== null
            ? [{ label: "Cleared in", value: formatClock(completedInSeconds) }]
            : []),
        ]}
        playAgain={{ onClick: () => router.push("/casino/mines-pvp") }}
        onReturnToLobby={() => router.push("/casino")}
      />
    );
  }

  // ── Loading / error / non-participant ──────────────────────────
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

  // ── Chunk info ──────────────────────────────────────────────────
  const stake = Number(match.stakeAmount) || 0;
  const wagerLabel = isAi ? "Free play" : `${stake.toLocaleString()} tokens`;
  const mySummary = isPlayer1 ? match.players?.p1 : match.players?.p2;
  const oppSummary = isPlayer1 ? match.players?.p2 : match.players?.p1;
  const myDisplayName = mySummary?.displayName || "You";
  const opponentDisplayName = isAi ? "GRYND AI" : oppSummary?.displayName || "Opponent";
  const canCancel = isWaiting && match.player1Id === myUserId && !cancelling;
  const opponentClerkId = isAi ? null : isPlayer1 ? match.player2Id : match.player1Id;
  const minesTotal = Number(match.minesCount) || 0;
  const tilesTotal = GRID_CELLS;

  const titleNode = (
    <motion.div
      {...withReducedMotion(shouldReduceMotion, {
        initial: { opacity: 0, y: -12 },
        animate: { opacity: 1, y: 0 },
        transition: { duration: 0.4 },
      })}
    >
      <h1 className="flex items-center justify-center gap-3 text-center text-2xl sm:text-3xl font-extrabold tracking-wide text-transparent bg-clip-text bg-gradient-to-r from-cyan-200 via-cyan-300 to-fuchsia-300 drop-shadow-[0_0_18px_rgba(0,229,255,0.55)]">
        <MineIcon className="w-7 h-7 sm:w-8 sm:h-8 text-cyan-300 drop-shadow-[0_0_12px_rgba(0,229,255,0.65)] flex-shrink-0" />
        <span>Mines Duel · Match #{matchId}</span>
      </h1>
    </motion.div>
  );

  // ── Top scoreboard: YOU | clock | OPPONENT, with compact progress ──
  const scoreboardNode = (
    <div className="mx-auto mt-4 w-full max-w-3xl rounded-2xl border border-[color:var(--gr-outline)] bg-[#08142f]/70 px-3 py-3 shadow-[inset_0_2px_0_rgba(255,255,255,0.05),0_10px_0_-4px_rgba(3,8,20,0.7)] sm:px-5 lg:mt-0 lg:max-w-none">
      <div className="grid grid-cols-[1fr_auto_1fr] items-start gap-2 sm:gap-4 lg:mt-0 lg:grid-cols-1">
        <ScoreSide
          align="left"
          accent="cyan"
          label="You"
          name={myDisplayName}
          iconKey={mySummary?.iconKey || null}
          profileFrame={mySummary?.profileFrame || null}
          nameColor={mySummary?.nameColor || null}
          isGuest={Boolean(mySummary?.isGuest)}
          score={Number(match.myScore) || 0}
          tiles={myTilesResolved}
          tilesTotal={tilesTotal}
          mines={Number(match.myCorrectFlags) || 0}
          completed={Boolean(match.myCompleted)}
          pops={myPops}
          emote={myEmote}
          emoteSide="mine"
        />
        <div className="flex flex-col items-center px-1">
          <div
            className={`flex items-center gap-1 text-3xl font-black tabular-nums sm:text-4xl ${
              isActive && timeLeft <= 10 ? "text-red-300" : "text-white"
            } ${isActive && timeLeft <= 5 && timeLeft > 0 ? "animate-pulse" : ""}`}
          >
            <ClockIcon className="w-5 h-5 opacity-70" />
            {formatClock(isActive ? timeLeft : 0)}
          </div>
          <span className="mt-0.5 text-[9px] font-bold uppercase tracking-widest text-white/40">
            Match timer
          </span>
        </div>
        <ScoreSide
          align="right"
          accent="fuchsia"
          label={isAi ? "GRYND AI" : "Opponent"}
          name={opponentDisplayName}
          iconKey={oppSummary?.iconKey || null}
          profileFrame={oppSummary?.profileFrame || null}
          nameColor={oppSummary?.nameColor || null}
          isGuest={Boolean(oppSummary?.isGuest)}
          score={Number(match.opponentScore) || 0}
          tiles={opponentTilesResolved}
          tilesTotal={tilesTotal}
          mines={Number(match.opponentCorrectFlags) || 0}
          completed={Boolean(match.opponentCompleted)}
          pops={oppPops}
          emote={incomingEmote}
          emoteSide="incoming"
        />
      </div>
    </div>
  );

  // ── Status banner ───────────────────────────────────────────────
  function renderStatus() {
    if (isCancelled) {
      return (
        <div className="flex items-center justify-center gap-2 rounded-xl border border-red-400/40 bg-red-900/30 px-4 py-3 text-red-200">
          <AlertIcon className="w-5 h-5 text-red-300" />
          <span className="font-semibold">This match was cancelled.</span>
        </div>
      );
    }
    if (isFinished) return null;
    if (isWaiting || isReady) return null;
    if (isActive && match.opponentCompleted && !match.myCompleted) {
      return (
        <div className="flex items-center justify-center gap-2 rounded-xl border border-amber-300/40 bg-amber-500/10 px-4 py-2.5 text-amber-100">
          <span className="font-bold">
            {isAi ? "GRYND AI cleared its board" : `${opponentDisplayName} cleared their board`} — keep going
          </span>
        </div>
      );
    }
    if (isActive && boardLocked && !match.myCompleted) {
      return (
        <div className="flex items-center justify-center gap-2 rounded-xl border border-red-400/50 bg-red-900/25 px-4 py-2.5 text-red-200">
          <ClockIcon className="w-5 h-5 text-red-300" />
          <span className="font-bold">Time! Waiting for the final result…</span>
        </div>
      );
    }
    return (
      <div className="flex items-center justify-center gap-2 rounded-xl border border-cyan-300/40 bg-cyan-500/10 px-4 py-2.5 text-cyan-200">
        <span className="font-bold">
          {flagMode ? "Flag mode — tap a tile you believe is a mine" : "Reveal safe tiles and flag mines — go!"}
        </span>
      </div>
    );
  }

  // ── Board ───────────────────────────────────────────────────────
  const boardNode = (
    <div className="mines-board-frame mx-auto relative mt-4 w-full rounded-2xl border-2 border-[color:var(--gr-outline)] bg-[#0a1c33] p-2 shadow-[0_10px_0_-2px_rgba(3,8,20,0.85),inset_0_2px_0_rgba(255,255,255,0.07)] sm:p-3">
      <div className="grid grid-cols-10 gap-1 sm:gap-1.5">
        {Array.from({ length: GRID_CELLS }, (_, i) => i).map((cellIndex) => {
          const display = getCellDisplay(cellIndex);
          const revealDelay = revealDelayMs(cellIndex);
          const clickable = !boardLocked && (display.tone === "hidden" || display.tone === "flagTarget" || display.tone === "wrongFlag") && !myRevealMap.has(cellIndex) && !correctFlagSet.has(cellIndex);
          return (
            <button
              key={cellIndex}
              onClick={() => handleCellClick(cellIndex)}
              disabled={!clickable || busy}
              aria-label={`Tile ${cellIndex + 1}`}
              className={`group w-full aspect-square ${getCellClass(display.tone)} ${
                clickable ? "cursor-pointer" : "cursor-not-allowed"
              }`}
              style={revealDelay > 0 ? { transitionDelay: `${revealDelay}ms` } : undefined}
            >
              <span className="inline-flex transition-transform duration-100 ease-out group-active:scale-90">
                {display.content}
              </span>
            </button>
          );
        })}
      </div>

      {/* Board-cleared overlay — the player finished, the opponent plays on. */}
      <AnimatePresence>
        {isActive && match.myCompleted && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-1 rounded-2xl bg-[#00111f]/85 backdrop-blur-sm"
          >
            <span className="flex items-center gap-2 text-2xl font-black uppercase tracking-widest text-emerald-300 drop-shadow-[0_0_18px_rgba(52,211,153,0.6)] sm:text-3xl">
              <IconTrophy size={26} className="text-emerald-300" />
              Board cleared
            </span>
            <span className="text-sm font-black text-cyan-200">+100 bonus</span>
            <span className="mt-1 text-[10px] font-bold uppercase tracking-widest text-white/50">
              Final score
            </span>
            <span className="text-4xl font-black tabular-nums text-white">{Number(match.myScore) || 0}</span>
            <span className="mt-2 flex items-center gap-1.5 text-xs font-semibold text-white/60">
              <LoadingDotsIcon className="w-4 h-4 animate-pulse text-cyan-300" />
              Waiting for {isAi ? "GRYND AI" : "opponent"}…
            </span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );

  const legendNode = (
    <p className="mt-3 text-center text-[10px] uppercase tracking-widest text-white/35 font-bold">
      <span className="inline-flex items-center gap-1">
        <IconDiamondFilled size={12} className="text-cyan-300" /> number = tiles to the nearest mine (1 = right next to it)
      </span>
    </p>
  );

  // ── Controls ────────────────────────────────────────────────────
  const pickToggleNode =
    isActive && !match.myLocked ? (
      <div className="mt-3 flex flex-col items-center gap-2">
        <div className="inline-flex rounded-xl border border-cyan-300/30 bg-[#08142f]/80 p-1 text-xs font-bold">
          <button
            onClick={() => setFlagMode(false)}
            className={`px-3 py-1.5 rounded-lg transition ${
              !flagMode ? "bg-cyan-300 text-[#001933] shadow-[0_0_10px_rgba(0,229,255,0.45)]" : "text-cyan-200/70 hover:text-cyan-100"
            }`}
          >
            <span className="inline-flex items-center gap-1">
              <IconDiamondFilled size={14} className="text-cyan-300" /> Reveal
            </span>
          </button>
          <button
            onClick={() => setFlagMode(true)}
            className={`px-3 py-1.5 rounded-lg transition ${
              flagMode ? "bg-red-400 text-[#2a0d1e] shadow-[0_0_10px_rgba(248,113,113,0.45)]" : "text-red-300/70 hover:text-red-200"
            }`}
          >
            <span className="inline-flex items-center gap-1">
              <IconFlag size={14} className="text-red-300" /> Flag
            </span>
          </button>
        </div>
        <p className="max-w-md text-center text-[10px] font-semibold text-white/45">
          Safe reveal +5 · correct flag = the mine&apos;s value · wrong flag −10 · mine hit −25 · clearing your board +100.
          Flag mode taps a marked tile to remove a wrong flag.
        </p>
      </div>
    ) : null;

  const resignNode =
    isActive && !match.myLocked ? (
      <div className="flex justify-center">
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

  const messagesNode = messages.length ? (
    <div className="mt-3 flex flex-col gap-1">
      {messages.map((m) => (
        <div
          key={m.id}
          className={`animate-state-in rounded-lg border px-3 py-1.5 text-center text-xs font-bold ${
            m.tone === "mine" ? "border-amber-300/40 bg-amber-500/10 text-amber-200" : "border-red-400/40 bg-red-900/30 text-red-200"
          }`}
        >
          {m.text}
        </div>
      ))}
    </div>
  ) : null;

  const errorNode = error ? (
    <div className="mt-3 flex items-center gap-2 rounded-lg border border-red-400/40 bg-red-900/30 px-3 py-2 text-sm text-red-200">
      <AlertIcon className="w-4 h-4 text-red-300" />
      <span>{error}</span>
    </div>
  ) : null;

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

  const infoNode = (
    <div className="mt-2 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-xs text-white/60">
      <span className="inline-flex items-center gap-1">
        {isAi ? "Free vs AI" : "Stake:"}
        {!isAi && (
          <span className="text-yellow-300 font-semibold inline-flex items-center gap-1">
            {stake.toLocaleString()}
            <CoinIcon className="w-3.5 w-3.5 text-yellow-300" />
          </span>
        )}
        {isAi && <span className="text-emerald-300 font-semibold">No tokens at stake</span>}
      </span>
      <span className="inline-flex items-center gap-1">
        Mines: <span className="text-fuchsia-300 font-semibold inline-flex items-center gap-1">{minesTotal}<MineIcon className="w-3.5 h-3.5 text-fuchsia-300" /></span>
      </span>
      <span className="inline-flex items-center gap-1">
        Your mines left: <span className="text-cyan-300 font-semibold">{Math.max(0, minesTotal - (Number(match.myCorrectFlags) || 0))}</span>
      </span>
      <span className="inline-flex items-center gap-1">
        {wagerLabel}
      </span>
      {opponentClerkId && (
        <button
          onClick={() => setShowReportModal(true)}
          className="inline-flex items-center gap-1 rounded-full border border-red-500/30 bg-red-500/10 px-2.5 py-0.5 text-xs font-bold text-red-400 transition-all hover:bg-red-500/20"
        >
          <IconFlag size={12} /> Report opponent
        </button>
      )}
    </div>
  );

  const emoteNode = (
    <div className="mt-3 flex justify-center">
      <EmotePicker compact hideBubbles incomingEmote={incomingEmote} myEmote={myEmote} onSend={(emote) => sendEmote(emote)} />
    </div>
  );

  return (
    <>
      {(isWaiting || isReady) && (
        <MatchWaiting
          state={isReady ? "ready" : "waiting"}
          gameName={isAi ? "Mines Duel vs AI" : "Mines Duel"}
          subtitle={
            isReady
              ? "Both players joined. Starting in a few seconds…"
              : isAi
                ? "Free practice against the GRYND AI — the board starts in a moment."
                : `Your ${stake.toLocaleString()} stake is escrowed. Someone with the same stake will join shortly.`
          }
          seats={[
            isReady
              ? { label: "You", name: myDisplayName, occupied: true, wager: wagerLabel }
              : { label: "You", name: myDisplayName, occupied: true },
            isReady
              ? { label: isAi ? "GRYND AI" : "Opponent", name: opponentDisplayName, occupied: true, wager: wagerLabel }
              : { label: isAi ? "GRYND AI" : "Opponent", occupied: false },
          ]}
          onCancel={isWaiting && canCancel ? handleCancel : null}
          cancelLabel="Cancel lobby (refund stake)"
          cancelling={cancelling}
        />
      )}

      <div className="min-h-screen overflow-x-clip bg-gradient-to-br from-[#001933] to-[#000d1a] px-3 pb-24 pt-20 text-white sm:px-6 md:pb-8">
        <NavigationBar currentPath="/casino" />

        <div className="mx-auto mt-4 max-w-3xl sm:mt-8 lg:mt-4 lg:max-w-5xl">
          <GameSessionHost
            autoStart={Boolean(match) && !isWaiting && !isFinished && !isCancelled}
            autoStop={isFinished || isCancelled}
            gameLabel="mines-duel"
          >
            {titleNode}
            {/* Desktop puts the seats, clock, status and controls in a
                right-hand rail BESIDE the board, which is what frees the
                height the square board grows into
                (tests/board-fit-desktop.test.mjs pins this). Below `lg` the
                rail is the same stack it always was: seats, status, controls,
                then the board — so the phone layout keeps its reading order. */}
            <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_17rem] lg:items-start lg:gap-6">
              <div className="lg:order-2 lg:col-start-2 lg:row-start-1 lg:flex lg:flex-col lg:gap-3">
                {scoreboardNode}
                {infoNode}
                <div className="mt-3 lg:mt-0">{renderStatus()}</div>
                {resignNode || pickToggleNode || emoteNode ? (
                  <div className="flex flex-col items-center gap-3 lg:mt-0">
                    {pickToggleNode}
                    {emoteNode}
                    {resignNode}
                  </div>
                ) : null}
              </div>
              <div className="lg:order-1 lg:col-start-1 lg:row-start-1">
                {boardNode}
                {legendNode}
                {messagesNode}
                {errorNode}
                {cancelNode}
              </div>
            </div>
            {renderResult()}
          </GameSessionHost>

          <Footer />
        </div>

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
