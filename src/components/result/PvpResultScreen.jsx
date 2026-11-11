"use client";

/**
 * PvpResultScreen — the single end-of-match experience across Grynd (UX
 * plan P3-3 / "reward moment").
 *
 * Every PvP game replaces its bespoke WIN/LOSS/DRAW popup with this shared
 * full-screen result overlay. It never computes or invents rewards — games
 * pass the REAL values already returned by their existing match APIs, and
 * any section (Elo / trophies, duration, opponent, details…) is simply hidden
 * when its data is absent.
 *
 * Two live progression values are read from the platform's OWN endpoints
 * when the game doesn't pass them explicitly: the player's current win
 * streak (/api/user/stats) and their true weekly leaderboard rank
 * (/api/leaderboard/weekly). Both are real server numbers, fire-and-forget
 * (a failure or unranked state simply hides the chip — the result screen is
 * never blocked), and games can override either via the `streak` / `rank`
 * props to skip the fetch.
 *
 * Adapter pattern per game:
 *   1. Detect the finished state exactly as today (status === "finished",
 *      a result phase, etc.) and keep rendering the game page underneath.
 *   2. Map the existing winner/result to `outcome` ("win" | "loss" | "draw").
 *   3. Elo / trophy progress goes in `progress` only if the match payload
 *      carries it — otherwise omit (sections auto-hide, no fake numbers).
 *      Token/payout figures are deliberately NOT part of this screen: the
 *      platform is free-play, so no result popup talks about tokens,
 *      stakes, pots or winnings.
 *   4. Compute `durationSeconds` from existing startedAt/endedAt when both
 *      exist, else omit.
 *   5. Keep game-specific info (payout breakdowns, pick audits, per-round
 *      scores…) either as `summary`/`details` rows or as `detailsContent`
 *      JSX inside the expandable Match Details panel.
 *   6. Actions: `playAgain`/`rematch` reuse the game's existing
 *      create-match/matchmaking flow; omit `rematch` when a direct rematch
 *      with the same opponent doesn't exist in the architecture. A game that
 *      needs one extra cross-page action (e.g. linking back to the game's lobby)
 *      passes the generic `secondaryAction` — `{ label, href }` to navigate or
 *      `{ label, onClick }` for an in-page action. It is deliberately generic
 *      so every result screen can reuse it, never a game-specific prop.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  IconChevronDown,
  IconHeartHandshake,
  IconRobot,
  IconTrophy,
  IconX,
} from "@tabler/icons-react";
import { fireConfetti, withReducedMotion } from "../../lib/animations";
import { notifyDailyRewardWin } from "../../lib/practiceWinClient";
import FrameAvatar from "../FrameAvatar";
import PostMatchAdSlot from "../ads/PostMatchAdSlot";
import GuestPostMatchCta from "../guest/GuestPostMatchCta";
import { PORTAL_MATCH_FINISHED_EVENT } from "../../lib/portal/crazygames";
import { isPortalPlayPath } from "../../lib/portal/framing";
import { usePathname } from "next/navigation";
import { useTranslation } from "../../hooks/useTranslation";
import GlitchSay from "../mascot/GlitchSay";
import { selectGlitchResultReaction } from "../../lib/mascot/glitchMoments";

// ── GLITCH result reactions: at most one per event, per session ──────────
//
// The selector decides WHETHER this result gets a reaction (first rated match
// → completed tier → rank improvement → one occasional line). This is the only
// state that needs remembering: which event ids have already spoken in this
// session. It is session-scoped on purpose — a new tab or a new session may
// speak again, and nothing is written to the server.
const GLITCH_RESULT_SEEN_KEY = "grynd:glitch:result-seen";
const GLITCH_RESULT_SEEN_MAX = 20;

function readSeenGlitchResultEvents() {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.sessionStorage.getItem(GLITCH_RESULT_SEEN_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((value) => typeof value === "string") : [];
  } catch {
    return [];
  }
}

function rememberGlitchResultEvent(eventId) {
  if (typeof window === "undefined" || !eventId) return;
  try {
    const seen = readSeenGlitchResultEvents();
    if (seen.includes(eventId)) return;
    const next = [...seen, eventId].slice(-GLITCH_RESULT_SEEN_MAX);
    window.sessionStorage.setItem(GLITCH_RESULT_SEEN_KEY, JSON.stringify(next));
  } catch {
    // Storage unavailable — the reaction simply may repeat later. Harmless.
  }
}

const CONFETTI_COLORS = ["#00e5ff", "#f5ff3b", "#ff4fd8", "#a855f7", "#34d399"];

// ── The match-ending beat ─────────────────────────────────────────────
// Every win / loss / draw popup in the platform mounts through this
// component, so the reveal hold lives here ONCE instead of in every game:
// the panel is held back 3s after the match ends, so the finished board (the
// winning line, the last ball, the losing tile…) is what the player reads
// first, and the result then lands on top of it. Exported so a game (and the
// test that pins this) can reason about the beat without repeating it.
export const RESULT_REVEAL_DELAY_MS = 3_000;

function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.round(Number(totalSeconds) || 0));
  const m = Math.floor(s / 60);
  const sec = String(s % 60).padStart(2, "0");
  return `${m}:${sec}`;
}

function formatNumber(n) {
  return Number(n || 0).toLocaleString();
}

const OUTCOME_STYLES = {
  win: {
    label: "WIN",
    tagline: "You took the match",
    icon: IconTrophy,
    accentText: "text-emerald-300",
    gradient:
      "from-[#0d2b1a] via-[#072014] to-[#04170e] border-emerald-400/50 shadow-[0_0_70px_rgba(52,211,153,0.35)]",
    glow: "text-emerald-300 drop-shadow-[0_0_18px_rgba(52,211,153,0.7)]",
    borderTop: "bg-emerald-400/60",
  },
  loss: {
    label: "LOSS",
    tagline: "The match got away — run it back",
    icon: IconX,
    accentText: "text-red-300",
    gradient:
      "from-[#2a0f14] via-[#1d0a0e] to-[#140608] border-red-500/40 shadow-[0_0_60px_rgba(239,68,68,0.28)]",
    glow: "text-red-300 drop-shadow-[0_0_16px_rgba(248,113,113,0.55)]",
    borderTop: "bg-red-400/60",
  },
  draw: {
    label: "DRAW",
    tagline: "Evenly matched — both walk away",
    icon: IconHeartHandshake,
    accentText: "text-cyan-300",
    gradient:
      "from-[#0a1a33] via-[#08142a] to-[#050d1c] border-cyan-400/50 shadow-[0_0_60px_rgba(34,211,238,0.3)]",
    glow: "text-cyan-300 drop-shadow-[0_0_16px_rgba(34,211,238,0.6)]",
    borderTop: "bg-cyan-400/60",
  },
};

const panelMotion = {
  initial: { opacity: 0, scale: 0.85, y: 40 },
  animate: { opacity: 1, scale: 1, y: 0 },
  exit: { opacity: 0, scale: 0.9, y: 24 },
  transition: { type: "spring", stiffness: 260, damping: 22 },
};

/**
 * @typedef {Object} ResultRow
 * @property {string} label
 * @property {import("react").ReactNode} value
 */

/**
 * @typedef {Object} ResultProgress
 * @property {string} label   e.g. "Overall Elo"
 * @property {string} from    e.g. "72"
 * @property {string} to      e.g. "73"
 * @property {number} percent 0–100 fill for the bar
 */

export default function PvpResultScreen({
  open,
  // How long the panel is held back after `open` flips — the match-ending
  // beat. Defaults to the platform-wide 3s; a game may shorten it, never
  // remove it.
  revealDelayMs = RESULT_REVEAL_DELAY_MS,
  outcome,
  headline,
  subline = null,
  opponent = null,
  gameName,
  xp = null,
  progress = [],
  summary = [],
  details = [],
  detailsContent = null,
  durationSeconds = null,
  playAgain = null,
  rematch = null,
  // Generic optional extra action, rendered between Rematch and Return to
  // Lobby. Pass `{ label, href }` to navigate (internal route) or
  // `{ label, onClick }` for an in-page action; omit/null hides it. Games use
  // this for a one-off cross-page destination
  // instead of each game inventing its own button.
  secondaryAction = null,
  // Optional "analyse this match" action, rendered above the generic
  // secondaryAction. Pass `{ label, href }` to open the read-only analysis
  // page for exactly this match. It exists as a PLAYER choice only: a result
  // never navigates to an analysis on its own.
  analysisAction = null,
  onReturnToLobby = null,
  onDismiss = null,
  dismissLabel = "View Match Results",
  // Optional rated game key for this match. When passed, the Overall Elo
  // movement is only shown if the player's most recent rated match was THIS
  // game — so an AI / unrated result screen never inherits a previous
  // ranked match's movement. Omit for the freshness-only behaviour.
  gameKey = null,
  // Explicit Overall Elo movement override, shaped like the derived object
  // ({ previousOverallElo, overallElo, overallDelta, eligibleGames }).
  // When passed, the live fetch is skipped. Games rarely need this — the
  // server derivation is authoritative — but it exists for parity with the
  // streak/rank/xp overrides.
  overallElo = null,
  // Compact creator-frame mode (UX: the shared result screen mounted
  // INSIDE the Creator Mode recording viewport). The recording frame is
  // a 390px-wide phone viewport zoomed to fill the output, so the panel
  // and its type scale down to fit the narrow frame instead of rendering
  // at desktop size.
  compact = false,
  // Real progression values (optional). When a game passes these, the
  // screen renders them verbatim and skips the matching live fetch.
  streak = null,
  rank = null,
  rankDelta = null,
  // Optional final score comparison, e.g.
  //   [{ name: "You", score: 240, highlight: true }, { name: "Rival", score: 180 }]
  // The highlighted side is emphasised; the other stays visible but muted.
  // Games that don't pass it render exactly as before.
  sides = null,
  // Optional game-specific block rendered IN THE MAIN FLOW (visible without
  // expanding Match Details), right after the final-score comparison. Used for
  // a compact self-explanatory visual — e.g. Precision's frozen rockets from
  // the deciding round. Games that don't pass it render exactly as before.
  extraContent = null,
  // Optional post-match advertisement node. When a game passes one it is
  // rendered verbatim (the wired pages resolve the surface on the server).
  // Otherwise the shared screen mounts the ONE shared slot, which asks the
  // server whether an ad may be offered and resolves the match id — that is
  // what gives every game's result screen the surface without each one
  // duplicating the plumbing. Rendered BELOW the action buttons (never between
  // the player and "Run it back"), and suppressed in compact mode so Creator
  // Mode recordings never carry an ad.
  postMatchAd = null,
  // Canonical key of THIS game when a guest's practice results are persisted
  // for it (tic-tac-toe, dominoes, battleship, odds). Passing it mounts the
  // shared guest → account invitation below the actions; the component itself
  // decides whether this visitor is a guest, so an account sees nothing and a
  // game that does not record guest progress passes nothing at all.
  guestGameKey = null,
  // GLITCH's reaction to this result, inline under the outcome hero. On by
  // default — every result screen is a legitimate place for the character to
  // react — and switched OFF by the one screen that already renders its own
  // mascot line (the RPS onboarding match passes it through `extraContent`),
  // so a single result can never show two mascots.
  showGlitch = true,
}) {
  const shouldReduce = useReducedMotion();
  // PORTAL SURFACE (/play/<gameKey>[/<matchId>]): a games portal forbids an
  // external account system, an outbound link and anyone else's advertising
  // inside the frame. So this screen offers no GRYND account invitation and no
  // GRYND post-match ad there — the portal's own SDK owns the ad break.
  const portalSurface = isPortalPlayPath(usePathname());
  const { t } = useTranslation();
  const router = useRouter();
  // THE RESULT BEAT. `open` is the game's own finished-state flag; the
  // overlay itself waits `revealDelayMs` so the ending stays readable before
  // the panel covers it. Everything that belongs to the VISIBLE result
  // (confetti, the back-gesture guard, the overlay itself) keys off
  // `revealed`, while the progression fetches start on `open` so the numbers
  // are already there when it lands.
  const [revealed, setRevealed] = useState(false);
  // Portal SDK: a finished match is the moment the player stopped playing, and
  // the only moment an ad break is allowed. The bridge on /play/<gameKey>
  // listens; outside a portal visit nothing listens and this is inert.
  useEffect(() => {
    if (!revealed || typeof window === "undefined") return;
    window.dispatchEvent(
      new CustomEvent(PORTAL_MATCH_FINISHED_EVENT, {
        detail: { gameKey: guestGameKey ?? null },
      }),
    );
  }, [revealed, guestGameKey]);
  useEffect(() => {
    if (!open) {
      setRevealed(false);
      return undefined;
    }
    const hold = Number(revealDelayMs);
    if (!Number.isFinite(hold) || hold <= 0) {
      setRevealed(true);
      return undefined;
    }
    setRevealed(false);
    const timer = setTimeout(() => setRevealed(true), hold);
    return () => clearTimeout(timer);
  }, [open, revealDelayMs]);
  // Decided ONCE, from synchronous props only. The result screen's numbers are
  // still free to arrive (or animate) afterwards without ever re-deciding: a
  // reaction that appeared and then withdrew as a fetch landed would be worse
  // than no reaction at all.
  const [glitchReaction] = useState(() =>
    selectGlitchResultReaction(
      {
        outcome,
        showGlitch,
        compact,
        overallElo,
        progress,
        rankDelta,
      },
      { seenEventIds: readSeenGlitchResultEvents() }
    )
  );

  useEffect(() => {
    if (glitchReaction.show) rememberGlitchResultEvent(glitchReaction.moment.eventId);
  }, [glitchReaction]);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [navigating, setNavigating] = useState(false);
  // The post-match ad is offered when the player picks an EXIT action, so this
  // screen holds that action until the ad reports back.
  const [adOpen, setAdOpen] = useState(false);
  const adOpenRef = useRef(false);
  const adAttemptedRef = useRef(false);
  const pendingExitRef = useRef(null);
  // Which exit control started the ad attempt. The ad surface draws nothing
  // while the tag is fetched, so the pressed button is what tells the player
  // their choice registered: it carries a small inline spinner until the ad
  // settles (played, skipped, or unavailable).
  const [pendingExit, setPendingExit] = useState(null);

  // A RESULT SCREEN CAN OUTLIVE A RESULT. A rematch or a re-deal navigates to a
  // NEW match on the SAME route, where React keeps this component instance
  // alive. Per-result state therefore has to be reset when a result opens, or
  // the next match inherits the previous one's flags: `adAttemptedRef` would
  // already be spent (so the video is never offered again) and `navigating`
  // would still be true (so every exit button is disabled). One attempt per
  // RESULT, not one attempt per mounted component.
  useEffect(() => {
    if (!open) return;
    adAttemptedRef.current = false;
    adOpenRef.current = false;
    pendingExitRef.current = null;
    setAdOpen(false);
    setPendingExit(null);
    setNavigating(false);
  }, [open]);

  const style = OUTCOME_STYLES[outcome] || OUTCOME_STYLES.draw;
  const OutcomeIcon = style.icon;

  // Celebrate a win once when the screen appears (respects reduced motion —
  // no animation at all then; confetti is skipped too).
  useEffect(() => {
    if (!revealed || outcome !== "win") return;
    if (shouldReduce) return;
    fireConfetti({ particleCount: 90, spread: 100, origin: { x: 0.5, y: 0.35 }, colors: CONFETTI_COLORS });
    const t1 = setTimeout(
      () =>
        fireConfetti({ particleCount: 60, spread: 120, origin: { x: 0.3, y: 0.4 }, colors: CONFETTI_COLORS }),
      350,
    );
    const t2 = setTimeout(
      () =>
        fireConfetti({ particleCount: 60, spread: 120, origin: { x: 0.7, y: 0.4 }, colors: CONFETTI_COLORS }),
      650,
    );
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [revealed, outcome, shouldReduce]);

  // A win against the AI can unlock today's daily reward. Announce it so any
  // daily-reward surface mounted on this origin re-reads its status without a
  // page reload. The delay lets the authoritative write land first: server-
  // settled practice stamps inside its settlement transaction, while the
  // client-settled boards POST /api/practice/win from their own result path.
  useEffect(() => {
    if (!open || outcome !== "win" || !opponent?.isAi) return;
    const timer = setTimeout(() => notifyDailyRewardWin(), 900);
    return () => clearTimeout(timer);
  }, [open, outcome, opponent?.isAi]);

  // One action per screen: once Play Again / Rematch / Lobby is picked,
  // disable the buttons so a double-tap can't create two matches.
  //
  // THE POST-MATCH VIDEO COMES FIRST. Every exit control routes through this
  // guard, so a finished match — a win, a loss or a resignation — offers its ad
  // at the moment the player leaves the result, never over the result itself.
  // The action is parked in a ref and run once the ad reports back.
  //
  // ONE ATTEMPT PER RESULT. If the surface is off, the viewer is a member, the
  // cadence declines or the tag fails, the slot answers `onDone` immediately and
  // the player moves on. A declined ad must never leave a button that looks
  // clickable and does nothing.
  const guard = (key, fn) => () => {
    if (navigating || pendingExit || typeof fn !== "function") return;
    // A game that supplies its own node renders the ad itself (no shared slot
    // is mounted), so parking the exit action here would leave the buttons
    // waiting for a settle that can never arrive. Those screens navigate at
    // once; everyone else meets the shared slot.
    if (!compact && !postMatchAd && !adAttemptedRef.current) {
      // Skip the surface entirely on the portal path: run the exit action now
      // rather than holding it until an ad that must never play reports back.
      if (portalSurface) {
        setNavigating(true);
        fn();
        return;
      }
      adAttemptedRef.current = true;
      pendingExitRef.current = fn;
      adOpenRef.current = true;
      setPendingExit(key);
      setAdOpen(true);
      return;
    }
    setNavigating(true);
    fn();
  };

  // The ad is over (played, skipped, closed) or was never available: continue to
  // where the player asked to go. Idempotent — the slot settles exactly once.
  const handleAdSettled = useCallback(() => {
    if (!adOpenRef.current) return;
    adOpenRef.current = false;
    setAdOpen(false);
    setPendingExit(null);
    const next = pendingExitRef.current;
    pendingExitRef.current = null;
    if (!next) return;
    setNavigating(true);
    next();
  }, []);

  // Latest guard, for the listener registered below: the back gesture hands
  // its exit to the same gate as the buttons.
  const guardRef = useRef(guard);
  guardRef.current = guard;

  // THE BROWSER BACK GESTURE IS AN EXIT TOO. A finished match can be left with
  // the system back button or gesture, which never reaches a click handler;
  // without this, that one way out would walk straight past the post-match
  // video. While the result is on screen the pop is cancelled and the leave
  // action goes through the guard, so back is held for the ad exactly like
  // "Return to Lobby". A result with no leave action at all (replay only) is
  // left alone: back already goes where it went before.
  const backExitRef = useRef(null);
  backExitRef.current = onReturnToLobby
    ? onReturnToLobby
    : secondaryAction
      ? secondaryAction.href
        ? () => router.push(secondaryAction.href)
        : secondaryAction.onClick
      : onDismiss;

  useEffect(() => {
    if (!revealed || compact || !backExitRef.current) return;
    const onPopState = () => {
      // The entry was already popped: put the result back first, so the
      // player stays on it while the ad runs, and when there is none.
      window.history.pushState(null, "", window.location.href);
      // A second back while an exit is already in flight is not a second exit.
      if (navigating || adOpenRef.current || pendingExitRef.current) return;
      guardRef.current("back", backExitRef.current)();
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [revealed, compact, navigating]);

  // Live progression — real numbers from the platform's own endpoints,
  // fetched only when the game didn't pass its own values. Fire-and-forget:
  // any failure leaves the chips hidden and never blocks the result screen.
  const [liveStreak, setLiveStreak] = useState(null);
  const [liveRank, setLiveRank] = useState(null);
  const [liveRankDelta, setLiveRankDelta] = useState(null);
  const [liveOverall, setLiveOverall] = useState(null);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    // Fresh screen per match — never carry values from a previous result.
    setLiveStreak(null);
    setLiveRank(null);
    setLiveRankDelta(null);
    setLiveOverall(null);

    // Current win streak, from the platform's own stats endpoint. Streak is
    // only meaningful on a win (a settled loss resets it to 0 server-side).
    const fetchStats = () =>
      fetch("/api/user/stats", {
        credentials: "include",
        signal: controller.signal,
      })
        .then((res) => res.json().catch(() => null))
        .then((data) => {
          const stats = data?.userStats ?? {};
          if (streak === null && outcome === "win") {
            const s = Number(stats.currentStreak ?? 0);
            if (Number.isFinite(s) && s > 0) setLiveStreak(s);
          }
          // Overall Elo movement across the most recent rated match. Derived
          // server-side from the rating journal; gated by a freshness window
          // so a stale match is never shown as this one's change. When this
          // screen knows its game key, the movement must match it — an AI
          // result can never inherit a previous ranked match's movement.
          if (overallElo === null) {
            const currentElo = Number(stats.overallElo);
            const at = stats.overallEloAt
              ? new Date(stats.overallEloAt).getTime()
              : null;
            const sameGame =
              !gameKey || String(stats.overallEloGameKey || "") === String(gameKey);
            if (
              Number.isFinite(currentElo) &&
              at !== null &&
              Date.now() - at < 3 * 60 * 1000 &&
              sameGame
            ) {
              const prev = stats.overallEloPrevious;
              const delta = stats.overallEloDelta;
              setLiveOverall({
                overallElo: currentElo,
                previousOverallElo: prev === null || prev === undefined ? null : Number(prev),
                overallDelta:
                  delta === null || delta === undefined ? null : Number(delta),
                eligibleGames: Number(stats.overallEligibleGames || 0),
              });
            }
          }
          // Nudge the navbar's Overall Elo chip to refetch, so a just-settled
          // rated match animates the new value without a full navigation.
          try {
            window.dispatchEvent(new Event("profileUpdated"));
          } catch {}
        })
        .catch(() => {});

    fetchStats();
    // One retry: some settle paths apply the counters fire-and-forget, so
    // the result can reach the client a moment before the stats write lands.
    const retry = setTimeout(() => {
      if (overallElo === null) fetchStats();
    }, 1200);

    // True weekly rank + the movement caused by the most recent settled
    // match (server-authoritative deltas written at settlement time, read
    // via /api/leaderboard/my-rank). Wins only — a loss screen leads with
    // the run-it-back path, never salt. A rank beyond the top 100 stays
    // hidden.
    if (rank === null && outcome === "win") {
      fetch("/api/leaderboard/my-rank", {
        credentials: "include",
        signal: controller.signal,
      })
        .then((res) => res.json().catch(() => null))
        .then((data) => {
          const r = Number(data?.rank);
          const d = Number(data?.delta);
          if (Number.isFinite(r) && r > 0 && r <= 100) {
            setLiveRank(r);
            if (Number.isFinite(d)) setLiveRankDelta(d);
          }
        })
        .catch(() => {});
    }

    return () => {
      clearTimeout(retry);
      controller.abort();
    };
  }, [open, outcome, streak, rank, overallElo, gameKey]);

  const displayStreak = streak ?? (outcome === "win" ? liveStreak : null);
  const displayRank = rank ?? liveRank;
  const displayRankDelta = rankDelta ?? liveRankDelta;
  const displayOverall = overallElo ?? liveOverall;
  // A 1-win streak is not a streak worth celebrating — start at 2.
  const showStreak = displayStreak !== null && Number(displayStreak) >= 2;
  const showRank =
    outcome === "win" && displayRank !== null && Number(displayRank) > 0;

  // Progression is the only "after the result" block left — no token/payout
  // row exists on this screen.
  const hasProgression =
    displayOverall !== null ||
    (Array.isArray(progress) && progress.length > 0);

  const rows = [
    ...summary,
    ...(durationSeconds !== null && durationSeconds !== undefined
      ? [{ label: "Duration", value: formatDuration(durationSeconds) }]
      : []),
  ];

  const allDetails = [
    ...(gameName ? [{ label: "Game", value: gameName }] : []),
    ...details,
    ...(durationSeconds !== null && durationSeconds !== undefined
      ? [{ label: "Duration", value: formatDuration(durationSeconds) }]
      : []),
  ];
  const hasDetails = allDetails.length > 0 || detailsContent !== null;

  // A BOT OPPONENT IS A CHARACTER, NOT A HANDLE. Its hero shows the roster
  // portrait the player just raced instead of an "@name" handle, because there
  // is no account behind it. Real players keep the handle treatment.
  const opponentPortrait = opponent?.imageSrc ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={opponent.imageSrc}
      alt={opponent.imageAlt || `${opponent.name || "Opponent"} portrait`}
      width={compact ? 64 : 80}
      height={compact ? 64 : 80}
      data-testid="result-opponent-image"
      className={`aspect-square shrink-0 rounded-2xl border border-white/15 bg-black/30 object-cover object-center ${
        compact ? "h-16 w-16" : "h-20 w-20"
      }`}
    />
  ) : null;

  return (
    <AnimatePresence>
      {revealed && (
        <motion.div
          {...withReducedMotion(shouldReduce, {
            // Short backdrop fade so the final board (with the scoring bucket
            // still highlighted) is briefly visible as the gameplay state hands
            // over to the result state — then the panel lands on top.
            initial: { opacity: 0 },
            animate: { opacity: 1 },
            exit: { opacity: 0 },
            transition: { duration: 0.18, ease: "easeOut" },
          })}
          role="dialog"
          aria-modal="true"
          aria-label={`Match result — ${style.label}`}
          className={`fixed inset-0 z-[95] overflow-y-auto bg-black/80 px-3 py-4 backdrop-blur-xs sm:px-4 ${
            compact ? "!px-2 !py-3" : ""
          }`}
        >
          {/* Centred by this wrapper, NOT by the scroll container: a result
              taller than the viewport (Dominoes carries its full scoreboard
              plus the score comparison) then scrolls from its first pixel
              instead of being centred into a clipped top. */}
          <div className="flex min-h-full items-center justify-center">
          <motion.div
            {...withReducedMotion(shouldReduce, {
              ...panelMotion,
              // A win settles with its small overshoot; a loss lands firmer and
              // flatter (no bounce), so the hand reads as a hit rather than a
              // flourish; a draw lands dead neutral (a plain ease, no overshoot
              // at all) so it never reads as a win. Deliberately the ONLY
              // difference — no shake, no red wash, no extra negative effect.
              transition:
                outcome === "loss"
                  ? { type: "spring", stiffness: 340, damping: 30 }
                  : outcome === "draw"
                    ? { duration: 0.3, ease: "easeOut" }
                    : panelMotion.transition,
            })}
            className={`relative w-full rounded-2xl border-2 bg-linear-to-b text-center ${style.gradient} ${
              compact
                ? "max-w-[22rem] p-3.5"
                : "max-w-md p-5 sm:p-6"
            }`}
          >
            {/* Outcome header */}
            <div className="relative">
              <motion.div
                initial={shouldReduce ? false : { scale: 0, rotate: -20 }}
                animate={{ scale: 1, rotate: 0 }}
                transition={{ type: "spring", stiffness: 280, damping: 14, delay: 0.08 }}
                className="mx-auto mb-2 flex h-16 w-16 items-center justify-center rounded-2xl border border-white/10 bg-black/30"
              >
                <OutcomeIcon size={compact ? 30 : 44} className={style.glow} aria-hidden="true" />
              </motion.div>
              {/* Outcome chip — a compact eyebrow, never the hero. The
                  achievement line below carries the emotional weight. */}
              <span
                className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-black uppercase tracking-[0.2em] ${
                  outcome === "win"
                    ? "border-emerald-300/50 bg-emerald-400/15 text-emerald-300"
                    : outcome === "loss"
                      ? "border-red-300/50 bg-red-400/15 text-red-300"
                      : "border-cyan-300/50 bg-cyan-400/15 text-cyan-300"
                }`}
              >
                <OutcomeIcon size={14} aria-hidden="true" />
                {outcome === "win" ? "YOU WON" : outcome === "loss" ? "DEFEAT" : "DRAW"}
              </span>
              <div className="mx-auto mt-2 h-0.5 w-16 rounded-full opacity-60">
                <div className={`h-full w-full rounded-full ${style.borderTop}`} />
              </div>
              {/* Hero — "YOU BEAT @PLAYER" (win) / "DEFEATED BY @PLAYER"
                  (loss). Only when the opponent is a real player with a
                  name (never for AI, never fabricated); otherwise the
                  outcome itself is the hero. The game's own headline
                  (scores, rounds…) drops below as the supporting line. */}
              {outcome === "win" &&
                opponent &&
                !opponent.isAi &&
                opponent.name &&
                opponent.name !== "Opponent" &&
                opponent.name !== "GRYND AI" ? (
                <>
                  <p
                    className={`font-black uppercase tracking-[0.15em] text-emerald-300 drop-shadow-[0_0_12px_rgba(52,211,153,0.6)] ${
                      compact ? "mt-2 text-sm" : "mt-2 text-lg sm:text-xl"
                    }`}
                  >
                    You beat
                  </p>
                  <p
                    className={`truncate font-black text-[#f5ff3b] drop-shadow-[0_0_16px_rgba(255,215,0,0.55)] ${
                      compact ? "text-2xl" : "text-4xl sm:text-5xl"
                    }`}
                  >
                    @{opponent.name}
                  </p>
                  {/* Game-specific line (rounds, score, pot…) stays visible
                      under the beat line — it's real match data. */}
                  {headline && headline !== style.tagline && (
                    <p className={`mt-1.5 text-white/75 ${compact ? "text-[11px]" : "text-sm"}`}>
                      {headline}
                    </p>
                  )}
                </>
              ) : outcome === "loss" &&
                opponent &&
                !opponent.isAi &&
                opponent.name &&
                opponent.name !== "Opponent" &&
                opponent.name !== "GRYND AI" ? (
                <>
                  <p
                    className={`font-black uppercase tracking-[0.15em] text-red-300 drop-shadow-[0_0_12px_rgba(248,113,113,0.55)] ${
                      compact ? "mt-2 text-sm" : "mt-2 text-lg sm:text-xl"
                    }`}
                  >
                    Defeated by
                  </p>
                  <p
                    className={`truncate font-black text-white/95 ${
                      compact ? "text-2xl" : "text-4xl sm:text-5xl"
                    }`}
                  >
                    @{opponent.name}
                  </p>
                  {headline && headline !== style.tagline && (
                    <p className={`mt-1.5 text-white/75 ${compact ? "text-[11px]" : "text-sm"}`}>
                      {headline}
                    </p>
                  )}
                </>
              ) : outcome === "win" && opponent?.isAi && opponent.name ? (
                <>
                  <p
                    className={`font-black uppercase tracking-[0.15em] text-emerald-300 drop-shadow-[0_0_12px_rgba(52,211,153,0.6)] ${
                      compact ? "mt-2 text-sm" : "mt-2 text-lg sm:text-xl"
                    }`}
                  >
                    You beat
                  </p>
                  {/* The bot's face, with its name and strength rating beside
                      it — the three things the player actually raced. */}
                  <div className="mt-2 flex items-center justify-center gap-3 text-left">
                    {opponentPortrait}
                    <div className="min-w-0">
                      <p
                        className={`truncate font-black text-[#f5ff3b] drop-shadow-[0_0_16px_rgba(255,215,0,0.55)] ${
                          compact ? "text-2xl" : "text-3xl sm:text-4xl"
                        }`}
                      >
                        {opponent.name}
                      </p>
                      {opponent.ratingLabel && (
                        <p className="mt-1 inline-flex items-center gap-1 rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 font-mono text-[11px] font-bold text-amber-200">
                          <IconTrophy size={11} aria-hidden="true" />
                          {opponent.ratingLabel}
                        </p>
                      )}
                    </div>
                  </div>
                  {headline && headline !== style.tagline && (
                    <p className={`mt-1.5 text-white/75 ${compact ? "text-[11px]" : "text-sm"}`}>
                      {headline}
                    </p>
                  )}
                </>
              ) : outcome === "loss" && opponent?.isAi && opponent.name ? (
                <>
                  <p
                    className={`font-black uppercase tracking-[0.15em] text-red-300 drop-shadow-[0_0_12px_rgba(248,113,113,0.55)] ${
                      compact ? "mt-2 text-sm" : "mt-2 text-lg sm:text-xl"
                    }`}
                  >
                    Defeated by
                  </p>
                  <div className="mt-2 flex items-center justify-center gap-3 text-left">
                    {opponentPortrait}
                    <div className="min-w-0">
                      <p
                        className={`truncate font-black text-white/95 ${
                          compact ? "text-2xl" : "text-3xl sm:text-4xl"
                        }`}
                      >
                        {opponent.name}
                      </p>
                      {opponent.ratingLabel && (
                        <p className="mt-1 inline-flex items-center gap-1 rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 font-mono text-[11px] font-bold text-amber-200">
                          <IconTrophy size={11} aria-hidden="true" />
                          {opponent.ratingLabel}
                        </p>
                      )}
                    </div>
                  </div>
                  {headline && headline !== style.tagline && (
                    <p className={`mt-1.5 text-white/75 ${compact ? "text-[11px]" : "text-sm"}`}>
                      {headline}
                    </p>
                  )}
                </>
              ) : outcome === "win" ? (
                <>
                  <h2
                    className={`font-black uppercase tracking-wide text-emerald-300 drop-shadow-[0_0_16px_rgba(52,211,153,0.6)] ${
                      compact ? "mt-2 text-2xl" : "mt-2 text-4xl sm:text-5xl"
                    }`}
                  >
                    You won the match
                  </h2>
                  {headline && headline !== style.tagline && (
                    <p className={`mt-1.5 text-white/75 ${compact ? "text-[11px]" : "text-sm"}`}>
                      {headline}
                    </p>
                  )}
                </>
              ) : outcome === "loss" ? (
                <>
                  <h2
                    className={`font-black uppercase tracking-wide text-red-300 drop-shadow-[0_0_14px_rgba(248,113,113,0.5)] ${
                      compact ? "mt-2 text-2xl" : "mt-2 text-4xl sm:text-5xl"
                    }`}
                  >
                    Match lost
                  </h2>
                  {headline && headline !== style.tagline && (
                    <p className={`mt-1.5 text-white/75 ${compact ? "text-[11px]" : "text-sm"}`}>
                      {headline}
                    </p>
                  )}
                </>
              ) : (
                <>
                  <h2
                    className={`font-black uppercase tracking-wide text-cyan-300 drop-shadow-[0_0_14px_rgba(34,211,238,0.6)] ${
                      compact ? "mt-2 text-2xl" : "mt-2 text-4xl sm:text-5xl"
                    }`}
                  >
                    Draw
                  </h2>
                  {headline && headline !== style.tagline && (
                    <p className={`mt-1.5 text-white/75 ${compact ? "text-[11px]" : "text-sm"}`}>
                      {headline}
                    </p>
                  )}
                </>
              )}
              {subline && (
                <p className={`mx-auto mt-2 max-w-sm text-white/60 ${compact ? "text-[10px]" : "text-xs"}`}>
                  {subline}
                </p>
              )}
            </div>

            {/* GLITCH's reaction — INLINE in the panel's own flow, directly
                under the outcome hero. It cannot cover the score, the
                progression rows (Overall Elo, trophies, streak, weekly rank),
                the summary, the Rematch/Play Again/exit controls or the
                post-match ad — those either follow it in the flow or render
                in a layer above this whole panel. It states nothing about
                rewards (see glitchMoments.ts); the reward rows are the
                server's, not the character's.

                Suppressed in `compact` (a Creator Mode recording frame) and
                whenever a game supplies its own mascot line, so one result
                event can never produce two. */}
            {showGlitch && !compact && glitchReaction.show && (
              <div className="mx-auto mt-3 flex w-full max-w-xs justify-center">
                <GlitchSay
                  expression={glitchReaction.moment.expression}
                  message={t(glitchReaction.moment.messageKey)}
                  // The event that earned this reaction (data-glitch-event):
                  // first rated match, a completed tier, a rank climb, or the
                  // session's one occasional line.
                  eventId={glitchReaction.moment.eventId}
                  placement="inline"
                  size="sm"
                />
              </div>
            )}

            {/* Final score — hierarchy step 1.5: after the outcome hero, the
                winner's score is emphasised and the loser's is muted but still
                fully readable. Draw passes no highlight, so both read evenly.
                Sequenced (delay) between the hero and the progression. */}
            {Array.isArray(sides) && sides.length > 0 && (
              <motion.div
                {...withReducedMotion(shouldReduce, {
                  initial: { opacity: 0, y: 8 },
                  animate: { opacity: 1, y: 0 },
                  transition: { duration: 0.2, ease: "easeOut", delay: 0.14 },
                })}
                className="mx-auto mt-4 grid w-full max-w-xs grid-cols-2 gap-2"
              >
                {sides.map((side, i) => (
                  <div
                    key={`${side.name || "side"}-${i}`}
                    className={`rounded-xl border p-2.5 text-center ${
                      side.highlight
                        ? "border-[#f5ff3b]/60 bg-[#f5ff3b]/10 shadow-[0_0_18px_rgba(245,255,59,0.25)]"
                        : "border-white/10 bg-black/25 opacity-70"
                    }`}
                  >
                    <p
                      className={`truncate text-[10px] uppercase tracking-wider ${
                        side.highlight ? "text-[#f5ff3b]/80" : "text-white/45"
                      }`}
                    >
                      {side.name}
                    </p>
                    <p
                      className={`mt-0.5 font-black tabular-nums ${
                        side.highlight ? "text-2xl text-[#f5ff3b]" : "text-xl text-white/70"
                      }`}
                    >
                      {side.score}
                    </p>
                    {side.highlight && (
                      <p className="mt-0.5 text-[9px] font-bold uppercase tracking-widest text-[#f5ff3b]/70">
                        Winner
                      </p>
                    )}
                  </div>
                ))}
              </motion.div>
            )}

            {/* Game-specific visual — sequenced between the score and the
                rewards so it reads as "here is how it ended". */}
            {extraContent && (
              <motion.div
                {...withReducedMotion(shouldReduce, {
                  initial: { opacity: 0, y: 8 },
                  animate: { opacity: 1, y: 0 },
                  transition: { duration: 0.22, ease: "easeOut", delay: 0.18 },
                })}
                className="mx-auto mt-4 w-full max-w-xs"
              >
                {extraContent}
              </motion.div>
            )}

            {/* Progression — only rows whose data actually exists.
                Sequenced AFTER the outcome, never with it: the win/loss hero
                lands first, then progression (Overall Elo, trophies)
                registers one short beat later, so the order the player reads
                is result → progression → details. A rise + fade with a hair
                of scale, 0.22s, gated through the shared helper — with reduced
                motion it appears in place with no movement and no delay. */}
            {hasProgression && (
              <motion.div
                {...withReducedMotion(shouldReduce, {
                  initial: { opacity: 0, y: 8, scale: 0.97 },
                  animate: { opacity: 1, y: 0, scale: 1 },
                  transition: { duration: 0.22, ease: "easeOut", delay: 0.24 },
                })}
                className="mx-auto mt-5 w-full max-w-xs space-y-2"
              >
                {displayOverall !== null && (
                  <div className="rounded-xl border border-[#f5ff3b]/30 bg-black/25 px-4 py-2.5">
                    <div className="flex items-center justify-between text-sm">
                      <span className="font-bold text-white/85">Overall Elo</span>
                      <span className="font-black text-white">
                        {displayOverall.previousOverallElo !== null &&
                        displayOverall.previousOverallElo !== undefined ? (
                          <>
                            {formatNumber(displayOverall.previousOverallElo)}{" "}
                            <span className="text-white/40">{"\u2192"}</span>{" "}
                            <span className="text-[#f5ff3b]">
                              {formatNumber(displayOverall.overallElo)}
                            </span>
                          </>
                        ) : (
                          <span className="text-[#f5ff3b]">
                            {formatNumber(displayOverall.overallElo)}
                          </span>
                        )}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center justify-between text-[11px] text-white/50">
                      <span>
                        {formatNumber(displayOverall.eligibleGames)} eligible{" "}
                        {Number(displayOverall.eligibleGames) === 1
                          ? "game"
                          : "games"}
                      </span>
                      {displayOverall.overallDelta !== null &&
                        displayOverall.overallDelta !== undefined &&
                        Number(displayOverall.overallDelta) !== 0 && (
                          <span
                            className={
                              Number(displayOverall.overallDelta) > 0
                                ? "font-black text-emerald-300"
                                : "font-black text-red-300"
                            }
                          >
                            {Number(displayOverall.overallDelta) > 0 ? "+" : ""}
                            {formatNumber(displayOverall.overallDelta)}
                          </span>
                        )}
                    </div>
                  </div>
                )}
                {progress.map((p) => (
                  <div key={p.label} className="rounded-xl border border-white/10 bg-black/25 px-4 py-2.5">
                    <div className="flex items-center justify-between text-sm">
                      <span className="font-bold text-white/85">{p.label}</span>
                      <span className="font-black text-white">
                        {p.from} <span className="text-white/40">→</span>{" "}
                        <span className={style.accentText}>{p.to}</span>
                      </span>
                    </div>
                    <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-white/10">
                      <motion.div
                        initial={shouldReduce ? false : { width: 0 }}
                        animate={{ width: `${Math.max(0, Math.min(100, p.percent))}%` }}
                        transition={{ duration: 0.8, ease: "easeOut", delay: 0.25 }}
                        className={`h-full rounded-full ${style.borderTop}`}
                      />
                    </div>
                  </div>
                ))}
              </motion.div>
            )}

            {/* Progression chips — real streak + weekly rank, hidden when
                absent or when the game passed nothing. */}
            {(showStreak || showRank) && (
              <div className="mx-auto mt-4 flex w-full max-w-xs flex-wrap items-center justify-center gap-2">
                {showStreak && (
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-300/50 bg-amber-400/15 px-3 py-1 text-xs font-black uppercase tracking-wider text-amber-300">
                    <span aria-hidden="true">🔥</span>
                    {formatNumber(showStreak)} win streak
                  </span>
                )}
                {showRank && (
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-[#00e5ff]/50 bg-[#00e5ff]/10 px-3 py-1 text-xs font-black uppercase tracking-wider text-[#00e5ff]">
                    <IconTrophy size={14} aria-hidden="true" />
                    {displayRankDelta !== null && Number(displayRankDelta) > 0
                      ? `RANK \u2191 ${formatNumber(displayRankDelta)} \u00b7 #${formatNumber(displayRank)}`
                      : `WEEKLY RANK #${formatNumber(displayRank)}`}
                  </span>
                )}
              </div>
            )}

            {/* Opponent */}
            {opponent && (
              <div className="mx-auto mt-5 flex w-full max-w-xs items-center justify-center gap-3 rounded-xl border border-white/10 bg-black/25 px-4 py-3">
                {opponent.iconKey ? (
                  <FrameAvatar
                    frame={opponent.profileFrame}
                    iconKey={opponent.iconKey}
                    name={opponent.name}
                    size="h-11 w-11"
                  />
                ) : opponent.imageSrc ? (
                  // A bot's roster portrait — same artwork the player raced.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={opponent.imageSrc}
                    alt={opponent.imageAlt || `${opponent.name || "Opponent"} portrait`}
                    width={44}
                    height={44}
                    data-testid="result-opponent-strip-image"
                    className="h-11 w-11 shrink-0 rounded-xl border border-white/15 bg-black/30 object-cover object-center"
                  />
                ) : (
                  <div className="flex h-11 w-11 items-center justify-center rounded-full border border-white/15 bg-white/10 text-lg font-black text-[#d8fbff]">
                    {(opponent.name || "?").charAt(0).toUpperCase()}
                  </div>
                )}
                <div className="min-w-0 text-left">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-white/45">
                    Opponent
                  </p>
                  <p className="truncate text-sm font-bold text-[#f5ff3b]">
                    {opponent.isAi ? (
                      <span className="inline-flex items-center gap-1">
                        <IconRobot size={15} className="text-cyan-300" aria-hidden="true" />
                        {opponent.name || "GRYND AI"}
                      </span>
                    ) : (
                      opponent.name || "Opponent"
                    )}
                  </p>
                </div>
              </div>
            )}

            {/* Compact match summary */}
            {rows.length > 0 && (
              <div className="mx-auto mt-5 w-full max-w-xs space-y-1.5 rounded-xl border border-white/10 bg-black/25 px-4 py-3 text-sm">
                {rows.map((row) => (
                  <p key={row.label} className="flex items-center justify-between gap-4">
                    <span className="shrink-0 text-white/50">{row.label}</span>
                    <span className="truncate text-right font-semibold text-white/90">
                      {row.value}
                    </span>
                  </p>
                ))}
              </div>
            )}

            {/* Actions */}
            {(playAgain ||
              rematch ||
              analysisAction ||
              secondaryAction ||
              onReturnToLobby ||
              onDismiss) && (
              <div className="mx-auto mt-6 flex w-full max-w-xs flex-col gap-2.5">
                {playAgain && (
                  <button
                    type="button"
                    onClick={guard("playAgain", playAgain.onClick)}
                    disabled={navigating || Boolean(pendingExit)}
                    aria-busy={pendingExit === "playAgain"}
                    className="inline-flex w-full items-center justify-center gap-2 rounded-xl border-b-4 border-[#0087a8] bg-[#00e5ff] px-5 py-3 text-sm font-extrabold text-[#001a2e] transition hover:brightness-110 disabled:opacity-60"
                  >
                    {pendingExit === "playAgain" && (
                      <span aria-hidden="true" className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                    )}
                    {playAgain.label || "RUN IT BACK"}
                  </button>
                )}
                {rematch && (
                  <button
                    type="button"
                    onClick={guard("rematch", rematch.onClick)}
                    disabled={navigating || Boolean(pendingExit)}
                    aria-busy={pendingExit === "rematch"}
                    className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-[#00e5ff]/50 bg-[#00e5ff]/10 px-5 py-3 text-sm font-bold text-[#67f9ff] transition hover:bg-[#00e5ff]/20 disabled:opacity-60"
                  >
                    {pendingExit === "rematch" && (
                      <span aria-hidden="true" className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                    )}
                    {rematch.label || "Rematch"}
                  </button>
                )}
                {/* Match analysis. A deliberate departure from the result,
                    requested by the player — never opened automatically — so
                    it goes through the same exit gate as every other control. */}
                {analysisAction && analysisAction.href && (
                  <Link
                    href={analysisAction.href}
                    onClick={(event) => {
                      event.preventDefault();
                      guard("analysis", () => router.push(analysisAction.href))();
                    }}
                    className="flex w-full items-center justify-center rounded-xl border border-cyan-300/40 bg-cyan-300/10 px-5 py-3 text-sm font-bold text-cyan-200 transition hover:bg-cyan-300/20"
                  >
                    {analysisAction.label || "Match analysis"}
                  </Link>
                )}
                {/* Generic extra action — navigation (href) uses the router link
                    so it prefetches like any other in-app route; an in-page
                    action (onClick) is guarded like the other buttons. */}
                {secondaryAction && secondaryAction.href && (
                  <Link
                    href={secondaryAction.href}
                    // Same gate as the buttons: this exit offers the video
                    // first and the route runs once the surface settles.
                    onClick={(event) => {
                      event.preventDefault();
                      guard("secondary", () => router.push(secondaryAction.href))();
                    }}
                    className="flex w-full items-center justify-center rounded-xl border border-[#00e5ff]/50 bg-[#00e5ff]/10 px-5 py-3 text-sm font-bold text-[#67f9ff] transition hover:bg-[#00e5ff]/20"
                  >
                    {secondaryAction.label || "Continue"}
                  </Link>
                )}
                {secondaryAction && !secondaryAction.href && (
                  <button
                    type="button"
                    onClick={guard("secondary", secondaryAction.onClick)}
                    disabled={navigating || Boolean(pendingExit)}
                    aria-busy={pendingExit === "secondary"}
                    className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-[#00e5ff]/50 bg-[#00e5ff]/10 px-5 py-3 text-sm font-bold text-[#67f9ff] transition hover:bg-[#00e5ff]/20 disabled:opacity-60"
                  >
                    {pendingExit === "secondary" && (
                      <span aria-hidden="true" className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                    )}
                    {secondaryAction.label || "Continue"}
                  </button>
                )}
                {onReturnToLobby && (
                  <button
                    type="button"
                    onClick={guard("lobby", onReturnToLobby)}
                    disabled={navigating || Boolean(pendingExit)}
                    aria-busy={pendingExit === "lobby"}
                    className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-white/15 bg-white/5 px-5 py-3 text-sm font-semibold text-white/80 transition hover:bg-white/10 disabled:opacity-60"
                  >
                    {pendingExit === "lobby" && (
                      <span aria-hidden="true" className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                    )}
                    Return to Lobby
                  </button>
                )}
                {onDismiss && (
                  <button
                    type="button"
                    onClick={guard("dismiss", onDismiss)}
                    disabled={navigating || Boolean(pendingExit)}
                    aria-busy={pendingExit === "dismiss"}
                    className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-white/10 px-5 py-2.5 text-xs font-semibold text-white/50 transition hover:bg-white/5 hover:text-white/80 disabled:opacity-60"
                  >
                    {pendingExit === "dismiss" && (
                      <span aria-hidden="true" className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                    )}
                    {dismissLabel}
                  </button>
                )}
              </div>
            )}

            {/* Guest → account invitation. In the panel's own flow, BELOW the
                actions, so it never covers the outcome, the score or the
                retry/lobby controls. The component is inert for an account and
                for a game without guest progression; `revealed` is only true
                once the match has actually finished, so nothing can appear
                during play, matchmaking, loading or a cancelled match. */}
            {!compact && !portalSurface && guestGameKey ? (
              <div className="mx-auto mt-5 w-full max-w-xs">
                <GuestPostMatchCta
                  gameKey={guestGameKey}
                  matchFinished={revealed}
                />
              </div>
            ) : null}

            {/* Post-match advertisement. It is NOT mounted over the result any
                more: the guard above opens it when the player picks an exit
                action, and that action runs once it reports back. A game that
                wired its own node still wins; every other game gets the shared
                slot, which renders nothing unless the server says it may offer
                one (and never for a GRYND PRO member). Compact creator
                recordings carry no ad at all. */}
            {!compact && postMatchAd && (
              <div className="mx-auto mt-5 w-full max-w-xs">{postMatchAd}</div>
            )}
            {!compact && !portalSurface && adOpen && !postMatchAd && (
              <div className="mx-auto mt-5 w-full max-w-xs">
                <PostMatchAdSlot onDone={handleAdSettled} />
              </div>
            )}

            {/* Expandable match details */}
            {hasDetails && (
              <div className="mx-auto mt-5 w-full max-w-xs overflow-hidden rounded-xl border border-white/10">
                <button
                  type="button"
                  onClick={() => setDetailsOpen((v) => !v)}
                  aria-expanded={detailsOpen}
                  className="flex w-full items-center justify-between bg-black/25 px-4 py-2.5 text-left text-xs font-bold uppercase tracking-wider text-white/60 transition hover:bg-black/35"
                >
                  Match Details
                  <IconChevronDown
                    size={16}
                    className={`transition-transform duration-200 ${detailsOpen ? "rotate-180" : ""}`}
                    aria-hidden="true"
                  />
                </button>
                <AnimatePresence initial={false}>
                  {detailsOpen && (
                    <motion.div
                      initial={shouldReduce ? false : { height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={shouldReduce ? undefined : { height: 0, opacity: 0 }}
                      transition={{ duration: 0.22, ease: "easeOut" }}
                      className="bg-black/15"
                    >
                      <div className="space-y-1.5 px-4 py-3 text-xs">
                        {allDetails.map((row) => (
                          <p key={row.label} className="flex items-center justify-between gap-4">
                            <span className="text-white/45">{row.label}</span>
                            <span className="truncate text-right font-semibold text-white/85">
                              {row.value}
                            </span>
                          </p>
                        ))}
                        {detailsContent}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            )}
          </motion.div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}