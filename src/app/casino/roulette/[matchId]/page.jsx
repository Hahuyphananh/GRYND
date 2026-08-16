"use client";

// src/app/casino/roulette/[matchId]/page.jsx
//
// PvP match view built directly on top of the existing solo roulette page
// (canvas drawing, betting grid, spin animation are all preserved from
// /casino/roulette/page.jsx — original solo roulette is gone; solo roulette
// API surface at /api/roulette/save-game untouched as a courtesy to the
// historical data path). The matchmaking lobby lives at the parent route
// /casino/roulette (page.jsx).
//
// What this file adds on top of the preserved solo-roulette logic:
//   • Server-driven spin animation: instead of animating immediately on
//     POST, the wheel's `spinWheel()` Promise runs when polling reveals
//     a fresh `match.lastSpinResultIndex` from the server.
//   • Score panel: both players' round-win counts (color-coded).
//   • Persistent match "points" balance (Prompt 2 semantics):
//     `playerOnePoints`/`playerTwoPoints` drift round-to-round based on
//     (payout − total_bet); never reset between rounds.
//   • Opponent bet-status indicator ("" / "…") + deadline countdown.
//   • "Lock in bets" submission instead of solo "Spin".
//   • Cancel & refund (creator, only in `waiting` state).
//   • Round-just-resolved banner + match-finished confetti + claim banner.
//
// All state is server-authoritative. The client never computes winners —
// it just renders polled state.

import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
  use,
} from "react";
import { useRouter } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import { motion } from "framer-motion";
import confetti from "canvas-confetti";
import { usePostHog } from "posthog-js/react";
import NavigationBar from "../../../../components/navigation-bar";
import ReportModal from "../../../../components/ReportModal";
import { useSocket } from "../../../../context/SocketProvider";
import {
  ROULETTE_NUMBERS,
  RED_NUMBERS,
  COLORS,
  CHIP_VALUES,
} from "../../../../lib/rouletteConfig";
import {
  MATCH_STATUS,
  STARTING_POINTS,
  sumBetAmounts,
} from "../../../../lib/roulette-pvp/constants";
import {
  ROULETTE_PVP_LOBBY_ROOM,
  ROULETTE_PVP_MATCH_UPDATED,
  roulettePvpMatchRoom,
} from "../../../../lib/roulette-pvp/rooms";
import {
  RouletteWheelIcon,
  CoinIcon,
  BoltIcon,
  ClockIcon,
  TrophyIcon,
  SkullIcon,
  HandshakeIcon,
  BookIcon,
  CheckIcon,
  ChevronUpIcon,
  ChevronDownIcon,
  LoadingDotsIcon,
  TargetIcon,
  AlertIcon,
} from "../../../../components/roulette-pvp/RouletteIcons";
import { IconFlag } from "@tabler/icons-react";

const POLL_INTERVAL_MS = 1500;

// ── Next.js 16 dynamic-route params arrived async (Promise). ──────────
// In Next.js 15+/16 the `params` prop on a dynamic-route page is a
// Promise; accessing `params.matchId` synchronously yields a Promise
// value, and `Number(promise)` evaluates to `NaN`. Without unwrapping
// it here, `fetchMatchId === NaN`, `matchId` inside `fetchStatus` is not
// finite, the function returns early *without* calling setLoading,
// and both players get stuck on the "Loading match…" page forever.
// `use()` suspends the component until the route params resolve so the
// final returned value is a plain object with `matchId` already as a
// real string. The grandparent `<Suspense>` boundary provided by the
// route segment (Next.js default behaviour) covers the brief suspend.

const ROUND_STATUS_LABELS = {
  waiting: "Waiting for opponent",
  ready: "Match starting…",
  round_1: "Round 1",
  round_2: "Round 2",
  round_3: "Round 3",
  sudden_death: "Sudden Death",
  finished: "Match finished",
  cancelled: "Cancelled",
};

const BETTABLE = new Set([
  MATCH_STATUS.ROUND_1,
  MATCH_STATUS.ROUND_2,
  MATCH_STATUS.ROUND_3,
  MATCH_STATUS.SUDDEN_DEATH,
]);

// ─── Canvas constants (preserved verbatim from solo roulette) ──────────
const CANVAS_SIZE = 420;
const WHEEL_RADIUS = CANVAS_SIZE / 2;
const BALL_RADIUS = 7;
const BALL_ORBIT_RADIUS = WHEEL_RADIUS - 24;
const SEGMENT_ANGLE = (2 * Math.PI) / ROULETTE_NUMBERS.length;
const POINTER_ANGLE = -Math.PI / 2;
const POINTER_RADIUS = BALL_ORBIT_RADIUS - 28;

const isRedNum = (num) => RED_NUMBERS.includes(num);
const pocketColor = (num) => {
  if (num === 0) return COLORS.green;
  return isRedNum(num) ? COLORS.red : COLORS.black;
};
const lastNumColor = (num) => {
  if (num === 0) return "bg-[#0d5e2e] text-white";
  return isRedNum(num)
    ? "bg-[#c0392b] text-white"
    : "bg-[#1a1a2e] text-[#FFFF33]";
};

// Reusable swatch + label for an arbitrary bet key. Mirrors the
// radar-pocket / betting-zone styling so the side panel reads at a
// glance: red/black/green chips for colours, numeric chips for singles,
// a generic dark pill for the dozens / parity ranges.
function formatBetDisplay(bet) {
  const k = String(bet);
  const num = Number(bet);
  if (Number.isFinite(num)) {
    if (num === 0)
      return { label: "0", swatch: "bg-[#0d5e2e] text-white" };
    if (RED_NUMBERS.includes(num))
      return { label: String(num), swatch: "bg-[#c0392b] text-white" };
    return { label: String(num), swatch: "bg-[#1a1a2e] text-[#FFFF33]" };
  }
  const map = {
    red: { label: "Red", swatch: "bg-[#c0392b] text-white" },
    black: { label: "Black", swatch: "bg-[#1a1a2e] text-[#FFFF33]" },
    green: { label: "Green", swatch: "bg-[#0d5e2e] text-white" },
    even: { label: "Even", swatch: "bg-[#102542] text-white" },
    odd: { label: "Odd", swatch: "bg-[#102542] text-white" },
    "1-12": { label: "1–12", swatch: "bg-[#102542] text-white" },
    "13-24": { label: "13–24", swatch: "bg-[#102542] text-white" },
    "25-36": { label: "25–36", swatch: "bg-[#102542] text-white" },
    "1-18": { label: "1–18", swatch: "bg-[#102542] text-white" },
    "19-36": { label: "19–36", swatch: "bg-[#102542] text-white" },
  };
  return (
    map[k] || { label: k, swatch: "bg-[#102542] text-white" }
  );
}

// Side-panel that lists each player's locked-in bet targets plus the
// wager amount. Renders while either player has submitted AND the
// match is in an active state (i.e. between submission and the next
// round's betting window). Pulls from `displayMyBets` /
// `displayOppBets` so it works during the spin animation too (those
// memos fall back to the just-resolved round's `player1Bets` /
// `player2Bets` snapshot when the server has cleared the live row).
function LockedInBetsPanel({ displayMyBets, displayOppBets, spinning }) {
  const renderColumn = (bets, accent) => {
    const entries = Object.entries(bets || {}).filter(
      ([, v]) => Number(v) > 0,
    );
    if (entries.length === 0) {
      // Distinguish "no bets placed yet" (panel won't render here —
      // its visibility gate requires at least one seat with entries)
      // from "locked in with zero wager", which is the only path
      // that reaches this branch.
      return (
        <div className="text-xs text-white/45 italic">
          No bets placed
          <span className="ml-1 inline-flex items-center gap-0.5 text-green-300/80 not-italic">
            <CheckIcon className="w-3 h-3" title="Locked in" /> locked
          </span>
        </div>
      );
    }
    const total = entries.reduce(
      (acc, [, v]) => acc + (Number(v) || 0),
      0,
    );
    const baseText = accent === "yellow" ? "text-yellow-300" : "text-cyan-300";
    const totalText =
      accent === "yellow" ? "text-yellow-200" : "text-cyan-200";
    return (
      <>
        <ul className="space-y-1">
          {entries.map(([k, v]) => {
            const { label, swatch } = formatBetDisplay(k);
            return (
              <li
                key={String(k)}
                className="flex items-center justify-between gap-2 text-xs"
              >
                <span
                  className={`inline-flex items-center justify-center min-w-[28px] h-7 px-2 rounded-md text-[11px] font-bold border border-white/10 ${swatch}`}
                >
                  {label}
                </span>
                <span className={`font-bold tabular-nums ${baseText}`}>
                  {Number(v)} pts
                </span>
              </li>
            );
          })}
        </ul>
        <div className="mt-2 pt-1.5 border-t border-white/10 text-[10px] flex items-center justify-between">
          <span className="text-white/45">Total</span>
          <span className={`font-bold tabular-nums ${totalText}`}>
            {total} pts
          </span>
        </div>
      </>
    );
  };
  return (
    <div className="w-full bg-[#001933] border border-purple-400/30 rounded-xl p-3 text-sm">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[11px] uppercase tracking-widest text-white/55 inline-flex items-center gap-1.5">
          <TargetIcon
            className="w-3.5 h-3.5 text-purple-200"
            title="Locked bets"
          />
          <span>Locked-In Bets</span>
        </span>
        <span className="text-[10px] text-white/35">
          {spinning ? "Spin in progress" : "Both locked in"}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-yellow-200 mb-1.5">
            You
          </div>
          {renderColumn(displayMyBets, "yellow")}
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-cyan-200 mb-1.5">
            Opp
          </div>
          {renderColumn(displayOppBets, "cyan")}
        </div>
      </div>
    </div>
  );
}

export default function RoulettePvpGamePage({ params }) {
  // Unwrap params Promise (Next.js 15+/16 async dynamic API). We
  // memoize a stable Promise wrapping the raw `params` prop so `use()`
  // is called unconditionally on every render — this satisfies the
  // React rules-of-hooks (no conditional `use(...)` per render). When
  // `params` is itself a thenable, `Promise.resolve(p)` flattens to
  // the existing promise; when it's a plain object (older Next.js
  // versions), we wrap it ourselves so `use()` still receives a
  // thenable. Same pattern as `src/app/casino/precision/game/
  // [matchId]/page.tsx` (which types it as `Promise<{...}>` directly).
  const paramsPromise = useMemo(
    () => Promise.resolve(params),
    [params],
  );
  const resolvedParams = use(paramsPromise);
  const rawMatchId =
    resolvedParams && typeof resolvedParams === "object"
      ? resolvedParams.matchId
      : undefined;
  // Defensive fallback for malformed URLs. `Number.isFinite` rejects
  // `NaN` (which is exactly what `Number(undefined)` or
  // `Number("not-a-number")` produces) so this guards both the async
  // and the malformed-URL cases alike.
  const numericMatchId = Number(rawMatchId);
  const matchId = Number.isFinite(numericMatchId) ? numericMatchId : null;
  const router = useRouter();
  const { user, isSignedIn, isLoaded } = useUser();
  const { socket } = useSocket();
  const posthog = usePostHog();

  // ── Wheel / canvas state (preserved from solo roulette) ───────
  const [betAmount, setBetAmount] = useState(10);
  const [spinning, setSpinning] = useState(false); // ≈ wheel is currently animating
  const [error, setError] = useState(null);
  const [bets, setBets] = useState({}); // staged bets for current round
  const [showRules, setShowRules] = useState(false);
  const [winningNumber, setWinningNumber] = useState(null);
  const [newChipKeys, setNewChipKeys] = useState([]);

  // ── PvP overlays (replaces solo `stats` / `autoBet` / hot-numbers strip) ──
  const [match, setMatch] = useState(null);
  const [rounds, setRounds] = useState([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [timeLeft, setTimeLeft] = useState(null);
  const [roundResultBanner, setRoundResultBanner] = useState(null);
  const [matchEndedBanner, setMatchEndedBanner] = useState(null);
  // Report modal — flags the human opponent for moderation.
  const [showReportModal, setShowReportModal] = useState(false);

  const canvasRef = useRef(null);
  const betsRef = useRef(bets);
  useEffect(() => {
    betsRef.current = bets;
  }, [bets]);

  // Refs to keep overlapping closures stable. `player1IdRef` is used
  // inside fetchStatus to determine which side "you" is without making
  // the callback depend on `match?.player1Id` (which would invalidate
  // the polling interval on every status update).
  const player1IdRef = useRef(null);
  useEffect(() => {
    player1IdRef.current = match?.player1Id ?? null;
  }, [match?.player1Id]);
  const matchEndedBannerRef = useRef(null);
  useEffect(() => {
    matchEndedBannerRef.current = matchEndedBanner;
  }, [matchEndedBanner]);
  const lastRoundCountRef = useRef(null);
  const bannerTimerRef = useRef(null);
  // Last server-stamped spin-result fingerprint we animated on. Held
  // in a ref (NOT useState) so updating it inside the spin effect
  // doesn't re-run the effect with `lastAnimatedSpinId` in its dep
  // list — the update would race with the in-flight spinWheel IIFE,
  // fire its cleanup, and `cancelled = true` would skip the pending
  // banner reveal AND leave `spinning` stuck `true` forever. Bug
  // caught at code review.
  //
  // The fingerprint is `${rounds.length}-${lastSpinResultIndex}`
  // (computed as `spinId` further down). Using the round count + spin
  // index makes the sentinel unique across every round resolution, so
  // two consecutive rounds landing on the same wheel pocket still
  // re-trigger the animation (the bare `lastSpinResultIndex` would
  // match the previous spin and silently skip the new one).
  const lastAnimatedSpinIdRef = useRef(null);
  // BUG-FIX ("round banner appears and disappears while wheel is
  // still spinning"): the round-result popup used to fire
  // immediately on `poll detects rounds.length++`, well before
  // the 4.5 s canvas spin animation completed on this client's
  // machine — so a player could click Lock in, see the banner flash
  // for 2.2 s while the wheel was mid-spin, and then the spin
  // settled with no banner at all. We now stash the pending banner
  // payload in this ref inside `fetchStatus` and only mount it via
  // `setRoundResultBanner(...)` after `spinWheel(...)` resolves, so
  // the popup and the wheel settle at the same time.
  const pendingBannerRef = useRef(null);
  // Mirror `winningNumber` into a ref so `drawWheel` — and therefore
  // `spinWheel` — can read its current value WITHOUT listing
  // `winningNumber` in the `useCallback` dependency arrays.
  // BUG-FIX ("bet panel permanently locked after round 1"):
  // Previously `winningNumber` was in `drawWheel`'s deps, and
  // `drawWheel` was in `spinWheel`'s deps. The spin-anim effect's
  // dep list `[spinId, lastSpinResult, spinWheel]` therefore saw a
  // fresh `spinWheel` reference the moment the effect itself called
  // `setWinningNumber(...)` — the effect re-fired, its CLEANUP ran
  // and set `cancelled = true` on the previous run, and the
  // 4.5 s `spinWheel` Promise from that first run later resolved
  // with NO `setSpinning(false)` call (because `cancelled === true`).
  // Net result: `spinning` was stuck `true` forever, which spends
  // `myBetsAreLocked` permanently `true`, which locks the bet panel
  // after round 1 (and every subsequent round) even though the
  // server already cleared `player1Bets` / `player2Bets` to null.
  // Decoupling `winningNumber` from `drawWheel`'s identity via a
  // ref breaks the chain — re-renders triggered by
  // `setWinningNumber(...)` no longer recreate `drawWheel`,
  // `spinWheel`, or the effect's cleanup scheduler.
  const winningNumberRef = useRef(null);
  // Last server-stamped spin-result fingerprint we saw. Used by the
  // round-transition-reset effect below to detect "a new round just
  // began" (server cleared both players' bets but the same spin
  // index landed — i.e., the previous round settled and the next
  // one is fresh). Fingerprinted for the same repeat-spin reason as
  // `lastAnimatedSpinIdRef` above.
  const lastSeenSpinIdRef = useRef(null);

  // ── Polling match status (server-authoritative) ────────────────
  const fetchStatus = useCallback(async () => {
    // Defensive: matchId may legitimately be null if the dynamic route
    // delivered us an unparseable segment (e.g. someone pasted a
    // non-numeric link, or the Next.js 16 async params Promise somehow
    // resolved to an unexpected shape). Setting loading=false here flips
    // the UI out of the eternal "Loading match…" view and lets the
    // "Match not found" panel render instead. Pre-fix, we returned
    // early here without setLoading(false), which left both players
    // stranded on the loading spinner as soon as the URL was off in
    // any way that produced a non-finite matchId.
    if (matchId === null) {
      setError("Invalid match link.");
      setLoading(false);
      return;
    }
    try {
      const res = await fetch(`/api/roulette-pvp/match/${matchId}`, {
        cache: "no-store",
      });
      const data = await res.json();
      if (!res.ok || !data?.success) {
        // Critical: any non-2xx response or `success: false` payload
        // must NOT strand the UI on the loading spinner — pre-fix the
        // page rendered "Loading match…" forever because setLoading
        // was only called on the success path. Now we flip loading
        // off unconditionally so the "Match not found" panel can
        // render with the error message.
        setError(data?.error || "Unable to load match");
        setMatch(null);
        setLoading(false);
        return;
      }
      setError(null);
      setMatch(data.data.match);
      setRounds(data.data.rounds || []);

      // Round-just-resolved banner (count of rounds increased).
      // Stash the banner payload in a ref so the spinWheel effect can
      // pop it once the canvas animation completes — see
      // `pendingBannerRef` for the full reasoning.
      const counted = (data.data.rounds || []).length;
      if (lastRoundCountRef.current === null) {
        lastRoundCountRef.current = counted;
      } else if (counted > lastRoundCountRef.current) {
        const latest = data.data.rounds[data.data.rounds.length - 1];
        const meIsP1 = player1IdRef.current === user?.id;
        const won =
          latest?.roundWinner === (meIsP1 ? "player1" : "player2");
        const drew = !latest?.roundWinner;
        pendingBannerRef.current = {
          roundNumber: latest?.roundNumber,
          winner: won ? "you" : drew ? "draw" : "opponent",
          spinResult: latest?.spinResult,
          p1Net: latest?.player1Net,
          p2Net: latest?.player2Net,
          isSuddenDeath: Boolean(latest?.isSuddenDeath),
        };
        posthog?.capture("roulette_pvp_round_resolved", {
          match_id: matchId,
          round: latest?.roundNumber,
          winner: won ? "you" : drew ? "draw" : "opponent",
          spin_result: latest?.spinResult,
          is_sudden_death: Boolean(latest?.isSuddenDeath),
        });
        lastRoundCountRef.current = counted;
      } else {
        lastRoundCountRef.current = counted;
      }

      // Match-ended confetti + final banner
      if (
        data.data.match?.status === MATCH_STATUS.FINISHED &&
        !matchEndedBannerRef.current
      ) {
      // PROMPT 7 — Mutual elimination / draw handling. A match can
      // finish with no winnerId (both sides wiped out under the new
      // elimination rule, or `result === "draw"` is explicitly set).
      // Distinguish those from a real opponent win; otherwise the
      // banner would falsely tell a player they lost.
      const isDraw =
        !data.data.match.winnerId ||
        data.data.match.result === "draw";
      let endKind;
      if (isDraw) {
        endKind = "draw";
      } else {
        const meWon = data.data.match.winnerId === user?.id;
        endKind = meWon ? "you" : "opponent";
      }
      setMatchEndedBanner(endKind);
      posthog?.capture("roulette_pvp_match_finished", {
        match_id: matchId,
        winner: isDraw ? "draw" : endKind,
        prize_paid: data.data.match.prizePaid,
      });
        if (meWon) {
          confetti({
            particleCount: 80,
            spread: 70,
            origin: { y: 0.6 },
            colors: [COLORS.gold, "#FFD700", "#FFA500"],
          });
        }
      } else if (data.data.match?.status !== MATCH_STATUS.FINISHED) {
        setMatchEndedBanner(null);
      }
      setLoading(false);
    } catch {
      setError("Network error");
      setLoading(false);
    }
  }, [matchId, user?.id, posthog]);

  useEffect(() => {
    return () => {
      if (bannerTimerRef.current) clearTimeout(bannerTimerRef.current);
    };
  }, []);

  // Start polling once signed in. We intentionally bail out before
  // spinning up the polling interval if the matchId is invalid (e.g.
  // Next.js 16 async params resolved to an unexpected shape or the URL
  // is unsalvageable). The fetchStatus guard already sets loading=false
  // on the bad-matchId path so the user sees the "Match not found"
  // panel instead of a perpetual spinner.
  useEffect(() => {
    if (!isLoaded) return;
    if (!isSignedIn) {
      router.push("/sign-in");
      return;
    }
    if (matchId === null) {
      setError("Invalid match link.");
      setLoading(false);
      return;
    }
    fetchStatus();
    const interval = setInterval(fetchStatus, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [isLoaded, isSignedIn, fetchStatus, router, matchId]);

  // Subscribe to socket `lobby:updated` on the per-match room for
  // live fanout (the lobby page emits to this room on create-or-join;
  // the in-match page emits after submitBets success). The realtime
  // server's `room_event` fanout (`socket.to(room).emit`) routes
  // events to OTHER sockets in the room, so this subscription gets
  // every opponent action within socket latency (~50 ms).
  useEffect(() => {
    if (!socket) return;
    const roomId = roulettePvpMatchRoom(matchId);
    const join = () => socket.emit("join_room", { roomId });
    // lib/socket.ts keeps a process-wide socket instance and reuses it
    // across reconnects without firing a fresh `connect` event into
    // React. Without explicitly re-joining on (re)connect, a brief
    // network blip silently drops the per-match subscription until
    // the user hard-navigates back to the page.
    join();
    socket.on("connect", join);
    socket.on("lobby:updated", fetchStatus);
    return () => {
      socket.emit("leave_room", { roomId });
      socket.off("connect", join);
      socket.off("lobby:updated", fetchStatus);
    };
  }, [socket, matchId, fetchStatus]);

  // Round-deadline countdown (replaces userTokens from solo)
  useEffect(() => {
    if (!match?.roundDeadline) {
      setTimeLeft(null);
      return;
    }
    const update = () => {
      const diffMs = new Date(match.roundDeadline).getTime() - Date.now();
      setTimeLeft(Math.max(0, Math.ceil(diffMs / 1000)));
    };
    update();
    const interval = setInterval(update, 500);
    return () => clearInterval(interval);
  }, [match?.roundDeadline]);

  // ── Canvas drawing (verbatim from solo roulette) ───────────────
  const drawWheel = useCallback(
    (angleOffset = 0, ballAngle = null, ballDist = null) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      const size = canvas.width;
      const radius = size / 2;

      ctx.clearRect(0, 0, size, size);

      ctx.save();
      ctx.translate(radius, radius);

      // Dark wood rim
      ctx.beginPath();
      ctx.arc(0, 0, radius, 0, 2 * Math.PI);
      ctx.fillStyle = COLORS.wheelBg;
      ctx.fill();
      ctx.strokeStyle = COLORS.wheelRim;
      ctx.lineWidth = 6;
      ctx.stroke();

      // Inner gold ring
      ctx.beginPath();
      ctx.arc(0, 0, radius - 10, 0, 2 * Math.PI);
      ctx.strokeStyle = COLORS.gold;
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.rotate(angleOffset);

      ROULETTE_NUMBERS.forEach((num, i) => {
        const startAngle = i * SEGMENT_ANGLE;
        const endAngle = startAngle + SEGMENT_ANGLE;

        // Pocket
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.arc(0, 0, radius - 20, startAngle, endAngle);
        ctx.closePath();
        ctx.fillStyle = pocketColor(num);
        ctx.fill();

        // Pocket divider
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.arc(0, 0, radius - 20, endAngle, endAngle);
        ctx.strokeStyle = COLORS.pocketDivider;
        ctx.lineWidth = 0.5;
        ctx.stroke();

        // Number label
        ctx.save();
        ctx.fillStyle = "#fff";
        ctx.font = "bold 11px sans-serif";
        ctx.textAlign = "right";
        ctx.textBaseline = "middle";
        ctx.rotate(startAngle + SEGMENT_ANGLE / 2);
        ctx.fillText(num.toString(), radius - 30, 0);
        ctx.restore();
      });

      ctx.restore();

      // Ball (drawn in world space)
      if (ballAngle !== null && ballDist !== null) {
        ctx.save();
        ctx.translate(radius, radius);
        const bx = Math.cos(ballAngle) * ballDist;
        const by = Math.sin(ballAngle) * ballDist;

        ctx.beginPath();
        ctx.arc(bx, by, BALL_RADIUS + 3, 0, 2 * Math.PI);
        ctx.fillStyle = "rgba(255,255,255,0.25)";
        ctx.fill();

        ctx.beginPath();
        ctx.arc(bx, by, BALL_RADIUS, 0, 2 * Math.PI);
        const ballGrad = ctx.createRadialGradient(
          bx - 2,
          by - 2,
          0,
          bx,
          by,
          BALL_RADIUS,
        );
        ballGrad.addColorStop(0, "#ffffff");
        ballGrad.addColorStop(0.6, "#e0e0e0");
        ballGrad.addColorStop(1, "#a0a0a0");
        ctx.fillStyle = ballGrad;
        ctx.fill();
        ctx.strokeStyle = "#888";
        ctx.lineWidth = 0.5;
        ctx.stroke();

        ctx.restore();
      }

      // Highlight winning number on rim (Prompt 2 enhancement: from
      // the polled `match.lastSpinResult`). Read from the ref so
      // this `useCallback` doesn't have to list `winningNumber` in
      // its dependency array — see `winningNumberRef` for the full
      // reasoning on why that coupling would re-fire the spin-anim
      // effect mid-animation and stick `spinning` at true.
      const winningNumberForDraw = winningNumberRef.current;
      if (
        winningNumberForDraw !== null &&
        winningNumberForDraw !== undefined
      ) {
        const idx = ROULETTE_NUMBERS.indexOf(Number(winningNumberForDraw));
        if (idx >= 0) {
          ctx.save();
          ctx.translate(radius, radius);
          ctx.rotate(angleOffset + idx * SEGMENT_ANGLE + SEGMENT_ANGLE / 2);
          ctx.beginPath();
          ctx.arc(radius - 30, 0, 14, 0, 2 * Math.PI);
          ctx.strokeStyle = COLORS.goldAccent;
          ctx.lineWidth = 2;
          ctx.stroke();
          ctx.restore();
        }
      }

      // Fixed pointer at top
      ctx.save();
      ctx.translate(radius, 0);
      // Shadow
      ctx.beginPath();
      ctx.moveTo(0, 6);
      ctx.lineTo(-12, 28);
      ctx.lineTo(12, 28);
      ctx.closePath();
      ctx.fillStyle = COLORS.goldDark;
      ctx.fill();
      // Main pointer
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(-12, 24);
      ctx.lineTo(12, 24);
      ctx.closePath();
      const grad = ctx.createLinearGradient(0, 0, 0, 24);
      grad.addColorStop(0, COLORS.gold);
      grad.addColorStop(1, COLORS.goldDark);
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.restore();
    },
    // Empty dep array: drawing reads `winningNumber` via the ref
    // above. Listing `winningNumber` here would cause a fresh
    // `drawWheel` reference whenever the winning pocket updates,
    // which would invalidate `spinWheel` and the spin-anim effect's
    // dep list — see `winningNumberRef` for the full reasoning.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Single forward-only sync of `winningNumber` into the ref that
  // `drawWheel` reads. Lives in its own effect (not inline in the
  // render body) so React's render purity rules stay happy, and so
  // an unmount-mid-render can't read a stale ref.
  useEffect(() => {
    winningNumberRef.current = winningNumber;
  }, [winningNumber]);

  useEffect(() => {
    drawWheel();
    const onResize = () => drawWheel();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [drawWheel]);

  // ── Server-driven spin animation (replaces solo's `handleSpin`) ──
  const normAngle = (a) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);

  const spinWheel = useCallback(
    (finalIndex) => {
      return new Promise((resolve) => {
        const fullRotations = 7;
        const duration = 4500;
        const ballOrbitEnd = 0.78;
        const start = performance.now();

        const winningCenter =
          finalIndex * SEGMENT_ANGLE + SEGMENT_ANGLE / 2;
        const endRotation = normAngle(POINTER_ANGLE - winningCenter);
        const startRotation = Math.random() * (2 * Math.PI);

        let delta = endRotation - startRotation;
        if (delta <= 0) delta += 2 * Math.PI;
        delta += fullRotations * 2 * Math.PI;
        const finalAngle = startRotation + delta;
        const ballStartAngle = Math.random() * (2 * Math.PI);

        const animateStep = (now) => {
          const elapsed = now - start;
          const progress = Math.min(elapsed / duration, 1);
          const wheelEased = 1 - Math.pow(1 - progress, 3);
          const wheelAngle = startRotation + wheelEased * delta;

          let ballAngle, ballDist;
          if (progress < ballOrbitEnd) {
            const orbitProgress = progress / ballOrbitEnd;
            const orbitEased = 1 - Math.pow(1 - orbitProgress, 2);
            ballAngle =
              ballStartAngle - orbitEased * fullRotations * 2 * Math.PI;
            ballDist = BALL_ORBIT_RADIUS;
          } else {
            const dropProgress = (progress - ballOrbitEnd) / (1 - ballOrbitEnd);
            const dropEased = 1 - Math.pow(1 - dropProgress, 2);
            ballDist =
              BALL_ORBIT_RADIUS -
              dropEased * (BALL_ORBIT_RADIUS - POINTER_RADIUS);
            const wobbleDecay = Math.pow(1 - dropProgress, 3);
            const wobble =
              Math.sin(dropProgress * Math.PI * 3) * wobbleDecay * 0.05;
            ballAngle = POINTER_ANGLE + wobble;
          }

          drawWheel(wheelAngle, ballAngle, ballDist);

          if (progress < 1) {
            requestAnimationFrame(animateStep);
          } else {
            drawWheel(finalAngle, POINTER_ANGLE, POINTER_RADIUS);
            resolve();
          }
        };
        requestAnimationFrame(animateStep);
      });
    },
    [drawWheel],
  );

  // When the server reveals a new spin result, kick off the wheel
  // animation. `lastAnimatedSpinIdRef` (a ref, not state) guards
  // against re-animating on identical re-renders without re-running
  // this effect and triggering a spurious cleanup mid-animation.
  // See `lastAnimatedSpinIdRef` for the full reasoning on why this
  // value must NOT be React state.
  //
  // BUG-FIX ("wheel never re-animates when the same number lands twice
  // in a row"): The sentinel used to be `lastSpinResultIndex` alone,
  // but `spinResultIndex` is the position of the winning pocket on
  // the wheel (0–36) and is NOT unique across rounds — two rounds in
  // a row can both land on the red-12 pocket. When that happened,
  // the second resolution's identical `lastSpinResultIndex` matched
  // the sentinel, the wheel skipped its animation, the round-just-
  // resolved banner never surfaced, and the staged `bets` reset
  // effect below silently skipped too. The fix: fingerprint each
  // spin resolution with `${rounds.length}-${lastSpinResultIndex}`
  // — `rounds.length` increments by exactly 1 every resolution, so
  // the fingerprint is globally unique across the match.
  const spinId =
    match?.lastSpinResultIndex == null
      ? null
      : `${(rounds || []).length}-${match.lastSpinResultIndex}`;
  useEffect(() => {
    if (spinId === null) {
      return;
    }
    if (spinId === lastAnimatedSpinIdRef.current) {
      return;
    }
    setWinningNumber(match.lastSpinResult ?? null);
    setSpinning(true);
    lastAnimatedSpinIdRef.current = spinId;
    let cancelled = false;
    (async () => {
      try {
        await spinWheel(match.lastSpinResultIndex);
        // Wheel settled — if a round banner was queued while the
        // animation was playing, surface it now so the popup lands
        // at the same moment the player sees the final ball pocket.
        if (!cancelled && pendingBannerRef.current) {
          setRoundResultBanner(pendingBannerRef.current);
          if (bannerTimerRef.current) clearTimeout(bannerTimerRef.current);
          bannerTimerRef.current = setTimeout(
            () => setRoundResultBanner(null),
            3000,
          );
          pendingBannerRef.current = null;
        }
      } finally {
        if (!cancelled) setSpinning(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [spinId, match?.lastSpinResult, spinWheel]);

  // Clear wheel highlight after a delay (preserved from solo roulette)
  useEffect(() => {
    if (winningNumber !== null) {
      const timer = setTimeout(() => setWinningNumber(null), 4000);
      return () => clearTimeout(timer);
    }
  }, [winningNumber]);

  // BUG-FIX ("points/effective balance stale between rounds") ─────
  // Previously the locally-staged `bets` state carried the previous
  // round's chips forward into the next round, so the chip selector's
  // "X pts remaining" calculation would silently deduct those stale
  // chips against the new round's freshly-credited balance. We now
  // wipe the local `bets` whenever a fresh `spinId` fingerprint
  // surfaces — which, because `spinId` includes `rounds.length`,
  // fires exactly once per round resolution. The
  // `lastSeenSpinIdRef` sentinel suppresses re-runs we already
  // processed, so this effect is idempotent across re-renders.
  //
  // We don't need the `!match?.player1Bets && !match?.player2Bets`
  // guard from the previous revision: those columns are guaranteed
  // to be null at the moment of `spinId` change because the server
  // clears them in `resolveRound` (which is the same code path that
  // advances `rounds.length` and stamps `lastSpinResultIndex`).
  useEffect(() => {
    if (spinId === null) return;
    if (spinId === lastSeenSpinIdRef.current) return;
    lastSeenSpinIdRef.current = spinId;
    setBets({});
  }, [spinId]);

  // ── Bet placement (PvP-aware: only allowed when match is bettable
  //    AND you haven't already submitted your bets for this round) ───
  const isPlayer1 = match?.player1Id === user?.id;
  // The opponent is whoever occupies the seat we don't hold. Only
  // reportable once a real opponent has joined (player2Id set).
  const opponentClerkId = isPlayer1
    ? match?.player2Id ?? null
    : match?.player1Id ?? null;
  const mySubmittedBets = isPlayer1 ? match?.player1Bets : match?.player2Bets;
  const opponentSubmittedBets = isPlayer1
    ? match?.player2Bets
    : match?.player1Bets;
  const myBetsAreLocked =
    Boolean(mySubmittedBets) ||
    match?.status === MATCH_STATUS.FINISHED ||
    match?.status === MATCH_STATUS.CANCELLED ||
    match?.status === MATCH_STATUS.WAITING ||
    match?.status === MATCH_STATUS.READY ||
    !BETTABLE.has(match?.status) ||
    spinning;

  const myMatchPoints = Number(
    isPlayer1 ? match?.playerOnePoints : match?.playerTwoPoints,
  );
  const oppMatchPoints = Number(
    isPlayer1 ? match?.playerTwoPoints : match?.playerOnePoints,
  );

  // ── Spin-animation display masking ───────────────────────────────
  // The server is authoritative. `submitBets` runs `resolveRound`
  // immediately when the *second* player locks in, so by the time
  // the canvas 4.5 s spin animation starts on either client, the
  // server-side `match.playerOnePoints` / `playerTwoPoints` ALREADY
  // include the new payout and `match.player1Bets` /
  // `match.player2Bets` are ALREADY null (cleared by `resolveRound`
  // for the next round). Without intervention this reveals the
  // result before the wheel settles and wipes the locked-in chip
  // badges the moment the spin starts — which is why one screen
  // appeared to "show the bets deducted" while the other didn't, and
  // why the big-number display "jumps to the new balance" before the
  // ball visibly lands.
  //
  // The masking below freezes the displayed values at the post-lock
  // balance for the duration of `spinning`, and reads the locked-in
  // bets from the round's history row (`rounds[].player{N}Bets`) so
  // the "" check-marks, chip badges, and the new reveal panel stay
  // visible through the animation. The moment `spinning` flips to
  // false, the real server-balance surfaces in lockstep with the
  // round-result banner so the player sees the points change at the
  // same moment the ball visibly settles in its pocket.
  //
  // BUG-FIX ("spin-result lookup returns wrong round for repeats"):
  // Previously this `useMemo` looked up the round whose
  // `spinResultIndex` matched `match.lastSpinResultIndex`, but
  // `spinResultIndex` is the position of the winning number on the
  // wheel (0–36) and IS NOT unique across rounds — e.g., two rounds
  // in a row can both land on red-12. The `.find()` returned the
  // FIRST round with that index, so on any repeat-spin the panel
  // resurfaced the OLD round's payouts/balance delta instead of the
  // just-resolved round's. The fix: trust the INSERT order instead
  // and use the last entry of the history array, which `fetchMatch`
  // returns ordered by `roundNumber ASC` (so the last entry is the
  // most recently appended round).
  const latestResolvedRound = useMemo(() => {
    if (!rounds || rounds.length === 0) return null;
    return rounds[rounds.length - 1];
  }, [rounds]);

  const resolvedMyPayout = useMemo(() => {
    if (!latestResolvedRound) return 0;
    return (
      Number(
        isPlayer1
          ? latestResolvedRound.player1Payout
          : latestResolvedRound.player2Payout,
      ) || 0
    );
  }, [latestResolvedRound, isPlayer1]);
  const resolvedOppPayout = useMemo(() => {
    if (!latestResolvedRound) return 0;
    return (
      Number(
        isPlayer1
          ? latestResolvedRound.player2Payout
          : latestResolvedRound.player1Payout,
      ) || 0
    );
  }, [latestResolvedRound, isPlayer1]);

  // Locked-in bets for display. The server clears `player1Bets` /
  // `player2Bets` to null the moment the round resolves — and for
  // the player who triggered resolution, their `submitBets` response
  // arrives AFTER the resolve, so their own UI also sees nulls. We
  // therefore fall back to the just-resolved round's snapshot while
  // the wheel is still animating so the chip badges and the new
  // reveal panel stay populated throughout the spin.
  //
  // Empty `{}` submissions are valid (the server's `validateBets`
  // accepts a zero-wager lock-in), so the truthy check is
  // `mySubmittedBets != null` rather than `Object.keys(...).length
  // > 0` — a player who locks in with zero chips is still "locked
  // in" and the round-bet-status pill should show green  instead
  // of the spinner used while a player hasn't submitted at all.
  const displayMyBets = useMemo(() => {
    if (mySubmittedBets != null) {
      return mySubmittedBets;
    }
    if (spinning && latestResolvedRound) {
      return isPlayer1
        ? latestResolvedRound.player1Bets
        : latestResolvedRound.player2Bets;
    }
    return null;
  }, [mySubmittedBets, spinning, latestResolvedRound, isPlayer1]);
  const displayOppBets = useMemo(() => {
    if (opponentSubmittedBets != null) {
      return opponentSubmittedBets;
    }
    if (spinning && latestResolvedRound) {
      return isPlayer1
        ? latestResolvedRound.player2Bets
        : latestResolvedRound.player1Bets;
    }
    return null;
  }, [opponentSubmittedBets, spinning, latestResolvedRound, isPlayer1]);

  // Symmetric display masking for the OPPONENT column. The server's
  // post-resolve match state already includes the opponent's payout
  // in `oppMatchPoints`; until the wheel animation completes the
  // player should see the opponent's POST-LOCK balance too, then
  // the resolve bumps up in sync with the round-result banner. Same
  // gate as `myEffectivePoints` so the two columns balance-update in
  // lockstep when the spin settles.
  const oppEffectivePoints = useMemo(() => {
    const safe =
      Number.isFinite(Number(oppMatchPoints)) ? Number(oppMatchPoints) : 0;
    if (spinning && latestResolvedRound) {
      return Math.max(0, safe - (resolvedOppPayout || 0));
    }
    return Math.max(0, safe);
  }, [oppMatchPoints, spinning, latestResolvedRound, resolvedOppPayout]);

  const myTotalBet = useMemo(
    () =>
      Object.values(bets || {}).reduce((acc, v) => {
        const n = Number(v);
        return Number.isFinite(n) && n > 0 ? acc + n : acc;
      }, 0),
    [bets],
  );
  const pointsRemaining = Math.max(
    0,
    (Number.isFinite(myMatchPoints) ? myMatchPoints : 0) - myTotalBet,
  );

  // BUG-FIX ("points not updating when betting") ──────────────────
  // `myCommittedBet` is the sum of the player's server-stored bets
  // (i.e. what they actually locked in). Used by the
  // −/locked/staged chip-usage badge below the points display so
  // the player can see HOW MUCH they're committed to. The actual
  // points balance now comes from the server directly (commit-time
  // deduction lives inside `submitBets`, not in `resolveRound`),
  // so we no longer subtract `myCommittedBet` from `myMatchPoints`
  // here — that would double-deduct against the server-side
  // commitment.
  const myCommittedBet = useMemo(
    // Use `displayMyBets` instead of `mySubmittedBets` so the
    // "−X locked" badge keeps showing the wager after the server
    // clears `player{N}Bets` (i.e. while the wheel is animating) and
    // we fall back to the round-history snapshot.
    () => sumBetAmounts(displayMyBets),
    [displayMyBets],
  );
  // Effective current points: server-authoritative once locked-in
  // (the wager was deducted at commit time inside `submitBets`,
  // so `myMatchPoints` already reflects it); optimistic-projection
  // while staging chips (server hasn't been touched yet).
  //
  // During the spin animation the server has already credited the
  // new round's payout to `match.playerOnePoints` /
  // `match.playerTwoPoints`. Subtracting that payout here freezes
  // the displayed balance at the post-lock value, preserved until
  // the wheel animation settles and the round-result banner reveals
  // the outcome. The "real" new balance is then surfaced on the
  // next render in perfect sync with `spinning → false`.
  const myEffectivePoints = useMemo(() => {
    const base = myBetsAreLocked
      ? Math.max(0, Number.isFinite(myMatchPoints) ? myMatchPoints : 0)
      : Math.max(
          0,
          (Number.isFinite(myMatchPoints) ? myMatchPoints : 0) - myTotalBet,
        );
    if (spinning && latestResolvedRound) {
      return Math.max(0, base - (resolvedMyPayout || 0));
    }
    return base;
  }, [
    myBetsAreLocked,
    myMatchPoints,
    myTotalBet,
    spinning,
    latestResolvedRound,
    resolvedMyPayout,
  ]);

  const placeBet = (target) => {
    if (myBetsAreLocked) return;
    const amount = betAmount < 1 ? 1 : betAmount;
    if (betAmount < 1) setBetAmount(1);
    setBets((prev) => {
      const updated = {
        ...prev,
        [target]: (prev[target] || 0) + amount,
      };
      return updated;
    });
    const key = `${target}-${Date.now()}`;
    setNewChipKeys((prev) => [...prev, key]);
    setTimeout(
      () => setNewChipKeys((prev) => prev.filter((k) => k !== key)),
      350,
    );
  };

  const resetBets = () => {
    if (myBetsAreLocked) return;
    setBets({});
    setError(null);
  };

  // ── Submit bets for current round (replaces solo `handleSpin`) ─
  const submitBets = async () => {
    if (!match) return;
    if (myBetsAreLocked) return;
    const currentBets = betsRef.current;
    const total = Object.values(currentBets).reduce(
      (a, b) => a + (Number(b) || 0),
      0,
    );
    if (total > myMatchPoints + 0.0001) {
      setError(
        `Total bets (${total.toFixed(2)}) exceed your current match points (${myMatchPoints.toFixed(2)})`,
      );
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/roulette-pvp/match/${matchId}/bet`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ bets: currentBets }),
        },
      );
      const data = await res.json();
      if (!res.ok || !data?.success) {
        setError(data?.error || "Unable to submit bets");
        return;
      }
      // Socket-driven live update: server-side submitBets may have
      // already resolved the round if the opponent had prior bets.
      // Emit room_event to the per-match room so the opponent sees
      // the resolution inside a single socket round trip rather than
      // waiting up to 1.5 s for the next poll. We also kick a local
      // re-poll so this player's UI is in sync (subsequent players
      // joining the room also see this via their own subscription).
      socket?.emit("room_event", {
        roomId: roulettePvpMatchRoom(matchId),
        event: ROULETTE_PVP_MATCH_UPDATED,
      });
      await fetchStatus();
    } catch {
      setError("Network error while submitting bets");
    } finally {
      setSubmitting(false);
    }
  };

  const cancelWaiting = async () => {
    setCancelling(true);
    try {
      const res = await fetch(
        `/api/roulette-pvp/match/${matchId}/cancel`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        },
      );
      const data = await res.json();
      if (data?.success) {
        // Cancelling affects both the open-lobbies list AND any
        // opponent already sitting on the match view (their match
        // row transitions to "cancelled" with the stake refunded).
        socket?.emit("room_event", {
          roomId: ROULETTE_PVP_LOBBY_ROOM,
          event: ROULETTE_PVP_MATCH_UPDATED,
        });
        socket?.emit("room_event", {
          roomId: roulettePvpMatchRoom(matchId),
          event: ROULETTE_PVP_MATCH_UPDATED,
        });
        router.push("/casino/roulette");
      } else {
        setError(data?.error || "Unable to cancel");
      }
    } finally {
      setCancelling(false);
    }
  };

  const leaveOrContinue = () => router.push("/casino/roulette");

  // ── Number grid + betting zones (preserved from solo roulette) ──
  const renderNumberGrid = () => {
    const rows = [[], [], []];
    for (let i = 1; i <= 36; i++) {
      rows[(i - 1) % 3].push(i);
    }
    // While bets are locked-in (either still on the server OR
    // pulled from the just-resolved round's snapshot via
    // `displayMyBets`), show the locked-in layout on the chips so
    // both players see the same bets through the spin animation.
    const displayBets = myBetsAreLocked ? displayMyBets || {} : bets;

    return (
      <div className="w-full overflow-x-auto pb-2">
        <div className="min-w-[320px] space-y-1">
          {/* Zero row */}
          <div className="flex justify-center mb-1">
            <button
              onClick={() => placeBet(0)}
              disabled={myBetsAreLocked}
              className={`relative w-12 h-12 sm:w-14 sm:h-14 flex items-center justify-center rounded-md border border-[#FFFF33]/30 text-sm font-bold transition-all duration-150
                bg-[#0d5e2e] text-white shadow-[0_0_12px_rgba(13,94,46,0.5)]
                ${
                  myBetsAreLocked
                    ? "opacity-70 cursor-not-allowed"
                    : "hover:scale-105 hover:brightness-110 active:scale-95"
                }
                ${winningNumber === 0 ? "ring-3 ring-[#FFFF33] animate-pulse shadow-[0_0_25px_rgba(255,255,51,0.8)]" : ""}
              `}
            >
              0
              {displayBets[0] && (
                <span className={`absolute -top-2 -right-2 bg-[#FFFF33]/90 text-black text-[10px] sm:text-xs font-bold px-1.5 py-0.5 rounded-full shadow-[0_0_8px_rgba(255,255,51,0.5)] ${newChipKeys.some((k) => k.startsWith("0-")) ? "animate-bet-chip" : ""}`}>
                  {displayBets[0]}
                </span>
              )}
            </button>
          </div>

          {rows.map((row, idx) => (
            <div key={idx} className="grid grid-cols-12 gap-1 justify-center">
              {row.map((num) => {
                const red = isRedNum(num);
                const isWinner = winningNumber === num;

                return (
                  <button
                    key={num}
                    onClick={() => placeBet(num)}
                    disabled={myBetsAreLocked}
                    className={`relative w-full aspect-square flex items-center justify-center rounded-md border text-[11px] sm:text-sm font-medium transition-all duration-150
                      ${
                        red
                          ? "bg-[#c0392b] border-red-400/40 text-white shadow-[0_0_10px_rgba(192,57,43,0.4)]"
                          : "bg-[#1a1a2e] border-[#FFFF33]/30 text-[#FFFF33] shadow-[0_0_8px_rgba(255,255,51,0.15)]"
                      }
                      ${
                        myBetsAreLocked
                          ? "opacity-70 cursor-not-allowed"
                          : "hover:scale-105 hover:brightness-110 active:scale-95"
                      }
                      ${isWinner ? "ring-3 ring-[#FFFF33] animate-pulse shadow-[0_0_25px_rgba(255,255,51,0.8)] z-10" : ""}
                    `}
                  >
                    {num}
                    {displayBets[num] && (
                      <span className={`absolute -top-2 -right-2 bg-[#FFFF33]/90 text-black text-[10px] sm:text-xs font-bold px-1.5 py-0.5 rounded-full shadow-[0_0_8px_rgba(255,255,51,0.5)] ${newChipKeys.some((k) => k.startsWith(`${num}-`)) ? "animate-bet-chip" : ""}`}>
                        {displayBets[num]}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    );
  };

  // ── Render ────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="min-h-screen overflow-x-clip bg-gradient-to-br from-[#001933] to-[#000d1a] px-3 pb-24 pt-20 text-white md:pb-8 flex flex-col items-center justify-center gap-3">
        <NavigationBar currentPath="/casino" />
        <LoadingDotsIcon
          className="w-8 h-8 text-yellow-300 animate-pulse"
          title="Loading"
        />
        <div className="text-yellow-200 text-sm animate-pulse">
          Loading match…
        </div>
      </div>
    );
  }

  if (!match) {
    return (
      <div className="min-h-screen overflow-x-clip bg-gradient-to-br from-[#001933] to-[#000d1a] px-3 pb-24 pt-20 text-white md:pb-8">
        <NavigationBar currentPath="/casino" />
        <div className="mx-auto mt-6 max-w-xl text-center flex flex-col items-center gap-4">
          <AlertIcon
            className="w-10 h-10 text-red-300"
            title="Match not found"
          />
          <p className="text-red-300">{error || "Match not found"}</p>
          <button
            onClick={leaveOrContinue}
            className="px-4 py-2 rounded-lg bg-yellow-300 text-[#001933] font-bold"
          >
            Back to lobby
          </button>
        </div>
      </div>
    );
  }

  const stake = Number(match.stakeAmount);
  const totalPot = stake * 2;
  const scoreP1 = match.scorePlayer1 ?? 0;
  const scoreP2 = match.scorePlayer2 ?? 0;
  const scoreYouView = isPlayer1 ? scoreP1 : scoreP2;
  const scoreOppView = isPlayer1 ? scoreP2 : scoreP1;
  const draws = (rounds || []).filter((r) => !r.roundWinner).length;
  const statusLabel =
    ROUND_STATUS_LABELS[match.status] ?? match.status ?? "";

  const renderStatusPill = () => {
    const isWaiting = match.status === MATCH_STATUS.WAITING;
    const isReady = match.status === MATCH_STATUS.READY;
    const isFinished = match.status === MATCH_STATUS.FINISHED;
    const isCancelled = match.status === MATCH_STATUS.CANCELLED;
    return (
      <span
        className={`px-3 py-1 rounded-full text-xs font-bold border ${
          isWaiting
            ? "bg-yellow-300/15 text-yellow-200 border-yellow-300/40 animate-pulse"
            : isReady
              ? "bg-cyan-400/15 text-cyan-200 border-cyan-400/40 animate-pulse"
              : isFinished
                ? "bg-green-500/15 text-green-300 border-green-400/40"
                : isCancelled
                  ? "bg-red-500/15 text-red-300 border-red-400/40"
                  : "bg-yellow-300/15 text-yellow-200 border-yellow-300/40"
        }`}
      >
        {statusLabel}
      </span>
    );
  };

  return (
    <div className="min-h-screen overflow-x-clip bg-gradient-to-br from-[#001933] to-[#000d1a] pb-24 pt-20 text-white md:pb-8">
      <NavigationBar currentPath="/casino" />

      <div className="mx-auto mt-2 flex w-full max-w-[1300px] flex-col gap-4 px-3 sm:mt-6 sm:flex-row sm:gap-8 sm:p-6">
        {/* ── Left sidebar: PvP state + controls ─────────────────── */}
        <div className="flex w-full flex-shrink-0 flex-col items-start gap-3 sm:w-[280px] sm:gap-4">
          <h1 className="mt-2 w-full text-center text-2xl font-bold text-[#FFFF33] drop-shadow-[0_0_12px_rgba(255,255,51,0.6)] sm:text-3xl inline-flex items-center justify-center gap-2">
            <RouletteWheelIcon
              className="w-7 h-7 sm:w-8 sm:h-8 text-[#FFFF33]"
              title="Roulette wheel"
            />
            <span>Roulette PvP</span>
          </h1>

          <div className="flex w-full flex-wrap items-center justify-center gap-2">
            {renderStatusPill()}
            <span className="px-3 py-1 rounded-full bg-[#FFFF33]/15 border border-[#FFFF33]/40 text-yellow-200 text-xs font-bold inline-flex items-center gap-1.5">
              <span>Stake: {stake.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
              <CoinIcon className="w-3.5 h-3.5 text-yellow-200" title="Tokens" />
            </span>
            <span className="px-3 py-1 rounded-full bg-[#00e5ff]/15 border border-[#00e5ff]/40 text-cyan-200 text-xs font-bold inline-flex items-center gap-1.5">
              <span>Pot: {totalPot.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
              <CoinIcon className="w-3.5 h-3.5 text-cyan-200" title="Tokens" />
            </span>
            {opponentClerkId && (
              <button
                onClick={() => setShowReportModal(true)}
                className="px-3 py-1 rounded-full border border-red-500/30 bg-red-500/10 text-xs font-bold text-red-400 transition-all hover:bg-red-500/20 hover:shadow-[0_0_10px_rgba(239,68,68,0.3)] inline-flex items-center gap-1.5"
              >
                <IconFlag size={12} /> <span>Report opponent</span>
              </button>
            )}
          </div>

          {/* Score panel (round-win counter) */}
          {match.status !== MATCH_STATUS.WAITING &&
            match.status !== MATCH_STATUS.CANCELLED && (
              <div className="w-full bg-[#001933] border border-[#FFFF33]/30 rounded-xl p-3">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[11px] uppercase tracking-widest text-white/55">
                    Score
                  </span>
                  <span className="text-[11px] uppercase tracking-widest text-white/55">
                    Draw {draws}
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2 text-center">
                  <div>
                    <div className="text-[10px] uppercase tracking-wider text-yellow-200">
                      You
                    </div>
                    <div className="text-2xl font-extrabold text-yellow-300">
                      {scoreYouView}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-wider text-cyan-200">
                      Opp
                    </div>
                    <div className="text-2xl font-extrabold text-cyan-300">
                      {scoreOppView}
                    </div>
                  </div>
                </div>
                <div className="mt-2 text-[10px] text-center text-white/50">
                  Always 3 rounds. <b>Round wins</b> shown above are informational<br/>
                  only — most match points decides the winner.
                </div>
              </div>
            )}          {/* Persistent match-points panel (Prompt 2) */}
          {match.status !== MATCH_STATUS.WAITING &&
            match.status !== MATCH_STATUS.CANCELLED && (
              <div className="w-full bg-[#001933] border border-[#FFFF33]/30 rounded-xl p-3">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[11px] uppercase tracking-widest text-white/55">
                    Match points
                  </span>
                  <span className="text-[10px] uppercase tracking-widest text-white/35">
                    seed {STARTING_POINTS}
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2 text-center">
                  <div>
                    <div
                      className={`text-xl font-bold tabular-nums transition-colors duration-200 ${
                        !Number.isFinite(myEffectivePoints)
                          ? "text-white/40"
                          : myEffectivePoints > STARTING_POINTS
                            ? "text-green-300"
                            : myEffectivePoints < STARTING_POINTS
                              ? "text-red-300"
                              : "text-white/80"
                      }`}
                      title={
                        (myCommittedBet > 0 || myTotalBet > 0)
                          ? `Server balance ${(myMatchPoints || 0).toFixed(
                              0,
                            )} − ${(myBetsAreLocked
                              ? myCommittedBet
                              : myTotalBet
                            ).toFixed(0)} pts (${myBetsAreLocked
                              ? "locked"
                              : "staged"})`
                          : "Server-authoritative balance"
                      }
                    >
                      {Number.isFinite(myEffectivePoints)
                        ? myEffectivePoints.toFixed(0)
                        : "—"}
                    </div>
                    {(myCommittedBet > 0 || myTotalBet > 0) && (
                      <div
                        className={`mt-1.5 text-[10px] font-bold inline-flex items-center gap-1 mx-auto px-1.5 py-0.5 rounded-full border ${
                          myBetsAreLocked
                            ? "border-green-400/40 bg-green-500/10 text-green-200"
                            : "border-yellow-300/30 bg-yellow-300/10 text-yellow-200"
                        }`}
                      >
                        {/* After the server commits the wager, the big
                            number above already reflects the deduction.
                            Prefix with the minus ONLY during staging
                            (player hasn't locked in yet — they're
                            projecting how much of their balance will be
                            consumed). When locked, drop the minus so the
                            badge isn't read as "balance − locked = 0". */}
                        {!myBetsAreLocked && <span>−</span>}
                        <span>
                          {(myBetsAreLocked ? myCommittedBet : myTotalBet).toFixed(
                            0,
                          )}
                        </span>
                        <span>
                          {myBetsAreLocked ? "locked" : "staged"}
                        </span>
                        {myBetsAreLocked && (
                          <CheckIcon
                            className="w-2.5 h-2.5"
                            title="Bets locked"
                          />
                        )}
                      </div>
                    )}
                  </div>
                  <div>
                    <div
                      className={`text-xl font-bold tabular-nums transition-colors duration-200 ${
                        !Number.isFinite(oppEffectivePoints)
                          ? "text-white/40"
                          : oppEffectivePoints > STARTING_POINTS
                          ? "text-green-300"
                          : oppEffectivePoints < STARTING_POINTS
                            ? "text-red-300"
                            : "text-white/80"
                      }`}
                      title={
                        spinning
                          ? "Frozen during spin · payout revealed when wheel settles"
                          : "Server-authoritative balance"
                      }
                    >
                      {Number.isFinite(oppEffectivePoints)
                        ? oppEffectivePoints.toFixed(0)
                        : "—"}
                    </div>
                  </div>
                </div>
                <div className="mt-2 text-[10px] text-center text-white/45">
                  Persist round-to-round. Win/losing bets update them.
                </div>
              </div>
            )}

          {/* Bet-status panel (you vs opponent) */}
          {match.status !== MATCH_STATUS.WAITING &&
            match.status !== MATCH_STATUS.CANCELLED &&
            match.status !== MATCH_STATUS.FINISHED && (
              <div className="w-full bg-[#001933] border border-cyan-400/30 rounded-xl p-3 text-sm">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[11px] uppercase tracking-widest text-white/55">
                    Round bet status
                  </span>
                  <span className="text-[11px] uppercase tracking-widest text-white/55">
                    {timeLeft !== null ? `${timeLeft}s` : "—"}
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div
                    className={`rounded-md px-2 py-1 border text-center text-xs inline-flex items-center justify-center gap-1 ${
                      displayMyBets
                        ? "border-green-400/40 bg-green-500/10 text-green-200"
                        : "border-yellow-300/30 bg-yellow-300/10 text-yellow-200"
                    }`}
                  >
                    <span>You</span>
                    {displayMyBets ? (
                      <CheckIcon className="w-3.5 h-3.5 text-green-200" title="Submitted" />
                    ) : (
                      <LoadingDotsIcon className="w-3.5 h-3.5 text-yellow-200 animate-pulse" title="Waiting" />
                    )}
                  </div>
                  <div
                    className={`rounded-md px-2 py-1 border text-center text-xs inline-flex items-center justify-center gap-1 ${
                      displayOppBets
                        ? "border-green-400/40 bg-green-500/10 text-green-200"
                        : "border-cyan-400/30 bg-cyan-400/10 text-cyan-200"
                    }`}
                  >
                    <span>Opp</span>
                    {displayOppBets ? (
                      <CheckIcon className="w-3.5 h-3.5 text-green-200" title="Submitted" />
                    ) : (
                      <LoadingDotsIcon className="w-3.5 h-3.5 text-cyan-200 animate-pulse" title="Waiting" />
                    )}
                  </div>
                </div>
              </div>
            )}

          {/* Locked-In Bets breakdown panel — shows each player's bet
              targets and amounts. ALWAYS visible during active (non-
              terminal, non-cancelled, non-waiting) rounds so both
              players can see each other's "in progress" stack even
              before anyone has locked in. Falls back to the just-
              resolved round's snapshot during the spin via
              `displayMyBets` / `displayOppBets` so a brand-new
              submitter sees the opponent's wager without waiting
              for a polling round-trip. */}
          {match.status !== MATCH_STATUS.WAITING &&
            match.status !== MATCH_STATUS.CANCELLED &&
            match.status !== MATCH_STATUS.FINISHED && (
              <LockedInBetsPanel
                displayMyBets={displayMyBets}
                displayOppBets={displayOppBets}
                spinning={spinning}
              />
            )}

          {/* Chip selector (replaces solo "Valeur du jeton") */}
          {!myBetsAreLocked && BETTABLE.has(match.status) && (
            <div className="w-full bg-[#001933] p-3 rounded-lg border border-[#FFFF33]/20">
              <p className="text-[11px] uppercase tracking-widest text-white/55 mb-2 text-center">
                Chip value · {pointsRemaining.toFixed(0)} remaining /{" "}
                {Number.isFinite(myMatchPoints) ? myMatchPoints.toFixed(0) : "—"}
              </p>
              <div className="flex flex-wrap gap-1.5 justify-center">
                {CHIP_VALUES.map((val) => (
                  <button
                    key={val}
                    onClick={() => setBetAmount(val)}
                    className={`px-2.5 py-1 rounded-full text-xs font-bold border transition-all duration-150 ${
                      betAmount === val
                        ? "bg-[#FFFF33] text-black border-[#FFFF33] shadow-[0_0_12px_rgba(255,255,51,0.6)] scale-110"
                        : "bg-[#0a1a3a] text-[#FFFF33]/80 border-[#FFFF33]/30 hover:bg-[#FFFF33]/20 hover:border-[#FFFF33]/60"
                    }`}
                  >
                    {val}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-1.5 mt-2">
                <input
                  type="number"
                  min="0"
                  value={betAmount}
                  onChange={(e) => setBetAmount(parseInt(e.target.value) || 0)}
                  onBlur={() => {
                    if (!betAmount || betAmount < 1) setBetAmount(1);
                  }}
                  className="flex-1 rounded bg-[#0a1a3a] border border-[#FFFF33]/30 focus:border-[#FFFF33] focus:ring-1 focus:ring-[#FFFF33] px-2 py-1 text-white text-sm text-center"
                />
                <button
                  onClick={() =>
                    setBetAmount(Math.min(Math.max(1, Math.floor(myMatchPoints / 2)), MAX_INT))
                  }
                  className="px-2 py-1 rounded text-xs font-bold border border-[#FFFF33]/30 bg-[#FFFF33]/15 text-[#FFFF33] hover:bg-[#FFFF33]/25 transition"
                >
                  ½
                </button>
                <button
                  onClick={() =>
                    setBetAmount(Math.min(Math.max(1, Math.floor(myMatchPoints)), MAX_INT))
                  }
                  className="px-2 py-1 rounded text-xs font-bold border border-[#FFFF33]/30 bg-[#FFFF33]/15 text-[#FFFF33] hover:bg-[#FFFF33]/25 transition"
                >
                  ALL
                </button>
              </div>
            </div>
          )}

          {/* Lock-in-bets + reset (replaces solo Spin + Reset) */}
          {!myBetsAreLocked && BETTABLE.has(match.status) && (
            <div className="flex flex-col gap-2 w-full">
              <button
                onClick={submitBets}
                disabled={submitting || spinning || myTotalBet <= 0 || myTotalBet > myMatchPoints + 0.0001}
                className={`px-6 py-3 rounded-full font-bold text-lg border border-[#FFFF33]/40 transition-all duration-200 inline-flex items-center justify-center gap-2 ${
                  submitting || spinning || myTotalBet <= 0 || myTotalBet > myMatchPoints + 0.0001
                    ? "bg-gray-600 text-gray-300 cursor-not-allowed"
                    : "bg-[#FFFF33]/20 text-[#FFFF33] hover:bg-[#FFFF33]/35 shadow-[0_0_20px_rgba(255,255,51,0.5)] hover:shadow-[0_0_30px_rgba(255,255,51,0.7)] active:scale-95"
                }`}
              >
                {submitting ? (
                  <>
                    <LoadingDotsIcon className="w-5 h-5 text-gray-300 animate-pulse" title="Submitting" />
                    <span>Submitting…</span>
                  </>
                ) : spinning ? (
                  <>
                    <LoadingDotsIcon className="w-5 h-5 text-gray-300 animate-pulse" title="Spinning" />
                    <span>Spinning…</span>
                  </>
                ) : myTotalBet > 0 ? (
                  <>
                    <TargetIcon className="w-5 h-5 text-[#FFFF33]" title="Lock in bets" />
                    <span>Lock in bets ({myTotalBet} pts)</span>
                  </>
                ) : (
                  "Place bets first"
                )}
              </button>
              <button
                onClick={resetBets}
                disabled={myTotalBet === 0}
                className="px-6 py-2 rounded-full font-bold border border-red-500/40 text-red-400 hover:bg-red-500/20 hover:text-red-200 transition shadow-[0_0_10px_rgba(255,0,0,0.3)] disabled:opacity-50"
              >
                Clear bets
              </button>
            </div>
          )}

          {/* "Bets locked" indicator during the brief inter-round window */}
          {myBetsAreLocked &&
            match.status !== MATCH_STATUS.FINISHED &&
            match.status !== MATCH_STATUS.CANCELLED &&
            match.status !== MATCH_STATUS.WAITING && (
              <div className="w-full rounded-xl border border-green-400/30 bg-green-500/10 px-3 py-2 text-center text-sm font-semibold text-green-200">
                Bets locked. Waiting for opponent…
              </div>
            )}

          {/* Round history strip (replaces solo hot-numbers) */}
          {rounds.length > 0 && (
            <div className="w-full max-h-44 overflow-y-auto bg-[#001933]/70 border border-[#FFFF33]/20 rounded-lg p-3 text-xs">
              <p className="text-[11px] uppercase tracking-widest text-white/55 mb-2">
                Round history
              </p>
              <div className="space-y-1">
                {rounds.map((r) => {
                  const meIsP1 = isPlayer1;
                  const isYouWinner = r.roundWinner === (meIsP1 ? "player1" : "player2");
                  const isDraw = !r.roundWinner;
                  return (
                    <div
                      key={r.id}
                      className="flex items-center justify-between gap-2 rounded px-2 py-1 bg-[#08142f]/80 border border-white/5"
                    >
                      <span className="text-white/60">
                        {r.isSuddenDeath ? "SD" : "R"}
                        {r.roundNumber}
                      </span>
                      <span
                        className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${lastNumColor(r.spinResult)}`}
                      >
                        {r.spinResult}
                      </span>
                      <span
                        className={
                          isDraw
                            ? "text-white/55"
                            : isYouWinner
                              ? "text-green-300"
                              : "text-red-300"
                        }
                      >
                        {isDraw
                          ? "Draw"
                          : isYouWinner
                            ? "+you"
                            : "+opp"}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Waiting panel (creator can cancel) */}
          {match.status === MATCH_STATUS.WAITING && (
            <div className="w-full rounded-2xl border border-yellow-300/40 bg-yellow-300/10 px-4 py-4 text-center">
              <p className="font-bold text-yellow-200 inline-flex items-center justify-center gap-2">
                <ClockIcon
                  className="w-5 h-5 text-yellow-200 animate-pulse"
                  title="Waiting"
                />
                <span>
                  Waiting for an opponent to join your{" "}
                  {stake.toLocaleString()}
                </span>
                <CoinIcon className="w-4 h-4 text-yellow-200" title="Tokens" />
                <span>lobby…</span>
              </p>
              <p className="text-xs text-white/60 mt-1">
                When someone joins with the same stake, your Round 1 begins.
              </p>
              <button
                onClick={cancelWaiting}
                disabled={cancelling}
                className="mt-3 px-4 py-2 rounded-lg bg-red-500/80 hover:bg-red-500 text-white font-bold text-sm disabled:opacity-50 inline-flex items-center gap-2"
              >
                {cancelling ? (
                  <>
                    <LoadingDotsIcon className="w-3.5 h-3.5 text-white animate-pulse" title="Cancelling" />
                    <span>Cancelling…</span>
                  </>
                ) : (
                  "Cancel & refund"
                )}
              </button>
            </div>
          )}

          {/* Ready window (3s transition before Round 1) */}
          {match.status === MATCH_STATUS.READY && (
            <div className="w-full rounded-2xl border border-cyan-400/40 bg-cyan-400/10 px-4 py-4 text-center">
              <p className="font-bold text-cyan-200 animate-pulse inline-flex items-center justify-center gap-2">
                <BoltIcon className="w-5 h-5 text-cyan-200" title="Match starting" />
                <span>Match starting…</span>
              </p>
              <p className="text-xs text-white/60 mt-1">
                Round 1 will begin in{" "}
                {timeLeft !== null ? `${timeLeft}s` : "a moment"}.
              </p>
            </div>
          )}

          {/* Cancelled panel */}
          {match.status === MATCH_STATUS.CANCELLED && (
            <div className="w-full rounded-2xl border border-red-400/40 bg-red-500/10 px-4 py-4 text-center">
              <p className="font-bold text-red-200">
                This match was cancelled. Your stake was refunded.
              </p>
              <button
                onClick={leaveOrContinue}
                className="mt-3 px-4 py-2 rounded-lg bg-yellow-300 text-[#001933] font-bold text-sm"
              >
                Back to lobby
              </button>
            </div>
          )}

          {/* Round-just-resolved banner */}
          {roundResultBanner &&
            match.status !== MATCH_STATUS.FINISHED &&
            match.status !== MATCH_STATUS.CANCELLED && (
              <motion.div
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                className="w-full rounded-xl border border-cyan-400/40 bg-cyan-400/10 px-3 py-2 text-center text-sm font-semibold text-cyan-100"
              >
                Round {roundResultBanner.roundNumber}{" "}
                {roundResultBanner.winner === "you"
                  ? "won by you"
                  : roundResultBanner.winner === "opponent"
                    ? "won by opponent"
                    : "ended in a draw"}
                . Spin:{" "}
                <b className="text-yellow-300">{roundResultBanner.spinResult}</b>{" "}
                · You net{" "}
                <b
                  className={
                    (isPlayer1
                      ? roundResultBanner.p1Net
                      : roundResultBanner.p2Net) > 0
                      ? "text-green-300"
                      : "text-red-300"
                  }
                >
                  {Number(
                    isPlayer1
                      ? roundResultBanner.p1Net
                      : roundResultBanner.p2Net,
                  ).toFixed(2)}
                </b>
              </motion.div>
            )}

          {/* Match-ended banner */}
          {match.status === MATCH_STATUS.FINISHED && (
            <motion.div
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              className={`w-full rounded-2xl border p-4 text-center font-bold tracking-wide ${
                matchEndedBanner === "you"
                  ? "bg-green-500/15 border-green-400/40 text-green-200"
                  : "bg-red-500/15 border-red-400/40 text-red-200"
              }`}
            >
              {matchEndedBanner === "you" ? (
                <span className="inline-flex items-center justify-center gap-2 flex-wrap">
                  <TrophyIcon className="w-6 h-6 text-green-300" title="You won" />
                  <span>
                    You won {Number(match.prizePaid || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </span>
                  <CoinIcon className="w-5 h-5 text-green-300" title="Tokens" />
                  <span>!</span>
                </span>
              ) : matchEndedBanner === "opponent" ? (
                <span className="inline-flex items-center justify-center gap-2 flex-wrap">
                  <SkullIcon className="w-6 h-6 text-red-300" title="You lost" />
                  <span>
                    You lost. Opponent took {Number(match.prizePaid || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </span>
                  <CoinIcon className="w-5 h-5 text-red-300" title="Tokens" />
                  <span>.</span>
                </span>
              ) : matchEndedBanner === "draw" ? (
                <span className="inline-flex items-center justify-center gap-2">
                  <HandshakeIcon className="w-6 h-6 text-white/80" title="Draw" />
                  <span>Mutual wipeout — match is a draw and stakes were refunded.</span>
                </span>
              ) : (
                "Match finished"
              )}
              {Number(match.prizePaid) > 0 && (
                <span className="block mt-1 text-xs text-white/60 inline-flex items-center gap-1">
                  <span>(house fee: {Number(match.houseFee || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                  <CoinIcon className="w-3 h-3 text-white/60" title="Tokens" />
                  <span>)</span>
                </span>
              )}
            </motion.div>
          )}

          {/* Error */}
          {error && (
            <div className="w-full bg-red-900/30 border border-red-400/30 text-red-300 p-2 rounded text-xs text-center">
              {error}
            </div>
          )}

          {/* Rules */}
          <div className="w-full">
            <button
              onClick={() => setShowRules(!showRules)}
              className="w-full flex items-center justify-between px-3 py-2.5 bg-[#FFFF33]/15 text-[#FFFF33] font-bold rounded-lg border border-[#FFFF33]/35 text-sm hover:bg-[#FFFF33]/25 transition"
            >
              <span className="inline-flex items-center gap-2">
                <BookIcon className="w-4 h-4 text-[#FFFF33]" title="Rules" />
                <span>Rules</span>
              </span>
              {showRules ? (
                <ChevronUpIcon className="w-4 h-4 text-[#FFFF33]" title="Collapse" />
              ) : (
                <ChevronDownIcon className="w-4 h-4 text-[#FFFF33]" title="Expand" />
              )}
            </button>
            {showRules && (
              <div className="mt-2 bg-[#020617] border border-[#FFFF33]/25 rounded-xl p-3 text-white text-xs sm:text-sm leading-relaxed max-h-56 overflow-y-auto">
                <h2 className="text-base font-bold text-yellow-400 mb-2 text-center">
                  How to play
                </h2>
                <div className="space-y-3">
                  <div>
                    <h3 className="text-yellow-400 font-semibold inline-flex items-center gap-1.5">
                      <TargetIcon className="w-4 h-4 text-yellow-400" title="Goal" />
                      <span>Goal</span>
                    </h3>
                    <p>Both players bet on the same wheel spin; higher net payout wins the round.</p>
                  </div>
                  <div>
                    <h3 className="text-yellow-400 font-semibold">Bets</h3>
                    <ul className="list-disc ml-4">
                      <li>Single number (×35)</li>
                      <li>Red/Black/Even/Odd (×2)</li>
                      <li>Dozens (×3)</li>
                    </ul>
                  </div>
                  <div>
                    <h3 className="text-yellow-400 font-semibold inline-flex items-center gap-1.5">
                      <ClockIcon className="w-4 h-4 text-yellow-400" title="Timer" />
                      <span>Timer</span>
                    </h3>
                    <p>Each round gives both players exactly 20 seconds to place bets. The timer starts simultaneously for both players — when it hits zero, betting locks and boards are saved server-side.</p>
                  </div>
                  <div>
                    <h3 className="text-yellow-400 font-semibold inline-flex items-center gap-1.5">
                      <TrophyIcon className="w-4 h-4 text-yellow-400" title="Match" />
                      <span>Match</span>
                    </h3>
                    <p>Always 3 rounds — the player with the most match points wins. Ties after Round 3 trigger Sudden Death. 2.5% house fee.</p>
                  </div>
                  <div>
                    <h3 className="text-yellow-400 font-semibold inline-flex items-center gap-1.5">
                      <CoinIcon className="w-4 h-4 text-yellow-400" title="Points" />
                      <span>Points</span>
                    </h3>
                    <p>You start with 100 match points. They persist round-to-round. You cannot wager more than your current balance.</p>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Back-to-lobby button (terminal states) */}
          {(match.status === MATCH_STATUS.FINISHED ||
            match.status === MATCH_STATUS.CANCELLED) && (
            <button
              onClick={leaveOrContinue}
              className="w-full px-4 py-2.5 rounded-xl font-bold text-black bg-yellow-300 hover:bg-yellow-200 transition"
            >
              Back to lobby
            </button>
          )}
        </div>

        {/* ── Right side: wheel + grid + zones ──────────────────── */}
        <div className="flex w-full min-w-0 flex-col items-center">
          {/* Spinning overlay indicator */}
          {spinning && (
            <div className="mb-2 px-3 py-1 rounded-full bg-black/60 text-yellow-300 text-xs font-bold tracking-wider animate-pulse inline-flex items-center gap-2">
              <span>Spinning</span>
              <LoadingDotsIcon className="w-3.5 h-3.5 text-yellow-300" title="Spinning" />
            </div>
          )}

          {/* Last-spin highlight strip (replaces solo hot numbers) */}
          {Number.isFinite(match?.lastSpinResult) && (
            <div className="w-full max-w-[440px] mb-3 flex items-center gap-2 overflow-x-auto px-1">
              <span className="text-[#FFFF33]/60 text-xs font-bold whitespace-nowrap">
                Last spin
              </span>
              <span
                className={`inline-flex items-center justify-center w-8 h-8 rounded-full text-xs font-bold flex-shrink-0 border border-white/10 ${lastNumColor(match.lastSpinResult)} ring-2 ring-[#FFFF33] scale-110`}
              >
                {match.lastSpinResult}
              </span>
            </div>
          )}

          {/* Wheel + pointer.
              The canvas is deliberately rendered on every
              non-loading, non-null-match render — i.e. ALWAYS visible,
              even when the player is between rounds, in FINISHED,
              or waiting for the opponent to lock in. This is the
              "keep wheel even when not betting" invariant: the wheel
              canvas DOM node is never conditionally removed. The
              status indicator below doubles down on the same promise
              with an explicit textual cue so the player has strong
              visual confirmation the wheel is still "live". */}
          <div className="relative mx-auto w-full max-w-[420px] aspect-square">
            <canvas
              ref={canvasRef}
              width={CANVAS_SIZE}
              height={CANVAS_SIZE}
              className="w-full h-full rounded-full ring-1 ring-[#FFFF33]/15 shadow-[0_0_35px_rgba(255,255,51,0.12)]"
              style={{ maxWidth: CANVAS_SIZE, maxHeight: CANVAS_SIZE }}
            />
          </div>
          {/* Wheel status indicator. Always visible so the player has
              a constant textual cue that the wheel is present and
              active. Shows the spin state, the last spin result (if
              any), and whether bets are still being accepted. */}
          <div className="mt-2 text-center">
            <span className="text-[10px] uppercase tracking-widest text-white/45 inline-flex items-center gap-1.5">
              {spinning ? (
                <>
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-yellow-300 animate-pulse" />
                  <span>Spinning…</span>
                </>
              ) : Number.isFinite(match?.lastSpinResultIndex) ? (
                <>
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-cyan-300" />
                  <span>
                    Last spin{" "}
                    <b className="text-yellow-200">
                      {match.lastSpinResult}
                    </b>
                    {match.player1Bets || match.player2Bets
                      ? " · awaiting opponent"
                      : " · next round open"}
                  </span>
                </>
              ) : (
                <>
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-cyan-300 animate-pulse" />
                  <span>Wheel ready · awaiting first spin</span>
                </>
              )}
            </span>
          </div>

          {/* Number grid */}
          <div className="w-full max-w-[440px] mt-4 px-1">
            {renderNumberGrid()}
          </div>

          {/* Betting zones */}
          <div className="mt-3 flex flex-wrap gap-1.5 justify-center w-full max-w-[440px] px-1">
            {[
              { key: "1-12", label: "1-12" },
              { key: "13-24", label: "13-24" },
              { key: "25-36", label: "25-36" },
              { key: "1-18", label: "1-18" },
              { key: "even", label: "Even" },
              { key: "red", label: "Red" },
              { key: "black", label: "Black" },
              { key: "odd", label: "Odd" },
              { key: "19-36", label: "19-36" },
              { key: "green", label: "Green" },
            ].map(({ key, label }) => {
              const displayBets = myBetsAreLocked ? mySubmittedBets || {} : bets;
              return (
                <button
                  key={key}
                  onClick={() => placeBet(key)}
                  disabled={myBetsAreLocked}
                  className={`relative px-2.5 py-1.5 rounded border border-[#FFFF33]/30 text-xs sm:text-sm font-bold capitalize transition-all duration-150 ${
                    key === "red"
                      ? "bg-[#c0392b] text-white"
                      : key === "black"
                        ? "bg-[#1a1a2e] text-[#FFFF33]"
                        : key === "green"
                          ? "bg-[#0d5e2e] text-white"
                          : "bg-[#102542] text-white"
                  } ${
                    displayBets[key]
                      ? "ring-2 ring-[#FFFF33] shadow-[0_0_15px_rgba(255,255,51,0.5)]"
                      : ""
                  } ${
                    myBetsAreLocked
                      ? "opacity-70 cursor-not-allowed"
                      : "hover:scale-105 hover:brightness-110 active:scale-95"
                  }`}
                >
                  {label}
                  {displayBets[key] && (
                    <span className={`absolute -top-2 -right-2 bg-[#FFFF33]/90 text-black text-[10px] font-bold px-1.5 py-0.5 rounded-full shadow-[0_0_8px_rgba(255,255,51,0.5)] ${newChipKeys.some((k) => k.startsWith(`${key}-`)) ? "animate-bet-chip" : ""}`}>
                      {displayBets[key]}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Animations */}
      <style jsx>{`
        @keyframes betChipPop {
          0% {
            transform: scale(0);
            opacity: 0;
          }
          50% {
            transform: scale(1.3);
          }
          100% {
            transform: scale(1);
            opacity: 1;
          }
        }
        .animate-bet-chip {
          animation: betChipPop 0.3s ease-out;
        }
      `}</style>

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
              gameType: "roulette-pvp",
              gameId: String(matchId),
              reason,
              details: details || undefined,
            }),
          });
          const data = await res.json();
          if (!data.success) throw new Error(data.error || "Failed to submit report");
        }}
        reportedPlayerName="Opponent"
        gameType="Roulette PvP"
      />
    </div>
  );
}

// Local constant for safe Math.min / setBetAmount calls in the
// chip-selector ½ / ALL buttons. JS Number.MAX_SAFE_INTEGER is the
// natural upper boundary; we expose it under a short alias to keep
// the button expressions readable.
const MAX_INT = Number.MAX_SAFE_INTEGER;
