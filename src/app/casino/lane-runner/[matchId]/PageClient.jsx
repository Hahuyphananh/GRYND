"use client";

// src/app/casino/lane-runner/[matchId]/page.jsx
//
// MATCH view for the "Lane Rush Duel" system. Both players race the
// SAME shared provably-fair tower (bad tile per lane per risk path),
// alternating turns, scored in POINTS.
//
// Skill mechanics (the anti-luck package):
//   • SHARED TOWER — both players climb one layout. Every safe pick
//     either player makes is shown on BOTH boards, so each pick is
//     a deduction you can use (eliminating a bad-tile candidate).
//   • DEFERRED REVEAL — a pick parks until the opponent answers the
//     same row; the two reveal together. Nobody can mirror the
//     other's current-row pick — you can only deduce from rows
//     already revealed to both.
//   • RISK PATHS — every lane you choose your odds: Safe (4 tiles,
//     75%), Balanced (3, 67%) or Risky (2, 50%), each paying more
//     points per safe pick. Choosing which luck to buy is the skill.
//   • BAD-TILE MEMORY — safe/balanced bad tiles never repeat the
//     previous lane's position on the same path, and a risky bad
//     tile never sits in the previous lane's SAFE position when it's
//     in range — so solving one path narrows the next row.
//   • THE FLAG — call the bad tile (2 per match): a CORRECT flag
//     claims the row + points and reveals the tile to both players,
//     a WRONG flag busts you. No more free instant wins.
//   • PEEK — spend one of 2 private peeks on your turn to instantly
//     learn if a tile in your current lane is safe or bad, without
//     consuming the turn. Only you see the answer; the opponent
//     just sees that you peeked. Verifiable post-match.
//   • HOLD — bank your points: they're locked (bust-proof) and the
//     first player to BANK 1,000 takes the pot. Banking never ends
//     the climb — you keep playing at a reduced rate, so the race
//     continues until someone locks the target.
//   • Provably fair — every path's bad tiles derive from a shared
//     server seed + the host's client seed; the full layout is
//     revealed post-match so the memory rule is verifiable.

import { useCallback, useEffect, useMemo, useRef, useState, use } from "react";
import { useRouter } from "next/navigation";
import { usePostHog } from "posthog-js/react";
import { useUser } from "@clerk/nextjs";
// `useReducedMotion` is framer-motion's own media-query hook; the shared
// `withReducedMotion` swaps a variant for the project's opacity-only static
// one. Together they are the repo's reduced-motion system (see blackjack /
// keno-pvp): the global CSS rule in globals.css can only collapse CSS
// animations and transitions, so every JS-driven (framer) movement has to
// opt out here as well — otherwise reduced motion would silently leave the
// biggest movements running.
import { motion, useReducedMotion } from "framer-motion";
import { withReducedMotion } from "../../../../lib/animations";
import NavigationBar from "../../../../components/navigation-bar";
import FrameAvatar from "../../../../components/FrameAvatar";
// Shared creator-mode presentation layer (admin-only).
import CreatorModeHost from "../../../../components/creator-mode/CreatorModeHost";
import {
  CreatorView,
  CreatorModeShell,
  ShellHeader,
  ShellMain,
  ShellAside,
} from "../../../../components/creator-mode/CreatorModeLayout";

import MatchWaiting from "../../../../components/lobby/MatchWaiting";
import PvpResultScreen from "../../../../components/result/PvpResultScreen";
import Footer from "../../../../components/Footer";
import { useSocket } from "../../../../context/SocketProvider";
import {
  LANE_RUSH_DUEL_MATCH_UPDATED,
  laneRushDuelMatchRoom,
} from "../../../../lib/lane-rush-duel/rooms";
import {
  DIFFICULTIES,
  MAX_FLAGS,
  MAX_LANES,
  MAX_PEEKS,
  RISK_PATHS,
  WIN_BANKED_SCORE,
  bankedGainOnHold,
  bustsByLaneForSeat,
  computeDeductions,
  latestBustFor,
  unbankedLostOnBust,
  pointsForSafePick,
  safePicksToReachScore,
  survivalOdds,
} from "../../../../lib/lane-rush-duel/constants";
import {
  playVictory,
  playDefeat,
  playTick,
  playGoodReveal,
  playOpponentPick,
  playOpponentBank,
  playOpponentBust,
  playBuzz,
  playSelect,
  playSafePick,
  playBank,
} from "../../../../lib/gameAudio";
import {
  IconLock,
  IconClock,
  IconArrowLeft,
  IconShieldCheck,
  IconFlag,
  IconEye,
  IconX,
} from "@tabler/icons-react";

function CoinIcon({ className = "" }) {
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

// The newest action a seat has resolved (any kind), or null. Read-only
// helper: it lets the board confirm a tap only when the AUTHORITATIVE
// history says that tap is the seat's latest and it didn't bust.
const lastActionForSeat = (actions, seat) => {
  if (!Array.isArray(actions)) return null;
  for (let i = actions.length - 1; i >= 0; i -= 1) {
    const a = actions[i];
    if (a && a.seat === seat) return a;
  }
  return null;
};

// Stable, semantic identity for a bust action: it only changes when a
// genuinely NEW bust happens, so it is safe to use as an
// animation/dedup key. A refresh re-delivers the same key and therefore
// replays nothing.
const bustKeyOf = (bust) =>
  bust
    ? `${bust.round ?? bust.lane}:${bust.tile ?? ""}:${bust.at ?? ""}`
    : null;

// One-shot animations for the bust feedback. Module-level (stable
// identity) so a poll/socket refresh that carries the SAME bust cannot
// restart them — they play exactly once, when the bust first appears.
const BUST_TILE_FLASH = { scale: [0.85, 1.1, 1] };
const BUST_TILE_TRANSITION = { duration: 0.36, ease: "easeOut" };
// The positive counterpart: a short, slightly bouncier pop for a tile the
// server just confirmed (safe pick / correct flag / peek). Same one-shot
// rules as the bust flash, and deliberately a different colour language
// (emerald ring here, red ✕ there) so success and bust never blur.
const CONFIRM_TILE_FLASH = { scale: [0.94, 1.12, 1] };
const CONFIRM_TILE_TRANSITION = { duration: 0.34, ease: "easeOut" };

// Identity of a BANK action: it only changes for a genuinely NEW bank, so
// a poll/socket refresh can't replay the banking feedback and a stale
// feedback timer can't clear newer feedback.
const holdKeyOf = (hold) =>
  hold
    ? `${hold.seat ?? ""}:${hold.round ?? hold.lane ?? ""}:${hold.bankedTotal ?? ""}:${hold.at ?? ""}`
    : null;

// Stable, semantic identity for a seat's newest RESOLVED action: it only
// changes when a genuinely NEW action lands, so it is safe as an
// animation/dedup key for BOTH seats — the opponent's read-out and the
// viewer's own cues key on the same identity. The immediate room broadcast,
// the 5s safety poll, a socket re-push, a reconnect or a page reload all
// re-deliver the SAME key, so none of them can re-announce (or re-sound) an
// action that has already been shown and heard once.
const actionKeyOf = (a) =>
  a
    ? [
        a.action,
        a.round ?? a.lane ?? "",
        a.tile ?? "",
        a.path ?? "",
        a.safe ?? "",
        a.points ?? "",
        a.bankedTotal ?? "",
        a.at ?? "",
      ].join(":")
    : null;

// One SHORT line describing what the opponent just did, phrased in the
// same terms the viewer's own feedback uses. Built only from the
// authoritative history — and a PEEK stays a peek: the server withholds
// which tile was scouted and its answer, so neither is ever named here.
function oppNoticeFor(action, actions) {
  if (!action) return null;
  const level = Math.min(
    (Number(action.round ?? action.lane) || 0) + 1,
    MAX_LANES,
  );
  if (action.action === "peek") {
    return { tone: "peek", text: `Scouted level ${level}` };
  }
  if (action.action === "hold") {
    const banked = Number(action.bankedTotal) || 0;
    const moved = bankedGainOnHold(actions, action.seat, action);
    return {
      tone: "bank",
      text: `Banked ${banked.toLocaleString()}${
        moved > 0 ? ` · +${moved.toLocaleString()} locked` : ""
      }`,
    };
  }
  if (action.safe === false) {
    const lost = unbankedLostOnBust(actions, action.seat, action);
    return {
      tone: "bust",
      text: `Busted level ${level}${
        lost > 0 ? ` · −${lost.toLocaleString()} at risk` : ""
      }`,
    };
  }
  const pts = Number(action.points) || 0;
  return {
    tone: "safe",
    text: `${action.action === "flag" ? "Called" : "Cleared"} level ${level}${
      pts > 0 ? ` · +${pts.toLocaleString()}` : ""
    }`,
  };
}

// Opponent-notice tones. Deliberately the opponent's own colour family
// (rose/neutral) rather than the viewer's cyan/emerald, so an opponent
// event can never be mistaken for one of the viewer's own.
const OPP_NOTICE_TONE = {
  safe: "bg-black/30 text-white/70",
  bust: "bg-red-500/20 text-red-100",
  bank: "bg-amber-400/15 text-amber-100",
  peek: "bg-rose-500/15 text-rose-100/90",
};

// Banking feedback: one short strip explaining the move (unbanked →
// protected) plus a brief emphasis on the protected total. Both are
// one-shot module constants (no permanent pulsing of the banked score)
// and both are keyed on the bank, never on the poll.
const BANK_ONESHOT = {
  initial: { opacity: 0, y: 8, scale: 0.98 },
  animate: { opacity: 1, y: 0, scale: [1.01, 1] },
  transition: { duration: 0.34, ease: "easeOut" },
};
const BANK_BADGE_FLASH = { scale: [1, 1.22, 1] };
const BANK_BADGE_TRANSITION = { duration: 0.4, ease: "easeOut" };
// The bank button's press feedback — the ONLY motion it needs. It is on
// screen for the entire match, so a looping pulse there would be a
// permanent animation competing with every real transition; the bankable
// amount carries a one-shot cue instead (keyed on the amount).
const BANK_PRESS_TRANSITION = { duration: 0.18, ease: "easeOut" };

// The live row ARRIVES once: it rises a few pixels into place and takes a
// short cyan sweep, so climbing reads as the board moving instead of one
// row of tiles being swapped for another. It is a one-shot target (rows
// keep their identity — the board is never in permanent motion), and the
// module-level constant means a poll/socket re-render cannot restart it.
const ROW_LIVE_ONESHOT = {
  y: [7, 0],
  boxShadow: [
    "0 0 0px 0px rgba(34,211,238,0)",
    "0 0 16px 0px rgba(34,211,238,0.36)",
    "0 0 0px 0px rgba(34,211,238,0)",
  ],
};
const ROW_LIVE_TRANSITION = { duration: 0.42, ease: "easeOut" };
const BUST_BANNER_ONESHOT = {
  initial: { opacity: 0, y: -8 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.4, ease: "easeOut" },
};

const PATH_STYLE = {
  safe: {
    chip: "border-emerald-300/50 bg-emerald-400/10 text-emerald-100",
    chipActive: "border-emerald-300 bg-emerald-400/25 text-emerald-50 shadow-[0_0_10px_rgba(52,211,153,0.5)]",
    tile: "bg-gradient-to-br from-emerald-500 to-green-700 border-emerald-300/50",
    text: "text-emerald-300",
  },
  balanced: {
    chip: "border-amber-300/50 bg-amber-400/10 text-amber-100",
    chipActive: "border-amber-300 bg-amber-400/25 text-amber-50 shadow-[0_0_10px_rgba(251,191,36,0.5)]",
    tile: "bg-gradient-to-br from-amber-500 to-yellow-700 border-amber-300/50",
    text: "text-amber-300",
  },
  risky: {
    chip: "border-rose-300/50 bg-rose-500/10 text-rose-100",
    chipActive: "border-rose-300 bg-rose-500/25 text-rose-50 shadow-[0_0_10px_rgba(251,113,133,0.5)]",
    tile: "bg-gradient-to-br from-rose-500 to-red-700 border-rose-300/50",
    text: "text-rose-300",
  },
};

// ── Scoreboard figures ──────────────────────────────────────────────
// A figure that emphasises itself for a moment when its VALUE changes.
// The React key IS the value, so the app's shared 180ms
// `animate-state-in` cue (globals.css) plays exactly on a change: a
// poll/socket snapshot carrying the same number, the 250ms local clock,
// or the creator frame re-rendering all keep the same key and never
// replay it — and a rapid run of changes restarts from the newest value
// instead of stacking. No new animation utility and no new library, and
// the global prefers-reduced-motion rule collapses it to its end state,
// so every figure stays fully readable with motion off.
function ScoreNumber({ value, className = "" }) {
  const shown = Number(value) || 0;
  return (
    <span
      key={shown}
      className={`inline-block animate-state-in tabular-nums ${className}`}
    >
      {shown.toLocaleString()}
    </span>
  );
}

// The run a seat's unbanked points are riding on: consecutive SAFE
// resolutions (a pick or a correct flag) since its last bust. Read-only
// and derived from the immutable history — a hold doesn't break the run,
// a bust resets it, and the same history always yields the same number,
// so it can never disagree with the board on a refresh. Presentation
// only: it feeds no rule, score or settlement.
// The seat's newest RESOLVED entry in the authoritative history. A parked
// (`pending`) entry is the answer still owed for a deferred reveal, so it
// is not an outcome yet — skipping it is what lets "what just happened to
// this seat?" be answered from the same immutable history a poll
// re-delivers, and every re-delivery gives the same answer. Read-only: it
// feeds presentation only, never a rule, score or state transition.
function lastResolvedActionFor(actions, seat) {
  const list = Array.isArray(actions) ? actions : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const a = list[i];
    if (a && a.seat === seat && a.action && a.action !== "pending") return a;
  }
  return null;
}

// Identity of a peek RESULT, used to voice the reveal exactly once. A peek
// is identified by WHERE it was spent as well as which tile it looked at:
// the same tile index recurs on later rows, and a rematch restarts at row
// 0, so deduping on the tile alone would either swallow a real cue or
// replay an old one. Read-only.
const peekIdOf = (peek) =>
  peek
    ? `${peek.round ?? ""}:${peek.path ?? ""}:${peek.tile ?? ""}:${peek.at ?? ""}`
    : null;

// The seat's newest PEEK RESULT. A peek is published with its answer (unlike
// the opponent's, which the server scrubs), so a reveal is readable from the
// immutable history alone. ONE definition is shared by the card and by the
// voice baseline below, so the two can never disagree about WHICH peek the
// seat is looking at.
function lastPeekFor(actions, seat) {
  if (!Array.isArray(actions)) return null;
  for (let i = actions.length - 1; i >= 0; i -= 1) {
    const a = actions[i];
    if (a && a.action === "peek" && a.seat === seat && a.peekResult) return a;
  }
  return null;
}

function safeRunFor(actions, seat) {
  if (!Array.isArray(actions)) return 0;
  let run = 0;
  for (const a of actions) {
    if (!a || a.seat !== seat) continue;
    if (a.action === "hold") continue;
    if (a.safe === false) {
      run = 0;
      continue;
    }
    if (a.safe === true) run += 1;
  }
  return run;
}

// The race in one glance: the amber segment is what the seat has BANKED
// (locked, bust-proof), the tinted segment is the at-risk run stacked on
// top of it — both measured against the 1,000-banked win target, so a
// bank visibly moves width out of the tinted segment and into the amber
// one. Width is a plain CSS transition (never a looping animation), and
// the shared prefers-reduced-motion rule zeroes it, so the meter simply
// steps to its new shape with motion off.
function ScoreProgress({
  banked,
  unbanked,
  tone = "cyan",
  muted = false,
  reached = false,
}) {
  const bankedPct = Math.max(
    0,
    Math.min(100, ((Number(banked) || 0) / WIN_BANKED_SCORE) * 100),
  );
  const riskPct = Math.max(
    0,
    Math.min(100 - bankedPct, ((Number(unbanked) || 0) / WIN_BANKED_SCORE) * 100),
  );
  return (
    <div className={muted ? "opacity-70" : undefined}>
      {/* The row the 1,000-banked target lands on takes ONE 180ms cue — the
          key IS the crossing, so it can only play on the change (a poll or
          socket re-push carrying the same banked total keeps the same key)
          — and then holds a static amber ring. No pulse, no loop: the
          state stays readable with motion off. */}
      <div
        key={reached ? "reached" : "racing"}
        className={`mt-1.5 flex h-1.5 w-full overflow-hidden rounded-full bg-black/40 transition-colors ${
          reached ? "animate-state-in ring-1 ring-amber-300/70" : ""
        }`}
      >
        <div
          className="h-full bg-amber-400 transition-all duration-300"
          style={{ width: `${bankedPct}%` }}
        />
        <div
          className={`h-full transition-all duration-300 ${
            tone === "rose" ? "bg-rose-400/80" : "bg-cyan-400/80"
          }`}
          style={{ width: `${riskPct}%` }}
        />
      </div>
      <p className="mt-0.5 text-[9px] font-semibold uppercase tracking-wide text-white/40">
        {Math.round(bankedPct)}% banked
      </p>
    </div>
  );
}

// Did this duel end by resignation? Settlement records it in the PUBLISHED
// action history — a resignation is appended as a `resign` entry, and every
// other finish is the 1,000-banked target. Read-only: it only picks the copy
// on the result screen and can never change the outcome the server settled.
const wasResigned = (actions) =>
  (Array.isArray(actions) ? actions : []).some(
    (a) => a === "resign" || (a && a.action === "resign"),
  );

// The deciding context, in the game's OWN language: where each seat stopped
// against the 1,000-banked target, drawn with the identical meter the player
// watched all match (amber = locked, tinted = still carried). Its whole job
// is to let the result explain itself — the winner's locked run crossed the
// target, or nobody did because the duel ended by resignation. Static: the
// shared result panel sequences its own entrance, so this never competes
// with it, and it reads with motion off.
function FinalRaceReadout({
  myName,
  oppName,
  myBanked,
  oppBanked,
  myUnbanked,
  oppUnbanked,
  winner, // "you" | "opp" | "draw"
  note, // one short line of deciding context
}) {
  const rows = [
    {
      key: "you",
      name: myName,
      banked: myBanked,
      unbanked: myUnbanked,
      mine: true,
      tone: "cyan",
    },
    {
      key: "opp",
      name: oppName,
      banked: oppBanked,
      unbanked: oppUnbanked,
      mine: false,
      tone: "rose",
    },
  ];
  return (
    <div
      data-testid="lane-runner-final-race"
      className="rounded-xl border border-white/10 bg-black/25 px-3 py-2.5 text-left"
    >
      <p className="text-[9px] font-bold uppercase tracking-[0.18em] text-white/45">
        Final race · first to {WIN_BANKED_SCORE.toLocaleString()} banked
      </p>
      {rows.map((r) => {
        const muted = winner !== "draw" && winner !== r.key;
        const reached = Number(r.banked) >= WIN_BANKED_SCORE;
        return (
          <div key={r.key} className={`mt-1.5 ${muted ? "opacity-70" : ""}`}>
            <div className="flex items-baseline justify-between gap-3">
              <span
                className={`truncate text-[11px] font-bold ${
                  r.mine ? "text-cyan-100" : "text-rose-100/90"
                }`}
              >
                {r.name}
              </span>
              <span className="shrink-0 text-[11px] font-black tabular-nums text-white/85">
                {reached && (
                  <IconLock
                    size={10}
                    className="mr-0.5 inline-block text-amber-300"
                    aria-hidden="true"
                  />
                )}
                {Number(r.banked).toLocaleString()} banked
              </span>
            </div>
            <ScoreProgress
              banked={r.banked}
              unbanked={r.unbanked}
              tone={r.tone}
              muted={muted}
              reached={reached}
            />
          </div>
        );
      })}
      {note && (
        <p className="mt-2 text-[10px] leading-snug text-white/50">{note}</p>
      )}
    </div>
  );
}

// The tower grid: 8 lanes, each rendered with the tiles of the path
// that was actually taken (or the currently selected path on the
// live lane). Points per lane replace the old multiplier readout.
function DuelTower({
  label,
  tone,
  lane,
  held,
  isActiveClimber,
  isViewerTurn,
  clickable,
  selectedPath,
  flagMode,
  peekMode,
  myPeeks,
  pathByLane,
  pickedTileByLane,
  bustByLane,
  oppBustByLane,
  pendingTile,
  confirmTile,
  intelPathByLane,
  intelPickedByLane,
  deductions,
  tower,
  difficulty,
  finished,
  onPick,
}) {
  const rowsTopFirst = [...Array.from({ length: MAX_LANES }, (_, i) => i)].reverse();
  // Reduced motion: every framer-motion movement below is gated on this.
  // The board keeps ALL of its information without moving — the live row's
  // cyan/rose border + wash, the bust tile's red fill and ✕ (with what it
  // cost), the emerald confirm ring+glow, the ✓/●/◉/⚑ glyphs and every
  // aria-label are plain state, not animation — so nothing here is a
  // "motion-only" signal that turning motion off would erase.
  const shouldReduce = useReducedMotion();
  const isMine = tone === "cyan";
  const chip = isMine
    ? "border-cyan-300/40 bg-cyan-300/15 text-cyan-100"
    : "border-rose-300/40 bg-rose-500/15 text-rose-100";

  // The tower is SHARED: the intel props carry the OTHER player's
  // resolved picks (path + tile per row), drawn on this board as
  // deduction markers — every safe pick narrows the same layout.
  const intelLabel = isMine ? "Opp" : "You";

  const pointsFor = (laneIdx, pathKey) =>
    pointsForSafePick(laneIdx, pathKey, difficulty);

  // Keep this seat's LIVE row in view. On a bounded-height board (the
  // creator portrait shell) or a short/mobile viewport the current lane
  // can sit below the fold, which would hide the only tiles the player
  // can actually pick. `block: "nearest"` only scrolls as far as needed.
  // After the first paint the board GLIDES to the new row instead of
  // snapping, so the climb is one continuous movement — except when the
  // player has asked for reduced motion, where it stays instant.
  const currentRowRef = useRef(null);
  const didPlaceBoardRef = useRef(false);
  useEffect(() => {
    const row = currentRowRef.current;
    if (!row?.scrollIntoView) return;
    const reduceMotion =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
    row.scrollIntoView({
      block: "nearest",
      behavior: didPlaceBoardRef.current && !reduceMotion ? "smooth" : "auto",
    });
    didPlaceBoardRef.current = true;
  }, [lane]);

  return (
    <div className="flex-1 flex flex-col rounded-2xl border border-white/10 bg-slate-950/80 p-3 min-h-0">
      <div className="shrink-0 mb-2 flex items-center justify-between gap-2">
        <span
          className={`rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider ${chip}`}
        >
          {label}
        </span>
        <span className="shrink-0 rounded-full bg-black/40 px-2.5 py-1 text-xs font-black text-white">
          {held
            ? `BANKED L${lane}`
            : lane >= MAX_LANES
              ? "TOP!"
              : `Level ${Math.min(lane + 1, MAX_LANES)}`}
        </span>
      </div>

      {/* The board scrolls instead of crushing the rows: each tile keeps
          a real, tappable size (48px min, 56px on desktop) and the
          whole visible tile IS the button — no overlay eats the hit
          area. Rows have a min height so the 8 lanes can never shrink
          to unclickable slivers on short/mobile viewports. */}
      <div className="flex-1 flex flex-col gap-2 min-h-0 overflow-y-auto overscroll-contain pr-1">
        {rowsTopFirst.map((laneIdx) => {
          const isCurrent = laneIdx === lane;
          const isCompleted = laneIdx < lane;
          const isBanked = held && isCurrent;
          // A bust does NOT move the seat, so its row keeps the marker
          // until a safe pick clears the row.
          const myBust = bustByLane?.[laneIdx];
          const oppBust = oppBustByLane?.[laneIdx];
          // How much of the at-risk run this row's bust destroyed (0 when
          // there was nothing unbanked to lose).
          const bustLoss = Number(myBust?.lost) || 0;

          // Which path this lane shows: the path actually taken on
          // completed lanes, the selected path on the live lane, and
          // a neutral "balanced" for unknown/future lanes.
          const lanePath = isCompleted
            ? pathByLane[laneIdx] || "balanced"
            : isCurrent
              ? selectedPath || "balanced"
              : "balanced";
          const pathCfg = RISK_PATHS[lanePath] || RISK_PATHS.balanced;
          const tiles = pathCfg.tiles;

          const pickedTile = pickedTileByLane[laneIdx];
          const intelPath = intelPathByLane?.[laneIdx];
          const intelTile = intelPickedByLane?.[laneIdx];
          // Live deduction for the displayed path on this row: how
          // many bad-tile candidates remain, and whether the bad tile
          // is fully known (flag reveal or single-candidate solve).
          const ded = deductions?.[laneIdx]?.[lanePath];
          const knownBadTile =
            ded && ded.solved && ded.badTile != null ? ded.badTile : null;
          // Other paths on this row that are already solved — public
          // knowledge, since the tower + deduction are shared.
          const solvedOthers = deductions?.[laneIdx]
            ? Object.entries(deductions[laneIdx]).filter(
                ([p, d]) => p !== lanePath && d.solved && d.badTile != null,
              )
            : [];
          // Finished: reveal the bad tile of the path that was taken.
          const takenPath = pathByLane[laneIdx] || "balanced";
          const badTile =
            finished && tower && tower[laneIdx]
              ? Number(tower[laneIdx][takenPath])
              : null;

          return (
            <motion.div
              key={laneIdx}
              ref={isCurrent ? currentRowRef : undefined}
              // One-shot arrival for the row that just became live; every
              // other row is completely still. `transition-colors` lets
              // the row wash (future → live → completed) fade between
              // states instead of snapping, which is the continuity cue
              // the tile gradients (not interpolable) can't give.
              // With reduced motion the row simply IS live: the rise + glow
              // sweep are dropped, and the border/wash below (which transitions
              // instantly under the global rule) still says which row is in
              // play. That is the information; the sweep was decoration.
              animate={isCurrent && !shouldReduce ? ROW_LIVE_ONESHOT : undefined}
              transition={
                isCurrent && !shouldReduce ? ROW_LIVE_TRANSITION : undefined
              }
              className={`relative flex-1 flex flex-col min-h-[84px] sm:min-h-[92px] rounded-lg border p-1.5 transition-colors duration-300 ${
                isBanked
                  ? "border-amber-300/60 bg-amber-400/10"
                  : isCurrent
                    ? isMine
                      ? "border-cyan-300/65 bg-cyan-400/10"
                      : "border-rose-300/65 bg-rose-500/10"
                    : isCompleted
                      ? "border-emerald-400/35 bg-emerald-500/10"
                      : "border-white/10 bg-black/20"
              }`}
            >
              <div className="shrink-0 mb-1.5 flex items-center justify-between text-[10px]">
                <span className="inline-flex items-center gap-1">
                  <span className="font-semibold text-white/70">
                    Level {laneIdx + 1}
                  </span>
                  {myBust && (
                    <span
                      className="rounded bg-red-500/25 px-1 py-0.5 text-[9px] font-bold uppercase text-red-100"
                      title="Red tile — your unbanked run was lost, your banked points are safe"
                    >
                      {bustLoss > 0
                        ? `Bust · −${bustLoss.toLocaleString()} unbanked`
                        : "Bust · no unbanked lost"}
                    </span>
                  )}
                  {oppBust && (
                    <span
                      data-testid="lane-runner-opp-bust"
                      className="rounded bg-rose-500/25 px-1 py-0.5 text-[9px] font-bold uppercase text-rose-100"
                      title="Opponent hit the bad tile — their unbanked run was cleared, their banked points are safe"
                    >
                      {isMine ? "Opp" : "You"} busted
                      {Number(oppBust.lost) > 0 && (
                        <b className="ml-1 tabular-nums">
                          −{Number(oppBust.lost).toLocaleString()}
                        </b>
                      )}
                    </span>
                  )}
                </span>
                <span className="inline-flex items-center gap-1">
                  {isCompleted && (
                    <span
                      className={`rounded px-1 py-0.5 text-[9px] font-bold uppercase ${PATH_STYLE[lanePath].chip}`}
                    >
                      {pathCfg.label}
                    </span>
                  )}
                  {/* Live candidate count for the displayed path —
                      how many tiles could still be the bad one. */}
                  {ded && (ded.solved || ded.candidates < pathCfg.tiles) && (
                    <span
                      className={`rounded-full px-1.5 py-0.5 text-[9px] font-bold ${
                        ded.solved
                          ? "bg-emerald-500/20 text-emerald-200"
                          : ded.candidates <= 2
                            ? "bg-amber-400/20 text-amber-100"
                            : "bg-black/40 text-white/70"
                      }`}
                    >
                      {ded.solved ? "solved" : `${ded.candidates} left`}
                    </span>
                  )}
                  <span
                    className={`rounded-full px-1.5 py-0.5 font-bold ${
                      isBanked
                        ? "bg-amber-400/25 text-amber-100"
                        : isCompleted
                          ? "bg-emerald-500/20 text-emerald-100"
                          : "bg-black/40 text-cyan-100"
                    }`}
                  >
                    {isBanked ? (
                      <span className="inline-flex items-center gap-0.5">
                        <IconLock size={9} /> +{pointsFor(laneIdx, lanePath)} pts
                      </span>
                    ) : (
                      `+${pointsFor(laneIdx, lanePath)} pts`
                    )}
                  </span>
                </span>
              </div>

              {/* Intel badge: the other player survived a DIFFERENT
                  path on this row — their pick is still a deduction
                  (that tile is safe on that path). */}
              {intelTile !== undefined && intelPath !== lanePath && (
                <div className="mb-1 flex justify-end">
                  <span
                    data-testid="lane-runner-intel"
                    className="rounded border border-rose-300/30 bg-rose-500/10 px-1 py-0.5 text-[9px] font-semibold text-rose-100/80"
                  >
                    {intelLabel}: {RISK_PATHS[intelPath]?.label ?? "?"} tile{" "}
                    {intelTile + 1} ✓
                  </span>
                </div>
              )}

              {/* Solved-elsewhere badge: another path on this row is
                  already deduced — its bad tile is public knowledge. */}
              {solvedOthers.map(([p, d]) => (
                <div key={p} className="mb-1 flex justify-end">
                  <span className="rounded border border-rose-300/40 bg-rose-500/10 px-1 py-0.5 text-[9px] font-semibold text-rose-200/90">
                    {RISK_PATHS[p]?.label ?? "?"} solved: @ {d.badTile + 1} ✕
                  </span>
                </div>
              ))}

              <div
                className="grid gap-2 min-h-0"
                style={{
                  gridTemplateColumns: `repeat(${tiles}, minmax(0, 1fr))`,
                }}
              >
                {Array.from({ length: tiles }, (_, tileIdx) => {
                  const tileIsSelectable =
                    clickable && isCurrent && isActiveClimber && isViewerTurn;
                  // Transient, viewer-only feedback states, both keyed to
                  // this exact row + tile: the tap that is still in
                  // flight, and the brief confirmation the server
                  // earned. Neither is derived from polling.
                  const tileIsPending =
                    pendingTile?.lane === laneIdx &&
                    pendingTile?.tile === tileIdx;
                  const tileIsConfirming =
                    confirmTile?.lane === laneIdx &&
                    confirmTile?.tile === tileIdx;
                  const tileIsPicked = pickedTile === tileIdx;
                  const tileIsBad = finished && badTile === tileIdx;
                  const tileIsRevealedBad = knownBadTile === tileIdx;
                  const tileIsSafePick = isCompleted && pickedTile === tileIdx;
                  // The other player survived this tile on the shared
                  // tower (same path, same row) — a live deduction.
                  const tileIsIntel =
                    intelTile === tileIdx && intelPath === lanePath;
                  // The viewer's PRIVATE peek on this lane+path+ tile.
                  const myPeek = myPeeks?.[laneIdx];
                  const tilePeeked =
                    myPeek &&
                    myPeek.path === lanePath &&
                    myPeek.tile === tileIdx;
                  // The viewer's OWN bust: they saw the bad tile, so mark
                  // it — clicking red must never look like it did nothing.
                  const tileIsMyBust =
                    Boolean(myBust) &&
                    myBust.path === lanePath &&
                    myBust.tile === tileIdx;
                  // A tile the viewer already busted on this row is
                  // KNOWN BAD — re-picking it can only bust again, so it
                  // is not selectable in pick/peek mode. (It also means a
                  // rapid double-tap on a red tile resolves exactly
                  // once.) FLAG mode keeps it selectable: flagging the
                  // tile you just proved is the bad one is the best flag
                  // play in the game.
                  const tileCanPick =
                    tileIsSelectable && !(tileIsMyBust && !flagMode);

                  let cls = "bg-gradient-to-br from-slate-700 to-slate-900 border-white/10 text-white/60";
                  let glyph = "?";
                  if (tileIsMyBust) {
                    cls = "bg-gradient-to-br from-red-600 to-rose-900 border-red-300/70 text-white";
                    // ✕ marks the tile that was hit; the small figure is
                    // exactly what it cost (the poll-derived `lost`, so a
                    // refresh can never change the number).
                    glyph = (
                      <span className="flex flex-col items-center justify-center leading-none">
                        <span aria-hidden>✕</span>
                        {bustLoss > 0 && (
                          <span className="mt-0.5 text-[9px] font-bold opacity-90">
                            −{bustLoss.toLocaleString()}
                          </span>
                        )}
                      </span>
                    );
                  } else if (tileIsBad) {
                    cls = "bg-gradient-to-br from-rose-600 to-red-800 border-red-300/60 text-white";
                    glyph = "✕";
                  } else if (tileIsRevealedBad) {
                    cls = "bg-gradient-to-br from-rose-500 to-red-700 border-red-300/60 text-white";
                    glyph = "✕";
                  } else if (tilePeeked) {
                    // Private knowledge — only this viewer sees it.
                    cls =
                      myPeek.result === "bad"
                        ? "bg-gradient-to-br from-orange-500 to-amber-700 border-orange-300/80 text-white"
                        : "bg-gradient-to-br from-emerald-600 to-green-800 border-emerald-300/60 text-white";
                    glyph = myPeek.result === "bad" ? "✕" : "✓";
                  } else if (tileIsSafePick) {
                    cls = "bg-gradient-to-br from-emerald-500 to-green-700 border-emerald-300/70 text-white";
                    glyph = "✓";
                  } else if (tileIsPicked) {
                    cls = isMine
                      ? "bg-gradient-to-br from-cyan-400 to-blue-600 border-cyan-100/70 text-white"
                      : "bg-gradient-to-br from-rose-400 to-pink-700 border-rose-100/70 text-white";
                    glyph = "●";
                  } else if (tileIsIntel) {
                    cls = isMine
                      ? "bg-slate-800/90 border-2 border-dashed border-rose-300/70 text-rose-200"
                      : "bg-slate-800/90 border-2 border-dashed border-cyan-300/70 text-cyan-200";
                    glyph = "◉";
                  } else if (tileIsPending) {
                    // In flight: keep the row's own colour language (no
                    // grey flash) and mark that THIS tile is being sent.
                    // It is a pending look, never a success look.
                    cls =
                      PATH_STYLE[lanePath].tile +
                      " opacity-70 ring-2 ring-white/80";
                    glyph = "…";
                  } else if (tileCanPick) {
                    cls = flagMode
                      ? "bg-gradient-to-br from-orange-700 to-red-900 border-orange-300/50 text-orange-100 hover:brightness-125 cursor-pointer"
                      : peekMode
                        ? "bg-gradient-to-br from-cyan-600 to-blue-800 border-cyan-200/60 text-white hover:brightness-125 cursor-pointer"
                        : PATH_STYLE[lanePath].tile + " hover:brightness-125 cursor-pointer";
                    glyph = flagMode ? "⚑" : "?";
                  } else if (
                    isCurrent &&
                    isActiveClimber &&
                    isViewerTurn &&
                    !finished &&
                    !isBanked
                  ) {
                    // Still on the live row, just not clickable this
                    // instant (an action is in flight). Keep the row's
                    // colours — the old grey fallback here read as "my
                    // click didn't register".
                    cls = PATH_STYLE[lanePath].tile + " opacity-55";
                    glyph = flagMode ? "⚑" : "?";
                  } else if (isBanked && isCurrent) {
                    cls = "bg-gradient-to-br from-amber-600/60 to-amber-900/60 border-amber-300/40 text-amber-100/70";
                  }
                  // Success confirmation: a brief emerald ring on the
                  // tile the server just confirmed (a bust keeps its own
                  // red marker and never gets this).
                  if (tileIsConfirming && !tileIsMyBust) {
                    cls +=
                      " ring-2 ring-emerald-200/90 shadow-[0_0_14px_rgba(52,211,153,0.45)]";
                  }

                  return (
                    <motion.button
                      key={`${laneIdx}-${tileIdx}`}
                      type="button"
                      // Press/hover feedback is a scale, so it is the first
                      // thing to drop for reduced motion — the colour + ring
                      // feedback below still answers a tap.
                      whileHover={
                        tileCanPick && !shouldReduce ? { scale: 1.04 } : undefined
                      }
                      whileTap={
                        tileCanPick && !shouldReduce ? { scale: 0.96 } : undefined
                      }
                      // One-shot pop: a bust when the tile turns red, a
                      // confirm when the server just resolved it safely.
                      // Both targets are module-level constants, so a
                      // refresh that re-renders the same state does not
                      // restart either animation — and the confirm state
                      // clears on its own after ~0.5s, leaving the tile
                      // calm in its resolved look.
                      // The pop is a pure scale, so with reduced motion it is
                      // dropped and the tile lands straight on its resolved
                      // look — which is exactly what the pop was drawing
                      // attention to (red + ✕ + −N, or the emerald ring).
                      animate={
                        shouldReduce
                          ? undefined
                          : tileIsMyBust
                            ? BUST_TILE_FLASH
                            : tileIsConfirming
                              ? CONFIRM_TILE_FLASH
                              : undefined
                      }
                      transition={
                        shouldReduce
                          ? undefined
                          : tileIsMyBust
                            ? BUST_TILE_TRANSITION
                            : tileIsConfirming
                              ? CONFIRM_TILE_TRANSITION
                              : undefined
                      }
                      onClick={() => tileCanPick && onPick(tileIdx)}
                      disabled={!tileCanPick}
                      // The accessible name always states the tile's condition,
                      // never just "button". The colour is a second, redundant
                      // channel: every state also has a glyph (✕ ✓ ● ◉ ⚑ ? …)
                      // and this label, so nothing is communicated by colour
                      // alone — and a non-clickable tile still explains itself.
                      aria-label={`Level ${laneIdx + 1} tile ${tileIdx + 1}${
                        tileIsMyBust
                          ? ` — busted${
                              bustLoss > 0
                                ? `, ${bustLoss.toLocaleString()} unbanked points lost`
                                : ""
                            }, your banked points are safe`
                          : tileIsConfirming
                            ? " — safe, added to your at-risk run"
                            : tilePeeked
                              ? myPeek.result === "bad"
                                ? " — peeked: BAD tile, only you can see this"
                                : " — peeked: SAFE tile, only you can see this"
                              : tileIsBad || tileIsRevealedBad
                                ? " — the bad tile"
                                : tileIsSafePick
                                  ? " — safe, already cleared"
                                  : tileIsIntel
                                    ? ` — ${intelLabel.toLowerCase()} already cleared this tile`
                                    : tileIsPending
                                      ? " — sending"
                                      : tileIsPicked
                                        ? " — picked"
                                        : tileCanPick
                                          ? " — " +
                                            (flagMode
                                              ? "flag"
                                              : peekMode
                                                ? "peek"
                                                : "pick")
                                          : " — not available on this level"
                      }`}
                      className={`w-full min-h-[48px] min-w-[44px] touch-manipulation select-none rounded-lg border text-base font-bold leading-none transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-200 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950 sm:min-h-[56px] sm:text-lg ${cls}`}
                    >
                      {glyph}
                    </motion.button>
                  );
                })}
              </div>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}

// ── Risk-path picker ───────────────────────────────────────────────
// Shown on your turn: choose the odds (and points) for the current
// lane before picking or flagging a tile.
function PathPicker({
  lane,
  selectedPath,
  onSelect,
  flagMode,
  onToggleFlag,
  peekMode,
  onTogglePeek,
  disabled,
  flagsLeft,
  peeksLeft,
  deductions,
}) {
  const flagDisabled = disabled || flagsLeft <= 0;
  const peekDisabled = disabled || peeksLeft <= 0;
  return (
    <div className="rounded-2xl border border-white/10 bg-black/25 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-xs font-black uppercase tracking-wider text-white/70">
          Choose your odds. Level {Math.min(lane + 1, MAX_LANES)}
        </p>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onTogglePeek}
            disabled={peekDisabled}
            // A mode toggle, so its ON state is exposed as a pressed state
            // rather than only as a colour change.
            aria-pressed={peekMode}
            // `min-h` keeps the mode chips a comfortable touch target on a
            // tablet / landscape phone, where the header does not wrap and
            // they would otherwise collapse to their text height (~25px).
            // On a phone they already stretch to the wrapped title's height.
            className={`inline-flex min-h-[36px] items-center gap-1 rounded-full border px-3 py-1 text-[10px] font-black uppercase tracking-wider transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 focus-visible:ring-offset-1 focus-visible:ring-offset-slate-950 ${
              peekMode
                ? "border-cyan-300 bg-cyan-500/25 text-cyan-100"
                : peekDisabled
                  ? "border-white/10 bg-black/20 text-white/35 cursor-not-allowed"
                  : "border-white/15 bg-black/30 text-white/60 hover:text-white"
            }`}
          >
            <IconEye size={11} />
            {peekMode
              ? "Peek mode ON. Tap a tile"
              : peekDisabled
                ? "No peeks left"
                : `Peek (${peeksLeft} left)`}
          </button>
          <button
            type="button"
            onClick={onToggleFlag}
            disabled={flagDisabled}
            aria-pressed={flagMode}
            className={`inline-flex min-h-[36px] items-center gap-1 rounded-full border px-3 py-1 text-[10px] font-black uppercase tracking-wider transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-300 focus-visible:ring-offset-1 focus-visible:ring-offset-slate-950 ${
              flagMode
                ? "border-orange-300 bg-orange-500/25 text-orange-100"
                : flagDisabled
                  ? "border-white/10 bg-black/20 text-white/35 cursor-not-allowed"
                  : "border-white/15 bg-black/30 text-white/60 hover:text-white"
            }`}
          >
            <IconFlag size={11} />
            {flagMode
              ? "Flag mode ON. Tap a tile"
              : flagDisabled
                ? "No flags left"
                : `Flag mode (${flagsLeft} left)`}
          </button>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2">
        {Object.values(RISK_PATHS).map((path) => {
          const active = !flagMode && selectedPath === path.key;
          const pts = pointsForSafePick(lane, path.key, undefined);
          // Display only (never feeds a rule): rounded, because a 3-tile path
          // is 66.66666…% and the raw float overflowed the chip on a narrow
          // screen into a wall of digits.
          const odds = Math.round(((path.tiles - 1) / path.tiles) * 100);
          // How many bad-tile candidates remain on this path for the
          // current lane (safe picks, flags, and the memory rule).
          const ded = deductions?.[lane]?.[path.key];
          const candidates = ded ? ded.candidates : path.tiles;
          return (
            <button
              key={path.key}
              type="button"
              onClick={() => onSelect(path.key)}
              disabled={disabled}
              // Which odds are selected is a state, so it is exposed as a
              // pressed state — and each chip already carries its own text
              // (label, % safe, candidates left, points), so the choice is
              // never communicated by colour alone.
              aria-pressed={selectedPath === path.key}
              className={`min-h-[44px] rounded-xl border px-2 py-2 text-center transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 focus-visible:ring-offset-1 focus-visible:ring-offset-slate-950 ${
                active
                  ? PATH_STYLE[path.key].chipActive
                  : PATH_STYLE[path.key].chip
              } ${ded?.solved ? "ring-1 ring-emerald-300/60" : ""} ${
                disabled ? "opacity-50" : "hover:brightness-110"
              }`}
            >
              <p className="text-[11px] font-black uppercase">{path.label}</p>
              <p className="text-[9px] text-white/70">
                {odds}% safe ·{" "}
                {ded?.solved
                  ? "solved ✓"
                  : `${candidates} ${candidates === 1 ? "candidate" : "candidates"} left`}
              </p>
              <p className={`text-xs font-black ${PATH_STYLE[path.key].text}`}>
                +{pts} pts
              </p>
            </button>
          );
        })}
      </div>
      <p className="mt-2 text-[10px] text-white/45">
        {peekMode
          ? "PEEK = spend one of 2 private calls to learn whether a tile on this level is SAFE or BAD — only you see the answer, and you can still pick after. Perfect for converting a coin-flip Risky row into a sure climb."
          : flagMode
            ? "FLAG = call the bad tile (2 per match). Right → you claim the row + points and reveal it to BOTH players. Wrong → you bust. Save flags for safe/balanced calls the memory rule has narrowed."
            : "Both players climb the SAME tower: every safe pick either of you makes (visible on both boards) eliminates a bad-tile candidate. Bad tiles also never repeat the previous lane's position on the same path."}
      </p>
    </div>
  );
}

// ── Race pressure strip (1,000-banked target) ──────────────────────
// The win is the FIRST player to BANK WIN_BANKED_SCORE (1,000)
// points — the strip shows each player's banked progress toward the
// target, how many safe picks that implies, and the survival odds of
// pushing blind. Banking never settles the match; the race continues
// at reduced rates until someone locks 1,000.
function PressureStrip({
  myScore,
  oppScore,
  myBanked,
  oppBanked,
  myHeld,
  oppHeld,
  myRate,
  oppRate,
  difficulty,
  isBotMatch,
  oppName: oppNameProp,
}) {
  const oppName = oppNameProp || (isBotMatch ? "the bot" : "your opponent");
  // Picks needed to reach the 1,000 target from the current
  // accumulated score (you still need to BANK it once you get there).
  const myPicksToTarget = safePicksToReachScore(
    WIN_BANKED_SCORE,
    myScore,
    "balanced",
    difficulty,
  );
  const oppPicksToTarget = safePicksToReachScore(
    WIN_BANKED_SCORE,
    oppScore,
    "balanced",
    difficulty,
  );
  const survival = (n) => survivalOdds(n, RISK_PATHS.balanced.tiles);
  const ratePct = (r) => `${Math.round(r * 100)}%`;
  const pct = (banked) =>
    `${Math.min(100, Math.round((banked / WIN_BANKED_SCORE) * 100))}%`;

  // ── Both banked: the race continues at reduced rates ─────────────
  if (myHeld && oppHeld) {
    return (
      <div className="rounded-2xl border border-amber-300/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
        <p className="flex items-center gap-1.5 text-xs font-black uppercase tracking-wider text-amber-200">
          <IconFlag size={13} className="text-amber-300" />
          Both banked — the race to {WIN_BANKED_SCORE.toLocaleString()} continues
        </p>
        <p className="mt-1 text-sm">
          You're locked at{" "}
          <b className="text-white">{myBanked.toLocaleString()}</b>{" "}
          ({pct(myBanked)} of target, picks pay {ratePct(myRate)});{" "}
          {oppName} is at{" "}
          <b className="text-white">{oppBanked.toLocaleString()}</b>{" "}
          ({pct(oppBanked)}, {ratePct(oppRate)}). First to{" "}
          <b className="text-white">{WIN_BANKED_SCORE.toLocaleString()}</b> banked
          takes the pot.
        </p>
      </div>
    );
  }

  // ── I banked: I'm ahead on locked points, but the win needs 1,000 ─
  if (myHeld) {
    return (
      <div className="rounded-2xl border border-amber-300/40 bg-amber-500/10 px-4 py-3">
        <p className="flex items-center gap-1.5 text-xs font-black uppercase tracking-wider text-amber-200">
          <IconFlag size={13} className="text-amber-300" />
          You banked {myBanked.toLocaleString()}
          <span className="font-normal normal-case text-amber-200/70">
            ({pct(myBanked)} of {WIN_BANKED_SCORE.toLocaleString()} — picks now pay{" "}
            {ratePct(myRate)})
          </span>
        </p>
        <p className="mt-1 text-sm text-amber-100">
          You need <b className="text-white">{myPicksToTarget}</b> more balanced
          safe pick{myPicksToTarget === 1 ? "" : "s"} to reach{" "}
          <b className="text-white">{WIN_BANKED_SCORE.toLocaleString()}</b> and bank
          the win (only ~
          <b className="text-white">{(survival(myPicksToTarget) * 100).toFixed(0)}%</b>{" "}
          survival pushing blind). {oppName} is at{" "}
          <b className="text-white">{oppBanked.toLocaleString()}</b> banked
          ({pct(oppBanked)}).
        </p>
        {myPicksToTarget > 0 && (
          <SurvivalBar pct={survival(myPicksToTarget)} label="your survival odds" />
        )}
      </div>
    );
  }

  // ── They banked: I'm behind on locked points ─────────────────────
  if (oppHeld) {
    return (
      <div className="rounded-2xl border border-cyan-300/40 bg-cyan-500/10 px-4 py-3">
        <p className="flex items-center gap-1.5 text-xs font-black uppercase tracking-wider text-cyan-200">
          <IconFlag size={13} className="text-cyan-300" />
          {isBotMatch ? "The bot" : "Your opponent"} banked{" "}
          {oppBanked.toLocaleString()}
          <span className="font-normal normal-case text-cyan-200/70">
            ({pct(oppBanked)} of {WIN_BANKED_SCORE.toLocaleString()} — their picks
            now pay {ratePct(oppRate)})
          </span>
        </p>
        <p className="mt-1 text-sm text-cyan-100">
          You're at <b className="text-white">{myBanked.toLocaleString()}</b> banked
          ({pct(myBanked)}). You need{" "}
          <b className="text-white">{myPicksToTarget}</b> more balanced safe
          pick{myPicksToTarget === 1 ? "" : "s"} to reach{" "}
          <b className="text-white">{WIN_BANKED_SCORE.toLocaleString()}</b> and bank
          the win (only ~
          <b className="text-white">{(survival(myPicksToTarget) * 100).toFixed(0)}%</b>{" "}
          survival pushing blind). First to{" "}
          <b className="text-white">{WIN_BANKED_SCORE.toLocaleString()}</b> banked
          takes the pot.
        </p>
        {myPicksToTarget > 0 && (
          <SurvivalBar pct={survival(myPicksToTarget)} label="your survival odds" />
        )}
      </div>
    );
  }

  // ── Nobody banked yet: the live race to 1,000 ────────────────────
  return (
    <div className="rounded-2xl border border-white/10 bg-black/25 px-4 py-3 text-sm text-white/75">
      <p>
        <b className="text-white">First to bank {WIN_BANKED_SCORE.toLocaleString()}</b>{" "}
        wins — you're at <b className="text-white">{myScore.toLocaleString()}</b>{" "}
        accumulated (~{myPicksToTarget} more balanced safe picks), {oppName} at{" "}
        <b className="text-white">{oppScore.toLocaleString()}</b>. Bank to lock
        points (picks after banking pay half, stacking), but only a{" "}
        <b className="text-white">{WIN_BANKED_SCORE.toLocaleString()}</b> banked
        total takes the pot — and if you bust, only what you banked survives.
      </p>
    </div>
  );
}

// Tiny survival-odds meter — visual weight for the chicken math.
function SurvivalBar({ pct, label }) {
  const clamped = Math.max(0, Math.min(100, pct * 100));
  const tone =
    clamped >= 50 ? "bg-emerald-400" : clamped >= 25 ? "bg-amber-400" : "bg-rose-500";
  return (
    <div className="mt-2 flex items-center gap-2">
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10">
        <div
          className={`h-full rounded-full transition-all duration-500 ${tone}`}
          style={{ width: `${clamped}%` }}
        />
      </div>
      <span className="text-[10px] text-white/50">
        {clamped.toFixed(0)}% {label}
      </span>
    </div>
  );
}

export default function LaneRushDuelMatchPage({ params }) {
  const router = useRouter();
  const posthog = usePostHog();
  const { user } = useUser();
  const { socket } = useSocket();
  // The repo's reduced-motion switch (framer's own hook). Every framer
  // movement in this view is gated on it; the shared CSS cues are already
  // collapsed by the global `prefers-reduced-motion` rule in globals.css.
  const shouldReduce = useReducedMotion();

  // ── Dynamic-route params arrive async (Promise) on Next.js 15+/16. ──
  // BUG-FIX ("multiplayer flow never loads"): the previous code read
  // `params?.matchId` synchronously — on Next.js 16 `params` is a
  // Promise, so `matchId` was always `NaN`, every /status poll and
  // socket join silently no-oped, and the match view stayed pinned on
  // the loading screen for BOTH players (host waiting, joiner waiting,
  // ready banner, turns — the whole flow). Mirror the blackjack /
  // mines match views: unwrap the Promise with React's `use()`, keep
  // `matchId` as `null` until it resolves, and guard every consumer
  // against the invalid-id window.
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
  const matchId = Number.isFinite(numericMatchId) ? numericMatchId : null;

  const [match, setMatch] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [acting, setActing] = useState(false);
  const [resigning, setResigning] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  // The countdown clock starts as `null` (not `Date.now()`) so the
  // server-rendered markup can't disagree with the first client render.
  const [now, setNow] = useState(null);
  const [selectedPath, setSelectedPath] = useState("balanced");
  const [flagMode, setFlagMode] = useState(false);
  const [peekMode, setPeekMode] = useState(false);
  const [lastPeek, setLastPeek] = useState(null); // { path, tile, result }
  // Consecutive failed reconciles — surfaced as a "Reconnecting…" chip so
  // an API failure can never leave the duel silently frozen.
  const [syncFailures, setSyncFailures] = useState(0);

  // In-flight action guard (declared before doAction so the callback can
  // read it synchronously — `acting` state lags a frame behind).
  const actingRef = useRef(false);
  const actionIdRef = useRef(0);
  // Status-poll sequencing: only the NEWEST reconcile may write state.
  // Without this, a slow earlier response could land after a newer one
  // (socket push + 5s poll + post-action refresh overlap) and roll the
  // board back — which is exactly what made player/AI actions look like
  // they were "not processed together".
  const syncSeqRef = useRef(0);
  const syncAbortRef = useRef(null);
  const mountedRef = useRef(true);
  // Which server state the bot wake-up has already been fired for.
  const botTurnFiredRef = useRef(null);
  // Bust feedback (buzz + banner animation) is keyed on the bust's own
  // identity, never on the poll: `lastBustSeenRef` is the bust we have
  // already reacted to, and `loadBustKeysRef` holds the busts that were
  // ALREADY in the history when this page loaded. Between them, no
  // poll, socket push, re-render or page refresh can replay the
  // feedback — only a bust that happened while we were watching fires
  // it, exactly once.
  const lastBustSeenRef = useRef(null);
  const loadBustKeysRef = useRef(null);
  // Tile interaction feedback (viewer-only, transient):
  //   pending — the tap that is in flight, so the player sees their
  //             press register the instant it happens;
  //   confirm — a short pop/glow on the tile the SERVER just confirmed.
  // Both are client-local and short-lived, so a poll/socket refresh can
  // never trigger, extend or replay them.
  const [pendingTile, setPendingTile] = useState(null); // { lane, tile }
  const [confirmTile, setConfirmTile] = useState(null); // { lane, tile }
  // Banking has no tile to mark, so it gets its own pair: an in-flight
  // flag (the button is the only control) and a short confirmation that
  // spells out the move from at risk → protected.
  const [bankPending, setBankPending] = useState(false);
  const [bankConfirm, setBankConfirm] = useState(null); // { key, moved, bankedTotal }
  // Opponent feedback: a short, one-shot line describing the opponent's
  // newest resolved action and nothing else. Client-local and short-lived,
  // so a poll/socket snapshot can neither trigger nor extend it (see the
  // opponent-action effect below).
  const [oppNotice, setOppNotice] = useState(null); // { key, tone, text }
  // Both confirmations are short timers, not derived-from-poll state.
  const confirmTimerRef = useRef(null);
  const bankTimerRef = useRef(null);
  const oppNoticeTimerRef = useRef(null);
  // Opponent-notice dedup: `oppSeenKeyRef` holds the action we have already
  // announced, and `oppPrimedRef` is set by the FIRST authoritative snapshot
  // of this mount — so a reload never announces history that was already on
  // screen when the view mounted.
  const oppSeenKeyRef = useRef(null);
  const oppPrimedRef = useRef(false);
  // Peek-reveal dedup: the identity of the peek result we have already
  // voiced. Reset with the duel (see the matchId effect), so a rematch
  // re-arms the chime instead of swallowing the new match's first peek.
  const lastPeekRef = useRef(null);
  // The viewer's OWN resolved-action voice (safe pick / bank). `mySeenKeyRef`
  // holds the action already voiced, and `myPrimedRef` is set by the FIRST
  // authoritative snapshot of this mounting, so a reload can never re-sound
  // history that was already on screen (and already heard) when it loaded.
  const mySeenKeyRef = useRef(null);
  const myPrimedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Drop any in-flight reconcile when the duel view unmounts.
      syncAbortRef.current?.abort();
      syncAbortRef.current = null;
      // …and cancel the pending tile/bank/opponent feedback timers, so a
      // remount can never leave a stray timer (or a stale flipped state)
      // behind.
      if (confirmTimerRef.current) {
        clearTimeout(confirmTimerRef.current);
        confirmTimerRef.current = null;
      }
      if (oppNoticeTimerRef.current) {
        clearTimeout(oppNoticeTimerRef.current);
        oppNoticeTimerRef.current = null;
      }
      if (bankTimerRef.current) {
        clearTimeout(bankTimerRef.current);
        bankTimerRef.current = null;
      }
    };
  }, []);

  // A new matchId is a NEW duel. Drop every per-match client artifact
  // (stale board, in-flight reconcile, bot wake-up key, selected path and
  // modes) so nothing from a previous duel can leak in — a stale board
  // would otherwise send an action stamped with the WRONG row. Declared
  // BEFORE the poll effect so the reset always precedes the first fetch.
  useEffect(() => {
    setMatch(null);
    setLoading(true);
    setError(null);
    setSyncFailures(0);
    setLastPeek(null);
    lastPeekRef.current = null;
    setSelectedPath("balanced");
    setFlagMode(false);
    setPeekMode(false);
    setActing(false);
    actingRef.current = false;
    botTurnFiredRef.current = null;
    // Bust feedback belongs to the OLD duel — the new match starts
    // with a clean feedback baseline (its own first snapshot).
    lastBustSeenRef.current = null;
    loadBustKeysRef.current = null;
    // Tile feedback belongs to the OLD duel too: drop any in-flight tile
    // marker and cancel a pending confirmation timer.
    if (confirmTimerRef.current) {
      clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = null;
    }
    setPendingTile(null);
    setConfirmTile(null);
    if (oppNoticeTimerRef.current) {
      clearTimeout(oppNoticeTimerRef.current);
      oppNoticeTimerRef.current = null;
    }
    // Opponent feedback belongs to the OLD duel: drop the notice and re-arm
    // the announce baseline for the new match's first snapshot.
    setOppNotice(null);
    oppPrimedRef.current = false;
    oppSeenKeyRef.current = null;
    // …the viewer's own cue baseline too, so a rematch re-arms their safe /
    // bank cues instead of swallowing the new duel's first resolution.
    mySeenKeyRef.current = null;
    myPrimedRef.current = false;
    if (bankTimerRef.current) {
      clearTimeout(bankTimerRef.current);
      bankTimerRef.current = null;
    }
    setBankPending(false);
    setBankConfirm(null);
    syncSeqRef.current += 1;
    syncAbortRef.current?.abort();
    syncAbortRef.current = null;
  }, [matchId]);

  // ── Status polling (5s safety net) + socket live updates ─────────
  const fetchStatus = useCallback(async () => {
    if (!matchId) {
      // Invalid/undecided matchId — never pin the page on "Loading…".
      // The `!loading && !match` branch renders the not-found panel.
      if (mountedRef.current) setLoading(false);
      return null;
    }
    // Supersede any older in-flight reconcile (out-of-order responses
    // are the classic stale-state bug in a polled duel).
    const seq = (syncSeqRef.current += 1);
    syncAbortRef.current?.abort();
    const controller = new AbortController();
    syncAbortRef.current = controller;
    try {
      const res = await fetch(`/api/lane-rush-duel/match/${matchId}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      const json = await res.json();
      if (!mountedRef.current || seq !== syncSeqRef.current) return null;
      if (!res.ok || !json.success) {
        setError(json.error || "Failed to load match");
        setSyncFailures((n) => n + 1);
        return null;
      }
      setMatch(json.data.match);
      if (loadBustKeysRef.current === null) {
        // First snapshot of this mount: a bust already in the history
        // happened BEFORE we were watching, so it is a baseline — never
        // a "you just busted" event.
        const first = json.data.match;
        loadBustKeysRef.current = new Set(
          [
            bustKeyOf(latestBustFor(first?.actions, "player1")),
            bustKeyOf(latestBustFor(first?.actions, "player2")),
          ].filter(Boolean),
        );
        // …and the same rule for the PEEK reveal: a peek the history
        // already carried was on screen before this mount, so a reload or
        // a reconnect must not re-voice it. The seat is taken from THIS
        // payload (the component's `mySeat` is still null on the first
        // fetch), and the identity is the shared one the card uses.
        const firstSeat = first?.viewerIsPlayer1 ? "player1" : "player2";
        lastPeekRef.current = peekIdOf(lastPeekFor(first?.actions, firstSeat));
      }
      setError(null);
      setSyncFailures(0);
      return json.data.match;
    } catch (e) {
      // Aborted by a newer reconcile / unmount — not a failure.
      if (e?.name === "AbortError") return null;
      if (!mountedRef.current || seq !== syncSeqRef.current) return null;
      setSyncFailures((n) => n + 1);
      return null;
    } finally {
      if (mountedRef.current && seq === syncSeqRef.current) setLoading(false);
    }
  }, [matchId]);

  useEffect(() => {
    fetchStatus();
    // Socket room (LANE_RUSH_DUEL_MATCH_UPDATED) pushes opponent updates
    // instantly; this HTTP poll is a reconcile/safety net. Round pacing
    // comes from server state + the local 250ms clock, never from the poll
    // rate, so 5s is safe and keeps match-time DB reads minimal.
    const interval = setInterval(fetchStatus, 5000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  useEffect(() => {
    if (!socket || !matchId) return;
    socket.emit("join_room", { roomId: laneRushDuelMatchRoom(matchId) });
    const refresh = () => fetchStatus();
    socket.on(LANE_RUSH_DUEL_MATCH_UPDATED, refresh);
    return () => {
      socket.emit("leave_room", { roomId: laneRushDuelMatchRoom(matchId) });
      socket.off(LANE_RUSH_DUEL_MATCH_UPDATED, refresh);
    };
  }, [socket, matchId, fetchStatus]);

  // Local clock for the countdown display.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);

  const finished = match?.status === "finished";
  const cancelled = match?.status === "cancelled";

  // ── Test vs Bot: auto-trigger the bot's turn ─────────────────────
  const isBotMatch = match?.player2Id === "AI_BOT";
  const [botRetry, setBotRetry] = useState(0);

  useEffect(() => {
    const isActive =
      match?.status === "active" ||
      match?.status === "p1_turn" ||
      match?.status === "p2_turn";
    if (!isBotMatch || !matchId || !isActive) {
      botTurnFiredRef.current = null;
      return;
    }

    // Key each bot turn by the server state, not by the local clock. This
    // prevents duplicate requests while still retriggering after the human
    // answers and the action history advances.
    const turnKey = [
      matchId,
      Array.isArray(match.actions) ? match.actions.length : 0,
      match.p2Lane,
      match.p2Held,
    ].join(":");
    if (botTurnFiredRef.current === turnKey) return;

    const timer = setTimeout(async () => {
      if (botTurnFiredRef.current === turnKey) return;
      botTurnFiredRef.current = turnKey;
      // The server dedupes on this id, so a retried/duplicated wake-up
      // can never hand the bot an extra action.
      const actionId = `${matchId}:bot:${turnKey}`;
      try {
        const response = await fetch(
          `/api/lane-rush-duel/match/${matchId}/ai-turn`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ actionId }),
          },
        );
        const json = await response.json();
        if (!mountedRef.current) return;
        if (json?.success) {
          socket?.emit("room_event", {
            roomId: laneRushDuelMatchRoom(matchId),
            event: LANE_RUSH_DUEL_MATCH_UPDATED,
          });
          await fetchStatus();
        } else {
          botTurnFiredRef.current = null;
          // Resync BEFORE retrying: if the duel just ended (or the board
          // moved on), the next effect pass sees the real state and bails
          // — a finished duel never keeps a bot timer alive. The server
          // also re-checks the match state inside its transaction, so a
          // stale callback can never mutate a finished match.
          await fetchStatus();
          if (!mountedRef.current) return;
          setBotRetry((value) => value + 1);
        }
      } catch {
        if (!mountedRef.current) return;
        botTurnFiredRef.current = null;
        setBotRetry((value) => value + 1);
      }
    }, 1500);

    return () => clearTimeout(timer);
  }, [
    botRetry,
    isBotMatch,
    matchId,
    match?.status,
    match?.p2Lane,
    match?.p2Held,
    match?.actions?.length,
    socket,
    fetchStatus,
  ]);

  // ── Derived state ────────────────────────────────────────────────
  const isPlayer1 = match?.viewerIsPlayer1;
  const mySeat = isPlayer1 ? "player1" : "player2";
  const oppSeat = isPlayer1 ? "player2" : "player1";

  // Seat identity — real username + official Grynd icon + equipped name
  // color, resolved server-side (getSeatIdentity). Null for the bot
  // seat; the labels fall back to "You" / "GRYND AI" / "Opponent".
  const mySeatIdentity = isPlayer1
    ? {
        name: match?.player1Name || null,
        iconKey: match?.player1IconKey || null,
        nameColor: match?.player1NameColor || null,
        profileFrame: match?.player1ProfileFrame || null,
      }
    : {
        name: match?.player2Name || null,
        iconKey: match?.player2IconKey || null,
        nameColor: match?.player2NameColor || null,
        profileFrame: match?.player2ProfileFrame || null,
      };
  const oppSeatIdentity = isBotMatch
    ? { name: null, iconKey: null, nameColor: null, profileFrame: null }
    : isPlayer1
      ? {
          name: match?.player2Name || null,
          iconKey: match?.player2IconKey || null,
          nameColor: match?.player2NameColor || null,
          profileFrame: match?.player2ProfileFrame || null,
        }
      : {
          name: match?.player1Name || null,
          iconKey: match?.player1IconKey || null,
          nameColor: match?.player1NameColor || null,
          profileFrame: match?.player1ProfileFrame || null,
        };
  const myDisplayName = mySeatIdentity.name || "You";
  const oppDisplayName =
    oppSeatIdentity.name || (isBotMatch ? "GRYND AI" : "Opponent");
  const mySeatIcon = mySeatIdentity.iconKey;
  const oppSeatIcon = oppSeatIdentity.iconKey;
  const mySeatProfileFrame = mySeatIdentity.profileFrame;
  const oppSeatProfileFrame = oppSeatIdentity.profileFrame;
  const myNameColor = mySeatIdentity.nameColor;
  const oppNameColor = oppSeatIdentity.nameColor;

  const myLane = Number(match?.myLane) || 0;
  const oppLane = Number(match?.oppLane) || 0;
  const myHeld = Boolean(match?.myHeld);
  const oppHeld = Boolean(match?.oppHeld);
  const myScore = Number(match?.myScore) || 0;
  const oppScore = Number(match?.oppScore) || 0;
  // Soft bank: locked totals, bank counts, live pick rates, and
  // climb status (busted/completed = ended; banked ≠ ended).
  const myBanked = Number(match?.myBanked) || 0;
  const oppBanked = Number(match?.oppBanked) || 0;
  // `Number(undefined) ?? 1` is NaN (nullish, not NaN, coalescing), so
  // a missing rate used to render as "NaN%" in the pressure strip.
  const myRate = Number.isFinite(Number(match?.myRate))
    ? Number(match.myRate)
    : 1;
  const oppRate = Number.isFinite(Number(match?.oppRate))
    ? Number(match.oppRate)
    : 1;
  const myEnded = Boolean(match?.myEnded);
  const oppEnded = Boolean(match?.oppEnded);

  // UNBANKED (at-risk) vs BANKED (locked, bust-proof) — the one
  // distinction the whole game turns on. Always derived, never trusted
  // to a separate field, and never negative.
  const myUnbanked = Math.max(0, myScore - myBanked);
  const oppUnbanked = Math.max(0, oppScore - oppBanked);

  // ── Opponent read-outs (presentation only) ───────────────────────
  // The opponent's newest RESOLVED action plus its stable identity, their
  // live safe run and their current level. Every value is a read-only
  // derivation of the payload / immutable history, so a poll, a socket
  // re-push or a refresh always produces the same result — and none of it
  // can steer a rule, a score or a state transition.
  const oppLastAction = useMemo(() => {
    const actions = match?.actions || [];
    for (let i = actions.length - 1; i >= 0; i -= 1) {
      const a = actions[i];
      if (a && a.seat === oppSeat && a.action && a.action !== "pending") {
        return a;
      }
    }
    return null;
  }, [match?.actions, oppSeat]);
  const oppActionKey = actionKeyOf(oppLastAction);
  const oppRun = useMemo(
    () => safeRunFor(match?.actions, oppSeat),
    [match?.actions, oppSeat],
  );
  const oppLaneLabel = Math.min(oppLane + 1, MAX_LANES);
  // The level the opponent is ACTIVELY scouting. The server publishes an
  // opponent peek as a fact (seat + level + when) with the position and
  // the answer withheld, and a peek never consumes their turn — it can only
  // ever target the row they are standing on. So while a peek is their
  // newest resolved action, and that row is still the row they are on, this
  // is the level they are working: the moment they resolve anything else it
  // stops being "active" and the card falls back to their plain level.
  // Read-only: it names a level and nothing more.
  const oppPeekRow = Number(oppLastAction?.round ?? oppLastAction?.lane);
  const oppScoutingLevel =
    oppLastAction?.action === "peek" && oppPeekRow === oppLane
      ? Math.min(oppPeekRow + 1, MAX_LANES)
      : null;

  const isMyTurn = match?.status === "active";
  const canAct = !finished && !cancelled && !acting && isMyTurn && !myEnded;

  // Path + picked tile per lane from the actions history. `round`
  // (the 0-based row) is authoritative for current matches; pre-
  // upgrade matches only have the legacy `lane` field.
  const myHistory = useMemo(() => {
    const pathByLane = {};
    const pickedByLane = {};
    const oppPath = {};
    const oppPicked = {};
    (match?.actions || []).forEach((a) => {
      if (!a || a.safe !== true) return;
      const key =
        a.round !== undefined && a.round !== null ? a.round : a.lane;
      if (a.action === "flag") {
        // Correct flags also set the row's path chip (the reveal
        // itself is handled by the deductions tracker).
        if (a.seat === mySeat) pathByLane[key] = a.path;
        else if (a.seat === oppSeat) oppPath[key] = a.path;
        return;
      }
      // pick
      if (a.seat === mySeat) {
        pathByLane[key] = a.path;
        pickedByLane[key] = a.tile;
      } else if (a.seat === oppSeat) {
        oppPath[key] = a.path;
        oppPicked[key] = a.tile;
      }
    });
    return { myPath: pathByLane, myPicked: pickedByLane, oppPath, oppPicked };
  }, [match?.actions, mySeat, oppSeat]);

  // Live deduction: how many bad-tile candidates remain per lane +
  // path, given every safe pick (either player's), correct flags, and
  // the memory rule. Same for both players — the tower is shared.
  const deductions = useMemo(
    () => computeDeductions(match?.actions || []),
    [match?.actions],
  );

  // Bust feedback: which tile the viewer red-tile'd on which row (and,
  // as a bare badge, that the opponent busted a row). A bust only
  // clears the unbanked run, so the board has to SHOW it — otherwise a
  // red tile click looks like it was ignored.
  const myBustByLane = useMemo(
    () => bustsByLaneForSeat(match?.actions, mySeat),
    [match?.actions, mySeat],
  );
  const oppBustByLane = useMemo(
    () => bustsByLaneForSeat(match?.actions, oppSeat),
    [match?.actions, oppSeat],
  );
  const myLastBust = useMemo(
    () => latestBustFor(match?.actions, mySeat),
    [match?.actions, mySeat],
  );
  // Exactly how big the run that bust destroyed was (derived from the
  // immutable history, so a refresh can never change the number).
  const myBustLoss = useMemo(
    () =>
      myLastBust ? unbankedLostOnBust(match?.actions, mySeat, myLastBust) : 0,
    [match?.actions, mySeat, myLastBust],
  );
  // Stable identity for the current bust: the banner ("key") and the
  // buzz are both driven by it, so a poll/socket refresh that
  // re-delivers the same bust can never REPLAY the feedback.
  const myBustKey = bustKeyOf(myLastBust);
  // Is the bust the viewer's CURRENT outcome, or just board history? The
  // banner and the red at-risk tone describe what JUST happened, so they
  // follow the seat's newest resolved action: banking, or a safe pick
  // resolving, retires them — and a poll re-delivering the same history
  // changes neither (same action = same answer). The row badge and the
  // tile's ✕ stay permanent: the loss is never hidden, it just stops
  // out-ranking whatever the player is doing now.
  const myLastResolvedAction = useMemo(
    () => lastResolvedActionFor(match?.actions, mySeat),
    [match?.actions, mySeat],
  );
  const myBustIsCurrent =
    Boolean(myBustKey) && bustKeyOf(myLastResolvedAction) === myBustKey;
  // Stable identity of the viewer's own newest resolved action — the same
  // key the opponent read-outs use, so the viewer's outcome cue is keyed on
  // the action itself and never on a poll re-delivery.
  const myActionKey = actionKeyOf(myLastResolvedAction);
  // …and the last peek result narrates the row it was SPENT on, not the
  // rest of the match: the answer itself is permanent (the peeked tile
  // keeps its ✓/✕ mark on the board and the deduction tracker holds it),
  // so only the card retires when the seat climbs past that row. Same rule
  // as the opponent's scouting chip, from the same published facts — a peek
  // spent on level 3 can never claim to describe level 9.
  const myPeekIsCurrent =
    Boolean(lastPeek) && Number(lastPeek.round) === Number(myLane);
  const myBustLaneLabel =
    (Number(myLastBust?.round ?? myLastBust?.lane) || 0) + 1;
  const myLaneLabel = Math.min(myLane + 1, MAX_LANES);

  // The viewer's live SAFE RUN — the consecutive-safe-pick streak the
  // unbanked points are riding on. Presentation only (see safeRunFor):
  // derived from the immutable history, so a poll/refresh can't change it.
  const myRun = useMemo(
    () => safeRunFor(match?.actions, mySeat),
    [match?.actions, mySeat],
  );

  // Flag budget: how many calls the VIEWER has left this match.
  const myFlagsUsed = (match?.actions || []).filter(
    (a) => a.seat === mySeat && a.action === "flag",
  ).length;
  const flagsLeft = Math.max(0, MAX_FLAGS - myFlagsUsed);

  // Peek budget + the viewer's own (PRIVATE) peek results — the
  // opponent's peeks arrive stripped of path/tile/result, so only
  // ours are visible here.
  const myPeeksUsed = (match?.actions || []).filter(
    (a) => a.seat === mySeat && a.action === "peek",
  ).length;
  const peeksLeft = Math.max(0, MAX_PEEKS - myPeeksUsed);
  const myPeeks = useMemo(() => {
    const map = {};
    (match?.actions || []).forEach((a) => {
      if (a && a.action === "peek" && a.seat === mySeat && a.peekResult) {
        map[a.round ?? a.lane] = {
          path: a.path,
          tile: a.tile,
          result: a.peekResult,
        };
      }
    });
    return map;
  }, [match?.actions, mySeat]);

  // Surface the most recent peek result once the status poll carries
  // it back (peeks are instant and keep our turn).
  useEffect(() => {
    const last = lastPeekFor(match?.actions, mySeat);
    if (!last) return;
    setLastPeek({
      path: last.path,
      tile: last.tile,
      round: last.round ?? last.lane,
      at: last.at,
      result: last.peekResult,
    });
  }, [match?.actions, mySeat]);

  // Bad tile per lane per path (only available after finish).
  const myTower = Array.isArray(match?.myTower) ? match.myTower : [];

  const deadlineMs = match?.roundDeadline
    ? new Date(match.roundDeadline).getTime()
    : null;
  const secondsLeft =
    deadlineMs && now ? Math.max(0, Math.ceil((deadlineMs - now) / 1000)) : null;

  // Soft bank: you can bank ANY number of times (each bank halves
  // your future pick rate), as long as your climb isn't over.
  const canHold = canAct && myScore > 0;

  const handleResign = useCallback(async () => {
    if (resigning) return;
    if (
      !window.confirm(
        "Resign this match? Your stake is forfeited and your opponent wins.",
      )
    )
      return;
    setResigning(true);
    setError(null);
    try {
      const res = await fetch(`/api/lane-rush-duel/match/${matchId}/resign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        setError(json.error || "Resign failed");
        return;
      }
      posthog?.capture("lane_rush_duel_resigned", { match_id: matchId });
      socket?.emit("room_event", {
        roomId: laneRushDuelMatchRoom(matchId),
        event: LANE_RUSH_DUEL_MATCH_UPDATED,
      });
      await fetchStatus();
    } catch {
      // Never let a network failure surface as an unhandled rejection.
      if (mountedRef.current) setError("Network error — could not resign.");
    } finally {
      if (mountedRef.current) setResigning(false);
    }
  }, [matchId, posthog, resigning, socket, fetchStatus]);

  // ── Actions ──────────────────────────────────────────────────────
  // ONE path for every player action. Each request carries:
  //   * `actionId` — unique per tap, so a network retry (or a double
  //     submit) resolves exactly once server-side instead of scoring
  //     the pick twice, and
  //   * `round` — the level the click was rendered against, so a click
  //     that arrives after the row already advanced is rejected with a
  //     "board moved on" message instead of resolving the wrong row.
  // The in-flight guard is released as soon as the request settles (no
  // artificial 600ms lockout), so a click is only ever ignored while an
  // action is genuinely still in flight.
  // Fire the one-shot success confirmation for a tile. It is armed ONLY
  // once the server accepted the action, and it clears itself on a short
  // timer so the tile settles back into its calm resolved state.
  const armConfirm = useCallback((lane, tile) => {
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    setConfirmTile({ lane, tile });
    confirmTimerRef.current = setTimeout(() => {
      confirmTimerRef.current = null;
      if (mountedRef.current) setConfirmTile(null);
    }, 520);
  }, []);

  // Fire the banking confirmation. Armed ONLY after the authoritative
  // resync shows a NEW `hold` for this seat, and cleared on a short
  // timer. The clearing timer is stamped with the bank's identity and
  // re-checks it, so a stale timer from an older bank can never wipe
  // newer feedback (rapid re-banking stays correct).
  const armBankConfirm = useCallback((hold, actions) => {
    const key = holdKeyOf(hold);
    if (!key) return;
    const moved = bankedGainOnHold(actions, hold.seat, hold);
    const bankedTotal = Number(hold.bankedTotal) || 0;
    if (bankTimerRef.current) clearTimeout(bankTimerRef.current);
    setBankConfirm({ key, moved, bankedTotal });
    bankTimerRef.current = setTimeout(() => {
      bankTimerRef.current = null;
      if (!mountedRef.current) return;
      setBankConfirm((cur) => (cur && cur.key === key ? null : cur));
    }, 1800);
  }, []);

  const doAction = useCallback(
    async (action, tileIndex) => {
      if (!matchId || actingRef.current) return;
      // Defence in depth for a re-pick of a tile this seat ALREADY
      // busted on this row (its known bad tile): the rules gain nothing
      // and it would double-resolve the same intent. Flagging it stays
      // allowed (that is a different, legitimate action).
      const resolvedBust = myBustByLane?.[myLane];
      if (
        action === "pick" &&
        resolvedBust &&
        resolvedBust.path === selectedPath &&
        resolvedBust.tile === tileIndex
      ) {
        return;
      }
          // The PRESS itself, voiced at the finger — the quietest rung of the
      // hierarchy. It acknowledges the gesture and claims nothing: the
      // OUTCOME cue comes later, from the authoritative history only. Fired
      // after the guards above, so a tap that is refused (a duplicate, or a
      // re-pick of a tile this seat already busted on this row) stays silent.
      playSelect();
      // Immediate press feedback: show the tapped tile as in flight for
      // the duration of the request. It is a PENDING state — never a
      // success state — so nothing here claims the action landed.
      const clickedLane = myLane;
      const clickedTile = tileIndex === null || tileIndex === undefined ? null : tileIndex;
      if (clickedTile !== null) setPendingTile({ lane: clickedLane, tile: clickedTile });
      // A bank has no tile to mark, so the button itself carries the
      // in-flight state (a PENDING look, never a success claim).
      if (action === "hold") setBankPending(true);
      actingRef.current = true;
      setActing(true);
      setError(null);

      actionIdRef.current += 1;
      const actionId = `${matchId}:${mySeat}:${Date.now()}:${actionIdRef.current}`;
      const body =
        action === "hold"
          ? { action, actionId }
          : { action, path: selectedPath, tileIndex, actionId, round: myLane };
      const url = `/api/lane-rush-duel/match/${matchId}/act`;
      const send = () =>
        fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify(body),
        });

      try {
        let res;
        try {
          res = await send();
        } catch {
          // One retry — safe because the server dedupes on `actionId`.
          res = await send();
        }
        const json = await res.json();
        if (!mountedRef.current) return;
        if (!res.ok || !json.success) {
          setError(json.error || "Action failed");
          // 409 = the row moved on under us: reconcile immediately so
          // the board matches the authoritative state again.
          if (res.status === 409) await fetchStatus();
          return;
        }
        posthog?.capture("lane_rush_duel_action", {
          match_id: matchId,
          action,
          path: action === "hold" ? null : selectedPath,
          tile: tileIndex ?? null,
        });
        socket?.emit("room_event", {
          roomId: laneRushDuelMatchRoom(matchId),
          event: LANE_RUSH_DUEL_MATCH_UPDATED,
        });
        const synced = await fetchStatus();
        // Only NOW may the tile confirm, and only if the AUTHORITATIVE
        // history says the tap we sent landed on this exact tile and did
        // not bust. A merely-accepted request proves nothing (a red tile
        // succeeds too), so success is never inferred from the POST.
        const resolved = synced
          ? lastActionForSeat(synced.actions, mySeat)
          : null;
        if (action === "hold" && resolved?.action === "hold") {
          // The bank really landed: spell out the move from at risk →
          // protected, derived from the authoritative history.
          armBankConfirm(resolved, synced.actions);
        } else if (
          resolved &&
          resolved.action !== "hold" &&
          resolved.safe !== false &&
          Number(resolved.round ?? resolved.lane) === clickedLane &&
          Number(resolved.tile) === clickedTile
        ) {
          armConfirm(clickedLane, clickedTile);
        }
        // A peek is instant + private and keeps our row — drop out of
        // peek mode so the next tap is a real pick (the result shows in
        // the banner and as a private marker on the board).
        if (action === "peek") setPeekMode(false);
      } catch {
        if (mountedRef.current) {
          setError("Network error — your action was not sent. Try again.");
        }
      } finally {
        actingRef.current = false;
        if (mountedRef.current) {
          setActing(false);
          // The request settled (either way) — the pending markers are
          // done. A failure surfaces through the error chip instead.
          setPendingTile(null);
          setBankPending(false);
        }
      }
    },
    [
      matchId,
      posthog,
      selectedPath,
      socket,
      fetchStatus,
      mySeat,
      myLane,
      myBustByLane,
      armConfirm,
      armBankConfirm,
    ],
  );

  const cancelLobby = useCallback(async () => {
    if (!matchId) return;
    setCancelling(true);
    try {
      const res = await fetch(`/api/lane-rush-duel/match/${matchId}/cancel`, {
        method: "POST",
        credentials: "include",
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        setError(json.error || "Unable to cancel");
        return;
      }
      router.push("/casino/lane-runner");
    } catch {
      // Never let a network failure surface as an unhandled rejection.
      if (mountedRef.current) setError("Network error — could not cancel.");
    } finally {
      if (mountedRef.current) setCancelling(false);
    }
  }, [matchId, router]);

  // ── Status copy ──────────────────────────────────────────────────
  let statusChip = null;
  if (loading && !match) {
    statusChip = { text: "Loading…", cls: "bg-white/10 text-white/70" };
  } else if (cancelled) {
    statusChip = { text: "Cancelled", cls: "bg-red-500/20 text-red-200" };
  } else if (match?.status === "waiting") {
    statusChip = { text: "Waiting for opponent…", cls: "bg-amber-400/20 text-amber-200" };
  } else if (match?.status === "ready") {
    statusChip = { text: "Get ready…", cls: "bg-emerald-400/20 text-emerald-200" };
  } else if (finished) {
    const won = match.winnerId === user?.id;
    statusChip = {
      text: won ? "YOU WIN" : match.result === "draw" ? "DRAW" : "YOU LOSE",
      cls: won
        ? "bg-emerald-400/25 text-emerald-200"
        : match.result === "draw"
          ? "bg-amber-400/25 text-amber-200"
          : "bg-rose-500/25 text-rose-200",
    };
  } else if (isMyTurn) {
    statusChip = { text: "Play anytime", cls: "bg-cyan-400/25 text-cyan-100" };
  }

  // ── Result panel ─────────────────────────────────────────────────
  const wonMatch = finished && match.winnerId === user?.id;
  const lostMatch = finished && match.winnerId && match.winnerId !== user?.id;
  const drawMatch = finished && match.result === "draw";

  // ── Audio ─────────────────────────────────────────────────────────
  // Match result plays once when the finished state first surfaces
  // from the status poll (the poll re-renders repeatedly at finished).
  const finishSoundRef = useRef(false);
  useEffect(() => {
    if (!finished) {
      finishSoundRef.current = false;
      return;
    }
    if (finishSoundRef.current) return;
    finishSoundRef.current = true;
    if (wonMatch) playVictory();
    else if (lostMatch) playDefeat();
    else if (drawMatch) playTick();
  }, [finished, wonMatch, lostMatch, drawMatch]);

  // Bust feedback sound — a buzz the first time a NEW bust surfaces for
  // us. Keyed on the bust's identity and gated on the load baseline, so
  // neither a poll/socket refresh nor a page reload replays it. A red
  // tile must never resolve silently.
  useEffect(() => {
    if (!myBustKey) {
      lastBustSeenRef.current = null;
      return;
    }
    if (lastBustSeenRef.current === myBustKey) return;
    lastBustSeenRef.current = myBustKey;
    // Already busted before we loaded — not news, and not our buzz.
    if (loadBustKeysRef.current?.has(myBustKey)) return;
    playBuzz();
  }, [myBustKey]);

  // The viewer's own OUTCOME cue — the second rung: a safe pick/flag
  // confirms (playSafePick), a bank locks the run in (playBank). Voiced from
  // the authoritative history, never from the POST: a merely-accepted
  // request proves nothing (a red tile succeeds too).
  //
  // Exactly-once is structural. The cue is keyed on the action's OWN
  // identity and baselined on the first authoritative snapshot of this
  // mount, so the immediate room broadcast, the 5s safety poll, a socket
  // re-push, a React Strict-Mode double-invoked effect and a reload all
  // collapse to a single cue — and rapid play simply replaces the key
  // instead of stacking sounds.
  //
  // Deliberately has no say over the other two outcomes, so nothing ever
  // doubles: a BUST keeps its own keyed buzz above, and a PEEK keeps the
  // viewer's own reveal cue (chime / buzz) — a peek is information, not a
  // play, and it is voiced where its RESULT resolves. Anything else (an
  // unresolved entry) stays silent rather than guessing.
  useEffect(() => {
    if (!match) return;
    if (!myPrimedRef.current) {
      // Whatever this seat had already resolved when the view mounted is
      // history, not news: it becomes the baseline, never a cue.
      myPrimedRef.current = true;
      mySeenKeyRef.current = myActionKey;
      return;
    }
    if (!myActionKey || myActionKey === mySeenKeyRef.current) return;
    mySeenKeyRef.current = myActionKey;
    const a = myLastResolvedAction;
    if (!a) return;
    if (a.action === "hold") playBank();
    else if (a.safe === true && (a.action === "pick" || a.action === "flag")) {
      playSafePick();
    }
  }, [match, myActionKey, myLastResolvedAction]);

  // ── Opponent action feedback ─────────────────────────────────────
  // The opponent acts at the same time as the viewer: there is no turn to
  // wait for and the server publishes no per-seat "deciding" state mid-
  // match (the payload's `oppPending` only ever describes a legacy parked
  // entry, and `roundDeadline` is scrubbed while no seat owns a turn), so
  // NO "thinking…" affordance is fabricated here. The feedback is
  // event-shaped instead: when a genuinely NEW action lands, say what it
  // was for a couple of seconds, then let it fade.
  //
  // It is keyed on the action's own identity, baselined on the first
  // authoritative snapshot of this mount, and cleared by a timer stamped
  // with that identity — so the immediate room broadcast, the 5s safety
  // poll, a socket re-push or a reload can neither replay nor extend it,
  // and rapid opponent actions simply replace each other.
  useEffect(() => {
    if (!match) return;
    if (!oppPrimedRef.current) {
      // Whatever the opponent had already done when this view mounted is
      // history, not news — it becomes the baseline, never an alert.
      oppPrimedRef.current = true;
      oppSeenKeyRef.current = oppActionKey;
      return;
    }
    if (!oppActionKey || oppActionKey === oppSeenKeyRef.current) return;
    oppSeenKeyRef.current = oppActionKey;
    const notice = oppNoticeFor(oppLastAction, match.actions);
    if (!notice) return;
    if (oppNoticeTimerRef.current) clearTimeout(oppNoticeTimerRef.current);
    setOppNotice({ key: oppActionKey, tone: notice.tone, text: notice.text });
    // …and give it a voice. One restrained cue per opponent event, chosen
    // from the notice's own tone, so the audio and the visual can never
    // disagree or drift. A peek is information rather than a play, so it
    // stays silent. Fired from THIS one deduped path: the same broadcast /
    // poll / re-push that cannot replay the notice cannot replay the cue
    // either, and the guard above means it can never fire twice.
    if (notice.tone === "bust") playOpponentBust();
    else if (notice.tone === "bank") playOpponentBank();
    else if (notice.tone === "safe") playOpponentPick();
    oppNoticeTimerRef.current = setTimeout(() => {
      oppNoticeTimerRef.current = null;
      if (!mountedRef.current) return;
      setOppNotice((cur) => (cur && cur.key === oppActionKey ? null : cur));
    }, 2200);
  }, [match, oppActionKey, oppLastAction]);

  // Peek reveal — a chime for a safe tile, a buzz for a bad tile. Fires
  // only for a peek RESULT this mount has not voiced yet: the identity is
  // the peek (row + path + tile), never the object the poll just rebuilt,
  // so repeated snapshots stay silent while a genuinely new peek speaks.
  useEffect(() => {
    if (!lastPeek) return;
    if (lastPeekRef.current === peekIdOf(lastPeek)) return;
    lastPeekRef.current = peekIdOf(lastPeek);
    if (lastPeek.result === "bad") playBuzz();
    else playGoodReveal();
  }, [lastPeek]);

  // Real final-banked totals come from the server payload (p1Points /
  // p2Points); prizePaid is viewer-scrubbed server-side (only set when
  // this viewer won), so the delta math below uses real values only.
  const stakeNumber = Number(match?.stakeAmount) || 0;
  const myFinalPts = isPlayer1
    ? Number(match?.p1Points) || 0
    : Number(match?.p2Points) || 0;
  const oppFinalPts = isPlayer1
    ? Number(match?.p2Points) || 0
    : Number(match?.p1Points) || 0;

  // Duration from the existing match timestamps (omitted when absent).
  let durationSeconds = null;
  if (match?.startedAt && match?.endedAt) {
    const t0 = new Date(match.startedAt).getTime();
    const t1 = new Date(match.endedAt).getTime();
    if (Number.isFinite(t0) && Number.isFinite(t1) && t1 >= t0) {
      durationSeconds = Math.round((t1 - t0) / 1000);
    }
  }

  // Shared end-of-match screen (UX plan P3-3) — the old inline
  // YOU WIN / DRAW / YOU LOSE popup is gone. This const is mounted in
  // every layout variant below (creator portrait/landscape + default).
  // ── Result screen (shared PvpResultScreen) ────────────────────────
  // Presentation only. Every value is REAL settled state: the outcome the
  // server decided, the final accumulated score (p1Points / p2Points), the
  // locked totals the server derived from the hold entries, the published
  // payout, and whether the published history records a resignation. Nothing
  // here recomputes a winner, a score or a payout — it only chooses how the
  // settled result is told, and WHICH of two existing end-states caused it
  // (the 1,000-banked target or a resignation).
  const resignedEnd = wasResigned(match?.actions);
  const wonBy = drawMatch
    ? "Draw — both stakes returned"
    : resignedEnd
      ? "Resignation"
      : `${WIN_BANKED_SCORE.toLocaleString()} banked`;
  const resultHeadline = drawMatch
    ? "Both players receive their stake back"
    : wonMatch
      ? resignedEnd
        ? "Opponent resigned — the pot is yours"
        : `You banked ${Number(myBanked).toLocaleString()} and took the pot`
      : resignedEnd
        ? "You resigned — the pot went to your opponent"
        : `They banked ${Number(oppBanked).toLocaleString()} first`;
  const raceNote = drawMatch
    ? "Neither seat reached the target — both stakes were returned."
    : resignedEnd
      ? "The duel ended by resignation, so the race target was never reached."
      : wonMatch
        ? `Your locked ${Number(myBanked).toLocaleString()} crossed the target first.`
        : `Their locked ${Number(oppBanked).toLocaleString()} crossed the target first.`;
  // Built only for a settled match (`finished` implies `match`), so nothing
  // here can read a half-loaded payload.
  const resultScreenProps = finished ? {
    outcome: drawMatch ? "draw" : wonMatch ? "win" : "loss",
    headline: resultHeadline,
    gameName: "Lane Rush Duel",
    opponent: {
      name: oppDisplayName,
      iconKey: oppSeatIcon,
      profileFrame: oppSeatProfileFrame,
      isAi: isBotMatch,
    },
    tokenDelta: drawMatch
      ? 0
      : wonMatch
        ? Number(match.prizePaid || 0) - stakeNumber
        : -stakeNumber,
    durationSeconds,
    // Final score comparison — the winner's figure is emphasised, the
    // loser's stays readable but muted. Draw highlights neither.
    sides: [
      { name: "You", score: myFinalPts, highlight: !drawMatch && wonMatch },
      { name: oppDisplayName, score: oppFinalPts, highlight: !drawMatch && !wonMatch },
    ],
    // …and the reason, in the game's own terms.
    extraContent: (
      <FinalRaceReadout
        myName="You"
        oppName={oppDisplayName}
        myBanked={myBanked}
        oppBanked={oppBanked}
        myUnbanked={myUnbanked}
        oppUnbanked={oppUnbanked}
        winner={drawMatch ? "draw" : wonMatch ? "you" : "opp"}
        note={raceNote}
      />
    ),
    details: [
      ...(match.id != null ? [{ label: "Match ID", value: String(match.id) }] : []),
      { label: "Stake", value: `${stakeNumber.toLocaleString()} tokens` },
      { label: "Winner", value: drawMatch ? "Draw" : wonMatch ? "You" : oppDisplayName },
      { label: "Won by", value: wonBy },
    ],
    playAgain: { onClick: () => router.push("/casino/lane-runner") },
    onReturnToLobby: () => router.push("/casino"),
  } : null;
  const matchEndPopup = resultScreenProps ? (
    <PvpResultScreen open {...resultScreenProps} />
  ) : null;
  // …and the same screen in the compact scale the creator phone frame needs
  // (the repo's convention for a result mounted inside the recording frame).
  const matchEndPopupCompact = resultScreenProps ? (
    <PvpResultScreen open compact {...resultScreenProps} />
  ) : null;


  /* Creator Mode bespoke 9:16 portrait: race scoreboard (both players) on top,
     the shared tower large, and pick/flag/peek + bank/resign controls below. */
  const creatorScoreboard = (
    <>
<div className="grid grid-cols-2 gap-3">
              <div className="rounded-2xl border border-cyan-300/50 bg-cyan-500/10 p-3 text-center">
                <p className="inline-flex items-center justify-center gap-1 text-[10px] font-bold uppercase tracking-wider text-white/70">
                  <FrameAvatar frame={mySeatProfileFrame} iconKey={mySeatIcon} name={myDisplayName} size="h-4 w-4" />
                  <span className="max-w-[80px] truncate" style={myNameColor ? { color: myNameColor } : undefined}>
                    {myDisplayName}
                  </span>
                </p>
                {/* SCORE — one keyed transition per change, so a poll or
                    socket snapshot carrying the same number never replays. */}
                <p className="text-2xl font-black text-cyan-200">
                  <ScoreNumber value={myScore} />{" "}
                  <span className="text-xs text-white/40">pts</span>
                </p>
                {/* STREAK — only a real run (2+) is shown, and the key IS the
                    run length: the cue plays once per safe pick, and a
                    refresh (same run = same key) replays nothing. */}
                {myRun >= 2 && (
                  <p className="mt-0.5">
                    <span
                      key={`my-run-${myRun}`}
                      className="animate-state-in inline-flex items-center gap-0.5 rounded-full border border-cyan-300/40 bg-cyan-400/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-cyan-100"
                    >
                      <span aria-hidden>🔥</span> {myRun} safe run
                    </span>
                  </p>
                )}
                {/* PROGRESS — locked (amber) vs at risk (cyan) toward 1,000. */}
                <ScoreProgress
                  banked={myBanked}
                  unbanked={myUnbanked}
                  tone="cyan"
                  reached={myBanked >= WIN_BANKED_SCORE}
                />
                <p className="text-[10px] text-white/50">
                  At risk{" "}
                  {/* At-risk reads red while a NEW bust is this seat's latest
                      action (keyed on the bust, so a refresh can't recolour
                      it); otherwise it is the calm at-risk run tone. */}
                  <ScoreNumber
                    value={myUnbanked}
                    className={`font-bold ${myBustIsCurrent ? "text-red-300" : "text-rose-200"}`}
                  />{" "}
                  · banked{" "}
                  {/* The protected total gets a brief one-shot emphasis when a
                      bank lands — never a permanent pulse. The amber chip +
                      glow are the STATE (this total was just increased by a
                      bank); the scale flash is the extra motion, so with
                      reduced motion the chip still appears, it just doesn't
                      pop. */}
                  <motion.b
                    animate={
                      bankConfirm && !shouldReduce
                        ? BANK_BADGE_FLASH
                        : undefined
                    }
                    transition={
                      bankConfirm && !shouldReduce
                        ? BANK_BADGE_TRANSITION
                        : undefined
                    }
                    className={`inline-block text-amber-200 ${
                      bankConfirm
                        ? "rounded bg-amber-400/25 px-1 shadow-[0_0_10px_rgba(251,191,36,0.45)]"
                        : ""
                    }`}
                  >
                    {myBanked.toLocaleString()}
                  </motion.b>
                </p>
              </div>
              <div className="rounded-2xl border border-rose-300/40 bg-rose-500/10 p-3 text-center">
                <p className="inline-flex items-center justify-center gap-1 text-[10px] font-bold uppercase tracking-wider text-white/70">
                  <FrameAvatar frame={oppSeatProfileFrame} iconKey={oppSeatIcon} name={oppDisplayName} size="h-4 w-4" />
                  <span className="max-w-[80px] truncate" style={oppNameColor ? { color: oppNameColor } : undefined}>
                    {oppDisplayName}
                  </span>
                </p>
                <p className="text-xl font-black text-rose-200/90">
                  <ScoreNumber value={oppScore} />{" "}
                  <span className="text-xs text-white/35">pts</span>
                </p>
                {/* The opponent's race meter — the same read-out, deliberately
                    lighter so the local player's state keeps the emphasis. */}
                <ScoreProgress
                  banked={oppBanked}
                  unbanked={oppUnbanked}
                  tone="rose"
                  muted
                  reached={oppBanked >= WIN_BANKED_SCORE}
                />
                {/* Opponent action read-out — the one place their latest
                    move is announced. The slot keeps its height when idle
                    (showing their level), so the header never jumps, and
                    the notice itself is keyed on the action's identity and
                    clears itself, so it can never become a permanent
                    opponent banner. */}
                <p className="mt-0.5 flex min-h-[18px] items-center justify-center text-[9px] font-bold uppercase tracking-wide">
                  {oppNotice ? (
                    <span
                      key={oppNotice.key}
                      data-testid="lane-runner-opp-notice"
                      role="status"
                      aria-live="polite"
                      // Narrow cards (a 320px phone leaves the opponent
                      // ~116px) used to ELLIPSISE this line mid-word, hiding
                      // how much the bust cost. It now wraps instead: the
                      // slot has a min height, so the card only grows when a
                      // long message genuinely needs a second line.
                      className={`animate-state-in inline-block max-w-full rounded px-1.5 py-0.5 text-center leading-tight ${
                        OPP_NOTICE_TONE[oppNotice.tone] || OPP_NOTICE_TONE.safe
                      }`}
                    >
                      {oppNotice.text}
                    </span>
                  ) : (
                    <span
                      data-testid="lane-runner-opp-status"
                      className="text-white/40"
                    >
                      {oppScoutingLevel !== null ? (
                          <span className="inline-flex items-center gap-0.5 text-rose-200/80">
                            <IconEye size={9} />
                            Scouting L{oppScoutingLevel}
                          </span>
                        ) : (
                          <>Level {oppLaneLabel}</>
                        )}
                      {oppRun >= 2 && (
                        <span
                          key={`opp-run-${oppRun}`}
                          className="animate-state-in ml-1 text-rose-200/80"
                        >
                          🔥 {oppRun}
                        </span>
                      )}
                    </span>
                  )}
                </p>
                <p className="text-[10px] text-white/50">
                  At risk <ScoreNumber value={oppUnbanked} /> · banked{" "}
                  <ScoreNumber value={oppBanked} className="font-bold text-amber-200/85" />
                </p>
              </div>
            </div>
    </>
  );
  const creatorPressure = (
    <>
<PressureStrip
              myScore={myScore}
              oppScore={oppScore}
              myBanked={myBanked}
              oppBanked={oppBanked}
              myHeld={myHeld}
              oppHeld={oppHeld}
              myRate={myRate}
              oppRate={oppRate}
              difficulty={match?.difficulty}
              isBotMatch={isBotMatch}
              oppName={oppDisplayName}
            />
    </>
  );
  const creatorPathPicker = (
    <>
{canAct && (
              <PathPicker
                lane={myLane}
                selectedPath={selectedPath}
                onSelect={setSelectedPath}
                flagMode={flagMode}
                onToggleFlag={() => setFlagMode((f) => !f)}
                peekMode={peekMode}
                onTogglePeek={() => setPeekMode((p) => !p)}
                disabled={acting}
                flagsLeft={flagsLeft}
                peeksLeft={peeksLeft}
                deductions={deductions}
              />
            )}

    </>
  );
  const creatorLastPeek = (
    <>
{myPeekIsCurrent && !finished && (
              <div
                data-testid="lane-runner-peek-card"
                className={`rounded-2xl border px-4 py-2.5 text-xs ${
                  lastPeek.result === "bad"
                    ? "border-orange-300/50 bg-orange-500/15 text-orange-100"
                    : "border-emerald-300/50 bg-emerald-500/15 text-emerald-100"
                }`}
              >
                <b className="uppercase">
                  Peek: {RISK_PATHS[lastPeek.path]?.label ?? lastPeek.path} @{" "}
                  {lastPeek.tile + 1}
                </b>{" "}
                is the{" "}
                {lastPeek.result === "bad" ? (
                  <b>BAD tile — avoid it.</b>
                ) : (
                  <b>SAFE tile — it's a guaranteed pick.</b>
                )}
                <span className="ml-1 text-white/50">(only you saw this)</span>
              </div>
            )}

    </>
  );
  const creatorTower = (
    <>
<div className="h-full flex-1 flex flex-col gap-3 min-h-0">
              <DuelTower
                label="Your tower"
                tone="cyan"
                lane={myLane}
                held={myHeld}
                isActiveClimber={true}
                isViewerTurn={true}
                clickable={canAct}
                selectedPath={selectedPath}
                flagMode={flagMode}
                peekMode={peekMode}
                myPeeks={myPeeks}
                pathByLane={myHistory.myPath}
                pickedTileByLane={myHistory.myPicked}
                bustByLane={myBustByLane}
                oppBustByLane={oppBustByLane}
                pendingTile={pendingTile}
                confirmTile={confirmTile}
                intelPathByLane={myHistory.oppPath}
                intelPickedByLane={myHistory.oppPicked}
                deductions={deductions}
                tower={myTower}
                difficulty={match?.difficulty}
                finished={finished}
                onPick={(t) => doAction(peekMode ? "peek" : flagMode ? "flag" : "pick", t)}
              />
            </div>
    </>
  );
  const creatorBank = (
    <>
      {!finished && (
              <div className="space-y-1">
                {myBustIsCurrent && (
                  // Keyed on the bust itself: a NEW bust replays the
                  // one-shot entrance, a poll/socket refresh with the
                  // SAME bust does not (same key = same element, no
                  // animation restart). It is an inline row in the side
                  // column, so it never covers the board.
                  <motion.div
                    key={myBustKey}
                    {...withReducedMotion(shouldReduce, BUST_BANNER_ONESHOT)}
                    role="status"
                    aria-live="polite"
                    className="rounded-2xl border border-red-400/60 bg-red-500/15 px-3 py-2 text-xs text-red-100"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <b className="uppercase tracking-wide">
                        Bust on level {myBustLaneLabel}
                      </b>
                      <span className="shrink-0 rounded-full bg-red-500/30 px-2 py-0.5 text-[10px] font-bold tabular-nums">
                        {myBustLoss > 0
                          ? `−${myBustLoss.toLocaleString()} unbanked`
                          : "no unbanked lost"}
                      </span>
                    </div>
                    <p className="mt-0.5 text-[11px] leading-snug text-red-100/90">
                      That red tile took your at-risk run. Your banked{" "}
                      <b>{myBanked.toLocaleString()}</b> is safe and the duel
                      continues — pick on to keep climbing.
                    </p>
                  </motion.div>
                )}
                {bankConfirm && (
                  // Keyed on the bank itself: a NEW bank replays the
                  // one-shot entrance, a poll/socket refresh with the
                  // same bank does not. Compact, inline, above the
                  // button — it never covers the board.
                  // Reduced motion renders it in place (the shared static
                  // variant): the "+N moved from at risk → protected" text is
                  // the information, the slide was just where to look.
                  <motion.div
                    key={bankConfirm.key}
                    {...withReducedMotion(shouldReduce, BANK_ONESHOT)}
                    role="status"
                    aria-live="polite"
                    className="flex items-center gap-2 rounded-2xl border border-amber-300/60 bg-amber-400/15 px-3 py-2 text-xs text-amber-100"
                  >
                    <IconLock size={13} className="shrink-0 text-amber-300" />
                    <span className="min-w-0 leading-snug">
                      {bankConfirm.moved > 0 ? (
                        <>
                          <b>+{bankConfirm.moved.toLocaleString()}</b> moved from
                          at risk → protected:{" "}
                        </>
                      ) : (
                        "Nothing new was at risk — "
                      )}
                      <b>{bankConfirm.bankedTotal.toLocaleString()}</b> banked
                      and bust-proof. Keep climbing.
                    </span>
                  </motion.div>
                )}
                <motion.button
                  type="button"
                  data-testid="lane-runner-bank-button"
                  disabled={!canHold || bankPending}
                  whileTap={
                    canHold && !bankPending && !shouldReduce
                      ? { scale: 0.97 }
                      : undefined
                  }
                  transition={
                    shouldReduce ? undefined : BANK_PRESS_TRANSITION
                  }
                  onClick={() => doAction("hold")}
                  className={`flex w-full items-center justify-center gap-2 rounded-2xl py-3.5 text-sm font-black uppercase tracking-wider transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-200 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950 ${
                    bankPending
                      ? "bg-gradient-to-r from-amber-400/70 to-yellow-400/70 text-black/70 ring-2 ring-amber-200/70"
                      : canHold
                        ? "bg-gradient-to-r from-amber-400 to-yellow-400 text-black"
                        : "bg-white/10 text-white/40"
                  }`}
                >
                  <IconLock size={16} />
                  {bankPending ? (
                    "Banking…"
                  ) : (
                    /* Keyed on the amount: the label cues ONCE each time the
                       bankable total changes (the shared 180ms one-shot) and
                       is completely still otherwise — a poll carrying the
                       same total keeps the same key and replays nothing. */
                    <span
                      key={`bank-label-${myScore}`}
                      className={`inline-block ${
                        canHold ? "animate-state-in" : ""
                      }`}
                    >
                      {myHeld
                        ? `Re-bank ${myScore.toLocaleString()} pts`
                        : `Bank ${myScore.toLocaleString()} pts`}
                    </span>
                  )}
                </motion.button>
                <p className="text-center text-[10px] text-white/40">
                  At risk{" "}
                  <b className="text-rose-200">
                    {myUnbanked.toLocaleString()}
                  </b>{" "}
                  · banked{" "}
                  <b className="text-amber-200">{myBanked.toLocaleString()}</b>{" "}
                  (always safe — a bust only clears the at-risk run). First to{" "}
                  {WIN_BANKED_SCORE.toLocaleString()} banked wins.
                </p>
                {!cancelled && !isBotMatch && (
                  <button
                    type="button"
                    onClick={handleResign}
                    disabled={resigning}
                    className="flex w-full items-center justify-center gap-2 rounded-2xl border border-red-500/40 bg-red-500/10 py-2.5 text-xs font-black uppercase tracking-wider text-red-300 transition hover:bg-red-500/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950 disabled:opacity-50"
                  >
                    {resigning ? "Resigning…" : "Resign match"}
                  </button>
                )}
              </div>
            )}

    </>
  );

  const desktopContent = (
    <>
      {(match?.status === "active" || finished) && (
        <div className="space-y-4">
          {matchEndPopup}
          <div className="rounded-2xl border border-cyan-300/40 bg-cyan-400/10 p-3 text-sm text-cyan-100">Both players can act at the same time.</div>
          {creatorScoreboard}
          {creatorPressure}
          {creatorPathPicker}
          {creatorLastPeek}
          {creatorTower}
          {creatorBank}
        </div>
      )}
    </>
  );

  const portraitContent = (
    <CreatorModeShell className="bg-[#070b1e] bg-[radial-gradient(circle_at_top,#1b2150_0%,#080b1f_35%,#03040d_100%)]">
      <ShellHeader className="space-y-2">
        {creatorScoreboard}
        {creatorPressure}
      </ShellHeader>
      <ShellMain className="h-full items-start overflow-y-auto px-2">{creatorTower}</ShellMain>
      <ShellAside className="space-y-3">
        {creatorPathPicker}
        {creatorLastPeek}
        {creatorBank}
      </ShellAside>
      {matchEndPopupCompact}
    </CreatorModeShell>
  );

  return (
    <>
      {/* Unified full-screen waiting takeover (matchmaking → countdown) */}
      {(match?.status === "waiting" || match?.status === "ready") && (
        <MatchWaiting
          state={match.status === "ready" ? "ready" : "waiting"}
          gameName={isBotMatch ? "Lane Rush vs Bot" : "Lane Rush Duel"}
          subtitle={
            match.status === "ready"
              ? "You both climb the SAME tower — get ready!"
              : "Your stake is escrowed. Share the invite link to play a player of the same stake, or wait for matchmaking."
          }
          seats={
            match.status === "waiting"
              ? [
                  { label: "You", name: myDisplayName, occupied: true },
                  {
                    label: isBotMatch ? "Bot" : "Opponent",
                    name: oppDisplayName,
                    occupied: false,
                  },
                ]
              : []
          }
          onCancel={
            match.status === "waiting" && match?.player1Id === user?.id
              ? cancelLobby
              : null
          }
          cancelLabel="Cancel lobby"
          cancelling={cancelling}
          onCopy={
            isBotMatch
              ? null
              : () =>
                  navigator.clipboard
                    ?.writeText(window.location.href)
                    ?.catch(() => {})
          }
        />
      )}

      <div className="min-h-screen overflow-x-clip bg-[radial-gradient(circle_at_top,#1b2150_0%,#080b1f_35%,#03040d_100%)] pb-24 pt-20 text-white md:pb-8">
      <NavigationBar currentPath="/casino/lane-runner" />

      <div className="mx-auto mt-4 max-w-5xl px-3 sm:px-4">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <button
              onClick={() => router.push("/casino/lane-runner")}
              className="rounded-lg border border-white/15 bg-black/30 p-2 text-white/70 transition hover:border-cyan-300/40 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950"
              aria-label="Back to lobby"
            >
              <IconArrowLeft size={18} />
            </button>
            <div>
              <h1 className="text-xl font-black text-cyan-100 sm:text-2xl">
                Lane Rush Duel
              </h1>
              <p className="text-xs text-white/55">
                #{matchId} · {DIFFICULTIES[match?.difficulty]?.label || "Easy"}{" "}
                tower ·{" "}
                <span className="inline-flex items-center gap-1 font-semibold text-yellow-300">
                  <CoinIcon className="w-3 h-3" />
                  {Number(match?.stakeAmount || 0).toLocaleString()}
                </span>{" "}
                stake
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {statusChip && (
              <span
                className={`rounded-full border px-3 py-1.5 text-xs font-black uppercase tracking-wider ${statusChip.cls}`}
              >
                {statusChip.text}
              </span>
            )}
            {secondsLeft !== null && !finished && !cancelled && (
              <span
                className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-black ${
                  secondsLeft <= 5
                    ? "border-red-400/50 bg-red-500/20 text-red-200"
                    : "border-white/15 bg-black/30 text-white/80"
                }`}
              >
                <IconClock size={13} />
                {secondsLeft}s
              </span>
            )}
            {syncFailures > 0 && !finished && !cancelled && (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-400/40 bg-amber-500/15 px-3 py-1.5 text-xs font-black text-amber-100">
                <IconClock size={13} />
                Reconnecting…
              </span>
            )}
          </div>
        </div>

        {error && (
          <div className="mb-4 flex items-center gap-2 rounded-xl border border-red-400/40 bg-red-900/30 px-3 py-2 text-sm text-red-200">
            <IconX size={16} className="text-red-300" />
            <span>{error}</span>
          </div>
        )}

        {/* ── Waiting / Ready states ─────────────────────────────── */}
        {(match?.status === "waiting" || match?.status === "ready") && (
          <motion.div
            initial={shouldReduce ? false : { opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex flex-col items-center justify-center rounded-3xl border border-cyan-300/20 bg-slate-900/60 py-20 text-center"
          >
            <div className="flex items-center gap-2 text-2xl font-black text-cyan-100">
              <span className="inline-block h-3 w-3 animate-ping rounded-full bg-cyan-400" />
              {match?.status === "waiting"
                ? "Waiting for an opponent…"
                : "Opponent found! Get ready…"}
            </div>
            <p className="mt-2 max-w-md text-sm text-white/60">
              {match?.status === "waiting"
                ? "Your stake is escrowed. Share this link to invite a player of the same stake, or wait for matchmaking."
                : "You both climb the SAME tower. Picks reveal together, so watch what the other player survives — every safe pick narrows the odds. Bank with HOLD, or call a bad tile with FLAG (2 per match)."}
            </p>
            <div className="mt-6 flex items-center gap-3">
              {match?.status === "waiting" && match?.player1Id === user?.id && (
                <button
                  onClick={cancelLobby}
                  disabled={cancelling}
                  className="rounded-xl border border-red-400/40 bg-red-500/15 px-5 py-2.5 text-sm font-bold text-red-200 transition hover:bg-red-500/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950 disabled:opacity-50"
                >
                  {cancelling ? "Cancelling…" : "Cancel lobby"}
                </button>
              )}
              {!isBotMatch && (
                <button
                  onClick={() =>
                    navigator.clipboard
                      ?.writeText(window.location.href)
                      ?.catch(() => {})
                  }
                  className="rounded-xl border border-cyan-300/40 bg-cyan-400/10 px-5 py-2.5 text-sm font-bold text-cyan-100 transition hover:bg-cyan-400/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950"
                >
                  Copy invite link
                </button>
              )}
            </div>
          </motion.div>
        )}

        {/* ── Active game ────────────────────────────────────────── */}
                <CreatorModeHost
          autoStart={Boolean(match && match.status === "active")}
          autoStop={Boolean(finished || cancelled)}
          gameLabel="lane-rush-duel"
          backToLobbyHref="/casino/lane-runner"
        >
          <CreatorView
            normal={desktopContent}
            portrait={portraitContent}
            landscape={desktopContent}
          />
        </CreatorModeHost>


        {!loading && !match && (
          <div className="rounded-3xl border border-white/10 bg-slate-900/60 py-20 text-center">
            <p className="text-white/60">
              {error
                ? `Couldn't load the duel: ${error}`
                : "Match not found or you are not a participant."}
            </p>
            {error && (
              <button
                onClick={() => fetchStatus()}
                className="mt-4 mr-2 rounded-xl border border-cyan-300/50 bg-cyan-400/10 px-5 py-2 text-sm font-bold text-cyan-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950"
              >
                Retry
              </button>
            )}
            <button
              onClick={() => router.push("/casino/lane-runner")}
              className="mt-4 rounded-xl bg-cyan-400 px-5 py-2 text-sm font-bold text-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-200 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950"
            >
              Back to Lobby
            </button>
          </div>
        )}

        <Footer />
      </div>
      </div>
    </>
  );
}
