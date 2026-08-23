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
import { motion, AnimatePresence } from "framer-motion";
import NavigationBar from "../../../../components/navigation-bar";
import Footer from "../../../../components/Footer";
import { useSocket } from "../../../../context/SocketProvider";
import {
  LANE_RUSH_DUEL_MATCH_UPDATED,
  laneRushDuelMatchRoom,
} from "../../../../lib/lane-rush-duel/rooms";
import {
  DIFFICULTIES,
  LANE_POINTS,
  MAX_FLAGS,
  MAX_LANES,
  MAX_PEEKS,
  RISK_PATHS,
  WIN_BANKED_SCORE,
  computeDeductions,
  pointsForSafePick,
  safePicksToReachScore,
  survivalOdds,
} from "../../../../lib/lane-rush-duel/constants";
import {
  IconTrophy,
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
  intelPathByLane,
  intelPickedByLane,
  deductions,
  tower,
  difficulty,
  finished,
  onPick,
}) {
  const rowsTopFirst = [...Array.from({ length: MAX_LANES }, (_, i) => i)].reverse();
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

  return (
    <div className="flex-1 rounded-2xl border border-white/10 bg-slate-950/80 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span
          className={`rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider ${chip}`}
        >
          {label}
        </span>
        <span className="rounded-full bg-black/40 px-2.5 py-1 text-xs font-black text-white">
          {held
            ? `BANKED L${lane}`
            : lane >= MAX_LANES
              ? "TOP!"
              : `Level ${Math.min(lane + 1, MAX_LANES)}`}
        </span>
      </div>

      <div className="space-y-1.5">
        {rowsTopFirst.map((laneIdx) => {
          const isCurrent = laneIdx === lane;
          const isCompleted = laneIdx < lane;
          const isFuture = laneIdx > lane;
          const isBanked = held && isCurrent;

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
            <div
              key={laneIdx}
              className={`relative rounded-lg border p-1.5 ${
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
              <div className="mb-1.5 flex items-center justify-between text-[10px]">
                <span className="font-semibold text-white/70">
                  Level {laneIdx + 1}
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
                  <span className="rounded border border-white/10 bg-black/30 px-1 py-0.5 text-[9px] font-semibold text-white/60">
                    {intelLabel}: {RISK_PATHS[intelPath]?.label ?? "?"} @{" "}
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
                className="grid gap-1.5"
                style={{
                  gridTemplateColumns: `repeat(${tiles}, minmax(0, 1fr))`,
                }}
              >
                {Array.from({ length: tiles }, (_, tileIdx) => {
                  const tileCanPick =
                    clickable && isCurrent && isActiveClimber && isViewerTurn;
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

                  let cls = "bg-gradient-to-br from-slate-700 to-slate-900 border-white/10 text-white/60";
                  let glyph = "?";
                  if (tileIsBad) {
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
                  } else if (tileCanPick) {
                    cls = flagMode
                      ? "bg-gradient-to-br from-orange-700 to-red-900 border-orange-300/50 text-orange-100 hover:brightness-125 cursor-pointer"
                      : peekMode
                        ? "bg-gradient-to-br from-cyan-600 to-blue-800 border-cyan-200/60 text-white hover:brightness-125 cursor-pointer"
                        : PATH_STYLE[lanePath].tile + " hover:brightness-125 cursor-pointer";
                    glyph = flagMode ? "⚑" : "?";
                  } else if (isBanked && isCurrent) {
                    cls = "bg-gradient-to-br from-amber-600/60 to-amber-900/60 border-amber-300/40 text-amber-100/70";
                  }

                  return (
                    <motion.button
                      key={`${laneIdx}-${tileIdx}`}
                      type="button"
                      whileHover={tileCanPick ? { scale: 1.06 } : undefined}
                      whileTap={tileCanPick ? { scale: 0.94 } : undefined}
                      onClick={() => tileCanPick && onPick(tileIdx)}
                      disabled={!tileCanPick}
                      className={`h-6 md:h-7 rounded border text-[10px] font-bold transition-all ${cls}`}
                    >
                      {glyph}
                    </motion.button>
                  );
                })}
              </div>
            </div>
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
            className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[10px] font-black uppercase tracking-wider transition ${
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
            className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[10px] font-black uppercase tracking-wider transition ${
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
          const odds = ((path.tiles - 1) / path.tiles) * 100;
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
              className={`rounded-xl border px-2 py-2 text-center transition ${
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
}) {
  const oppName = isBotMatch ? "the bot" : "your opponent";
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
  const [cancelling, setCancelling] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [selectedPath, setSelectedPath] = useState("balanced");
  const [flagMode, setFlagMode] = useState(false);
  const [peekMode, setPeekMode] = useState(false);
  const [lastPeek, setLastPeek] = useState(null); // { path, tile, result }

  const pickedRef = useRef(false);

  // ── Status polling (1.5s) + socket live updates ──────────────────
  const fetchStatus = useCallback(async () => {
    if (!matchId) {
      // Invalid/undecided matchId — never pin the page on "Loading…".
      // The `!loading && !match` branch renders the not-found panel.
      setLoading(false);
      return;
    }
    try {
      const res = await fetch(`/api/lane-rush-duel/match/${matchId}`, {
        cache: "no-store",
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        setError(json.error || "Failed to load match");
        return;
      }
      setMatch(json.data.match);
      setError(null);
    } catch (e) {
      // silent — retry next tick
    } finally {
      setLoading(false);
    }
  }, [matchId]);

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 1500);
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

  // ── Test vs Bot: auto-trigger the bot's turn ────────────────────
  const isBotMatch = match?.player2Id === "AI_BOT";
  const botTurnFiredRef = useRef(false);

  useEffect(() => {
    if (!isBotMatch) return;
    const inTurn =
      match?.status === "p1_turn" || match?.status === "p2_turn";
    const isBotTurn = match?.currentTurnUserId === "AI_BOT";
    if (!inTurn || !isBotTurn) {
      botTurnFiredRef.current = false;
      return;
    }
    const timerSec = Number(match?.roundTimerSeconds) || 20;
    const deadline = match?.roundDeadline
      ? new Date(match.roundDeadline).getTime()
      : null;
    const elapsed = deadline ? timerSec * 1000 - (deadline - now) : 0;
    if (elapsed >= 1500 && !botTurnFiredRef.current) {
      botTurnFiredRef.current = true;
      fetch(`/api/lane-rush-duel/match/${matchId}/ai-turn`, {
        method: "POST",
        credentials: "include",
      })
        .then((r) => r.json())
        .then((json) => {
          if (json?.success) {
            socket?.emit("room_event", {
              roomId: laneRushDuelMatchRoom(matchId),
              event: LANE_RUSH_DUEL_MATCH_UPDATED,
            });
            fetchStatus();
          } else {
            botTurnFiredRef.current = false;
          }
        })
        .catch(() => {
          botTurnFiredRef.current = false;
        });
    }
  }, [isBotMatch, match, now, matchId, socket, fetchStatus]);

  // ── Derived state ────────────────────────────────────────────────
  const isPlayer1 = match?.viewerIsPlayer1;
  const mySeat = isPlayer1 ? "player1" : "player2";
  const oppSeat = isPlayer1 ? "player2" : "player1";

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
  const myBanks = Number(match?.myBanks) || 0;
  const oppBanks = Number(match?.oppBanks) || 0;
  const myRate = Number(match?.myRate) ?? 1;
  const oppRate = Number(match?.oppRate) ?? 1;
  const myEnded = Boolean(match?.myEnded);
  const oppEnded = Boolean(match?.oppEnded);

  // Deferred reveal: myPending = my pick is parked awaiting the
  // opponent's answer; oppPending = the opponent locked in first.
  const myPending = Boolean(match?.myPending);
  const oppPending = Boolean(match?.oppPending);

  // Banking does NOT end your climb — only a bust or completing the
  // tower does. Banked players keep playing at a reduced rate.
  const myDone = myEnded;
  const oppDone = oppEnded;

  const isMyTurn = Boolean(match?.isViewerTurn);
  const canAct =
    !finished &&
    !cancelled &&
    isMyTurn &&
    !myDone &&
    !acting &&
    !myPending &&
    (match?.status === "p1_turn" || match?.status === "p2_turn");

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
    const peeks = (match?.actions || []).filter(
      (a) => a && a.action === "peek" && a.seat === mySeat && a.peekResult,
    );
    if (peeks.length > 0) {
      const last = peeks[peeks.length - 1];
      setLastPeek({ path: last.path, tile: last.tile, result: last.peekResult });
    }
  }, [match?.actions, mySeat]);

  // Bad tile per lane per path (only available after finish).
  const myTower = Array.isArray(match?.myTower) ? match.myTower : [];
  const oppTower = Array.isArray(match?.oppTower) ? match.oppTower : [];

  const deadlineMs = match?.roundDeadline
    ? new Date(match.roundDeadline).getTime()
    : null;
  const secondsLeft = deadlineMs
    ? Math.max(0, Math.ceil((deadlineMs - now) / 1000))
    : null;

  // Soft bank: you can bank ANY number of times (each bank halves
  // your future pick rate), as long as your climb isn't over.
  const canHold = canAct && myLane >= 1 && myLane < MAX_LANES;

  // ── Actions ──────────────────────────────────────────────────────
  const doAction = useCallback(
    async (action, tileIndex) => {
      if (acting || pickedRef.current) return;
      pickedRef.current = true;
      setActing(true);
      setError(null);
      try {
        const body =
          action === "hold"
            ? { action }
            : { action, path: selectedPath, tileIndex };
        const res = await fetch(`/api/lane-rush-duel/match/${matchId}/act`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify(body),
        });
        const json = await res.json();
        if (!res.ok || !json.success) {
          setError(json.error || "Action failed");
          pickedRef.current = false;
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
        await fetchStatus();
        if (action === "peek") {
          // A peek is instant + private and keeps our turn — unlock
          // the picker right away and drop out of peek mode so the
          // next tap is a real pick (the result shows in the banner
          // and as a private marker on the board).
          pickedRef.current = false;
          setPeekMode(false);
        }
      } catch (e) {
        setError("Network error. Retrying…");
        pickedRef.current = false;
      } finally {
        setActing(false);
        setTimeout(() => {
          pickedRef.current = false;
        }, 600);
      }
    },
    [acting, matchId, posthog, selectedPath, socket, fetchStatus],
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
    } finally {
      setCancelling(false);
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
    statusChip = { text: "Your turn", cls: "bg-cyan-400/25 text-cyan-100" };
  } else {
    statusChip = { text: "Opponent's turn", cls: "bg-rose-500/20 text-rose-100" };
  }

  // ── Result panel ─────────────────────────────────────────────────
  const wonMatch = finished && match.winnerId === user?.id;
  const lostMatch = finished && match.winnerId && match.winnerId !== user?.id;
  const drawMatch = finished && match.result === "draw";

  return (
    <div className="min-h-screen overflow-x-clip bg-[radial-gradient(circle_at_top,#1b2150_0%,#080b1f_35%,#03040d_100%)] pb-24 pt-20 text-white md:pb-8">
      <NavigationBar currentPath="/casino/lane-runner" />

      <div className="mx-auto mt-4 max-w-5xl px-3 sm:px-4">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <button
              onClick={() => router.push("/casino/lane-runner")}
              className="rounded-lg border border-white/15 bg-black/30 p-2 text-white/70 transition hover:border-cyan-300/40 hover:text-white"
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
            initial={{ opacity: 0, y: 10 }}
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
                  className="rounded-xl border border-red-400/40 bg-red-500/15 px-5 py-2.5 text-sm font-bold text-red-200 transition hover:bg-red-500/25 disabled:opacity-50"
                >
                  {cancelling ? "Cancelling…" : "Cancel lobby"}
                </button>
              )}
              {!isBotMatch && (
                <button
                  onClick={() => navigator.clipboard?.writeText(window.location.href)}
                  className="rounded-xl border border-cyan-300/40 bg-cyan-400/10 px-5 py-2.5 text-sm font-bold text-cyan-100 transition hover:bg-cyan-400/20"
                >
                  Copy invite link
                </button>
              )}
            </div>
          </motion.div>
        )}

        {/* ── Active game ────────────────────────────────────────── */}
        {(match?.status === "p1_turn" || match?.status === "p2_turn" || finished) && (
          <div className="space-y-4">
            {/* Turn banner */}
            {!finished && (
              <div
                className={`rounded-2xl border px-4 py-3 text-sm ${
                  isMyTurn
                    ? "border-cyan-300/40 bg-cyan-400/10 text-cyan-100"
                    : "border-rose-300/30 bg-rose-500/10 text-rose-100"
                }`}
              >
                {myEnded
                  ? "Your climb is over. Waiting for the opponent to finish."
                  : isMyTurn
                    ? myPending
                      ? "Your pick is locked in. Waiting for the opponent to answer this level…"
                      : oppPending
                        ? "Your opponent has locked in. Your move — pick, flag, or bank."
                        : "Your turn. Pick a path, pick a tile, FLAG the bad one, or BANK — first to bank 1,000 wins."
                    : myPending
                      ? "Your pick is locked in. Waiting for your opponent…"
                      : oppEnded
                        ? "Their climb is over — you're climbing alone now."
                        : "Opponent's turn. They're climbing."}
              </div>
            )}

            {/* Scoreboard — points + the zugzwang chip */}
            <div className="grid grid-cols-2 gap-3">
              <div
                className={`rounded-2xl border p-3 text-center ${
                  isMyTurn && !finished
                    ? "border-cyan-300/50 bg-cyan-500/10"
                    : "border-white/10 bg-black/30"
                }`}
              >
                <p className="text-[10px] uppercase tracking-wider text-white/50">
                  You
                </p>
                <p className="text-2xl font-black text-cyan-200">
                  {myScore.toLocaleString()}{" "}
                  <span className="text-xs text-white/40">pts</span>
                </p>
                <p className="text-[10px] text-white/50">
                  {myLane >= MAX_LANES
                    ? "Completed"
                    : myEnded
                      ? "Busted"
                      : myHeld
                        ? `Banked ${myBanked.toLocaleString()} / ${WIN_BANKED_SCORE.toLocaleString()} · ${Math.round(myRate * 100)}% rate`
                        : `Level ${myLane + 1} · ${myScore.toLocaleString()} / ${WIN_BANKED_SCORE.toLocaleString()} to win`}
                </p>
              </div>
              <div
                className={`rounded-2xl border p-3 text-center ${
                  !isMyTurn && !finished
                    ? "border-rose-300/50 bg-rose-500/10"
                    : "border-white/10 bg-black/30"
                }`}
              >
                <p className="text-[10px] uppercase tracking-wider text-white/50">
                  {isBotMatch ? "Bot" : "Opponent"}
                </p>
                <p className="text-2xl font-black text-rose-200">
                  {oppScore.toLocaleString()}{" "}
                  <span className="text-xs text-white/40">pts</span>
                </p>
                <p className="text-[10px] text-white/50">
                  {oppLane >= MAX_LANES
                    ? "Completed"
                    : oppEnded
                      ? "Busted"
                      : oppHeld
                        ? `Banked ${oppBanked.toLocaleString()} / ${WIN_BANKED_SCORE.toLocaleString()} · ${Math.round(oppRate * 100)}% rate`
                        : `Level ${oppLane + 1} · ${oppScore.toLocaleString()} / ${WIN_BANKED_SCORE.toLocaleString()} to win`}
                </p>
              </div>
            </div>

            {/* Zugzwang pressure strip */}
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
            />

            {/* Risk-path picker — your turn only, while your pick is
                not already parked for this row */}
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

            {/* Private peek result — only the viewer sees this. */}
            {lastPeek && !finished && !myPending && (
              <div
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
                <span className="ml-1 text-white/50">
                  (only you saw this)
                </span>
              </div>
            )}

            {/* Deferred reveal: your pick is parked — nothing else to
                do until the opponent answers this row. */}
            {myPending && !finished && (
              <div className="flex items-center gap-3 rounded-2xl border border-cyan-300/30 bg-cyan-500/10 px-4 py-3 text-sm text-cyan-100">
                <span className="inline-block h-2.5 w-2.5 animate-ping rounded-full bg-cyan-400" />
                <span>
                  <b className="font-black uppercase tracking-wider">Pick locked in.</b>{" "}
                  Waiting for your opponent to climb this level — both picks reveal
                  together.
                </span>
              </div>
            )}

            {/* Towers */}
            <div className="flex flex-col gap-3 lg:flex-row">
              <DuelTower
                label="Your tower"
                tone="cyan"
                lane={myLane}
                held={myHeld}
                isActiveClimber={!myDone}
                isViewerTurn={isMyTurn}
                clickable={canAct}
                selectedPath={selectedPath}
                flagMode={flagMode}
                peekMode={peekMode}
                myPeeks={myPeeks}
                pathByLane={myHistory.myPath}
                pickedTileByLane={myHistory.myPicked}
                intelPathByLane={myHistory.oppPath}
                intelPickedByLane={myHistory.oppPicked}
                deductions={deductions}
                tower={myTower}
                difficulty={match?.difficulty}
                finished={finished}
                onPick={(t) => doAction(peekMode ? "peek" : flagMode ? "flag" : "pick", t)}
              />
              <DuelTower
                label={isBotMatch ? "Bot's tower" : "Opponent's tower"}
                tone="rose"
                lane={oppLane}
                held={oppHeld}
                isActiveClimber={!oppDone}
                isViewerTurn={false}
                clickable={false}
                selectedPath={null}
                flagMode={false}
                peekMode={false}
                myPeeks={undefined}
                pathByLane={myHistory.oppPath}
                pickedTileByLane={myHistory.oppPicked}
                intelPathByLane={myHistory.myPath}
                intelPickedByLane={myHistory.myPicked}
                deductions={deductions}
                tower={oppTower}
                difficulty={match?.difficulty}
                finished={finished}
                onPick={() => {}}
              />
            </div>

            {/* Bank button — soft bank: locks your score, you keep
                climbing at a reduced rate (×0.5 per bank). */}
            {!finished && (
              <div className="space-y-1">
                <motion.button
                  type="button"
                  disabled={!canHold}
                  animate={canHold ? { scale: [1, 1.02, 1] } : undefined}
                  transition={{ repeat: canHold ? Infinity : 0, duration: 1.1 }}
                  onClick={() => doAction("hold")}
                  className={`flex w-full items-center justify-center gap-2 rounded-2xl py-3.5 text-sm font-black uppercase tracking-wider transition ${
                    canHold
                      ? "bg-gradient-to-r from-amber-400 to-yellow-400 text-black shadow-[0_0_25px_rgba(251,191,36,0.5)] hover:brightness-110"
                      : "bg-white/10 text-white/40"
                  }`}
                >
                  <IconLock size={16} />
                  {myLane === 0
                    ? "Bank (climb at least one level first)"
                    : acting
                      ? "Banking…"
                      : myHeld
                        ? `Re-bank ${myScore.toLocaleString()} pts (${myScore >= WIN_BANKED_SCORE ? "WINS" : "toward " + WIN_BANKED_SCORE.toLocaleString()})`
                        : `Bank ${myScore.toLocaleString()} pts (first to ${WIN_BANKED_SCORE.toLocaleString()})`}
                </motion.button>
                {myEnded ? (
                  <p className="text-center text-[10px] text-white/40">
                    Your climb is over{myHeld ? ` — you keep ${myBanked.toLocaleString()} pts` : " — you banked nothing"}.
                  </p>
                ) : myLane === 0 ? (
                  <p className="text-center text-[10px] text-white/40">
                    Bank once you've climbed at least one level — first to{" "}
                    {WIN_BANKED_SCORE.toLocaleString()} banked wins.
                  </p>
                ) : (
                  <p className="text-center text-[10px] text-white/40">
                    Locks {myScore.toLocaleString()} pts as your banked score{" "}
                    {myHeld ? "(re-banking raises it)" : ""}. First to{" "}
                    <b className="text-amber-200">
                      {WIN_BANKED_SCORE.toLocaleString()}
                    </b>{" "}
                    banked wins; picks after banking pay{" "}
                    <b className="text-amber-200">
                      {Math.round(Math.pow(0.5, myBanks + 1) * 100)}%
                    </b>
                    .
                  </p>
                )}
              </div>
            )}

            {/* Result reveal */}
            <AnimatePresence>
              {(wonMatch || lostMatch || drawMatch) && (
                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  className={`rounded-3xl border p-6 text-center ${
                    wonMatch
                      ? "border-emerald-300/40 bg-emerald-500/10"
                      : drawMatch
                        ? "border-amber-300/40 bg-amber-500/10"
                        : "border-rose-300/40 bg-rose-500/10"
                  }`}
                >
                  <IconTrophy
                    size={40}
                    className={`mx-auto ${
                      wonMatch
                        ? "text-emerald-300"
                        : drawMatch
                          ? "text-amber-300"
                          : "text-rose-300"
                    }`}
                  />
                  <h2
                    className={`mt-2 text-3xl font-black tracking-wide ${
                      wonMatch
                        ? "text-emerald-200"
                        : drawMatch
                          ? "text-amber-200"
                          : "text-rose-200"
                    }`}
                  >
                    {wonMatch ? "VICTORY" : drawMatch ? "DRAW" : "DEFEAT"}
                  </h2>
                  <p className="mt-1 text-sm text-white/70">
                    {wonMatch
                      ? `You took the race to ${WIN_BANKED_SCORE.toLocaleString()} banked — ${Number(match.prizePaid).toFixed(2)} tokens (stake back + 90% of the loser's).`
                      : drawMatch
                        ? "Even scores. Full refund, no house fee."
                        : "You busted before banking 1,000 — only what you banked survived."}
                  </p>
                  <p className="mt-2 text-lg font-black text-white">
                    {myScore.toLocaleString()} pts vs {oppScore.toLocaleString()} pts{" "}
                    <span className="text-xs font-normal text-white/50">
                      (banked {myBanked.toLocaleString()} vs {oppBanked.toLocaleString()})
                    </span>
                  </p>
                  {wonMatch && (
                    <p className="mt-1 text-2xl font-black text-emerald-200">
                      +{Number(match.prizePaid).toFixed(2)}{" "}
                      <CoinIcon className="inline w-5 h-5 text-yellow-300" />
                    </p>
                  )}

                  {/* Provably-fair reveal */}
                  <div className="mx-auto mt-5 max-w-lg rounded-2xl border border-white/10 bg-black/30 p-4 text-left text-xs">
                    <p className="mb-2 flex items-center gap-1.5 font-bold text-cyan-200">
                      <IconShieldCheck size={14} />
                      Provably fair. Verified
                    </p>
                    <div className="grid grid-cols-1 gap-1.5 text-white/70 sm:grid-cols-2">
                      <p>
                        Server seed:{" "}
                        <span className="font-mono text-[10px] break-all text-white/90">
                          {match.serverSeed}
                        </span>
                      </p>
                      <p>
                        Seed hash:{" "}
                        <span className="font-mono text-[10px] break-all text-white/90">
                          {match.serverSeedHash}
                        </span>
                      </p>
                      <p>
                        Client seed (shared tower):{" "}
                        <span className="font-mono text-[10px] break-all text-white/90">
                          {match.p1ClientSeed}
                        </span>
                      </p>
                    </div>
                    <p className="mt-2 text-white/50">
                      Bad tile per path per lane (the shared tower):
                    </p>
                    <div className="mt-1 grid grid-cols-1 gap-0.5 font-mono text-[10px] text-rose-300/90">
                      {myTower.map((entry, i) => (
                        <p key={i}>
                          L{i + 1} · safe <b>{entry?.safe ?? "?"}</b> · balanced{" "}
                          <b>{entry?.balanced ?? "?"}</b> · risky{" "}
                          <b>{entry?.risky ?? "?"}</b>
                        </p>
                      ))}
                    </div>
                    <p className="mt-2 text-white/50">
                      Note: on the safe/balanced paths, each lane's bad tile
                      never repeats the previous lane's position; the risky
                      path instead never repeats the previous lane's SAFE
                      position. Both constraints are verifiable here.
                    </p>
                  </div>

                  <button
                    onClick={() => router.push("/casino/lane-runner")}
                    className="mt-5 rounded-xl bg-gradient-to-r from-cyan-400 to-blue-500 px-6 py-2.5 text-sm font-bold text-black transition hover:brightness-110"
                  >
                    Back to Lobby
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}

        {!loading && !match && (
          <div className="rounded-3xl border border-white/10 bg-slate-900/60 py-20 text-center">
            <p className="text-white/60">Match not found or you are not a participant.</p>
            <button
              onClick={() => router.push("/casino/lane-runner")}
              className="mt-4 rounded-xl bg-cyan-400 px-5 py-2 text-sm font-bold text-black"
            >
              Back to Lobby
            </button>
          </div>
        )}

        <Footer />
      </div>
    </div>
  );
}
