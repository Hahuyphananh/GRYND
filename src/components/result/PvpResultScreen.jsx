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

import React, { useEffect, useRef, useState } from "react";
import Link from "next/link";
import ShareWinButton from "../share/ShareWinButton";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  IconChevronDown,
  IconFlame,
  IconHeartHandshake,
  IconRobot,
  IconTrophy,
  IconX,
} from "@tabler/icons-react";
import { fireConfetti, withReducedMotion } from "../../lib/animations";
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
// the panel is held back 1s after the match ends, so the finished board (the
// winning line, the last ball, the losing tile…) is what the player reads
// first, and the result then lands on top of it. Exported so a game (and the
// test that pins this) can reason about the beat without repeating it.
export const RESULT_REVEAL_DELAY_MS = 1_000;

function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.round(Number(totalSeconds) || 0));
  const m = Math.floor(s / 60);
  const sec = String(s % 60).padStart(2, "0");
  return `${m}:${sec}`;
}

function formatNumber(n) {
  return Number(n || 0).toLocaleString();
}

// Outcome is a 2px rule, a chip and one accent word — not a page-wide
// gradient. The panel itself is the same surface in every outcome, so a loss
// never looks like a different product from a win.
const OUTCOME_STYLES = {
  win: {
    label: "WIN",
    tagline: "You took the match",
    icon: IconTrophy,
    accentText: "text-[color:var(--state-win)]",
    bar: "bg-[color:var(--state-win)]",
    chip: "border-[color:var(--border-success)] bg-[color:var(--accent-fill)] text-[color:var(--state-win)]",
  },
  loss: {
    label: "LOSS",
    tagline: "The match got away — run it back",
    icon: IconX,
    accentText: "text-[color:var(--state-loss)]",
    bar: "bg-[color:var(--state-loss)]",
    chip: "border-[color:var(--border-hairline)] bg-[color:var(--bg-panel)] text-[color:var(--state-loss)]",
  },
  draw: {
    label: "DRAW",
    tagline: "Evenly matched — both walk away",
    icon: IconHeartHandshake,
    accentText: "text-[color:var(--text-primary)]",
    bar: "bg-[color:var(--border-strong)]",
    chip: "border-[color:var(--border-hairline)] bg-[color:var(--bg-panel)] text-[color:var(--text-primary)]",
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
  // beat. Defaults to the platform-wide 1s; a game may shorten it, never
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
  // Optional share-a-win config, shaped `{ mode?: "Ranked", url?: string }`.
  // Only games that pass it get the control, and the screen shows it on a WIN
  // only — a "share" button on a loss would be a joke at the player's expense.
  // The time in the shared copy is `durationSeconds`, i.e. the same number the
  // result rows display, so the post can never exaggerate the run.
  shareWin = null,
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
  //   [{ name: "You", score: 240, highlight: true, elo: 1180 },
  //    { name: "Rival", score: 180, elo: 1240 }]
  // The highlighted side is emphasised; the other stays visible but muted.
  // `elo` is optional: when a side carries a number it is printed under the
  // score in Match Details (the bot's roster strength in a practice match, the
  // player's rated Elo in a ranked one); a null/absent value prints nothing.
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
  // The result is a modal in the only sense that matters on a phone: the match
  // is over and nothing behind it can be played. It therefore owns focus while
  // it is up — otherwise the keyboard and Tab still talk to the board — and
  // hands it back when the panel leaves. Escape, which the native Back button
  // dispatches (see NativeBackButton), takes the same exit as "Return to
  // Lobby", so Back can no longer be swallowed by an invisible dialog.
  const panelRef = useRef(null);
  useEffect(() => {
    if (!revealed) return undefined;
    const panel = panelRef.current;
    const previous = typeof document === "undefined" ? null : document.activeElement;
    panel?.focus({ preventScroll: true });

    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        const exit = onReturnToLobby || onDismiss;
        if (!exit || navigating) return;
        event.preventDefault();
        // Same latch the buttons use, so a doubled Back cannot navigate twice.
        setNavigating(true);
        exit();
        return;
      }
      if (event.key !== "Tab" || !panel) return;
      const items = Array.from(
        panel.querySelectorAll(
          'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (
        event.shiftKey &&
        (document.activeElement === first || document.activeElement === panel)
      ) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (previous && typeof previous.focus === "function") {
        try {
          previous.focus({ preventScroll: true });
        } catch {
          // The control that opened the result is gone (e.g. after a rematch).
        }
      }
    };
  }, [revealed, navigating, onReturnToLobby, onDismiss]);
  // A RESULT SCREEN CAN OUTLIVE A RESULT. A rematch or a re-deal navigates to a
  // NEW match on the SAME route, where React keeps this component instance
  // alive, so the per-result `navigating` flag has to be reset when the next
  // result opens or every exit button would stay disabled.
  useEffect(() => {
    if (!open) return;
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

  // One action per screen: once Play Again / Rematch / Lobby is picked, disable
  // the buttons so a double-tap can't create two matches. The post-match video
  // no longer waits for an exit — it plays as soon as the result is on screen —
  // so an exit action is never parked here.
  const guard = (key, fn) => () => {
    if (navigating || typeof fn !== "function") return;
    setNavigating(true);
    fn();
  };

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

  // ── The ONE number and the ONE action ────────────────────────────────
  // The number is the new Overall Elo when the server settled one, otherwise
  // the first progression value the game passed. Everything else (score rows,
  // bars, opponent, summary) lives inside Match Details.
  const firstProgress = Array.isArray(progress) && progress.length > 0 ? progress[0] : null;
  const primaryNumber = displayOverall
    ? formatNumber(displayOverall.overallElo)
    : firstProgress
      ? String(firstProgress.to)
      : null;
  const primaryNumberLabel = displayOverall
    ? "Overall Elo"
    : firstProgress
      ? firstProgress.label
      : "";
  const primaryDelta = displayOverall
    ? displayOverall.overallDelta
    : firstProgress
      ? null
      : null;

  // The disclosure is worth showing whenever it would contain something the
  // first read does not: a score comparison, progression bars, an opponent
  // strip, summary rows, a detail list or an analysis entry point.
  const hasDetailsContent =
    hasDetails ||
    (Array.isArray(sides) && sides.length > 0) ||
    Boolean(opponent) ||
    hasProgression ||
    rows.length > 0 ||
    Boolean(analysisAction && analysisAction.href);

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
          className={`fixed inset-0 z-[95] overflow-y-auto bg-black/80 px-3 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))] backdrop-blur-xs sm:px-4 ${
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
                // A win settles with its small overshoot; a loss lands firmer
                // and flatter (no bounce); a draw lands dead neutral (a plain
                // ease, no overshoot at all) so it never reads as a win. The
                // motion is the ONLY difference — no shake, no red wash.
                transition:
                  outcome === "loss"
                    ? { type: "spring", stiffness: 340, damping: 30 }
                    : outcome === "draw"
                      ? { duration: 0.3, ease: "easeOut" }
                      : panelMotion.transition,
              })}
              ref={panelRef}
              tabIndex={-1}
              className={`relative w-full overflow-hidden rounded-[var(--radius-surface)] border border-[color:var(--border-hairline)] bg-[color:var(--bg-surface)] text-center shadow-[var(--shadow-raise)] outline-none ${
                compact ? "max-w-[22rem] p-4" : "max-w-md p-5 sm:p-7"
              }`}
            >
              {/* ONE OUTCOME LINE. The hue lives in this 2px rule and the
                  outcome chip, never in a page-wide gradient. */}
              <div className={`absolute inset-x-0 top-0 h-0.5 ${style.bar}`} aria-hidden="true" />

              <div className="relative">
                <span
                  className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-black uppercase tracking-[0.2em] ${style.chip}`}
                >
                  <OutcomeIcon size={14} aria-hidden="true" />
                  {outcome === "win" ? "YOU WON" : outcome === "loss" ? "DEFEAT" : "DRAW"}
                </span>

                {/* The hero names the opponent when there is a real one, and
                    the bot by its portrait when there is not. Everything else
                    is the supporting line below. */}
                {outcome === "win" &&
                opponent &&
                !opponent.isAi &&
                opponent.kind !== "recorded" &&
                opponent.name &&
                opponent.name !== "Opponent" &&
                opponent.kind !== "ai" ? (
                  <h2
                    className={`mt-3 font-black leading-tight tracking-tight text-[color:var(--text-primary)] ${
                      compact ? "text-2xl" : "text-3xl sm:text-4xl"
                    }`}
                  >
                    You beat{" "}
                    <span className="text-[color:var(--state-gold)]">@{opponent.name}</span>
                  </h2>
                ) : outcome === "loss" &&
                  opponent &&
                  !opponent.isAi &&
                  opponent.kind !== "recorded" &&
                  opponent.name &&
                  opponent.name !== "Opponent" &&
                  opponent.kind !== "ai" ? (
                  <h2
                    className={`mt-3 font-black leading-tight tracking-tight text-[color:var(--text-primary)] ${
                      compact ? "text-2xl" : "text-3xl sm:text-4xl"
                    }`}
                  >
                    Defeated by{" "}
                    <span className="text-[color:var(--text-secondary)]">@{opponent.name}</span>
                  </h2>
                ) : opponent?.kind === "recorded" && opponent.name ? (
                  // A recorded run is never presented as the live person whose
                  // moves it replays. The name is shown as the recording's
                  // handle, with the classification stated in words.
                  <>
                    <h2
                      className={`mt-3 font-black leading-tight tracking-tight ${
                        outcome === "win"
                          ? "text-[color:var(--state-win)]"
                          : "text-[color:var(--state-loss)]"
                      } ${compact ? "text-2xl" : "text-3xl sm:text-4xl"}`}
                    >
                      {outcome === "win" ? "You beat a recorded opponent" : "Beaten by a recorded opponent"}
                    </h2>
                    <p className="mt-1 text-sm text-[color:var(--text-muted)]">
                      {opponent.name} — a replay of a real player&apos;s run on this deal, not a live player.
                    </p>
                  </>
                ) : outcome === "win" && opponent?.isAi && opponent.name ? (
                  <>
                    <h2
                      className={`mt-3 font-black leading-tight tracking-tight text-[color:var(--state-win)] ${
                        compact ? "text-2xl" : "text-3xl"
                      }`}
                    >
                      You beat
                    </h2>
                    {/* The bot's face with its name and strength rating beside
                        it — the three things the player actually raced. */}
                    <div className="mt-2 flex items-center justify-center gap-3 text-left">
                      {opponentPortrait}
                      <div className="min-w-0">
                        <p
                          className={`truncate font-black text-[color:var(--state-gold)] ${
                            compact ? "text-2xl" : "text-2xl sm:text-3xl"
                          }`}
                        >
                          {opponent.name}
                        </p>
                        {opponent.ratingLabel && (
                          <p className="mt-1 inline-flex items-center gap-1 rounded-full border border-[color:var(--border-hairline)] bg-[color:var(--bg-panel)] px-2 py-0.5 font-mono text-[11px] font-bold text-[color:var(--text-secondary)]">
                            <IconTrophy size={11} aria-hidden="true" />
                            {opponent.ratingLabel}
                          </p>
                        )}
                      </div>
                    </div>
                  </>
                ) : outcome === "loss" && opponent?.isAi && opponent.name ? (
                  <>
                    <h2
                      className={`mt-3 font-black leading-tight tracking-tight text-[color:var(--state-loss)] ${
                        compact ? "text-2xl" : "text-3xl"
                      }`}
                    >
                      Defeated by
                    </h2>
                    <div className="mt-2 flex items-center justify-center gap-3 text-left">
                      {opponentPortrait}
                      <div className="min-w-0">
                        <p
                          className={`truncate font-black text-[color:var(--text-primary)] ${
                            compact ? "text-2xl" : "text-2xl sm:text-3xl"
                          }`}
                        >
                          {opponent.name}
                        </p>
                        {opponent.ratingLabel && (
                          <p className="mt-1 inline-flex items-center gap-1 rounded-full border border-[color:var(--border-hairline)] bg-[color:var(--bg-panel)] px-2 py-0.5 font-mono text-[11px] font-bold text-[color:var(--text-secondary)]">
                            <IconTrophy size={11} aria-hidden="true" />
                            {opponent.ratingLabel}
                          </p>
                        )}
                      </div>
                    </div>
                  </>
                ) : outcome === "win" ? (
                  <h2
                    className={`mt-3 font-black leading-tight tracking-tight text-[color:var(--text-primary)] ${
                      compact ? "text-2xl" : "text-3xl sm:text-4xl"
                    }`}
                  >
                    You won the match
                  </h2>
                ) : outcome === "loss" ? (
                  <h2
                    className={`mt-3 font-black leading-tight tracking-tight text-[color:var(--text-primary)] ${
                      compact ? "text-2xl" : "text-3xl sm:text-4xl"
                    }`}
                  >
                    Match lost
                  </h2>
                ) : (
                  <h2
                    className={`mt-3 font-black leading-tight tracking-tight text-[color:var(--text-primary)] ${
                      compact ? "text-2xl" : "text-3xl sm:text-4xl"
                    }`}
                  >
                    Draw
                  </h2>
                )}

                {headline && headline !== style.tagline && (
                  <p
                    className={`mx-auto mt-2 max-w-sm text-[color:var(--text-secondary)] ${
                      compact ? "text-[11px]" : "text-sm"
                    }`}
                  >
                    {headline}
                  </p>
                )}
                {subline && (
                  <p
                    className={`mx-auto mt-1 max-w-sm text-[color:var(--text-muted)] ${
                      compact ? "text-[11px]" : "text-xs"
                    }`}
                  >
                    {subline}
                  </p>
                )}
              </div>

              {/* ONE NUMBER. The figure the player came for: the new Overall
                  Elo when the server settled one, otherwise the first
                  progression value the game passed. A delta rides beside it. */}
              {primaryNumber !== null && (
                <motion.div
                  {...withReducedMotion(shouldReduce, {
                    initial: { opacity: 0, y: 6 },
                    animate: { opacity: 1, y: 0 },
                    transition: { duration: 0.2, ease: "easeOut", delay: 0.18 },
                  })}
                  className="mt-5"
                  data-testid="result-primary-number"
                >
                  <p
                    className={`font-black tabular-nums leading-none text-[color:var(--text-primary)] ${
                      compact ? "text-4xl" : "text-5xl sm:text-6xl"
                    }`}
                  >
                    {primaryNumber}
                  </p>
                  <p className="mt-2 flex items-center justify-center gap-2 text-[11px] font-bold uppercase tracking-[0.18em] text-[color:var(--text-muted)]">
                    {primaryNumberLabel}
                    {primaryDelta !== null && primaryDelta !== undefined && Number(primaryDelta) !== 0 && (
                      <span
                        className={
                          Number(primaryDelta) > 0
                            ? "text-[color:var(--state-win)]"
                            : "text-[color:var(--state-loss)]"
                        }
                      >
                        {Number(primaryDelta) > 0 ? "+" : ""}
                        {formatNumber(primaryDelta)}
                      </span>
                    )}
                  </p>
                </motion.div>
              )}

              {/* GLITCH — inline, under the number. It never covers the score,
                  the progression, the actions or the ad, and it states nothing
                  about rewards. Suppressed in compact recordings and whenever a
                  game supplies its own mascot line. */}
              {showGlitch && !compact && glitchReaction.show && (
                <div className="mx-auto mt-3 flex w-full max-w-xs justify-center">
                  <GlitchSay
                    expression={glitchReaction.moment.expression}
                    message={t(glitchReaction.moment.messageKey)}
                    eventId={glitchReaction.moment.eventId}
                    placement="inline"
                    size="sm"
                  />
                </div>
              )}

              {/* Game-specific visual — how it ended, in the game's own terms. */}
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

              {/* Real streak + weekly rank, quiet chips beside the number. */}
              {(showStreak || showRank) && (
                <div className="mx-auto mt-4 flex w-full max-w-xs flex-wrap items-center justify-center gap-2">
                  {showStreak && (
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-[color:var(--border-hairline)] bg-[color:var(--bg-panel)] px-3 py-1 text-xs font-black uppercase tracking-wider text-[color:var(--state-gold)]">
                      <IconFlame size={13} aria-hidden="true" />
                      {formatNumber(displayStreak)} win streak
                    </span>
                  )}
                  {showRank && (
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-[color:var(--border-hairline)] bg-[color:var(--bg-panel)] px-3 py-1 text-xs font-black uppercase tracking-wider text-[color:var(--text-secondary)]">
                      <IconTrophy size={13} aria-hidden="true" />
                      {displayRankDelta !== null && Number(displayRankDelta) > 0
                        ? `RANK ↑ ${formatNumber(displayRankDelta)} · #${formatNumber(displayRank)}`
                        : `WEEKLY RANK #${formatNumber(displayRank)}`}
                    </span>
                  )}
                </div>
              )}

              {/* ONE ACTION, in this order: the retry the game offered, then
                  the generic continue, then the lobby, then the quiet dismiss.
                  Only the first is a filled button. */}
              {(playAgain ||
                rematch ||
                analysisAction ||
                secondaryAction ||
                onReturnToLobby ||
                onDismiss) && (
                <div className="mx-auto mt-6 flex w-full max-w-xs flex-col items-stretch gap-2.5">
                  {playAgain && (
                    <button
                      type="button"
                      onClick={guard("playAgain", playAgain.onClick)}
                      disabled={navigating}
                      className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-[color:var(--accent)] px-5 py-3 text-sm font-extrabold text-[color:var(--on-accent)] transition hover:bg-[color:var(--accent-strong)] disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {playAgain.label || "RUN IT BACK"}
                    </button>
                  )}
                  {rematch && (
                    <button
                      type="button"
                      onClick={guard("rematch", rematch.onClick)}
                      disabled={navigating}
                      className={
                        playAgain
                          ? "inline-flex w-full items-center justify-center gap-2 rounded-lg border border-[color:var(--border-strong)] px-5 py-2.5 text-sm font-semibold text-[color:var(--text-primary)] transition hover:bg-[color:var(--bg-panel)] disabled:opacity-60"
                          : "inline-flex w-full items-center justify-center gap-2 rounded-lg bg-[color:var(--accent)] px-5 py-3 text-sm font-extrabold text-[color:var(--on-accent)] transition hover:bg-[color:var(--accent-strong)] disabled:cursor-not-allowed disabled:opacity-60"
                      }
                    >
                      {rematch.label || "Rematch"}
                    </button>
                  )}
                  {secondaryAction && secondaryAction.href && (
                    <Link
                      href={secondaryAction.href}
                      // Same gate as the buttons: this exit offers the video
                      // first and the route runs once the surface settles.
                      onClick={(event) => {
                        event.preventDefault();
                        guard("secondary", () => router.push(secondaryAction.href))();
                      }}
                      className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-[color:var(--border-strong)] px-5 py-2.5 text-sm font-semibold text-[color:var(--text-primary)] transition hover:bg-[color:var(--bg-panel)]"
                    >
                      {secondaryAction.label || "Continue"}
                    </Link>
                  )}
                  {secondaryAction && !secondaryAction.href && (
                    <button
                      type="button"
                      onClick={guard("secondary", secondaryAction.onClick)}
                      disabled={navigating}
                      className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-[color:var(--border-strong)] px-5 py-2.5 text-sm font-semibold text-[color:var(--text-primary)] transition hover:bg-[color:var(--bg-panel)] disabled:opacity-60"
                    >
                      {secondaryAction.label || "Continue"}
                    </button>
                  )}
                  {onReturnToLobby && (
                    <button
                      type="button"
                      onClick={guard("lobby", onReturnToLobby)}
                      disabled={navigating}
                      className="inline-flex w-full items-center justify-center gap-2 rounded-lg px-5 py-2 text-sm font-semibold text-[color:var(--text-secondary)] transition hover:text-[color:var(--text-primary)] disabled:opacity-60"
                    >
                      Return to Lobby
                    </button>
                  )}
                  {onDismiss && (
                    <button
                      type="button"
                      onClick={guard("dismiss", onDismiss)}
                      disabled={navigating}
                      className="inline-flex w-full items-center justify-center rounded-lg px-5 py-1.5 text-xs font-semibold text-[color:var(--text-muted)] transition hover:text-[color:var(--text-primary)] disabled:opacity-60"
                    >
                      {dismissLabel}
                    </button>
                  )}
                </div>
              )}

              {/* Share this win — outside the actions block, so it is present
                  even for a result that offers no retry/lobby action. */}
              {!compact && shareWin && outcome === "win" && (
                <div className="mx-auto mt-4 flex w-full max-w-xs justify-center">
                  <ShareWinButton
                    game={shareWin.game ?? "duel"}
                    mode={shareWin.mode ?? null}
                    durationMs={
                      durationSeconds !== null && durationSeconds !== undefined
                        ? Number(durationSeconds) * 1000
                        : null
                    }
                    url={shareWin.url ?? null}
                    testId="result-share-win"
                  />
                </div>
              )}

              {/* Guest → account invitation. BELOW the actions, so it never
                  covers the outcome, the number or the retry. `revealed` is
                  only true once the match finished. */}
              {!compact && !portalSurface && guestGameKey ? (
                <div className="mx-auto mt-5 w-full max-w-xs">
                  <GuestPostMatchCta gameKey={guestGameKey} matchFinished={revealed} />
                </div>
              ) : null}

              {/* Post-match advertisement — an overlay, so the result, the
                  number and the controls stay behind it. A game that wired its
                  own node still wins; every other game gets the shared slot,
                  which renders nothing unless the server says it may. */}
              {!compact && postMatchAd && (
                <div className="mx-auto mt-5 w-full max-w-xs">{postMatchAd}</div>
              )}
              {!compact && !portalSurface && !postMatchAd && revealed && (
                <div className="mx-auto mt-5 w-full max-w-xs">
                  <PostMatchAdSlot />
                </div>
              )}

              {/* MATCH DETAILS — everything the player might want to check,
                  one tap away and out of the first read: the score comparison,
                  the progression bars, the opponent, the summary rows, the
                  analysis entry point and the expansion content. */}
              {hasDetailsContent && (
                <div className="mx-auto mt-5 w-full overflow-hidden rounded-[var(--radius-surface)] border border-[color:var(--border-hairline)]">
                  <button
                    type="button"
                    onClick={() => setDetailsOpen((v) => !v)}
                    aria-expanded={detailsOpen}
                    className="flex w-full items-center justify-between bg-[color:var(--bg-panel)] px-4 py-2.5 text-left text-xs font-bold uppercase tracking-wider text-[color:var(--text-secondary)] transition hover:text-[color:var(--text-primary)]"
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
                        className="bg-[color:var(--bg-page)]"
                      >
                        <div className="space-y-3 px-4 py-3 text-xs">
                          {/* Final score — the winner emphasised, the loser
                              muted but fully readable. */}
                          {Array.isArray(sides) && sides.length > 0 && (
                            <div className="grid grid-cols-2 gap-2">
                              {sides.map((side, i) => (
                                <div
                                  key={`${side.name || "side"}-${i}`}
                                  className={`rounded-lg border p-2.5 text-center ${
                                    side.highlight
                                      ? "border-[color:var(--accent)] bg-[color:var(--accent-fill)]"
                                      : "border-[color:var(--border-hairline)] bg-[color:var(--bg-panel)] opacity-80"
                                  }`}
                                >
                                  <p className="truncate text-[11px] uppercase tracking-wider text-[color:var(--text-muted)]">
                                    {side.name}
                                  </p>
                                  <p
                                    className={`mt-0.5 font-black tabular-nums ${
                                      side.highlight
                                        ? "text-2xl text-[color:var(--text-primary)]"
                                        : "text-xl text-[color:var(--text-secondary)]"
                                    }`}
                                  >
                                    {side.score}
                                  </p>
                                  {side.elo !== null &&
                                    side.elo !== undefined &&
                                    Number.isFinite(Number(side.elo)) && (
                                      <p
                                        data-testid="result-side-elo"
                                        title="Elo rating for this game"
                                        className="mt-0.5 font-mono text-[11px] font-bold text-[color:var(--text-muted)]"
                                      >
                                        {formatNumber(side.elo)} Elo
                                      </p>
                                    )}
                                  {side.highlight && (
                                    <p className="mt-0.5 text-[11px] font-bold uppercase tracking-widest text-[color:var(--accent-strong)]">
                                      Winner
                                    </p>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}

                          {/* Progression — only rows whose data exists. */}
                          {hasProgression && (
                            <div className="space-y-2">
                              {displayOverall !== null && (
                                <div className="rounded-lg border border-[color:var(--border-hairline)] bg-[color:var(--bg-panel)] px-3 py-2">
                                  <div className="flex items-center justify-between text-sm">
                                    <span className="font-bold text-[color:var(--text-secondary)]">
                                      Overall Elo
                                    </span>
                                    <span className="font-black text-[color:var(--text-primary)]">
                                      {displayOverall.previousOverallElo !== null &&
                                      displayOverall.previousOverallElo !== undefined ? (
                                        <>
                                          {formatNumber(displayOverall.previousOverallElo)}{" "}
                                          <span className="text-[color:var(--text-muted)]">
                                            {"→"}
                                          </span>{" "}
                                          <span className="text-[color:var(--state-gold)]">
                                            {formatNumber(displayOverall.overallElo)}
                                          </span>
                                        </>
                                      ) : (
                                        <span className="text-[color:var(--state-gold)]">
                                          {formatNumber(displayOverall.overallElo)}
                                        </span>
                                      )}
                                    </span>
                                  </div>
                                  <div className="mt-1 flex items-center justify-between text-[11px] text-[color:var(--text-muted)]">
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
                                              ? "font-black text-[color:var(--state-win)]"
                                              : "font-black text-[color:var(--state-loss)]"
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
                                <div
                                  key={p.label}
                                  className="rounded-lg border border-[color:var(--border-hairline)] bg-[color:var(--bg-panel)] px-3 py-2"
                                >
                                  <div className="flex items-center justify-between text-sm">
                                    <span className="font-bold text-[color:var(--text-secondary)]">
                                      {p.label}
                                    </span>
                                    <span className="font-black text-[color:var(--text-primary)]">
                                      {p.from}{" "}
                                      <span className="text-[color:var(--text-muted)]">→</span>{" "}
                                      <span className={style.accentText}>{p.to}</span>
                                    </span>
                                  </div>
                                  <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-[color:var(--bg-page)]">
                                    <motion.div
                                      initial={shouldReduce ? false : { width: 0 }}
                                      animate={{
                                        width: `${Math.max(0, Math.min(100, p.percent))}%`,
                                      }}
                                      transition={{ duration: 0.8, ease: "easeOut", delay: 0.25 }}
                                      className={`h-full rounded-full ${style.bar}`}
                                    />
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}

                          {/* Opponent strip */}
                          {opponent && (
                            <div className="flex items-center gap-3 rounded-lg border border-[color:var(--border-hairline)] bg-[color:var(--bg-panel)] px-3 py-2">
                              {opponent.iconKey ? (
                                <FrameAvatar
                                  frame={opponent.profileFrame}
                                  iconKey={opponent.iconKey}
                                  name={opponent.name}
                                  size="h-9 w-9"
                                />
                              ) : opponent.imageSrc ? (
                                // A bot's roster portrait — same artwork the
                                // player raced.
                                // eslint-disable-next-line @next/next/no-img-element
                                <img
                                  src={opponent.imageSrc}
                                  alt={opponent.imageAlt || `${opponent.name || "Opponent"} portrait`}
                                  width={36}
                                  height={36}
                                  data-testid="result-opponent-strip-image"
                                  className="h-9 w-9 shrink-0 rounded-lg border border-[color:var(--border-hairline)] bg-[color:var(--bg-page)] object-cover object-center"
                                />
                              ) : (
                                <div className="flex h-9 w-9 items-center justify-center rounded-full border border-[color:var(--border-hairline)] bg-[color:var(--bg-panel)] text-sm font-black text-[color:var(--text-secondary)]">
                                  {(opponent.name || "?").charAt(0).toUpperCase()}
                                </div>
                              )}
                              <div className="min-w-0 text-left">
                                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[color:var(--text-muted)]">
                                  Opponent
                                  <span
                                    data-testid="result-opponent-kind"
                                    className="ml-2 rounded-full border border-[color:var(--border-hairline)] px-1.5 py-0.5 text-[9px] font-bold tracking-[0.12em]"
                                  >
                                    {opponent.kind === "recorded"
                                      ? "Recorded opponent"
                                      : opponent.kind === "ai"
                                        ? "GRYND AI"
                                        : "Live player"}
                                  </span>
                                </p>
                                <p className="truncate text-sm font-bold text-[color:var(--text-primary)]">
                                  {opponent.isAi ? (
                                    <span className="inline-flex items-center gap-1">
                                      <IconRobot
                                        size={14}
                                        className="text-[color:var(--text-secondary)]"
                                        aria-hidden="true"
                                      />
                                      {opponent.name || "GRYND AI"}
                                    </span>
                                  ) : (
                                    opponent.name || "Opponent"
                                  )}
                                </p>
                              </div>
                            </div>
                          )}

                          {/* Summary rows */}
                          {rows.length > 0 && (
                            <div className="space-y-1.5 rounded-lg border border-[color:var(--border-hairline)] bg-[color:var(--bg-panel)] px-3 py-2 text-sm">
                              {rows.map((row) => (
                                <p
                                  key={row.label}
                                  className="flex items-center justify-between gap-4"
                                >
                                  <span className="shrink-0 text-[color:var(--text-muted)]">
                                    {row.label}
                                  </span>
                                  <span className="truncate text-right font-semibold text-[color:var(--text-primary)]">
                                    {row.value}
                                  </span>
                                </p>
                              ))}
                            </div>
                          )}

                          {/* Match analysis. A deliberate departure from the
                              result, requested by the player — never opened
                              automatically — so it goes through the same exit
                              gate as every other control. */}
                          {analysisAction && analysisAction.href && (
                            <Link
                              href={analysisAction.href}
                              onClick={(event) => {
                                event.preventDefault();
                                guard("analysis", () => router.push(analysisAction.href))();
                              }}
                              className="flex w-full items-center justify-center rounded-lg border border-[color:var(--border-strong)] px-4 py-2 text-xs font-bold text-[color:var(--text-primary)] transition hover:bg-[color:var(--bg-panel)]"
                            >
                              {analysisAction.label || "Match analysis"}
                            </Link>
                          )}

                          {allDetails.map((row) => (
                            <p
                              key={row.label}
                              className="flex items-center justify-between gap-4"
                            >
                              <span className="text-[color:var(--text-muted)]">{row.label}</span>
                              <span className="truncate text-right font-semibold text-[color:var(--text-primary)]">
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
