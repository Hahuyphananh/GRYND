"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";

/**
 * Hex Duel troop number that ROLLS to its new value instead of snapping.
 *
 * A tile (or a player's troop bar) whose count changes now counts up or down
 * over a short window, and the digits carry one direction-tinted emphasis
 * that fades out as the count lands. Direction is real information here: a
 * number climbing is troops arriving (displace / reinforce), a number falling
 * is troops spent or lost (attack / defence), so the motion reads as the move
 * that caused it rather than as decoration.
 *
 * Exactly once, structurally: the animation is keyed on the VALUE, not on a
 * render. React only re-runs the effect when `value` actually changes, and the
 * `seenRef` guard swallows a re-run at a value the effect already handled — so
 * polling snapshots, socket re-deliveries, parent re-renders, a re-mount and
 * Strict Mode's double-invoked effects cannot replay or extend a roll. A
 * mid-flight change continues from whatever number is currently on screen, so
 * two quick moves can't produce a snap or a stutter.
 *
 * Reduced motion (`prefers-reduced-motion: reduce`) settles on the new value
 * immediately — the number itself is the information, so nothing is lost.
 */

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

/**
 * Smoothstep: even through the middle, so a multi-digit swing actually SHOWS
 * the numbers between its old and new value instead of jumping to the target
 * almost immediately (which a front-loaded ease would do).
 */
const ease = (p: number) => p * p * (3 - 2 * p);

/** ~0.22s for a ±1 swing, capped at 0.42s for a big one. */
const durationFor = (distance: number) => Math.min(420, 200 + distance * 16);

export interface HexTroopCountProps {
  value: number;
  /** The digit colour — used to tint the emphasis glow. */
  color: string;
  /** The glow the digits wear at rest (owner colour), so the emphasis adds to it. */
  glow?: string;
  className?: string;
  style?: CSSProperties;
}

export default function HexTroopCount({
  value, color, glow = "none", className = "", style,
}: HexTroopCountProps) {
  const [display, setDisplay] = useState(value);
  /** 0 at rest, +1 while climbing, −1 while falling. */
  const [direction, setDirection] = useState(0);
  /** 0 → 1 → 0 across the roll; drives how hard the emphasis pushes. */
  const [emphasis, setEmphasis] = useState(0);

  /** The number the DOM is currently showing (the roll's start point). */
  const renderedRef = useRef(value);
  /** The last value the effect handled — the duplicate-snapshot guard. */
  const seenRef = useRef(value);
  const frameRef = useRef<number | null>(null);
  /** Identifies the in-flight roll; a stale frame checks it and bails. */
  const runRef = useRef(0);

  useEffect(() => {
    // Same value as the last handled one (a poll / socket re-delivery / a
    // re-render) — nothing new happened, so nothing rolls.
    if (seenRef.current === value) return;
    const from = renderedRef.current;
    seenRef.current = value;
    // Two moves that cancel out (12 → 13 → 12) leave the rendered number
    // already correct; don't roll to where we already are.
    if (from === value) return;

    const run = ++runRef.current;
    const dir = value > from ? 1 : -1;

    if (prefersReducedMotion()) {
      renderedRef.current = value;
      setDisplay(value);
      setDirection(0);
      setEmphasis(0);
      return;
    }

    setDirection(dir);
    const duration = durationFor(Math.abs(value - from));
    const start = performance.now();

    const step = (now: number) => {
      if (runRef.current !== run) return;
      const p = Math.min(1, (now - start) / duration);
      const shown = Math.round(from + (value - from) * ease(p));
      renderedRef.current = shown;
      setDisplay(shown);
      setEmphasis(Math.sin(Math.PI * p));
      if (p < 1) {
        frameRef.current = requestAnimationFrame(step);
      } else {
        frameRef.current = null;
        renderedRef.current = value;
        setDisplay(value);
        setEmphasis(0);
        setDirection(0);
      }
    };

    frameRef.current = requestAnimationFrame(step);
    return () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [value]);

  // Unmounting mid-roll must not leave a frame queued.
  useEffect(() => () => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
  }, []);

  const boost = emphasis > 0 ? `0 0 ${Math.round(6 + 14 * emphasis)}px ${color}` : null;
  const textShadow = [glow !== "none" ? glow : null, boost].filter(Boolean).join(", ") || undefined;
  const moving = direction !== 0 && emphasis > 0;

  return (
    <span
      /* `data-troop-count` carries the AUTHORITATIVE value while the text
         shows the rolling display, so QA can tell "mid-roll" from "settled"
         (same kind of anchor as `data-tile-key` / `data-hex-board`). */
      data-troop-count={value}
      className={`inline-block tabular-nums ${className}`}
      style={{
        ...style,
        textShadow,
        transform: moving
          ? `translateY(${(-direction * 2 * emphasis).toFixed(2)}px) scale(${(1 + direction * 0.14 * emphasis).toFixed(3)})`
          : undefined,
        filter: moving ? `brightness(${(1 + direction * 0.35 * emphasis).toFixed(3)})` : undefined,
        willChange: moving ? "transform, filter" : undefined,
      }}
    >
      {display}
    </span>
  );
}
