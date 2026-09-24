"use client";

// src/app/casino/lane-runner/[matchId]/PageClient.jsx
//
// MATCH view for the "Lane Rush Duel" system — the SHARED GLASS BRIDGE.
//
// Both players cross ONE provably-fair bridge: 10 rows, exactly one bad
// tile per row, alternating turns.
//   • Pick a tile on the row you are standing on. SAFE carries you one
//     row further and it stays your turn (the 15s window resets). BAD
//     breaks that tile for the rest of the match, ends your attempt
//     (back to row 1) and hands the turn over.
//   • Crossing row 10 wins the match instantly.
//   • 2 MEMORY FLAGS per player, placeable only on a tile you personally
//     landed on safely. Flags are PUBLIC, append-only and never consume
//     the turn.
//   • The 15s choice window is SERVER-authoritative. This component only
//     displays it: when it reaches zero it simply asks the server for the
//     authoritative state (the same GET the safety poll makes), so a
//     device clock can never decide a result.
//
// REUSE, not reinvention: the 5s safety poll + Socket.IO nudge, the
// idempotent action submit (`actionId`), reconnection resync, the shared
// waiting/result screens all come from the
// existing architecture.

import { useCallback, useEffect, useMemo, useRef, useState, use } from "react";
import { useRouter } from "next/navigation";
import { usePostHog } from "posthog-js/react";
import { useUser } from "@clerk/nextjs";
import { motion, useReducedMotion } from "framer-motion";
import NavigationBar from "../../../../components/navigation-bar";
import FrameAvatar from "../../../../components/FrameAvatar";
import { cosmeticEffectClass } from "../../../../lib/profileCosmetics";
import GameSessionHost from "../../../../components/GameSessionHost";

import MatchWaiting from "../../../../components/lobby/MatchWaiting";
import PvpResultScreen from "../../../../components/result/PvpResultScreen";
import Footer from "../../../../components/Footer";
import { useSocket } from "../../../../context/SocketProvider";
import {
  LANE_RUSH_DUEL_MATCH_UPDATED,
  laneRushDuelMatchRoom,
} from "../../../../lib/lane-rush-duel/rooms";
import {
  BOT_ACTION_INTERVAL_MS,
  DIFFICULTIES,
} from "../../../../lib/lane-rush-duel/constants";
import {
  playVictory,
  playDefeat,
  playTick,
  playOpponentPick,
  playOpponentBust,
  playBuzz,
  playSelect,
  playSafePick,
  playGlassBreak,
} from "../../../../lib/gameAudio";
import {
  IconClock,
  IconArrowLeft,
  IconFlag,
  IconTrophy,
  IconX,
} from "@tabler/icons-react";

function CoinIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <circle cx="12" cy="12" r="10" fill="#facc15" stroke="#a16207" strokeWidth="1.5" />
      <text
        x="12"
        y="16.5"
        textAnchor="middle"
        fontSize="11"
        fontWeight="900"
        fill="#78350f"
      >
        G
      </text>
    </svg>
  );
}

const key = (row, tile) => `${row}:${tile}`;

/** Rows a seat has PERSONALLY crossed (its own safe landings). */
function safeLandingsFor(actions, seat) {
  const set = new Set();
  for (const a of Array.isArray(actions) ? actions : []) {
    if (!a || a.seat !== seat) continue;
    if (a.action !== "jump") continue;
    if (a.outcome !== "safe" && a.outcome !== "won") continue;
    set.add(key(Number(a.row), Number(a.tile)));
  }
  return set;
}

function flagKeySet(list) {
  const set = new Set();
  for (const f of Array.isArray(list) ? list : []) {
    set.add(key(Number(f?.row), Number(f?.tile)));
  }
  return set;
}

function lastActionFor(actions, seat, predicate) {
  for (let i = (actions?.length ?? 0) - 1; i >= 0; i -= 1) {
    const a = actions[i];
    if (a && a.seat === seat && predicate(a)) return a;
  }
  return null;
}

const wasResigned = (actions) =>
  Array.isArray(actions) &&
  actions.some((a) => a === "resign" || a?.action === "resign");

/** The authoritative actions that happened BEFORE `action` (exclusive). */
function historyBefore(actions, action) {
  const list = Array.isArray(actions) ? actions : [];
  const at = list.indexOf(action);
  return at > 0 ? list.slice(0, at) : [];
}

/**
 * WHERE A SEAT IS STANDING — a board object, not a row number.
 *
 * The shared bridge is crossed TILE BY TILE, so a player stands ON the tile
 * they last crossed (the tile they clicked, which carried them to the next
 * row). Their avatar is drawn on that tile, never beside the row:
 *
 *   • { kind: "tile", row, tile } — the tile the seat is standing on;
 *   • { kind: "start" }           — the start platform (no tile yet);
 *   • { kind: "crossed" }         — off the bridge (won): no token at all.
 *
 * The landing only counts while it sits in the row DIRECTLY below the seat's
 * own progress. A fall (or a timeout) resets the seat to row 1, so a stale
 * landing from a previous attempt can never strand its token mid-bridge.
 *
 * Pure presentation: it reads the server's action history and never decides a
 * tile, a turn or a result.
 */
function ballAnchorFor({ actions, seat, row, rows }) {
  const progress = Number(row);
  if (!Number.isFinite(progress)) return { kind: "start" };
  if (progress >= Number(rows)) return { kind: "crossed" };
  if (progress <= 0) return { kind: "start" };
  const landing = lastActionFor(
    actions,
    seat,
    (a) => a.action === "jump" && (a.outcome === "safe" || a.outcome === "won"),
  );
  if (landing && Number(landing.row) === progress - 1) {
    return { kind: "tile", row: Number(landing.row), tile: Number(landing.tile) };
  }
  return { kind: "start" };
}

// ── Presentation: the floating glass bridge ─────────────────────────
// All of it is PRESENTATION ONLY — every state below is the server's
// (`myRow`/`oppRow`/`broken`/`myFlags`/`oppFlags`/`roundDeadline`). Nothing
// here decides a tile, a turn or a result.

/** The shared choice window length; the server owns the real deadline. */
const BRIDGE_TOTAL_SECONDS = 15;

// ── Waking the practice bot ───────────────────────────────────────
// The bot is paced SERVER-side (`BOT_ACTION_INTERVAL_MS` in the store), so the
// page wakes it on that same shared interval — never faster — with a small
// cushion so a wake-up cannot land a millisecond inside the throttle and burn
// a wake-up of the bot's 15s window.
const BOT_FIRST_WAKE_MS = 350;
const BOT_WAKE_INTERVAL_MS = BOT_ACTION_INTERVAL_MS + 150;

/**
 * The 15s choice window as a bright glass ring. DISPLAY ONLY: when it
 * empties the component simply re-asks the server for the authoritative
 * state (the same GET the safety poll makes) — a device clock never
 * decides anything.
 */
function TimerRing({ secondsLeft, active }) {
  const total = BRIDGE_TOTAL_SECONDS;
  const shown =
    secondsLeft === null ? null : Math.max(0, Math.min(total, secondsLeft));
  const R = 15.5;
  const C = 2 * Math.PI * R;
  const offset = shown === null ? C : C * (1 - shown / total);
  const danger = shown !== null && shown <= 5;
  const stroke = danger
    ? "#fb7185"
    : active
      ? "#22d3ee"
      : "rgba(255,255,255,0.65)";
  return (
    <span
      className={`relative inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-full border backdrop-blur-md ${
        danger ? "border-rose-400/50 bg-rose-500/10" : "border-white/15 bg-black/40"
      }`}
      title={active ? "Your choice window" : "Their choice window"}
    >
      <svg
        viewBox="0 0 40 40"
        className="absolute inset-0 h-full w-full -rotate-90"
        aria-hidden="true"
      >
        <circle
          cx="20"
          cy="20"
          r={R}
          fill="none"
          stroke="rgba(255,255,255,0.12)"
          strokeWidth="3"
        />
        <circle
          cx="20"
          cy="20"
          r={R}
          fill="none"
          stroke={stroke}
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={C}
          strokeDashoffset={offset}
          style={{
            transition: "stroke-dashoffset 0.3s linear, stroke 0.3s linear",
          }}
        />
      </svg>
      <span className="relative flex flex-col items-center leading-none">
        <span
          className={`text-sm font-black ${danger ? "text-rose-200" : "text-white"}`}
        >
          {shown === null ? "\u2013" : shown}
        </span>
        <span className="mt-0.5 text-[7px] font-bold uppercase tracking-[0.18em] text-white/40">
          sec
        </span>
      </span>
    </span>
  );
}

/**
 * One bridge seat: the player's profile picture, username, rows crossed
 * (progress) and remaining memory flags. `isTurn` glows the live seat so
 * both players can see whose 15s window it is.
 */
function BridgeSeat({
  isSelf,
  name,
  nameColor,
  nameEffect,
  identity,
  row,
  total,
  flagsLeft,
  flagsTotal,
  isTurn,
}) {
  const pct = total > 0 ? Math.min(100, Math.round((row / total) * 100)) : 0;
  return (
    <div
      className={`relative overflow-hidden rounded-2xl border p-3 backdrop-blur-md transition ${
        isTurn
          ? isSelf
            ? "border-cyan-300/70 bg-cyan-400/10 shadow-[0_0_30px_-8px_rgba(34,211,238,0.6)]"
            : "border-rose-300/70 bg-rose-500/10 shadow-[0_0_30px_-8px_rgba(251,113,133,0.55)]"
          : "border-white/10 bg-white/[0.04]"
      }`}
    >
      {isTurn && (
        <span className="absolute right-2 top-2 rounded-full bg-cyan-300 px-1.5 py-0.5 text-[8px] font-black uppercase tracking-wider text-black">
          Turn
        </span>
      )}
      <div className="flex items-center gap-3">
        <FrameAvatar
          frame={identity?.profileFrame}
          iconKey={identity?.iconKey}
          name={name}
          size="h-12 w-12"
          className="ring-1 ring-white/15"
        />
        <div className="min-w-0 flex-1">
          <p className="text-[9px] font-bold uppercase tracking-[0.14em] text-white/45">
            {isSelf ? "You" : "Opponent"}
          </p>
          <p
            className={`truncate text-sm font-black ${nameEffect}`}
            style={nameColor ? { color: nameColor } : undefined}
          >
            {name}
          </p>
          <div className="mt-1 flex items-center gap-2">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10">
              <div
                className={`h-full rounded-full transition-[width] duration-500 ${
                  isSelf
                    ? "bg-gradient-to-r from-cyan-300 to-cyan-500"
                    : "bg-gradient-to-r from-rose-300 to-rose-500"
                }`}
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="shrink-0 text-sm font-black text-white">
              {row}
              <span className="text-xs text-white/40">/{total}</span>
            </span>
          </div>
          <p
            data-testid="lane-runner-flags-left"
            className="mt-1 flex items-center gap-1.5 text-[10px] font-semibold text-white/55"
          >
            <span className="flex items-center gap-0.5" aria-hidden="true">
              {Array.from({ length: Math.max(0, flagsTotal) }, (_, i) => (
                <IconFlag
                  key={i}
                  size={11}
                  className={i < flagsLeft ? "text-amber-300" : "text-white/20"}
                />
              ))}
            </span>
            {flagsLeft}/{flagsTotal} left
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * A panel of glass giving way.
 *
 * Everything is delayed to `delay` — the instant the falling token actually
 * reaches the tile. Playing it on mount made the glass appear to shatter in
 * mid-air, before the player had landed on it at all, which is why the tiles
 * never read as breaking "on impact".
 *
 * Three beats: a bright impact flash, a crack web snapping out from the point
 * of contact, and a spray of shards thrown off the tile.
 */
function GlassBreak({ tileRect, delay = 0.5 }) {
  const cx = tileRect.x + tileRect.w / 2;
  const cy = tileRect.y + tileRect.h / 2;
  const reach = Math.max(tileRect.w, tileRect.h) * 0.7;
  const SHARDS = 12;

  return (
    <>
      {/* the impact flash */}
      <motion.span
        aria-hidden
        data-testid="lane-runner-impact"
        className="absolute rounded-full"
        style={{
          left: cx - 22,
          top: cy - 22,
          width: 44,
          height: 44,
          background:
            "radial-gradient(circle, rgba(255,255,255,0.95), rgba(186,230,253,0.45) 45%, transparent 72%)",
        }}
        initial={{ opacity: 0, scale: 0.3 }}
        animate={{ opacity: [0, 1, 0], scale: [0.3, 1.35, 1.7] }}
        transition={{ duration: 0.42, delay, times: [0, 0.25, 1], ease: "easeOut" }}
      />

      {/* the crack web — 7 splits radiating from the impact point */}
      {[0, 52, 104, 156, 208, 260, 312].map((deg, i) => (
        <motion.span
          key={`crack-${i}`}
          aria-hidden
          data-testid="lane-runner-crack"
          className="absolute bg-white/85"
          style={{
            left: cx,
            top: cy,
            width: 1.5,
            height: reach,
            transformOrigin: "0% 50%",
            rotate: `${deg}deg`,
          }}
          initial={{ opacity: 0.95, scaleX: 0.08 }}
          animate={{ opacity: 0, scaleX: 1 }}
          transition={{ duration: 0.5, delay, ease: "easeOut" }}
        />
      ))}

      {/* the shards — spun off the tile as real glass flakes */}
      {Array.from({ length: SHARDS }, (_, i) => {
        const a = (i / SHARDS) * Math.PI * 2 + 0.4;
        const dist = 30 + (i % 3) * 9;
        return (
          <motion.span
            key={`shard-${i}`}
            aria-hidden
            data-testid="lane-runner-shard"
            className="absolute"
            style={{
              left: cx,
              top: cy,
              width: i % 2 ? 5 : 8,
              height: i % 2 ? 9 : 5,
              background:
                "linear-gradient(135deg, rgba(255,255,255,0.95), rgba(186,230,253,0.35))",
              clipPath: "polygon(0% 0%, 100% 18%, 72% 100%, 8% 74%)",
            }}
            initial={{ x: -4, y: -4, opacity: 1, rotate: i * 42, scale: 1 }}
            animate={{
              x: Math.cos(a) * dist,
              y: Math.sin(a) * dist * 0.85 + 16,
              opacity: 0,
              rotate: i * 42 + 210,
              scale: 0.7,
            }}
            transition={{ duration: 0.62, delay, ease: "easeOut" }}
          />
        );
      })}
    </>
  );
}

/**
 * Where `el` sits inside `root`, in LAYOUT pixels — the sum of the offset chain
 * up to `root`. Unlike `getBoundingClientRect` this ignores every ancestor
 * TRANSFORM, so a board that is still arriving (a spring on `y`/`scale`) cannot
 * skew it: the token is a child of the same
 * container, so layout coordinates are exactly where it belongs. Returns null
 * if `root` is not in the element's offset chain (the caller falls back to
 * viewport rects).
 */
function offsetWithin(el, root) {
  let x = 0;
  let y = 0;
  let node = el;
  while (node && node !== root) {
    x += node.offsetLeft;
    y += node.offsetTop;
    node = node.offsetParent;
  }
  return node === root ? { x, y } : null;
}

/**
 * A seat's STANDING token: the player's profile picture sitting ON the tile
 * they are standing on, centred on that tile's glass — never beside the row.
 *
 * The tile is MEASURED rather than guessed, so the token stays centred on the
 * glass at every breakpoint.
 * Travelling between tiles is the jump overlay's job (it arcs from the previous
 * tile onto the clicked one); this is only the resting position, and it is
 * derived from the server's own history. The seat is hidden while its own jump
 * is in the air, so exactly one avatar is ever on the board for a seat.
 */
function BridgeToken({ boardRef, tileRefs, startRef, anchor, layoutKey, seat, mine, identity, name }) {
  const [placed, setPlaced] = useState(null);
  const anchorKey =
    anchor?.kind === "tile"
      ? `t:${anchor.row}:${anchor.tile}`
      : anchor?.kind ?? "none";

  useEffect(() => {
    const board = boardRef.current;
    const el =
      anchor?.kind === "tile"
        ? tileRefs.current?.[`${anchor.row}:${anchor.tile}`]
        : anchor?.kind === "start"
          ? startRef.current
          : null;
    if (!board || !el) {
      setPlaced(null);
      return;
    }
    // Layout first: immune to the board's entrance spring, so the token is on
    // its tile from its very first frame.
    const local = offsetWithin(el, board);
    if (local) {
      setPlaced({
        key: anchorKey,
        x: local.x + el.offsetWidth / 2,
        y: local.y + el.offsetHeight / 2,
      });
      return;
    }
    const b = board.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    setPlaced({
      key: anchorKey,
      x: r.left - b.left + r.width / 2,
      y: r.top - b.top + r.height / 2,
    });
  }, [
    boardRef,
    tileRefs,
    startRef,
    anchorKey,
    anchor?.kind,
    anchor?.row,
    anchor?.tile,
    layoutKey,
  ]);

  // Never paint a token at a tile it has already left while the new one is
  // being measured: the jump overlay is covering this seat at that moment.
  if (anchor?.kind === "crossed") return null;
  if (!placed || placed.key !== anchorKey) return null;

  return (
    <motion.span
      data-testid="lane-runner-token"
      data-token-seat={seat}
      data-token-row={anchor.kind === "tile" ? anchor.row : "start"}
      data-token-tile={anchor.kind === "tile" ? anchor.tile : -1}
      initial={false}
      animate={{ x: placed.x, y: placed.y }}
      transition={{ type: "spring", stiffness: 360, damping: 26 }}
      className="pointer-events-none absolute left-0 top-0 z-20"
      // The bridge stacks its planks with `space-y-*`, which adds a top margin
      // to every non-hidden sibling after the first — including this absolutely
      // positioned token. Zero it inline so the token's measured centre is its
      // real centre.
      style={{ margin: 0 }}
      title={mine ? "You are here" : `${name} is here`}
    >
      <span
        data-token-avatar="true"
        className={`block -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ${
          mine ? "ring-cyan-300/90" : "ring-rose-300/90"
        }`}
      >
        <FrameAvatar
          frame={identity?.profileFrame}
          iconKey={identity?.iconKey}
          name={name}
          size="h-7 w-7"
        />
      </span>
    </motion.span>
  );
}

/**
 * The player's JUMP, rendered from the SERVER's resolved action.
 *
 * It is pure presentation: the outcome (safe / fell / won) and the row/tile
 * come from the authoritative action history, never from anything the client
 * decides. It draws a lightweight avatar token over the bridge — the seat hops
 * OFF the tile it was standing on, arcs over the bridge and lands ON the tile
 * it clicked: an anticipation squash into a curved arc with a landing squash
 * for a SAFE jump, or a leap toward the bad tile followed by a fall-through, a
 * crack flash and a small glass shatter for a BAD one — then removes itself. It
 * is skipped entirely under reduced motion (and a SAFE jump's glass impact
 * rides the existing Tailwind/framer-motion primitives, no new engine).
 */
function JumpOverlay({ anim, boardRef, tileRefs, startRef, identity, name, onDone }) {
  const [coords, setCoords] = useState(null);
  const doneRef = useRef(false);
  const finish = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    onDone?.();
  };

  useEffect(() => {
    const board = boardRef.current;
    if (!board) {
      finish();
      return undefined;
    }
    const b = board.getBoundingClientRect();
    // A tile (or the start platform) in BOARD coordinates: the top-left for the
    // glass-break effects plus the centre the token travels to.
    const rectForAnchor = (anchor) => {
      const el =
        anchor?.kind === "tile"
          ? tileRefs.current?.[`${anchor.row}:${anchor.tile}`]
          : anchor?.kind === "start"
            ? startRef.current
            : null;
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        x: r.left - b.left,
        y: r.top - b.top,
        w: r.width,
        h: r.height,
        cx: r.left - b.left + r.width / 2,
        cy: r.top - b.top + r.height / 2,
      };
    };

    const target = rectForAnchor(anim.toAnchor);
    // A win hops UP off the top of the bridge, FROM the tile it was won on, so
    // the token must leave the span upward — never swoop back down toward
    // row 1.
    const standing = rectForAnchor(anim.fromAnchor);
    const fromRect = anim.outcome === "won" ? target : standing;
    if (!fromRect) {
      finish();
      return undefined;
    }
    const from = { x: fromRect.cx, y: fromRect.cy };
    let to = target ? { x: target.cx, y: target.cy } : from;
    let tileRect = null;
    if (anim.outcome === "fell") {
      // The tile it went through: the glass breaks there, on impact.
      if (target) {
        tileRect = { x: target.x, y: target.y, w: target.w, h: target.h };
        to = { x: target.cx, y: target.cy };
      }
    } else if (anim.outcome === "won") {
      to = { x: from.x, y: from.y - 34 };
    }
    setCoords({ from, to, tileRect });
    // Safety net: whatever happens to the animation, the overlay retires.
    // The fall now includes the delayed shatter (impact at 0.5s + 0.62s
    // shards), so the overlay must outlive it.
    const t = setTimeout(finish, anim.outcome === "fell" ? 1400 : 800);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anim]);

  if (!coords) return null;
  const { from, to, tileRect } = coords;
  const isFall = anim.outcome === "fell";
  const midX = (from.x + to.x) / 2;
  const ringClass =
    anim.seat === "player1" ? "ring-cyan-300/90" : "ring-rose-300/90";

  return (
    <div
      data-testid="lane-runner-jump"
      data-jump-seat={anim.seat}
      data-jump-outcome={anim.outcome}
      className="pointer-events-none absolute inset-0 z-30 overflow-visible"
    >
      {/* The glass breaks at the moment of impact, not when the fall starts:
          the token's tile contact lands at `times[2]` of its 0.8s arc, i.e.
          ~0.5s in. */}
      {isFall && tileRect && <GlassBreak tileRect={tileRect} delay={0.5} />}

      {/* the player token: anticipation → arc → landing squash (SAFE),
          or leap → fall-through (BAD) */}
      <motion.div
        className="absolute left-0 top-0"
        initial={{ x: from.x, y: from.y, rotate: 0, opacity: 1, scaleX: 1, scaleY: 1 }}
        animate={
          isFall
            ? {
                x: [from.x, midX, to.x, to.x],
                y: [from.y, from.y - 16, to.y, to.y + 72],
                rotate: [0, 10, -8, 52],
                opacity: [1, 1, 1, 0],
                scale: [1, 1.05, 0.95, 0.7],
              }
            : {
                x: [from.x, from.x, midX, to.x],
                y: [from.y, from.y + 4, from.y - 30, to.y],
                rotate: [0, 0, 10, 0],
                scaleX: [1, 1.15, 0.92, 1],
                scaleY: [1, 0.78, 1.12, 1],
              }
        }
        transition={{
          duration: isFall ? 0.8 : 0.58,
          times: isFall ? [0, 0.3, 0.62, 1] : [0, 0.2, 0.55, 1],
          ease: "easeInOut",
        }}
        onAnimationComplete={finish}
      >
        <span
          className={`block -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ${ringClass}`}
        >
          <FrameAvatar
            frame={identity?.profileFrame}
            iconKey={identity?.iconKey}
            name={name}
            size="h-8 w-8"
          />
        </span>
      </motion.div>

      {/* the small glass impact of a SAFE landing */}
      {!isFall && (
        <>
          <motion.span
            aria-hidden
            className="absolute rounded-full border-2 border-cyan-200/80"
            style={{ left: to.x - 16, top: to.y - 16, width: 32, height: 32 }}
            initial={{ scale: 0.3, opacity: 0.9 }}
            animate={{ scale: 1.8, opacity: 0 }}
            transition={{ duration: 0.5, delay: 0.42, ease: "easeOut" }}
          />
          {[0, 1, 2, 3, 4].map((i) => {
            const a = (i / 5) * Math.PI * 2;
            return (
              <motion.span
                key={`spark-${i}`}
                aria-hidden
                className="absolute h-1 w-1 rounded-full bg-cyan-100"
                style={{ left: to.x, top: to.y }}
                initial={{ x: 0, y: 0, opacity: 0.9 }}
                animate={{ x: Math.cos(a) * 20, y: Math.sin(a) * 18 - 6, opacity: 0 }}
                transition={{ duration: 0.5, delay: 0.42, ease: "easeOut" }}
              />
            );
          })}
        </>
      )}
    </div>
  );
}

export default function LaneRushDuelMatchPage({ params }) {
  const resolvedParams = typeof params?.then === "function" ? use(params) : params;
  const rawMatchId = resolvedParams?.matchId;
  const numericMatchId = Number(rawMatchId);
  const matchId = Number.isFinite(numericMatchId) ? numericMatchId : null;

  const router = useRouter();
  const posthog = usePostHog();
  const { user } = useUser();
  const { socket } = useSocket();
  const shouldReduce = useReducedMotion();

  const [match, setMatch] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [acting, setActing] = useState(false);
  const [resigning, setResigning] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [flagMode, setFlagMode] = useState(false);
  // The just-landed tile whose flag prompt the player dismissed (so it does
  // not nag). A new safe landing resets it.
  const [dismissedFlagKey, setDismissedFlagKey] = useState(null);
  // The countdown clock starts as `null` (not `Date.now()`) so the
  // server-rendered markup can't disagree with the first client render.
  const [now, setNow] = useState(null);
  // ms to add to the device clock to get the SERVER clock (serverNow −
  // clientNow at the moment the last payload landed). The 15s window is
  // set by the server, so the countdown is measured on the server clock.
  const [clockOffsetMs, setClockOffsetMs] = useState(0);
  const [syncFailures, setSyncFailures] = useState(0);
  // The one-off jump animation for a seat, keyed by a monotonic id. It is
  // driven ONLY by a newly-resolved server action (see the audio effects).
  const [jumpAnim, setJumpAnim] = useState(null);

  const mountedRef = useRef(false);
  const actingRef = useRef(false);
  const actionIdRef = useRef(0);
  const syncSeqRef = useRef(0);
  const syncAbortRef = useRef(null);
  // The newest match payload, readable from inside the bot's wake-up loop
  // (the loop outlives the render that started it).
  const matchRef = useRef(null);
  const expiredDeadlineRef = useRef(null);
  const jumpIdRef = useRef(0);
  const boardRef = useRef(null);
  const tileRefs = useRef({});
  // The start platform, so a seat that has not crossed a tile yet still has a
  // board position to stand on.
  const startRef = useRef(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Mirror the newest payload into a ref so the bot's wake-up loop (which
  // outlives the render that started it) always reads the LIVE board rather
  // than the closure it was created in.
  useEffect(() => {
    matchRef.current = match;
  }, [match]);

  // Re-measure the on-tile tokens whenever the board's geometry can have
  // changed, so a token can never settle off-centre.
  const [layoutRev, setLayoutRev] = useState(0);
  useEffect(() => {
    const bump = () => setLayoutRev((n) => n + 1);
    window.addEventListener("resize", bump);
    return () => window.removeEventListener("resize", bump);
  }, []);

  // A new matchId is a NEW duel — never inherit the previous one's state.
  useEffect(() => {
    setMatch(null);
    setError(null);
    setLoading(true);
    setActing(false);
    setFlagMode(false);
    setDismissedFlagKey(null);
    setSyncFailures(0);
    setClockOffsetMs(0);
    actingRef.current = false;
    syncSeqRef.current += 1;
    syncAbortRef.current?.abort();
    expiredDeadlineRef.current = null;
    jumpIdRef.current = 0;
    setJumpAnim(null);
  }, [matchId]);

  // ── Status polling (5s safety net) + socket live updates ─────────
  const fetchStatus = useCallback(async () => {
    if (!matchId) {
      if (mountedRef.current) setLoading(false);
      return null;
    }
    // Supersede any older in-flight reconcile: out-of-order responses are
    // the classic stale-state bug in a polled duel.
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
      const incoming = json.data.match;
      // Re-anchor the countdown to the server clock on EVERY payload (first
      // load, poll, reconnect), so "remaining time" is always
      // `roundDeadline − serverNow` rather than a device-clock guess.
      if (incoming?.serverNow) {
        const serverMs = new Date(incoming.serverNow).getTime();
        if (Number.isFinite(serverMs)) setClockOffsetMs(serverMs - Date.now());
      }
      setMatch(incoming);
      setError(null);
      setSyncFailures(0);
      setLoading(false);
      return incoming;
    } catch (err) {
      if (err?.name === "AbortError") return null;
      if (!mountedRef.current || seq !== syncSeqRef.current) return null;
      setSyncFailures((n) => n + 1);
      setLoading(false);
      return null;
    }
  }, [matchId]);

  useEffect(() => {
    fetchStatus();
    // The socket room pushes opponent updates instantly; this HTTP poll is
    // a reconcile/safety net. Pacing comes from server state + the local
    // 250ms clock, never from the poll rate.
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
  const isBotMatch = match?.player2Id === "AI_BOT";
  const isPlayer1 = match?.viewerIsPlayer1;
  const mySeat = isPlayer1 ? "player1" : "player2";
  const oppSeat = isPlayer1 ? "player2" : "player1";

  // ── Test vs Bot: keep waking the bot while IT owns the turn ──────
  //
  // The bot is paced SERVER-side (`BOT_ACTION_INTERVAL_MS`): a wake-up that
  // arrives inside that throttle applies NOTHING and still answers `success`.
  // A page that asked only ONCE therefore left the bot frozen for the rest of
  // its 15s window, so it lost the attempt to a timeout and reset to row 1 —
  // the AI "never plays". Worse, a safe tile KEEPS the bot's turn, so one ask
  // per state can never carry it across the bridge.
  //
  // So while the turn is the bot's, this keeps waking it on the shared
  // interval. Each ask carries an `actionId` keyed to (match, turn, action
  // count), which is exactly what the server dedupes on: a repeat of the SAME
  // state can never grant the bot a second action, while the next state is a
  // new ask. The loop stops the moment the turn is no longer the bot's — its
  // own fall, a timeout, or the duel ending.
  const botOwnsTurn =
    isBotMatch && !finished && !cancelled && match?.currentTurnUserId === "AI_BOT";
  const botAskUrl = matchId
    ? `/api/lane-rush-duel/match/${matchId}/ai-turn`
    : null;
  useEffect(() => {
    if (!botOwnsTurn || !botAskUrl) return undefined;
    let cancelled = false;
    let timer = null;

    const wake = async () => {
      if (cancelled || !mountedRef.current) return;
      // Read the LIVE board: between wake-ups the turn may already have moved
      // on (the bot's fall, a timeout resolved by the other tab, the duel
      // ending), and an ask is only ever made while the bot still owns it.
      const live = matchRef.current;
      if (!live || live.player2Id !== "AI_BOT") return;
      if (live.status === "finished" || live.status === "cancelled") return;
      if (live.currentTurnUserId !== "AI_BOT") return;

      const actionCount = Array.isArray(live.actions) ? live.actions.length : 0;
      const actionId = `${matchId}:bot:${live.currentTurnUserId}:${actionCount}`;
      try {
        const response = await fetch(botAskUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ actionId }),
        });
        const json = await response.json().catch(() => null);
        if (cancelled || !mountedRef.current) return;
        if (json?.success) {
          socket?.emit("room_event", {
            roomId: laneRushDuelMatchRoom(matchId),
            event: LANE_RUSH_DUEL_MATCH_UPDATED,
          });
        }
        // Resync on EVERY answer: a refusal (the bot no longer owns the turn)
        // and a throttled no-op both mean the next wake-up has to decide from
        // the authoritative board rather than this closure.
        await fetchStatus();
      } catch {
        if (cancelled || !mountedRef.current) return;
        await fetchStatus();
      }

      if (cancelled || !mountedRef.current) return;
      timer = setTimeout(wake, BOT_WAKE_INTERVAL_MS);
    };

    timer = setTimeout(wake, BOT_FIRST_WAKE_MS);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [botOwnsTurn, botAskUrl, matchId, socket, fetchStatus]);

  // ── Seat identity ────────────────────────────────────────────────
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
  const myNameColor = mySeatIdentity.nameColor;
  const oppNameColor = oppSeatIdentity.nameColor;
  const myNameEffect =
    cosmeticEffectClass(mySeatIdentity.profileFrame?.usernameEffect?.visual) || "";
  const oppNameEffect =
    cosmeticEffectClass(oppSeatIdentity.profileFrame?.usernameEffect?.visual) || "";

  // ── Bridge state (all server-derived, public) ────────────────────
  const bridgeRows = Number(match?.bridgeRows) || 10;
  const tileCount = Number(match?.tileCount) || 4;
  const myRow = Number(match?.myRow) || 0;
  const oppRow = Number(match?.oppRow) || 0;
  const myFlagsLeft = Number(match?.myFlagsLeft) || 0;
  const flagsPerPlayer = Number(match?.flagsPerPlayer) || 2;
  const isMyTurn = Boolean(match?.isViewerTurn);

  const brokenSet = useMemo(() => flagKeySet(match?.broken), [match?.broken]);
  const myFlagSet = useMemo(() => flagKeySet(match?.myFlags), [match?.myFlags]);
  const oppFlagSet = useMemo(() => flagKeySet(match?.oppFlags), [match?.oppFlags]);
  // Tiles I may flag: my own safe landings that are not flagged yet.
  const flaggableSet = useMemo(() => {
    const landed = safeLandingsFor(match?.actions, mySeat);
    const out = new Set();
    for (const k of landed) if (!myFlagSet.has(k)) out.add(k);
    return out;
  }, [match?.actions, mySeat, myFlagSet]);

  // The tile THIS player most recently landed on safely — the natural place
  // to offer a memory flag. Derived from the server's own action history, so
  // an untested tile can never qualify.
  const mySafeLanding = useMemo(() => {
    const actions = Array.isArray(match?.actions) ? match.actions : [];
    for (let i = actions.length - 1; i >= 0; i -= 1) {
      const a = actions[i];
      if (!a || a.seat !== mySeat) continue;
      if (a.action !== "jump") continue;
      if (a.outcome !== "safe" && a.outcome !== "won") continue;
      const r = Number(a.row);
      const t = Number(a.tile);
      if (!Number.isInteger(r) || !Number.isInteger(t)) continue;
      return { row: r, tile: t, key: key(r, t) };
    }
    return null;
  }, [match?.actions, mySeat]);

  // Offer the flag only when it is genuinely allowed: budget left, not yet
  // flagged, match live, and not dismissed for that tile.
  const canFlagLanding = Boolean(
    mySafeLanding &&
      !finished &&
      !cancelled &&
      myFlagsLeft > 0 &&
      !myFlagSet.has(mySafeLanding.key) &&
      dismissedFlagKey !== mySafeLanding.key,
  );

  const myTiles = useMemo(
    () => Array.from({ length: bridgeRows }, (_, row) => row).reverse(),
    [bridgeRows],
  );

  // ── The newest MOVEMENT (a jump or a timeout — a flag is not movement) ─
  // Read from the authoritative action history so BOTH seats' latest movement
  // and result stay visible on the board. Presentation only.
  const lastMovement = useMemo(() => {
    const actions = Array.isArray(match?.actions) ? match.actions : [];
    for (let i = actions.length - 1; i >= 0; i -= 1) {
      const a = actions[i];
      if (a && a.action !== "flag") return a;
    }
    return null;
  }, [match?.actions]);

  const lastMovementText = useMemo(() => {
    const a = lastMovement;
    if (!a) return null;
    const mine = a.seat === mySeat;
    const who = mine ? "You" : oppDisplayName;
    if (a.outcome === "fell") return `${who} hit a broken tile — back to row 1`;
    if (a.action === "timeout" || a.outcome === "timed_out")
      return `${who} ran out of time — back to row 1`;
    if (a.outcome === "won") return `${who} crossed row ${bridgeRows} and won`;
    if (a.outcome === "safe")
      return `${who} crossed to row ${Math.max(1, mine ? myRow : oppRow)}`;
    return null;
  }, [lastMovement, mySeat, oppDisplayName, bridgeRows, myRow, oppRow]);

  const deadlineMs = match?.roundDeadline
    ? new Date(match.roundDeadline).getTime()
    : null;
  const serverNowMs = now === null ? null : now + clockOffsetMs;
  const secondsLeft =
    deadlineMs && serverNowMs
      ? Math.max(0, Math.ceil((deadlineMs - serverNowMs) / 1000))
      : null;

  // ── The 15s window belongs to the server ─────────────────────────
  // When the live window reaches 0, ASK THE SERVER (the same GET the 5s
  // safety poll makes). Nothing is decided here: the server re-compares
  // `roundDeadline` against its OWN clock and ends the attempt. Deduped
  // per deadline so a stalled or skewed client cannot hammer the endpoint;
  // either seat may nudge — the timed-out player's tab, or the opponent's
  // if that tab is gone.
  const livePhase =
    match?.status === "active" ||
    match?.status === "p1_turn" ||
    match?.status === "p2_turn";
  useEffect(() => {
    if (!livePhase || !match?.currentTurnUserId || !deadlineMs) return;
    if (secondsLeft === null || secondsLeft > 0) return;
    if (expiredDeadlineRef.current === deadlineMs) return;
    expiredDeadlineRef.current = deadlineMs;
    fetchStatus();
  }, [livePhase, match?.currentTurnUserId, deadlineMs, secondsLeft, fetchStatus]);

  // ── Audio: the tile shattering ────────────────────────────────────
  // The glass gives way at the END of the fall, not when the action resolves:
  // the jump overlay's impact lands ~0.5s into the arc, so the crack has to be
  // scheduled to that same beat or it would sound while the token is still in
  // the air. Reduced motion skips the fall animation entirely — the tile breaks
  // immediately — so the sound fires with it. (Same 0.5s impact constant the
  // overlay uses; see <GlassBreak>.)
  const GLASS_BREAK_IMPACT_MS = 500;
  const playBreakAtImpact = useCallback(
    (quieter = false) => {
      const fire = () => {
        if (!mountedRef.current) return;
        // A rival's break is mixed down so it can never be mistaken for yours.
        playGlassBreak(quieter ? 0.6 : 1);
      };
      if (shouldReduce) {
        fire();
        return;
      }
      setTimeout(fire, GLASS_BREAK_IMPACT_MS);
    },
    [shouldReduce],
  );

  // ── Audio: the viewer's own resolution ───────────────────────────
  const myLastAction = useMemo(
    () => lastActionFor(match?.actions, mySeat, (a) => a.action !== "flag"),
    [match?.actions, mySeat],
  );
  const myActionKey = myLastAction
    ? [myLastAction.action, myLastAction.row, myLastAction.tile, myLastAction.at].join(":")
    : null;
  const mySeenKeyRef = useRef(null);
  useEffect(() => {
    if (!match) return;
    if (mySeenKeyRef.current === null) {
      mySeenKeyRef.current = myActionKey;
      return;
    }
    if (!myActionKey || myActionKey === mySeenKeyRef.current) return;
    mySeenKeyRef.current = myActionKey;
    const a = myLastAction;
    if (!a) return;
    if (a.action === "timeout" || a.outcome === "timed_out") {
      // A timeout breaks no tile — it keeps the buzz.
      playBuzz();
    } else if (a.outcome === "safe" || a.outcome === "won") {
      playSafePick();
    } else if (a.outcome === "fell") {
      // You went through the glass.
      playBreakAtImpact();
    }
    // The jump is a visual echo of the SERVER's resolved action — it reads the
    // outcome from the history and never influences the game state.
    if (
      !shouldReduce &&
      (a.outcome === "safe" || a.outcome === "fell" || a.outcome === "won")
    ) {
      const id = (jumpIdRef.current += 1);
      setJumpAnim({
        id,
        seat: mySeat,
        outcome: a.outcome,
        fromRow: Math.max(0, Math.min(bridgeRows - 1, Number(a.row) || 0)),
        tile: Number(a.tile),
        // The tile it CLICKED: where the hop lands, and the tile the seat now
        // stands on. For a fall this is the glass it goes through.
        toAnchor: {
          kind: "tile",
          row: Math.max(0, Math.min(bridgeRows - 1, Number(a.row) || 0)),
          tile: Number(a.tile),
        },
        // The tile (or start platform) it was standing on when it clicked, so
        // the arc leaves the board instead of starting mid-air.
        fromAnchor: ballAnchorFor({
          actions: historyBefore(match?.actions, a),
          seat: mySeat,
          row: Number(a.row) || 0,
          rows: bridgeRows,
        }),
      });
    }
  }, [match, myActionKey, myLastAction, shouldReduce, mySeat, bridgeRows, playBreakAtImpact]);

  // ── Audio: the opponent's resolution ─────────────────────────────
  const oppLastResolved = useMemo(
    () => lastActionFor(match?.actions, oppSeat, (a) => a.action !== "flag"),
    [match?.actions, oppSeat],
  );
  const oppActionKey = oppLastResolved
    ? [
        oppLastResolved.action,
        oppLastResolved.row,
        oppLastResolved.tile,
        oppLastResolved.at,
      ].join(":")
    : null;
  // The last opponent action already reacted to. `null` = the first snapshot
  // (history is the baseline, never "news"), so a poll/socket re-delivery of
  // the SAME action neither replays the cue nor re-runs the jump animation.
  const oppSeenKeyRef = useRef(null);
  useEffect(() => {
    if (!match) return;
    if (oppSeenKeyRef.current === null) {
      oppSeenKeyRef.current = oppActionKey;
      return;
    }
    if (!oppActionKey || oppActionKey === oppSeenKeyRef.current) return;
    oppSeenKeyRef.current = oppActionKey;
    const a = oppLastResolved;
    if (!a) return;
    if (a.outcome === "timed_out") playOpponentBust();
    else if (a.outcome === "fell") playBreakAtImpact(true);
    else if (a.outcome === "safe" || a.outcome === "won") playOpponentPick();
    if (
      !shouldReduce &&
      (a.outcome === "safe" || a.outcome === "fell" || a.outcome === "won")
    ) {
      const id = (jumpIdRef.current += 1);
      setJumpAnim({
        id,
        seat: oppSeat,
        outcome: a.outcome,
        fromRow: Math.max(0, Math.min(bridgeRows - 1, Number(a.row) || 0)),
        tile: Number(a.tile),
        toAnchor: {
          kind: "tile",
          row: Math.max(0, Math.min(bridgeRows - 1, Number(a.row) || 0)),
          tile: Number(a.tile),
        },
        fromAnchor: ballAnchorFor({
          actions: historyBefore(match?.actions, a),
          seat: oppSeat,
          row: Number(a.row) || 0,
          rows: bridgeRows,
        }),
      });
    }
  }, [match, oppActionKey, oppLastResolved, shouldReduce, oppSeat, bridgeRows, playBreakAtImpact]);

  // ── Actions ──────────────────────────────────────────────────────
  const doAction = useCallback(
    async (action, row, tile) => {
      if (actingRef.current) return;
      if (!matchId) return;
      actingRef.current = true;
      setActing(true);
      setError(null);
      const actionId = `${matchId}:${mySeat}:${Date.now()}:${(actionIdRef.current += 1)}`;
      const send = () =>
        fetch(`/api/lane-rush-duel/match/${matchId}/act`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ action, row, tile, actionId }),
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
          // 409 = the board moved on under us (or the window expired):
          // reconcile immediately so the board matches the server again.
          if (res.status === 409) {
            setFlagMode(false);
            await fetchStatus();
          }
          return;
        }
        posthog?.capture("lane_rush_duel_action", {
          match_id: matchId,
          action,
          row,
          tile,
        });
        socket?.emit("room_event", {
          roomId: laneRushDuelMatchRoom(matchId),
          event: LANE_RUSH_DUEL_MATCH_UPDATED,
        });
        await fetchStatus();
      } catch {
        if (mountedRef.current) {
          setError("Network error — your action was not sent. Try again.");
        }
      } finally {
        actingRef.current = false;
        if (mountedRef.current) setActing(false);
      }
    },
    [matchId, mySeat, posthog, socket, fetchStatus],
  );

  const onTileClick = useCallback(
    (row, tile) => {
      const k = key(row, tile);
      if (flagMode) {
        if (!flaggableSet.has(k)) return;
        playSelect();
        setFlagMode(false);
        doAction("flag", row, tile);
        return;
      }
      if (!isMyTurn || row !== myRow) return;
      if (brokenSet.has(k)) return;
      playSelect();
      doAction("jump", row, tile);
    },
    [flagMode, flaggableSet, isMyTurn, myRow, brokenSet, doAction],
  );

  const cancelLobby = useCallback(async () => {
    if (cancelling || !matchId) return;
    setCancelling(true);
    setError(null);
    try {
      const res = await fetch(`/api/lane-rush-duel/match/${matchId}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        setError(json.error || "Cancel failed");
        return;
      }
      router.push("/casino/lane-runner");
    } catch {
      if (mountedRef.current) setError("Network error — could not cancel.");
    } finally {
      if (mountedRef.current) setCancelling(false);
    }
  }, [cancelling, matchId, router]);

  const handleResign = useCallback(async () => {
    if (resigning || !matchId) return;
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
      if (mountedRef.current) setError("Network error — could not resign.");
    } finally {
      if (mountedRef.current) setResigning(false);
    }
  }, [matchId, posthog, resigning, socket, fetchStatus]);

  // ── Result ───────────────────────────────────────────────────────
  const wonMatch = finished && match?.winnerId === user?.id;
  const drawMatch = finished && match?.result === "draw";
  const lostMatch = finished && match?.winnerId && match.winnerId !== user?.id;
  const resignedEnd = wasResigned(match?.actions);
  const stakeNumber = Number(match?.stakeAmount) || 0;
  const durationSeconds = useMemo(() => {
    if (!match?.startedAt || !match?.endedAt) return null;
    const ms =
      new Date(match.endedAt).getTime() - new Date(match.startedAt).getTime();
    return Number.isFinite(ms) && ms > 0 ? Math.round(ms / 1000) : null;
  }, [match?.startedAt, match?.endedAt]);

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

  const resultScreenProps = finished
    ? {
        outcome: drawMatch ? "draw" : wonMatch ? "win" : "loss",
        headline: drawMatch
          ? "Both players receive their stake back"
          : wonMatch
            ? resignedEnd
              ? "Opponent resigned — the pot is yours"
              : `You crossed the bridge in ${myRow} rows`
            : resignedEnd
              ? "You resigned — the pot went to your opponent"
              : `${oppDisplayName} crossed row 10 first`,
        gameName: "Lane Rush Duel",
        opponent: {
          name: oppDisplayName,
          iconKey: oppSeatIdentity.iconKey,
          profileFrame: oppSeatIdentity.profileFrame,
          isAi: isBotMatch,
        },
        tokenDelta: drawMatch
          ? 0
          : wonMatch
            ? Number(match?.prizePaid || 0) - stakeNumber
            : -stakeNumber,
        durationSeconds,
        sides: [
          { name: "You", score: `${myRow}/${bridgeRows}`, highlight: !drawMatch && wonMatch },
          {
            name: oppDisplayName,
            score: `${oppRow}/${bridgeRows}`,
            highlight: !drawMatch && !wonMatch,
          },
        ],
        details: [
          ...(match?.id != null ? [{ label: "Match ID", value: String(match.id) }] : []),
          { label: "Stake", value: `${stakeNumber.toLocaleString()} tokens` },
          { label: "Winner", value: drawMatch ? "Draw" : wonMatch ? "You" : oppDisplayName },
          {
            label: "Won by",
            value: drawMatch
              ? "Neither crossed"
              : resignedEnd
                ? "Resignation"
                : "Crossed row 10",
          },
          {
            label: "Tiles broken",
            value: String(brokenSet.size),
          },
        ],
        playAgain: { onClick: () => router.push("/casino/lane-runner") },
        onReturnToLobby: () => router.push("/casino"),
      }
    : null;
  const matchEndPopup = resultScreenProps ? (
    <PvpResultScreen open {...resultScreenProps} />
  ) : null;
  const matchEndPopupCompact = resultScreenProps ? (
    <PvpResultScreen open compact {...resultScreenProps} />
  ) : null;

  // ── Status chip ──────────────────────────────────────────────────
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
    statusChip = {
      text: drawMatch ? "DRAW" : wonMatch ? "YOU WIN" : "YOU LOSE",
      cls: drawMatch
        ? "bg-amber-400/25 text-amber-200"
        : wonMatch
          ? "bg-emerald-400/25 text-emerald-200"
          : "bg-rose-500/25 text-rose-200",
    };
  } else if (isMyTurn) {
    statusChip = { text: "Your turn", cls: "bg-cyan-400/25 text-cyan-100" };
  } else {
    statusChip = { text: "Opponent's turn", cls: "bg-white/10 text-white/70" };
  }

  // ── The board — a floating glass bridge ──────────────────────────
  // Each row is a suspended plank of semi-transparent glass tiles. A player's
  // profile picture sits ON THE TILE that player is standing on — the tile they
  // clicked to get to their row — so the bridge shows both seats' progress TILE
  // BY TILE rather than floating beside it. Broken tiles are cracked and red
  // for the rest of the match; flags are drawn for BOTH players. Untouched
  // tiles are pixel-identical — safe/bad is never hinted at.
  const myAnchor = ballAnchorFor({
    actions: match?.actions,
    seat: mySeat,
    row: myRow,
    rows: bridgeRows,
  });
  const oppAnchor = ballAnchorFor({
    actions: match?.actions,
    seat: oppSeat,
    row: oppRow,
    rows: bridgeRows,
  });
  // A seat whose jump is in the air is drawn by the overlay instead, so exactly
  // one avatar is ever standing on the board for a seat. Keyed on the SEATS,
  // not on "player1", so a player sitting in seat 2 hides its own token while
  // its own jump plays.
  const myTokenVisible = jumpAnim?.seat !== mySeat;
  const oppTokenVisible = jumpAnim?.seat !== oppSeat;
  const layoutKey = `${layoutRev}:${bridgeRows}:${tileCount}`;

  // Glass is intact until it is struck. While a fall is in flight, the tile the
  // token is falling through keeps its unbroken styling; the shattered state
  // appears exactly as the impact animation lands (~0.5s), so the tile reads as
  // breaking ON impact instead of already being broken when the jump starts.
  //
  // Only a FRESHLY broken tile is held back — a repeat visit to a tile that was
  // already broken must keep showing it as broken. `prevBrokenRef` carries the
  // broken set from the previous server snapshot, which is exactly the set as
  // it stood before this jump.
  const prevBrokenRef = useRef(brokenSet);
  useEffect(() => {
    prevBrokenRef.current = brokenSet;
  }, [brokenSet]);

  const [pendingBreakKey, setPendingBreakKey] = useState(null);
  useEffect(() => {
    const clear = () => setPendingBreakKey((cur) => (cur === null ? cur : null));
    if (jumpAnim?.outcome !== "fell") {
      clear();
      return undefined;
    }
    const k = key(jumpAnim.fromRow, jumpAnim.tile);
    if (prevBrokenRef.current?.has(k)) {
      clear();
      return undefined;
    }
    setPendingBreakKey(k);
    const timer = setTimeout(() => setPendingBreakKey(null), 520);
    return () => clearTimeout(timer);
  }, [jumpAnim]);

  const board = (
    <motion.div
      initial={shouldReduce ? false : { opacity: 0, y: 18, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ type: "spring", stiffness: 120, damping: 18 }}
      // The planks settle as the board arrives; the on-tile tokens measure the
      // glass, so they re-measure once that motion has finished.
      onAnimationComplete={() => setLayoutRev((n) => n + 1)}
      className="relative"
    >
      {/* Suspension rails the planks hang from */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-4 left-3 w-px bg-gradient-to-b from-cyan-200/60 via-white/10 to-cyan-200/10"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-4 right-3 w-px bg-gradient-to-b from-cyan-200/10 via-white/10 to-cyan-200/60"
      />

      {/* The bridge is SUSPENDED, not looping: the glass slab, rails and
          under-glow give it the floating look without perpetual board motion
          (which would also make the tiles impossible to click reliably). */}
      <div ref={boardRef} className="relative space-y-1.5 px-1.5">
        {/* Summit */}
        <div className="flex items-center justify-center gap-1.5 pb-1 text-[10px] font-black uppercase tracking-[0.2em] text-amber-200/80">
          <IconTrophy size={13} className="text-amber-300" />
          Summit · cross row {bridgeRows} to win
        </div>

        {myTiles.map((row) => {
          // Top-first render: the LAST row index (10) is the top of the
          // screen, so the summit is `bridgeRows - 1` — never row 1.
          const isGoal = row === bridgeRows - 1;
          // The row a seat chooses on is exactly `seatRow` (row index ===
          // rows crossed). The server gates the click on the same value.
          const isMyRow = row === myRow;
          const activeRow = isMyTurn && isMyRow && !finished && !cancelled;
          return (
            <div
              key={row}
              data-lane-row={row}
              data-goal={isGoal ? "true" : "false"}
              className={`relative flex items-center gap-1.5 rounded-none px-1 py-1 transition ${
                isGoal
                  ? "bg-amber-400/[0.06]"
                  : activeRow
                    ? "bg-cyan-400/10 shadow-[0_0_26px_-12px_rgba(34,211,238,0.9)]"
                    : ""
              }`}
            >
              <span
                className={`w-6 shrink-0 text-center text-[10px] font-black ${
                  isGoal
                    ? "text-amber-300"
                    : activeRow
                      ? "text-cyan-200"
                      : "text-white/35"
                }`}
                title={
                  isGoal ? `Row ${row + 1} — the top of the bridge` : `Row ${row + 1}`
                }
              >
                {row + 1}
              </span>

              <div className="flex flex-1 flex-wrap items-center justify-center gap-1.5">
                {Array.from({ length: tileCount }, (_, tile) => {
                  const k = key(row, tile);
                  const broken = brokenSet.has(k) && k !== pendingBreakKey;
                  const myFlag = myFlagSet.has(k);
                  const oppFlag = oppFlagSet.has(k);
                  const flaggableNow = flagMode && flaggableSet.has(k);
                  const actionable = flagMode
                    ? flaggableNow
                    : activeRow && !broken;
                  return (
                    <button
                      key={tile}
                      ref={(el) => {
                        if (el) tileRefs.current[k] = el;
                        else delete tileRefs.current[k];
                      }}
                      type="button"
                      onClick={() => onTileClick(row, tile)}
                      disabled={!actionable || acting}
                      aria-label={
                        broken
                          ? `Row ${row + 1} tile ${tile + 1} — broken`
                          : myFlag
                            ? `Row ${row + 1} tile ${tile + 1} — your flag`
                            : oppFlag
                              ? `Row ${row + 1} tile ${tile + 1} — opponent flag`
                              : `Row ${row + 1} tile ${tile + 1}`
                      }
                      className={`group relative h-12 w-12 shrink-0 overflow-hidden rounded-none border-2 text-[11px] font-black backdrop-blur-sm transition duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 sm:h-14 sm:w-14 ${
                        broken
                          ? "border-rose-400/70 bg-rose-950/60 text-rose-200/80 shadow-[inset_0_1px_0_rgba(255,255,255,0.15)]"
                          : myFlag && oppFlag
                            ? "border-violet-300/80 bg-violet-400/15 text-white shadow-[0_0_16px_-4px_rgba(196,181,253,0.9)]"
                            : myFlag
                              ? "border-amber-300/80 bg-amber-400/20 text-white shadow-[0_0_16px_-4px_rgba(251,191,36,0.95)]"
                              : oppFlag
                                ? "border-rose-300/80 bg-rose-400/20 text-white shadow-[0_0_16px_-4px_rgba(251,113,133,0.95)]"
                                : flaggableNow
                              ? "cursor-pointer border-amber-300/70 bg-amber-400/15 text-amber-100 shadow-[0_0_18px_-4px_rgba(251,191,36,0.7),inset_0_1px_0_rgba(255,255,255,0.4)]"
                              : actionable
                                ? "cursor-pointer border-cyan-200/45 bg-white/10 text-white/85 shadow-[inset_0_1px_0_rgba(255,255,255,0.4),0_10px_22px_-16px_rgba(34,211,238,0.9)] hover:border-cyan-200/90 hover:bg-white/20 hover:shadow-[0_0_22px_-4px_rgba(34,211,238,0.7),inset_0_1px_0_rgba(255,255,255,0.5)]"
                                : "border-white/15 bg-white/[0.05] text-white/45 shadow-[inset_0_1px_0_rgba(255,255,255,0.28)]"
                      }`}
                    >
                      {/* Bright glass edge reflection */}
                      <span
                        aria-hidden
                        className="pointer-events-none absolute -left-1/3 top-0 h-[200%] w-1/2 rotate-[16deg] bg-gradient-to-r from-white/0 via-white/25 to-white/0 opacity-60 transition-opacity group-hover:opacity-90"
                      />
                      {broken ? (
                        /* Shattered glass, permanently: a crack web radiating
                           from the impact point plus translucent shards, so
                           a dead tile reads as broken glass at a glance. */
                        <span
                          aria-hidden
                          className="pointer-events-none absolute inset-0"
                        >
                          <span className="absolute inset-0 bg-[radial-gradient(circle_at_50%_50%,rgba(255,255,255,0.20),transparent_62%)]" />
                          {[-104, -62, -26, 14, 52, 86].map((deg, i) => (
                            <span
                              key={`broke-crack-${i}`}
                              className="absolute left-1/2 top-1/2 h-px w-[125%] origin-left bg-white/55"
                              style={{ transform: `translateY(-50%) rotate(${deg}deg)` }}
                            />
                          ))}
                          <span className="absolute left-[16%] top-[20%] h-2 w-2 rotate-45 bg-white/25" />
                          <span className="absolute bottom-[18%] right-[14%] h-2.5 w-1.5 -rotate-12 bg-white/20" />
                          <span className="absolute bottom-[12%] left-[34%] h-1.5 w-1.5 rotate-12 bg-white/25" />
                          <IconX
                            size={16}
                            className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-rose-200/90"
                          />
                        </span>
                      ) : (
                        <>
                          {/* The tile number stays readable, dimmed when a
                              flag sits on the tile. */}
                          <span
                            className={`relative z-10 ${
                              myFlag || oppFlag ? "opacity-45" : ""
                            }`}
                          >
                            {tile + 1}
                          </span>
                          {/* Memory flags are a first-class board object, not
                              a corner badge: a large glowing flag centred on
                              the tile. Public to both players — yours amber,
                              the opponent's rose, both violet. */}
                          {(myFlag || oppFlag) && (
                            <span
                              aria-hidden
                              className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center gap-0.5"
                            >
                              {oppFlag && (
                                <IconFlag
                                  size={18}
                                  stroke={2.4}
                                  className="text-rose-300 drop-shadow-[0_0_5px_rgba(251,113,133,0.95)]"
                                />
                              )}
                              {myFlag && (
                                <IconFlag
                                  size={18}
                                  stroke={2.4}
                                  className="text-amber-300 drop-shadow-[0_0_5px_rgba(251,191,36,0.95)]"
                                />
                              )}
                            </span>
                          )}
                        </>
                      )}
                    </button>
                  );
                })}
              </div>

            </div>
          );
        })}

        {/* Start platform — the board position a seat stands on before it has
            crossed its first tile. */}
        <div
          ref={startRef}
          data-lane-start="true"
          className="flex items-center justify-center gap-1.5 pt-1 text-[10px] font-black uppercase tracking-[0.2em] text-white/40"
        >
          Start · row 1
        </div>

        {/* The standings: one avatar per seat, sitting ON the tile that seat is
            standing on. Never blocks a tap. */}
        {myTokenVisible && (
          <BridgeToken
            boardRef={boardRef}
            tileRefs={tileRefs}
            startRef={startRef}
            anchor={myAnchor}
            layoutKey={layoutKey}
            seat={mySeat}
            mine
            identity={mySeatIdentity}
            name={myDisplayName}
          />
        )}
        {oppTokenVisible && (
          <BridgeToken
            boardRef={boardRef}
            tileRefs={tileRefs}
            startRef={startRef}
            anchor={oppAnchor}
            layoutKey={layoutKey}
            seat={oppSeat}
            identity={oppSeatIdentity}
            name={oppDisplayName}
          />
        )}
      </div>

      {jumpAnim && (
        <JumpOverlay
          key={jumpAnim.id}
          anim={jumpAnim}
          boardRef={boardRef}
          tileRefs={tileRefs}
          startRef={startRef}
          identity={
            jumpAnim.seat === "player1" ? mySeatIdentity : oppSeatIdentity
          }
          name={jumpAnim.seat === "player1" ? myDisplayName : oppDisplayName}
          onDone={() =>
            setJumpAnim((cur) => (cur && cur.id === jumpAnim.id ? null : cur))
          }
        />
      )}
    </motion.div>
  );

  const players = (
    <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
      <BridgeSeat
        isSelf
        name={myDisplayName}
        nameColor={myNameColor}
        nameEffect={myNameEffect}
        identity={mySeatIdentity}
        row={myRow}
        total={bridgeRows}
        flagsLeft={myFlagsLeft}
        flagsTotal={flagsPerPlayer}
        isTurn={isMyTurn && !finished && !cancelled}
      />
      <BridgeSeat
        isSelf={false}
        name={oppDisplayName}
        nameColor={oppNameColor}
        nameEffect={oppNameEffect}
        identity={oppSeatIdentity}
        row={oppRow}
        total={bridgeRows}
        flagsLeft={Number(match?.oppFlagsLeft) || 0}
        flagsTotal={flagsPerPlayer}
        isTurn={!isMyTurn && livePhase && !finished && !cancelled}
      />
    </div>
  );

  // ── The post-landing memory-flag offer ──────────────────────────
  // Shown right after YOU land safely on a tile, so a flag can be placed then
  // and there. The server still decides whether it is valid.
  const flagPrompt = canFlagLanding ? (
    <div
      data-testid="lane-runner-flag-prompt"
      className="flex items-center gap-2 rounded-2xl border border-amber-300/40 bg-amber-400/10 px-3 py-2 backdrop-blur-md"
    >
      <IconFlag size={14} className="shrink-0 text-amber-300" />
      <p className="min-w-0 flex-1 text-[11px] font-semibold text-amber-100">
        Landed safely on row {mySafeLanding.row + 1} — mark it?
      </p>
      <button
        type="button"
        data-testid="lane-runner-flag-place"
        onClick={() => {
          playSelect();
          setDismissedFlagKey(mySafeLanding.key);
          setFlagMode(false);
          doAction("flag", mySafeLanding.row, mySafeLanding.tile);
        }}
        className="shrink-0 rounded-lg border border-amber-300/60 bg-amber-400/20 px-2.5 py-1 text-[10px] font-black uppercase tracking-wider text-amber-50 transition hover:bg-amber-400/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300"
      >
        Place flag
      </button>
      <button
        type="button"
        onClick={() => setDismissedFlagKey(mySafeLanding.key)}
        aria-label="Dismiss flag prompt"
        className="shrink-0 rounded-lg border border-white/15 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-white/50 transition hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
      >
        No
      </button>
    </div>
  ) : null;

  const controls = (
    <div className="space-y-3">
      {flagPrompt}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid="lane-runner-flag-toggle"
          onClick={() => {
            playSelect();
            setFlagMode((on) => !on);
          }}
          disabled={
            finished ||
            cancelled ||
            myFlagsLeft <= 0 ||
            flaggableSet.size === 0 ||
            acting
          }
          className={`inline-flex items-center gap-1.5 rounded-xl border px-4 py-2 text-xs font-black uppercase tracking-wider transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300 disabled:opacity-40 ${
            flagMode
              ? "border-amber-300 bg-amber-400/30 text-amber-50"
              : "border-amber-300/50 bg-amber-400/10 text-amber-200 hover:bg-amber-400/20"
          }`}
        >
          <IconFlag size={13} />
          {flagMode ? "Pick a tile you landed on" : "Place memory flag"}
        </button>
        <span className="text-[10px] text-white/45">
          {myFlagsLeft}/{flagsPerPlayer} flags left · both players can see flags
        </span>
      </div>
      {!cancelled && !finished && !isBotMatch && (
        <button
          type="button"
          onClick={handleResign}
          disabled={resigning}
          className="w-full rounded-2xl border border-red-500/40 bg-red-500/10 py-2.5 text-xs font-black uppercase tracking-wider text-red-300 transition hover:bg-red-500/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300 disabled:opacity-50"
        >
          {resigning ? "Resigning…" : "Resign match"}
        </button>
      )}
      {isBotMatch && !finished && (
        <p className="text-center text-[10px] text-white/40">
          Practice match — no stake.
        </p>
      )}
    </div>
  );

  // ── Turn banner — the single, unmistakable "whose turn" read-out ──
  const turnBanner =
    finished || cancelled ? null : (
      <div
        role="status"
        aria-live="polite"
        className={`flex w-full items-center gap-3 rounded-2xl border px-3 py-2.5 backdrop-blur-md ${
          isMyTurn
            ? "border-cyan-300/60 bg-cyan-400/10 shadow-[0_0_30px_-10px_rgba(34,211,238,0.7)]"
            : "border-white/12 bg-white/[0.04]"
        }`}
      >
        <span
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-base font-black ${
            isMyTurn ? "bg-cyan-300 text-black" : "bg-white/10 text-white/60"
          }`}
        >
          {isMyTurn ? "!" : "…"}
        </span>
        <div className="min-w-0 flex-1">
          <p
            className={`text-sm font-black uppercase tracking-wide ${
              isMyTurn ? "text-cyan-100" : "text-white/80"
            }`}
          >
            {isMyTurn ? "Your turn" : "Opponent's turn"}
          </p>
          <p className="truncate text-[11px] text-white/55">
            {isMyTurn
              ? `Pick a tile on row ${Math.min(myRow + 1, bridgeRows)}${
                  secondsLeft !== null ? ` · ${secondsLeft}s to decide` : ""
                }`
              : `Waiting for ${oppDisplayName} to cross their row…`}
          </p>
        </div>
        {lastMovementText && (
          <p className="hidden max-w-[42%] truncate text-right text-[10px] font-semibold text-white/45 sm:block">
            {lastMovementText}
          </p>
        )}
      </div>
    );

  const desktopContent = (
    <div className="space-y-4">
      {matchEndPopup}
      {players}
      {turnBanner}
      <div className="relative rounded-[26px] border border-white/10 bg-gradient-to-b from-white/[0.07] to-white/[0.02] p-2 shadow-[0_36px_80px_-40px_rgba(34,211,238,0.5)] backdrop-blur-md">
        {board}
      </div>
      {controls}
      <p className="text-center text-[10px] leading-relaxed text-white/45">
        Safe tile → keep going, same turn, timer resets. Bad tile → it stays
        broken and you restart at row 1. First to cross row 10 wins.
      </p>
    </div>
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
              ? "You both cross the SAME bridge — get ready!"
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

        <div className="mx-auto mt-4 max-w-2xl px-3 sm:px-4">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <button
                onClick={() => router.push("/casino/lane-runner")}
                className="rounded-lg border border-white/15 bg-black/30 p-2 text-white/70 transition hover:border-cyan-300/40 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300"
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
                  bridge ·{" "}
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
                <TimerRing secondsLeft={secondsLeft} active={isMyTurn} />
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

          {cancelled && (
            <div className="rounded-3xl border border-red-400/30 bg-slate-900/60 py-16 text-center">
              <p className="text-lg font-black text-red-200">
                This lobby was cancelled
              </p>
              <button
                onClick={() => router.push("/casino/lane-runner")}
                className="mt-4 rounded-xl bg-cyan-400 px-5 py-2 text-sm font-bold text-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-200"
              >
                Back to Lobby
              </button>
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
                  : "You both cross the SAME bridge — 10 rows with one bad tile each. A safe tile keeps your turn; a bad tile breaks for good and sends you back to row 1."}
              </p>
              <div className="mt-6 flex items-center gap-3">
                {match?.status === "waiting" && match?.player1Id === user?.id && (
                  <button
                    onClick={cancelLobby}
                    disabled={cancelling}
                    className="rounded-xl border border-red-400/40 bg-red-500/15 px-5 py-2.5 text-sm font-bold text-red-200 transition hover:bg-red-500/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300 disabled:opacity-50"
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
                    className="rounded-xl border border-cyan-300/40 bg-cyan-400/10 px-5 py-2.5 text-sm font-bold text-cyan-100 transition hover:bg-cyan-400/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300"
                  >
                    Copy invite link
                  </button>
                )}
              </div>
            </motion.div>
          )}

          {/* ── Active game ────────────────────────────────────────── */}
          {(livePhase || finished) && (
            <GameSessionHost
              autoStart={Boolean(match && match.status === "active")}
              autoStop={Boolean(finished || cancelled)}
              gameLabel="lane-rush-duel"
            >
              {desktopContent}
            </GameSessionHost>
          )}

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
                  className="mt-4 mr-2 rounded-xl border border-cyan-300/50 bg-cyan-400/10 px-5 py-2 text-sm font-bold text-cyan-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300"
                >
                  Retry
                </button>
              )}
              <button
                onClick={() => router.push("/casino/lane-runner")}
                className="mt-4 rounded-xl bg-cyan-400 px-5 py-2 text-sm font-bold text-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-200"
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
