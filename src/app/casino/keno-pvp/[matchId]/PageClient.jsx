"use client";

// src/app/casino/keno-pvp/[matchId]/PageClient.jsx
//
// Live 1v1 Keno SURVIVAL DUEL match view.
//
// Both players start with 3 lives. ONE tile is lit at a time on the 1–40
// board and both players have the SAME window to tap it — claiming it
// first costs the opponent nothing. A life is lost only for your OWN
// miss: if you do not tap the lit tile before its window closes, you (and
// only you) lose a life, whether the opponent took the tile or nobody
// did. The server generates each target's window (3s base ramp, bounded
// variation, 0.5s floor) and a short anticipation pause between targets,
// so the pace is unpredictable but identical for both seats. A 5s
// get-ready countdown runs before the first tile lights. Lose all your
// lives and the match is over (both eliminated on the same tile → draw).
//
// The client renders the live tile + its window from the SERVER's clock
// and the public per-tile log; the SERVER decides every outcome with its
// own clock, so the client can never self-report a claim.

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { usePostHog } from "posthog-js/react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import confetti from "canvas-confetti";
import NavigationBar from "../../../../components/navigation-bar";
import MatchLoading from "../../../../components/game/MatchLoading";
import Footer from "../../../../components/Footer";
import SoundToggle from "../../../../components/SoundToggle";
import KenoWaitingPanel from "../../../../components/keno-pvp/KenoWaitingPanel";
import PvpResultScreen from "../../../../components/result/PvpResultScreen";
import FrameAvatar from "../../../../components/FrameAvatar";
import { cosmeticEffectClass } from "../../../../lib/profileCosmetics";
// Page-level session host: records "recently played" and beats
// active-player presence, driven by the game's REAL lifecycle
// (autoStart/autoStop) — never by page load.
import GameSessionHost from "../../../../components/GameSessionHost";

import {
  getSharedAudioContext,
  getSharedOutputNode,
} from "../../../../lib/audioContext";
// Shared game SFX. gameAudio imports the same audioContext
// singleton as the inline tick in this page, so every Keno sound routes
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
  KENO_POOL_SIZE,
  MIN_WINDOW_MS,
  READY_WINDOW_MS,
  STARTING_LIVES,
  START_WINDOW_MS,
} from "../../../../lib/keno-pvp/constants";
import { tileWindowMs, windowRemainingMs } from "../../../../lib/keno-pvp/engine";
import {
  streakMilestoneAt,
  streakStats,
} from "../../../../lib/keno-pvp/streaks";
import { withReducedMotion } from "../../../../lib/animations";
import {
  useMatchSync,
} from "../../../../hooks/useMatchSync";
import { usePracticePause } from "../../../../hooks/usePracticePause";
import {
  PracticePauseChip,
  PracticePauseOverlay,
} from "../../../../components/game/PracticePause";
import { kenoPvpDueRead } from "../../../../lib/deadlineRead";
import { useDeadlineRead } from "../../../../hooks/useDeadlineRead";
import {
  IconCoins,
  IconHeart,
  IconHeartBroken,
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

// The 1–40 board numbers. Built once: both board copies map it, and it
// never changes.
const KENO_NUMBERS = Array.from({ length: KENO_POOL_SIZE }, (_, i) => i + 1);

// Server reason → player-facing copy for a tap that did not land. Raw API
// strings must never reach the board.
const MISS_TEXT = {
  "That tile is not live": "Not the live tile",
  "That tile is no longer live": "That tile is gone",
  "Too slow — the tile expired": "Too slow",
  "No tile is live yet": "Wait for the next tile",
  "Match is not live": "Match over",
  "Tile is not live yet": "Not live yet",
};
const MISS_TEXT_FALLBACK = "Too slow";

// Reasons that mean this player's tap genuinely failed (and the tile was
// resolved as a both-miss) → show a miss flash. Transport/auth failures
// are deliberately absent: they are not the player's fault.
const TAP_MISS_REASONS = new Set([
  "That tile is not live",
  "That tile is no longer live",
  "Too slow — the tile expired",
  "Match is not live",
  "No tile is live yet",
]);

function missTextFor(reason) {
  return MISS_TEXT[reason] || MISS_TEXT_FALLBACK;
}

// ── Public tile log → presentation ────────────────────────────────────
//
// The tile log is public to both players (both watch every tile resolve),
// so the match feed is derived from it rather than from local guesses.
// One line per resolved tile, written from the VIEWER's perspective.

function feedLineFor(entry, viewerIsPlayer1, oppName) {
  if (!entry) return null;
  const name = oppName || "Your opponent";
  // Each seat's tap is read from its own flag, so a tile BOTH players
  // tapped no longer masquerades as a one-sided claim. The legacy
  // `outcome` strings are the fallback for log entries written before the
  // per-player flags existed (and for the pure-logic tests).
  const iClaimed =
    Boolean(entry[viewerIsPlayer1 ? "p1Claimed" : "p2Claimed"]) ||
    (!("p1Claimed" in entry) &&
      (entry.outcome === (viewerIsPlayer1 ? "player1" : "player2") ||
        entry.outcome === "both_claim"));
  const theyClaimed =
    Boolean(entry[viewerIsPlayer1 ? "p2Claimed" : "p1Claimed"]) ||
    (!("p2Claimed" in entry) &&
      (entry.outcome === (viewerIsPlayer1 ? "player2" : "player1") ||
        entry.outcome === "both_claim"));
  const myMs = entry[viewerIsPlayer1 ? "p1ReactionMs" : "p2ReactionMs"];

  // Only YOUR miss costs you a life — the opponent's claim never does.
  if (!iClaimed) {
    return {
      tone: "miss",
      text: theyClaimed
        ? `${name} claimed tile ${entry.tile} — you missed it and lost a life`
        : `Tile ${entry.tile} went unclaimed — you lost a life`,
    };
  }
  return {
    tone: "mine",
    text:
      `You claimed tile ${entry.tile}` +
      (myMs != null ? ` · ${myMs}ms` : "") +
      (theyClaimed ? ` — ${name} got it too, nobody lost a life` : ""),
  };
}

// The one-line instruction above the board.
function liveStatusText({ isLive, hasLiveTile, remainingMs, viewerCanClaim, savedByMe }) {
  if (!isLive) return null;
  if (!hasLiveTile) return "Lighting the next tile…";
  if (remainingMs <= 0) return "Tile expired — resolving…";
  if (!viewerCanClaim) return "Waiting for the match…";
  if (savedByMe) return "Tile tapped — your life is safe on this one";
  return "Tap the lit tile before the window closes";
}

// Lives as HEARTS: a full heart is a life still in hand, a broken faded heart
// is one already lost. The seat is carried by colour as well as the glyph
// (you = mint, opponent = gold) so the two bars never differ by hue alone.
//
// `pulseKey` changes whenever THIS seat loses a life (the page bumps it from
// the authoritative payload, never from a local guess): the newly lost heart
// plays its break once and the remaining hearts get a short emphasis. Reduced
// motion renders exactly the same end state with no animation.
function LivesPips({ lives, total = STARTING_LIVES, tone = "cyan", size = "md", pulseKey = 0 }) {
  const shouldReduceMotion = useReducedMotion();
  const filled = Math.max(0, Math.min(total, Number(lives) || 0));
  const isOpp = tone === "opp";
  const heartPx = size === "lg" ? 26 : size === "sm" ? 16 : 20;
  const color = isOpp ? "text-[#FFD700]" : "text-[#00ffa6]";
  const glow = isOpp
    ? "drop-shadow-[0_0_6px_rgba(255,215,0,0.5)]"
    : "drop-shadow-[0_0_6px_rgba(0,255,166,0.5)]";
  // Hearts fill left to right, so the heart that has JUST been lost is the
  // first empty one (`filled`). `pulseKey > 0` means a loss just happened.
  const justLostIndex = pulseKey > 0 ? filled : -1;

  return (
    <span
      className="inline-flex items-center gap-1"
      aria-label={`${filled} of ${total} lives left`}
      data-lives={filled}
    >
      {Array.from({ length: total }, (_, i) => {
        const isLost = i >= filled;
        const justLost = isLost && i === justLostIndex;
        return (
          <motion.span
            key={i}
            className="relative inline-flex items-center justify-center"
            initial={false}
            animate={
              shouldReduceMotion
                ? { opacity: 1, scale: 1, rotate: 0 }
                : justLost
                  ? { opacity: 0.55, scale: [1.45, 0.85], rotate: [0, -16, 6] }
                  : isLost
                    ? { opacity: 1, scale: 1, rotate: 0 }
                    : pulseKey > 0
                      ? { scale: [1, 1.22, 1], opacity: 1 }
                      : { scale: 1, opacity: 1, rotate: 0 }
            }
            transition={{ duration: 0.45, ease: "easeOut" }}
          >
            {isLost ? (
              <IconHeartBroken
                size={heartPx}
                stroke={2}
                aria-hidden="true"
                className="text-red-400/45"
              />
            ) : (
              <IconHeart
                size={heartPx}
                stroke={2.2}
                aria-hidden="true"
                fill="currentColor"
                className={`${color} ${glow}`}
              />
            )}
          </motion.span>
        );
      })}
    </span>
  );
}

// One Keno board tile.
//
// Memoized leaf: the page re-renders on the 100ms board clock, which used
// to rebuild all 40 tile buttons on every tick. This re-renders only when
// a prop it actually renders changes. The countdown bar is a plain width
// (a data read-out, not decoration), so it stays informative under
// prefers-reduced-motion.
const KenoTile = memo(function KenoTile({
  num,
  tilePx = 44,
  isLive,
  phase = "normal",
  ripple = false,
  savedByMe,
  liveRemainingRatio,
  claimedByMe,
  claimedByOpp,
  missed,
  frozen,
  onClaim,
}) {
  const shouldReduceMotion = useReducedMotion();
  // Scale the numeral with the tile so a 100px tile does not show a 14px
  // number, while a 30px floor tile still fits two digits.
  const numeralPx = Math.max(11, Math.round(tilePx * 0.3));
  // The live tile's tone follows the SAME server deadline the meter uses.
  // It is a warning colour only — the server still grades every tap.
  // Full class strings (never interpolated): Tailwind only emits classes it
  // can see as literals in the source.
  const liveTone =
    phase === "expired"
      ? {
          bg: "bg-[#ff4d5e]",
          ring: "ring-[#ffe3e6]",
          shadow:
            "shadow-[0_0_0_2px_var(--gr-outline),0_0_18px_rgba(255,77,94,0.6),0_0_34px_rgba(255,77,94,0.5)]",
        }
      : phase === "urgent"
        ? {
            bg: "bg-[#ffb020]",
            ring: "ring-[#fff1cf]",
            shadow:
              "shadow-[0_0_0_2px_var(--gr-outline),0_0_18px_rgba(255,176,32,0.6),0_0_34px_rgba(255,176,32,0.45)]",
          }
        : {
            bg: "bg-[#00e5ff]",
            ring: "ring-[#eaf6ff]",
            shadow:
              "shadow-[0_0_0_2px_var(--gr-outline),0_0_18px_rgba(0,229,255,0.55),0_0_34px_rgba(0,229,255,0.35)]",
          };
  // ONE dark outline (the shared `--gr-outline`) on every tile, with the
  // state choosing only the hue. That outline is what stops a claimed green
  // tile and the neon-cyan live tile reading as two different games.
  const RAISED =
    "shadow-[inset_0_2px_0_rgba(255,255,255,0.10),inset_0_-3px_0_rgba(3,8,20,0.55)]";
  const FLAT = "shadow-[inset_0_2px_0_rgba(255,255,255,0.05)]";
  let cls = `border-[color:var(--gr-outline)] bg-[#0b224f] text-white/45 ${RAISED} cursor-default`;
  // `missed` means THIS viewer did not tap the tile — that is the only
  // thing that costs a life, so it drives the tile red even when the
  // opponent took it (their diamond marker marks that case).
  if (missed && claimedByOpp)
    cls = `border-[color:var(--gr-outline)] bg-[#3a1418] text-red-200/80 ${FLAT} cursor-default`;
  else if (missed)
    cls = `border-[color:var(--gr-outline)] bg-[#4a1020] text-red-200/85 ${FLAT} cursor-default`;
  else if (claimedByMe)
    cls = `border-[color:var(--gr-outline)] bg-[#00c98a] text-[#001933] font-black ${FLAT} cursor-default`;
  else if (claimedByOpp)
    cls = `border-[color:var(--gr-outline)] bg-[#FFD700]/30 text-[#FFD700] ${FLAT} cursor-default`;
  if (isLive && savedByMe) {
    // Tapped already: the tile stays lit for the rest of its window (so the
    // other player can still save themselves), but it is no longer a target.
    cls =
      "border-[color:var(--gr-outline)] bg-[#00ffa6] text-[#001933] font-black scale-110 " +
      "ring-2 ring-[#eaf6ff] shadow-[0_0_0_2px_var(--gr-outline),0_0_18px_rgba(0,255,166,0.5)] cursor-default";
  } else if (isLive) {
    cls =
      `border-[color:var(--gr-legal-move)] ${liveTone.bg} text-[#001933] font-black scale-110 ` +
      `ring-2 ${liveTone.ring} cursor-pointer animate-pulse motion-reduce:animate-none ` +
      `${liveTone.shadow}`;
  }
  const disabled = frozen || !isLive || savedByMe;
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => {
        if (!disabled) onClaim(num);
      }}
      aria-label={
        isLive && savedByMe
          ? `Live tile ${num} — you tapped it, your life is safe`
          : isLive
            ? `Live tile ${num} — tap to claim`
          : claimedByMe
            ? `Tile ${num} claimed by you${
                claimedByOpp ? " and your opponent" : ""
              }`
            : missed
              ? claimedByOpp
                ? `Tile ${num} claimed by your opponent — you lost a life`
                : `Tile ${num} went unclaimed — you lost a life`
              : claimedByOpp
                ? `Tile ${num} claimed by your opponent`
                : `Tile ${num}`
      }
      className={`gr-focusable relative w-full aspect-square overflow-hidden flex items-center justify-center rounded-[6px] border-2 text-sm font-bold leading-none tabular-nums transition-all duration-200 touch-manipulation select-none active:scale-90 ${cls}`}
      style={{ fontSize: `${numeralPx}px` }}
    >
      <span className="relative z-0">{num}</span>
      {/* Ownership is a SHAPE, not only a hue: a white dot in the top-right
          corner is your claim, a gold diamond in the top-left is theirs. Both
          can sit on one tile, which is why they occupy opposite corners. They
          are kept 4px so a two-digit numeral never collides with them, even
          at the 30px tile 320px screens get. */}
      {claimedByMe && !missed && (
        <span
          aria-hidden="true"
          className="absolute right-0.5 top-0.5 z-10 h-1 w-1 rounded-full border border-[color:var(--gr-outline)] bg-white"
        />
      )}
      {claimedByOpp && (
        <span
          aria-hidden="true"
          className="absolute left-0.5 top-0.5 z-10 h-1 w-1 rotate-45 border border-[color:var(--gr-outline)] bg-[#FFD700]"
        />
      )}
      {isLive && (
        <span
          aria-hidden="true"
          className="absolute inset-x-0 bottom-0 h-1 bg-white/85 transition-[width] duration-100 ease-linear"
          style={{ width: `${Math.max(0, Math.min(1, liveRemainingRatio)) * 100}%` }}
        />
      )}
      {/* Brief impact ring on a CONFIRMED claim. Purely visual and started
          after the POST already returned, so it can never delay the request
          or the next target. */}
      {ripple &&
        (shouldReduceMotion ? (
          <span
            aria-hidden="true"
            data-testid="keno-ripple"
            className="pointer-events-none absolute inset-0 rounded-[6px] border-2 border-white/80"
          />
        ) : (
          <motion.span
            aria-hidden="true"
            data-testid="keno-ripple"
            className="pointer-events-none absolute inset-0 rounded-[6px] border-2 border-white"
            initial={{ opacity: 0.9, scale: 0.55 }}
            animate={{ opacity: 0, scale: 2.1 }}
            transition={{ duration: 0.5, ease: "easeOut" }}
          />
        ))}
    </button>
  );
});

// Cushion added to the tile-deadline nudge below. The nudge is timed from
// our own estimate of the server clock (`clockOffset`), which carries up
// to roughly half an RTT of error; without the cushion the read could land
// a fraction early, see the tile still live, and wait for the poll.
const DEADLINE_NUDGE_CUSHION_MS = 300;

// When a free (AI) match re-asks the server to run the bot's turn, measured
// from the moment the page learns of the live tile.
//
// The bot's claim is graded SERVER-side against its own reaction time —
// 200–420ms into the tile's window — so a coarse poll can never catch it: the
// 5s backstop poll and the deadline nudge both land outside the window, and
// the store refuses to claim once the tile has expired. A short burst (plus
// one immediate ask) covers the whole reaction band without polling for the
// entire window: whichever probe first lands at/after the bot's due time is
// the one that writes the claim.
const AI_TURN_PROBE_OFFSETS_MS = [140, 300, 460];

// ── Board layout ──────────────────────────────────────────────────────────
// Narrow phones get FIVE columns (8 rows) instead of eight 30px slivers, so a
// tile keeps a real tap target. Anything wider gets the classic 8 × 5 board.
const BOARD_TILE_MIN_PX = 30;
const BOARD_TILE_MAX_PX = 104;

/**
 * Observe the board's content box. The board is sized from BOTH axes, which
 * CSS alone cannot do (an aspect-ratio box cannot read its parent's height),
 * so the page measures the space the flex layout actually gave the board.
 *
 * Returns `[box, attach]` where `attach` is a CALLBACK REF. An effect keyed on
 * `ref.current` would run once against the loading screen (where the board does
 * not exist yet) and never again — which left every tile on the fallback size
 * and clipped the board on short phones. A callback ref re-runs the effect when
 * the board actually mounts.
 */
function useElementBox() {
  const [element, setElement] = useState(null);
  const [box, setBox] = useState({ width: 0, height: 0 });

  useEffect(() => {
    if (!element || typeof ResizeObserver === "undefined") return undefined;

    const measure = (width, height) => {
      setBox((prev) =>
        Math.abs(prev.width - width) < 1 && Math.abs(prev.height - height) < 1
          ? prev
          : { width, height },
      );
    };

    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) measure(rect.width, rect.height);
    });
    observer.observe(element);

    const rect = element.getBoundingClientRect();
    measure(rect.width, rect.height);
    return () => observer.disconnect();
  }, [element]);

  return [box, setElement];
}

/** True below the `sm` breakpoint (where the 5-column board is used). */
function useNarrowBoard() {
  const [narrow, setNarrow] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return undefined;
    }
    const query = window.matchMedia("(max-width: 639px)");
    const apply = () => setNarrow(query.matches);
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, []);

  return narrow;
}

export default function KenoPvpMatchPage({ params }) {
  const router = useRouter();
  const posthog = usePostHog();
  const { socket } = useSocket();
  const shouldReduceMotion = useReducedMotion();

  const [matchId, setMatchId] = useState(null);
  const [match, setMatch] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [now, setNow] = useState(Date.now());
  const [clockOffset, setClockOffset] = useState(0); // ms: serverNow = clientNow + offset
  // Latest resolved-tile event, shown as a short banner. Derived from the
  // public tile log (never from local guesses), so it can never disagree
  // with the server.
  const [feedEntry, setFeedEntry] = useState(null);
  // Local tap feedback only (pending ring / too-slow flash).
  const [claiming, setClaiming] = useState(false);
  const [tapMiss, setTapMiss] = useState(null);
  const [showRules, setShowRules] = useState(false);
  const [leaving, setLeaving] = useState(false);
  // Local (optimistic) "I have readied" flag for the get-ready panel. Keno
  // has no server-side ready flag: the server lights the first tile when its
  // own ready window elapses, so this only drives the player's own state.
  const [selfReady, setSelfReady] = useState(false);
  const [flashSeat, setFlashSeat] = useState(null); // "you" | "opp" | null
  const [showResult, setShowResult] = useState(false);
  // Mobile "collapsed sidebar" sheet. Layout state only — no match state.
  const [detailsOpen, setDetailsOpen] = useState(false);
  // Feedback only. Never match state: every value below is a message about a
  // payload the server already sent, and none of it gates a claim.
  const [lifeEvent, setLifeEvent] = useState(null); // { text, tone }
  const [heartPulse, setHeartPulse] = useState({ you: 0, opp: 0 });
  const [justClaimedTile, setJustClaimedTile] = useState(null);

  // Synchronous in-flight guard: one tap per live tile. A ref so a second
  // tap in the same tick is dropped before it can race the first request.
  const claimingRef = useRef(false);
  // Status-read ordering. Several reads can be in flight at once (the 5s
  // poll, a socket push, the deadline nudge) and they can resolve out of
  // order — the sequence number lets only the newest response commit a
  // snapshot.
  const statusSeqRef = useRef(0);
  const lastAppliedStatusSeqRef = useRef(0);
  const lastStatusRef = useRef(null);
  const deadlineNudgedRef = useRef(null);
  const feedTimerRef = useRef(null);
  const flashTimerRef = useRef(null);
  const tapMissTimerRef = useRef(null);
  const resultTimerRef = useRef(null);
  const lifeEventTimerRef = useRef(null);
  const heartPulseTimerRef = useRef(null);
  const claimRippleTimerRef = useRef(null);
  // Keyboard claim buffer (desktop): the digits typed so far for the live
  // tile. Numbers above 9 need a second key, so the buffer is what turns
  // "1" then "7" into tile 17 — and "7" alone into no claim at all.
  const keyBufferRef = useRef("");
  const keyBufferTimerRef = useRef(null);
  const confettiFiredRef = useRef(false);
  // Highest tile-log index already announced, so a poll/socket snapshot
  // can never replay a banner or a life-loss flash.
  const seenLogIndexRef = useRef(-1);
  // The live tile index whose audio tick has already played.
  const tickedIndexRef = useRef(-1);

  // Show one short banner for a newly resolved tile.
  const showFeed = useCallback((entry, ms = 2200) => {
    setFeedEntry(entry);
    if (feedTimerRef.current) clearTimeout(feedTimerRef.current);
    feedTimerRef.current = setTimeout(() => {
      feedTimerRef.current = null;
      setFeedEntry(null);
    }, ms);
  }, []);

  const triggerSeatFlash = useCallback((who) => {
    setFlashSeat(who);
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    flashTimerRef.current = setTimeout(() => setFlashSeat(null), 1800);
  }, []);

  /**
   * Announce a life loss that the payload just reported. `myDrop`/`oppDrop`
   * were derived by comparing the previous payload with this one — the client
   * never decrements a life itself. Handles the simultaneous case (a both-miss
   * that can eliminate both players → draw) with one message and a break on
   * BOTH seats' hearts.
   */
  const announceLifeLoss = useCallback(
    ({ myDrop, oppDrop, myLives, oppLives, oppName: rivalName }) => {
      const both = myDrop && oppDrop;
      const text = both
        ? myLives === 0 && oppLives === 0
          ? "Both eliminated — draw."
          : `Both lost a life — you ${myLives}, ${rivalName} ${oppLives}.`
        : myDrop
          ? `Life lost — ${myLives} remaining.`
          : `${rivalName} lost a life — ${oppLives} left.`;

      setLifeEvent({ text, tone: myDrop || both ? "miss" : "opp" });
      if (lifeEventTimerRef.current) clearTimeout(lifeEventTimerRef.current);
      lifeEventTimerRef.current = setTimeout(() => {
        lifeEventTimerRef.current = null;
        setLifeEvent(null);
      }, 2800);

      setHeartPulse((prev) => ({
        you: prev.you + (myDrop ? 1 : 0),
        opp: prev.opp + (oppDrop ? 1 : 0),
      }));
      if (heartPulseTimerRef.current) clearTimeout(heartPulseTimerRef.current);
      heartPulseTimerRef.current = setTimeout(
        () => setHeartPulse({ you: 0, opp: 0 }),
        950,
      );

      if (myDrop) playBuzz();
    },
    [],
  );

  // Short confetti burst when YOU take the match. Fires once per match
  // (guard ref); visible because the result modal is held back ~1.2s.
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
    } catch {
      // Best-effort — ignore.
    }
  }, []);

  // Clean up timers + in-flight bookkeeping on unmount.
  useEffect(() => {
    return () => {
      if (feedTimerRef.current) clearTimeout(feedTimerRef.current);
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
      if (tapMissTimerRef.current) clearTimeout(tapMissTimerRef.current);
      if (resultTimerRef.current) clearTimeout(resultTimerRef.current);
      if (lifeEventTimerRef.current) clearTimeout(lifeEventTimerRef.current);
      if (heartPulseTimerRef.current) clearTimeout(heartPulseTimerRef.current);
      if (claimRippleTimerRef.current) clearTimeout(claimRippleTimerRef.current);
      if (streakTimerRef.current) clearTimeout(streakTimerRef.current);
      if (keyBufferTimerRef.current) clearTimeout(keyBufferTimerRef.current);
      claimingRef.current = false;
    };
  }, []);

  // Resolve the [matchId] param (Next 15/16 passes params as a Promise).
  useEffect(() => {
    (async () => {
      const p = await params;
      setMatchId(Number(p?.matchId));
    })();
  }, [params]);

  const fetchStatus = useCallback(async () => {
    if (!matchId) return;
    const seq = (statusSeqRef.current += 1);
    try {
      const t0 = Date.now();
      const res = await fetch(`/api/keno-pvp/match/${matchId}`, {
        cache: "no-store",
      });
      const json = await res.json();
      // Clock sync: the response carries the server's clock. Estimate the
      // server↔client offset from the request midpoint and smooth it —
      // the tile deadline is a server-set absolute, so comparing against
      // the server clock keeps the window aligned with the server's
      // grading. Ignore samples from slow/hung requests.
      const t1 = Date.now();
      const serverTime = Number(json.data?.serverTime);
      if (Number.isFinite(serverTime) && serverTime > 0 && t1 - t0 < 2000) {
        const sample = serverTime - (t0 + t1) / 2;
        setClockOffset((prev) => (prev === 0 ? sample : prev * 0.7 + sample * 0.3));
      }
      if (!json.success) {
        if (res.status === 401) {
          router.push(
            "/sign-in?redirect_url=" +
              encodeURIComponent(`/casino/keno-pvp/${matchId}`),
          );
        }
        setError(json.error || "Failed to load match");
        return;
      }
      setError(null);
      // Newest snapshot wins: an older read must not roll the board back
      // to a tile that has already been resolved.
      if (seq <= lastAppliedStatusSeqRef.current) return;
      lastAppliedStatusSeqRef.current = seq;

      const m = json.data.match;
      setMatch(m);

      const log = Array.isArray(m.tileLog) ? m.tileLog : [];
      const newest = log.length > 0 ? log[log.length - 1] : null;
      const newestIndex = newest ? Number(newest.index) : -1;

      if (Number.isFinite(newestIndex) && newestIndex > seenLogIndexRef.current) {
        seenLogIndexRef.current = newestIndex;
        const oppName =
          m.players?.[m.viewerIsPlayer1 ? "p2" : "p1"]?.displayName ||
          (m.isAi ? "GRYND AI" : "Your opponent");
        const line = feedLineFor(newest, Boolean(m.viewerIsPlayer1), oppName);
        if (line) showFeed(line);
        // Life-loss flash on the seat that dropped.
        const prev = lastStatusRef.current;
        const p1Dropped =
          prev && Number(newest.p1Lives) < Number(prev.p1Lives ?? STARTING_LIVES);
        const p2Dropped =
          prev && Number(newest.p2Lives) < Number(prev.p2Lives ?? STARTING_LIVES);
        const myDropped = Boolean(m.viewerIsPlayer1 ? p1Dropped : p2Dropped);
        const oppDropped = Boolean(m.viewerIsPlayer1 ? p2Dropped : p1Dropped);
        if (prev && (myDropped || oppDropped)) {
          announceLifeLoss({
            myDrop: myDropped,
            oppDrop: oppDropped,
            myLives: Number(m.viewerIsPlayer1 ? m.p1Lives : m.p2Lives) || 0,
            oppLives: Number(m.viewerIsPlayer1 ? m.p2Lives : m.p1Lives) || 0,
            oppName,
          });
          triggerSeatFlash(myDropped ? "you" : "opp");
        }
      }

      // Result modal is held back ~1.2s so the final board + the winning
      // flash are visible before the overlay covers the screen.
      if (m.status === "finished" && lastStatusRef.current?.status !== "finished") {
        if (resultTimerRef.current) clearTimeout(resultTimerRef.current);
        resultTimerRef.current = setTimeout(() => setShowResult(true), 1200);
      } else if (m.status !== "finished") {
        if (resultTimerRef.current) clearTimeout(resultTimerRef.current);
        setShowResult(false);
      }
      lastStatusRef.current = m;
    } catch {
      // Network failure (e.g. ERR_INTERNET_DISCONNECTED): surface it and
      // clear the loading state so the page never sits on a blank screen
      // forever. The poll keeps retrying and clears it once connectivity
      // returns.
      setLoading(false);
      setError("Can't reach the server — check your connection. Retrying…");
    }
  }, [matchId, router, showFeed, triggerSeatFlash, announceLifeLoss]);

  useEffect(() => {
    if (!matchId) return;
    fetchStatus();
  }, [matchId, fetchStatus]);

  // ── Status flags ───────────────────────────────────────────────────────
  //
  // Derived from `match` and declared HERE, above the hooks that read them.
  // They used to sit further down the component, which made
  // `Boolean(match?.isAi) && !isFinished` below a temporal-dead-zone read: a
  // PvP match short-circuited on the left operand and hid it, but the moment a
  // practice (AI) match's payload landed — i.e. as soon as you joined a free
  // game — `!isFinished` threw `ReferenceError: Cannot access 'isFinished'
  // before initialization` during render and the route error boundary took the
  // whole screen ("This screen hit a problem").
  const isWaiting = match?.status === "waiting";
  const isReady = match?.status === "ready";
  const isLive = Boolean(match?.status) && /^round_\d+$/.test(match.status);
  const isFinished = match?.status === "finished";
  const isCancelled = match?.status === "cancelled";

  // Socket room (KENO_PVP_MATCH_UPDATED) pushes opponent actions instantly;
  // this poll is the reconnect safety net. It relaxes while the socket is
  // healthy and tightens if it drops, and it stops while the tab is hidden.
  // Tile pacing comes from the server deadline + the local 100ms clock, never
  // from the poll rate.
  // ── Practice pause (vs AI only) ────────────────────────────────────────
  const practicePause = usePracticePause({
    game: "keno-pvp",
    matchId,
    enabled: Boolean(match?.isAi) && !isFinished,
    onResume: fetchStatus,
  });
  const paused = practicePause.paused;
  const pausedRef = practicePause.pausedRef;

  useMatchSync(fetchStatus, socket, Boolean(matchId) && !paused);

  // …plus the ONE read the ready banner needs. The tile window is nudged just
  // below, but the ready banner is a separate instant (it only becomes the first
  // lit tile inside a read), so both seats could sit on "Get ready…" forever.
  // Which instant counts is `kenoPvpDueRead` (see `lib/deadlineRead.ts`).
  //
  // `serverNow` hands the read the page's own estimate of the server clock, so
  // the countdown reaching 0 is what FIRES it rather than a slack added on top —
  // the same offset the tile nudge below already times itself with. Without it
  // the first tile still arrived, just a fixed ~400ms after the countdown ended
  // (the reported "the countdown hits 0 and the game doesn't start").
  useDeadlineRead(paused ? null : kenoPvpDueRead(match), fetchStatus, {
    serverNow: () => Date.now() + clockOffset,
  });

  // Tile-deadline nudge: the server only resolves a both-miss when it is
  // read, so without this the board can sit on an expired tile for up to a
  // whole poll tick. One extra status read just after the deadline (+ the
  // hidden grace), and at most one nudge per deadline.
  useEffect(() => {
    const deadlineMs = match?.liveDeadline
      ? new Date(match.liveDeadline).getTime()
      : null;
    if (!matchId || deadlineMs == null || !Number.isFinite(deadlineMs)) {
      deadlineNudgedRef.current = null;
      return;
    }
    const grace = Number(match.tapGraceMs) || 0;
    if (deadlineNudgedRef.current === deadlineMs) return;
    const delay = Math.max(
      0,
      deadlineMs + grace - (Date.now() + clockOffset) + DEADLINE_NUDGE_CUSHION_MS,
    );
    const timer = setTimeout(() => {
      deadlineNudgedRef.current = deadlineMs;
      void fetchStatus();
    }, delay);
    return () => clearTimeout(timer);
  }, [matchId, match?.liveDeadline, match?.tapGraceMs, clockOffset, fetchStatus]);

  // ── Free practice: let the bot actually take its turn ────────────────
  // A free (AI) match's bot claims are decided and written SERVER-side, but
  // only when the server is read at/after the bot's own reaction time inside
  // the live tile's window. Nothing else reads that often — the 5s backstop
  // poll and the deadline nudge are both too late, and the store explicitly
  // refuses to claim once the window has expired. Without this sweep the bot
  // is never asked in time, so every tile resolves as a both-miss and the AI
  // appears to do nothing at all.
  //
  // The sweep uses the dedicated ai-turn route (it only runs the bot's due
  // claim and returns a count, rather than a full match read) and pulls the
  // board once the bot has actually tapped. Scoped to a free AI match, where
  // this viewer is the human seat, with a live tile on the board — a
  // human-vs-human duel keeps its single 5s poll.
  useEffect(() => {
    if (!matchId || !match?.isAi || !match?.viewerIsPlayer1 || paused) return undefined;
    if (!match?.viewerCanClaim) return undefined;

    let cancelled = false;
    const probe = async () => {
      try {
        const res = await fetch(`/api/keno-pvp/match/${matchId}/ai-turn`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({}),
        });
        const json = await res.json();
        if (cancelled) return;
        // The bot tapped: repaint the board (its claim + the next live tile).
        if (json?.success && Number(json.data?.actions) > 0) void fetchStatus();
      } catch {
        // Network failure — the next probe retries.
      }
    };

    // One ask straight away (covers a tile we only learned about late), then
    // the burst across the bot's reaction band.
    void probe();
    const timers = AI_TURN_PROBE_OFFSETS_MS.map((offset) =>
      setTimeout(probe, offset),
    );
    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
  }, [
    matchId,
    match?.isAi,
    match?.viewerIsPlayer1,
    match?.viewerCanClaim,
    match?.liveTile,
    match?.liveTileIndex,
    fetchStatus,
    paused,
  ]);

  // Socket live-update: refresh instantly on opponent actions.
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

  // Board clock (100ms ticks drive the window bar + the ring seconds).
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(interval);
  }, []);

  // Subtle audio tick the moment a new tile lights up. Synthesised with
  // the Web Audio API (no asset needed); the context is created lazily and
  // resumed on the first user gesture. Best-effort.
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

  // Unlock the shared audio context on the first user gesture.
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

  // Server-view of "now": every timing comparison uses the server clock.
  const serverNow = now + clockOffset;

  // ── Viewport layout ──────────────────────────────────────────────
  // Hooks must run before the loading/empty early returns below.
  const narrowBoard = useNarrowBoard();
  const [boardBox, attachBoardArea] = useElementBox();

  // Reaction + streak read-outs for the sidebar. Derived ONLY from the public
  // tile log (presentation, never authority): a "streak" is how many resolved
  // tiles in a row this seat claimed. Tiles either player can claim, so both
  // seats may hold a streak at once.
  const viewerStats = useMemo(() => {
    const log = Array.isArray(match?.tileLog) ? match.tileLog : [];
    const isP1 = Boolean(match?.viewerIsPlayer1);
    // Streaks are replayed from the PUBLIC log by the shared helper, so the
    // page, the tests and a historical replay always agree on the counts.
    const runs = streakStats(log);
    const myRun = isP1 ? runs.p1Run : runs.p2Run;
    const oppRun = isP1 ? runs.p2Run : runs.p1Run;
    const myBest = isP1 ? runs.p1Best : runs.p2Best;
    const oppBest = isP1 ? runs.p2Best : runs.p1Best;
    const num = (value) =>
      value == null || !Number.isFinite(Number(value))
        ? null
        : Math.max(0, Math.round(Number(value)));
    const last = log.length > 0 ? log[log.length - 1] : null;
    const myLast = last ? num(isP1 ? last.p1ReactionMs : last.p2ReactionMs) : null;
    const oppLast = last ? num(isP1 ? last.p2ReactionMs : last.p1ReactionMs) : null;
    return {
      myRun,
      oppRun,
      myBest,
      oppBest,
      myLast,
      oppLast,
      delta: myLast != null && oppLast != null ? myLast - oppLast : null,
    };
  }, [match?.tileLog, match?.viewerIsPlayer1]);

  // ── Cosmetic streak milestones ─────────────────────────────────────
  // Purely decorative: the run is replayed from the public log, the newest
  // entry's INDEX is the idempotency key (a re-delivered snapshot can never
  // double-fire), and nothing here touches a claim, a life, a deadline, the
  // board or the result. Celebrations live in the status row and the seat
  // cards — never over the active target — and they never block input.
  const [streakMilestone, setStreakMilestone] = useState(null);
  const streakEntryIndexRef = useRef(-1);
  const streakPrimedRef = useRef(false);
  const streakTimerRef = useRef(null);
  // A page opened mid-match must not replay milestones it never witnessed.
  useEffect(() => {
    const log = Array.isArray(match?.tileLog) ? match.tileLog : [];
    if (log.length === 0) return;
    const newest = log[log.length - 1];
    const index = Number(newest?.index);
    if (!Number.isInteger(index) || index <= streakEntryIndexRef.current) return;
    streakEntryIndexRef.current = index;
    if (!streakPrimedRef.current) {
      streakPrimedRef.current = true;
      return;
    }
    const hits = streakMilestoneAt(log);
    if (hits.length === 0) return;
    const viewerSeat = match?.viewerIsPlayer1 ? "p1" : "p2";
    const hit = hits.find((h) => h.seat === viewerSeat) || hits[0];
    const seat = hit.seat === viewerSeat ? "you" : "opp";
    setStreakMilestone({ seat, count: hit.count });
    if (seat === "you") playGoodReveal();
    if (streakTimerRef.current) clearTimeout(streakTimerRef.current);
    streakTimerRef.current = setTimeout(() => {
      streakTimerRef.current = null;
      setStreakMilestone(null);
    }, 1800);
  }, [match?.tileLog, match?.viewerIsPlayer1]);

  useEffect(() => {
    setLoading(false);
  }, [match]);

  const liveTile = match?.liveTile ?? null;
  const windowMs = Number(match?.windowMs) || tileWindowMs(0);
  const liveDeadlineMs = match?.liveDeadline
    ? new Date(match.liveDeadline).getTime()
    : 0;
  const remainingMs = liveDeadlineMs
    ? windowRemainingMs({ deadlineMs: liveDeadlineMs, atMs: serverNow })
    : 0;
  const remainingSec = remainingMs / 1000;
  const remainingRatio = windowMs > 0 ? remainingMs / windowMs : 0;
  // Countdown warning phase. Derived ONLY from the server deadline and the
  // server clock (`remainingMs`), so it is a colour hint and nothing more:
  // the server still grades every tap against `liveDeadline + tapGraceMs`,
  // and no client-side deadline is created.
  const windowExpired = Boolean(isLive && liveTile != null && remainingMs <= 0);
  const windowUrgent = Boolean(
    isLive &&
      liveTile != null &&
      !windowExpired &&
      (remainingRatio <= 0.4 || remainingMs <= 500),
  );
  const windowPhase = windowExpired ? "expired" : windowUrgent ? "urgent" : "normal";
  // This viewer has already tapped the tile that is lit RIGHT NOW. The tile
  // stays lit for the rest of its window — the other player may still save
  // themselves — so the board has to say so instead of looking stuck.
  const iAmSafeOnLiveTile = Boolean(liveTile != null && match?.myClaimedLive);

  // Get-ready countdown — the real remaining seconds until the server
  // lights the first tile, read off the server clock like the tile window.
  const readyDeadlineMs = match?.readyDeadline
    ? new Date(match.readyDeadline).getTime()
    : 0;
  const readyRemainingMs = readyDeadlineMs
    ? Math.max(0, readyDeadlineMs - serverNow)
    : 0;

  // Audio tick once per newly lit tile.
  useEffect(() => {
    const index = Number(match?.liveTileIndex);
    if (!isLive || liveTile == null || !Number.isInteger(index)) return;
    if (index === tickedIndexRef.current) return;
    tickedIndexRef.current = index;
    playTileTick();
  }, [isLive, liveTile, match?.liveTileIndex, playTileTick]);

  // Board sets — derived from the PUBLIC tile log, so the board can never
  // mislabel a tile the server resolved differently.
  const { myClaimedSet, oppClaimedSet, missedSet } = useMemo(() => {
    const mine = new Set();
    const opp = new Set();
    const missed = new Set();
    const viewerSeat = match?.viewerIsPlayer1 ? "player1" : "player2";
    for (const entry of Array.isArray(match?.tileLog) ? match.tileLog : []) {
      const tile = Number(entry?.tile);
      if (!Number.isInteger(tile)) continue;
      const myKey = viewerSeat === "player1" ? "p1Claimed" : "p2Claimed";
      const theirKey = viewerSeat === "player1" ? "p2Claimed" : "p1Claimed";
      const outcome = entry.outcome;
      // Per-player flags first (a tile can be claimed by BOTH players now).
      // The legacy outcome strings are the fallback for old log entries.
      const iClaimed =
        myKey in entry
          ? Boolean(entry[myKey])
          : outcome === viewerSeat || outcome === "both_claim";
      const theyClaimed =
        theirKey in entry
          ? Boolean(entry[theirKey])
          : outcome === (viewerSeat === "player1" ? "player2" : "player1") ||
            outcome === "both_claim";
      if (iClaimed) mine.add(tile);
      if (theyClaimed) opp.add(tile);
      // A life is lost only for your own miss.
      if (!iClaimed) missed.add(tile);
    }
    return { myClaimedSet: mine, oppClaimedSet: opp, missedSet: missed };
  }, [match?.tileLog, match?.viewerIsPlayer1]);

  // Result sting, fired with the result PANEL rather than the instant the
  // row settles. `showResult` flips exactly once per finished match and
  // the guard ref makes the sound fire once even if more snapshots arrive.
  const resultSoundFiredRef = useRef(false);
  useEffect(() => {
    if (!isFinished) {
      resultSoundFiredRef.current = false;
      return;
    }
    if (!showResult || resultSoundFiredRef.current) return;
    resultSoundFiredRef.current = true;
    if (!match?.result || match.result === "draw") playTick();
    else if (match.result === (match.viewerIsPlayer1 ? "player1" : "player2")) {
      playVictory();
    } else playDefeat();
  }, [isFinished, showResult, match?.result, match?.viewerIsPlayer1]);

  // Win → confetti + seat flash, once the newest log entry shows the
  // opponent (or us) at zero lives.
  useEffect(() => {
    if (!isFinished || !match?.result || match.result === "draw") return;
    const iWon = match.result === (match.viewerIsPlayer1 ? "player1" : "player2");
    triggerSeatFlash(iWon ? "you" : "opp");
    if (iWon) triggerWinConfetti();
  }, [isFinished, match?.result, match?.viewerIsPlayer1, triggerSeatFlash, triggerWinConfetti]);

  const doClaim = useCallback(
    async (tileNumber) => {
      if (!matchId || pausedRef.current) return;
      if (tileNumber !== Number(match?.liveTile)) return;
      if (claimingRef.current) return;
      const deadline = match?.liveDeadline
        ? new Date(match.liveDeadline).getTime()
        : 0;
      const grace = Number(match?.tapGraceMs) || 0;
      if (deadline && Date.now() + clockOffset > deadline + grace) return;

      claimingRef.current = true;
      setClaiming(true);
      try {
        const res = await fetch(`/api/keno-pvp/match/${matchId}/catch`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ tile: tileNumber }),
        });
        const json = await res.json();
        if (!json.success) {
          const reason = json.error || "";
          if (TAP_MISS_REASONS.has(reason)) {
            setTapMiss({ text: missTextFor(reason) });
            if (tapMissTimerRef.current) clearTimeout(tapMissTimerRef.current);
            tapMissTimerRef.current = setTimeout(() => setTapMiss(null), 1100);
            playBuzz();
          }
          // Reconcile either way: a rejected tap usually means the tile
          // already moved on.
          void fetchStatus();
          return;
        }
        playGoodReveal();
        // Confirmed by the server. Start the impact ring here (never before
        // the response) so feedback can't delay the request or the next tile.
        setJustClaimedTile(tileNumber);
        if (claimRippleTimerRef.current) clearTimeout(claimRippleTimerRef.current);
        claimRippleTimerRef.current = setTimeout(() => {
          claimRippleTimerRef.current = null;
          setJustClaimedTile(null);
        }, 650);
        posthog?.capture("keno_pvp_claimed", {
          match_id: matchId,
          tile: tileNumber,
          reaction_ms: json.data?.claim?.reactionMs,
        });
        // Pull the freshly lit tile immediately rather than waiting for
        // the next poll.
        void fetchStatus();
        socket?.emit("room_event", {
          roomId: kenoPvpMatchRoom(matchId),
          event: KENO_PVP_MATCH_UPDATED,
        });
        if (match?.isAi) {
          void fetch(`/api/keno-pvp/match/${matchId}/ai-turn`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({}),
          }).catch(() => {});
        }
      } catch {
        // Network failure — silent; the poll reconciles.
      } finally {
        claimingRef.current = false;
        setClaiming(false);
      }
    },
    [matchId, match?.liveTile, match?.liveDeadline, match?.tapGraceMs, match?.isAi, clockOffset, fetchStatus, posthog, socket],
  );

  // ── E. Desktop keyboard claim ───────────────────────────────────────
  // Typing the lit tile's number runs the SAME validated claim as a tap
  // (`doClaim`): the server clock, the tile-identity check, the per-tile
  // in-flight guard and the server's grading all still apply, and nothing is
  // optimistic. Numbers above 9 are buffered ("1" then "7" → 17). Ignored
  // while any overlay is open, and never intercepted inside a text field.
  useEffect(() => {
    if (!isLive || !match?.viewerCanClaim || paused) return undefined;
    const live = match?.liveTile == null ? "" : String(match.liveTile);
    if (!live) return undefined;

    const onKeyDown = (event) => {
      if (event.defaultPrevented || event.repeat) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (!/^[0-9]$/.test(event.key)) return;
      if (showRules || detailsOpen || showResult) return;
      if (event.target instanceof HTMLElement) {
        if (event.target.isContentEditable) return;
        if (/^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)) return;
      }
      if (typeof document !== "undefined" && document.querySelector('[role="dialog"]')) {
        return;
      }

      const next = `${keyBufferRef.current}${event.key}`;
      if (next === live) {
        keyBufferRef.current = "";
        if (keyBufferTimerRef.current) clearTimeout(keyBufferTimerRef.current);
        keyBufferTimerRef.current = null;
        event.preventDefault();
        doClaim(Number(live));
        return;
      }
      if (live.startsWith(next)) {
        keyBufferRef.current = next;
        if (keyBufferTimerRef.current) clearTimeout(keyBufferTimerRef.current);
        keyBufferTimerRef.current = setTimeout(() => {
          keyBufferTimerRef.current = null;
          keyBufferRef.current = "";
        }, 1200);
        return;
      }
      // Not a prefix of the live tile: restart from this key, never claim.
      keyBufferRef.current = live.startsWith(event.key) ? event.key : "";
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    isLive,
    match?.viewerCanClaim,
    match?.liveTile,
    paused,
    showRules,
    detailsOpen,
    showResult,
    doClaim,
  ]);

  const goToLobby = useCallback(() => {
    if (leaving) return;
    setLeaving(true);
    router.push("/casino/keno");
  }, [leaving, router]);

  // Resign a live match. The disconnect-forfeit store call is the same
  // settlement path the realtime server uses, so the opponent wins and the
  // pot is paid exactly once; then the status poll paints the result screen.
  const resignMatch = useCallback(async () => {
    if (!matchId || leaving) return;
    setLeaving(true);
    try {
      await fetch(`/api/keno-pvp/match/${matchId}/resign`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
      });
      await fetchStatus();
    } catch {
      // Poll reconciles on the next tick.
    } finally {
      setLeaving(false);
    }
  }, [matchId, leaving, fetchStatus]);

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
  // lives ABOVE the loading/match early returns below.
  const { incomingEmote, myEmote, sendEmote } = useGameEmotes({
    socket,
    roomId: matchId ? `keno:emote:${matchId}` : null,
    eventName: "keno:emote",
    selfId: match ? (match.viewerIsPlayer1 ? "player1" : "player2") : null,
  });

  if (loading && !match) {
    // Branded shell WITH the nav bar (this gate used to drop it entirely).
    return <MatchLoading currentPath="/casino/keno" />;
  }

  if (!match) {
    return (
      <div className="min-h-screen bg-[#001933] text-white flex items-center justify-center">
        <div className="text-center space-y-4">
          <p className="text-lg">{error || "Match not found"}</p>
        </div>
      </div>
    );
  }

  const me = match.viewerIsPlayer1 ? "player1" : "player2";
  const opponent = match.viewerIsPlayer1 ? "player2" : "player1";
  const myLives = match.viewerIsPlayer1 ? match.p1Lives : match.p2Lives;
  const oppLives = match.viewerIsPlayer1 ? match.p2Lives : match.p1Lives;
  const myTiles = match.viewerIsPlayer1 ? match.p1Tiles : match.p2Tiles;
  const oppTiles = match.viewerIsPlayer1 ? match.p2Tiles : match.p1Tiles;

  const p1Name = match.players?.p1?.displayName || match.player1Id?.slice(0, 6) || "P1";
  const p2Name = match.isAi
    ? "GRYND AI"
    : match.players?.p2?.displayName || match.player2Id?.slice(0, 6) || "P2";
  const myName = me === "player1" ? p1Name : p2Name;
  const oppName = me === "player1" ? p2Name : p1Name;

  // Seat identity — the server already enriches `players` with the
  // official Grynd icon key + equipped name color per seat (keyed p1/p2);
  // the AI seat stays null and falls back to the GRYND AI label.
  const mySeatSummary = match.viewerIsPlayer1
    ? match.players?.p1 ?? null
    : match.players?.p2 ?? null;
  const oppSeatSummary = match.viewerIsPlayer1
    ? match.players?.p2 ?? null
    : match.players?.p1 ?? null;
  const myNameColor = mySeatSummary?.nameColor || null;
  const oppNameColor = oppSeatSummary?.nameColor || null;
  const myNameEffect =
    cosmeticEffectClass(mySeatSummary?.profileFrame?.usernameEffect?.visual) || "";
  const oppNameEffect =
    cosmeticEffectClass(oppSeatSummary?.profileFrame?.usernameEffect?.visual) || "";

  // ── Waiting room (rendered in place of the board) ───────────────────
  // Shown while the match is filling up and during the server's get-ready
  // banner. The board only mounts once the run is live, so this is the whole
  // content of the page until then.
  const waitingPanelNode =
    isWaiting || isReady ? (
      <KenoWaitingPanel
        matchId={matchId}
        state={isReady ? "ready" : "waiting"}
        isAi={Boolean(match.isAi)}
        stakeAmount={match.stakeAmount}
        myName={myName}
        oppName={oppName}
        mySeatSummary={mySeatSummary}
        oppSeatSummary={oppSeatSummary}
        selfReady={selfReady}
        readyRemainingMs={readyDeadlineMs ? readyRemainingMs : null}
        onReadyClick={() => setSelfReady(true)}
        onCancel={isWaiting && match.viewerCanCancel ? cancelMatch : null}
        cancelling={leaving}
      />
    ) : null;

  const statusLine = liveStatusText({
    isLive,
    hasLiveTile: liveTile != null,
    remainingMs,
    savedByMe: iAmSafeOnLiveTile,
    viewerCanClaim: match.viewerCanClaim,
  });

  // ── Match layout: the board is sized from BOTH available axes ────
  // Width and height are used together, so a short laptop shrinks the tiles
  // instead of pushing the controls off-screen, and a phone gets real 44px
  // targets from five columns rather than eight slivers.
  const boardCols = narrowBoard ? 5 : 8;
  const boardRows = Math.ceil(KENO_NUMBERS.length / boardCols);
  const boardGap = narrowBoard ? 5 : 8;
  const measuredTile = Math.floor(
    Math.min(
      (boardBox.width - boardGap * (boardCols - 1)) / boardCols,
      (boardBox.height - boardGap * (boardRows - 1)) / boardRows,
    ),
  );
  const hasBoardMeasurement = Number.isFinite(measuredTile) && measuredTile > 0;
  const tilePx = Math.max(
    BOARD_TILE_MIN_PX,
    Math.min(
      BOARD_TILE_MAX_PX,
      hasBoardMeasurement ? measuredTile : narrowBoard ? 44 : 64,
    ),
  );
  // Only a very short window (where even the 30px floor cannot fit) lets the
  // board area scroll; every normal viewport fits without one.
  const boardScrolls = hasBoardMeasurement && measuredTile < BOARD_TILE_MIN_PX;

  // ── Scoreboard: lives + tiles claimed, per seat ────────────────────
  // ONE card shape renders in the desktop sidebar AND the mobile strip, so the
  // two layouts can never disagree about a player's lives or tiles.
  const seatCard = (side, compact = false) => {
    const isMe = side === "you";
    const lives = isMe ? myLives : oppLives;
    const tiles = isMe ? myTiles : oppTiles;
    const name = isMe ? myName : oppName;
    const summary = isMe ? mySeatSummary : oppSeatSummary;
    const nameColor = isMe ? myNameColor : oppNameColor;
    const nameEffect = isMe ? myNameEffect : oppNameEffect;
    const streak = isMe ? viewerStats.myRun : viewerStats.oppRun;
    const flashing = flashSeat === (isMe ? "you" : "opp");
    return (
      <div
        className={
          "relative flex min-w-0 flex-1 items-center gap-2 rounded-xl border px-2 py-1.5 transition-colors " +
          (isMe
            ? "border-[#00ffa6]/40 bg-[#00ffa6]/5"
            : "border-[#FFD700]/40 bg-[#FFD700]/5") +
          (flashing ? " ring-2 ring-white/70" : "") +
          (streakMilestone?.seat === (isMe ? "you" : "opp")
            ? " ring-2 ring-[#00e5ff]/70"
            : "")
        }
      >
        <FrameAvatar
          frame={summary?.profileFrame || null}
          iconKey={summary?.iconKey || null}
          name={name}
          isGuest={Boolean(summary?.isGuest)}
          size={compact ? "h-7 w-7" : "h-9 w-9"}
        />
        <div className="min-w-0 flex-1">
          <div
            className={`truncate font-bold ${compact ? "text-[11px]" : "text-xs"} ${nameEffect}`}
            style={nameColor ? { color: nameColor } : undefined}
          >
            {name}
            {isMe ? " (you)" : ""}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
            <LivesPips
              lives={lives}
              tone={isMe ? "cyan" : "opp"}
              size={compact ? "sm" : "md"}
              pulseKey={isMe ? heartPulse.you : heartPulse.opp}
            />
            <span className="text-[10px] font-semibold text-white/50">
              {lives} {lives === 1 ? "life" : "lives"} · {tiles} claimed
            </span>
          </div>
          {streak > 1 && (
            <span
              data-testid={`keno-streak-${isMe ? "you" : "opp"}`}
              aria-label={`${name} is on a ${streak}-tile streak`}
              className={
                "mt-0.5 inline-flex w-fit items-center rounded-full border px-1.5 py-0.5 text-[9px] font-black tabular-nums " +
                (streak >= 10
                  ? "border-[#FFD700]/60 bg-[#FFD700]/15 text-[#ffe98a]"
                  : streak >= 5
                    ? "border-[#00e5ff]/50 bg-[#00e5ff]/12 text-[#aef7ff]"
                    : "border-white/20 bg-white/5 text-white/70")
              }
            >
              x{streak} streak
            </span>
          )}
        </div>
        {!compact && <EmoteBubble emote={isMe ? myEmote : incomingEmote} />}
      </div>
    );
  };

  // ── Momentum chip ──────────────────────────────────────────────────
  // Brief, in the status row (outside the board column), so it can never
  // cover the active target or delay the next one. Stronger tiers are
  // louder only in weight/colour — nothing moves into the board area.
  const milestoneNode = (
    <AnimatePresence initial={false}>
      {streakMilestone && (
        <motion.span
          key={`${streakMilestone.seat}-${streakMilestone.count}`}
          role="status"
          aria-live="polite"
          data-testid="keno-streak-milestone"
          {...withReducedMotion(shouldReduceMotion, {
            initial: { opacity: 0, scale: 0.85 },
            animate: { opacity: 1, scale: 1 },
            exit: { opacity: 0, scale: 0.95 },
            transition: { duration: 0.25 },
          })}
          className={
            "max-w-[12rem] shrink-0 truncate rounded-full border px-2 py-0.5 text-[10px] font-black uppercase tracking-wide " +
            (streakMilestone.count >= 15
              ? "border-white/70 bg-[#FFD700]/25 text-white shadow-[0_0_16px_rgba(255,215,0,0.55)]"
              : streakMilestone.count >= 10
                ? "border-[#FFD700]/70 bg-[#FFD700]/15 text-[#ffe98a] shadow-[0_0_12px_rgba(255,215,0,0.35)]"
                : "border-[#00e5ff]/60 bg-[#00e5ff]/12 text-[#aef7ff]")
          }
        >
          {streakMilestone.seat === "you"
            ? `You ${streakMilestone.count} in a row`
            : `${oppName} ${streakMilestone.count} in a row`}
        </motion.span>
      )}
    </AnimatePresence>
  );

  // ── Live-tile clock ────────────────────────────────────────────────
  // Kept in the top bar (never in the board column) so the seconds, the tile
  // number and the window are on screen at every width, including phones.
  const windowNode = (
    <div
      role="status"
      aria-live="polite"
      data-testid="keno-window"
      className={
        "flex min-w-0 items-center gap-2 rounded-xl border px-2 py-1.5 shadow-[0_0_20px_rgba(0,229,255,0.12)] sm:gap-3 sm:px-3 " +
        (liveTile == null
          ? "border-[#00e5ff]/35 bg-[#050d1f]/80"
          : windowPhase === "expired"
            ? "border-red-400/80 bg-[#24060a]/85 motion-safe:animate-pulse"
            : windowPhase === "urgent"
              ? "border-amber-400/70 bg-[#1d1405]/85"
              : "border-[#00e5ff]/35 bg-[#050d1f]/80")
      }
    >
      <div className="flex shrink-0 flex-col leading-none">
        <span
          className={`mb-1 text-[9px] font-bold uppercase tracking-[0.16em] ${
            windowPhase === "expired"
              ? "text-[#ff8a97]"
              : windowPhase === "urgent"
                ? "text-[#ffc247]"
                : "text-white/45"
          }`}
        >
          {liveTile == null
            ? isLive
              ? "Lighting the next tile…"
              : statusLine || "Waiting…"
            : remainingSec <= 0
              ? "Window closed"
              : iAmSafeOnLiveTile
                ? "You tapped it — your life is safe"
                : "Tap the lit tile"}
        </span>
        <span
          className={`text-2xl font-black tabular-nums sm:text-3xl ${
            iAmSafeOnLiveTile
              ? "text-[#00ffa6]"
              : windowPhase === "expired"
                ? "text-[#ff6b7a]"
                : windowPhase === "urgent"
                  ? "text-[#ffc247]"
                  : "text-[#00e5ff]"
          }`}
        >
          {liveTile == null ? "—" : `${Math.max(0, remainingSec).toFixed(1)}s`}
        </span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-2 text-[10px] font-semibold text-white/55">
          <span className="truncate">
            Tile{" "}
            <span className="font-black text-white">{liveTile ?? "—"}</span> · window{" "}
            {windowMs / 1000}s
          </span>
          {liveTile != null && (
            <span className="hidden text-white/55 sm:inline">
              {iAmSafeOnLiveTile
                ? `${oppName} can still tap it until the window closes`
                : "tap it before your window closes"}
            </span>
          )}
        </div>
        {/* Window bar — a pure data read-out (no animation), so it stays
            readable with motion reduced. */}
        <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
          <div
            className={
              "h-full rounded-full transition-[width] duration-100 ease-linear " +
              (windowPhase === "expired"
                ? "bg-red-400"
                : windowPhase === "urgent"
                  ? "bg-amber-400"
                  : "bg-[#00e5ff]")
            }
            style={{ width: `${Math.max(0, Math.min(1, remainingRatio)) * 100}%` }}
          />
        </div>
      </div>
      {claiming && (
        <span className="hidden shrink-0 text-[10px] text-[#7cefff] sm:inline">
          sending…
        </span>
      )}
    </div>
  );

  // ── Resolved-tile banner ───────────────────────────────────────────
  // An OVERLAY on the board, never a block above it: a banner that grows the
  // column would push the board (and the controls) off a short laptop screen.
  // Last few resolved tiles, newest first — the match feed. Public log, so it
  // is shared information (never a local guess).
  const recentFeed = (Array.isArray(match.tileLog) ? match.tileLog : [])
    .slice(-4)
    .reverse();

  // ── Reaction-time rivalry (server-timed) ────────────────────────────
  // Both numbers come from the resolved tile's PUBLIC log entry, which the
  // server wrote from its own clock. A measured reaction includes the trip
  // from that player's device, so a gap under ~25ms is presented as even
  // rather than declaring a winner. Shown only while that tile's feedback is
  // on screen, in the one-line status row (never over the board).
  const lastEntry = recentFeed[0] ?? null;
  const msOrNull = (value) =>
    value == null || !Number.isFinite(Number(value))
      ? null
      : Math.max(0, Math.round(Number(value)));
  const lastMine = lastEntry
    ? msOrNull(match.viewerIsPlayer1 ? lastEntry.p1ReactionMs : lastEntry.p2ReactionMs)
    : null;
  const lastOpp = lastEntry
    ? msOrNull(match.viewerIsPlayer1 ? lastEntry.p2ReactionMs : lastEntry.p1ReactionMs)
    : null;
  const reactionChip =
    feedEntry && lastEntry && (lastMine != null || lastOpp != null) ? (
      <span
        className="hidden shrink-0 items-center gap-1 sm:inline-flex"
        title="Server-timed reaction; includes each player's network latency"
      >
        <span className="text-[#7dffcf]">
          you {lastMine != null ? `~${lastMine}ms` : "—"}
        </span>
        <span className="text-white/25">vs</span>
        <span className="text-[#ffe98a]">
          {lastOpp != null ? `~${lastOpp}ms` : "—"}
        </span>
        {lastMine != null && lastOpp != null && (
          <span className="text-white/35">
            {Math.abs(lastMine - lastOpp) <= 25
              ? "even"
              : lastMine < lastOpp
                ? `${lastOpp - lastMine}ms faster`
                : `${lastMine - lastOpp}ms slower`}
          </span>
        )}
      </span>
    ) : null;

  const pauseNode = practicePause.canPause ? (
    <PracticePauseChip
      paused={paused}
      busy={practicePause.busy}
      onToggle={() => void practicePause.toggle()}
      testId="keno-pvp-pause"
    />
  ) : null;

  const resignNode = isLive ? (
    <button
      type="button"
      onClick={resignMatch}
      disabled={leaving}
      className="w-full rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-1.5 text-[11px] font-bold text-red-300 transition hover:border-red-400/50 hover:text-red-200 disabled:opacity-50"
    >
      {leaving ? "Resigning…" : "Resign"}
    </button>
  ) : null;

  // ── Reaction + streak read-outs (secondary information) ────────────
  // Both come from the PUBLIC tile log, so neither can disagree with the
  // server; neither is ever used to grade anything.
  const reactionNode = (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2 text-[11px]">
        <span className="text-white/60">You</span>
        <span className="font-mono font-bold text-[#7dffcf]">
          {viewerStats.myLast != null ? `~${viewerStats.myLast}ms` : "—"}
        </span>
      </div>
      <div className="flex items-baseline justify-between gap-2 text-[11px]">
        <span className="text-white/60">{oppName}</span>
        <span className="font-mono font-bold text-[#ffe98a]">
          {viewerStats.oppLast != null ? `~${viewerStats.oppLast}ms` : "—"}
        </span>
      </div>
      <p className="text-[10px] text-white/60">
        {viewerStats.delta == null
          ? "Needs both players' timings"
          : Math.abs(viewerStats.delta) <= 25
            ? "Too close to call"
            : viewerStats.delta < 0
              ? `~${Math.abs(viewerStats.delta)}ms faster than ${oppName}`
              : `~${viewerStats.delta}ms slower than ${oppName}`}
      </p>
      <p className="text-[9px] text-white/45">
        Server-timed · includes network latency
      </p>
    </div>
  );

  const streakNode = (
    <div className="space-y-1 text-[11px]">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-white/60">You</span>
        <span className="font-bold text-[#7dffcf]">
          {viewerStats.myRun} now · best {viewerStats.myBest}
        </span>
      </div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-white/60">{oppName}</span>
        <span className="font-bold text-[#ffe98a]">
          {viewerStats.oppRun} now · best {viewerStats.oppBest}
        </span>
      </div>
    </div>
  );

  const feedListNode = (limit = 3) => {
    const entries = recentFeed.slice(0, limit);
    if (entries.length === 0) {
      return <p className="text-[10px] text-white/50">No tiles resolved yet.</p>;
    }
    return (
      <div className="space-y-1">
        {entries.map((entry) => {
          const line = feedLineFor(entry, Boolean(match.viewerIsPlayer1), oppName);
          const tone =
            line?.tone === "mine"
              ? "text-[#00ffa6]"
              : line?.tone === "opp"
                ? "text-[#FFD700]"
                : "text-red-300";
          return (
            <p key={`${entry.index}-${entry.tile}`} className="truncate text-[10px]">
              <span className="text-white/50">#{entry.index + 1}</span>{" "}
              <span className={tone}>{line?.text}</span>
              <span className="text-white/45"> · {(entry.windowMs || 0) / 1000}s</span>
            </p>
          );
        })}
      </div>
    );
  };

  const rulesButton = (label = "How to play") => (
    <button
      type="button"
      onClick={() => setShowRules(true)}
      aria-label={label}
      title={label}
      className="h-8 w-8 shrink-0 rounded-lg border border-[#00e5ff]/40 bg-[#0b224f]/70 text-sm font-bold text-[#7cefff] transition hover:border-[#00e5ff]/80 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
    >
      ?
    </button>
  );

  const detailsButton = (
    <button
      type="button"
      onClick={() => setDetailsOpen((open) => !open)}
      aria-expanded={detailsOpen}
      aria-controls="keno-match-details"
      aria-label={detailsOpen ? "Close match details" : "Match details"}
      className="shrink-0 rounded-lg border border-[#00e5ff]/40 bg-[#0b224f]/70 px-2.5 py-1.5 text-[11px] font-bold text-[#7cefff] transition hover:border-[#00e5ff]/80 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff] focus-visible:ring-offset-2 focus-visible:ring-offset-[#050b1e] lg:hidden"
    >
      {detailsOpen ? "Close" : "Details"}
    </button>
  );

  const errorNode = error ? (
    <div className="shrink-0 rounded-lg border border-red-400/40 bg-red-900/30 px-3 py-1.5 text-[11px] text-red-200">
      {error}
    </div>
  ) : null;

  const rulesNode = (
    <AnimatePresence>
      {showRules && <RulesModal onClose={() => setShowRules(false)} />}
    </AnimatePresence>
  );

  const titleNode = (
    <div className="flex min-w-0 items-center gap-2">
      <h1 className="logo-text flex min-w-0 items-center gap-1.5 truncate text-base font-black uppercase tracking-[0.06em] text-[#7cefff] drop-shadow-[0_0_14px_rgba(0,229,255,0.4)] sm:text-lg">
        <PoolBallIcon size={20} className="text-[#00e5ff]" /> Keno Survival Duel
      </h1>
      <span className="hidden shrink-0 items-center gap-1 text-[10px] font-semibold text-white/45 sm:inline-flex">
        {STARTING_LIVES} lives · stake
        <span className="font-bold text-white/80">
          {match.stakeAmount.toLocaleString()}
        </span>
        <IconCoins size={11} />
      </span>
    </div>
  );

  // ── Waiting / ready / cancelled ────────────────────────────────────
  // No board exists yet, so these keep the normal document flow (the waiting
  // panel is taller than a phone viewport at its smallest). The viewport-
  // filling shell below only mounts for a real run.
  if (!isLive && !isFinished) {
    return (
      <>
        <div className="min-h-screen overflow-x-clip bg-gradient-to-br from-[#001933] to-[#000d1a] px-3 pb-24 pt-16 text-white sm:px-6 sm:pt-20 md:pb-8 md:pt-24">
          <NavigationBar currentPath="/casino" />
          <GameSessionHost
            autoStart={false}
            autoStop={isFinished || isCancelled}
            gameLabel="keno"
          >
            <div className="mx-auto mt-4 max-w-3xl">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                {titleNode}
                <div className="flex items-center gap-2">
                  {rulesButton()}
                  {pauseNode}
                </div>
              </div>
              {rulesNode}
              {errorNode}
              {waitingPanelNode}
              {isCancelled && (
                <div className="rounded-2xl border border-red-400/30 bg-[#0b224f]/85 p-10 text-center">
                  <p className="mb-3">
                    <IconCircleX size={36} className="text-red-400" />
                  </p>
                  <h2 className="text-xl font-bold mb-2">Match cancelled</h2>
                  <p className="text-sm text-white/60 mb-6">
                    Your stake was refunded.
                  </p>
                </div>
              )}
              <Footer />
            </div>
          </GameSessionHost>
        </div>
        <PracticePauseOverlay
          paused={paused}
          busy={practicePause.busy}
          onResume={() => void practicePause.toggle()}
          testId="keno-pvp-pause-overlay"
        />
      </>
    );
  }

  // ── Live / finished: the viewport-filling match shell ──────────────
  // Height is 100dvh minus the fixed navbar and the bottom chrome (plus the
  // safe-area inset), so nothing here needs a page scroll: the board column
  // takes every pixel that is left and the tiles are sized from BOTH axes.
  return (
    <>
      <div className="relative flex h-[100dvh] flex-col overflow-hidden bg-gradient-to-br from-[#001933] to-[#000d1a] text-white">
        <NavigationBar currentPath="/casino" />
        <GameSessionHost
          autoStart={isLive}
          autoStop={isFinished || isCancelled}
          gameLabel="keno"
        >
          <div className="mx-auto flex h-full min-h-0 w-full max-w-[1700px] flex-col gap-1.5 px-2 pb-[calc(5rem+env(safe-area-inset-bottom))] pt-16 sm:gap-2 sm:px-4 sm:pt-20 md:pb-3 md:pt-24">
            {/* Top bar: identity, the live-tile clock, the always-reachable
                commands. */}
            <div className="flex shrink-0 items-center gap-2">
              <div className="hidden min-w-0 flex-1 lg:flex">{titleNode}</div>
              <div className="min-w-0 flex-1 lg:flex-[1.4]">{windowNode}</div>
              <div className="flex shrink-0 items-center gap-1.5">
                {rulesButton()}
                {detailsButton}
              </div>
            </div>

            {errorNode}

            <div className="flex min-h-0 flex-1 gap-2 sm:gap-3">
              <main className="flex min-h-0 min-w-0 flex-1 flex-col gap-1.5 sm:gap-2">
                {/* Mobile status strip: both seats' lives stay visible while
                    the details sheet is closed. */}
                <div className="flex shrink-0 items-stretch gap-1.5 lg:hidden">
                  {seatCard("you", true)}
                  {seatCard("opp", true)}
                </div>

                {/* The board: sized from the measured box, centered, and the
                    only thing that grows/shrinks with the viewport. */}
                <div
                  ref={attachBoardArea}
                  className={
                    "relative flex min-h-0 flex-1 items-center justify-center rounded-2xl border-2 border-[color:var(--gr-outline)] bg-[#050d1f]/70 p-1.5 shadow-[0_10px_0_-2px_rgba(3,8,20,0.9),inset_0_2px_0_rgba(255,255,255,0.05)] sm:p-2.5 " +
                    (boardScrolls ? "overflow-y-auto" : "overflow-hidden")
                  }
                >
                  <div
                    className="grid"
                    style={{
                      gridTemplateColumns: `repeat(${boardCols}, ${tilePx}px)`,
                      gridAutoRows: `${tilePx}px`,
                      gap: `${boardGap}px`,
                    }}
                  >
                    {KENO_NUMBERS.map((num) => (
                      <KenoTile
                        key={num}
                        num={num}
                        tilePx={tilePx}
                        isLive={isLive && liveTile === num && remainingMs > 0}
                        phase={liveTile === num ? windowPhase : "normal"}
                        ripple={justClaimedTile === num}
                        liveRemainingRatio={remainingRatio}
                        savedByMe={iAmSafeOnLiveTile && liveTile === num}
                        claimedByMe={myClaimedSet.has(num)}
                        claimedByOpp={oppClaimedSet.has(num)}
                        missed={missedSet.has(num)}
                        frozen={!match.viewerCanClaim || isFinished}
                        onClaim={doClaim}
                      />
                    ))}
                  </div>
                </div>

                {/* One-line feedback + counters. Priority: a rejected tap,
                    then a life-loss announcement (the authoritative one),
                    then the resolved-tile feed, then the standing hint. It
                    never sits over the board, so it can't hide the next tile. */}
                <div className="flex shrink-0 items-center justify-between gap-2 px-1 text-[10px]">
                  <span
                    aria-live="polite"
                    data-testid="keno-feedback"
                    className={
                      "min-w-0 truncate font-semibold " +
                      (tapMiss
                        ? "text-red-300"
                        : lifeEvent
                          ? lifeEvent.tone === "opp"
                            ? "text-[#ffe98a]"
                            : "text-red-300"                            : feedEntry
                              ? "text-[#d8fbff]"
                              : "text-white/60")
                    }
                  >
                    {tapMiss?.text ||
                      lifeEvent?.text ||
                      feedEntry?.text ||
                      statusLine ||
                      "Waiting for the next tile…"}
                  </span>
                  <span className="flex shrink-0 items-center gap-2 tabular-nums text-white/55">
                    {milestoneNode}
                    {reactionChip}
                    <span>
                      {match.claimedTotal} / {KENO_POOL_SIZE} tiles
                    </span>
                  </span>
                </div>
              </main>

              {/* Desktop sidebar: persistent opponent/lives/reaction/streak
                  information plus every secondary command. */}
              <aside className="hidden w-[17.5rem] shrink-0 flex-col gap-2 overflow-hidden lg:flex xl:w-[19.5rem]">
                <section className="rounded-2xl border border-[#00e5ff]/20 bg-[#04101f]/85 p-2">
                  <h2 className="px-1 pb-1 text-[9px] font-bold uppercase tracking-[0.2em] text-white/55">
                    Players
                  </h2>
                  <div className="flex flex-col gap-1.5">
                    {seatCard("you")}
                    {seatCard("opp")}
                  </div>
                </section>

                <section className="rounded-2xl border border-[#00e5ff]/20 bg-[#04101f]/85 p-2">
                  <h2 className="px-1 pb-1 text-[9px] font-bold uppercase tracking-[0.2em] text-white/55">
                    Last reaction
                  </h2>
                  {reactionNode}
                </section>

                <section className="rounded-2xl border border-[#00e5ff]/20 bg-[#04101f]/85 p-2">
                  <h2 className="px-1 pb-1 text-[9px] font-bold uppercase tracking-[0.2em] text-white/55">
                    Streaks
                  </h2>
                  {streakNode}
                </section>

                {/* Secondary history — hidden on short laptops so the command
                    row below can never be pushed out of view. */}
                <section className="hidden min-h-0 flex-1 flex-col rounded-2xl border border-[#00e5ff]/20 bg-[#04101f]/85 p-2 [@media(min-height:820px)]:flex">
                  <h2 className="px-1 pb-1 text-[9px] font-bold uppercase tracking-[0.2em] text-white/55">
                    Feed
                  </h2>
                  {feedListNode(3)}
                </section>

                <section className="rounded-2xl border border-[#00e5ff]/20 bg-[#04101f]/85 p-2">
                  <div className="flex items-center justify-between gap-2">
                    <SoundToggle className="!px-2 !py-1.5" />
                    <EmotePicker
                      compact
                      hideBubbles
                      incomingEmote={incomingEmote}
                      myEmote={myEmote}
                      onSend={(emote) => sendEmote(emote)}
                    />
                  </div>
                  <p className="mt-1.5 text-center text-[9px] text-white/55">
                    Keyboard: type the lit tile&apos;s number
                  </p>
                  <div className="mt-1.5 flex flex-col gap-1.5">
                    {resignNode}
                    {pauseNode && <div className="flex justify-center">{pauseNode}</div>}
                  </div>
                </section>
              </aside>
            </div>
          </div>

          {isFinished && showResult && (
            <ResultModal
              match={match}
              me={me}
              myName={myName}
              oppName={oppName}
              oppSeatSummary={oppSeatSummary}
              myLives={myLives}
              oppLives={oppLives}
              myTiles={myTiles}
              oppTiles={oppTiles}
            />
          )}
        </GameSessionHost>
      </div>

      {/* Mobile details sheet — the collapsed sidebar. Fixed, so opening it
          never reflows the board; it has its own scroll only when the phone is
          too short to show the rows. */}
      {detailsOpen && (
        <>
          <button
            type="button"
            aria-label="Close match details"
            onClick={() => setDetailsOpen(false)}
            className="fixed inset-0 z-40 bg-black/55 lg:hidden"
          />
          <div
            id="keno-match-details"
            role="dialog"
            aria-label="Match details"
            className="fixed inset-x-2 bottom-[calc(5.5rem+env(safe-area-inset-bottom))] z-50 max-h-[64dvh] space-y-2 overflow-y-auto rounded-2xl border border-[#00e5ff]/40 bg-[#04101f]/95 p-3 text-white shadow-[0_0_30px_rgba(0,229,255,0.22)] backdrop-blur lg:hidden"
          >
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-xs font-black uppercase tracking-wider text-[#7cefff]">
                Match details
              </h2>
              <button
                type="button"
                onClick={() => setDetailsOpen(false)}
                aria-label="Close match details"
                className="rounded-lg border border-white/15 px-2 py-1 text-[11px] font-bold text-white/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
              >
                Close
              </button>
            </div>
            <div className="rounded-xl border border-white/10 bg-black/30 p-2">
              <p className="pb-1 text-[9px] font-bold uppercase tracking-[0.2em] text-white/35">
                Last reaction
              </p>
              {reactionNode}
            </div>
            <div className="rounded-xl border border-white/10 bg-black/30 p-2">
              <p className="pb-1 text-[9px] font-bold uppercase tracking-[0.2em] text-white/35">
                Streaks
              </p>
              {streakNode}
            </div>
            <div className="rounded-xl border border-white/10 bg-black/30 p-2">
              <p className="pb-1 text-[9px] font-bold uppercase tracking-[0.2em] text-white/35">
                Feed
              </p>
              {feedListNode(2)}
            </div>
            <div className="flex items-center justify-between gap-2 rounded-xl border border-white/10 bg-black/30 p-2">
              <SoundToggle />
              <EmotePicker
                compact
                hideBubbles
                incomingEmote={incomingEmote}
                myEmote={myEmote}
                onSend={(emote) => sendEmote(emote)}
              />
              {pauseNode}
            </div>
            {resignNode}
          </div>
        </>
      )}

      {rulesNode}
      <PracticePauseOverlay
        paused={paused}
        busy={practicePause.busy}
        onResume={() => void practicePause.toggle()}
        testId="keno-pvp-pause-overlay"
      />
    </>
  );
}

// ── Rules modal ──────────────────────────────────────────────────────

function RulesModal({ onClose }) {
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
          <h2 className="flex items-center gap-2 text-xl font-extrabold text-[#7cefff]">
            <IconNotebook size={20} /> How to play
          </h2>
          <button
            onClick={onClose}
            className="h-8 w-8 rounded-lg border border-white/15 text-white/60 transition hover:border-white/40 hover:text-white"
            aria-label="Close rules"
          >
            <IconX size={16} />
          </button>
        </div>

        <h3 className="mb-2 flex items-center gap-1.5 text-sm font-bold uppercase tracking-wider text-[#00ffa6]">
          <IconTarget size={15} /> Claim tiles, never miss your own
        </h3>
        <ul className="mb-5 space-y-1.5 text-xs text-white/70">
          <li>
            Both players start with{" "}
            <span className="font-semibold text-white">{STARTING_LIVES} lives</span>.
          </li>
          <li>
            <span className="font-semibold text-[#00e5ff]">One tile</span> from the 1–40
            board is lit for both players at the same time, and both players have
            the{" "}
            <span className="font-semibold text-white">same window</span> to tap it.
          </li>
          <li>
            Tap it inside that window →{" "}
            <span className="font-semibold text-[#00ffa6]">you claim the tile</span>{" "}
            <span className="font-semibold text-white">
              and lose nothing. Tapping after your opponent costs you nothing
              either
            </span>{" "}
            — even if they were faster, you can still claim it.
          </li>
          <li>
            You lose a life{" "}
            <span className="font-semibold text-red-300">only if YOU miss</span> — i.e.
            you don't tap the lit tile before its window closes. It makes no
            difference whether your opponent took it.
          </li>
          <li>
            On desktop you can also press the{" "}
            <span className="font-semibold text-white">number keys</span> for the lit
            tile.
          </li>
          <li>
            If neither player taps in time,{" "}
            <span className="font-semibold text-red-300">both players lose a life</span>.
          </li>
          <li>
            Lose all {STARTING_LIVES} lives → you are eliminated and the opponent takes the
            pot. If the same tile takes both players' last life, the match is a draw
            (stake refunded).
          </li>
        </ul>

        <h3 className="mb-2 flex items-center gap-1.5 text-sm font-bold uppercase tracking-wider text-[#00ffa6]">
          <IconClock size={15} /> The window keeps tightening
        </h3>
        <ul className="mb-5 space-y-1.5 text-xs text-white/70">
          <li>
            Before the first tile, a{" "}
            <span className="font-semibold text-white">
              {READY_WINDOW_MS / 1000}s countdown
            </span>{" "}
            gives both players time to get ready to click.
          </li>
          <li>
            The first tile then gives you{" "}
            <span className="font-semibold text-white">{START_WINDOW_MS / 1000}s</span> to
            react.
          </li>
          <li>
            Every tile either player claims shaves{" "}
            <span className="font-semibold text-white">100ms</span> off the next window.
          </li>
          <li>
            The window bottoms out at{" "}
            <span className="font-semibold text-white">{MIN_WINDOW_MS / 1000}s</span> — the
            endgame is pure reaction time.
          </li>
          <li>A tile nobody claims does not speed the match up.</li>
          <li className="flex items-center gap-1">
            <IconVolume size={12} /> A soft tick sounds the moment each tile lights up.
          </li>
        </ul>

        <h3 className="mb-2 flex items-center gap-1.5 text-sm font-bold uppercase tracking-wider text-[#00ffa6]">
          <IconTrophy size={15} /> The pot
        </h3>
        <ul className="space-y-1.5 text-xs text-white/70">
          <li>Winner takes their stake + 80% of the loser's stake (house keeps 10%).</li>
          <li className="flex items-start gap-1">
            <IconHeartHandshake size={12} className="mt-0.5 shrink-0" />
            <span>A draw (both eliminated on the same tile) refunds both stakes in full.</span>
          </li>
          <li>
            Leaving a live match forfeits it — the opponent takes the pot.
          </li>
        </ul>
      </motion.div>
    </motion.div>
  );
}

// ── Result screen — shared PvpResultScreen ──────────────────────
// End-of-match adapter: maps the real match result / survival fields
// onto the shared result screen. No invented values, and no token /
// stake / pot figure is ever shown.
function ResultModal({
  match,
  me,
  myName,
  oppName,
  oppSeatSummary,
  myLives,
  oppLives,
  myTiles,
  oppTiles,
}) {
  // This component is a sibling of the page, not a child of it, so it does not
  // close over the page's router. `onReturnToLobby` used to call a free
  // `router` that was never in scope — a ReferenceError the moment a practice
  // player clicked the lobby exit on the result panel.
  const router = useRouter();
  const result = match.result;
  const iWon = result === me;
  const drew = result === "draw";

  const winnerName = iWon ? myName : oppName;
  const outcome = drew ? "draw" : iWon ? "win" : "loss";
  const log = Array.isArray(match.tileLog) ? match.tileLog : [];

  const seats = match.viewerIsPlayer1
    ? { p1: myName, p2: oppName }
    : { p1: oppName, p2: myName };

  return (
    <PvpResultScreen
      open
      outcome={outcome}
      headline={
        drew
          ? "Both eliminated on the same tile — draw"
          : `${myTiles} – ${oppTiles} tiles claimed`
      }
      subline={
        outcome === "loss"
          ? `${winnerName} survived the duel.`
          : drew
            ? undefined
            : "You survived the duel."
      }
      gameName="Keno Duel"
      onReturnToLobby={match.isAi ? () => router.push("/casino/keno") : null}
      opponent={
        match.isAi
          ? { name: "GRYND AI", isAi: true }
          : { name: oppName, iconKey: oppSeatSummary?.iconKey || null }
      }
      summary={[
        { label: "Lives left", value: `${myLives} – ${oppLives}` },
        { label: "Tiles claimed", value: `${myTiles} – ${oppTiles}` },
      ]}
      details={[
        ...(match.id != null ? [{ label: "Match ID", value: String(match.id) }] : []),
        { label: "Winner", value: drew ? "Draw" : winnerName },
      ]}
      detailsContent={
        <div className="mt-2 space-y-1.5">
          {log.length === 0 && (
            <p className="text-xs text-white/40 text-center">
              No tiles were resolved (forfeit).
            </p>
          )}
          {log.map((entry) => {
            const who =
              entry.outcome === "both_miss"
                ? "nobody"
                : seats[entry.outcome] || entry.outcome;
            return (
              <p key={`${entry.index}-${entry.tile}`} className="text-[11px] text-white/60">
                <span className="text-white/35">#{entry.index + 1}</span> tile{" "}
                <span className="font-bold text-white/80">{entry.tile}</span> →{" "}
                <span
                  className={
                    entry.outcome === "both_miss"
                      ? "text-red-300"
                      : entry.outcome === me
                        ? "text-[#00ffa6]"
                        : "text-[#FFD700]"
                  }
                >
                  {who}
                </span>{" "}
                · {(entry.windowMs || 0) / 1000}s window
              </p>
            );
          })}
        </div>
      }
    />
  );
}
