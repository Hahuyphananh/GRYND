"use client";

// src/components/play/ModeTableau.tsx
//
// A short "video" of a mode's table: a real Klondike layout in that mode's
// colours, with exactly ONE move playing.
//
//   solo         the stock card flips down into the waste
//   daily        a sealed card deals onto the table under a gold sweep
//   ai           a tableau card climbs to a foundation while the bot thinks
//   ranked       two seats race the same deal to the foundations
//   dailyPuzzle  one card is lifted onto the puzzle's target
//   unlimited    an endless shuffle, three cards in flight
//
// ── Hover SCRUBS, it does not just replay ──────────────────────────────────
//
// While the pointer is over a preview the loop pauses and the pointer's
// horizontal position drives the move: left edge is the start of the move,
// right edge is the end. Moving the mouse back and forth plays the move
// backwards and forwards like a film strip. Leaving the preview resets it to
// the first frame and the idle loop resumes.
//
// Only for fine pointers that can hover — a touch drag stays a scroll, and
// nothing is scrubbed on a device that cannot hover. The idle loop itself is
// still CSS-only.
//
// ── Slow connections get a still ───────────────────────────────────────────
//
// Save-Data or a 2G-class connection renders the dealt table with no motion at
// all (`data-static="true"`). The artwork has no network cost either way, but a
// looping animation is still work a metered device did not ask for.
//
// Decorative: aria-hidden and no focusable element. The card around it is the
// link and carries the accessible name.

import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

import styles from "./ModeTableau.module.css";

export type TableauVariant =
  | "solo"
  | "daily"
  | "ai"
  | "ranked"
  | "dailyPuzzle"
  | "unlimited";

const CARD_W = 13;
const CARD_H = 18;

type NetworkInformation = {
  saveData?: boolean;
  effectiveType?: string;
};

function Face({
  x,
  y,
  rank,
  suit,
  red = false,
  fresh = false,
}: {
  x: number;
  y: number;
  rank: string;
  suit: string;
  red?: boolean;
  fresh?: boolean;
}) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <rect className={styles.face} width={CARD_W} height={CARD_H} rx={1.8} />
      {fresh && (
        <rect
          className={styles.fresh}
          width={CARD_W}
          height={CARD_H}
          rx={1.8}
        />
      )}
      <text className={`${styles.rank} ${red ? styles.red : ""}`} x={1.5} y={5.4}>
        {rank}
      </text>
      <text
        className={`${styles.suitSmall} ${red ? styles.red : ""}`}
        x={1.7}
        y={10.6}
      >
        {suit}
      </text>
      <text
        className={`${styles.suitBig} ${red ? styles.red : ""}`}
        x={11.4}
        y={16.8}
        textAnchor="end"
      >
        {suit}
      </text>
    </g>
  );
}

function Back({ x, y }: { x: number; y: number }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <rect className={styles.back} width={CARD_W} height={CARD_H} rx={1.8} />
      <rect
        className={styles.backInset}
        x={1.7}
        y={1.7}
        width={CARD_W - 3.4}
        height={CARD_H - 3.4}
        rx={1}
      />
    </g>
  );
}

export default function ModeTableau({ variant }: { variant: TableauVariant }) {
  const gradientId = `mode-felt-${variant}`;
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [staticStill, setStaticStill] = useState(false);

  // Save-Data / 2G: keep the dealt table, drop the motion entirely.
  useEffect(() => {
    const connection = (
      navigator as Navigator & { connection?: NetworkInformation }
    ).connection;
    const slow =
      Boolean(connection?.saveData) ||
      /(^|-)2g$/.test(String(connection?.effectiveType ?? ""));
    if (slow) setStaticStill(true);
  }, []);

  /**
   * Park every animation on this table at `progress` (0..1) of its own
   * timeline. `currentTime` is what makes this a scrub rather than a replay:
   * the CSS keyframes never restart, they just follow the pointer.
   */
  const scrub = (event: ReactPointerEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg || staticStill) return;
    if (
      typeof window !== "undefined" &&
      window.matchMedia &&
      !window.matchMedia("(hover: hover) and (pointer: fine)").matches
    ) {
      return;
    }

    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0) return;
    const progress = Math.min(
      1,
      Math.max(0, (event.clientX - rect.left) / rect.width),
    );

    for (const animation of svg.getAnimations({ subtree: true })) {
      const duration = Number(animation.effect?.getTiming().duration);
      if (!Number.isFinite(duration) || duration <= 0) continue;
      animation.pause();
      animation.currentTime = progress * duration;
    }
  };

  /** Back to the first frame, then let the idle loop run again. */
  const resume = () => {
    const svg = svgRef.current;
    if (!svg || staticStill) return;
    for (const animation of svg.getAnimations({ subtree: true })) {
      animation.currentTime = 0;
      animation.play();
    }
  };

  return (
    <svg
      ref={svgRef}
      viewBox="0 0 160 100"
      className={`${styles.frame} ${styles[variant]} ${
        staticStill ? styles.static : ""
      }`}
      aria-hidden="true"
      focusable="false"
      data-testid={`play-mode-preview-${variant}`}
      data-variant={variant}
      data-static={staticStill ? "true" : "false"}
      onPointerMove={scrub}
      onPointerLeave={resume}
      onPointerCancel={resume}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="var(--felt-a)" />
          <stop offset="100%" stopColor="var(--felt-b)" />
        </linearGradient>
        <radialGradient
          id={`${gradientId}-glow`}
          cx="0.5"
          cy="0"
          r="0.9"
        >
          <stop offset="0%" stopColor="var(--line)" stopOpacity="0.55" />
          <stop offset="100%" stopColor="var(--line)" stopOpacity="0" />
        </radialGradient>
      </defs>

      <rect width="160" height="100" fill={`url(#${gradientId})`} />
      <rect
        width="160"
        height="100"
        fill={`url(#${gradientId}-glow)`}
        className={styles.glow}
      />

      <g className={styles.grain} aria-hidden="true">
        {[0, 1, 2, 3, 4, 5, 6].map((i) => (
          <line
            key={i}
            x1={-30 + i * 32}
            y1={100}
            x2={10 + i * 32}
            y2={0}
          />
        ))}
      </g>

      {/* Foundations, top-left: two aces are already up, so the move always has
          a legal target to aim at. */}
      {[8, 24.5, 41].map((x) => (
        <rect
          key={x}
          className={styles.slot}
          x={x}
          y={8}
          width={CARD_W}
          height={CARD_H}
          rx={2}
        />
      ))}
      <Face x={8} y={8} rank="A" suit="♠" fresh />
      <Face x={24.5} y={8} rank="A" suit="♥" red />

      {/* Waste, directly under the stock: a stock card flips down into it. */}
      {(variant === "solo" || variant === "unlimited") && (
        <rect
          className={styles.slot}
          x={134.6}
          y={30}
          width={CARD_W}
          height={CARD_H}
          rx={2}
        />
      )}

      {/* Stock, top-right. */}
      <Back x={137.4} y={8} />
      <Back x={134.6} y={8} />

      {/* The tableau. Fanned by five units so every rank stays readable. */}
      <Face x={16} y={40} rank="K" suit="♠" />
      <Face x={16} y={45} rank="Q" suit="♥" red />

      <Face x={50} y={40} rank="9" suit="♦" red />

      <Face x={84} y={40} rank="J" suit="♣" />
      <Face x={84} y={45} rank="10" suit="♥" red />
      <Face x={84} y={50} rank="9" suit="♠" />

      <Face x={118} y={40} rank="7" suit="♠" />
      <Face x={118} y={45} rank="6" suit="♦" red />

      {/* ── The mode's move ─────────────────────────────────────────────── */}

      {variant === "solo" && (
        <g transform="translate(134.6 8)">
          <g className={styles.soloFlyer}>
            <Face x={0} y={0} rank="4" suit="♣" />
          </g>
        </g>
      )}

      {variant === "daily" && (
        <>
          <rect className={styles.sweep} x={0} y={0} width={26} height={100} />
          <g transform="translate(118 40)">
            <g className={styles.dealFlyer}>
              <Back x={0} y={0} />
            </g>
          </g>
        </>
      )}

      {variant === "ai" && (
        <>
          <circle
            className={styles.botPulse}
            cx={146}
            cy={86}
            r={5}
            fill="var(--line)"
          />
          <g transform="translate(16 40)">
            <g className={styles.aiFlyer}>
              <Face x={0} y={0} rank="2" suit="♣" />
            </g>
          </g>
        </>
      )}

      {variant === "ranked" && (
        <>
          <rect
            className={styles.raceBar}
            x={8}
            y={31}
            width={144}
            height={1.6}
            rx={0.8}
          />
          <g transform="translate(16 40)">
            <g className={styles.raceA}>
              <Face x={0} y={0} rank="2" suit="♣" />
            </g>
          </g>
          <g transform="translate(118 40)">
            <g className={styles.raceB}>
              <Face x={0} y={0} rank="2" suit="♦" red />
            </g>
          </g>
        </>
      )}

      {variant === "dailyPuzzle" && (
        <>
          <rect
            className={`${styles.slot} ${styles.puzzleTarget}`}
            x={73}
            y={28}
            width={CARD_W}
            height={CARD_H}
            rx={2}
          />
          <g transform="translate(73 40)">
            <g className={styles.puzzleFlyer}>
              <Face x={0} y={0} rank="Q" suit="♥" red />
            </g>
          </g>
        </>
      )}

      {variant === "unlimited" && (
        <>
          <g transform="translate(134.6 8)">
            <g className={`${styles.shuffle}`}>
              <Face x={0} y={0} rank="4" suit="♣" />
            </g>
          </g>
          <g transform="translate(134.6 8)">
            <g className={`${styles.shuffle} ${styles.shuffle2}`}>
              <Face x={0} y={0} rank="8" suit="♦" red />
            </g>
          </g>
          <g transform="translate(134.6 8)">
            <g className={`${styles.shuffle} ${styles.shuffle3}`}>
              <Face x={0} y={0} rank="A" suit="♠" />
            </g>
          </g>
        </>
      )}
    </svg>
  );
}
