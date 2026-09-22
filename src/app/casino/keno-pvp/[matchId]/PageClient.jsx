"use client";

// src/app/casino/keno-pvp/[matchId]/page.jsx
//
// Live 1v1 Keno Catch Duel match view. Both players face the SAME
// shared 10-tile draw; tiles glow one at a time on a server-declared
// schedule and you tap the glowing tile on the 1–40 board to catch it
// before its 0.8s glow fades. Green = caught, red = tapped too late
// (no points). First to 10 cumulative points takes the pot (90/10
// split).
//
// The client animates the glow stream from the match's roundDeadline
// + the shared timing constants; the SERVER grades every catch with
// its own clock, so the client can never self-report a catch.
// The opponent's ticket stays hidden until the round resolves.

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { usePostHog } from "posthog-js/react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import confetti from "canvas-confetti";
import NavigationBar from "../../../../components/navigation-bar";
import Footer from "../../../../components/Footer";
import MatchWaiting from "../../../../components/lobby/MatchWaiting";
import CreatorResultOverlay from "../../../../components/creator-mode/CreatorResultOverlay";
import FrameAvatar from "../../../../components/FrameAvatar";
import { cosmeticEffectClass } from "../../../../lib/profileCosmetics";
// Shared Creator Mode foundation (admin-only): mounts the viewport
// recorder + overlay, auto-starts when the match actually begins (a real
// round_1..N is in play, i.e. left the waiting room) and auto-stops once
// it finishes/cancels. The matchmaking takeover and nav stay outside the
// shared CreatorModeHost recording viewport.
import CreatorModeHost from "../../../../components/creator-mode/CreatorModeHost";
import {
  CreatorView,
  CreatorModeShell,
  ShellMain,
  CreatorPhoneFrame,
} from "../../../../components/creator-mode/CreatorModeLayout";
import {
  getSharedAudioContext,
  getSharedOutputNode,
} from "../../../../lib/creator-mode/audioTap";
// Shared game SFX. gameAudio imports the same creator-mode/audioTap
// singleton as the inline tile tick in this page, so every Keno sound routes
// through ONE page-wide audio context / output node — Creator Mode keeps
// capturing it, and the global mute gate keeps silencing all of it.
import {
  playGoodReveal,
  playBuzz,
  playVictory,
  playDefeat,
  playTick,
} from "../../../../lib/gameAudio";
import EmotePicker, { EmoteBubble } from "../../../../components/game/EmotePicker";
import useGameEmotes from "../../../../hooks/useGameEmotes";
import { useSocket } from "../../../../context/SocketProvider";
import {
  KENO_PVP_MATCH_UPDATED,
  kenoPvpMatchRoom,
} from "../../../../lib/keno-pvp/rooms";
import {
  BALL_COUNT,
  GLOW_MS,
  KENO_POOL_SIZE,
  MAX_ROUNDS,
  POINTS_TO_WIN,
} from "../../../../lib/keno-pvp/constants";
import RoundMarkers from "../../../../components/casino/RoundMarkers";
import { ballSchedule, computeRoundStats } from "../../../../lib/keno-pvp/engine";
import { KENO_MULTIPLIER_TABLE } from "../../../../lib/kenoMultipliers";
import { withReducedMotion } from "../../../../lib/animations";
import {
  IconCoins,
  IconHeartHandshake,
  IconTrophy,
  IconCircleX,
  IconNotebook,
  IconX,
  IconTarget,
  IconVolume,
  IconClock,
} from "@tabler/icons-react";
import { PoolBallIcon } from "../../../../components/icons/CustomIcons";

// Flash feedback shown after a tap on the board: green for a catch
// inside the glow window, red for a tap that genuinely landed too late,
// neutral for a ball the server says is already on YOUR ticket (an
// idempotent duplicate — never a miss).
const FLASH_LABEL = {
  caught: { text: "CAUGHT!", cls: "text-emerald-300 border-emerald-400/60 bg-emerald-500/15" },
  missed: { text: "MISSED", cls: "text-red-300 border-red-400/60 bg-red-500/15" },
  duplicate: { text: "ALREADY CAUGHT", cls: "text-white/80 border-white/30 bg-white/10" },
};

// Server reason → player-facing copy for a tap that failed. Raw API
// strings ("Ball expired", "Ball not catchable at this instant", …)
// must never reach the board; anything unmapped falls back to "Too late".
const MISS_TEXT = {
  "Ball has not been released yet": "Too early",
  "Ball is not in this round's draw": "Not this round",
  "Round has ended": "Round over",
  "Match is not in a catch round": "Round over",
};
const MISS_TEXT_FALLBACK = "Too late";

// Reasons that genuinely mean THIS player's tap failed (the ball's
// window closed, or the round did) → the tile turns red. Transport,
// auth and server failures are deliberately absent: they are not a miss.
const TAP_MISS_REASONS = new Set([
  "Ball expired",
  "Ball not catchable at this instant",
  "Ball has not been released yet",
  "Ball is not in this round's draw",
  "Round has ended",
  "Match is not in a catch round",
]);

// The one server reason that means the ball is already on our own
// ticket (a racing duplicate) rather than that the tap failed.
const ALREADY_CAUGHT_REASON = "Ball already caught";

function missTextFor(reason) {
  return MISS_TEXT[reason] || MISS_TEXT_FALLBACK;
}

// The flash pill's label. A caught ball names the tile it landed on; the
// two "gained nothing" flashes (a genuine miss, or a ball the server
// says is already on our ticket) show their plain reason instead.
function flashLabelFor(quality, flash) {
  if (quality === "missed" || quality === "duplicate") {
    return flash.text || FLASH_LABEL[quality]?.text || "MISSED";
  }
  return `TILE ${flash.ball} · ${FLASH_LABEL[quality].text}`;
}

// The round banner's one line. It carries the round ANNOUNCEMENT (the round
// that is live now, so the cue also shows when a match opens straight into
// round 1) and, when the same snapshot also closed the previous round, that
// round's result rides along on the same line. `winnerIsYou` is null for a
// draw (or a winner we do not know).
function roundBannerText(banner) {
  const resolved =
    banner.resolvedRound == null
      ? null
      : banner.winnerIsYou === null
        ? `Round ${banner.resolvedRound}: draw`
        : banner.winnerIsYou
          ? `Round ${banner.resolvedRound}: you won it!`
          : `Round ${banner.resolvedRound}: opponent won it`;
  if (banner.liveRound != null) {
    return resolved ? `Round ${banner.liveRound} · ${resolved}` : `Round ${banner.liveRound}`;
  }
  return resolved || "";
}

// The opponent's caught numbers in the LATEST resolved round — the only
// round whose tiles the board paints gold, and the ticket the recap strip
// spells out. `rounds` is ordered by round number and only ever carries
// resolved rounds (the server writes the history row at resolution), so its
// last entry is the round that just ended. Deliberately ONE round, never the
// accumulated history: a number caught in round 1 and drawn again later, or
// caught by both seats, stayed gold forever, so the board stopped describing
// any single round. A resolved round is public — the server scrubs only the
// LIVE round's opponent catches — so nothing here is hidden information.
function oppResolvedTilesFor(rounds, viewerIsPlayer1) {
  const latest = Array.isArray(rounds) && rounds.length > 0 ? rounds[rounds.length - 1] : null;
  if (!latest) return [];
  const catches = latest[viewerIsPlayer1 ? "player2Catches" : "player1Catches"];
  if (!Array.isArray(catches)) return [];
  const numbers = new Set();
  for (const c of catches) {
    if (c && typeof c.number === "number") numbers.add(c.number);
  }
  return [...numbers].sort((a, b) => a - b);
}

// A score number that emphasises itself for a moment when its value CHANGES.
// The React key is the value itself, so the 180ms `animate-state-in` one-shot
// plays exactly on a score change — an unrelated render (the 100ms board
// clock, a poll/socket snapshot returning the same score, the creator frame
// re-rendering every second) keeps the same key and never replays it. It is
// the app's shared state-change cue, and it collapses to its end state under
// prefers-reduced-motion, so the score stays fully readable either way.
// The race bar's static emphasis. Normally a win is carried by the CSS flash
// animation (`kenoGlowGreen` / `kenoGlowGold`, applied inline); with motion
// off the global reduced-motion rule collapses that animation to nothing, so
// the WINNER's fill carries a static ring + glow and the LOSER's fill steps
// back — the outcome stays readable with no movement at all, and it clears
// itself when `flashWinner` resets exactly like the animation did.
function raceBarTone(side, winner, reduceMotion) {
  if (!reduceMotion || !winner) return "";
  if (winner !== side) return " opacity-40";
  return side === "you"
    ? " ring-1 ring-[#00ffa6] shadow-[0_0_12px_rgba(0,255,166,0.9)]"
    : " ring-1 ring-[#FFD700] shadow-[0_0_12px_rgba(255,215,0,0.9)]";
}

function ScoreNumber({ value, className = "" }) {
  return (
    <span key={value} className={`inline-block animate-state-in tabular-nums ${className}`}>
      {value}
    </span>
  );
}

// The 1–40 board numbers. Built once: both board copies map it, and it never
// changes.
const KENO_NUMBERS = Array.from({ length: KENO_POOL_SIZE }, (_, i) => i + 1);

// One Keno board tile.
//
// The page re-renders on the 100ms client clock, which used to rebuild all 40
// tile buttons on every tick. This is a memoized leaf: it re-renders only when
// a prop it actually renders changes — its own board state (released / glowing
// / caught / gold / missed / pending / frozen), the countdown ring's remaining
// seconds while it IS the glowing tile, or the (stable) catch handler. The
// other 39 tiles are skipped by the shallow prop compare on every tick.
//
// Caught / missed carry a ONE-SHOT reveal (no looping pulse): the class stays
// stable while the state holds, so the 100ms board clock, a poll or a socket
// push can never replay it.
const KenoTile = memo(function KenoTile({
  num,
  released,
  isActive,
  ringSeconds,
  inGraceTail,
  caught,
  oppCaught,
  missed,
  pending,
  frozen,
  onCatch,
}) {
  let cls = "bg-[#020617] border border-[#00e5ff]/20 text-white/35 cursor-default";
  if (caught)
    cls =
      "bg-[#00ffa6] text-[#001933] scale-105 ring-2 ring-[#00ffa6]/70 shadow-[0_0_18px_rgba(0,255,166,0.9)] animate-tile-reveal";
  else if (isActive)
    cls =
      "bg-[#00e5ff] text-[#001933] border-[#00e5ff] scale-110 shadow-[0_0_20px_rgba(0,229,255,0.8)] cursor-pointer animate-pulse";
  else if (inGraceTail) cls = "bg-[#00e5ff]/25 text-[#7cefff] border-[#00e5ff]/50 cursor-pointer";
  else if (oppCaught) cls = "bg-[#FFD700]/25 text-[#FFD700] border border-[#FFD700]/50";
  else if (missed) cls = "bg-red-500/25 text-red-400 border border-red-500/60 animate-keno-miss";
  else if (released) cls = "bg-[#0a1a3a] border-[#00e5ff]/25 text-white/50 cursor-pointer";
  // A tap that is still awaiting /catch gets a neutral ring + nudge so it
  // never feels dropped. It deliberately does NOT claim the catch — only a
  // green tile (or the CAUGHT! flash) means caught.
  if (pending) cls = `${cls} ring-2 ring-white/90 scale-105`;
  return (
    <button
      disabled={frozen || !released || caught || missed}
      onClick={() => !frozen && released && onCatch(num)}
      className={`relative w-full aspect-square flex items-center justify-center rounded-lg text-sm font-bold transition-all duration-200 touch-manipulation select-none active:scale-90 ${cls}`}
    >
      {num}
      {/* Shrinking countdown ring — the remaining-time read-out for the active
          ball, so it is deliberately NOT reduced-motion-gated: freezing it
          would hide that the tile is about to expire. */}
      {isActive && ringSeconds != null && (
        <motion.span
          key={`glow-ring-${num}`}
          initial={{ scale: 1, opacity: 1 }}
          animate={{ scale: 0.55, opacity: 0 }}
          transition={{ duration: Math.max(0.05, ringSeconds), ease: "linear" }}
          aria-hidden="true"
          className="absolute inset-0 rounded-lg border-2 border-white/80 pointer-events-none"
        />
      )}
    </button>
  );
});

// The frozen board shown while the result modal is still pending, built from
// the FINAL round's own resolved history row (its shared draw, both catch
// lists and both round scores) — the same public row the recap strip reads,
// so no new server data is involved. The moment a match finishes the server
// clears the live round (currentDraw, both catch lists, the deadline), which
// is why the live board cannot be used here.
// Returns null unless the row really is the round the match ended on — a
// forfeit (a round that never resolved) must not show a stale board.
function finalBoardFromResolvedRound(resolvedRound, viewerIsPlayer1, currentRound) {
  if (!resolvedRound) return null;
  const round = Number(resolvedRound.roundNumber);
  if (!Number.isFinite(round) || round !== Number(currentRound)) return null;
  const mine =
    (viewerIsPlayer1 ? resolvedRound.player1Catches : resolvedRound.player2Catches) || [];
  const caughtNumbers = new Set();
  for (const c of Array.isArray(mine) ? mine : []) {
    if (c && typeof c.number === "number") caughtNumbers.add(c.number);
  }
  const drawnNumbers = new Set();
  const schedule = [];
  const draw = Array.isArray(resolvedRound.sharedDraw) ? resolvedRound.sharedDraw : [];
  for (const n of draw) {
    if (typeof n !== "number") continue;
    drawnNumbers.add(n);
    // Past release + past expiry: the tile class chain then reads each ball as
    // settled — released, never the active tile, never in the grace tail — so
    // the held board is stable and nothing glows.
    schedule.push({ number: n, releaseMs: -1, expiresMs: -1, acceptedUntilMs: -1 });
  }
  const myCatches = Array.isArray(mine) ? mine : [];
  return {
    round,
    schedule,
    drawnNumbers,
    caughtNumbers,
    myCatches,
    myStats: computeRoundStats(myCatches),
  };
}

// The round number a status snapshot represents, or null when it is not a
// round (ready / overtime / finished / cancelled).
function roundStatusNumber(status) {
  if (!status || !/^round_\d+$/.test(status.status || "")) return null;
  const n = Number(status.currentRound);
  return Number.isFinite(n) ? n : null;
}

// What the round banner should announce for a snapshot, or null when nothing
// about the round changed. Returns { liveRound, resolvedRound, winnerIsYou }:
//  · liveRound     — the round that is LIVE now, when this snapshot entered a
//                    round it was not in before (round 1 included, and on the
//                    first snapshot after mounting mid-round).
//  · resolvedRound — the round this snapshot CLOSED, when it left the round
//                    it was in. Detected by the round number changing, not by
//                    "the next status is also a round", so the FINAL round is
//                    announced too even though the match goes straight to
//                    `finished` (or settles into `overtime`).
//  · winnerIsYou   — true / false, or null for a draw (or an unknown winner).
function roundAnnouncementFor(prev, m, resolvedRounds) {
  const liveRound = roundStatusNumber(m);
  const prevRound = roundStatusNumber(prev);
  const resolvedNumber = prevRound != null && liveRound !== prevRound ? prevRound : null;
  const enteredNumber = liveRound != null && liveRound !== prevRound ? liveRound : null;
  if (enteredNumber == null && resolvedNumber == null) return null;
  const row =
    resolvedNumber == null
      ? null
      : (resolvedRounds || []).find((r) => r.roundNumber === resolvedNumber);
  // A resolved round with no history row yet announces nothing extra — never
  // leave an empty banner on screen.
  if (enteredNumber == null && !row) return null;
  return {
    liveRound: enteredNumber,
    resolvedRound: row ? row.roundNumber : null,
    winnerIsYou:
      !row || !row.roundWinner || row.roundWinner === "draw"
        ? null
        : row.roundWinner === (m.viewerIsPlayer1 ? "player1" : "player2"),
  };
}

// Cushion added to the round-deadline nudge below. The nudge is timed from
// our own estimate of the server clock (`clockOffset`), which carries up to
// roughly half an RTT of error — without the cushion the extra read could
// land a fraction early, see the round still live, and wait for the poll.
// 300ms is imperceptible next to the 0–5s wait it removes.
const DEADLINE_NUDGE_CUSHION_MS = 300;

export default function KenoPvpMatchPage({ params }) {
  const router = useRouter();
  const posthog = usePostHog();
  const { socket } = useSocket();
  // Repo convention (see PvpResultScreen / the blackjack and mines match
  // pages): ask framer-motion once and swap every decorative variant for the
  // shared `staticMotion` when the user asks for reduced motion. CSS one-shots
  // are already handled by the global prefers-reduced-motion rule in
  // globals.css; this covers the Framer-driven motion that rule cannot reach.
  const shouldReduceMotion = useReducedMotion();

  const [matchId, setMatchId] = useState(null);
  const [match, setMatch] = useState(null);
  const [rounds, setRounds] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [now, setNow] = useState(Date.now());
  const [clockOffset, setClockOffset] = useState(0); // ms: serverNow = clientNow + offset
  const [lastQuality, setLastQuality] = useState(null); // { ball, quality } flash
  // Round announcement: { liveRound, resolvedRound, winnerIsYou } — the
  // round now live (or null) plus the round this same snapshot resolved (or
  // null). Rendered through `roundBannerText`.
  const [roundBanner, setRoundBanner] = useState(null);
  const [missedTiles, setMissedTiles] = useState(new Set()); // tiles tapped after the glow faded
  // Balls whose /catch request is in flight (local only). Drives the
  // neutral "tap registered" ring so a tap is acknowledged instantly even
  // though only the server can confirm the catch.
  const [pendingTaps, setPendingTaps] = useState(new Set());
  const [showRules, setShowRules] = useState(false);
  const [leaving, setLeaving] = useState(false);
  // Which side just crossed the POINTS_TO_WIN line → scoreboard bar
  // flashes the victory. "you" | "opp" | null.
  const [flashWinner, setFlashWinner] = useState(null);
  // Result modal is delayed briefly so the flash + final board are
  // visible before the overlay covers the screen.
  const [showResult, setShowResult] = useState(false);

  const myCatchesRef = useRef([]);
  // Synchronous in-flight guard for taps (one attempt per ball). A ref so
  // a second tap in the same tick is dropped before it can race the first
  // request to the server and come back as "Ball already caught".
  const pendingTapsRef = useRef(new Set());
  // Status-read ordering. Several reads can be in flight at once (the 5s
  // poll, a socket push, the round-deadline nudge) and they can resolve out
  // of order — the sequence number lets only the newest response commit a
  // snapshot, so a slow older read can never roll the view back a round.
  const statusSeqRef = useRef(0);
  const lastAppliedStatusSeqRef = useRef(0);
  const lastStatusRef = useRef(null);
  // The round deadline we have already nudged a status read for.
  const deadlineNudgedRef = useRef(null);
  const bannerTimerRef = useRef(null);
  const lastRoundRef = useRef(null);
  // Victory-flash timer. Deliberately separate from the quality-flash
  // timer below — the two lifecycles are independent (a 2s scoreboard-bar
  // flash vs a ~900ms pill), so sharing one ref would let a catch cancel
  // the victory flash, or leave it stuck on screen.
  const flashTimerRef = useRef(null);
  // Quality-flash (CAUGHT! / Too late / Already caught pill) dismiss timer.
  const qualityTimerRef = useRef(null);
  const resultTimerRef = useRef(null);
  const confettiFiredRef = useRef(false);

  // Flash the scoreboard bar when a player crosses the 10-point line.
  const triggerVictoryFlash = useCallback((who) => {
    setFlashWinner(who);
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    flashTimerRef.current = setTimeout(() => setFlashWinner(null), 2000);
  }, []);

  // Short confetti burst when YOU cross the 10-point line. Fires once
  // per match (guard ref); visible because the result modal is held
  // back ~1.2s. Best-effort — never breaks the game if confetti fails.
  const triggerWinConfetti = useCallback(() => {
    if (confettiFiredRef.current) return;
    confettiFiredRef.current = true;
    try {
      confetti({
        particleCount: 80,
        spread: 70,
        origin: { y: 0.55 },
        colors: ["#00e5ff", "#00ffa6", "#FFD700", "#FFFFFF"],
        disableForReducedMotion: true,
      });
      setTimeout(
        () =>
          confetti({
            particleCount: 40,
            spread: 100,
            origin: { y: 0.45 },
            colors: ["#00ffa6", "#FFFFFF"],
            disableForReducedMotion: true,
          }),
        250,
      );
    } catch {
      // Best-effort — ignore.
    }
  }, []);

  // Show the short local flash pill for one catch / miss / duplicate event.
  // Every event routes through here so the dismiss timer is always tracked:
  // a newer event clears the previous timer instead of racing it (an old
  // 900ms timer must never blank a fresher flash), and the pill is only
  // ever cleared by its own event's timer. Local state only, so no poll or
  // socket update can re-show it.
  const showQualityFlash = useCallback((flash, ms = 900) => {
    setLastQuality(flash);
    if (qualityTimerRef.current) clearTimeout(qualityTimerRef.current);
    qualityTimerRef.current = setTimeout(() => {
      qualityTimerRef.current = null;
      setLastQuality(null);
    }, ms);
  }, []);

  // Clean up the victory-flash / quality-flash / result-modal timers on
  // unmount.
  useEffect(() => {
    return () => {
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
      if (qualityTimerRef.current) clearTimeout(qualityTimerRef.current);
      if (resultTimerRef.current) clearTimeout(resultTimerRef.current);
      // Drop the in-flight tap bookkeeping with the component instance so
      // no ball can be left "pending" behind a mounted page.
      pendingTapsRef.current.clear();
    };
  }, []);

  // Clear per-round miss state whenever a new round starts.
  useEffect(() => {
    const round = match?.currentRound;
    if (round && round !== lastRoundRef.current) {
      lastRoundRef.current = round;
      setMissedTiles(new Set());
      // A new round wipes both tickets, so any tap still awaiting a
      // response belongs to the finished round — drop it so the new
      // board can never show a stale pending ring.
      pendingTapsRef.current.clear();
      setPendingTaps(new Set());
    }
  }, [match?.currentRound]);

  // Resolve the [matchId] param (Next 15/16 passes params as a Promise).
  useEffect(() => {
    (async () => {
      const p = await params;
      setMatchId(Number(p?.matchId));
    })();
  }, [params]);

  const fetchStatus = useCallback(async () => {
    if (!matchId) return;
    // Monotonic request id, assigned when the read starts (not when it
    // lands), so responses can be ordered by how fresh the data is.
    const seq = (statusSeqRef.current += 1);
    try {
      const t0 = Date.now();
      const res = await fetch(`/api/keno-pvp/match/${matchId}`, {
        cache: "no-store",
      });
      const json = await res.json();
      // Clock sync: the response carries the server's clock. Estimate
      // the server↔client offset from the request midpoint (t0+t1)/2
      // and smooth it — schedule times are server-set absolutes, so
      // comparing against the server clock keeps the glow stream
      // aligned with the server's grading on devices whose clock
      // drifts. Ignore samples from slow/hung requests (bad midpoint).
      const t1 = Date.now();
      const serverTime = Number(json.data?.serverTime);
      if (Number.isFinite(serverTime) && serverTime > 0 && t1 - t0 < 2000) {
        const sample = serverTime - (t0 + t1) / 2;
        setClockOffset((prev) => (prev === 0 ? sample : prev * 0.7 + sample * 0.3));
      }
      if (!json.success) {
        if (res.status === 401) {
          router.push("/sign-in?redirect_url=" + encodeURIComponent(`/casino/keno-pvp/${matchId}`));
        }
        setError(json.error || "Failed to load match");
        return;
      }
      setError(null);
      // Newest snapshot wins: if a newer read already committed, drop this
      // older response instead of rolling `match`/`rounds` (and the round
      // banner's `prev`) back to state we have already left. Failures above
      // still take effect — they are not snapshot ordering.
      if (seq <= lastAppliedStatusSeqRef.current) return;
      lastAppliedStatusSeqRef.current = seq;
      const resolvedRounds = json.data.rounds || [];
      setMatch(json.data.match);
      setRounds(resolvedRounds);
      myCatchesRef.current = json.data.match.myCatches || [];

      const m = json.data.match;
      const prev = lastStatusRef.current;
      // Round announcement. One compact banner covers both ends of a round
      // change: which round is LIVE now, and — when this same snapshot also
      // closed the previous one — what that round resolved to. It is computed
      // against the FRESH `resolvedRounds` (the just-fetched history); the
      // state variable `rounds` is still the previous poll's value and would
      // miss the newly stamped round.
      const announcement = roundAnnouncementFor(prev, m, resolvedRounds);
      if (announcement) {
        setRoundBanner(announcement);
        if (bannerTimerRef.current) clearTimeout(bannerTimerRef.current);
        bannerTimerRef.current = setTimeout(() => setRoundBanner(null), 2600);
      }

      // Victory flash: when a player's cumulative score first crosses
      // POINTS_TO_WIN, pulse their side of the scoreboard race bar.
      // (Only fires for a real points win — a cap-tie draw or a
      // low-score finish flashes nothing.)
      if (prev && (m.result === "player1" || m.result === "player2")) {
        const winnerSeat = m.result;
        const prevWinnerScore =
          winnerSeat === "player1" ? Number(prev.p1Score) || 0 : Number(prev.p2Score) || 0;
        const newWinnerScore =
          winnerSeat === "player1" ? Number(m.p1Score) || 0 : Number(m.p2Score) || 0;
        if (newWinnerScore >= POINTS_TO_WIN && prevWinnerScore < POINTS_TO_WIN) {
          const winnerIsYou =
            winnerSeat === (m.viewerIsPlayer1 ? "player1" : "player2");
          triggerVictoryFlash(winnerIsYou ? "you" : "opp");
          if (winnerIsYou) triggerWinConfetti();
        }
      }

      // Hold the result modal back ~1.2s so the player sees the final
      // board + the victory flash before the overlay appears.
      if (m.status === "finished" && prev?.status !== "finished") {
        if (resultTimerRef.current) clearTimeout(resultTimerRef.current);
        resultTimerRef.current = setTimeout(() => setShowResult(true), 1200);
      } else if (m.status !== "finished") {
        if (resultTimerRef.current) clearTimeout(resultTimerRef.current);
        setShowResult(false);
      }
      lastStatusRef.current = m;
    } catch {
      // Network failure (e.g. ERR_INTERNET_DISCONNECTED): surface it and
      // clear the loading state so the page never sits on a blank
      // "Loading match…" screen forever. The poll keeps retrying and
      // clears the error once connectivity returns.
      setLoading(false);
      setError("Can't reach the server — check your connection. Retrying…");
    }
  }, [matchId, router, triggerVictoryFlash, triggerWinConfetti]);

  useEffect(() => {
    if (!matchId) return;
    fetchStatus();
    // Socket room (KENO_PVP_MATCH_UPDATED) already pushes opponent updates
    // instantly; this HTTP poll is a reconnect safety net. Held at 5s to
    // keep match-time DB reads minimal — turn pacing comes from server
    // deadlines + the local 100ms clock, never from the poll rate.
    const interval = setInterval(fetchStatus, 5000);
    return () => clearInterval(interval);
  }, [matchId, fetchStatus]);

  // Round-deadline nudge. A round only resolves when the server is read, so
  // without this the board can sit on a finished round for up to a whole
  // poll tick. Whenever the snapshot carries a deadline, arm ONE extra
  // status read for just after it — the same `fetchStatus` call, never a
  // second polling loop, and at most one nudge per deadline. The timer is
  // re-armed only when the deadline itself changes, and it is cleared on
  // deadline/match/unmount change by the effect cleanup below. The 5s poll
  // and the socket room are untouched and remain the safety net.
  useEffect(() => {
    const deadlineMs = match?.roundDeadline ? new Date(match.roundDeadline).getTime() : null;
    if (!matchId || deadlineMs == null || !Number.isFinite(deadlineMs)) {
      // No deadline in play (waiting / finished) — forget the last nudge.
      deadlineNudgedRef.current = null;
      return;
    }
    if (deadlineNudgedRef.current === deadlineMs) return;
    const delay = Math.max(
      0,
      deadlineMs - (Date.now() + clockOffset) + DEADLINE_NUDGE_CUSHION_MS,
    );
    const timer = setTimeout(() => {
      deadlineNudgedRef.current = deadlineMs;
      void fetchStatus();
    }, delay);
    return () => clearTimeout(timer);
  }, [matchId, match?.roundDeadline, clockOffset, fetchStatus]);

  // Socket live-update: re-poll instantly on opponent actions.
  useEffect(() => {
    if (!socket || !matchId) return;
    const roomId = kenoPvpMatchRoom(matchId);
    const refresh = () => fetchStatus();
    socket.emit("join_room", { roomId });
    socket.on(KENO_PVP_MATCH_UPDATED, refresh);
    return () => {
      socket.emit("leave_room", { roomId });
      socket.off(KENO_PVP_MATCH_UPDATED, refresh);
    };
  }, [socket, matchId, fetchStatus]);

  // Animation clock (100ms ticks drive the ball stream).
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(interval);
  }, []);

  // Subtle audio tick when a tile lights up. Synthesised with the Web
  // Audio API (no asset needed); the context is created lazily and
  // resumed on the first user gesture (browsers block audio before
  // one). Best-effort — never breaks the game if audio is unavailable.
  const playTileTick = useCallback(() => {
    try {
      const ctx = getSharedAudioContext();
      if (!ctx) return;
      if (ctx.state !== "running") return;
      const t = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "triangle";
      osc.frequency.setValueAtTime(880, t);
      osc.frequency.exponentialRampToValueAtTime(660, t + 0.08);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.12, t + 0.005);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
      osc.connect(gain).connect(getSharedOutputNode() || ctx.destination);
      osc.start(t);
      osc.stop(t + 0.1);
    } catch {
      // Audio is best-effort — ignore.
    }
  }, []);

  // Unlock the shared audio context on the first user gesture
  // (autoplay policy) — the same one playTileTick routes through.
  useEffect(() => {
    const unlock = () => {
      try {
        const ctx = getSharedAudioContext();
        if (ctx && ctx.state === "suspended") ctx.resume();
      } catch {
        // ignore
      }
    };
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);

  // Server-view of "now" (client now + measured offset). The release
  // schedule is derived from the server-set round deadline, so all
  // timing comparisons must use the server clock — otherwise a device
  // clock that drifts would make tiles glow at the wrong moment.
  const serverNow = now + clockOffset;

  useEffect(() => {
    setLoading(false);
  }, [match]);

  const isRound = match && /^round_\d+$/.test(match.status || "");
  const isWaiting = match?.status === "waiting";
  const isReady = match?.status === "ready";
  // 30-second countdown after the 3-minute match clock expires with
  // nobody at POINTS_TO_WIN — most tiles wins when it hits zero.
  const isOvertime = match?.status === "overtime";
  const isFinished = match?.status === "finished";
  const isCancelled = match?.status === "cancelled";

  // The release schedule for the current round, derived server-style
  // from the round deadline (identical for both players).
  const schedule = useMemo(() => {
    if (!isRound || !match?.roundDeadline) return [];
    return ballSchedule(new Date(match.roundDeadline).getTime(), match.currentDraw || []);
  }, [isRound, match?.roundDeadline, match?.currentDraw]);

  // Latest committed values for the tap handler. `doCatch` is handed to all 40
  // tiles (in both board copies), so it has to keep a STABLE identity across
  // the 100ms board clock — otherwise every tile gets a new click handler ten
  // times a second and no tile can ever be memoized. These refs carry the
  // current schedule / clock offset / AI flag into the handler without making
  // it depend on them; they are written after each commit, so a tap reads the
  // values the board is already rendering.
  const scheduleRef = useRef(schedule);
  const clockOffsetRef = useRef(clockOffset);
  const isAiRef = useRef(Boolean(match?.isAi));
  useEffect(() => {
    scheduleRef.current = schedule;
    clockOffsetRef.current = clockOffset;
    isAiRef.current = Boolean(match?.isAi);
  });

  // ONE pass over the (≤10 ball) schedule per tick for both time-derived board
  // states: the tile currently GLOWING (inside its visible 0.8s window —
  // bright cyan with the shrinking ring) and how many balls have been released
  // so far. This replaces two separate memos that each rescanned the schedule,
  // one of which rebuilt a Set on every tick for a value the board only ever
  // displays as a count (`n / 20 drawn`).
  const { activeTile, drawnCount } = useMemo(() => {
    let active = null;
    let drawn = 0;
    for (const b of schedule) {
      if (serverNow >= b.releaseMs) drawn += 1;
      if (serverNow >= b.releaseMs && serverNow < b.expiresMs) active = b;
    }
    return { activeTile: active, drawnCount: drawn };
  }, [schedule, serverNow]);

  // Play the audio tick each time a NEW tile lights up (fires once per
  // tile — activeTile?.number changes only when the glowing tile does).
  useEffect(() => {
    if (activeTile?.number != null) playTileTick();
  }, [activeTile?.number, playTileTick]);

  // Result sting, fired with the result PANEL (the same moment the modal and
  // the confetti land) rather than the instant the row settles. `showResult`
  // flips exactly once per finished match — it is armed by the
  // finished-transition only and cleared whenever the match leaves the
  // finished state — and the guard ref makes the sound fire once even if more
  // snapshots arrive, so polling can never replay the fanfare. Re-armed on a
  // rematch, like the other PvP pages. Draw → neutral tick, else win/loss.
  const resultSoundFiredRef = useRef(false);
  useEffect(() => {
    if (!isFinished) {
      resultSoundFiredRef.current = false;
      return;
    }
    if (!showResult || resultSoundFiredRef.current) return;
    resultSoundFiredRef.current = true;
    if (!match?.result || match.result === "draw") playTick();
    else if (match.result === (match.viewerIsPlayer1 ? "player1" : "player2")) playVictory();
    else playDefeat();
  }, [isFinished, showResult, match?.result, match?.viewerIsPlayer1]);

  const roundEndMs = match?.roundDeadline ? new Date(match.roundDeadline).getTime() : 0;
  const roundTimeLeft = Math.max(0, Math.ceil((roundEndMs - serverNow) / 1000));

  // No `currentRound` dependency: the server sends a fresh `myCatches` array
  // for every round (and only ever appends to the current one), so a new round
  // invalidates this memo on its own — the round number was a redundant extra
  // dependency that recomputed the stats for nothing.
  const myStats = useMemo(() => computeRoundStats(match?.myCatches || []), [match?.myCatches]);

  const caughtNumbers = useMemo(
    () => new Set((match?.myCatches || []).map((c) => c.number)),
    [match?.myCatches],
  );

  // The most recently COMPLETED round. `rounds` is ordered by round number
  // and only ever carries resolved rounds (the server writes the history row
  // at resolution), so its last entry is "the round that just ended". It
  // drives both the gold board state and the recap strip under the board.
  const lastResolvedRound = useMemo(
    () => (Array.isArray(rounds) && rounds.length > 0 ? rounds[rounds.length - 1] : null),
    [rounds],
  );

  // The opponent's numbers for that round (numerically ordered), used for
  // both the gold board state and the recap strip's ticket row — derived from
  // one source so the two can never disagree.
  const oppResolvedTiles = useMemo(
    () => oppResolvedTilesFor(rounds, Boolean(match?.viewerIsPlayer1)),
    [rounds, match?.viewerIsPlayer1],
  );
  const oppRevealedNumbers = useMemo(() => new Set(oppResolvedTiles), [oppResolvedTiles]);

  // ── Pre-modal final-board hold ────────────────────────────────────
  // The moment a match finishes the server clears the live round
  // (currentDraw, both catch lists and the round deadline), so `isRound`
  // goes false and the whole board/tickets block used to vanish at once —
  // leaving an empty page (and an empty recording frame) for the ~1.2s
  // before the result modal. During that window the board now stays up,
  // rebuilt from the FINAL round's own resolved history row (the same public
  // row the recap strip reads): its shared draw, both catch lists and both
  // round scores. No new server data is invented.
  // The board is FROZEN — every drawn ball settled (past release, past
  // expiry), nothing glowing, nothing in the grace tail, nothing tappable.
  // Guarded on the resolved row actually being the round the match ended on,
  // so a forfeit (a round that never resolved) shows no stale board.
  const finalHoldBoard = useMemo(
    () =>
      isFinished
        ? finalBoardFromResolvedRound(
            lastResolvedRound,
            Boolean(match?.viewerIsPlayer1),
            match?.currentRound,
          )
        : null,
    [isFinished, lastResolvedRound, match?.viewerIsPlayer1, match?.currentRound],
  );

  const isFinalHold = finalHoldBoard != null;

  // What the board / tickets / points table render from: the live round, or
  // the frozen final round while the result modal is still pending. Only the
  // SOURCE changes — every animation and class below is untouched, so the
  // held board is the same board, just settled and non-interactive.
  const boardSchedule = finalHoldBoard ? finalHoldBoard.schedule : schedule;
  // The board only displays this as a count, so the live round derives a
  // number and the held board (built once per round) reports its Set's size.
  const boardDrawnCount = finalHoldBoard ? finalHoldBoard.drawnNumbers.size : drawnCount;
  const boardCaughtNumbers = finalHoldBoard ? finalHoldBoard.caughtNumbers : caughtNumbers;
  // `match` is null until the first status read lands, and these two lines sit
  // ABOVE the loading / not-found early returns below (every hook above them
  // has to run on every render). Dereferencing `match` directly threw
  // "Cannot read properties of null (reading 'myCatches')" on the very first
  // render — including the server pass — so the whole page died into Next's
  // blank "Application error" shell instead of ever showing the board.
  const boardMyCatches = finalHoldBoard ? finalHoldBoard.myCatches : match?.myCatches || [];
  const boardMyStats = finalHoldBoard ? finalHoldBoard.myStats : myStats;
  // The live opponent count is scrubbed away on settlement, so the held board
  // uses the final round's resolved catch count (already public) instead.
  const boardOppCatchCount = finalHoldBoard ? oppResolvedTiles.length : match?.opponentCatchCount;

  // O(1) ball lookup for the tile grid. Every tile used to scan
  // `boardSchedule` (40 × ≤10 comparisons on each 100ms tick) just to find its
  // own ball; this is rebuilt only when the round's schedule changes.
  const ballByNumber = useMemo(() => {
    const map = new Map();
    for (const b of boardSchedule) map.set(b.number, b);
    return map;
  }, [boardSchedule]);

  // Live opponent catch count — the ONLY live information the server ever
  // exposes about the opponent's ticket (their count, never which tiles).
  // The pop is keyed on the count VALUE, so it fires when the count actually
  // changes and never on an ordinary rerender, the 100ms board clock, or a
  // poll that returns the same count. Shared by the normal page and the
  // creator frame so both read identically.
  const opponentCatchCountNode = (
    <motion.span
      key={`opp-caught-${boardOppCatchCount}`}
      {...withReducedMotion(shouldReduceMotion, {
        initial: { scale: 0.65, opacity: 0.45 },
        animate: { scale: 1, opacity: 1 },
        transition: { duration: 0.22, ease: "easeOut" },
      })}
      className="inline-block font-black text-[#FFD700]"
    >
      {boardOppCatchCount}
    </motion.span>
  );

  const doCatch = useCallback(
    async (tileNumber) => {
      if (!matchId) return;
      // Only taps on tiles that have STARTED glowing reach the server —
      // a tile that hasn't lit up yet is not a miss, it's just not due.
      // (Uses the server-viewed clock so it agrees with the server.)
      const ball = scheduleRef.current.find((b) => b.number === tileNumber);
      // Read the server clock FRESH at tap time instead of from the last
      // render: a tile only becomes tappable on a render where it is already
      // released, so a slightly newer reading can never reject a tap the board
      // just offered — while a 100ms-old one could.
      const tapNow = Date.now() + clockOffsetRef.current;
      if (!ball || tapNow < ball.releaseMs) return;
      if ((myCatchesRef.current || []).some((c) => c.number === tileNumber)) return;
      // One in-flight attempt per ball. Tiles stay tappable while a request
      // is out and `myCatchesRef` only learns about the catch when the
      // response lands, so without this guard two fast taps on the same
      // ball both reach the server.
      if (pendingTapsRef.current.has(tileNumber)) return;

      // Instant acknowledgement: this tap is registered locally and on its
      // way. It deliberately does NOT claim the catch (only the server
      // can) — it just stops the tap feeling dropped.
      pendingTapsRef.current.add(tileNumber);
      setPendingTaps((prev) => new Set(prev).add(tileNumber));

      try {
        const res = await fetch(`/api/keno-pvp/match/${matchId}/catch`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ ball: tileNumber }),
        });
        const json = await res.json();
        if (!json.success) {
          const reason = json.error || "";
          // Idempotent duplicate: the ball is already on OUR ticket
          // server-side, so this tap gained nothing — but it is NOT a
          // miss and the tile must not turn red. If this client already
          // knows about the catch there is nothing left to say (the tile
          // is already green); otherwise say so plainly.
          if (reason === ALREADY_CAUGHT_REASON) {
            if (!(myCatchesRef.current || []).some((c) => c.number === tileNumber)) {
              showQualityFlash({
                ball: tileNumber,
                quality: "duplicate",
                text: "Already caught",
              });
            }
            return;
          }
          // Only a genuine tap miss turns the tile red — a transient
          // transport / auth / server failure is not the player's fault,
          // and the status poll reconciles it.
          if (!TAP_MISS_REASONS.has(reason)) return;
          setMissedTiles((prev) => new Set(prev).add(tileNumber));
          showQualityFlash({ ball: tileNumber, quality: "missed", text: missTextFor(reason) });
          // Negative sting, once per genuine local miss. This is the ONLY miss
          // path (an unmapped/transport failure returned above, and a duplicate
          // took the idempotent branch), and it only ever runs for a request
          // this player actually made — polling and socket updates never reach
          // doCatch, so they can never replay it.
          playBuzz();
          return;
        }
        showQualityFlash({ ball: tileNumber, quality: "caught" });
        // Positive chime, once per ACTUAL catch — this is the server-confirmed
        // success branch, i.e. exactly one sound per catch. Catches the player
        // never made (the opponent's, or a round resolved by the server) arrive
        // through polling/socket snapshots instead, which never sound here.
        playGoodReveal();
        myCatchesRef.current = [...myCatchesRef.current, json.data.catch];
        setMatch((prev) => {
          if (!prev) return prev;
          const mine = [...(prev.myCatches || []), json.data.catch];
          return { ...prev, myCatches: mine };
        });
        posthog?.capture("keno_pvp_caught", {
          match_id: matchId,
          ball: tileNumber,
          quality: json.data.catch.quality,
        });
        socket?.emit("room_event", {
          roomId: kenoPvpMatchRoom(matchId),
          event: KENO_PVP_MATCH_UPDATED,
        });
        // Best-effort AI trigger after a human catch. The server also
        // runs this from status polling, so a failed trigger is safe.
        if (isAiRef.current) {
          void fetch(`/api/keno-pvp/match/${matchId}/ai-turn`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({}),
          }).catch(() => {});
        }
      } catch {
        // Network failure — silent; the poll will reconcile.
      } finally {
        // Never leave a ball stuck as pending: this runs on success, on
        // every failure return above, and on a thrown/aborted request.
        pendingTapsRef.current.delete(tileNumber);
        setPendingTaps((prev) => {
          if (!prev.has(tileNumber)) return prev;
          const next = new Set(prev);
          next.delete(tileNumber);
          return next;
        });
      }
    },
    [matchId, posthog, socket, showQualityFlash],
  );

  // The 1–40 board, built once per render as memoized tiles. Creating the
  // elements is cheap; what used to be expensive was the 40 button bodies
  // re-rendering on the 100ms clock, which `KenoTile`'s shallow prop compare
  // now skips — per tick only the glowing tile re-renders (its countdown ring),
  // plus any tile whose own state actually changed.
  const kenoTilesNode = KENO_NUMBERS.map((num) => {
    const ball = ballByNumber.get(num);
    const isActive = activeTile?.number === num;
    const released = !!ball && serverNow >= ball.releaseMs;
    return (
      <KenoTile
        key={num}
        num={num}
        released={released}
        isActive={isActive}
        ringSeconds={isActive && ball ? (ball.expiresMs - serverNow) / 1000 : null}
        inGraceTail={!!ball && serverNow >= ball.expiresMs && serverNow < ball.acceptedUntilMs}
        caught={boardCaughtNumbers.has(num)}
        oppCaught={oppRevealedNumbers.has(num)}
        missed={missedTiles.has(num)}
        pending={pendingTaps.has(num)}
        frozen={isFinalHold}
        onCatch={doCatch}
      />
    );
  });

  const goToLobby = useCallback(() => {
    if (leaving) return;
    setLeaving(true);
    router.push("/casino/keno");
  }, [leaving, router]);

  const cancelMatch = useCallback(async () => {
    if (!matchId) return;
    try {
      await fetch(`/api/keno-pvp/match/${matchId}/cancel`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
      });
      socket?.emit("room_event", { roomId: "lobby:keno-pvp", event: "lobby:updated" });
      goToLobby();
    } catch {
      // Silent
    }
  }, [matchId, socket, goToLobby]);

  // Emote wiring must be called on EVERY render (rules of hooks), so it
  // lives ABOVE the loading/match early returns below — the old position
  // skipped it on the loading paint and React threw "Rendered more hooks
  // than during the previous render" the moment the first status poll
  // landed (i.e. right after starting any match). selfId stays null until
  // the match loads; the socket room only joins once matchId resolves,
  // so no emote can arrive before then.
  const { incomingEmote, myEmote, sendEmote } = useGameEmotes({
    socket,
    roomId: matchId ? `keno:emote:${matchId}` : null,
    eventName: "keno:emote",
    selfId: match ? (match.viewerIsPlayer1 ? "player1" : "player2") : null,
  });

  if (loading && !match) {
    return (
      <div className="min-h-screen bg-[#001933] text-white flex items-center justify-center">
        <p className="animate-pulse">Loading match…</p>
      </div>
    );
  }

  if (!match) {
    return (
      <div className="min-h-screen bg-[#001933] text-white flex items-center justify-center">
        <div className="text-center space-y-4">
          <p className="text-lg">{error || "Match not found"}</p>
          <button
            onClick={goToLobby}
            className="px-5 py-2 rounded-lg bg-[#00e5ff] text-[#001933] font-bold"
          >
            Back to Keno Lobby
          </button>
        </div>
      </div>
    );
  }

  const me = match.viewerIsPlayer1 ? "player1" : "player2";
  const opponent = match.viewerIsPlayer1 ? "player2" : "player1";
  const myWins = match.viewerIsPlayer1 ? match.roundsWonPlayer1 : match.roundsWonPlayer2;
  const oppWins = match.viewerIsPlayer1 ? match.roundsWonPlayer2 : match.roundsWonPlayer1;
  const myPts = match.viewerIsPlayer1 ? match.p1Score : match.p2Score;
  const oppPts = match.viewerIsPlayer1 ? match.p2Score : match.p1Score;

  const p1Name = match.players?.p1?.displayName || match.player1Id?.slice(0, 6) || "P1";
  const p2Name = match.isAi
    ? "GRYND AI"
    : match.players?.p2?.displayName || match.player2Id?.slice(0, 6) || "P2";
  const oppName = me === "player1" ? p2Name : p1Name;

  // Seat identity — the server already enriches `players` with the
  // official Grynd icon key + equipped name color per seat; the AI
  // seat stays null and falls back to the GRYND AI label.
  const mySeatSummary = match.players?.[me] ?? null;
  const oppSeatSummary = match.players?.[opponent] ?? null;
  const mySeatIcon = mySeatSummary?.iconKey || null;
  const oppSeatIcon = oppSeatSummary?.iconKey || null;
  const mySeatProfileFrame = mySeatSummary?.profileFrame || null;
  const oppSeatProfileFrame = oppSeatSummary?.profileFrame || null;
  const myNameColor = mySeatSummary?.nameColor || null;
  const oppNameColor = oppSeatSummary?.nameColor || null;
  const myNameEffect =
    cosmeticEffectClass(mySeatSummary?.profileFrame?.usernameEffect?.visual) || "";
  const oppNameEffect =
    cosmeticEffectClass(oppSeatSummary?.profileFrame?.usernameEffect?.visual) || "";

  // ── Creator Mode arrangement ──────────────────────────────────────
  // The SAME game content composes the normal page and the creator
  // frames (portrait phone-style + landscape/square rail), mirroring
  // Tower Arena / Mines Duel. Layout only — no game logic touched.

  // Race to POINTS_TO_WIN — each player fills toward the centre line (mine
  // from the left, the opponent's from the right). The 500ms slide is the
  // only motion, plus the one-shot victory flash when someone crosses the
  // line; the `n/10` labels at each end spell out the objective so the bar
  // never has to be guessed. Shared by the normal page and the creator frame
  // so both show exactly the same progress.
  const raceBarNode = (
    <div
      className="relative h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-white/10"
      title={`You ${myPts}/${POINTS_TO_WIN} · ${oppName} ${oppPts}/${POINTS_TO_WIN}`}
    >
      <div
        className={`absolute inset-y-0 left-0 rounded-full bg-[#00ffa6] transition-all duration-500${raceBarTone(
          "you",
          flashWinner,
          shouldReduceMotion
        )}`}
        style={{
          width: `${Math.min(50, (myPts / POINTS_TO_WIN) * 50)}%`,
          // Victory flash when YOU cross the 10-point line. Skipped with
          // motion off (the static emphasis above carries it instead).
          animation:
            flashWinner === "you" && !shouldReduceMotion
              ? "kenoGlowGreen 0.8s ease-in-out 2"
              : undefined,
        }}
      />
      <div
        className={`absolute inset-y-0 right-0 rounded-full bg-[#FFD700] transition-all duration-500${raceBarTone(
          "opp",
          flashWinner,
          shouldReduceMotion
        )}`}
        style={{
          width: `${Math.min(50, (oppPts / POINTS_TO_WIN) * 50)}%`,
          // Victory flash when the OPPONENT crosses the line.
          animation:
            flashWinner === "opp" && !shouldReduceMotion
              ? "kenoGlowGold 0.8s ease-in-out 2"
              : undefined,
        }}
      />
      <div className="absolute inset-y-0 left-1/2 w-px bg-white/40" />
    </div>
  );

  // Rounds won — the shared best-of tracker (blue = you, red = them). Only the
  // newest dot springs in; every earlier dot renders without initial/animate
  // and keeps its key across rerenders, so nothing replays.
  const roundTrackerNode = (
    <RoundMarkers
      total={MAX_ROUNDS}
      myWins={myWins}
      oppWins={oppWins}
      myLabel="You"
      oppLabel={oppName}
      compact
    />
  );

  // Round announcement — ONE compact banner, shared by the normal page and
  // the creator frame so the cue is never outside the recording frame. It
  // rides the existing AnimatePresence + bannerTimerRef system: the state
  // cycles null → object → null per announcement, so it pops once and then
  // clears itself. It is in flow (never an overlay), so the board below it
  // stays immediately playable — no intermission.
  const roundBannerNode = (
    <AnimatePresence>
      {roundBanner && (
        <motion.div
          key={`${roundBanner.liveRound ?? "-"}:${roundBanner.resolvedRound ?? "-"}`}
          {...withReducedMotion(shouldReduceMotion, {
            initial: { opacity: 0, y: -8 },
            animate: { opacity: 1, y: 0 },
            exit: { opacity: 0, y: -8 },
          })}
          className="mb-3 rounded-lg border border-[#00ffa6]/40 bg-[#00ffa6]/10 px-3 py-2 text-center text-sm font-semibold text-[#7cefff]"
        >
          {roundBannerText(roundBanner)}
        </motion.div>
      )}
    </AnimatePresence>
  );

  // Round status line + glow hint + emotes (live round only)
  const roundStatusNode = (
    <div className="relative rounded-2xl border border-[#00e5ff]/35 bg-[#050d1f]/80 p-3 shadow-[0_0_25px_rgba(0,229,255,0.15)] sm:p-6">
      <div className="mb-2.5 flex items-center justify-between gap-2 text-xs text-white/60 sm:mb-4">
        <span className="font-bold text-[#FFD700] uppercase tracking-wider">
          Round {match.currentRound} · first to {POINTS_TO_WIN} pts
        </span>
        <span>{isFinalHold ? "final" : `${roundTimeLeft}s left`}</span>
      </div>
      <div className="flex flex-col items-center gap-1 sm:gap-2">
        {/* ONE calm status line (no pulse): the glowing tile is the
            urgency, this only says what to do. Two states — the live
            instruction, and the wait for the next ball — instead of the
            old per-ball three-message cycle. During the pre-modal hold it
            names the settled board instead, so a finished round never
            shows a tap prompt. */}
        {isFinalHold ? (
          <p className="text-sm font-bold text-[#00ffa6]">
            Final board — round {match.currentRound} complete
          </p>
        ) : activeTile ? (
          <p className="text-sm font-bold text-[#00e5ff]">Tap tile {activeTile.number}</p>
        ) : (
          <p className="text-sm text-white/50">
            {roundTimeLeft > 0 ? "Next tile incoming…" : "Resolving round…"}
          </p>
        )}
        {/* Secondary explainer — dropped on phones so the board (not the
            hint stack) is what dominates the first screen. */}
        <p className="hidden text-[11px] text-white/40 sm:block">
          Each tile glows for {GLOW_MS / 1000}s. Tap it while the ring is shrinking. Green = caught · Red = missed.
        </p>
      </div>
      <div className="mt-1.5 flex justify-center">
        <EmotePicker
          compact
          hideBubbles
          incomingEmote={incomingEmote}
          myEmote={myEmote}
          onSend={(emote) => sendEmote(emote)}
        />
      </div>
      <AnimatePresence>
        {lastQuality && (
          // Keyed on the event (ball + quality) so every genuine local
          // catch / miss / duplicate gets its own pop — the pill used to
          // stay mounted through a text swap, which made a second catch
          // look dead. Polls and socket pushes never touch lastQuality,
          // so they can't replay it.
          <motion.div
            key={`${lastQuality.ball}:${lastQuality.quality}`}
            {...withReducedMotion(shouldReduceMotion, {
              initial: { opacity: 0, scale: 0.7 },
              animate: { opacity: 1, scale: 1 },
              exit: { opacity: 0, scale: 0.7 },
            })}
            className="pointer-events-none absolute inset-x-0 bottom-2 z-40 flex justify-center"
          >
            <span
              className={`rounded-full border px-5 py-2 text-lg font-black tracking-widest shadow-lg ${
                FLASH_LABEL[lastQuality.quality]?.cls || "text-white border-white/40 bg-black/60"
              }`}
            >
              {flashLabelFor(lastQuality.quality, lastQuality)}
            </span>
            {/* With motion off `withReducedMotion` renders this at its natural
                state: the pill still appears for its full 900ms (so a catch /
                miss is still acknowledged), it just no longer scales in. */}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );

  // Keno board — the main play visual. The creator frame lays the game
  // out at phone width (see CreatorPhoneFrame below), so the board uses
  // the classic 8-col × 5-row keno grid with fluid tiles: it fills the
  // phone width and only 5 rows tall, so the board is the big dominant
  // element instead of a small centered box.
  const boardNode = (
    <div className="relative rounded-2xl border border-[#00e5ff]/35 bg-[#050d1f]/70 p-3 sm:p-5">
      {/* Round-reset cue: one short edge fade when a new round takes the
          board, so the reset reads as "new round" rather than the tiles
          blinking out. A single element keyed by the round number — the 40
          tiles are never animated individually. */}
      {/* Skipped entirely with motion off: this cue fades TO transparent, so a
          "static" version would leave a solid border stuck over the board. The
          round banner and the round label still announce the change. */}
      {isRound && !shouldReduceMotion && (
        <motion.span
          key={`round-reset-${match.currentRound}`}
          initial={{ opacity: 0.5 }}
          animate={{ opacity: 0 }}
          transition={{ duration: 0.45, ease: "easeOut" }}
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 rounded-2xl border-2 border-[#00e5ff]/70"
        />
      )}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-bold uppercase tracking-wider text-[#7cefff]">
          <span className="inline-flex items-center gap-1.5"><PoolBallIcon size={16} className="text-[#00e5ff]" /> Keno Board 1–{KENO_POOL_SIZE}</span>
        </h3>
        <span className="text-xs text-white/50">
          {boardDrawnCount} / {BALL_COUNT} drawn
          {oppRevealedNumbers.size > 0 && (
            <span className="ml-2 text-[#FFD700]/80">
              · R{lastResolvedRound.roundNumber}: {oppRevealedNumbers.size} opponent caught
            </span>
          )}
        </span>
      </div>
      {/* One shared board geometry (normal + creator): 8 fluid columns of
          SQUARE tiles, so the grid always fills the width it is given and
          keeps keno's 8x5 shape. The `max-w` caps the tiles on wide screens
          (a full-width 8-col grid on desktop would give ~100px tiles); on a
          phone the cap never applies and the tiles land at 29-44px depending
          on the viewport. */}
      <div
        className={`mx-auto grid w-full max-w-[30rem] grid-cols-8 gap-1 sm:gap-2${
          isFinalHold ? " pointer-events-none" : ""
        }`}
      >
        {kenoTilesNode}
      </div>
      {/* Inline points table — live highlight on the current tier */}
      <div className="mt-4 border-t border-[#00e5ff]/20 pt-3">
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <h4 className="text-[11px] font-bold uppercase tracking-wider text-white/40">
            Points: tiles caught → score
          </h4>
          <span className="text-[11px] font-semibold text-[#00ffa6]">
            {boardMyStats.caught} caught · {boardMyStats.score} pts
          </span>
        </div>
        <div className="grid grid-cols-5 gap-1.5">
          {POINTS_TABLE.map(([caught, pts]) => {
            const isCurrent = caught === boardMyStats.caught;
            return (
              <div
                key={caught}
                className={`rounded-md border px-1 py-1 text-center transition-colors ${
                  isCurrent
                    ? "border-[#00ffa6]/80 bg-[#00ffa6]/15 shadow-[0_0_10px_rgba(0,255,166,0.35)]"
                    : "border-[#00e5ff]/20 bg-[#0b224f]/60"
                }`}
              >
                <div className={`text-[10px] font-bold ${isCurrent ? "text-[#00ffa6]" : "text-[#FFD700]"}`}>
                  {caught}
                </div>
                <div className={`text-[11px] font-black ${isCurrent ? "text-white" : "text-[#00ffa6]"}`}>
                  {pts}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {oppRevealedNumbers.size > 0 && (
        <p className="mt-3 text-[11px] text-white/40">
          <span className="text-[#FFD700]">Gold</span> = the numbers {oppName} caught in round{" "}
          {lastResolvedRound.roundNumber}, the last completed round. It resets with each new round;
          their LIVE ticket stays hidden until the round ends.
        </p>
      )}
    </div>
  );

  // Compact tickets strip for the phone frame — two small side-by-side
  // cards keep the caught-numbers info (and the opponent's live catch
  // count) visible without the vertical space a full stack would eat, so
  // header → board → status all stay above the fold in portrait.
  const creatorTicketsNode = (
    <div className="grid grid-cols-2 gap-2">
      <div className="rounded-xl border border-[#00ffa6]/30 bg-[#050d1f]/70 p-2.5">
        <div className="flex items-center justify-between gap-1">
          <span className="text-[10px] font-bold uppercase tracking-wider text-[#00ffa6]">You</span>
          <span className="shrink-0 text-[10px] font-black text-[#00ffa6]">
            {boardMyStats.score} pts
          </span>
        </div>
        <div className="mt-1.5 flex flex-wrap gap-1">
          {boardMyCatches.length === 0 ? (
            <p className="text-[10px] text-white/40">Catch some tiles!</p>
          ) : (
            boardMyCatches.map((c) => (
              <span
                key={c.number}
                className="rounded-md border border-[#00ffa6]/50 bg-[#00ffa6]/15 px-1.5 py-0.5 text-[11px] font-bold leading-none text-[#00ffa6]"
              >
                {c.number}
              </span>
            ))
          )}
        </div>
      </div>
      <div className="rounded-xl border border-[#FFD700]/30 bg-[#050d1f]/70 p-2.5">
        <div className="flex items-center justify-between gap-1">
          <span className="truncate text-[10px] font-bold uppercase tracking-wider text-[#FFD700]">{oppName}</span>
          <span className="shrink-0 text-[10px] font-black text-[#FFD700]">
            {opponentCatchCountNode} caught
          </span>
        </div>
        <p className="mt-1.5 text-[10px] leading-snug text-white/40">
          Opponent&apos;s ticket stays hidden until each round ends.
        </p>
      </div>
    </div>
  );

  // Last completed round — one compact recap under the board, so a round
  // change leaves something readable behind instead of the board just
  // resetting into thin air. Public data only: a resolved round is always
  // public (the server scrubs catches for the LIVE round only), and it
  // survives for the whole next round, unlike the 2.6s banner. Shared by the
  // normal page and the creator frame.
  const lastRoundMyScore = lastResolvedRound
    ? Number(
        match.viewerIsPlayer1 ? lastResolvedRound.player1Score : lastResolvedRound.player2Score
      ) || 0
    : 0;
  const lastRoundOppScore = lastResolvedRound
    ? Number(
        match.viewerIsPlayer1 ? lastResolvedRound.player2Score : lastResolvedRound.player1Score
      ) || 0
    : 0;
  const lastRoundResult = !lastResolvedRound
    ? null
    : !lastResolvedRound.roundWinner || lastResolvedRound.roundWinner === "draw"
      ? "draw"
      : lastResolvedRound.roundWinner === me
        ? "you won it"
        : "opponent won it";
  const lastRoundSummaryNode = lastResolvedRound ? (
    <div className="rounded-xl border border-white/10 bg-[#050d1f]/60 px-3 py-2 text-[11px]">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <span className="font-bold uppercase tracking-wider text-white/40">Last round</span>
        <span className="font-semibold text-white/70">
          Round {lastResolvedRound.roundNumber} ·{" "}
          <span className="font-black text-[#00ffa6]">{lastRoundMyScore}</span>
          <span className="text-white/30">–</span>
          <span className="font-black text-[#FFD700]">{lastRoundOppScore}</span> ·{" "}
          {lastRoundResult}
        </span>
      </div>
      {/* The opponent's ticket for that round. Their catches are already
          public once the round resolves (and already painted gold on the
          board), so spelling them out adds no information — it just makes
          the completed round readable. The LIVE round stays count-only. */}
      <div className="mt-1 flex flex-wrap items-center gap-1">
        <span className="shrink-0 text-[10px] uppercase tracking-wider text-white/35">
          {oppName} caught
        </span>
        {oppResolvedTiles.length === 0 ? (
          <span className="text-[10px] text-white/35">none</span>
        ) : (
          oppResolvedTiles.map((n) => (
            <span
              key={n}
              className="rounded-md border border-[#FFD700]/50 bg-[#FFD700]/15 px-1.5 py-0.5 text-[10px] font-bold leading-none text-[#FFD700]"
            >
              {n}
            </span>
          ))
        )}
      </div>
    </div>
  ) : null;

  // Leave control (live match)
  const leaveNode = !isFinished && !isCancelled && !isWaiting ? (
    <div className="flex justify-center">
      <button
        onClick={goToLobby}
        disabled={leaving}
        className="px-4 py-2 rounded-lg text-xs text-white/50 border border-white/15 hover:text-white hover:border-white/40 transition disabled:opacity-50"
      >
        {leaving ? "Leaving…" : "Leave match (forfeit)"}
      </button>
    </div>
  ) : null;

  // Compact header for the creator frames
  const compactHeaderNode = (
    <>
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <PoolBallIcon size={18} className="shrink-0 text-[#00e5ff]" />
          <h1 className="truncate text-base font-extrabold tracking-tight text-cyan-100">
            Keno Catch Duel
          </h1>
          <button
            onClick={() => setShowRules(true)}
            className="h-6 w-6 shrink-0 rounded-full border border-[#00e5ff]/40 bg-[#0b224f]/70 text-xs font-bold text-[#7cefff] transition hover:border-[#00e5ff]/80 hover:text-white"
            aria-label="How to play"
            title="How to play"
          >
            ?
          </button>
        </div>
        <div className="flex shrink-0 items-center gap-1.5 text-[11px] font-bold">
          <span className="inline-flex items-center gap-1 rounded-full border border-[#00ffa6]/40 bg-[#00ffa6]/15 px-2 py-0.5 text-[#00ffa6]">
            <FrameAvatar frame={mySeatProfileFrame} iconKey={mySeatIcon} name={me === "player1" ? p1Name : p2Name} size="h-3.5 w-3.5" />
            <span className={`max-w-[7rem] truncate ${myNameEffect}`} style={myNameColor ? { color: myNameColor } : undefined}>
              {me === "player1" ? p1Name : p2Name}
            </span>
            <ScoreNumber value={myPts} className="font-black" />
          </span>
          <span className="inline-flex items-center gap-1 rounded-full border border-[#FFD700]/40 bg-[#FFD700]/15 px-2 py-0.5 text-[#FFD700]">
            <span className={`max-w-[7rem] truncate ${oppNameEffect}`} style={oppNameColor ? { color: oppNameColor } : undefined}>
              {oppName}
            </span>
            <ScoreNumber value={oppPts} className="font-black" />
            <FrameAvatar frame={oppSeatProfileFrame} iconKey={oppSeatIcon} name={oppName} size="h-3.5 w-3.5" />
          </span>
        </div>
      </div>
      {/* Race to 10 + rounds won — the same scoreboard the normal page shows,
          sized for the phone frame. The audit found only the normal layout
          had them, so a creator recording never showed the objective. */}
      <div className="mt-1.5 flex items-center gap-2">
        <span className="shrink-0 text-[10px] font-bold tabular-nums text-[#00ffa6]">
          {myPts}/{POINTS_TO_WIN}
        </span>
        {raceBarNode}
        <span className="shrink-0 text-[10px] font-bold tabular-nums text-[#FFD700]">
          {oppPts}/{POINTS_TO_WIN}
        </span>
      </div>
      <div className="mt-1 flex items-center justify-between gap-2 text-[11px] font-semibold">
        <span className="truncate text-cyan-200">
          {isRound ? `Round ${match.currentRound}` : isOvertime ? "Overtime" : "Match"}
        </span>
        <span className="shrink-0 text-white/50">
          {isRound ? `${roundTimeLeft}s left` : `Stake ${Number(match.stakeAmount).toLocaleString()}`}
        </span>
      </div>
      {/* Rounds won — the tracker gets its own centred row: MAX_ROUNDS dots
          are too wide to share a row with the round/time text at phone width. */}
      <div className="mt-1 flex items-center justify-center gap-2">
        {roundTrackerNode}
        <span className="shrink-0 text-[10px] font-bold text-white/55">
          {myWins}–{oppWins}
        </span>
      </div>
    </>
  );

  // Creator-mode phone screen (same treatment as Blackjack / Memory Grid
  // / Pool Masters): the whole game is laid out at a real phone width
  // (390px) inside <CreatorPhoneFrame> and `zoom`ed up to fill the
  // selected recording frame — so the board fills the frame and the
  // status / tickets sit directly below it like a mobile app, instead of
  // a desktop page shrunken into a small centered box. The 8-col classic
  // keno grid (5 rows) keeps the board compact enough that header → board
  // → hint → tickets all fit the phone viewport in portrait.
  const creatorGameNode = (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 px-3 pb-1.5 pt-2">{compactHeaderNode}</div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 py-2">
        <div className="w-full">{roundBannerNode}</div>
        <div className="w-full">{boardNode}</div>
        {lastRoundSummaryNode && <div className="mt-3 w-full">{lastRoundSummaryNode}</div>}
        <div className="mt-3 w-full">{roundStatusNode}</div>
        <div className="mt-3 w-full">{creatorTicketsNode}</div>
      </div>
      {leaveNode && <div className="shrink-0 px-3 pb-3">{leaveNode}</div>}
    </div>
  );

  // Portrait (9:16) — the phone screen fills the frame edge-to-edge, so
  // the board is as big as the frame allows.
  const portraitContent = (
    <CreatorModeShell className="bg-gradient-to-br from-[#001933] to-[#000d1a]">
      <ShellMain className="overflow-hidden">
        <CreatorPhoneFrame>{creatorGameNode}</CreatorPhoneFrame>
      </ShellMain>
    </CreatorModeShell>
  );

  // Landscape (16:9) / square (1:1) — the same phone screen, fitted and
  // centered inside the frame (ShellMain centers its children).
  const landscapeContent = (
    <CreatorModeShell className="bg-gradient-to-br from-[#001933] to-[#000d1a]">
      <ShellMain className="overflow-hidden">
        <CreatorPhoneFrame>{creatorGameNode}</CreatorPhoneFrame>
      </ShellMain>
    </CreatorModeShell>
  );

  return (
    <>
      {/* Unified full-screen waiting takeover (matchmaking → countdown) */}
      {(isWaiting || isReady) && (
        <MatchWaiting
          state={isReady ? "ready" : "waiting"}
          gameName="Keno PvP"
          subtitle={
            isReady
              ? `${p1Name} vs ${p2Name} — Round 1 starts in a moment.`
              : `Your ${Number(match.stakeAmount).toLocaleString()} stake is escrowed. Someone with the same stake will join shortly.`
          }
          seats={
            isWaiting
              ? [
                  { label: "You", name: "You", occupied: true },
                  { label: "Opponent", occupied: false },
                ]
              : []
          }
          onCancel={isWaiting && match.viewerCanCancel ? cancelMatch : null}
          cancelLabel="Cancel Lobby"
        />
      )}

      <div className="min-h-screen overflow-x-clip bg-gradient-to-br from-[#001933] to-[#000d1a] px-3 pb-24 pt-20 text-white sm:px-6 md:pb-8">
      <NavigationBar currentPath="/casino" />

      {/* Only the actual match content is recorded — the matchmaking
          takeover and nav sit outside the shared CreatorModeHost
          recording viewport. Recording auto-starts when a round is in
          play and stops once the match finishes/cancels. */}
      <CreatorModeHost
        autoStart={isRound}
        autoStop={isFinished || isCancelled}
        gameLabel="keno"
        backToLobbyHref="/casino/keno"
      >
      <CreatorView
        normal={
          <>
            <div className="mx-auto mt-4 max-w-5xl">
        {/* Header + scoreboard */}
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3 sm:mb-4">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl sm:text-3xl font-extrabold tracking-wide text-transparent bg-clip-text bg-gradient-to-r from-[#00e5ff] to-[#00ffa6]">
                <span className="inline-flex items-center gap-2"><PoolBallIcon size={28} className="text-[#00e5ff]" /> Keno Catch Duel</span>
              </h1>
              <button
                onClick={() => setShowRules(true)}
                className="h-7 w-7 shrink-0 rounded-full border border-[#00e5ff]/40 bg-[#0b224f]/70 text-sm font-bold text-[#7cefff] transition hover:border-[#00e5ff]/80 hover:text-white"
                aria-label="How to play"
                title="How to play"
              >
                ?
              </button>
            </div>
            <p className="text-xs text-white/50 mt-1">
              First to {POINTS_TO_WIN} points · stake {match.stakeAmount.toLocaleString()} <IconCoins size={12} className="inline" />
            </p>
          </div>
          <div className="rounded-xl border border-[#00e5ff]/30 bg-[#0b224f]/85 px-4 py-2 text-sm shadow-[0_0_14px_rgba(0,229,255,0.15)] min-w-[210px]">
            <div className="flex items-center gap-3">
              <span className="relative inline-flex items-center gap-1.5 font-bold text-[#00ffa6]">
                <FrameAvatar frame={mySeatProfileFrame} iconKey={mySeatIcon} name={me === "player1" ? p1Name : p2Name} size="h-4 w-4" />
                <span
                  className={myNameEffect || undefined}
                  style={myNameColor ? { color: myNameColor } : undefined}
                >
                  {me === "player1" ? p1Name : p2Name}{" "}
                  <ScoreNumber value={myPts} className="font-black" />
                </span>
                <EmoteBubble emote={myEmote} side="mine" />
              </span>
              <span className="text-white/40">–</span>
              <span className="relative inline-flex items-center gap-1.5 font-bold text-[#FFD700]">
                <span
                  className={oppNameEffect || undefined}
                  style={oppNameColor ? { color: oppNameColor } : undefined}
                >
                  {me === "player2" ? p2Name : p1Name}{" "}
                  <ScoreNumber value={oppPts} className="font-black" />
                </span>
                <FrameAvatar frame={oppSeatProfileFrame} iconKey={oppSeatIcon} name={me === "player2" ? p2Name : p1Name} size="h-4 w-4" />
                <EmoteBubble emote={incomingEmote} />
              </span>
            </div>
            {/* Race to the finish: each player fills toward the centre
                10-point line (myPts / POINTS_TO_WIN from the left,
                opponent's from the right), with the objective spelled out at
                each end so the bar needs no guessing. */}
            <div className="mt-1.5 flex items-center gap-2">
              <span className="shrink-0 text-[10px] font-bold tabular-nums text-[#00ffa6]">
                {myPts}/{POINTS_TO_WIN}
              </span>
              {raceBarNode}
              <span className="shrink-0 text-[10px] font-bold tabular-nums text-[#FFD700]">
                {oppPts}/{POINTS_TO_WIN}
              </span>
            </div>
            {/* Round tracker — blue = rounds you won, red = rounds the
                opponent won (shared best-of marker, brawl-stars style). */}
            <div className="mt-1.5 flex justify-center">{roundTrackerNode}</div>
            <div className="mt-1 flex items-center justify-center gap-2 text-[11px] text-white/50">
              <span>{myWins}–{oppWins} round wins</span>
              <span>·</span>
              <span>first to {POINTS_TO_WIN} pts</span>
            </div>
          </div>
        </div>

        {/* Round announcement — the round now live ("Round 2") and, when
            this snapshot also closed the previous one, its result on the
            same line. */}
        {roundBannerNode}

        {/* How-to-play modal */}
        <AnimatePresence>
          {showRules && <RulesModal onClose={() => setShowRules(false)} />}
        </AnimatePresence>

        {error && (
          <div className="mb-3 rounded-lg border border-red-400/40 bg-red-900/30 px-3 py-2 text-sm text-red-200">
            {error}
          </div>
        )}

        {/* ── LIVE ROUND ──────────────────────────────────────────── */}
        {(isRound || isFinalHold) && (
          <div className="space-y-3 sm:space-y-4">
            <div className="relative rounded-2xl border border-[#00e5ff]/35 bg-[#050d1f]/80 p-3 shadow-[0_0_25px_rgba(0,229,255,0.15)] sm:p-6">
              {/* Round status line */}
              <div className="mb-2.5 flex items-center justify-between gap-2 text-xs text-white/60 sm:mb-4">
                <span className="font-bold text-[#FFD700] uppercase tracking-wider">
                  Round {match.currentRound} · first to {POINTS_TO_WIN} pts
                </span>
                <span>{isFinalHold ? "final" : `${roundTimeLeft}s left`}</span>
              </div>

              {/* Live status — ONE calm line (no pulse); the glowing tile
                  is the urgency. Two states instead of the old per-ball
                  three-message cycle. During the pre-modal hold it names
                  the settled board instead. */}
              <div className="flex flex-col items-center gap-1 sm:gap-2">
                {isFinalHold ? (
                  <p className="text-sm font-bold text-[#00ffa6]">
                    Final board — round {match.currentRound} complete
                  </p>
                ) : activeTile ? (
                  <p className="text-sm font-bold text-[#00e5ff]">Tap tile {activeTile.number}</p>
                ) : (
                  <p className="text-sm text-white/50">
                    {roundTimeLeft > 0 ? "Next tile incoming…" : "Resolving round…"}
                  </p>
                )}
                {/* Secondary explainer — dropped on phones so the board
                    (not the hint stack) dominates the first screen. */}
                <p className="hidden text-[11px] text-white/40 sm:block">
                  Each tile glows for {GLOW_MS / 1000}s. Tap it while the ring is shrinking. Green = caught · Red = missed.
                </p>
              </div>

              {/* Emotes */}
              <div className="mt-1.5 flex justify-center">
                <EmotePicker
                  compact
                  hideBubbles
                  incomingEmote={incomingEmote}
                  myEmote={myEmote}
                  onSend={(emote) => sendEmote(emote)}
                />
              </div>

              {/* Quality flash */}
              <AnimatePresence>
                {lastQuality && (
                  // Keyed on the event (ball + quality) so every genuine
                  // local catch / miss / duplicate gets its own pop; polls
                  // and socket pushes never touch lastQuality.
                  <motion.div
                    key={`${lastQuality.ball}:${lastQuality.quality}`}
                    {...withReducedMotion(shouldReduceMotion, {
                      initial: { opacity: 0, scale: 0.7 },
                      animate: { opacity: 1, scale: 1 },
                      exit: { opacity: 0, scale: 0.7 },
                    })}
                    className="pointer-events-none absolute inset-x-0 bottom-2 z-40 flex justify-center"
                  >
                    <span
                      className={`rounded-full border px-5 py-2 text-lg font-black tracking-widest shadow-lg ${
                        FLASH_LABEL[lastQuality.quality]?.cls || "text-white border-white/40 bg-black/60"
                      }`}
                    >
                      {flashLabelFor(lastQuality.quality, lastQuality)}
                    </span>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* Keno board — drawn numbers light up as the draw unfolds */}
            <div className="relative rounded-2xl border border-[#00e5ff]/35 bg-[#050d1f]/70 p-3 sm:p-5">
              {/* Round-reset cue: one short edge fade when a new round takes
                  the board, so the reset reads as "new round" rather than
                  the tiles blinking out. A single element keyed by the
                  round number — the 40 tiles are never animated
                  individually. */}
              {/* Skipped entirely with motion off: this cue fades TO
                  transparent, so a "static" version would leave a solid
                  border stuck over the board. */}
              {isRound && !shouldReduceMotion && (
                <motion.span
                  key={`round-reset-${match.currentRound}`}
                  initial={{ opacity: 0.5 }}
                  animate={{ opacity: 0 }}
                  transition={{ duration: 0.45, ease: "easeOut" }}
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0 rounded-2xl border-2 border-[#00e5ff]/70"
                />
              )}
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-bold uppercase tracking-wider text-[#7cefff]">
                  <span className="inline-flex items-center gap-1.5"><PoolBallIcon size={16} className="text-[#00e5ff]" /> Keno Board 1–{KENO_POOL_SIZE}</span>
                </h3>
                <span className="text-xs text-white/50">
                  {boardDrawnCount} / {BALL_COUNT} drawn
                  {oppRevealedNumbers.size > 0 && (
                    <span className="ml-2 text-[#FFD700]/80">
                      · R{lastResolvedRound.roundNumber}: {oppRevealedNumbers.size} opponent caught
                    </span>
                  )}
                </span>
              </div>
              {/* Same shared geometry as the creator board above — one 8-col
                  fluid grid, square tiles, no `xs:` breakpoint (this project
                  defines none, so `xs:` was a dead class that left phones on
                  the 5-col base grid with fixed ~40px tiles). */}
              <div
                className={`mx-auto grid w-full max-w-[30rem] grid-cols-8 gap-1 sm:gap-2${
                  isFinalHold ? " pointer-events-none" : ""
                }`}
              >
                {kenoTilesNode}
              </div>

              {/* Inline points table — live highlight on the current tier */}
              <div className="mt-4 border-t border-[#00e5ff]/20 pt-3">
                <div className="mb-1.5 flex items-center justify-between gap-2">
                  <h4 className="text-[11px] font-bold uppercase tracking-wider text-white/40">
                    Points: tiles caught → score
                  </h4>
                  <span className="text-[11px] font-semibold text-[#00ffa6]">
                    {boardMyStats.caught} caught · {boardMyStats.score} pts
                  </span>
                </div>
                <div className="grid grid-cols-5 gap-1.5">
                  {POINTS_TABLE.map(([caught, pts]) => {
                    const isCurrent = caught === boardMyStats.caught;
                    return (
                      <div
                        key={caught}
                        className={`rounded-md border px-1 py-1 text-center transition-colors ${
                          isCurrent
                            ? "border-[#00ffa6]/80 bg-[#00ffa6]/15 shadow-[0_0_10px_rgba(0,255,166,0.35)]"
                            : "border-[#00e5ff]/20 bg-[#0b224f]/60"
                        }`}
                      >
                        <div className={`text-[10px] font-bold ${isCurrent ? "text-[#00ffa6]" : "text-[#FFD700]"}`}>
                          {caught}
                        </div>
                        <div className={`text-[11px] font-black ${isCurrent ? "text-white" : "text-[#00ffa6]"}`}>
                          {pts}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {oppRevealedNumbers.size > 0 && (
                <p className="mt-3 text-[11px] text-white/40">
                  <span className="text-[#FFD700]">Gold</span> = the numbers {oppName} caught in round{" "}
                  {lastResolvedRound.roundNumber}, the last completed round. It resets with each new
                  round; their LIVE ticket stays hidden until the round ends.
                </p>
              )}
            </div>

            {/* Last completed round — compact recap that persists through
                the whole next round (see `lastRoundSummaryNode`). */}
            {lastRoundSummaryNode}

            {/* Tickets — always You | opponent, whichever seat you hold (the
                same arrangement as the creator frame). The old version titled
                each card by SEAT, so on seat 2 the opponent's card was the
                green "your ticket" card and their LIVE count was never shown
                at all. Green = you, gold = them, matching the scoreboard. */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="rounded-2xl border border-[#00ffa6]/30 bg-[#050d1f]/70 p-4">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="font-bold text-[#00ffa6]">Your ticket (You)</h3>
                  <span className="text-xs text-white/60">{boardMyStats.score} pts</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {boardMyCatches.length === 0 && (
                    <p className="text-xs text-white/40">Catch some tiles!</p>
                  )}
                  {boardMyCatches.map((c) => (
                    <span
                      key={c.number}
                      className="px-2.5 py-1 rounded-lg border text-sm font-bold bg-[#00ffa6]/15 text-[#00ffa6] border-[#00ffa6]/50"
                    >
                      {c.number}
                    </span>
                  ))}
                </div>
              </div>
              <div className="rounded-2xl border border-[#FFD700]/30 bg-[#050d1f]/70 p-4">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="min-w-0 truncate font-bold text-[#FFD700]">
                    {oppName}&apos;s ticket
                  </h3>
                  <span className="shrink-0 text-xs text-white/60">
                    {opponentCatchCountNode} caught
                  </span>
                </div>
                <p className="text-xs text-white/40">
                  {boardOppCatchCount === 0
                    ? `${oppName} has not caught a ball this round. Their ticket stays hidden until the round ends.`
                    : `${oppName} has caught ${boardOppCatchCount} ball${
                        boardOppCatchCount === 1 ? "" : "s"
                      } this round — which tiles stays hidden until the round ends.`}
                </p>
              </div>
            </div>
          </div>
        )}

        {/* ── OVERTIME ───────────────────────────────────────────── */}
        {isOvertime && (
          <div className="rounded-2xl border border-red-400/50 bg-[#1a0505]/85 p-8 text-center shadow-[0_0_30px_rgba(255,70,70,0.25)]">
            <p className="mb-2 animate-pulse"><IconClock size={40} className="text-red-400" /></p>
            <h2 className="text-2xl sm:text-3xl font-extrabold tracking-wide text-red-300">
              OVERTIME
            </h2>
            <p className="mt-2 text-sm text-white/70">
              Nobody reached {POINTS_TO_WIN} pts in time. When the clock hits zero, the player
              with the most tiles wins.
            </p>
            <p className="mt-4 text-6xl font-black text-white tabular-nums">{roundTimeLeft}s</p>
            <p className="mt-1 text-xs text-white/50">
              Most tiles (points) wins · overtime tie = 95% refund each (5% rake)
            </p>
          </div>
        )}

        {/* ── CANCELLED ───────────────────────────────────────────── */}
        {isCancelled && (
          <div className="rounded-2xl border border-red-400/30 bg-[#0b224f]/85 p-10 text-center">
            <p className="mb-3"><IconCircleX size={36} className="text-red-400" /></p>
            <h2 className="text-xl font-bold mb-2">Match cancelled</h2>
            <p className="text-sm text-white/60 mb-6">Your stake was refunded.</p>
            <button
              onClick={goToLobby}
              className="px-5 py-2 rounded-lg bg-[#00e5ff] text-[#001933] font-bold"
            >
              Back to Keno Lobby
            </button>
          </div>
        )}

        {/* Leave control during a live match */}
        {!isFinished && !isCancelled && !isWaiting && (
          <div className="mt-4 text-center">
            <button
              onClick={goToLobby}
              disabled={leaving}
              className="px-4 py-2 rounded-lg text-xs text-white/50 border border-white/15 hover:text-white hover:border-white/40 transition disabled:opacity-50"
            >
              {leaving ? "Leaving…" : "Leave match (forfeit)"}
            </button>
          </div>
        )}

        <Footer />
            </div>
          </>
        }
        portrait={portraitContent}
        landscape={landscapeContent}
      />

      {/* ── FINISHED: end-of-match result screen ──────────────────────
          Mounted INSIDE CreatorModeHost, as a sibling of <CreatorView>,
          so the WIN/LOSS panel is part of the recording. It used to sit
          inside CreatorView's `normal` node, which CreatorView replaces
          while recording — so the clip ended on the last round with no
          winner screen. showResult lands 1.2s after the finish, inside
          the 2.4s auto-stop grace period, so it is captured. ───────── */}
      {isFinished && showResult && (
        <ResultModal
          match={match}
          rounds={rounds}
          me={me}
          p1Name={p1Name}
          p2Name={p2Name}
          myWins={myWins}
          oppWins={oppWins}
          myPts={myPts}
          oppPts={oppPts}
          onLobby={goToLobby}
        />
      )}
      </CreatorModeHost>
    </div>
    </>
  );
}

// ── Rules modal ──────────────────────────────────────────────────────

// Tiles caught → points (the classic keno multiplier for picks == hits
// == caught, sourced straight from KENO_MULTIPLIER_TABLE so the modal
// can never drift from the engine).
const POINTS_TABLE = Object.entries(KENO_MULTIPLIER_TABLE)
  .map(([picks, byHits]) => [Number(picks), byHits[Number(picks)]])
  .sort((a, b) => a[0] - b[0]);

function RulesModal({ onClose }) {
  // Same convention as the page: with motion off the sheet is simply there
  // (fade + spring dropped) rather than flying in.
  const shouldReduceMotion = useReducedMotion();
  return (
    <motion.div
      {...withReducedMotion(shouldReduceMotion, {
        initial: { opacity: 0 },
        animate: { opacity: 1 },
        exit: { opacity: 0 },
      })}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <motion.div
        {...withReducedMotion(shouldReduceMotion, {
          initial: { opacity: 0, scale: 0.92, y: 12 },
          animate: { opacity: 1, scale: 1, y: 0 },
          exit: { opacity: 0, scale: 0.95, y: 8 },
          transition: { type: "spring", stiffness: 300, damping: 26 },
        })}
        className="w-full max-w-md rounded-2xl border border-[#00e5ff]/40 bg-[#050d1f]/95 p-6 shadow-[0_0_40px_rgba(0,229,255,0.25)] max-h-[92vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-xl font-extrabold text-[#7cefff]"><IconNotebook size={20} /> How to play</h2>
          <button
            onClick={onClose}
            className="h-8 w-8 rounded-lg border border-white/15 text-white/60 transition hover:border-white/40 hover:text-white"
            aria-label="Close rules"
          >
            <IconX size={16} />
          </button>
        </div>

        <h3 className="mb-2 flex items-center gap-1.5 text-sm font-bold uppercase tracking-wider text-[#00ffa6]"><IconTarget size={15} /> Catch the glowing tile</h3>
        <ul className="mb-5 space-y-1.5 text-xs text-white/70">
          <li>
            Each round, <span className="font-semibold text-white">10 tiles</span> from the 1–40 board
            light up one at a time. Both players chase the{" "}
            <span className="font-semibold text-white">same draw</span>.
          </li>
          <li>
            A tile <span className="font-semibold text-[#00e5ff]">glows for {GLOW_MS / 1000}s</span>{" "}
            (watch the ring shrink). Tap it while it's lit →{" "}
            <span className="font-semibold text-[#00ffa6]">caught (green)</span>.
          </li>
          <li>
            Tap after the glow fades → <span className="font-semibold text-red-400">miss (red)</span>. No
            points.
          </li>
          <li>Catching is binary: you're in the 0.8s window or you're not.</li>
          <li className="flex items-center gap-1"><IconVolume size={12} /> A soft tick sounds the moment each tile lights up.</li>
        </ul>

        <h3 className="mb-2 flex items-center gap-1.5 text-sm font-bold uppercase tracking-wider text-[#00ffa6]"><IconCoins size={15} /> Points: keno multiplier</h3>
        <div className="mb-2 grid grid-cols-5 gap-1.5">
          {POINTS_TABLE.map(([caught, pts]) => (
            <div
              key={caught}
              className="rounded-md border border-[#00e5ff]/25 bg-[#0b224f]/80 px-1 py-1.5 text-center"
            >
              <div className="text-[10px] font-bold text-[#FFD700]">{caught}</div>
              <div className="text-[11px] font-black text-[#00ffa6]">{pts}</div>
            </div>
          ))}
        </div>
        <p className="mb-5 text-[11px] text-white/50">
          Tiles caught → points. The multiplier compounds: 5 tiles = 50 pts, all 10 = 5,000 pts.
          The last tiles are worth the most.
        </p>

        <h3 className="mb-2 flex items-center gap-1.5 text-sm font-bold uppercase tracking-wider text-[#00ffa6]"><IconTrophy size={15} /> Winning the match</h3>
        <ul className="space-y-1.5 text-xs text-white/70">
          <li>
            <span className="font-semibold text-white">First to {POINTS_TO_WIN} points</span> takes the
            pot. Your round scores accumulate until someone crosses the line.
          </li>
          <li>Higher round score wins the round; an exact tie is a draw (no round win).</li>
          <li>Both cross {POINTS_TO_WIN} in the same round? The higher total wins. Exact tie → full
            refund, no rake.</li>
          <li>
            <IconClock size={12} className="inline" /> <span className="font-semibold text-white">3-minute match clock</span>. If nobody reaches{" "}
            {POINTS_TO_WIN} pts in ~3 minutes, a 30-second OVERTIME countdown starts; the player
            with the most tiles wins when it ends.
          </li>
          <li className="flex items-start gap-1"><IconHeartHandshake size={12} className="mt-0.5 shrink-0" /> <span>An overtime tie is a draw: both players are refunded 95% of their stake (5% rake
            each).</span></li>
          <li>Winner takes their stake + 90% of the loser's stake (house keeps 10%).</li>
        </ul>
      </motion.div>
    </motion.div>
  );
}

// ── Result screen — shared PvpResultScreen (UX plan P3-3) ─────────
// End-of-match adapter: maps the real match result / payout / score
// fields onto the shared result screen. No invented values — sections
// without data (XP, Battle Pass, duration…) simply don't render. The
// old bespoke MATCH DRAW / YOU WON modal is gone; the per-round
// breakdown lives under the screen's expandable Match Details.
function ResultModal({ match, rounds, me, p1Name, p2Name, myWins, oppWins, myPts, oppPts, onLobby }) {
  // CreatorResultOverlay picks the panel sizing from the creator-mode flag
  // (compact while the recording frame is live), so it must be mounted
  // inside <CreatorModeHost> — see its call site below.
  const router = useRouter();
  const result = match.result;
  const iWon = result === me;
  const drew = result === "draw";

  // Normal draws refund in full (houseFee = 0 → net 0). An OVERTIME
  // tie takes 5% of each stake (10% total, stored in houseFee) — each
  // player's net is −(houseFee / 2).
  const net = drew
    ? -(Number(match.houseFee) || 0) / 2
    : iWon
      ? Number(match.prizePaid) - Number(match.stakeAmount)
      : -Number(match.stakeAmount);

  const tieFee = drew ? Number(match.houseFee) || 0 : 0;
  const winnerName = result === "player1" ? p1Name : p2Name;
  const oppName = me === "player1" ? p2Name : p1Name;
  const oppSeatSummary = match.players?.[me === "player1" ? "player2" : "player1"] ?? null;
  const outcome = drew ? "draw" : iWon ? "win" : "loss";
  const stakeTokens = Number(match.stakeAmount) || 0;

  return (
    <CreatorResultOverlay
      open
      outcome={outcome}
      headline={
        drew
          ? tieFee > 0
            ? "Overtime ended tied — no winner"
            : "Stake refunded"
          : `${myPts} – ${oppPts} pts · ${myWins} – ${oppWins} round wins`
      }
      subline={
        drew && tieFee > 0
          ? "Both players keep 95% of their stake (5% rake each)."
          : outcome === "loss"
            ? `${winnerName} takes the pot.`
            : undefined
      }
      gameName="Keno Duel"      opponent={
        match.isAi
          ? { name: "GRYND AI", isAi: true }
          : { name: oppName, iconKey: oppSeatSummary?.iconKey || null }
      }
      tokenDelta={net}
      summary={[
        { label: "Score", value: `${myPts} – ${oppPts} pts` },
        { label: "Round wins", value: `${myWins} – ${oppWins}` },
      ]}
      details={
        [
          ...(match.id != null ? [{ label: "Match ID", value: String(match.id) }] : []),
          { label: "Stake", value: `${stakeTokens.toLocaleString()} tokens` },
          ...(iWon
            ? [{ label: "Payout", value: `${(Number(match.prizePaid) || 0).toLocaleString()} tokens` }]
            : []),
          ...(drew && tieFee > 0
            ? [{ label: "Rake (5% each)", value: `${tieFee.toLocaleString()} tokens` }]
            : []),
          { label: "Winner", value: drew ? "Draw" : winnerName },
        ]
      }
      detailsContent={
        <div className="mt-2 space-y-2">
          {rounds.length === 0 && (
            <p className="text-xs text-white/40 text-center">No completed rounds (forfeit).</p>
          )}
          {rounds.map((r) => {
            const rWinner =
              r.roundWinner === "player1" ? p1Name : r.roundWinner === "player2" ? p2Name : "Draw";
            return (
              <div
                key={r.id}
                className="rounded-lg border border-white/10 bg-[#08142f]/80 p-2.5 text-xs"
              >
                <div className="mb-1.5 flex justify-between">
                  <span className="font-bold text-[#FFD700]">Round {r.roundNumber}</span>
                  <span className="text-white/60">
                    {r.player1Score} – {r.player2Score} · winner: {rWinner}
                  </span>
                </div>
                <div className="flex flex-wrap gap-1">
                  <span className="mr-1 text-white/40">P1:</span>
                  {r.player1Catches.map((c) => (
                    <span
                      key={c.number}
                      className={`rounded px-1.5 ${c.quality === "perfect" ? "bg-emerald-500/20 text-emerald-300" : "bg-cyan-500/15 text-cyan-200"}`}
                    >
                      {c.number}
                    </span>
                  ))}
                </div>
                <div className="mt-1 flex flex-wrap gap-1">
                  <span className="mr-1 text-white/40">P2:</span>
                  {r.player2Catches.map((c) => (
                    <span
                      key={c.number}
                      className={`rounded px-1.5 ${c.quality === "perfect" ? "bg-emerald-500/20 text-emerald-300" : "bg-cyan-500/15 text-cyan-200"}`}
                    >
                      {c.number}
                    </span>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      }
      playAgain={{ label: "RUN IT BACK", onClick: onLobby }}
      onReturnToLobby={() => router.push("/casino")}
    />
  );
}
