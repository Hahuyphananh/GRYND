"use client";

// src/app/casino/lane-runner/[matchId]/page.jsx
//
// MATCH view for the "Lane Rush Duel" system. Both players race
// their OWN provably-fair tower (same difficulty), alternating
// turns. The game is scored in POINTS.
//
// Skill mechanics (the anti-luck package):
//   • RISK PATHS — every lane you choose your odds: Safe (4 tiles,
//     75%), Balanced (3, 67%) or Risky (2, 50%), each paying more
//     points per safe pick. Choosing which luck to buy is the skill.
//   • BAD-TILE MEMORY — a bad tile can never repeat the previous
//     lane's position (same path), so tracking history narrows your
//     next guess and late-game tiles become deducible.
//   • THE FLAG — instead of picking you may CALL a tile as the bad
//     one: right = instant win, wrong = bust.
//   • HOLD — bank your points and force the opponent to out-score
//     you (the flag-to-win chicken move).
//   • Provably fair — every path's bad tiles derive from a shared
//     server seed + each player's own client seed; the full layout
//     is revealed post-match so the memory rule is verifiable.

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
  MAX_LANES,
  RISK_PATHS,
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
  pathByLane,
  pickedTileByLane,
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
                  const tileIsSafePick = isCompleted && pickedTile === tileIdx;

                  let cls = "bg-gradient-to-br from-slate-700 to-slate-900 border-white/10 text-white/60";
                  let glyph = "?";
                  if (tileIsBad) {
                    cls = "bg-gradient-to-br from-rose-600 to-red-800 border-red-300/60 text-white";
                    glyph = "✕";
                  } else if (tileIsSafePick) {
                    cls = "bg-gradient-to-br from-emerald-500 to-green-700 border-emerald-300/70 text-white";
                    glyph = "✓";
                  } else if (tileIsPicked) {
                    cls = isMine
                      ? "bg-gradient-to-br from-cyan-400 to-blue-600 border-cyan-100/70 text-white"
                      : "bg-gradient-to-br from-rose-400 to-pink-700 border-rose-100/70 text-white";
                    glyph = "●";
                  } else if (tileCanPick) {
                    cls = flagMode
                      ? "bg-gradient-to-br from-orange-700 to-red-900 border-orange-300/50 text-orange-100 hover:brightness-125 cursor-pointer"
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
function PathPicker({ lane, selectedPath, onSelect, flagMode, onToggleFlag, disabled }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-black/25 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-xs font-black uppercase tracking-wider text-white/70">
          Choose your odds — Level {Math.min(lane + 1, MAX_LANES)}
        </p>
        <button
          type="button"
          onClick={onToggleFlag}
          disabled={disabled}
          className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[10px] font-black uppercase tracking-wider transition ${
            flagMode
              ? "border-orange-300 bg-orange-500/25 text-orange-100"
              : "border-white/15 bg-black/30 text-white/60 hover:text-white"
          }`}
        >
          <IconFlag size={11} />
          {flagMode ? "Flag mode ON — tap a tile" : "Flag mode"}
        </button>
      </div>
      <div className="grid grid-cols-3 gap-2">
        {Object.values(RISK_PATHS).map((path) => {
          const active = !flagMode && selectedPath === path.key;
          const pts = pointsForSafePick(lane, path.key, undefined);
          const odds = ((path.tiles - 1) / path.tiles) * 100;
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
              } ${disabled ? "opacity-50" : "hover:brightness-110"}`}
            >
              <p className="text-[11px] font-black uppercase">{path.label}</p>
              <p className="text-[9px] text-white/70">{odds}% safe</p>
              <p className={`text-xs font-black ${PATH_STYLE[path.key].text}`}>
                +{pts} pts
              </p>
            </button>
          );
        })}
      </div>
      <p className="mt-2 text-[10px] text-white/45">
        {flagMode
          ? "FLAG = call the bad tile. Right → instant win. Wrong → you bust. With the memory rule (bad tiles never repeat positions), late lanes are deducible."
          : "Bad tiles never repeat the previous lane's position on the same path — track what you see and you can narrow the next guess."}
      </p>
    </div>
  );
}

// ── Zugzwang pressure strip (points-based) ─────────────────────────
// Shows the chicken-game math in points: how many points the player
// who is behind must out-score, roughly how many safe picks that
// implies on a given path, and the survival odds of pushing blind.
function PressureStrip({
  myScore,
  oppScore,
  myHeld,
  oppHeld,
  difficulty,
  isBotMatch,
}) {
  const oppName = isBotMatch ? "The bot" : "Your opponent";
  const myPicksToWin = oppHeld
    ? safePicksToReachScore(oppScore, myScore, "balanced", difficulty)
    : 0;
  const oppPicksToWin = myHeld
    ? safePicksToReachScore(myScore, oppScore, "balanced", difficulty)
    : 0;
  const survival = (n) => survivalOdds(n, RISK_PATHS.balanced.tiles);

  // ── Both banked (transient — the game resolves immediately) ─────
  if (myHeld && oppHeld) {
    const ahead =
      myScore > oppScore ? "you" : oppScore > myScore ? "them" : "neither";
    return (
      <div className="rounded-2xl border border-amber-300/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
        <span className="font-black uppercase tracking-wider">Both banked</span>
        <span className="text-white/70">
          {" "}
          — you on {myScore.toLocaleString()} pts, them on{" "}
          {oppScore.toLocaleString()}.{" "}
          {ahead === "neither"
            ? "Dead even — draw."
            : ahead === "you"
              ? "You take the pot."
              : "They take the pot."}
        </span>
      </div>
    );
  }

  // ── I banked: the opponent must out-score me ────────────────────
  if (myHeld) {
    return (
      <div className="rounded-2xl border border-amber-300/40 bg-amber-500/10 px-4 py-3">
        <p className="flex items-center gap-1.5 text-xs font-black uppercase tracking-wider text-amber-200">
          <IconFlag size={13} className="text-amber-300" />
          Pressure — you banked {myScore.toLocaleString()} pts
        </p>
        {oppPicksToWin > 0 ? (
          <p className="mt-1 text-sm text-amber-100">
            {oppName} needs{" "}
            <b className="text-white">
              {(oppScore < myScore ? myScore - oppScore : 0).toLocaleString()} pts
            </b>{" "}
            — roughly{" "}
            <b className="text-white">
              {oppPicksToWin} balanced safe pick{oppPicksToWin === 1 ? "" : "s"}
            </b>{" "}
            — only ~
            <b className="text-white">
              {(survival(oppPicksToWin) * 100).toFixed(0)}%
            </b>{" "}
            survival pushing blind.
          </p>
        ) : (
          <p className="mt-1 text-sm text-amber-100">
            {oppName} is already out-scoring you — they win if they bank
            now. Your only hope is that they bust climbing.{" "}
            <span className="font-bold text-white">Hold the line.</span>
          </p>
        )}
        {oppPicksToWin > 0 && (
          <SurvivalBar pct={survival(oppPicksToWin)} label="their survival odds" />
        )}
      </div>
    );
  }

  // ── They banked: I must out-score them ──────────────────────────
  if (oppHeld) {
    return (
      <div className="rounded-2xl border border-cyan-300/40 bg-cyan-500/10 px-4 py-3">
        <p className="flex items-center gap-1.5 text-xs font-black uppercase tracking-wider text-cyan-200">
          <IconFlag size={13} className="text-cyan-300" />
          Pressure — {isBotMatch ? "the bot" : "your opponent"} banked{" "}
          {oppScore.toLocaleString()} pts
        </p>
        {myPicksToWin > 0 ? (
          <p className="mt-1 text-sm text-cyan-100">
            You need{" "}
            <b className="text-white">
              {(myScore < oppScore ? oppScore - myScore : 0).toLocaleString()} pts
            </b>{" "}
            — roughly{" "}
            <b className="text-white">
              {myPicksToWin} balanced safe pick{myPicksToWin === 1 ? "" : "s"}
            </b>{" "}
            — ~
            <b className="text-white">
              {(survival(myPicksToWin) * 100).toFixed(0)}%
            </b>{" "}
            survival pushing blind. Risky paths close the gap faster.
          </p>
        ) : (
          <p className="mt-1 text-sm text-cyan-100">
            You're already ahead of their bank — bank now to lock in the
            win, or push higher for more.
          </p>
        )}
        {myPicksToWin > 0 && (
          <SurvivalBar pct={survival(myPicksToWin)} label="your survival odds" />
        )}
      </div>
    );
  }

  // ── Nobody banked yet: the live race ─────────────────────────────
  const diff = myScore - oppScore;
  const leader =
    diff > 0 ? "You" : diff < 0 ? (isBotMatch ? "The bot" : "Your opponent") : null;
  return (
    <div className="rounded-2xl border border-white/10 bg-black/25 px-4 py-3 text-sm text-white/75">
      {diff === 0 ? (
        <p>
          <b className="text-white">Dead even</b> at{" "}
          <b className="text-white">{myScore.toLocaleString()}</b> pts —
          whoever banks first sets the target. Climb safe or hold now to
          apply the pressure.
        </p>
      ) : (
        <p>
          <b className="text-white">{leader}</b>{" "}
          {leader === "You" ? "lead" : "leads"} by{" "}
          <b className="text-white">{Math.abs(diff).toLocaleString()} pts</b>.
          A bank now forces the other side to close that gap against your
          hold.
        </p>
      )}
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

  const myDone = myHeld || myLane >= MAX_LANES;
  const oppDone = oppHeld || oppLane >= MAX_LANES;

  const isMyTurn = Boolean(match?.isViewerTurn);
  const canAct =
    !finished &&
    !cancelled &&
    isMyTurn &&
    !myDone &&
    !acting &&
    (match?.status === "p1_turn" || match?.status === "p2_turn");

  // Path + picked tile per lane from the actions history.
  const myHistory = useMemo(() => {
    const pathByLane = {};
    const pickedByLane = {};
    const oppPath = {};
    const oppPicked = {};
    (match?.actions || []).forEach((a) => {
      if (a.action !== "pick" || a.safe === false) return;
      if (a.seat === mySeat) {
        pathByLane[a.lane] = a.path;
        pickedByLane[a.lane] = a.tile;
      } else if (a.seat === oppSeat) {
        oppPath[a.lane] = a.path;
        oppPicked[a.lane] = a.tile;
      }
    });
    return { myPath: pathByLane, myPicked: pickedByLane, oppPath, oppPicked };
  }, [match?.actions, mySeat, oppSeat]);

  // Bad tile per lane per path (only available after finish).
  const myTower = Array.isArray(match?.myTower) ? match.myTower : [];
  const oppTower = Array.isArray(match?.oppTower) ? match.oppTower : [];

  const deadlineMs = match?.roundDeadline
    ? new Date(match.roundDeadline).getTime()
    : null;
  const secondsLeft = deadlineMs
    ? Math.max(0, Math.ceil((deadlineMs - now) / 1000))
    : null;

  const canHold = canAct && myLane >= 1 && !myHeld && myLane < MAX_LANES;

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
      } catch (e) {
        setError("Network error — retrying…");
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
                : "The first player is rolled at random. Score points by climbing, bank them with HOLD — or call the bad tile with FLAG."}
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
                {isMyTurn
                  ? myHeld || myLane >= MAX_LANES
                    ? "You banked your points — waiting for the opponent."
                    : "Your turn — pick a path, pick a tile — or FLAG the bad one."
                  : oppHeld || oppLane >= MAX_LANES
                    ? "Opponent banked — you must out-score them or bust trying."
                    : "Opponent's turn — they're climbing."}
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
                  {myHeld ? "Banked" : myLane >= MAX_LANES ? "Completed" : `Level ${myLane + 1}`}
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
                  {oppHeld ? "Banked" : oppLane >= MAX_LANES ? "Completed" : `Level ${oppLane + 1}`}
                </p>
              </div>
            </div>

            {/* Zugzwang pressure strip */}
            <PressureStrip
              myScore={myScore}
              oppScore={oppScore}
              myHeld={myHeld}
              oppHeld={oppHeld}
              difficulty={match?.difficulty}
              isBotMatch={isBotMatch}
            />

            {/* Risk-path picker — your turn only */}
            {canAct && !flagMode && (
              <PathPicker
                lane={myLane}
                selectedPath={selectedPath}
                onSelect={setSelectedPath}
                flagMode={flagMode}
                onToggleFlag={() => setFlagMode((f) => !f)}
                disabled={acting}
              />
            )}
            {canAct && flagMode && (
              <PathPicker
                lane={myLane}
                selectedPath={selectedPath}
                onSelect={setSelectedPath}
                flagMode={flagMode}
                onToggleFlag={() => setFlagMode((f) => !f)}
                disabled={acting}
              />
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
                pathByLane={myHistory.myPath}
                pickedTileByLane={myHistory.myPicked}
                tower={myTower}
                difficulty={match?.difficulty}
                finished={finished}
                onPick={(t) => doAction(flagMode ? "flag" : "pick", t)}
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
                pathByLane={myHistory.oppPath}
                pickedTileByLane={myHistory.oppPicked}
                tower={oppTower}
                difficulty={match?.difficulty}
                finished={finished}
                onPick={() => {}}
              />
            </div>

            {/* Hold button */}
            {!finished && (
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
                  ? "Hold (climb at least one level first)"
                  : myHeld
                    ? "Already banked"
                    : acting
                      ? "Banking…"
                      : `Hold & Bank ${myScore.toLocaleString()} pts`}
              </motion.button>
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
                      ? `You take ${Number(match.prizePaid).toFixed(2)} tokens (stake back + 90% of the loser's).`
                      : drawMatch
                        ? "Even points — full refund, no house fee."
                        : "Your tower busted before the opponent's."}
                  </p>
                  <p className="mt-2 text-lg font-black text-white">
                    {myScore.toLocaleString()} pts vs {oppScore.toLocaleString()} pts
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
                      Provably fair — verified
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
                        Your client seed:{" "}
                        <span className="font-mono text-[10px] break-all text-white/90">
                          {isPlayer1 ? match.p1ClientSeed : match.p2ClientSeed}
                        </span>
                      </p>
                      <p>
                        Their client seed:{" "}
                        <span className="font-mono text-[10px] break-all text-white/90">
                          {isPlayer1 ? match.p2ClientSeed : match.p1ClientSeed}
                        </span>
                      </p>
                    </div>
                    <p className="mt-2 text-white/50">
                      Bad tile per path per lane (your tower):
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
                      Note: on every path, each lane's bad tile never repeats
                      the previous lane's position — the memory rule you can
                      verify here.
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
